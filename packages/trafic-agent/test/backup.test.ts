import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { listBackups, cleanOldBackups, findBackup } from "../src/tasks/backup.js";
import type { BackupConfig } from "../src/types.js";

/**
 * Create a temporary directory for test backups
 */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "trafic-backup-test-"));
}

/**
 * Create a fake backup file in the given date directory
 */
function createFakeBackup(baseDir: string, date: string, project: string, content = "fake sql"): void {
  const dir = join(baseDir, date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${project}.sql.gz`), content);
}

describe("listBackups", () => {
  let tempDir: string;
  let config: BackupConfig;

  beforeEach(() => {
    tempDir = createTempDir();
    config = {
      enabled: true,
      scheduleHour: 3,
      retainDays: 7,
      localDir: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no backups exist", () => {
    const entries = listBackups(config);
    expect(entries).toEqual([]);
  });

  it("returns empty array when backup dir does not exist", () => {
    const entries = listBackups({ ...config, localDir: "/nonexistent" });
    expect(entries).toEqual([]);
  });

  it("lists backups sorted by date (newest first)", () => {
    createFakeBackup(tempDir, "2026-02-01", "app-a");
    createFakeBackup(tempDir, "2026-02-03", "app-b");
    createFakeBackup(tempDir, "2026-02-02", "app-a");

    const entries = listBackups(config);

    expect(entries.length).toBe(3);
    expect(entries[0].date).toBe("2026-02-03");
    expect(entries[1].date).toBe("2026-02-02");
    expect(entries[2].date).toBe("2026-02-01");
  });

  it("includes correct metadata", () => {
    createFakeBackup(tempDir, "2026-02-09", "my-project", "some content here");

    const entries = listBackups(config);

    expect(entries.length).toBe(1);
    expect(entries[0].project).toBe("my-project");
    expect(entries[0].date).toBe("2026-02-09");
    expect(entries[0].file).toBe(join(tempDir, "2026-02-09", "my-project.sql.gz"));
    expect(entries[0].sizeBytes).toBeGreaterThan(0);
  });

  it("ignores non-date directories", () => {
    mkdirSync(join(tempDir, "random-dir"), { recursive: true });
    mkdirSync(join(tempDir, "not-a-date"), { recursive: true });
    createFakeBackup(tempDir, "2026-02-09", "app");

    const entries = listBackups(config);
    expect(entries.length).toBe(1);
  });
});

describe("cleanOldBackups", () => {
  let tempDir: string;
  let config: BackupConfig;

  beforeEach(() => {
    tempDir = createTempDir();
    config = {
      enabled: true,
      scheduleHour: 3,
      retainDays: 3,
      localDir: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes backups older than retention period", () => {
    // Create backups: today, 2 days ago, 5 days ago, 10 days ago
    const today = new Date();
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(today.getDate() - 2);
    const fiveDaysAgo = new Date(today);
    fiveDaysAgo.setDate(today.getDate() - 5);
    const tenDaysAgo = new Date(today);
    tenDaysAgo.setDate(today.getDate() - 10);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    createFakeBackup(tempDir, fmt(today), "app");
    createFakeBackup(tempDir, fmt(twoDaysAgo), "app");
    createFakeBackup(tempDir, fmt(fiveDaysAgo), "app");
    createFakeBackup(tempDir, fmt(tenDaysAgo), "app");

    const removed = cleanOldBackups(config);

    // 5 and 10 days ago should be removed (older than 3 days)
    expect(removed).toBe(2);

    // Verify remaining directories
    const remaining = readdirSync(tempDir);
    expect(remaining).toContain(fmt(today));
    expect(remaining).toContain(fmt(twoDaysAgo));
    expect(remaining).not.toContain(fmt(fiveDaysAgo));
    expect(remaining).not.toContain(fmt(tenDaysAgo));
  });

  it("does nothing when backup dir does not exist", () => {
    const removed = cleanOldBackups({ ...config, localDir: "/nonexistent" });
    expect(removed).toBe(0);
  });

  it("does nothing when all backups are recent", () => {
    const today = new Date().toISOString().slice(0, 10);
    createFakeBackup(tempDir, today, "app");

    const removed = cleanOldBackups(config);
    expect(removed).toBe(0);
  });
});

describe("findBackup", () => {
  let tempDir: string;
  let config: BackupConfig;

  beforeEach(() => {
    tempDir = createTempDir();
    config = {
      enabled: true,
      scheduleHour: 3,
      retainDays: 7,
      localDir: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds the most recent backup when no date is specified", () => {
    createFakeBackup(tempDir, "2026-02-07", "my-app");
    createFakeBackup(tempDir, "2026-02-09", "my-app");
    createFakeBackup(tempDir, "2026-02-08", "my-app");

    const file = findBackup(config, "my-app");
    expect(file).toBe(join(tempDir, "2026-02-09", "my-app.sql.gz"));
  });

  it("finds a backup for a specific date", () => {
    createFakeBackup(tempDir, "2026-02-07", "my-app");
    createFakeBackup(tempDir, "2026-02-09", "my-app");

    const file = findBackup(config, "my-app", "2026-02-07");
    expect(file).toBe(join(tempDir, "2026-02-07", "my-app.sql.gz"));
  });

  it("returns undefined when no backup exists for the project", () => {
    createFakeBackup(tempDir, "2026-02-09", "other-app");

    const file = findBackup(config, "my-app");
    expect(file).toBeUndefined();
  });

  it("returns undefined for a specific date with no backup", () => {
    createFakeBackup(tempDir, "2026-02-09", "my-app");

    const file = findBackup(config, "my-app", "2026-02-08");
    expect(file).toBeUndefined();
  });

  it("returns undefined when backup dir does not exist", () => {
    const file = findBackup({ ...config, localDir: "/nonexistent" }, "my-app");
    expect(file).toBeUndefined();
  });
});
