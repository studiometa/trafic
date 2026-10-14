import { rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { deleteProject } from "../utils/db.js";
import { loadProjectList, nodeDdevRunner, type DdevRunner } from "../utils/ddev.js";
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
 */
export function resolveProjectDir(name: string, config: AgentConfig): string {
  if (!name.trim() || name === "." || name === ".." || name.includes("/")) {
    throw new Error(`Invalid project name: "${name}"`);
  }

  const projectsDir = resolve(config.projectsDir);
  const appRoot = loadProjectList(config.projectListPath).get(name);
  const dir = resolve(appRoot || join(projectsDir, name));
  const path = relative(projectsDir, dir);

  if (!path || isAbsolute(path) || path.split(sep)[0] === "..") {
    throw new Error(
      `Refusing to remove ${dir}: it is not inside the projects directory ${projectsDir}`,
    );
  }

  return dir;
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
 * project directory, in which case nothing is changed.
 */
export async function destroyProject(
  name: string,
  config: AgentConfig,
  run: DdevRunner = nodeDdevRunner,
): Promise<boolean> {
  const dir = resolveProjectDir(name, config);

  if (!isDirectory(dir)) {
    console.warn(`Project directory ${dir} does not exist — nothing to destroy`);
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
