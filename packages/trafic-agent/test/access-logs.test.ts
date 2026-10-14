import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ACCESS_LOG_RETAIN_DAYS, startAccessLogSweepScheduler } from "../src/tasks/access-logs.js";
import { closeDb, getAccessLogs, getDb, initDb, logAccess } from "../src/utils/db.js";

console.log = () => {};

const DAY_MS = 24 * 60 * 60 * 1000;

describe("startAccessLogSweepScheduler", () => {
  let timer: NodeJS.Timeout | undefined;
  const now = Date.parse("2026-10-14T12:00:00Z");

  /** Log an access to `app`, `ago` milliseconds before the current time. */
  function logAccessAgo(ago: number): void {
    logAccess({ project: "app", timestamp: Date.now() - ago, ip: "203.0.113.5", userAgent: "curl/8", path: "/" });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(now);
    initDb(":memory:");
  });

  afterEach(() => {
    clearInterval(timer);
    closeDb();
    vi.useRealTimers();
  });

  it("keeps the access logs for 30 days", () => {
    expect(ACCESS_LOG_RETAIN_DAYS).toBe(30);
  });

  it("removes old access logs on start, then once an hour", () => {
    logAccessAgo(31 * DAY_MS);
    logAccessAgo(DAY_MS);

    timer = startAccessLogSweepScheduler();

    expect(getAccessLogs("app")).toHaveLength(1);

    // The recent one gets old enough
    vi.advanceTimersByTime(29 * DAY_MS + 60 * 60 * 1000);

    expect(getAccessLogs("app")).toEqual([]);
  });

  it("reports a failed sweep and keeps the scheduler running", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    getDb().exec("DROP TABLE access_logs");

    expect(() => {
      timer = startAccessLogSweepScheduler();
    }).not.toThrow();
    expect(error).toHaveBeenCalledWith("Access log sweep failed:", expect.any(Error));

    expect(() => vi.advanceTimersByTime(60 * 60 * 1000)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
