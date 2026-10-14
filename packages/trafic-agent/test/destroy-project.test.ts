import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destroyProject, resolveProjectDir } from "../src/tasks/destroy-project.js";
import {
  initDb,
  closeDb,
  updateProjectAccess,
  getProject,
  logAccess,
  getAccessLogs,
} from "../src/utils/db.js";
import type { DdevRunner } from "../src/utils/ddev.js";
import type { AgentConfig } from "../src/types.js";

// The task reports progress; keep it out of the test output
console.log = () => {};
console.warn = () => {};

/** A runner that records each call and answers with the given outcome. */
function recordingRunner(
  ok: boolean,
  calls: { args: string[]; cwd?: string }[],
): DdevRunner {
  return (args, _timeoutMs, cwd) => {
    calls.push({ args, cwd });
    return Promise.resolve({ ok, stdout: "" });
  };
}

describe("destroyProject", () => {
  let root: string;
  let config: AgentConfig;

  /** Write DDEV's project list with the given name -> approot entries. */
  function writeProjectList(entries: Record<string, string>): void {
    writeFileSync(
      config.projectListPath,
      Object.entries(entries)
        .map(([name, approot]) => `${name}:\n    approot: ${approot}\n`)
        .join(""),
    );
  }

  /** Create a project directory with a file in it. */
  function createProject(name: string): string {
    const dir = join(config.projectsDir, name);
    mkdirSync(join(dir, ".ddev"), { recursive: true });
    writeFileSync(join(dir, ".ddev", "config.yaml"), `name: ${name}\n`);
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "trafic-destroy-"));
    mkdirSync(join(root, "www"));

    config = {
      tld: "previews.example.com",
      port: 9876,
      dbPath: ":memory:",
      projectListPath: join(root, "project_list.yaml"),
      projectsDir: join(root, "www"),
      idleTimeout: "30m",
      idleCheckInterval: "5m",
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

  it("deletes the DDEV project, its directory and its records", async () => {
    const dir = createProject("preview-42--app");
    writeProjectList({ "preview-42--app": dir });
    updateProjectAccess("preview-42--app");
    logAccess({ project: "preview-42--app", timestamp: 1, ip: "1.2.3.4", userAgent: "ua", path: "/" });
    const calls: { args: string[]; cwd?: string }[] = [];

    await expect(destroyProject("preview-42--app", config, {}, recordingRunner(true, calls))).resolves.toBe(true);

    expect(calls).toEqual([{ args: ["delete", "-Oy"], cwd: dir }]);
    expect(existsSync(dir)).toBe(false);
    expect(getProject("preview-42--app")).toBeUndefined();
    expect(getAccessLogs("preview-42--app")).toEqual([]);
  });

  it("leaves the records of other projects alone", async () => {
    createProject("app");
    updateProjectAccess("app");
    updateProjectAccess("other");
    logAccess({ project: "other", timestamp: 1, ip: "1.2.3.4", userAgent: "ua", path: "/" });

    await destroyProject("app", config, {}, recordingRunner(true, []));

    expect(getProject("other")).toBeDefined();
    expect(getAccessLogs("other")).toHaveLength(1);
  });

  it("removes leftover records when the directory is already gone", async () => {
    // A run that removed the directory and then failed to write to the
    // database must not leave the records behind for good
    updateProjectAccess("gone");
    logAccess({ project: "gone", timestamp: 1, ip: "1.2.3.4", userAgent: "ua", path: "/" });
    updateProjectAccess("other");
    const calls: { args: string[]; cwd?: string }[] = [];

    await expect(destroyProject("gone", config, {}, recordingRunner(true, calls))).resolves.toBe(false);

    expect(calls).toEqual([]);
    expect(getProject("gone")).toBeUndefined();
    expect(getAccessLogs("gone")).toEqual([]);
    expect(getProject("other")).toBeDefined();
  });

  it("still removes the directory when ddev delete fails", async () => {
    // Otherwise a project DDEV has already forgotten could never be cleaned
    // up, and the next deploy would find a stale directory
    const dir = createProject("app");
    updateProjectAccess("app");

    await expect(destroyProject("app", config, {}, recordingRunner(false, []))).resolves.toBe(true);

    expect(existsSync(dir)).toBe(false);
    expect(getProject("app")).toBeUndefined();
  });

  it("refuses an unsafe name before running anything", async () => {
    const calls: { args: string[]; cwd?: string }[] = [];

    for (const name of ["", " ", ".", "..", "../etc", "a/b"]) {
      await expect(destroyProject(name, config, {}, recordingRunner(true, calls))).rejects.toThrow(
        /Invalid project name/,
      );
    }

    expect(calls).toEqual([]);
    expect(existsSync(config.projectsDir)).toBe(true);
  });

  it("refuses a project directory that is a symbolic link", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "");
    symlinkSync(outside, join(config.projectsDir, "app"));
    const calls: { args: string[]; cwd?: string }[] = [];

    await expect(destroyProject("app", config, {}, recordingRunner(true, calls))).rejects.toThrow(
      /is a symbolic link/,
    );

    expect(calls).toEqual([]);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    expect(lstatSync(join(config.projectsDir, "app")).isSymbolicLink()).toBe(true);
  });

  it("refuses a project directory that a symlinked parent takes outside", async () => {
    const outside = join(root, "outside");
    mkdirSync(join(outside, "app"), { recursive: true });
    writeFileSync(join(outside, "app", "keep"), "");
    symlinkSync(outside, join(config.projectsDir, "link"));
    writeProjectList({ app: join(config.projectsDir, "link", "app") });
    const calls: { args: string[]; cwd?: string }[] = [];

    await expect(destroyProject("app", config, {}, recordingRunner(true, calls))).rejects.toThrow(
      /resolves to .*outside.*not inside the projects directory/,
    );

    expect(calls).toEqual([]);
    expect(existsSync(join(outside, "app", "keep"))).toBe(true);
  });

  it("follows a projects directory that is itself a symbolic link", async () => {
    const dir = createProject("app");
    config.projectsDir = join(root, "www-link");
    symlinkSync(join(root, "www"), config.projectsDir);

    await expect(destroyProject("app", config, {}, recordingRunner(true, []))).resolves.toBe(true);

    expect(existsSync(dir)).toBe(false);
  });

  describe("with backup", () => {
    /** A ddev whose describe finds a running project with a database. */
    function backupRunner(failing: string[], calls: string[][]): DdevRunner {
      return (args) => {
        calls.push(args);
        const ok = !failing.includes(args[0]!);
        const stdout =
          args[0] === "describe"
            ? JSON.stringify({ raw: { name: args[1], status: "running", dbinfo: { database_type: "mariadb" } } })
            : "";
        return Promise.resolve({ ok, stdout });
      };
    }

    it("backs the project up before it deletes anything", async () => {
      createProject("app");
      const calls: string[][] = [];

      await expect(destroyProject("app", config, { backup: true }, backupRunner([], calls))).resolves.toBe(true);

      expect(calls.map(([command]) => command)).toEqual(["describe", "export-db", "exec", "delete"]);
      expect(readdirSync(join(config.backup.dir, "app"))).toHaveLength(1);
    });

    it("removes nothing when the backup fails", async () => {
      const dir = createProject("app");
      updateProjectAccess("app");
      const calls: string[][] = [];

      await expect(
        destroyProject("app", config, { backup: true }, backupRunner(["export-db"], calls)),
      ).rejects.toThrow(/Could not export the database/);

      expect(calls.some(([command]) => command === "delete")).toBe(false);
      expect(existsSync(dir)).toBe(true);
      expect(getProject("app")).toBeDefined();
    });
  });

  describe("resolveProjectDir", () => {
    it("uses the app root from DDEV's project list", () => {
      const dir = join(config.projectsDir, "nested", "app");
      writeProjectList({ app: dir });

      expect(resolveProjectDir("app", config)).toBe(dir);
    });

    it("falls back to the projects directory for a project DDEV forgot", () => {
      expect(resolveProjectDir("app", config)).toBe(join(config.projectsDir, "app"));
    });

    it("refuses an app root outside the projects directory", () => {
      writeProjectList({ root: "/", home: root, sibling: join(root, "www-other", "app") });

      for (const name of ["root", "home", "sibling"]) {
        expect(() => resolveProjectDir(name, config)).toThrow(/not inside the projects directory/);
      }
    });

    it("refuses the projects directory itself", () => {
      writeProjectList({ app: `${config.projectsDir}/` });

      expect(() => resolveProjectDir("app", config)).toThrow(/not inside the projects directory/);
    });
  });
});
