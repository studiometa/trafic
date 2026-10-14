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
  /** TLS configuration */
  tls: TlsConfig;
  /** Backup configuration */
  backup: BackupConfig;
}

/**
 * Backup configuration.
 *
 * A backup is a directory `<dir>/<project>/<timestamp>` that holds the
 * database dump and an archive of the upload directories.
 */
export interface BackupConfig {
  /** Directory that holds the backups */
  dir: string;
  /** Days to keep a backup before the agent removes it */
  retainDays: number;
}

/**
 * TLS configuration.
 *
 * Without `dnsProvider`, Traefik keeps DDEV's per-host TLS-ALPN challenge and
 * asks Let's Encrypt for one certificate per project hostname. With it, the
 * agent adds a DNS-01 resolver and a wildcard default certificate, and the
 * per-host requests stop as soon as that wildcard is in the default store.
 */
export interface TlsConfig {
  /**
   * DNS-01 provider name from the Traefik/lego provider list, e.g.
   * "cloudflare". Setting it turns the wildcard certificate on.
   */
  dnsProvider?: string;
  /** ACME CA directory URL. Use the staging CA for a first test. */
  caServer?: string;
  /** Credentials the lego provider reads, passed to the router container. */
  dnsEnv: Record<string, string>;
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
  /**
   * Number of trusted proxies in front of the agent.
   *
   * Each proxy appends the peer it saw to X-Forwarded-For, so the client
   * address is this many entries from the right. Anything further left is
   * client-supplied and must not be trusted.
   *
   * 1 (default) matches a plain install, where only ddev-router/Traefik sits
   * in front. Add one for every additional proxy — a CDN or load balancer
   * ahead of Traefik makes it 2.
   */
  trustedProxyHops: number;
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
  /** Database type, or undefined when the project omits the db container */
  dbType?: string;
}

/**
 * Project record in the database
 */
export interface ProjectRecord {
  name: string;
  lastAccess: number; // Unix timestamp
  /** "destroying": trafic-agent destroy is removing it, see destroyProject */
  status: "running" | "stopped" | "starting" | "destroying";
}

/**
 * A removal scheduled with `trafic-agent destroy --delay`
 */
export interface ScheduledDestroy {
  name: string;
  /** When the removal is due, as a Unix timestamp in milliseconds */
  destroyAt: number;
  /** Whether to back the project up before it is removed */
  backup: boolean;
  /** Time limit of the backup (`--timeout`), when one was given */
  timeoutMs?: number;
  /**
   * Whether the sweep has started to remove the project, after its backup:
   * a cancel is then too late, and a retry does not back it up again
   */
  removing: boolean;
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
  /** Address of the immediate peer, from the socket. Cannot be forged. */
  ip: string;
  authorization?: string;
  /** Raw X-Forwarded-For header. Partly client-supplied — never trust it whole. */
  forwardedFor?: string;
}
