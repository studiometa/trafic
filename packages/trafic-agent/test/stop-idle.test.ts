import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopIdleProjects } from "../src/tasks/stop-idle.js";
import {
  initDb,
  closeDb,
  getProject,
  setProjectStatus,
  updateProjectAccess,
} from "../src/utils/db.js";
import type { DdevRunner } from "../src/utils/ddev.js";
import type { AgentConfig } from "../src/types.js";

console.log = () => {};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A project that was used `ago` milliseconds before now, and runs. */
function accessed(name: string, ago: number): void {
  updateProjectAccess(name, () => Date.now() - ago);
}

/**
 * A ddev where every given project runs: `list` and `describe` show them
 * running, and each call is recorded.
 */
function runningDdev(names: string[], calls: string[][]): DdevRunner {
  const raw = (name: string) => ({ name, status: "running", approot: `/www/${name}` });

  return (args) => {
    calls.push(args);
    const stdout =
      args[0] === "list"
        ? JSON.stringify({ raw: names.map(raw) })
        : args[0] === "describe"
          ? JSON.stringify({ raw: raw(args[1]!) })
          : "";
    return Promise.resolve({ ok: true, stdout });
  };
}

describe("stopIdleProjects", () => {
  let root: string;
  let config: AgentConfig;

  /** Register projects in DDEV's project list, each with its own directory. */
  function register(projects: Record<string, string | undefined>): void {
    let list = "";

    for (const [name, traficConfig] of Object.entries(projects)) {
      const dir = join(root, "www", name);
      mkdirSync(join(dir, ".ddev"), { recursive: true });

      if (traficConfig) {
        writeFileSync(join(dir, ".ddev", "config.trafic.yaml"), traficConfig);
      }

      list += `${name}:\n    approot: ${dir}\n`;
    }

    writeFileSync(config.projectListPath, list);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "trafic-idle-"));

    config = {
      tld: "previews.example.com",
      port: 9876,
      dbPath: ":memory:",
      projectListPath: join(root, "project_list.yaml"),
      projectsDir: join(root, "www"),
      idleTimeout: "24h",
      idleCheckInterval: "5m",
      maxRunningProjects: 0,
      auth: {
        defaultPolicy: "basic",
        allowedIps: [],
        tokens: [],
        basicAuth: [],
        rules: [],
        trustedProxyHops: 1,
      },
      tls: { dnsEnv: {} },
      backup: { dir: join(root, "backups"), retainDays: 14 },
    };

    initDb(config.dbPath);
  });

  afterEach(() => {
    closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it("stops the next least recently used project over max_running_projects, never one with idle_timeout: never", async () => {
    // None is idle: only the limit can stop a project here
    register({ pinned: "idle_timeout: never\n", a: undefined, b: undefined });
    accessed("pinned", 5 * HOUR);
    accessed("a", 2 * HOUR);
    accessed("b", HOUR);
    config.maxRunningProjects = 2;
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["pinned", "a", "b"], calls));

    expect(calls).toEqual([["list", "-j"], ["stop", "a"]]);
    expect(getProject("pinned")?.status).toBe("running");
    expect(getProject("a")?.status).toBe("stopped");
  });

  it("does not stop first a project that a deploy started", async () => {
    // `trafic deploy` runs `ddev start` without the agent: no record of it
    register({ a: undefined, b: undefined, deployed: undefined });
    accessed("a", 2 * HOUR);
    accessed("b", HOUR);
    config.maxRunningProjects = 2;
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["a", "b", "deployed"], calls));

    expect(calls).toEqual([["list", "-j"], ["stop", "a"]]);
    expect(getProject("deployed")?.status).toBe("running");
  });

  it("does not stop an idle project that trafic-agent destroy is removing", async () => {
    // Its backup started it: a stop now fails the backup
    register({ removing: undefined, idle: undefined });
    accessed("removing", 2 * HOUR);
    setProjectStatus("removing", "destroying");
    accessed("idle", 2 * HOUR);
    config.idleTimeout = "30m";
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["removing", "idle"], calls));

    expect(calls).toEqual([["describe", "idle", "-j"], ["stop", "idle"]]);
    expect(getProject("removing")?.status).toBe("destroying");
  });
});
