import { readFileSync, existsSync, watch } from "node:fs";
import { execSync } from "node:child_process";
import type { DdevProject } from "../types.js";

// Simple YAML parser for project_list.yaml (avoid dependencies)
// The file format is simple: key: value pairs with quoted strings
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Remove quotes
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
 * Load projects from DDEV's project_list.yaml
 * Returns a map of project name -> app root path
 */
export function loadProjectList(
  projectListPath: string,
): Map<string, string> {
  if (!existsSync(projectListPath)) {
    return new Map();
  }

  const content = readFileSync(projectListPath, "utf-8");
  const parsed = parseSimpleYaml(content);

  return new Map(Object.entries(parsed));
}

/**
 * Build a hostname -> project name index
 */
export function buildHostnameIndex(
  projects: Map<string, string>,
  tld: string,
): Map<string, string> {
  const index = new Map<string, string>();

  for (const [name] of projects) {
    // Primary hostname: project-name.tld
    index.set(`${name}.${tld}`, name);
  }

  return index;
}

/**
 * Get project name from hostname
 */
export function getProjectFromHostname(
  hostname: string,
  index: Map<string, string>,
): string | undefined {
  return index.get(hostname);
}

/**
 * Watch project_list.yaml for changes
 */
export function watchProjectList(
  projectListPath: string,
  onChange: () => void,
): void {
  if (!existsSync(projectListPath)) {
    console.warn(`Project list not found: ${projectListPath}`);
    return;
  }

  watch(projectListPath, (eventType) => {
    if (eventType === "change") {
      onChange();
    }
  });
}

/**
 * Get detailed project info using ddev describe
 */
export function getProjectInfo(name: string): DdevProject | undefined {
  try {
    const output = execSync(`ddev describe ${name} -j`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    const data = JSON.parse(output);

    if (!data.raw) return undefined;

    const raw = data.raw;
    return {
      name: raw.name,
      status: raw.status,
      appRoot: raw.approot,
      httpURLs: raw.httpURLs ?? [],
      httpsURLs: raw.httpsURLs ?? [],
      type: raw.type,
      phpVersion: raw.php_version,
      dbType: raw.dbinfo?.dbType,
    };
  } catch {
    return undefined;
  }
}

/**
 * Start a DDEV project
 */
export function startProject(name: string): boolean {
  try {
    execSync(`ddev start ${name}`, {
      encoding: "utf-8",
      timeout: 120000, // 2 minutes
      stdio: "pipe",
    });
    return true;
  } catch (error) {
    console.error(`Failed to start project ${name}:`, error);
    return false;
  }
}

/**
 * Stop a DDEV project
 */
export function stopProject(name: string): boolean {
  try {
    execSync(`ddev stop ${name}`, {
      encoding: "utf-8",
      timeout: 60000, // 1 minute
      stdio: "pipe",
    });
    return true;
  } catch (error) {
    console.error(`Failed to stop project ${name}:`, error);
    return false;
  }
}

/**
 * List all DDEV projects with their status
 */
export function listProjects(): DdevProject[] {
  try {
    const output = execSync("ddev list -j", {
      encoding: "utf-8",
      timeout: 30000,
    });
    const data = JSON.parse(output);

    if (!Array.isArray(data)) return [];

    return data.map((p: Record<string, unknown>) => ({
      name: p.name as string,
      status: p.status as DdevProject["status"],
      appRoot: p.approot as string,
      httpURLs: (p.httpURLs as string[]) ?? [],
      httpsURLs: (p.httpsURLs as string[]) ?? [],
      type: p.type as string,
    }));
  } catch {
    return [];
  }
}
