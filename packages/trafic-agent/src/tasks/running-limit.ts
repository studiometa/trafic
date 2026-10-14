import {
  getProject,
  setProjectStatus,
  updateProjectAccess,
} from "../utils/db.js";
import { listProjects, stopProject } from "../utils/ddev.js";
import type { DdevProject, ProjectRecord } from "../types.js";

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

/** Whether the agent works on a project, so it must not be stopped. */
function isBusy(record: ProjectRecord): boolean {
  return record.status === "starting" || record.status === "destroying";
}

export interface RunningLimitOptions {
  /** max_running_projects: 0 means no limit */
  max: number;
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
 * Stop the least recently used projects until `max` or fewer run.
 *
 * A project runs when `ddev list` shows it up, or when the agent is starting
 * it (status "starting" in the database). `ddev list` is the source because
 * `trafic deploy` runs `ddev start` itself, so the database does not know
 * about every running project. The projects the agent is starting count too,
 * because DDEV shows them stopped until their containers exist: the waiting
 * page marks its project "starting" before it calls this, so that project
 * counts once whether DDEV shows it up or not, and calls made for starts at
 * the same time each see all of them.
 *
 * Because of deploys, the database is first brought in line with DDEV. A
 * project that runs while the database says it is stopped (or has no record
 * of it) was started outside the agent, most likely by a deploy. Its last
 * access is then old or missing, which would make it the first one stopped,
 * right after the deploy. It is recorded as accessed now instead. A project
 * the database says runs while DDEV says it does not was stopped outside the
 * agent, and is recorded as stopped, so its next start is seen too.
 *
 * Projects with `idle_timeout: never`, projects the agent is starting and
 * projects `trafic-agent destroy` is removing (status "destroying": its
 * backup starts a stopped project) are never stopped. When no other project
 * can be stopped, a warning is logged and the server stays over the limit.
 *
 * Returns the names of the projects it stopped.
 */
export async function enforceRunningLimit(
  options: RunningLimitOptions,
  deps: RunningLimitDeps = nodeRunningLimitDeps,
): Promise<string[]> {
  const { max, neverStops } = options;

  if (max <= 0) return [];

  const projects = await deps.listProjects();

  for (const project of projects) {
    const status = deps.getProject(project.name)?.status;

    if (isUp(project) && (status === undefined || status === "stopped")) {
      deps.updateProjectAccess(project.name);
      deps.setProjectStatus(project.name, "running");
    } else if (!isUp(project) && status === "running") {
      deps.setProjectStatus(project.name, "stopped");
    }
  }

  const running: ProjectRecord[] = [];

  for (const project of projects) {
    const record = deps.getProject(project.name);

    if (record && (isUp(project) || record.status === "starting")) {
      running.push(record);
    }
  }

  const excess = running.length - max;

  if (excess <= 0) return [];

  const candidates = running
    .filter((record) => !isBusy(record) && !neverStops(record.name))
    .sort((a, b) => a.lastAccess - b.lastAccess)
    .slice(0, excess);

  const stopped: string[] = [];

  for (const record of candidates) {
    console.log(
      `Stopping ${record.name}: ${running.length} projects running, max_running_projects is ${max}`,
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
      `${running.length - stopped.length} projects running, max_running_projects is ${max}: no other project can be stopped`,
    );
  }

  return stopped;
}
