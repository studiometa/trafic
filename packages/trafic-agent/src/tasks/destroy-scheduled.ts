import { destroyProject, resolveProjectDir } from "./destroy-project.js";
import {
  cancelScheduledDestroy,
  getScheduledDestroy,
  getScheduledDestroys,
  scheduleDestroy,
  systemClock,
  type Clock,
} from "../utils/db.js";
import { parseDuration } from "../utils/config.js";
import { nodeDdevRunner, type DdevRunner } from "../utils/ddev.js";
import type { AgentConfig } from "../types.js";

/**
 * Schedule the removal of a project, `delay` from now ("48h", "1h30m").
 *
 * The date goes to the agent database, not to the project: a redeploy does
 * not reliably rewrite the project files, and the sweep must find the date
 * even for a project DDEV has forgotten. The name is checked now, so a bad
 * name or a wrong `projects_dir` fails the CI job, not a sweep two days
 * later. Returns the date of the removal.
 */
export function scheduleProjectDestroy(
  name: string,
  delay: string,
  config: AgentConfig,
  options: { backup?: boolean } = {},
  now: Clock = systemClock,
): Date {
  const delayMs = parseDuration(delay);

  if (delayMs <= 0) {
    throw new Error(`Invalid delay: "${delay}". Use hours, minutes or seconds, e.g. 48h or 1h30m`);
  }

  resolveProjectDir(name, config);

  const destroyAt = now() + delayMs;
  scheduleDestroy(name, destroyAt, options.backup ?? false);

  return new Date(destroyAt);
}

/** A removal can take longer than the sweep interval; one sweep at a time. */
let sweeping = false;

/**
 * Remove each project whose scheduled removal is due, through the same
 * removal as `trafic-agent destroy`, with a backup when one was asked for.
 *
 * A failure on one project does not stop the sweep: it is logged, and the
 * removal stays scheduled so the next sweep tries again. A project already
 * gone has its schedule cleared.
 *
 * A removal can take minutes, and a deploy or a `--cancel` can cancel the
 * removal of a project meanwhile. So the sweep reads each removal again just
 * before it starts, and once more after the backup. A cancel that comes
 * while `ddev delete` runs is too late: the project is removed.
 */
export async function destroyScheduledProjects(
  config: AgentConfig,
  now: Clock = systemClock,
  run: DdevRunner = nodeDdevRunner,
): Promise<void> {
  if (sweeping) {
    return;
  }

  sweeping = true;

  try {
    for (const { name } of getScheduledDestroys(now())) {
      // Not the row read above: an earlier removal of this sweep took time
      const scheduled = getScheduledDestroy(name, now());
      const isCancelled = () => !getScheduledDestroy(name, now());

      if (!scheduled) {
        continue;
      }

      console.log(`Destroying ${name}: its scheduled removal is due`);

      try {
        const { backup } = scheduled;
        const removed = await destroyProject(name, config, { backup, isCancelled }, run);

        // A removal clears the schedule itself; a project already gone is not removed
        if (!removed && !isCancelled()) {
          cancelScheduledDestroy(name);
        }
      } catch (error) {
        console.error(
          `Scheduled removal of ${name} failed, retrying on the next sweep: ${(error as Error).message}`,
        );
      }
    }
  } finally {
    sweeping = false;
  }
}

/** A sweep that throws must not take the scheduler down with it. */
function reportSweepError(error: unknown): void {
  console.error("Scheduled removal sweep failed:", error);
}

/**
 * Start the scheduled removal sweep, on the idle check interval
 */
export function startScheduledDestroyScheduler(config: AgentConfig): NodeJS.Timeout {
  const intervalMs = parseDuration(config.idleCheckInterval);

  console.log(`Scheduled removal sweep started: checking every ${config.idleCheckInterval}`);

  // Run immediately on start
  void destroyScheduledProjects(config).catch(reportSweepError);

  // Then run on interval
  return setInterval(() => {
    void destroyScheduledProjects(config).catch(reportSweepError);
  }, intervalMs);
}
