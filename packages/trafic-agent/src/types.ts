/**
 * Agent configuration loaded from TOML file
 */
export interface AgentConfig {
  /** TLD for DDEV projects (required) */
  tld: string;
  /** Port for the agent HTTP server */
  port: number;
  /** Path to the SQLite database */
  dbPath: string;
  /** Path to DDEV's project_list.yaml */
  projectListPath: string;
  /** Directory where projects are stored */
  projectsDir: string;
  /** Idle timeout before stopping projects (e.g., "30m", "1h") */
  idleTimeout: string;
  /** Interval for checking idle projects (e.g., "5m") */
  idleCheckInterval: string;
  /** Auth configuration */
  auth: AuthConfig;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Default policy: "allow" | "deny" | "basic" | "token" */
  defaultPolicy: "allow" | "deny" | "basic" | "token";
  /** IP addresses or CIDR ranges to always allow */
  allowedIps: string[];
  /** Bearer tokens to allow */
  tokens: string[];
  /** Basic auth credentials (username:password) */
  basicAuth: string[];
  /** Per-hostname rules */
  rules: AuthRule[];
}

/**
 * Per-hostname authentication rule
 */
export interface AuthRule {
  /** Hostname pattern (glob supported) */
  match: string;
  /** Policy for this hostname */
  policy: "allow" | "deny" | "basic" | "token";
  /** Optional: specific tokens for this hostname */
  tokens?: string[];
  /** Optional: specific IPs for this hostname */
  allowedIps?: string[];
}

/**
 * DDEV project from project_list.yaml
 */
export interface DdevProject {
  name: string;
  status: "running" | "stopped" | "paused" | "unhealthy";
  appRoot: string;
  httpURLs: string[];
  httpsURLs: string[];
  type: string;
  phpVersion?: string;
  dbType?: string;
}

/**
 * Project record in the database
 */
export interface ProjectRecord {
  name: string;
  lastAccess: number; // Unix timestamp
  status: "running" | "stopped" | "starting";
}

/**
 * Access log entry
 */
export interface AccessLog {
  id?: number;
  project: string;
  timestamp: number;
  ip: string;
  userAgent: string;
  path: string;
}

/**
 * Auth check result
 */
export interface AuthResult {
  allowed: boolean;
  reason: "ip" | "token" | "basic" | "rule" | "default";
  project?: string;
}

/**
 * HTTP request context for auth
 */
export interface AuthRequest {
  hostname: string;
  ip: string;
  authorization?: string;
  forwardedFor?: string;
}
