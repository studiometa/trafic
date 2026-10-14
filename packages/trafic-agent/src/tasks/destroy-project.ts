import { existsSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backupProject, type BackupOptions } from "./backup.js";
import { deleteProject, getProject, setProjectStatus } from "../utils/db.js";
import { loadProjectList, nodeDdevRunner, type DdevRunner } from "../utils/ddev.js";
import { isInside } from "../utils/paths.js";
import type { AgentConfig } from "../types.js";

/** Removing containers and volumes is slower than a stop. */
const DELETE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Find the directory of a project, and refuse one outside the projects
 * directory.
 *
 * DDEV's project list gives the real app root. A project DDEV has already
 * forgotten is looked for at `<projects_dir>/<name>`, where `trafic deploy`
 * puts it, so its directory can still be cleaned up.
 *
 * The check stands between a name typed on a command line and an
 * `rm -rf`: an empty name, `..` or an app root of `/` must never reach it.
 * The path is checked as written, then, when it exists, with its symbolic
 * links followed: a symlinked project directory or parent directory could
 * otherwise point `ddev delete` and the removal at a directory outside the
 * projects directory.
 */
export function resolveProjectDir(name: string, config: AgentConfig): string {
  if (!name.trim() || name === "." || name === ".." || name.includes("/")) {
    throw new Error(`Invalid project name: "${name}"`);
  }

  const projectsDir = resolve(config.projectsDir);
  const appRoot = loadProjectList(config.projectListPath).get(name);
  const dir = resolve(appRoot || join(projectsDir, name));

  if (!isInside(projectsDir, dir)) {
    throw new Error(
      `Refusing to remove ${dir}: it is not inside the projects directory ${projectsDir}. ` +
        "Set projects_dir in the agent config to the directory that `trafic deploy` uses",
    );
  }

  checkRealPath(dir, projectsDir);

  return dir;
}

/**
 * Refuse an existing project directory that is a symbolic link, or that a
 * symbolic link in its path takes outside the projects directory. A path
 * that does not exist is left to the caller: there is nothing to remove.
 */
function checkRealPath(dir: string, projectsDir: string): void {
  let stats;

  try {
    stats = lstatSync(dir);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;

    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to remove ${dir}: it is a symbolic link`);
  }

  const realDir = realpathSync(dir);
  const realProjectsDir = realpathSync(projectsDir);

  if (!isInside(realProjectsDir, realDir)) {
    throw new Error(
      `Refusing to remove ${dir}: it resolves to ${realDir}, ` +
        `which is not inside the projects directory ${realProjectsDir}`,
    );
  }
}

/**
 * Refuse a backup directory that is the project directory or inside it: the
 * removal would delete the backup right after it is written. validateConfig
 * already refuses a backup.dir in projects_dir; this also follows symbolic
 * links. It checks `<backup.dir>/<name>`, where the backup goes, so a
 * symbolic link at that level is followed too.
 */
function checkBackupDir(backupDir: string, name: string, dir: string): void {
  const target = resolve(backupDir, name);
  const realTarget = realpathOfNearest(target);
  const realDir = realpathSync(dir);

  if (target === dir || isInside(dir, target) || realTarget === realDir || isInside(realDir, realTarget)) {
    throw new Error(
      `Refusing to back up to ${backupDir}: it is inside the project directory ${dir}, which the removal deletes`,
    );
  }
}

/**
 * The real path of a path that may not exist yet: the real path of its
 * nearest existing ancestor, plus the rest of the path. The backup creates
 * the missing directories through the symbolic links of that ancestor.
 */
function realpathOfNearest(path: string): string {
  const rest: string[] = [];
  let current = path;

  while (!existsSync(current)) {
    const parent = dirname(current);

    if (parent === current) break;

    rest.unshift(basename(current));
    current = parent;
  }

  return join(realpathSync(current), ...rest);
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
 * Remove a project from the server.
 *
 * Steps:
 * 1. With `backup`, back up the database and the upload directories, all
 *    within `timeoutMs` when it is given
 * 2. Delete the DDEV project (containers, volumes, no snapshot)
 * 3. Remove the project directory
 * 4. Delete the project's records from the agent database
 *
 * A failed backup throws before anything is removed.
 *
 * A failed `ddev delete` does not stop the removal: a project DDEV has
 * already forgotten could otherwise never be cleaned up, and the next deploy
 * would find a stale directory.
 *
 * While the removal runs, the project has the status "destroying", which the
 * idle sweep never stops: the backup can take many minutes, and a stop in
 * the middle of it fails the backup. The status is in the database, so the
 * service sees it when `trafic-agent destroy` runs from the command line. A
 * removal that fails sets the status back: "running" when it was, else
 * "stopped".
 *
 * The database must be open (`initDb`). Returns false when there was no
 * project directory. The project's records are still deleted then, so a
 * retry after a run that failed between steps 2 and 3 cleans them up.
 */
export async function destroyProject(
  name: string,
  config: AgentConfig,
  options: { backup?: boolean } & BackupOptions = {},
  run: DdevRunner = nodeDdevRunner,
): Promise<boolean> {
  const dir = resolveProjectDir(name, config);

  if (!isDirectory(dir)) {
    console.warn(`Project directory ${dir} does not exist — nothing to destroy`);
    deleteProject(name);
    return false;
  }

  if (options.backup) {
    checkBackupDir(config.backup.dir, name, dir);
  }

  const previous = getProject(name)?.status;
  setProjectStatus(name, "destroying");

  try {
    await removeProject(name, dir, config, options, run);
  } catch (error) {
    setProjectStatus(name, previous === "running" ? "running" : "stopped");
    throw error;
  }

  return true;
}

/** The steps of destroyProject, once the project is marked "destroying". */
async function removeProject(
  name: string,
  dir: string,
  config: AgentConfig,
  options: { backup?: boolean } & BackupOptions,
  run: DdevRunner,
): Promise<void> {
  if (options.backup) {
    console.log(`Backing up ${name}`);
    await backupProject(name, dir, config.backup.dir, { timeoutMs: options.timeoutMs }, run);
  }

  console.log(`Deleting DDEV project: ${name}`);
  const { ok } = await run(["delete", "-Oy"], DELETE_TIMEOUT_MS, dir);

  if (!ok) {
    console.warn("DDEV delete failed — project may not be a valid DDEV project");
  }

  console.log(`Removing ${dir}`);
  rmSync(dir, { recursive: true, force: true });

  deleteProject(name);
  console.log(`Destroyed: ${name}`);
}
