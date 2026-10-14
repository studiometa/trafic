import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  initDb,
  getDb,
  closeDb,
  updateProjectAccess,
  getProject,
  setProjectStatus,
  getIdleProjects,
  logAccess,
  getAccessLogs,
  cleanOldLogs,
  deleteProject,
  scheduleDestroy,
  cancelScheduledDestroy,
  startScheduledDestroy,
  getScheduledDestroy,
  getScheduledDestroys,
  isProcessAlive,
  releaseStaleStatuses,
} from "../src/utils/db.js";

const NOW = new Date("2026-09-07T12:00:00Z").getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("db", () => {
  /** The moment the next call should see, advanced by the tests. */
  let clockValue = NOW;
  const clock = () => clockValue;

  beforeEach(() => {
    clockValue = NOW;
    initDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  describe("initDb", () => {
    it("creates the tables", () => {
      const tables = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as unknown as { name: string }[];

      expect(tables.map((t) => t.name)).toContain("projects");
      expect(tables.map((t) => t.name)).toContain("access_logs");
      expect(tables.map((t) => t.name)).toContain("scheduled_destroys");
    });

    it("can run again over an existing schema without losing data", () => {
      updateProjectAccess("my-app", clock);

      initDb(":memory:");

      // A fresh :memory: database is a new one, so this asserts only that
      // re-initialising does not throw on CREATE TABLE
      expect(() => getDb()).not.toThrow();
    });
  });

  describe("initDb over a database from an older agent", () => {
    let root: string;

    beforeEach(() => {
      closeDb();
      root = mkdtempSync(join(tmpdir(), "trafic-db-"));
    });

    afterEach(() => {
      closeDb();
      rmSync(root, { recursive: true, force: true });
    });

    it("adds the status_pid column and keeps the rows", () => {
      const path = join(root, "trafic.db");
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE projects (
          name TEXT PRIMARY KEY,
          last_access INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'stopped'
        );
        INSERT INTO projects VALUES ('app', 1, 'starting');
      `);
      old.close();

      initDb(path);

      // A row from before has no process: its busy status is stale
      expect(getProject("app")?.status).toBe("starting");
      expect(releaseStaleStatuses(() => true)).toEqual(["app"]);
      setProjectStatus("app", "destroying");
      expect(getProject("app")?.status).toBe("destroying");
    });

    it("can open the same database again", () => {
      // The service and trafic-agent destroy both open it
      const path = join(root, "trafic.db");
      initDb(path);
      closeDb();

      expect(() => initDb(path)).not.toThrow();
    });
  });

  describe("getDb", () => {
    it("throws before the database is initialised", () => {
      closeDb();

      expect(() => getDb()).toThrow(/not initialized/i);
    });
  });

  describe("updateProjectAccess", () => {
    it("records a new project as running", () => {
      updateProjectAccess("my-app", clock);

      expect(getProject("my-app")).toEqual({
        name: "my-app",
        lastAccess: NOW,
        status: "running",
      });
    });

    it("moves last access forward on a later request", () => {
      updateProjectAccess("my-app", clock);
      clockValue = NOW + HOUR;
      updateProjectAccess("my-app", clock);

      expect(getProject("my-app")?.lastAccess).toBe(NOW + HOUR);
    });

    it("does not overwrite a status set elsewhere", () => {
      // A start in flight must not be reset to "running" by a request
      // arriving on the waiting page
      setProjectStatus("my-app", "starting", clock);
      updateProjectAccess("my-app", clock);

      expect(getProject("my-app")?.status).toBe("starting");
    });
  });

  describe("getProject", () => {
    it("returns undefined for a project it has never seen", () => {
      expect(getProject("nope")).toBeUndefined();
    });
  });

  describe("setProjectStatus", () => {
    it("records a status for a project not seen before", () => {
      setProjectStatus("preview-42--app", "starting", clock);

      expect(getProject("preview-42--app")?.status).toBe("starting");
    });

    it("changes the status of a known project", () => {
      updateProjectAccess("my-app", clock);
      setProjectStatus("my-app", "stopped", clock);

      expect(getProject("my-app")?.status).toBe("stopped");
    });

    it("leaves last access alone", () => {
      updateProjectAccess("my-app", clock);
      clockValue = NOW + HOUR;
      setProjectStatus("my-app", "stopped", clock);

      // Otherwise stopping a project would look like activity and defer the
      // next idle sweep
      expect(getProject("my-app")?.lastAccess).toBe(NOW);
    });
  });

  describe("releaseStaleStatuses", () => {
    /** The process id recorded with a project's status. */
    function statusPid(name: string): number | null {
      const row = getDb()
        .prepare("SELECT status_pid AS pid FROM projects WHERE name = ?")
        .get(name) as { pid: number | null };
      return row.pid;
    }

    it("records this process with a busy status only", () => {
      setProjectStatus("starting", "starting", clock);
      setProjectStatus("destroying", "destroying", clock);
      setProjectStatus("running", "destroying", clock);
      setProjectStatus("running", "running", clock);

      expect(statusPid("starting")).toBe(process.pid);
      expect(statusPid("destroying")).toBe(process.pid);
      expect(statusPid("running")).toBeNull();
    });

    it("sets a busy status back to running when its process is gone", () => {
      // A trafic-agent destroy killed with its CI job, or a start that a
      // restart of the service cut short
      updateProjectAccess("removed", clock);
      setProjectStatus("removed", "destroying", clock);
      setProjectStatus("started", "starting", clock);

      expect(releaseStaleStatuses(() => false).sort()).toEqual(["removed", "started"]);
      expect(getProject("removed")).toEqual({ name: "removed", lastAccess: NOW, status: "running" });
      expect(getProject("started")?.status).toBe("running");
      expect(statusPid("removed")).toBeNull();
    });

    it("keeps a busy status while its process lives", () => {
      setProjectStatus("removing", "destroying", clock);
      setProjectStatus("starting", "starting", clock);

      expect(releaseStaleStatuses()).toEqual([]);
      expect(getProject("removing")?.status).toBe("destroying");
      expect(getProject("starting")?.status).toBe("starting");
    });

    it("leaves the other statuses alone", () => {
      updateProjectAccess("running", clock);
      setProjectStatus("stopped", "stopped", clock);

      expect(releaseStaleStatuses(() => false)).toEqual([]);
      expect(getProject("running")?.status).toBe("running");
      expect(getProject("stopped")?.status).toBe("stopped");
    });

    it("asks about the process that set the status", () => {
      setProjectStatus("app", "destroying", clock);
      const asked: number[] = [];

      releaseStaleStatuses((pid) => {
        asked.push(pid);
        return true;
      });

      expect(asked).toEqual([process.pid]);
    });
  });

  describe("isProcessAlive", () => {
    it("says this process is alive", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("says an id no process has is not", () => {
      // kill(2) refuses ids over pid_max
      expect(isProcessAlive(2 ** 30)).toBe(false);
    });
  });

  describe("getIdleProjects", () => {
    it("returns a running project past the threshold", () => {
      updateProjectAccess("stale", clock);
      clockValue = NOW + 5 * HOUR;

      expect(getIdleProjects(4 * HOUR, clock).map((p) => p.name)).toEqual(["stale"]);
    });

    it("leaves a recently used project alone", () => {
      updateProjectAccess("busy", clock);
      clockValue = NOW + MINUTE;

      expect(getIdleProjects(4 * HOUR, clock)).toEqual([]);
    });

    it("ignores a project that is not running", () => {
      // Stopping one that is already stopped would be wasted work, and
      // "starting" must not be interrupted mid-start
      updateProjectAccess("gone", clock);
      setProjectStatus("gone", "stopped", clock);
      updateProjectAccess("booting", clock);
      setProjectStatus("booting", "starting", clock);
      clockValue = NOW + 5 * HOUR;

      expect(getIdleProjects(4 * HOUR, clock)).toEqual([]);
    });

    it("treats a project used exactly at the cutoff as active", () => {
      updateProjectAccess("edge", clock);
      clockValue = NOW + 4 * HOUR;

      expect(getIdleProjects(4 * HOUR, clock)).toEqual([]);
    });

    it("returns every idle project, not just the first", () => {
      updateProjectAccess("a", clock);
      updateProjectAccess("b", clock);
      clockValue = NOW + 5 * HOUR;

      expect(getIdleProjects(4 * HOUR, clock)).toHaveLength(2);
    });
  });

  describe("logAccess and getAccessLogs", () => {
    const entry = {
      project: "my-app",
      timestamp: NOW,
      ip: "203.0.113.5",
      userAgent: "curl/8",
      path: "/",
    };

    it("stores and reads back an access", () => {
      logAccess(entry);

      const [logged] = getAccessLogs("my-app");

      expect(logged).toMatchObject(entry);
      expect(logged?.id).toBeGreaterThan(0);
    });

    it("returns only the requested project", () => {
      logAccess(entry);
      logAccess({ ...entry, project: "other" });

      expect(getAccessLogs("my-app")).toHaveLength(1);
    });

    it("returns the newest first", () => {
      logAccess({ ...entry, path: "/old", timestamp: NOW });
      logAccess({ ...entry, path: "/new", timestamp: NOW + MINUTE });

      expect(getAccessLogs("my-app").map((l) => l.path)).toEqual(["/new", "/old"]);
    });

    it("honours the limit", () => {
      for (let i = 0; i < 5; i++) {
        logAccess({ ...entry, timestamp: NOW + i });
      }

      expect(getAccessLogs("my-app", 2)).toHaveLength(2);
    });

    it("returns nothing for a project with no accesses", () => {
      expect(getAccessLogs("quiet")).toEqual([]);
    });
  });

  describe("deleteProject", () => {
    it("removes the project row and its access logs", () => {
      updateProjectAccess("gone", clock);
      updateProjectAccess("kept", clock);
      logAccess({ project: "gone", timestamp: NOW, ip: "1.2.3.4", userAgent: "ua", path: "/" });
      logAccess({ project: "kept", timestamp: NOW, ip: "1.2.3.4", userAgent: "ua", path: "/" });

      deleteProject("gone");

      expect(getProject("gone")).toBeUndefined();
      expect(getAccessLogs("gone")).toEqual([]);
      expect(getProject("kept")).toBeDefined();
      expect(getAccessLogs("kept")).toHaveLength(1);
    });

    it("does nothing for a project it has never seen", () => {
      expect(() => deleteProject("nope")).not.toThrow();
    });

    it("cancels the scheduled removal of the project", () => {
      scheduleDestroy("gone", NOW, false);

      deleteProject("gone");

      expect(getScheduledDestroys()).toEqual([]);
    });
  });

  describe("scheduled removals", () => {
    it("records a removal with its date and backup", () => {
      scheduleDestroy("app", NOW + DAY, true);

      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + DAY, backup: true, removing: false },
      ]);
    });

    it("replaces the date, backup and timeout of a removal already scheduled", () => {
      scheduleDestroy("app", NOW + DAY, true, HOUR);
      scheduleDestroy("app", NOW + 2 * DAY, false);

      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + 2 * DAY, backup: false, removing: false },
      ]);
    });

    it("lists the removals soonest first", () => {
      scheduleDestroy("later", NOW + 2 * DAY, false);
      scheduleDestroy("sooner", NOW + DAY, false);

      expect(getScheduledDestroys().map((s) => s.name)).toEqual(["sooner", "later"]);
    });

    it("lists only the removals due by the given time", () => {
      scheduleDestroy("past", NOW - HOUR, false);
      scheduleDestroy("now", NOW, false);
      scheduleDestroy("future", NOW + HOUR, false);

      expect(getScheduledDestroys(NOW).map((s) => s.name)).toEqual(["past", "now"]);
    });

    it("gets the removal of one project only when it is due", () => {
      scheduleDestroy("app", NOW, true);
      scheduleDestroy("other", NOW - HOUR, false);

      expect(getScheduledDestroy("app", NOW)).toEqual({ name: "app", destroyAt: NOW, backup: true, removing: false });
      expect(getScheduledDestroy("app", NOW - MINUTE)).toBeUndefined();
      expect(getScheduledDestroy("app")).toBeDefined();
      scheduleDestroy("timed", NOW, true, HOUR);
      expect(getScheduledDestroy("timed")).toEqual({
        name: "timed",
        destroyAt: NOW,
        backup: true,
        timeoutMs: HOUR,
        removing: false,
      });
      expect(getScheduledDestroy("unknown")).toBeUndefined();
    });

    it("cancels a removal and reports whether there was one", () => {
      scheduleDestroy("app", NOW + DAY, false);

      expect(cancelScheduledDestroy("app")).toBe("cancelled");
      expect(cancelScheduledDestroy("app")).toBe("none");
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("marks a removal as started only when it is still due", () => {
      scheduleDestroy("app", NOW, false);
      scheduleDestroy("later", NOW + HOUR, false);

      expect(startScheduledDestroy("app", NOW)).toBe(true);
      expect(startScheduledDestroy("later", NOW)).toBe(false);
      expect(startScheduledDestroy("unknown", NOW)).toBe(false);
      expect(getScheduledDestroys().map(({ name, removing }) => ({ name, removing }))).toEqual([
        { name: "app", removing: true },
        { name: "later", removing: false },
      ]);
    });

    it("refuses to cancel a removal that has started", () => {
      scheduleDestroy("app", NOW, false);
      startScheduledDestroy("app", NOW);

      expect(cancelScheduledDestroy("app")).toBe("removing");
      expect(getScheduledDestroy("app")?.removing).toBe(true);
    });

    it("deletes a started removal with the project records", () => {
      scheduleDestroy("app", NOW, false);
      startScheduledDestroy("app", NOW);

      deleteProject("app");

      expect(getScheduledDestroys()).toEqual([]);
    });
  });

  describe("cleanOldLogs", () => {
    const entry = {
      project: "my-app",
      timestamp: NOW,
      ip: "203.0.113.5",
      userAgent: "curl/8",
      path: "/",
    };

    it("removes entries older than the cutoff and reports how many", () => {
      logAccess({ ...entry, timestamp: NOW - 40 * DAY });
      logAccess({ ...entry, timestamp: NOW - 10 * DAY });

      expect(cleanOldLogs(30, clock)).toBe(1);
      expect(getAccessLogs("my-app")).toHaveLength(1);
    });

    it("reports zero when there is nothing old enough", () => {
      logAccess(entry);

      expect(cleanOldLogs(30, clock)).toBe(0);
    });

    it("keeps an entry exactly at the cutoff", () => {
      logAccess({ ...entry, timestamp: NOW - 30 * DAY });

      expect(cleanOldLogs(30, clock)).toBe(0);
    });
  });
});
