import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerDeps } from "../../src/server.js";
import type { AuthConfig } from "../../src/types.js";

export interface Recorded {
  accessed: string[];
  logged: { project: string; path: string; ip: string }[];
  statuses: [string, string][];
  started: string[];
}

export interface FakeDepsOptions {
  auth?: Partial<AuthConfig>;
  /** hostname -> project name */
  hostnames?: Record<string, string>;
  /** project name -> its own auth policy */
  projectPolicies?: Record<string, AuthConfig["defaultPolicy"]>;
  /** project name -> the record the database holds */
  records?: Record<string, { status: "running" | "stopped" | "starting" }>;
  /** What ddev describe reports */
  info?: Record<string, { status: string }>;
  /** Whether a start succeeds */
  startSucceeds?: boolean;
}

export const defaultAuth: AuthConfig = {
  defaultPolicy: "basic",
  allowedIps: [],
  tokens: [],
  basicAuth: ["user:pass"],
  rules: [],
  trustedProxyHops: 1,
};

/**
 * A ServerDeps that answers from a fixed world and records what happened.
 *
 * Injected rather than mocked so the handlers' real decisions run: which
 * auth policy applies, whether a project is already starting, and what the
 * waiting page is rendered for.
 */
export function createFakeDeps(options: FakeDepsOptions = {}): {
  deps: ServerDeps;
  recorded: Recorded;
} {
  const {
    auth = {},
    hostnames = {},
    projectPolicies = {},
    records = {},
    info = {},
    startSucceeds = true,
  } = options;

  const recorded: Recorded = {
    accessed: [],
    logged: [],
    statuses: [],
    started: [],
  };

  const deps: ServerDeps = {
    auth: { ...defaultAuth, ...auth },
    hostnameIndex: new Map(Object.entries(hostnames)),
    projectConfigs: new Map(
      Object.entries(projectPolicies).map(([name, policy]) => [
        name,
        { auth_policy: policy },
      ]),
    ),
    loadTemplate: (name) =>
      `<html>${name}:{{message}}{{project}}{{hostname}}</html>`,
    updateProjectAccess: (name) => void recorded.accessed.push(name),
    logAccess: (log) =>
      void recorded.logged.push({
        project: log.project,
        path: log.path,
        ip: log.ip,
      }),
    getProject: (name) => {
      const record = records[name];
      return record
        ? { name, lastAccess: 0, status: record.status }
        : undefined;
    },
    setProjectStatus: (name, status) =>
      void recorded.statuses.push([name, status]),
    startProject: (name) => {
      recorded.started.push(name);
      return Promise.resolve(startSucceeds);
    },
    getProjectInfo: (name) => {
      const found = info[name];
      return Promise.resolve(
        found
          ? {
              name,
              status: found.status,
              appRoot: "/x",
              httpURLs: [],
              httpsURLs: [],
              type: "wordpress",
            }
          : undefined,
      );
    },
  };

  return { deps, recorded };
}

export interface CapturedResponse {
  res: ServerResponse;
  status: () => number | undefined;
  headers: () => Record<string, string>;
  body: () => string;
}

/** A ServerResponse that records instead of writing to a socket. */
export function captureResponse(): CapturedResponse {
  let status: number | undefined;
  let headers: Record<string, string> = {};
  let body = "";

  const res = {
    writeHead(code: number, given?: Record<string, string>) {
      status = code;
      headers = { ...headers, ...given };
      return res;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
      return res;
    },
    headersSent: false,
  } as unknown as ServerResponse;

  return {
    res,
    status: () => status,
    headers: () => headers,
    body: () => body,
  };
}

/** A request with the headers ddev-router would forward. */
export function request(
  headers: Record<string, string> = {},
  url = "/",
  socketIp = "172.18.0.5",
): IncomingMessage {
  return {
    url,
    headers,
    socket: { remoteAddress: socketIp },
  } as unknown as IncomingMessage;
}
