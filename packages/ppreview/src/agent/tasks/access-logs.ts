import { cleanOldLogs } from "../utils/db.js";

/** Days the agent keeps its access logs. */
export const ACCESS_LOG_RETAIN_DAYS = 30;

/** Retention is counted in days, so an hourly sweep is enough. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** A sweep that throws must not take the scheduler down with it. */
function sweepAccessLogs(): void {
  try {
    const removed = cleanOldLogs(ACCESS_LOG_RETAIN_DAYS);

    if (removed > 0) {
      console.log(`Removed ${removed} access logs older than ${ACCESS_LOG_RETAIN_DAYS} days`);
    }
  } catch (error) {
    console.error("Access log sweep failed:", error);
  }
}

/**
 * Start the access log retention sweep. Each request logs a row, so without
 * it the database grows for good. The database must be open.
 */
export function startAccessLogSweepScheduler(): NodeJS.Timeout {
  console.log(`Access log sweep started: removing access logs older than ${ACCESS_LOG_RETAIN_DAYS} days`);

  // Run immediately on start
  sweepAccessLogs();

  // Then run on interval
  return setInterval(sweepAccessLogs, SWEEP_INTERVAL_MS);
}
