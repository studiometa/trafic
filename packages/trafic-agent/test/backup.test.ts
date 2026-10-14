import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_TIMEOUT_MS,
  backupProject,
  backupTimestamp,
  removeOldBackups,
} from "../src/tasks/backup.js";
import type { DdevRunner } from "../src/utils/ddev.js";

// The task reports progress; keep it out of the test output
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeDdevOptions {
  /** What ddev describe reports */
  status?: string;
  /** Whether the project has a db container */
  database?: boolean;
  /** DDEV_FILES_DIRS in the web container */
  filesDirs?: string;
  /** Commands (first argument) that fail */
  fails?: string[];
}

/** A ddev that answers from a fixed project and records each call. */
function fakeDdev(options: FakeDdevOptions, calls: string[][]): DdevRunner {
  const { status = "running", database = true, filesDirs = "", fails = [] } = options;

  return (args) => {
    calls.push(args);
    const ok = !fails.includes(args[0]!);

    if (args[0] === "describe") {
      const raw = { name: args[1], status, ...(database ? { dbinfo: { database_type: "mariadb" } } : {}) };
      return Promise.resolve({ ok, stdout: JSON.stringify({ raw }) });
    }

    if (args[0] === "exec") {
      return Promise.resolve({ ok, stdout: `${filesDirs}\n` });
    }

    return Promise.resolve({ ok, stdout: "" });
  };
}

/** The entries of a tar.gz archive. */
function archiveEntries(file: string): string[] {
  return execFileSync("tar", ["-tzf", file], { encoding: "utf-8" }).trim().split("\n");
}

describe("backupTimestamp", () => {
  it("names a backup after the UTC time, without colons", () => {
    expect(backupTimestamp(new Date("2026-10-14T07:40:24.123Z"))).toBe("2026-10-14T07-40-24Z");
  });
});

describe("backupProject", () => {
  let root: string;
  let projectDir: string;
  let backupDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "trafic-backup-"));
    projectDir = join(root, "www", "app");
    backupDir = join(root, "backups");
    mkdirSync(join(projectDir, "web", "wp-content", "uploads", "2026"), { recursive: true });
    writeFileSync(join(projectDir, "web", "wp-content", "uploads", "2026", "photo.jpg"), "jpg");
    writeFileSync(join(projectDir, "index.php"), "<?php");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fake ddev that also records the time limit of the export. */
  function timedDdev(exportTimeouts: number[]): DdevRunner {
    const ddev = fakeDdev({}, []);

    return (args, timeoutMs, cwd) => {
      if (args[0] === "export-db") {
        exportTimeouts.push(timeoutMs);
      }

      return ddev(args, timeoutMs, cwd);
    };
  }

  it("exports the database and archives the upload directories", async () => {
    const calls: string[][] = [];
    const ddev = fakeDdev({ filesDirs: "/var/www/html/web/wp-content/uploads" }, calls);

    const target = await backupProject("app", projectDir, backupDir, {}, ddev);

    expect(target.startsWith(join(backupDir, "app") + "/")).toBe(true);
    expect(calls).toEqual([
      ["describe", "app", "-j"],
      ["export-db", `--file=${join(target, "db.sql.gz")}`],
      ["exec", "printenv", "DDEV_FILES_DIRS"],
    ]);
    // Paths stay relative to the project directory, so the archive restores
    // in place
    expect(archiveEntries(join(target, "files.tar.gz"))).toContain(
      "web/wp-content/uploads/2026/photo.jpg",
    );
    expect(archiveEntries(join(target, "files.tar.gz"))).not.toContain("index.php");
  });

  it("starts a stopped project for the backup, then stops it again", async () => {
    const calls: string[][] = [];

    await backupProject("app", projectDir, backupDir, {}, fakeDdev({ status: "stopped" }, calls));

    expect(calls[1]).toEqual(["start", "app"]);
    expect(calls.at(-1)).toEqual(["stop", "app"]);
  });

  it("leaves a running project running", async () => {
    const calls: string[][] = [];

    await backupProject("app", projectDir, backupDir, {}, fakeDdev({}, calls));

    expect(calls.some(([command]) => command === "start" || command === "stop")).toBe(false);
  });

  it("skips the dump when the project has no database", async () => {
    const calls: string[][] = [];

    const target = await backupProject(
      "app",
      projectDir,
      backupDir,
      {},
      fakeDdev({ database: false, filesDirs: "/var/www/html/web/wp-content/uploads" }, calls),
    );

    expect(calls.some(([command]) => command === "export-db")).toBe(false);
    expect(readdirSync(target)).toEqual(["files.tar.gz"]);
  });

  it("skips the archive when no upload directory exists", async () => {
    const target = await backupProject(
      "app",
      projectDir,
      backupDir,
      {},
      // Missing on the host, and outside the project
      fakeDdev({ filesDirs: "/var/www/html/web/sites/default/files,/etc" }, []),
    );

    expect(existsSync(join(target, "files.tar.gz"))).toBe(false);
  });

  it("archives every upload directory DDEV lists", async () => {
    mkdirSync(join(projectDir, "private"));
    writeFileSync(join(projectDir, "private", "invoice.pdf"), "pdf");

    const target = await backupProject(
      "app",
      projectDir,
      backupDir,
      {},
      fakeDdev({ filesDirs: "/var/www/html/web/wp-content/uploads,/var/www/html/private" }, []),
    );

    const entries = archiveEntries(join(target, "files.tar.gz"));
    expect(entries).toContain("web/wp-content/uploads/2026/photo.jpg");
    expect(entries).toContain("private/invoice.pdf");
  });

  it("fails and keeps no partial backup when the export fails", async () => {
    const calls: string[][] = [];

    await expect(
      backupProject("app", projectDir, backupDir, {}, fakeDdev({ status: "stopped", fails: ["export-db"] }, calls)),
    ).rejects.toThrow(/Could not export the database/);

    expect(readdirSync(join(backupDir, "app"))).toEqual([]);
    // Left as found
    expect(calls.at(-1)).toEqual(["stop", "app"]);
  });

  it("fails when the project cannot be started", async () => {
    await expect(
      backupProject("app", projectDir, backupDir, {}, fakeDdev({ status: "stopped", fails: ["start"] }, [])),
    ).rejects.toThrow(/Could not start app/);

    expect(readdirSync(join(backupDir, "app"))).toEqual([]);
  });

  it("fails when the upload directories cannot be read", async () => {
    await expect(
      backupProject("app", projectDir, backupDir, {}, fakeDdev({ fails: ["exec"] }, [])),
    ).rejects.toThrow(/upload directories/);
  });

  it("gives the export 10 minutes by default", async () => {
    const exportTimeouts: number[] = [];

    await backupProject("app", projectDir, backupDir, {}, timedDdev(exportTimeouts));

    expect(exportTimeouts).toEqual([EXPORT_TIMEOUT_MS]);
  });

  it("gives the export the time limit it is given", async () => {
    const exportTimeouts: number[] = [];

    await backupProject("app", projectDir, backupDir, { timeoutMs: 3_600_000 }, timedDdev(exportTimeouts));

    expect(exportTimeouts).toEqual([3_600_000]);
  });

  it("fails when DDEV does not know the project", async () => {
    await expect(
      backupProject("app", projectDir, backupDir, {}, fakeDdev({ fails: ["describe"] }, [])),
    ).rejects.toThrow(/Could not describe the DDEV project app/);

    expect(existsSync(backupDir)).toBe(false);
  });
});

describe("removeOldBackups", () => {
  let dir: string;
  const now = Date.parse("2026-10-14T12:00:00Z");

  /** Create a backup directory for a project, `days` days before now. */
  function createBackup(project: string, days: number): string {
    const path = join(dir, project, backupTimestamp(new Date(now - days * DAY_MS)));
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "db.sql.gz"), "dump");
    return path;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trafic-backups-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the backups older than retain_days and keeps the others", () => {
    const old = createBackup("app", 15);
    const recent = createBackup("app", 13);

    expect(removeOldBackups({ dir, retainDays: 14 }, now)).toBe(1);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("removes a project directory once its last backup is gone", () => {
    createBackup("gone", 30);
    createBackup("kept", 1);

    removeOldBackups({ dir, retainDays: 14 }, now);

    expect(readdirSync(dir)).toEqual(["kept"]);
  });

  it("leaves directories it did not create alone", () => {
    mkdirSync(join(dir, "app", "manual-copy"), { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "keep");

    expect(removeOldBackups({ dir, retainDays: 1 }, now)).toBe(0);

    expect(existsSync(join(dir, "app", "manual-copy"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("does nothing when the backup directory does not exist", () => {
    expect(removeOldBackups({ dir: join(dir, "missing"), retainDays: 14 }, now)).toBe(0);
  });
});

