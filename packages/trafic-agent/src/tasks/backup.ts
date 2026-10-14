import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import {
  getProjectInfo,
  nodeDdevRunner,
  startProject,
  stopProject,
  type DdevRunner,
} from "../utils/ddev.js";
import type { AgentConfig, BackupConfig } from "../types.js";

const execFileAsync = promisify(execFile);

/** Where DDEV mounts the project in the web container. */
const CONTAINER_APPROOT = "/var/www/html";

/** A dump of a large database takes minutes. */
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

/** Upload directories can hold gigabytes. */
const ARCHIVE_TIMEOUT_MS = 30 * 60 * 1000;

/** Retention is counted in days, so an hourly sweep is enough. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A backup directory name: an ISO date in UTC, with `-` for `:`. */
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/;

/** The name of a backup directory, e.g. `2026-10-14T07-40-24Z`. */
export function backupTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
}

/** The time of a backup directory name, or undefined for any other name. */
function parseBackupTimestamp(name: string): number | undefined {
  const match = TIMESTAMP.exec(name);

  if (!match) {
    return undefined;
  }

  const [, day, hours, minutes, seconds] = match;
  const time = Date.parse(`${day}T${hours}:${minutes}:${seconds}Z`);

  return Number.isNaN(time) ? undefined : time;
}

/** Whether a path is an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The upload directories of a project, relative to its directory.
 *
 * DDEV resolves them: `upload_dirs` from the project config, or the default
 * of the project type (`wp-content/uploads` for WordPress, for instance).
 * Neither `ddev describe` nor `ddev utility configyaml` shows the type
 * default, but DDEV gives the result to the web container as
 * `DDEV_FILES_DIRS`, comma-separated container paths. The project must be
 * running.
 *
 * A directory that does not exist on the host is left out.
 */
async function findUploadDirs(dir: string, run: DdevRunner): Promise<string[]> {
  const { ok, stdout } = await run(["exec", "printenv", "DDEV_FILES_DIRS"], 60_000, dir);

  if (!ok) {
    throw new Error("Could not read the upload directories (DDEV_FILES_DIRS)");
  }

  return stdout
    .trim()
    .split(",")
    .filter(Boolean)
    .map((path) => posix.relative(CONTAINER_APPROOT, path))
    .filter((path) => path && !path.startsWith("..") && !posix.isAbsolute(path))
    .filter((path) => isDirectory(join(dir, path)));
}

/** Options of a backup. */
export interface BackupOptions {
  /**
   * Time limit of each step, the database dump and the files archive.
   * Defaults to EXPORT_TIMEOUT_MS for the dump and ARCHIVE_TIMEOUT_MS for
   * the archive.
   */
  timeoutMs?: number;
}

/**
 * Write the database dump and the upload archive of a running project.
 */
async function writeBackup(
  hasDatabase: boolean,
  dir: string,
  target: string,
  { timeoutMs }: BackupOptions,
  run: DdevRunner,
): Promise<void> {
  if (hasDatabase) {
    const file = join(target, "db.sql.gz");
    console.log(`Exporting the database to ${file}`);
    const { ok } = await run(
      ["export-db", `--file=${file}`],
      timeoutMs ?? EXPORT_TIMEOUT_MS,
      dir,
    );

    if (!ok) {
      throw new Error("Could not export the database");
    }
  } else {
    console.log("No database container — skipping the database dump");
  }

  const uploadDirs = await findUploadDirs(dir, run);

  if (uploadDirs.length === 0) {
    console.log("No upload directory — skipping the files archive");
    return;
  }

  const file = join(target, "files.tar.gz");
  console.log(`Archiving ${uploadDirs.join(", ")} to ${file}`);
  await execFileAsync("tar", ["-czf", file, "-C", dir, "--", ...uploadDirs], {
    timeout: timeoutMs ?? ARCHIVE_TIMEOUT_MS,
  });
}

/**
 * Create the directory of one backup. It must not exist: two backups of a
 * project in the same second would share it, and the one that fails would
 * remove the files of the other. The second one fails here, before it
 * changes anything.
 */
function createBackupDir(target: string, name: string): void {
  try {
    mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${target} already exists: another backup of ${name} runs or ran in the same second`);
    }

    throw error;
  }
}

/**
 * Back up a DDEV project to `<backupDir>/<name>/<timestamp>`.
 *
 * The backup holds:
 * - `db.sql.gz`: the `ddev export-db` dump, unless the project omits the db
 *   container
 * - `files.tar.gz`: the upload directories, with paths relative to the
 *   project directory, unless the project has none
 *
 * Both need the project running, so a stopped project is started, then
 * stopped again. A failed backup, or a step that takes longer than its time
 * limit, throws and leaves no backup directory. Returns the backup
 * directory.
 */
export async function backupProject(
  name: string,
  dir: string,
  backupDir: string,
  options: BackupOptions = {},
  run: DdevRunner = nodeDdevRunner,
): Promise<string> {
  const info = await getProjectInfo(name, run);

  if (!info) {
    throw new Error(`Could not describe the DDEV project ${name}`);
  }

  const target = join(backupDir, name, backupTimestamp(new Date()));
  const wasRunning = info.status === "running";

  mkdirSync(join(backupDir, name), { recursive: true });
  createBackupDir(target, name);

  try {
    if (!wasRunning) {
      console.log(`Starting ${name} for the backup`);

      if (!(await startProject(name, run))) {
        throw new Error(`Could not start ${name} for the backup`);
      }
    }

    try {
      await writeBackup(info.dbType !== undefined, dir, target, options, run);
    } finally {
      if (!wasRunning && !(await stopProject(name, run))) {
        console.warn(`Could not stop ${name} after the backup`);
      }
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  console.log(`Backup saved to ${target}`);
  return target;
}

/** The subdirectories of a directory, or none when it does not exist. */
function listDirs(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Remove the backups older than `retainDays`, and the project directories
 * left empty. Only directories with a backup timestamp name are removed.
 * Returns the number of backups removed.
 */
export function removeOldBackups(config: BackupConfig, now = Date.now()): number {
  const cutoff = now - config.retainDays * DAY_MS;
  let removed = 0;

  for (const project of listDirs(config.dir)) {
    const projectDir = join(config.dir, project);

    for (const name of listDirs(projectDir)) {
      const time = parseBackupTimestamp(name);

      if (time !== undefined && time < cutoff) {
        rmSync(join(projectDir, name), { recursive: true, force: true });
        console.log(`Removed old backup: ${project}/${name}`);
        removed++;
      }
    }

    try {
      if (readdirSync(projectDir).length === 0) {
        rmdirSync(projectDir);
      }
    } catch {
      // A backup started meanwhile: the directory is in use again
    }
  }

  return removed;
}

/** A sweep that throws must not take the scheduler down with it. */
function sweepBackups(config: BackupConfig): void {
  try {
    removeOldBackups(config);
  } catch (error) {
    console.error("Backup sweep failed:", error);
  }
}

/**
 * Start the backup retention sweep
 */
export function startBackupSweepScheduler(config: AgentConfig): NodeJS.Timeout {
  console.log(
    `Backup sweep started: removing backups older than ${config.backup.retainDays} days from ${config.backup.dir}`,
  );

  // Run immediately on start
  sweepBackups(config.backup);

  // Then run on interval
  return setInterval(() => sweepBackups(config.backup), SWEEP_INTERVAL_MS);
}
