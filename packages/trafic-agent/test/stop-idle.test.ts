import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopIdleProjects } from "../src/tasks/stop-idle.js";
import {
  initDb,
  closeDb,
  getDb,
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

  it("deletes the records of a project DDEV no longer lists, without asking DDEV", async () => {
    // Left behind by a removal outside the agent; set back to running, it
    // would make every sweep run ddev describe on a project DDEV does not know
    register({ app: undefined });
    accessed("app", HOUR);
    accessed("gone", 30 * HOUR);
    setProjectStatus("gone", "starting");
    getDb().prepare("UPDATE projects SET status_pid = NULL WHERE name = ?").run("gone");
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["app"], calls));

    expect(getProject("gone")).toBeUndefined();
    expect(calls.some((args) => args.includes("gone"))).toBe(false);
    expect(getProject("app")?.status).toBe("running");
  });

  it("stops a project idle longer than its own idle_timeout, shorter than the global one", async () => {
    // Global 24h: only the project's 30m makes it idle
    register({ short: "idle_timeout: 30m\n", global: undefined });
    accessed("short", HOUR);
    accessed("global", HOUR);
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["short", "global"], calls));

    expect(calls).toEqual([["describe", "short", "-j"], ["stop", "short"]]);
    expect(getProject("short")?.status).toBe("stopped");
    expect(getProject("global")?.status).toBe("running");
  });

  it("keeps a project idle longer than the global idle_timeout but not its own", async () => {
    register({ long: "idle_timeout: 48h\n", global: undefined });
    accessed("long", 30 * HOUR);
    accessed("global", 30 * HOUR);
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["long", "global"], calls));

    expect(calls).toEqual([["describe", "global", "-j"], ["stop", "global"]]);
    expect(getProject("long")?.status).toBe("running");
  });

  it("never stops a project with idle_timeout: never", async () => {
    register({ pinned: "idle_timeout: never\n" });
    accessed("pinned", 30 * HOUR);
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["pinned"], calls));

    expect(calls).toEqual([]);
    expect(getProject("pinned")?.status).toBe("running");
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

  it("stops an idle project whose removal was killed", async () => {
    // The backup started it, then the CI job was cancelled: nothing else
    // would ever stop it
    register({ removing: undefined });
    accessed("removing", 2 * HOUR);
    setProjectStatus("removing", "destroying");
    // No process has this id: kill(2) refuses ids over pid_max
    getDb().prepare("UPDATE projects SET status_pid = ? WHERE name = ?").run(2 ** 30, "removing");
    config.idleTimeout = "30m";
    const calls: string[][] = [];

    await stopIdleProjects(config, runningDdev(["removing"], calls));

    expect(calls).toEqual([["describe", "removing", "-j"], ["stop", "removing"]]);
    expect(getProject("removing")?.status).toBe("stopped");
  });
});
