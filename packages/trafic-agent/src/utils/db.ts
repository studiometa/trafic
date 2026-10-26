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
      status TEXT NOT NULL DEFAULT 'stopped',
      status_pid INTEGER
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

  // Databases made before the column existed
  addColumn(db, "projects", "status_pid INTEGER");

  return db;
}

/**
 * Add a column to a table that does not have it yet. The service and a
 * `trafic-agent destroy` run can both get here first, so a column that
 * exists already is not an error.
 */
function addColumn(database: DatabaseSync, table: string, column: string): void {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  } catch (error) {
    if (!/duplicate column name/i.test((error as Error).message)) {
      throw error;
    }
  }
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
 * The statuses a process sets while it works on a project: "starting" (the
 * waiting page, in the service, and `trafic-agent upgrade`) and "destroying"
 * (`trafic-agent destroy`).
 */
const BUSY_STATUSES: readonly ProjectRecord["status"][] = ["starting", "destroying"];

/**
 * Set project status
 *
 * A busy status ("starting", "destroying") records the id of this process,
 * so releaseStaleStatuses can tell when the process that set it is gone.
 */
export function setProjectStatus(
  name: string,
  status: ProjectRecord["status"],
  now: Clock = systemClock,
): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO projects (name, last_access, status, status_pid)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      status = excluded.status,
      status_pid = excluded.status_pid
  `);
  stmt.run(name, now(), status, BUSY_STATUSES.includes(status) ? process.pid : null);
}

/**
 * Whether a process is alive. EPERM means it is, but belongs to another user.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Set back to "running" the busy statuses ("starting", "destroying") whose
 * process is gone, and return the names of those projects.
 *
 * The process that sets a busy status sets it back when it ends. A process
 * that is killed (a cancelled CI job, a dropped SSH connection, a restart of
 * the service) cannot, and the status would stay: the sweeps never stop a
 * busy project, max_running_projects counts it as running, and the waiting
 * page never starts it. "running" lets the idle sweep check the project
 * against DDEV and stop it, also when it is stopped already.
 *
 * `isAlive` says whether a process still works on its project: the service
 * passes its own check at start, where its own id is not alive yet.
 */
export function releaseStaleStatuses(
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  const database = getDb();
  const rows = database
    .prepare(
      "SELECT name, status, status_pid AS pid FROM projects WHERE status IN ('starting', 'destroying')",
    )
    .all() as unknown as { name: string; status: string; pid: number | null }[];
  // Only when the same process still holds the status: another one may
  // have set it since the SELECT
  const release = database.prepare(`
    UPDATE projects SET status = 'running', status_pid = NULL
    WHERE name = ? AND status = ? AND status_pid IS ?
  `);
  const released: string[] = [];

  for (const { name, status, pid } of rows) {
    if (pid !== null && isAlive(pid)) {
      continue;
    }

    if (Number(release.run(name, status, pid).changes) > 0) {
      released.push(name);
    }
  }

  return released;
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
 * scheduled removal. Returns whether there was any.
 */
export function deleteProject(name: string): boolean {
  const database = getDb();
  const changes = [
    database.prepare("DELETE FROM projects WHERE name = ?").run(name),
    database.prepare("DELETE FROM access_logs WHERE project = ?").run(name),
    database.prepare("DELETE FROM scheduled_destroys WHERE name = ?").run(name),
  ].reduce((total, result) => total + Number(result.changes), 0);
  return changes > 0;
}

/**
 * Delete the records of the projects that DDEV no longer lists, and return
 * their names.
 *
 * A project removed outside the agent (`ddev delete` by hand, or a
 * `trafic destroy` older than the agent's own removal) leaves its row behind.
 * releaseStaleStatuses would set that row back to "running", and every sweep
 * would then ask DDEV about a project it does not know.
 *
 * A project with a busy status whose process lives is kept: `ddev delete`
 * takes it out of the list before its removal deletes the records. A project
 * with a scheduled removal is kept too: `ddev delete` by hand leaves its
 * directory, and the scheduled removal still has to remove it. An empty
 * list is kept as is too: a missing or unreadable project list is more likely
 * than a server with no project, and keeping the rows is harmless.
 */
export function deleteUnlistedProjects(
  listed: ReadonlySet<string>,
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  if (listed.size === 0) {
    return [];
  }

  const rows = getDb()
    .prepare(
      "SELECT name, status, status_pid AS pid FROM projects WHERE name NOT IN (SELECT name FROM scheduled_destroys)",
    )
    .all() as unknown as { name: string; status: ProjectRecord["status"]; pid: number | null }[];
  const deleted: string[] = [];

  for (const { name, status, pid } of rows) {
    if (listed.has(name)) {
      continue;
    }

    if (BUSY_STATUSES.includes(status) && pid !== null && isAlive(pid)) {
      continue;
    }

    deleteProject(name);
    deleted.push(name);
  }

  return deleted;
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
