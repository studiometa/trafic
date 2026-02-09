// Types
export type {
  AgentConfig,
  AuthConfig,
  AuthRule,
  AuthRequest,
  AuthResult,
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

// Tasks
export { stopIdleProjects, startIdleScheduler } from "./tasks/stop-idle.js";

// Server
export { startServer } from "./server.js";
