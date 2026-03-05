import { execSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, statSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectList, startProject, getProjectInfo } from "../utils/ddev.js";
import type { AgentConfig, BackupConfig, BackupResult, BackupEntry } from "../types.js";

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Ensure backup directory exists for a given date
 */
function ensureDateDir(localDir: string, date: string): string {
  const dir = join(localDir, date);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Export a single project's database using ddev export-db.
 * The project must be running. Use `forceStart` to start stopped projects
 * (only for explicit manual requests, not for scheduled backups).
 */
export function backupProjectDb(
  projectName: string,
  projectDir: string,
  outputDir: string,
  forceStart = false,
): BackupResult {
  const outputFile = join(outputDir, `${projectName}.sql.gz`);

  const info = getProjectInfo(projectName);

  if (info?.status !== "running") {
    if (!forceStart) {
      return { project: projectName, success: false, error: "Project is not running (skipped)" };
    }

    console.log(`  Starting ${projectName} for backup...`);
    const started = startProject(projectName);
    if (!started) {
      return { project: projectName, success: false, error: "Failed to start project" };
    }
  }

  try {
    execSync(`ddev export-db --gzip --file="${outputFile}"`, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 300_000, // 5 minutes
      stdio: "pipe",
    });

    return { project: projectName, success: true, file: outputFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { project: projectName, success: false, error: message };
  }
}

/**
 * Backup the agent's SQLite database and config file
 */
export function backupAgentData(config: AgentConfig, outputDir: string): void {
  // Backup SQLite database
  if (existsSync(config.dbPath)) {
    const dest = join(outputDir, "agent-db.sqlite");
    copyFileSync(config.dbPath, dest);
    console.log(`  Agent DB → ${dest}`);
  }

  // Backup config file (check common paths)
  const configPaths = ["/etc/trafic/config.toml", "./config.toml", "./trafic.toml"];
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      const dest = join(outputDir, "config.toml");
      copyFileSync(configPath, dest);
      console.log(`  Config → ${dest}`);
      break;
    }
  }
}

/**
 * Options for runBackup
 */
export interface RunBackupOptions {
  /** Backup a specific project (default: all) */
  projectName?: string;
  /** Start stopped projects for backup (default: false, only for explicit CLI requests) */
  forceStart?: boolean;
}

/**
 * Run backup for all projects (or a specific one).
 *
 * By default, only running projects are backed up. Stopped projects are
 * skipped because starting them is resource-intensive. Instead, projects
 * are backed up automatically before being stopped by the idle scheduler.
 *
 * Use `forceStart: true` for explicit manual backup requests
 * (e.g., `trafic-agent backup --name my-app`).
 */
export function runBackup(
  config: AgentConfig,
  options: RunBackupOptions = {},
): BackupResult[] {
  const { projectName, forceStart = false } = options;
  const date = formatDate(new Date());
  const outputDir = ensureDateDir(config.backup.localDir, date);
  const results: BackupResult[] = [];

  console.log(`Backup directory: ${outputDir}`);

  // Load all projects
  const projects = loadProjectList(config.projectListPath);

  if (projectName) {
    // Backup a specific project — forceStart for explicit requests
    const projectDir = projects.get(projectName);
    if (!projectDir) {
      results.push({ project: projectName, success: false, error: "Project not found" });
      return results;
    }

    console.log(`Backing up: ${projectName}`);
    results.push(backupProjectDb(projectName, projectDir, outputDir, forceStart));
  } else {
    // Backup all projects — only running ones unless forceStart
    console.log(`Backing up ${projects.size} projects...`);

    for (const [name, projectDir] of projects) {
      console.log(`Backing up: ${name}`);
      results.push(backupProjectDb(name, projectDir, outputDir, forceStart));
    }

    // Also backup agent data when doing a full backup
    backupAgentData(config, outputDir);
  }

  // Print summary
  const succeeded = results.filter((r) => r.success).length;
  const skipped = results.filter((r) => !r.success && r.error?.includes("skipped")).length;
  const failed = results.filter((r) => !r.success && !r.error?.includes("skipped")).length;
  console.log(`\nBackup complete: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed`);

  for (const result of results.filter((r) => !r.success && !r.error?.includes("skipped"))) {
    console.error(`  ✗ ${result.project}: ${result.error}`);
  }

  return results;
}

/**
 * List all available backups
 */
export function listBackups(backupConfig: BackupConfig): BackupEntry[] {
  const entries: BackupEntry[] = [];

  if (!existsSync(backupConfig.localDir)) {
    return entries;
  }

  const dateDirs = readdirSync(backupConfig.localDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();

  for (const date of dateDirs) {
    const dateDir = join(backupConfig.localDir, date);
    const stat = statSync(dateDir);
    if (!stat.isDirectory()) continue;

    const files = readdirSync(dateDir).filter(
      (f) => f.endsWith(".sql.gz") || f.endsWith(".sqlite") || f.endsWith(".toml"),
    );

    for (const file of files) {
      const filePath = join(dateDir, file);
      const fileStat = statSync(filePath);

      // Derive project name from filename
      const project = file.replace(/\.sql\.gz$/, "").replace(/\.sqlite$/, "").replace(/\.toml$/, "");

      entries.push({
        project,
        date,
        file: filePath,
        sizeBytes: fileStat.size,
      });
    }
  }

  return entries;
}

/**
 * Clean up old backups beyond the retention period
 */
export function cleanOldBackups(backupConfig: BackupConfig): number {
  if (!existsSync(backupConfig.localDir)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - backupConfig.retainDays);
  const cutoffDate = formatDate(cutoff);

  let removed = 0;
  const dateDirs = readdirSync(backupConfig.localDir).filter((name) =>
    /^\d{4}-\d{2}-\d{2}$/.test(name),
  );

  for (const date of dateDirs) {
    if (date < cutoffDate) {
      const dirPath = join(backupConfig.localDir, date);
      rmSync(dirPath, { recursive: true, force: true });
      console.log(`Removed old backup: ${date}`);
      removed++;
    }
  }

  return removed;
}

/**
 * Restore a project database from backup
 */
export function restoreProjectDb(
  projectName: string,
  projectDir: string,
  backupFile: string,
): boolean {
  try {
    // Ensure project is running
    const info = getProjectInfo(projectName);
    if (info?.status !== "running") {
      console.log(`Starting ${projectName} for restore...`);
      const started = startProject(projectName);
      if (!started) {
        console.error(`Failed to start ${projectName}`);
        return false;
      }
    }

    // Import database
    execSync(`ddev import-db --file="${backupFile}"`, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 300_000, // 5 minutes
      stdio: "pipe",
    });

    console.log(`Restored ${projectName} from ${backupFile}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to restore ${projectName}: ${message}`);
    return false;
  }
}

/**
 * Find a backup file for a project on a given date
 */
export function findBackup(
  backupConfig: BackupConfig,
  projectName: string,
  date?: string,
): string | undefined {
  if (!existsSync(backupConfig.localDir)) return undefined;

  // If a date is specified, look in that directory
  if (date) {
    const file = join(backupConfig.localDir, date, `${projectName}.sql.gz`);
    return existsSync(file) ? file : undefined;
  }

  // Otherwise, find the most recent backup
  const dateDirs = readdirSync(backupConfig.localDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();

  for (const dir of dateDirs) {
    const file = join(backupConfig.localDir, dir, `${projectName}.sql.gz`);
    if (existsSync(file)) return file;
  }

  return undefined;
}
