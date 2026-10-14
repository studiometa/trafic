import { DatabaseSync } from "node:sqlite";
import type { ProjectRecord, AccessLog, ScheduledDestroy } from "../types.js";

/**
 * Reads the current time in epoch milliseconds.
 *
 * Injected so a test can place a project's last access at a chosen moment
 * without freezing the clock for everything else in the process.
 */
export type Clock = () => number;

/** The real clock, used unless a caller passes its own. */
export const systemClock: Clock = () => Date.now();

let db: DatabaseSync | null = null;

/**
 * How long a write waits for another connection to release the lock.
 *
 * The service and a `trafic-agent destroy` run over SSH open the same file.
 * WAL lets readers and one writer work together, but a second writer fails
 * at once with "database is locked" unless it is told to wait.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Initialize the database connection and schema
 */
export function initDb(dbPath: string): DatabaseSync {
  db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  db.exec("PRAGMA journal_mode=WAL");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      last_access INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped'
    );

    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ip TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_access_logs_project ON access_logs(project);
    CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_destroys (
      name TEXT PRIMARY KEY,
      destroy_at INTEGER NOT NULL,
      backup INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER,
      removing INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

/**
 * Get the database instance
 */
export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error("Database not initialized. Call initDb first.");
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Update project last access time
 */
export function updateProjectAccess(name: string, now: Clock = systemClock): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO projects (name, last_access, status)
    VALUES (?, ?, 'running')
    ON CONFLICT(name) DO UPDATE SET last_access = excluded.last_access
  `);
  stmt.run(name, now());
}

/**
 * Get project record
 */
export function getProject(name: string): ProjectRecord | undefined {
  const database = getDb();
  const stmt = database.prepare(
    "SELECT name, last_access as lastAccess, status FROM projects WHERE name = ?",
  );
  return stmt.get(name) as unknown as ProjectRecord | undefined;
}

/**
 * Set project status
 */
export function setProjectStatus(
  name: string,
  status: ProjectRecord["status"],
  now: Clock = systemClock,
): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO projects (name, last_access, status)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET status = excluded.status
  `);
  stmt.run(name, now(), status);
}

/**
 * Get idle projects (last access older than threshold)
 */
export function getIdleProjects(
  thresholdMs: number,
  now: Clock = systemClock,
): ProjectRecord[] {
  const database = getDb();
  const cutoff = now() - thresholdMs;
  const stmt = database.prepare(`
    SELECT name, last_access as lastAccess, status
    FROM projects
    WHERE last_access < ? AND status = 'running'
  `);
  return stmt.all(cutoff) as unknown as ProjectRecord[];
}

/**
 * Delete every record of a project: its status row, its access logs and its
 * scheduled removal.
 */
export function deleteProject(name: string): void {
  const database = getDb();
  database.prepare("DELETE FROM projects WHERE name = ?").run(name);
  database.prepare("DELETE FROM access_logs WHERE project = ?").run(name);
  database.prepare("DELETE FROM scheduled_destroys WHERE name = ?").run(name);
}

/**
 * Schedule the removal of a project, or replace a removal already
 * scheduled. `timeoutMs` is the time limit of the backup.
 */
export function scheduleDestroy(
  name: string,
  destroyAt: number,
  backup: boolean,
  timeoutMs?: number,
): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO scheduled_destroys (name, destroy_at, backup, timeout_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      destroy_at = excluded.destroy_at,
      backup = excluded.backup,
      timeout_ms = excluded.timeout_ms
  `);
  stmt.run(name, destroyAt, backup ? 1 : 0, timeoutMs ?? null);
}

/** A row of scheduled_destroys. */
interface ScheduledDestroyRow {
  name: string;
  destroyAt: number;
  backup: number;
  timeoutMs: number | null;
  removing: number;
}

function toScheduledDestroy({
  name,
  destroyAt,
  backup,
  timeoutMs,
  removing,
}: ScheduledDestroyRow): ScheduledDestroy {
  return {
    name,
    destroyAt,
    backup: backup === 1,
    ...(timeoutMs === null ? {} : { timeoutMs }),
    removing: removing === 1,
  };
}

/** The columns of a ScheduledDestroy. */
const SCHEDULED_DESTROY_COLUMNS =
  "name, destroy_at as destroyAt, backup, timeout_ms as timeoutMs, removing";

/**
 * Cancel the scheduled removal of a project:
 * - "cancelled" when it was scheduled and is now cancelled
 * - "none" when there was none
 * - "removing" when the sweep already removes the project (see
 *   startScheduledDestroy): it is too late, and the removal stays
 */
export function cancelScheduledDestroy(name: string): "cancelled" | "none" | "removing" {
  const database = getDb();
  const result = database
    .prepare("DELETE FROM scheduled_destroys WHERE name = ? AND removing = 0")
    .run(name);

  if (Number(result.changes) > 0) {
    return "cancelled";
  }

  return getScheduledDestroy(name) ? "removing" : "none";
}

/**
 * Mark a scheduled removal as started, when it is still due at `dueBy`.
 * From then on, a cancel is refused, and a retry after a failure does not
 * back the project up again. Returns false when the removal was cancelled
 * or moved to a later date meanwhile. One statement, so a cancel from
 * another process comes either before (false) or after (refused).
 */
export function startScheduledDestroy(name: string, dueBy: number): boolean {
  const database = getDb();
  const result = database
    .prepare("UPDATE scheduled_destroys SET removing = 1 WHERE name = ? AND destroy_at <= ?")
    .run(name, dueBy);
  return Number(result.changes) > 0;
}

/**
 * Get the scheduled removals, soonest first. With `dueBy`, only the removals
 * due at or before that time.
 */
export function getScheduledDestroys(dueBy = Number.MAX_SAFE_INTEGER): ScheduledDestroy[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT ${SCHEDULED_DESTROY_COLUMNS}
    FROM scheduled_destroys
    WHERE destroy_at <= ?
    ORDER BY destroy_at, name
  `);
  const rows = stmt.all(dueBy) as unknown as ScheduledDestroyRow[];
  return rows.map(toScheduledDestroy);
}

/**
 * Get the scheduled removal of a project when it is due at or before
 * `dueBy`, or undefined when there is none.
 */
export function getScheduledDestroy(
  name: string,
  dueBy = Number.MAX_SAFE_INTEGER,
): ScheduledDestroy | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT ${SCHEDULED_DESTROY_COLUMNS}
    FROM scheduled_destroys
    WHERE name = ? AND destroy_at <= ?
  `);
  const row = stmt.get(name, dueBy) as ScheduledDestroyRow | undefined;
  return row && toScheduledDestroy(row);
}

/**
 * Log an access
 */
export function logAccess(log: Omit<AccessLog, "id">): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO access_logs (project, timestamp, ip, user_agent, path)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(log.project, log.timestamp, log.ip, log.userAgent, log.path);
}

/**
 * Get recent access logs for a project
 */
export function getAccessLogs(project: string, limit = 100): AccessLog[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT id, project, timestamp, ip, user_agent as userAgent, path
    FROM access_logs
    WHERE project = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  return stmt.all(project, limit) as unknown as AccessLog[];
}

/**
 * Clean old access logs (older than given days)
 */
export function cleanOldLogs(days: number, now: Clock = systemClock): number {
  const database = getDb();
  const cutoff = now() - days * 24 * 60 * 60 * 1000;
  const stmt = database.prepare("DELETE FROM access_logs WHERE timestamp < ?");
  const result = stmt.run(cutoff);
  return Number(result.changes);
}
