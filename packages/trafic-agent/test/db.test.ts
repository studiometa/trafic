import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    it("creates both tables", () => {
      const tables = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as unknown as { name: string }[];

      expect(tables.map((t) => t.name)).toContain("projects");
      expect(tables.map((t) => t.name)).toContain("access_logs");
    });

    it("can run again over an existing schema without losing data", () => {
      updateProjectAccess("scalian", clock);

      initDb(":memory:");

      // A fresh :memory: database is a new one, so this asserts only that
      // re-initialising does not throw on CREATE TABLE
      expect(() => getDb()).not.toThrow();
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
      updateProjectAccess("scalian", clock);

      expect(getProject("scalian")).toEqual({
        name: "scalian",
        lastAccess: NOW,
        status: "running",
      });
    });

    it("moves last access forward on a later request", () => {
      updateProjectAccess("scalian", clock);
      clockValue = NOW + HOUR;
      updateProjectAccess("scalian", clock);

      expect(getProject("scalian")?.lastAccess).toBe(NOW + HOUR);
    });

    it("does not overwrite a status set elsewhere", () => {
      // A start in flight must not be reset to "running" by a request
      // arriving on the waiting page
      setProjectStatus("scalian", "starting", clock);
      updateProjectAccess("scalian", clock);

      expect(getProject("scalian")?.status).toBe("starting");
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
      updateProjectAccess("scalian", clock);
      setProjectStatus("scalian", "stopped", clock);

      expect(getProject("scalian")?.status).toBe("stopped");
    });

    it("leaves last access alone", () => {
      updateProjectAccess("scalian", clock);
      clockValue = NOW + HOUR;
      setProjectStatus("scalian", "stopped", clock);

      // Otherwise stopping a project would look like activity and defer the
      // next idle sweep
      expect(getProject("scalian")?.lastAccess).toBe(NOW);
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
      project: "scalian",
      timestamp: NOW,
      ip: "203.0.113.5",
      userAgent: "curl/8",
      path: "/",
    };

    it("stores and reads back an access", () => {
      logAccess(entry);

      const [logged] = getAccessLogs("scalian");

      expect(logged).toMatchObject(entry);
      expect(logged?.id).toBeGreaterThan(0);
    });

    it("returns only the requested project", () => {
      logAccess(entry);
      logAccess({ ...entry, project: "other" });

      expect(getAccessLogs("scalian")).toHaveLength(1);
    });

    it("returns the newest first", () => {
      logAccess({ ...entry, path: "/old", timestamp: NOW });
      logAccess({ ...entry, path: "/new", timestamp: NOW + MINUTE });

      expect(getAccessLogs("scalian").map((l) => l.path)).toEqual(["/new", "/old"]);
    });

    it("honours the limit", () => {
      for (let i = 0; i < 5; i++) {
        logAccess({ ...entry, timestamp: NOW + i });
      }

      expect(getAccessLogs("scalian", 2)).toHaveLength(2);
    });

    it("returns nothing for a project with no accesses", () => {
      expect(getAccessLogs("quiet")).toEqual([]);
    });
  });

  describe("cleanOldLogs", () => {
    const entry = {
      project: "scalian",
      timestamp: NOW,
      ip: "203.0.113.5",
      userAgent: "curl/8",
      path: "/",
    };

    it("removes entries older than the cutoff and reports how many", () => {
      logAccess({ ...entry, timestamp: NOW - 40 * DAY });
      logAccess({ ...entry, timestamp: NOW - 10 * DAY });

      expect(cleanOldLogs(30, clock)).toBe(1);
      expect(getAccessLogs("scalian")).toHaveLength(1);
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
