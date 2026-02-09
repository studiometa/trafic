import Database from "better-sqlite3";
import type { ProjectRecord, AccessLog } from "../types.js";

let db: Database.Database | null = null;

/**
 * Initialize the database connection and schema
 */
export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

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
  `);

  return db;
}

/**
 * Get the database instance
 */
export function getDb(): Database.Database {
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
export function updateProjectAccess(name: string): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO projects (name, last_access, status)
    VALUES (?, ?, 'running')
    ON CONFLICT(name) DO UPDATE SET last_access = excluded.last_access
  `);
  stmt.run(name, Date.now());
}

/**
 * Get project record
 */
export function getProject(name: string): ProjectRecord | undefined {
  const database = getDb();
  const stmt = database.prepare(
    "SELECT name, last_access as lastAccess, status FROM projects WHERE name = ?",
  );
  return stmt.get(name) as ProjectRecord | undefined;
}

/**
 * Set project status
 */
export function setProjectStatus(
  name: string,
  status: ProjectRecord["status"],
): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO projects (name, last_access, status)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET status = excluded.status
  `);
  stmt.run(name, Date.now(), status);
}

/**
 * Get idle projects (last access older than threshold)
 */
export function getIdleProjects(thresholdMs: number): ProjectRecord[] {
  const database = getDb();
  const cutoff = Date.now() - thresholdMs;
  const stmt = database.prepare(`
    SELECT name, last_access as lastAccess, status
    FROM projects
    WHERE last_access < ? AND status = 'running'
  `);
  return stmt.all(cutoff) as ProjectRecord[];
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
  return stmt.all(project, limit) as AccessLog[];
}

/**
 * Clean old access logs (older than given days)
 */
export function cleanOldLogs(days: number): number {
  const database = getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stmt = database.prepare("DELETE FROM access_logs WHERE timestamp < ?");
  const result = stmt.run(cutoff);
  return result.changes;
}
