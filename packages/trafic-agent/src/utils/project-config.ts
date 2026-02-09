import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-project Trafic configuration
 * Read from .ddev/config.trafic.yaml
 */
export interface ProjectConfig {
  /** Auth policy override: allow | deny | basic | token */
  auth_policy?: "allow" | "deny" | "basic" | "token";
  /** Idle timeout override: "never" or duration like "30m", "4h" */
  idle_timeout?: string;
}

/**
 * Simple YAML parser for config.trafic.yaml
 * Only supports simple key: value pairs (no nesting, no arrays)
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Remove quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load project-specific Trafic config from .ddev/config.trafic.yaml
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = join(projectDir, ".ddev", "config.trafic.yaml");

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseSimpleYaml(content);

    const config: ProjectConfig = {};

    // Validate auth_policy
    if (parsed.auth_policy) {
      const policy = parsed.auth_policy.toLowerCase();
      if (["allow", "deny", "basic", "token"].includes(policy)) {
        config.auth_policy = policy as ProjectConfig["auth_policy"];
      }
    }

    // Validate idle_timeout
    if (parsed.idle_timeout) {
      config.idle_timeout = parsed.idle_timeout;
    }

    return config;
  } catch (error) {
    console.warn(`Failed to load project config from ${configPath}:`, error);
    return {};
  }
}

/**
 * Check if a project should never be stopped (idle_timeout = "never")
 */
export function shouldNeverStop(config: ProjectConfig): boolean {
  return config.idle_timeout?.toLowerCase() === "never";
}

/**
 * Get idle timeout in milliseconds, or undefined to use global default
 */
export function getIdleTimeoutMs(config: ProjectConfig): number | undefined {
  if (!config.idle_timeout) return undefined;
  if (shouldNeverStop(config)) return undefined;

  // Parse duration string (e.g., "30m", "4h", "2h30m")
  const regex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
  const match = config.idle_timeout.match(regex);
  if (!match) return undefined;

  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);

  const ms = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return ms > 0 ? ms : undefined;
}
