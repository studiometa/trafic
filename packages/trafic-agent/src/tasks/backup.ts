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
import { BACKUP_DIR } from "../setup/agent.js";
import type { AgentConfig, BackupConfig } from "../types.js";

const execFileAsync = promisify(execFile);

/** Where DDEV mounts the project in the web container. */
const CONTAINER_APPROOT = "/var/www/html";

/**
 * Default time limit of a backup, the database dump and the files archive
 * together: a large database takes minutes, and upload directories can hold
 * gigabytes.
 */
export const BACKUP_TIMEOUT_MS = 40 * 60 * 1000;

/** Reading the upload directories is quick. */
const UPLOAD_DIRS_TIMEOUT_MS = 60_000;

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
async function findUploadDirs(dir: string, timeoutMs: number, run: DdevRunner): Promise<string[]> {
  const { ok, stdout } = await run(["exec", "printenv", "DDEV_FILES_DIRS"], timeoutMs, dir);

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

/**
 * Create the backup directory of one backup (see createBackupDir).
 *
 * The agent service runs in a systemd sandbox (`ProtectSystem=strict`) that
 * can write to a few paths only. A `[backup] dir` outside of them is
 * read-only for the service, so every scheduled backup fails and the
 * project is never removed: say so in the error, which the sweep logs.
 */
function createBackupTarget(target: string, backupDir: string, name: string): void {
  try {
    mkdirSync(join(backupDir, name), { recursive: true });
    createBackupDir(target, name);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;

    if (code !== "EROFS" && code !== "EACCES") {
      throw error;
    }

    throw new Error(
      `Cannot write to the backup directory ${backupDir} (${code}). ` +
        "The agent service runs in a systemd sandbox (ProtectSystem=strict) and can only write to " +
        `/var/lib/trafic, /home/ddev and ${BACKUP_DIR}: set [backup] dir inside one of them, ` +
        "writable by the ddev user",
      { cause: error },
    );
  }
}

/** Options of a backup. */
export interface BackupOptions {
  /**
   * Time limit of the backup: the database dump, the reading of the upload
   * directories and the files archive together (default:
   * BACKUP_TIMEOUT_MS). Starting and stopping the project are not part of
   * it.
   */
  timeoutMs?: number;
}

/** The time left before the deadline of the backup. */
function timeLeft(deadline: number): number {
  const left = deadline - Date.now();

  if (left <= 0) {
    throw new Error("No time is left for the next step");
  }

  return left;
}

/** A duration in the largest whole unit: 1h, 40m or 90s. */
function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.ceil(ms / 1000)}s`;
}

/**
 * The error of a backup that went over its time limit. The step that ran
 * out of time only fails (ddev reports a failed command, tar is killed), so
 * this says it was the time limit, and how to raise it.
 */
function timeoutError(timeoutMs: number, cause: unknown): Error {
  return new Error(
    `The backup timed out: it took longer than its time limit of ${formatDuration(timeoutMs)}. ` +
      "Raise the limit with --timeout",
    { cause },
  );
}

/**
 * Write the database dump and the upload archive of a running project.
 * Each step gets the time left before `deadline`.
 */
async function writeBackup(
  hasDatabase: boolean,
  dir: string,
  target: string,
  deadline: number,
  run: DdevRunner,
): Promise<void> {
  if (hasDatabase) {
    const file = join(target, "db.sql.gz");
    console.log(`Exporting the database to ${file}`);
    const { ok } = await run(["export-db", `--file=${file}`], timeLeft(deadline), dir);

    if (!ok) {
      throw new Error("Could not export the database");
    }
  } else {
    console.log("No database container — skipping the database dump");
  }

  const uploadDirs = await findUploadDirs(
    dir,
    Math.min(UPLOAD_DIRS_TIMEOUT_MS, timeLeft(deadline)),
    run,
  );

  if (uploadDirs.length === 0) {
    console.log("No upload directory — skipping the files archive");
    return;
  }

  const file = join(target, "files.tar.gz");
  console.log(`Archiving ${uploadDirs.join(", ")} to ${file}`);
  await archive(file, dir, uploadDirs, timeLeft(deadline));
}

/**
 * Archive paths of a directory to a tar.gz file.
 *
 * The project runs during the archive, and can write to its upload
 * directories at any time. GNU tar then exits with code 1 ("some files
 * differ"): the archive is written, with the changed file as tar read it.
 * That is accepted with a warning. Code 2 or more (a fatal error, such as an
 * unreadable file) and a timeout fail the archive.
 */
async function archive(file: string, dir: string, paths: string[], timeoutMs: number): Promise<void> {
  try {
    await execFileAsync("tar", ["-czf", file, "-C", dir, "--", ...paths], { timeout: timeoutMs });
  } catch (error) {
    const { code, killed } = error as { code?: unknown; killed?: boolean };

    if (code !== 1 || killed) {
      throw error;
    }

    console.warn("Some files changed while tar read them: the archive has them as tar read them");
  }
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
 * stopped again. A failed backup, or a backup that takes longer than its
 * time limit (`timeoutMs`), throws and leaves no backup directory. Returns
 * the backup directory.
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

  createBackupTarget(target, backupDir, name);

  try {
    if (!wasRunning) {
      console.log(`Starting ${name} for the backup`);

      if (!(await startProject(name, run))) {
        throw new Error(`Could not start ${name} for the backup`);
      }
    }

    // One time limit for all the steps, so the caller knows how long the
    // backup can take
    const timeoutMs = options.timeoutMs ?? BACKUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    try {
      await writeBackup(info.dbType !== undefined, dir, target, deadline, run);
    } catch (error) {
      throw Date.now() >= deadline ? timeoutError(timeoutMs, error) : error;
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
 * that this removal leaves empty. Only directories with a backup timestamp
 * name are removed, and a project directory only when this sweep removed a
 * backup from it: `dir` can be a shared directory, with empty directories
 * that are not backups. Returns the number of backups removed.
 */
export function removeOldBackups(config: BackupConfig, now = Date.now()): number {
  const cutoff = now - config.retainDays * DAY_MS;
  let removed = 0;

  for (const project of listDirs(config.dir)) {
    const projectDir = join(config.dir, project);
    let removedFromProject = 0;

    for (const name of listDirs(projectDir)) {
      const time = parseBackupTimestamp(name);

      if (time !== undefined && time < cutoff) {
        rmSync(join(projectDir, name), { recursive: true, force: true });
        console.log(`Removed old backup: ${project}/${name}`);
        removedFromProject++;
      }
    }

    removed += removedFromProject;

    if (removedFromProject === 0) {
      continue;
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
