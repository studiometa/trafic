import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AuthConfig } from "./types.js";
import { checkAuth } from "./utils/auth.js";
import {
  loadProjectList,
  buildHostnameIndex,
  watchProjectList,
  startProject,
  getProjectInfo,
} from "./utils/ddev.js";
import {
  initDb,
  updateProjectAccess,
  logAccess,
  setProjectStatus,
  getProject,
} from "./utils/db.js";
import { loadProjectConfig } from "./utils/project-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// State
let config: AgentConfig;
let projectList: Map<string, string>;
let hostnameIndex: Map<string, string>;
// Cache of per-project configs (project name -> config)
const projectConfigs = new Map<string, ReturnType<typeof loadProjectConfig>>();

/**
 * Load HTML template
 */
function loadTemplate(name: string): string {
  const templatePath = resolve(__dirname, "..", "templates", `${name}.html`);
  try {
    return readFileSync(templatePath, "utf-8");
  } catch {
    return `<html><body><h1>${name}</h1></body></html>`;
  }
}

/**
 * Get effective auth config for a project (merges global + per-project)
 */
function getEffectiveAuthConfig(projectName: string | undefined): AuthConfig {
  if (!projectName) return config.auth;

  const projectConfig = projectConfigs.get(projectName);
  if (!projectConfig?.auth_policy) return config.auth;

  // Override default policy with project-specific policy
  return {
    ...config.auth,
    defaultPolicy: projectConfig.auth_policy,
  };
}

/**
 * Handle forward auth requests from Traefik
 * Traefik sends the original request headers, we return 200 (allow) or 401 (deny)
 */
function handleAuth(req: IncomingMessage, res: ServerResponse): void {
  const hostname = req.headers["x-forwarded-host"] as string ?? "";
  const ip = req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "";
  const authorization = req.headers["authorization"];
  const path = req.headers["x-forwarded-uri"] as string ?? "/";

  // Find project from hostname
  const projectName = hostnameIndex.get(hostname);

  // Get effective auth config (global + per-project overrides)
  const authConfig = getEffectiveAuthConfig(projectName);

  const result = checkAuth(
    {
      hostname,
      ip: ip.split(",")[0].trim(),
      authorization,
      forwardedFor: ip,
    },
    authConfig,
  );

  if (result.allowed) {
    // Log access and update last access time
    if (projectName) {
      updateProjectAccess(projectName);
      logAccess({
        project: projectName,
        timestamp: Date.now(),
        ip: ip.split(",")[0].trim(),
        userAgent: req.headers["user-agent"] ?? "",
        path,
      });
    }

    res.writeHead(200);
    res.end();
  } else {
    // Return 401 with WWW-Authenticate header for basic auth
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Trafic"',
    });
    res.end("Unauthorized");
  }
}

/**
 * Handle errors middleware requests (502 from Traefik)
 * When a project is stopped, Traefik returns 502. We show a waiting page and start the project.
 */
async function handleErrors(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const hostname = req.headers["x-forwarded-host"] as string ?? req.headers.host ?? "";
  const projectName = hostnameIndex.get(hostname);

  if (!projectName) {
    // Unknown project
    const template = loadTemplate("error");
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(template.replace("{{message}}", "Project not found"));
    return;
  }

  // Check if project is already starting
  const record = getProject(projectName);
  if (record?.status === "starting") {
    // Show waiting page
    const template = loadTemplate("wait");
    res.writeHead(503, {
      "Content-Type": "text/html",
      "Retry-After": "5",
    });
    res.end(
      template
        .replace(/\{\{project\}\}/g, projectName)
        .replace(/\{\{hostname\}\}/g, hostname),
    );
    return;
  }

  // Mark as starting
  setProjectStatus(projectName, "starting");

  // Show waiting page immediately
  const template = loadTemplate("wait");
  res.writeHead(503, {
    "Content-Type": "text/html",
    "Retry-After": "5",
  });
  res.end(
    template
      .replace(/\{\{project\}\}/g, projectName)
      .replace(/\{\{hostname\}\}/g, hostname),
  );

  // Start project in background
  setTimeout(() => {
    const success = startProject(projectName);
    setProjectStatus(projectName, success ? "running" : "stopped");
  }, 100);
}

/**
 * Handle status polling requests
 */
function handleStatus(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const projectName = url.searchParams.get("project");

  if (!projectName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing project parameter" }));
    return;
  }

  const info = getProjectInfo(projectName);
  const record = getProject(projectName);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      name: projectName,
      status: info?.status ?? record?.status ?? "unknown",
      ready: info?.status === "running",
    }),
  );
}

/**
 * Request handler
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";

  try {
    // Route requests
    if (url === "/__auth__" || url.startsWith("/__auth__/")) {
      handleAuth(req, res);
    } else if (url === "/__status__" || url.startsWith("/__status__/")) {
      handleStatus(req, res);
    } else if (url === "/__health__") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "__VERSION__" }));
    } else {
      // Default: errors middleware
      await handleErrors(req, res);
    }
  } catch (error) {
    console.error("Request error:", error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}

/**
 * Reload project list and their configs
 */
function reloadProjects(): void {
  projectList = loadProjectList(config.projectListPath);
  hostnameIndex = buildHostnameIndex(projectList, config.tld);

  // Load per-project configs
  projectConfigs.clear();
  for (const [name, projectDir] of projectList) {
    const projectConfig = loadProjectConfig(projectDir);
    if (projectConfig.auth_policy || projectConfig.idle_timeout) {
      projectConfigs.set(name, projectConfig);
      console.log(`  ${name}: auth=${projectConfig.auth_policy ?? "default"}, idle=${projectConfig.idle_timeout ?? "default"}`);
    }
  }

  console.log(`Loaded ${projectList.size} projects (${projectConfigs.size} with custom config)`);
}

/**
 * Start the agent server
 */
export function startServer(agentConfig: AgentConfig): void {
  config = agentConfig;

  // Initialize database
  initDb(config.dbPath);

  // Load projects
  reloadProjects();

  // Watch for changes
  watchProjectList(config.projectListPath, () => {
    console.log("Project list changed, reloading...");
    reloadProjects();
  });

  // Create HTTP server
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("Unhandled error:", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  });

  server.listen(config.port, () => {
    console.log(`Trafic agent listening on port ${config.port}`);
    console.log(`TLD: ${config.tld}`);
    console.log(`Projects: ${projectList.size}`);
  });
}
