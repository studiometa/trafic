import {
  getProject,
  setProjectStatus,
  updateProjectAccess,
} from "../utils/db.js";
import { listProjects, stopProject } from "../utils/ddev.js";
import type { DdevProject } from "../types.js";

/**
 * What the limit needs from the outside world. Injected so a test can set
 * the DDEV state and record the stops without a DDEV install.
 */
export interface RunningLimitDeps {
  listProjects: () => Promise<DdevProject[]>;
  stopProject: (name: string) => Promise<boolean>;
  getProject: typeof getProject;
  setProjectStatus: (name: string, status: "running" | "stopped") => void;
  updateProjectAccess: (name: string) => void;
}

/** The real dependencies, used unless a caller passes its own. */
export const nodeRunningLimitDeps: RunningLimitDeps = {
  listProjects: () => listProjects(),
  stopProject: (name) => stopProject(name),
  getProject,
  setProjectStatus: (name, status) => setProjectStatus(name, status),
  updateProjectAccess: (name) => updateProjectAccess(name),
};

export interface RunningLimitOptions {
  /** max_running_projects: 0 means no limit */
  max: number;
  /** Slots to keep free: 1 before the agent starts a project, else 0 */
  reserve: number;
  /** Whether a project's own config says never to stop it */
  neverStops: (name: string) => boolean;
}

/** DDEV states where the project's containers are up and use memory. */
function isUp(project: DdevProject): boolean {
  return (
    project.status === "running" ||
    project.status === "starting" ||
    project.status === "unhealthy"
  );
}

/**
 * Stop the least recently used projects until `max - reserve` or fewer run.
 *
 * The count comes from `ddev list`, not from the database: `trafic deploy`
 * runs `ddev start` itself, so the database does not know about every
 * running project.
 *
 * For the same reason, the database is first brought in line with DDEV. A
 * project that runs while the database says it is stopped (or has no record
 * of it) was started outside the agent, most likely by a deploy. Its last
 * access is then old or missing, which would make it the first one stopped,
 * right after the deploy. It is recorded as accessed now instead. A project
 * the database says runs while DDEV says it does not was stopped outside the
 * agent, and is recorded as stopped, so its next start is seen too.
 *
 * Projects with `idle_timeout: never` and projects the agent is starting are
 * never stopped. When no other project can be stopped, a warning is logged
 * and the server stays over the limit.
 *
 * Returns the names of the projects it stopped.
 */
export async function enforceRunningLimit(
  options: RunningLimitOptions,
  deps: RunningLimitDeps = nodeRunningLimitDeps,
): Promise<string[]> {
  const { max, reserve, neverStops } = options;

  if (max <= 0) return [];

  const projects = await deps.listProjects();
  const up = projects.filter(isUp);

  for (const project of projects) {
    const status = deps.getProject(project.name)?.status;

    if (isUp(project) && (status === undefined || status === "stopped")) {
      deps.updateProjectAccess(project.name);
      deps.setProjectStatus(project.name, "running");
    } else if (!isUp(project) && status === "running") {
      deps.setProjectStatus(project.name, "stopped");
    }
  }

  const excess = up.length + reserve - max;

  if (excess <= 0) return [];

  const candidates = up
    .map((project) => deps.getProject(project.name))
    .filter((record) => record !== undefined)
    .filter((record) => record.status !== "starting" && !neverStops(record.name))
    .sort((a, b) => a.lastAccess - b.lastAccess)
    .slice(0, excess);

  const stopped: string[] = [];

  for (const record of candidates) {
    console.log(
      `Stopping ${record.name}: ${up.length} projects running, max_running_projects is ${max}`,
    );

    if (await deps.stopProject(record.name)) {
      deps.setProjectStatus(record.name, "stopped");
      stopped.push(record.name);
    } else {
      console.error(`Failed to stop: ${record.name}`);
    }
  }

  if (stopped.length < excess) {
    console.warn(
      `${up.length - stopped.length} projects running, max_running_projects is ${max}: no other project can be stopped`,
    );
  }

  return stopped;
}
