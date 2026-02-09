import { getIdleProjects, setProjectStatus } from "../utils/db.js";
import { stopProject, getProjectInfo } from "../utils/ddev.js";
import { parseDuration } from "../utils/config.js";
import type { AgentConfig } from "../types.js";

/**
 * Stop idle projects that haven't been accessed recently
 */
export function stopIdleProjects(config: AgentConfig): void {
  const thresholdMs = parseDuration(config.idleTimeout);
  const idleProjects = getIdleProjects(thresholdMs);

  for (const project of idleProjects) {
    // Double-check project is actually running via DDEV
    const info = getProjectInfo(project.name);
    if (info?.status !== "running") {
      // Already stopped, just update our record
      setProjectStatus(project.name, "stopped");
      continue;
    }

    console.log(`Stopping idle project: ${project.name}`);
    const success = stopProject(project.name);

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
export function startIdleScheduler(config: AgentConfig): NodeJS.Timeout {
  const intervalMs = parseDuration(config.idleCheckInterval);

  console.log(
    `Idle scheduler started: checking every ${config.idleCheckInterval}, timeout ${config.idleTimeout}`,
  );

  // Run immediately on start
  stopIdleProjects(config);

  // Then run on interval
  return setInterval(() => {
    stopIdleProjects(config);
  }, intervalMs);
}
