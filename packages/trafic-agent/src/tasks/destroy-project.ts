import { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { deleteProject } from "../utils/db.js";
import { loadProjectList, nodeDdevRunner, type DdevRunner } from "../utils/ddev.js";
import type { AgentConfig } from "../types.js";

/** Removing containers and volumes is slower than a stop. */
const DELETE_TIMEOUT_MS = 5 * 60 * 1000;

/** Whether `child` is strictly inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return Boolean(path) && !isAbsolute(path) && path.split(sep)[0] !== "..";
}

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
 * 1. Delete the DDEV project (containers, volumes, no snapshot)
 * 2. Remove the project directory
 * 3. Delete the project's records from the agent database
 *
 * A failed `ddev delete` does not stop the removal: a project DDEV has
 * already forgotten could otherwise never be cleaned up, and the next deploy
 * would find a stale directory.
 *
 * The database must be open (`initDb`). Returns false when there was no
 * project directory. The project's records are still deleted then, so a
 * retry after a run that failed between steps 2 and 3 cleans them up.
 */
export async function destroyProject(
  name: string,
  config: AgentConfig,
  run: DdevRunner = nodeDdevRunner,
): Promise<boolean> {
  const dir = resolveProjectDir(name, config);

  if (!isDirectory(dir)) {
    console.warn(`Project directory ${dir} does not exist — nothing to destroy`);
    deleteProject(name);
    return false;
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

  return true;
}
