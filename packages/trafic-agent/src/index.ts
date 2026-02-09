// Types
export type {
  AgentConfig,
  AuthConfig,
  AuthRule,
  AuthRequest,
  AuthResult,
  BackupConfig,
  BackupResult,
  BackupEntry,
  DdevProject,
  ProjectRecord,
  AccessLog,
} from "./types.js";

// Config utilities
export { loadConfig, validateConfig, parseDuration } from "./utils/config.js";

// Auth utilities
export {
  checkAuth,
  matchIp,
  matchHostname,
  parseBasicAuth,
  parseBearerToken,
} from "./utils/auth.js";

// DDEV utilities
export {
  loadProjectList,
  buildHostnameIndex,
  getProjectFromHostname,
  watchProjectList,
  getProjectInfo,
  startProject,
  stopProject,
  listProjects,
} from "./utils/ddev.js";

// Database utilities
export {
  initDb,
  getDb,
  closeDb,
  updateProjectAccess,
  getProject,
  setProjectStatus,
  getIdleProjects,
  logAccess,
  getAccessLogs,
  cleanOldLogs,
} from "./utils/db.js";

// Project config utilities
export {
  loadProjectConfig,
  shouldNeverStop,
  getIdleTimeoutMs,
} from "./utils/project-config.js";
export type { ProjectConfig } from "./utils/project-config.js";

// Tasks
export { stopIdleProjects, startIdleScheduler } from "./tasks/stop-idle.js";
export {
  runBackup,
  backupProjectDb,
  backupAgentData,
  listBackups,
  cleanOldBackups,
  restoreProjectDb,
  findBackup,
} from "./tasks/backup.js";
export { startBackupScheduler } from "./tasks/backup-scheduler.js";

// Server
export { startServer } from "./server.js";

// Setup
export { setup, audit, runAudit, printAuditResults } from "./setup/index.js";
export type { SetupOptions, StepResult, AuditCheck } from "./setup/types.js";
