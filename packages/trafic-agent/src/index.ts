// Types
export type {
  AgentConfig,
  AuthConfig,
  BackupConfig,
  AuthRule,
  AuthRequest,
  AuthResult,
  DdevProject,
  ProjectRecord,
  AccessLog,
  ScheduledDestroy,
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

// Setup: firewall rules for Docker-published ports
export {
  buildDockerFirewallScript,
  buildDockerFirewallUnit,
  configureDockerFirewall,
  DOCKER_FIREWALL_SCRIPT,
  DOCKER_FIREWALL_UNIT,
} from "./setup/docker-firewall.js";

// Database utilities
export {
  initDb,
  getDb,
  closeDb,
  updateProjectAccess,
  getProject,
  setProjectStatus,
  deleteProject,
  scheduleDestroy,
  cancelScheduledDestroy,
  getScheduledDestroys,
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
export { destroyProject } from "./tasks/destroy-project.js";
export {
  scheduleProjectDestroy,
  destroyScheduledProjects,
  startScheduledDestroyScheduler,
} from "./tasks/destroy-scheduled.js";
export {
  backupProject,
  removeOldBackups,
  startBackupSweepScheduler,
} from "./tasks/backup.js";

// Server
export { startServer } from "./server.js";

// Setup
export { setup, audit, runAudit, printAuditResults } from "./setup/index.js";
export type { SetupOptions, StepResult, AuditCheck } from "./setup/types.js";
