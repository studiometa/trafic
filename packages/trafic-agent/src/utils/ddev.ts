import { readFileSync, existsSync, watch } from "node:fs";
import { execSync } from "node:child_process";
import type { DdevProject } from "../types.js";

/** Strip a single pair of surrounding quotes. */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/** A project name at the start of a line, e.g. `my-project:` */
const PROJECT_LINE = /^(\S[^:]*):\s*$/;

/** An indented `approot: /path` belonging to the project above it */
const APPROOT_LINE = /^\s+approot:\s*(.+?)\s*$/;

/**
 * Load projects from DDEV's project_list.yaml
 * Returns a map of project name -> app root path
 *
 * The file nests the path under the project name:
 *
 *   scalian:
 *       approot: /home/ddev/www/scalian
 *
 * Indentation therefore has to be read. A flat key/value pass produces one
 * entry per line instead: the project mapped to an empty string, plus a
 * phantom project called `approot`. Both did damage — the empty path meant
 * `loadProjectConfig` looked for `.ddev/config.trafic.yaml` relative to the
 * working directory and never found it, so per-project settings were silently
 * ignored, and the phantom entered the hostname index, where the TLS ask
 * endpoint would vouch for `approot.<tld>` and have a certificate issued for
 * a project that does not exist.
 */
export function loadProjectList(
  projectListPath: string,
): Map<string, string> {
  if (!existsSync(projectListPath)) {
    return new Map();
  }

  const projects = new Map<string, string>();
  let current: string | undefined;

  for (const line of readFileSync(projectListPath, "utf-8").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const project = PROJECT_LINE.exec(line);

    if (project) {
      current = unquote(project[1]!.trim());
      // Recorded now so a project keeps its hostname even if DDEV writes no
      // approot for it
      projects.set(current, "");
      continue;
    }

    const approot = APPROOT_LINE.exec(line);

    if (approot && current) {
      projects.set(current, unquote(approot[1]!));
    }
  }

  return projects;
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
