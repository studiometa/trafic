import { getIdleProjects, setProjectStatus } from "../utils/db.js";
import { stopProject, getProjectInfo, loadProjectList } from "../utils/ddev.js";
import { parseDuration } from "../utils/config.js";
import { loadProjectConfig, shouldNeverStop, getIdleTimeoutMs } from "../utils/project-config.js";
import type { AgentConfig } from "../types.js";

/**
 * Stop idle projects that haven't been accessed recently
 * Respects per-project idle_timeout settings from .ddev/config.trafic.yaml
 */
export async function stopIdleProjects(config: AgentConfig): Promise<void> {
  const globalThresholdMs = parseDuration(config.idleTimeout);

  // Get all projects to check their individual configs
  const projects = loadProjectList(config.projectListPath);

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
    const info = await getProjectInfo(project.name);
    if (info?.status !== "running") {
      // Already stopped, just update our record
      setProjectStatus(project.name, "stopped");
      continue;
    }

    console.log(`Stopping idle project: ${project.name}`);
    const success = await stopProject(project.name);

    if (success) {
      setProjectStatus(project.name, "stopped");
      console.log(`Stopped: ${project.name}`);
    } else {
      console.error(`Failed to stop: ${project.name}`);
    }
  }
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
