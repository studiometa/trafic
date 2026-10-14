import { getIdleProjects, releaseStaleStatuses, setProjectStatus } from "../utils/db.js";
import {
  stopProject,
  getProjectInfo,
  loadProjectList,
  nodeDdevRunner,
  type DdevRunner,
} from "../utils/ddev.js";
import { parseDuration } from "../utils/config.js";
import { loadProjectConfig, shouldNeverStop, getIdleTimeoutMs } from "../utils/project-config.js";
import { ddevRunningLimitDeps, enforceRunningLimit } from "./running-limit.js";
import type { AgentConfig } from "../types.js";

/**
 * Stop idle projects that haven't been accessed recently
 * Respects per-project idle_timeout settings from .ddev/config.trafic.yaml
 *
 * Only projects with the status "running" are idle: a project the agent is
 * starting or removing is never stopped here. A start or a removal whose
 * process was killed is set back to "running" first, so its project is not
 * left up for good.
 *
 * Then brings the server back under max_running_projects: a deploy runs
 * `ddev start` without asking the agent, so only the sweep sees it.
 */
export async function stopIdleProjects(
  config: AgentConfig,
  run: DdevRunner = nodeDdevRunner,
): Promise<void> {
  const globalThresholdMs = parseDuration(config.idleTimeout);

  // Get all projects to check their individual configs
  const projects = loadProjectList(config.projectListPath);

  for (const name of releaseStaleStatuses()) {
    console.log(`Set ${name} back to running: the process that started or removed it is gone`);
  }

  // Get projects idle according to global threshold
  const idleProjects = getIdleProjects(globalThresholdMs);

  for (const project of idleProjects) {
    const projectDir = projects.get(project.name);

    // Load per-project config if available
    if (projectDir) {
      const projectConfig = loadProjectConfig(projectDir);

      // Skip if project is configured to never stop
      if (shouldNeverStop(projectConfig)) {
        continue;
      }

      // Check project-specific idle timeout
      const projectThresholdMs = getIdleTimeoutMs(projectConfig);
      if (projectThresholdMs !== undefined) {
        const idleDuration = Date.now() - project.lastAccess;
        if (idleDuration < projectThresholdMs) {
          // Not idle according to project-specific timeout
          continue;
        }
      }
    }

    // Double-check project is actually running via DDEV
    const info = await getProjectInfo(project.name, run);
    if (info?.status !== "running") {
      // Already stopped, just update our record
      setProjectStatus(project.name, "stopped");
      continue;
    }

    console.log(`Stopping idle project: ${project.name}`);
    const success = await stopProject(project.name, run);

    if (success) {
      setProjectStatus(project.name, "stopped");
      console.log(`Stopped: ${project.name}`);
    } else {
      console.error(`Failed to stop: ${project.name}`);
    }
  }

  await enforceRunningLimit(
    {
      max: config.maxRunningProjects,
      neverStops: (name) => {
        const projectDir = projects.get(name);
        return projectDir ? shouldNeverStop(loadProjectConfig(projectDir)) : false;
      },
    },
    ddevRunningLimitDeps(run),
  );
}

/**
 * Start the idle check scheduler
 */
/** An idle sweep that throws must not take the scheduler down with it. */
function reportSweepError(error: unknown): void {
  console.error("Idle sweep failed:", error);
}

export function startIdleScheduler(config: AgentConfig): NodeJS.Timeout {
  const intervalMs = parseDuration(config.idleCheckInterval);

  console.log(
    `Idle scheduler started: checking every ${config.idleCheckInterval}, timeout ${config.idleTimeout}`,
  );

  // Run immediately on start
  void stopIdleProjects(config).catch(reportSweepError);

  // Then run on interval
  return setInterval(() => {
    void stopIdleProjects(config).catch(reportSweepError);
  }, intervalMs);
}
