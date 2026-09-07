import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AuthConfig } from "./types.js";
import { checkAuth, resolveClientIp } from "./utils/auth.js";
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
import { syncForwardAuthAddress } from "./utils/traefik.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// State
let config: AgentConfig;
let projectList: Map<string, string>;
let hostnameIndex: Map<string, string>;
// Cache of per-project configs (project name -> config)
const projectConfigs = new Map<string, ReturnType<typeof loadProjectConfig>>();

/**
 * What the request handlers need from the outside world.
 *
 * Gathered into one seam so a test can drive the handlers with a known
 * project list and record what they did, without a listening socket, a real
 * database or a DDEV install. `startServer` builds the real one.
 */
export interface ServerDeps {
  auth: AuthConfig;
  /** hostname -> project name */
  hostnameIndex: Map<string, string>;
  /** project name -> its own config, where it has one */
  projectConfigs: Map<string, ReturnType<typeof loadProjectConfig>>;
  loadTemplate: (name: string) => string;
  updateProjectAccess: (name: string) => void;
  logAccess: (log: Parameters<typeof logAccess>[0]) => void;
  getProject: (name: string) => ReturnType<typeof getProject>;
  setProjectStatus: (name: string, status: "running" | "stopped" | "starting") => void;
  startProject: (name: string) => Promise<boolean>;
  getProjectInfo: (name: string) => ReturnType<typeof getProjectInfo>;
}

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
export function getEffectiveAuthConfig(
  projectName: string | undefined,
  deps: Pick<ServerDeps, "auth" | "projectConfigs">,
): AuthConfig {
  if (!projectName) return deps.auth;

  const projectConfig = deps.projectConfigs.get(projectName);
  if (!projectConfig?.auth_policy) return deps.auth;

  // Override default policy with project-specific policy
  return {
    ...deps.auth,
    defaultPolicy: projectConfig.auth_policy,
  };
}

/**
 * Handle forward auth requests from Traefik
 * Traefik sends the original request headers, we return 200 (allow) or 401 (deny)
 */
export function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): void {
  const hostname = req.headers["x-forwarded-host"] as string ?? "";
  // Keep the two apart: the socket peer cannot be forged, X-Forwarded-For
  // partly can. checkAuth decides which entry to trust.
  const socketIp = req.socket.remoteAddress ?? "";
  const forwardedFor = req.headers["x-forwarded-for"] as string | undefined;
  const authorization = req.headers["authorization"];
  const path = req.headers["x-forwarded-uri"] as string ?? "/";

  // Find project from hostname
  const projectName = deps.hostnameIndex.get(hostname);

  // Get effective auth config (global + per-project overrides)
  const authConfig = getEffectiveAuthConfig(projectName, deps);

  const clientIp = resolveClientIp(
    socketIp,
    forwardedFor,
    authConfig.trustedProxyHops,
  );

  const result = checkAuth(
    {
      hostname,
      ip: socketIp,
      authorization,
      forwardedFor,
    },
    authConfig,
  );

  if (result.allowed) {
    // Log access and update last access time
    if (projectName) {
      deps.updateProjectAccess(projectName);
      deps.logAccess({
        project: projectName,
        timestamp: Date.now(),
        ip: clientIp,
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
export async function handleErrors(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const hostname = req.headers["x-forwarded-host"] as string ?? req.headers.host ?? "";
  const projectName = deps.hostnameIndex.get(hostname);

  if (!projectName) {
    // Unknown project
    const template = deps.loadTemplate("error");
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(template.replace("{{message}}", "Project not found"));
    return;
  }

  // Check if project is already starting
  const record = deps.getProject(projectName);
  if (record?.status === "starting") {
    // Show waiting page
    const template = deps.loadTemplate("wait");
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
  deps.setProjectStatus(projectName, "starting");

  // Show waiting page immediately
  const template = deps.loadTemplate("wait");
  res.writeHead(503, {
    "Content-Type": "text/html",
    "Retry-After": "5",
  });
  res.end(
    template
      .replace(/\{\{project\}\}/g, projectName)
      .replace(/\{\{hostname\}\}/g, hostname),
  );

  // Start the project without waiting for it. The response is already sent,
  // and `startProject` no longer blocks the event loop, so the agent keeps
  // serving forward auth for every other project while this runs. The status
  // is recorded when it settles, which is what stops a second request from
  // starting the same project again.
  void deps.startProject(projectName)
    .then((success) => {
      deps.setProjectStatus(projectName, success ? "running" : "stopped");
    })
    .catch((error: unknown) => {
      // Leaving it "starting" forever would wedge the waiting page
      deps.setProjectStatus(projectName, "stopped");
      console.error(`Could not start ${projectName}:`, error);
    });
}

/**
 * Handle status polling requests
 */
export async function handleStatus(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const projectName = url.searchParams.get("project");

  if (!projectName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing project parameter" }));
    return;
  }

  const info = await deps.getProjectInfo(projectName);
  const record = deps.getProject(projectName);

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
 * The path a request should be routed on, without the query string.
 *
 * `req.url` is a target, not a URL: it carries the query and, for a proxied
 * request, may be absolute. Parsing against a fixed base keeps a malformed or
 * absolute target from deciding the route, and a trailing slash is dropped so
 * `/__auth__/` and `/__auth__` are the same endpoint.
 */
export function routePath(target: string | undefined): string {
  let path: string;

  try {
    path = new URL(target ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }

  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Request handler
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  // Route on the path alone. Matching the raw URL meant a query string threw
  // every internal route off: Traefik's catch-all and errors middleware pass
  // the original request through, so `/?s=term` on a stopped project missed
  // every branch and fell to the waiting page — which then started an
  // already-running project. `/__status__?project=` never reached its handler
  // for the same reason: it needs the query it was being routed away from.
  const path = routePath(req.url);

  try {
    // Route requests
    if (path === "/__auth__" || path.startsWith("/__auth__/")) {
      handleAuth(req, res, deps);
    } else if (path === "/__status__" || path.startsWith("/__status__/")) {
      await handleStatus(req, res, deps);
    } else if (path === "/__health__") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "__VERSION__" }));
    } else {
      // Default: errors middleware
      await handleErrors(req, res, deps);
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

  // setup wrote the forward auth address before any DDEV network existed, so
  // correct it now that one may have appeared
  syncForwardAuthAddress(config.projectListPath);

  // Load projects
  reloadProjects();

  // Watch for changes
  watchProjectList(config.projectListPath, () => {
    console.log("Project list changed, reloading...");
    reloadProjects();
  });

  // The real dependencies. Rebuilt per request for the two maps, which
  // reloadProjects replaces wholesale when the project list changes.
  const deps = (): ServerDeps => ({
    auth: config.auth,
    hostnameIndex,
    projectConfigs,
    loadTemplate,
    updateProjectAccess,
    logAccess,
    getProject,
    setProjectStatus,
    startProject,
    getProjectInfo,
  });

  // Create HTTP server
  const server = createServer((req, res) => {
    handleRequest(req, res, deps()).catch((error) => {
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
