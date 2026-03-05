import { runBackup, cleanOldBackups } from "./backup.js";
import type { AgentConfig } from "../types.js";

/**
 * Simple daily backup scheduler.
 * Checks every 30 minutes if we've passed the scheduled hour and runs once per day.
 */
export function startBackupScheduler(config: AgentConfig): NodeJS.Timeout {
  const { scheduleHour } = config.backup;
  let lastRunDate = "";

  console.log(
    `Backup scheduler started: daily at ${String(scheduleHour).padStart(2, "0")}:00, ` +
    `retention ${config.backup.retainDays} days, ` +
    `dir ${config.backup.localDir}`,
  );

  const check = (): void => {
    const now = new Date();
    const todayDate = now.toISOString().slice(0, 10);
    const currentHour = now.getHours();

    // Run once per day, after the scheduled hour
    if (currentHour >= scheduleHour && lastRunDate !== todayDate) {
      lastRunDate = todayDate;

      console.log(`[backup] Starting scheduled backup...`);
      try {
        runBackup(config);
        cleanOldBackups(config.backup);
      } catch (error) {
        console.error("[backup] Scheduled backup failed:", error);
      }
    }
  };

  // Check immediately on start
  check();

  // Check every 30 minutes
  return setInterval(check, 30 * 60 * 1000);
}
