import { readFileSync, existsSync } from "node:fs";
import { parse } from "smol-toml";
import type { AgentConfig, AuthConfig, AuthRule, BackupConfig } from "../types.js";

const DEFAULT_CONFIG_PATHS = [
  "/etc/trafic/config.toml",
  "./config.toml",
  "./trafic.toml",
];

const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  scheduleHour: 3,
  retainDays: 7,
  localDir: "/var/backups/trafic",
};

const DEFAULT_CONFIG: AgentConfig = {
  tld: "",
  port: 9876,
  dbPath: "/var/lib/trafic/db.sqlite",
  projectListPath: "/home/ddev/.ddev/project_list.yaml",
  projectsDir: "/home/ddev/www",
  idleTimeout: "30m",
  idleCheckInterval: "5m",
  auth: {
    defaultPolicy: "basic",
    allowedIps: [],
    tokens: [],
    basicAuth: [],
    rules: [],
  },
  backup: { ...DEFAULT_BACKUP_CONFIG },
};

/**
 * Parse a duration string (e.g., "30m", "1h", "2h30m") to milliseconds
 */
export function parseDuration(duration: string): number {
  const regex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
  const match = duration.match(regex);
  if (!match) return 0;

  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Load configuration from TOML file
 */
export function loadConfig(configPath?: string): AgentConfig {
  // Find config file
  let path = configPath;
  if (!path) {
    path = DEFAULT_CONFIG_PATHS.find((p) => existsSync(p));
  }

  if (!path || !existsSync(path)) {
    console.warn("No config file found, using defaults");
    return DEFAULT_CONFIG;
  }

  const content = readFileSync(path, "utf-8");
  const parsed = parse(content) as Record<string, unknown>;

  // Merge with defaults
  const auth = mergeAuthConfig(parsed.auth as Record<string, unknown>);
  const backup = mergeBackupConfig(parsed.backup as Record<string, unknown>);

  return {
    tld: (parsed.tld as string) ?? DEFAULT_CONFIG.tld,
    port: (parsed.port as number) ?? DEFAULT_CONFIG.port,
    dbPath: (parsed.db_path as string) ?? DEFAULT_CONFIG.dbPath,
    projectListPath:
      (parsed.project_list_path as string) ?? DEFAULT_CONFIG.projectListPath,
    projectsDir: (parsed.projects_dir as string) ?? DEFAULT_CONFIG.projectsDir,
    idleTimeout:
      (parsed.idle_timeout as string) ?? DEFAULT_CONFIG.idleTimeout,
    idleCheckInterval:
      (parsed.idle_check_interval as string) ??
      DEFAULT_CONFIG.idleCheckInterval,
    auth,
    backup,
  };
}

function mergeAuthConfig(raw?: Record<string, unknown>): AuthConfig {
  if (!raw) return DEFAULT_CONFIG.auth;

  const rules = (raw.rules as Array<Record<string, unknown>>) ?? [];

  return {
    defaultPolicy:
      (raw.default_policy as AuthConfig["defaultPolicy"]) ??
      DEFAULT_CONFIG.auth.defaultPolicy,
    allowedIps:
      (raw.allowed_ips as string[]) ?? DEFAULT_CONFIG.auth.allowedIps,
    tokens: (raw.tokens as string[]) ?? DEFAULT_CONFIG.auth.tokens,
    basicAuth: (raw.basic_auth as string[]) ?? DEFAULT_CONFIG.auth.basicAuth,
    rules: rules.map(
      (r): AuthRule => ({
        match: r.match as string,
        policy: r.policy as AuthRule["policy"],
        tokens: r.tokens as string[] | undefined,
        allowedIps: r.allowed_ips as string[] | undefined,
      }),
    ),
  };
}

function mergeBackupConfig(raw?: Record<string, unknown>): BackupConfig {
  if (!raw) return { ...DEFAULT_BACKUP_CONFIG };

  return {
    enabled: (raw.enabled as boolean) ?? DEFAULT_BACKUP_CONFIG.enabled,
    scheduleHour:
      (raw.schedule_hour as number) ?? DEFAULT_BACKUP_CONFIG.scheduleHour,
    retainDays:
      (raw.retain_days as number) ?? DEFAULT_BACKUP_CONFIG.retainDays,
    localDir: (raw.local_dir as string) ?? DEFAULT_BACKUP_CONFIG.localDir,
  };
}

/**
 * Validate configuration
 */
export function validateConfig(config: AgentConfig): string[] {
  const errors: string[] = [];

  if (!config.tld) {
    errors.push("tld is required");
  }

  if (config.port < 1 || config.port > 65535) {
    errors.push("port must be between 1 and 65535");
  }

  if (
    config.auth.defaultPolicy !== "allow" &&
    config.auth.defaultPolicy !== "deny" &&
    config.auth.defaultPolicy !== "basic" &&
    config.auth.defaultPolicy !== "token"
  ) {
    errors.push('auth.default_policy must be "allow", "deny", "basic", or "token"');
  }

  return errors;
}
