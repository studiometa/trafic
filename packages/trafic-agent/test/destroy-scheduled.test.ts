import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  destroyScheduledProjects,
  scheduleProjectDestroy,
} from "../src/tasks/destroy-scheduled.js";
import { initDb, closeDb, getScheduledDestroys, scheduleDestroy } from "../src/utils/db.js";
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
        { name: "app", destroyAt: NOW + 48 * HOUR, backup: false },
      ]);
    });

    it("records that the removal must back up first", () => {
      scheduleProjectDestroy("app", "1h30m", config, { backup: true }, clock);

      expect(getScheduledDestroys()).toEqual([
        { name: "app", destroyAt: NOW + 1.5 * HOUR, backup: true },
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

    it("clears the schedule of a project that is already gone", async () => {
      scheduleDestroy("gone", NOW, false);
      const calls: string[][] = [];

      await destroyScheduledProjects(config, clock, recordingRunner(calls));

      expect(calls).toEqual([]);
      expect(getScheduledDestroys()).toEqual([]);
    });
  });
});
