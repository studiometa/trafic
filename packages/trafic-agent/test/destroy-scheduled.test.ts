import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  destroyScheduledProjects,
  scheduleProjectDestroy,
  startScheduledDestroyScheduler,
} from "../src/tasks/destroy-scheduled.js";
import {
  initDb,
  closeDb,
  cancelScheduledDestroy,
  getScheduledDestroys,
  scheduleDestroy,
  startScheduledDestroy,
} from "../src/utils/db.js";
import type { DdevRunner } from "../src/utils/ddev.js";
import type { AgentConfig } from "../src/types.js";

// The task reports progress; keep it out of the test output
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const NOW = new Date("2026-10-14T12:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;
const clock = () => NOW;

/**
 * A ddev that records each command, finds every project running with a
 * database, and fails the export of the projects in `failExportIn`.
 */
function recordingRunner(calls: string[][], failExportIn: string[] = []): DdevRunner {
  return (args, _timeoutMs, cwd) => {
    calls.push(args);
    const ok = !(args[0] === "export-db" && failExportIn.some((dir) => cwd === dir));
    const stdout =
      args[0] === "describe"
        ? JSON.stringify({ raw: { name: args[1], status: "running", dbinfo: { database_type: "mariadb" } } })
        : "";
    return Promise.resolve({ ok, stdout });
  };
}

describe("scheduled removals", () => {
  let root: string;
  let config: AgentConfig;

  /** Create a project directory with a file in it. */
  function createProject(name: string): string {
    const dir = join(config.projectsDir, name);
    mkdirSync(join(dir, ".ddev"), { recursive: true });
    writeFileSync(join(dir, ".ddev", "config.yaml"), `name: ${name}\n`);
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "trafic-destroy-scheduled-"));
    mkdirSync(join(root, "www"));

    config = {
      tld: "previews.example.com",
      port: 9876,
      dbPath: ":memory:",
      projectListPath: join(root, "project_list.yaml"),
      projectsDir: join(root, "www"),
      idleTimeout: "30m",
      idleCheckInterval: "5m",
      auth: {
        defaultPolicy: "basic",
        allowedIps: [],
        tokens: [],
        basicAuth: [],
        rules: [],
        trustedProxyHops: 1,
      },
      tls: { dnsEnv: {} },
      backup: { dir: join(root, "backups"), retainDays: 14 },
    };

    initDb(config.dbPath);
  });

  afterEach(() => {
    closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  describe("scheduleProjectDestroy", () => {
    it("records the removal at now plus the delay", () => {
      const destroyAt = scheduleProjectDestroy("app", "48h", config, {}, clock);

      expect(destroyAt.getTime()).toBe(NOW + 48 * HOUR);
      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + 48 * HOUR, backup: false, removing: false },
      ]);
    });

    it("records that the removal must back up first", () => {
      scheduleProjectDestroy("app", "1h30m", config, { backup: true }, clock);

      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + 1.5 * HOUR, backup: true, removing: false },
      ]);
    });

    it("records the time limit of the backup", () => {
      scheduleProjectDestroy("app", "48h", config, { backup: true, timeoutMs: HOUR }, clock);

      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + 48 * HOUR, backup: true, timeoutMs: HOUR, removing: false },
      ]);
    });

    it("refuses a delay it cannot read", () => {
      for (const delay of ["", "0h", "2d", "soon"]) {
        expect(() => scheduleProjectDestroy("app", delay, config, {}, clock)).toThrow(
          /Invalid delay/,
        );
      }

      expect(getScheduledDestroys()).toEqual([]);
    });

    it("refuses a removal that the sweep already started", () => {
      scheduleDestroy("app", NOW, true);
      startScheduledDestroy("app", NOW);

      expect(() => scheduleProjectDestroy("app", "48h", config, {}, clock)).toThrow(
        /The removal of app is in progress/,
      );
      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW, backup: true, removing: true },
      ]);
    });

    it("refuses an unsafe name now rather than in a later sweep", () => {
      expect(() => scheduleProjectDestroy("../etc", "48h", config, {}, clock)).toThrow(
        /Invalid project name/,
      );
      expect(getScheduledDestroys()).toEqual([]);
    });
  });

  describe("destroyScheduledProjects", () => {
    it("removes the projects that are due and keeps the others", async () => {
      const due = createProject("due");
      const later = createProject("later");
      scheduleDestroy("due", NOW - HOUR, false);
      scheduleDestroy("later", NOW + HOUR, false);
      const calls: string[][] = [];

      await destroyScheduledProjects(config, clock, recordingRunner(calls));

      expect(calls).toEqual([["delete", "-Oy"]]);
      expect(existsSync(due)).toBe(false);
      expect(existsSync(later)).toBe(true);
      expect(getScheduledDestroys().map((s) => s.name)).toEqual(["later"]);
    });

    it("backs the project up first when the removal asked for it", async () => {
      createProject("app");
      scheduleDestroy("app", NOW, true);
      const calls: string[][] = [];

      await destroyScheduledProjects(config, clock, recordingRunner(calls));

      expect(calls.map(([command]) => command)).toEqual(["describe", "export-db", "exec", "delete"]);
      expect(readdirSync(join(config.backup.dir, "app"))).toHaveLength(1);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("gives the backup the time limit of the removal", async () => {
      createProject("app");
      scheduleDestroy("app", NOW, true, HOUR);
      const exportTimeouts: number[] = [];
      const runner = recordingRunner([]);

      await destroyScheduledProjects(config, clock, (args, timeoutMs, cwd) => {
        if (args[0] === "export-db") {
          exportTimeouts.push(timeoutMs);
        }
        return runner(args, timeoutMs, cwd);
      });

      expect(exportTimeouts).toEqual([HOUR]);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("goes on after a failure and retries the failed project later", async () => {
      const failing = createProject("failing");
      const other = createProject("other");
      scheduleDestroy("failing", NOW - HOUR, true);
      scheduleDestroy("other", NOW, false);

      await destroyScheduledProjects(config, clock, recordingRunner([], [failing]));

      // The failed backup removed nothing and kept the schedule
      expect(existsSync(failing)).toBe(true);
      expect(existsSync(other)).toBe(false);
      expect(getScheduledDestroys().map((s) => s.name)).toEqual(["failing"]);

      // The next sweep tries again
      await destroyScheduledProjects(config, clock, recordingRunner([]));

      expect(existsSync(failing)).toBe(false);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("keeps a project whose removal is cancelled while another one runs", async () => {
      const first = createProject("first");
      const second = createProject("second");
      scheduleDestroy("first", NOW - HOUR, false);
      scheduleDestroy("second", NOW, true);
      const runner = recordingRunner([]);

      // A deploy of the second project cancels its removal meanwhile
      await destroyScheduledProjects(config, clock, (args, timeoutMs, cwd) => {
        if (cwd === first) {
          cancelScheduledDestroy("second");
        }
        return runner(args, timeoutMs, cwd);
      });

      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("removes nothing when the removal is cancelled during the backup", async () => {
      const dir = createProject("app");
      scheduleDestroy("app", NOW, true);
      const calls: string[][] = [];
      const runner = recordingRunner(calls);

      // A deploy cancels the removal while the database is exported
      await destroyScheduledProjects(config, clock, (args, timeoutMs, cwd) => {
        if (args[0] === "export-db") {
          cancelScheduledDestroy("app");
        }
        return runner(args, timeoutMs, cwd);
      });

      // No ddev delete, no directory removed, no schedule left
      expect(calls.map(([command]) => command)).toEqual(["describe", "export-db", "exec"]);
      expect(existsSync(dir)).toBe(true);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("keeps a project whose removal is cancelled and scheduled again during its backup", async () => {
      const dir = createProject("app");
      scheduleDestroy("app", NOW, true);
      const calls: string[][] = [];
      const runner = recordingRunner(calls);

      // A deploy cancels the removal, then a new one is scheduled for later
      await destroyScheduledProjects(config, clock, (args, timeoutMs, cwd) => {
        if (args[0] === "export-db") {
          scheduleDestroy("app", NOW + HOUR, false);
        }
        return runner(args, timeoutMs, cwd);
      });

      expect(calls.map(([command]) => command)).toEqual(["describe", "export-db", "exec"]);
      expect(existsSync(dir)).toBe(true);
      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + HOUR, backup: false, removing: false },
      ]);
    });

    it("refuses a cancel that comes after the backup and removes the project", async () => {
      const dir = createProject("app");
      scheduleDestroy("app", NOW, true);
      const calls: string[][] = [];
      const runner = recordingRunner(calls);
      const cancels: string[] = [];

      // A deploy tries to cancel the removal while ddev delete runs
      await destroyScheduledProjects(config, clock, (args, timeoutMs, cwd) => {
        if (args[0] === "delete") {
          cancels.push(cancelScheduledDestroy("app"));
          expect(getScheduledDestroys()).toEqual([
            { name: "app", destroyAt: NOW, backup: true, removing: true },
          ]);
        }
        return runner(args, timeoutMs, cwd);
      });

      // The deploy is told it is too late, and the removal goes on
      expect(cancels).toEqual(["removing"]);
      expect(calls.map(([command]) => command)).toEqual(["describe", "export-db", "exec", "delete"]);
      expect(existsSync(dir)).toBe(false);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("does not back the project up again when it retries a removal that failed after the backup", async () => {
      const dir = createProject("app");
      scheduleDestroy("app", NOW, true);
      const runner = recordingRunner([]);

      // The service stops while ddev delete runs
      await destroyScheduledProjects(config, clock, (args, timeoutMs, cwd) =>
        args[0] === "delete" ? Promise.reject(new Error("killed")) : runner(args, timeoutMs, cwd),
      );

      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(join(config.backup.dir, "app"))).toHaveLength(1);
      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW, backup: true, removing: true },
      ]);

      // DDEV has forgotten the project: a new backup would fail on ddev describe
      const calls: string[][] = [];
      await destroyScheduledProjects(config, clock, recordingRunner(calls));

      expect(calls).toEqual([["delete", "-Oy"]]);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(join(config.backup.dir, "app"))).toHaveLength(1);
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("runs one sweep at a time", async () => {
      const dir = createProject("app");
      scheduleDestroy("app", NOW, false);
      const calls: string[][] = [];
      let finishDelete = () => {};

      // The first sweep waits in ddev delete
      const first = destroyScheduledProjects(config, clock, (args) => {
        calls.push(args);
        return new Promise((resolve) => {
          finishDelete = () => resolve({ ok: true, stdout: "" });
        });
      });

      await vi.waitFor(() => expect(calls).toHaveLength(1));

      // A second sweep started meanwhile does nothing
      const second: string[][] = [];
      await destroyScheduledProjects(config, clock, recordingRunner(second));
      expect(second).toEqual([]);

      finishDelete();
      await first;

      expect(calls).toEqual([["delete", "-Oy"]]);
      expect(existsSync(dir)).toBe(false);
    });

    it("clears the schedule of a project that is already gone", async () => {
      scheduleDestroy("gone", NOW, false);
      const calls: string[][] = [];

      await destroyScheduledProjects(config, clock, recordingRunner(calls));

      expect(calls).toEqual([]);
      expect(getScheduledDestroys()).toEqual([]);
    });
  });

  describe("startScheduledDestroyScheduler", () => {
    let timer: NodeJS.Timeout | undefined;

    /** Let a sweep the timer started finish; setImmediate is not faked. */
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      clearInterval(timer);
      vi.useRealTimers();
    });

    it("sweeps on start, then every idle_check_interval", async () => {
      // Projects already gone: the sweep clears their schedule without ddev
      scheduleDestroy("first", NOW, false);

      timer = startScheduledDestroyScheduler(config);

      await settle();
      expect(getScheduledDestroys()).toEqual([]);

      scheduleDestroy("second", NOW, false);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
      expect(getScheduledDestroys().map((s) => s.name)).toEqual(["second"]);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(getScheduledDestroys()).toEqual([]);
    });

    it("reports a failed sweep and keeps the scheduler running", async () => {
      const error = vi.spyOn(console, "error");
      // No database: each sweep throws before it removes anything
      closeDb();

      expect(() => {
        timer = startScheduledDestroyScheduler(config);
      }).not.toThrow();
      await settle();
      expect(error).toHaveBeenCalledWith("Scheduled removal sweep failed:", expect.any(Error));

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await settle();
      expect(error).toHaveBeenCalledTimes(2);
      error.mockRestore();
    });
  });
});
