import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  enforceRunningLimit,
  type RunningLimitDeps,
} from "../src/tasks/running-limit.js";
import {
  initDb,
  closeDb,
  getProject,
  setProjectStatus,
  updateProjectAccess,
} from "../src/utils/db.js";
import type { DdevProject } from "../src/types.js";

console.log = () => {};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A project that was used `ago` milliseconds before now, and runs. */
function accessed(name: string, ago: number): void {
  updateProjectAccess(name, () => Date.now() - ago);
}

/** What ddev list reports. */
function ddev(statuses: Record<string, DdevProject["status"]>): DdevProject[] {
  return Object.entries(statuses).map(([name, status]) => ({
    name,
    status,
    appRoot: `/home/ddev/www/${name}`,
    httpURLs: [],
    httpsURLs: [],
    type: "wordpress",
  }));
}

/**
 * Real database, fake DDEV: the decisions run against the real SQL, and the
 * stops are recorded instead of sent.
 */
function createDeps(
  projects: DdevProject[],
  stopSucceeds = true,
): { deps: RunningLimitDeps; stopped: string[]; listed: () => number } {
  const stopped: string[] = [];
  let listed = 0;

  return {
    deps: {
      listProjects: () => {
        listed++;
        return Promise.resolve(projects);
      },
      stopProject: (name) => {
        stopped.push(name);
        return Promise.resolve(stopSucceeds);
      },
      getProject,
      setProjectStatus: (name, status) => setProjectStatus(name, status),
      updateProjectAccess: (name) => updateProjectAccess(name),
    },
    stopped,
    listed: () => listed,
  };
}

const nothingIsNever = () => false;

describe("enforceRunningLimit", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("does nothing, and does not ask ddev, without a limit", async () => {
    accessed("a", HOUR);
    const { deps, stopped, listed } = createDeps(ddev({ a: "running" }));

    await enforceRunningLimit({ max: 0, neverStops: nothingIsNever }, deps);

    expect(listed()).toBe(0);
    expect(stopped).toEqual([]);
  });

  it("stops nothing under the limit", async () => {
    accessed("a", HOUR);
    accessed("b", MINUTE);
    const { deps, stopped } = createDeps(ddev({ a: "running", b: "running" }));

    await enforceRunningLimit({ max: 2, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual([]);
  });

  it("stops the least recently used projects down to the limit", async () => {
    accessed("old", 3 * HOUR);
    accessed("older", 4 * HOUR);
    accessed("recent", MINUTE);
    const { deps, stopped } = createDeps(
      ddev({ old: "running", older: "running", recent: "running" }),
    );

    const result = await enforceRunningLimit(
      { max: 1, neverStops: nothingIsNever },
      deps,
    );

    expect(stopped).toEqual(["older", "old"]);
    expect(result).toEqual(["older", "old"]);
    expect(getProject("older")?.status).toBe("stopped");
    expect(getProject("recent")?.status).toBe("running");
  });

  it("frees one slot for a project about to start", async () => {
    // The waiting page marks the project "starting" before it makes room,
    // and ddev still shows it stopped
    setProjectStatus("target", "starting");
    accessed("a", 2 * HOUR);
    accessed("b", HOUR);
    const { deps, stopped } = createDeps(
      ddev({ target: "stopped", a: "running", b: "running" }),
    );

    await enforceRunningLimit({ max: 2, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual(["a"]);
    expect(getProject("target")?.status).toBe("starting");
  });

  it("counts a starting project once when ddev already shows it up", async () => {
    // A running app that answers 503 shows the waiting page too: the project
    // is "starting" in the database and already up in ddev
    setProjectStatus("target", "starting");
    accessed("a", 2 * HOUR);
    const { deps, stopped } = createDeps(ddev({ target: "running", a: "running" }));

    await enforceRunningLimit({ max: 2, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual([]);
  });

  it("frees one slot for each project starting at the same time", async () => {
    // ddev shows both stopped until their containers exist: each call must
    // count both, or each frees the same single slot
    setProjectStatus("first", "starting");
    setProjectStatus("second", "starting");
    accessed("a", 3 * HOUR);
    accessed("b", 2 * HOUR);
    accessed("c", HOUR);
    const { deps, stopped } = createDeps(
      ddev({ first: "stopped", second: "stopped", a: "running", b: "running", c: "running" }),
    );

    await enforceRunningLimit({ max: 3, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual(["a", "b"]);
  });

  it("counts from ddev, not from the database", async () => {
    // The database says both run, but ddev says one is stopped: the server
    // is under the limit and nothing must be stopped
    accessed("a", 2 * HOUR);
    accessed("b", HOUR);
    const { deps, stopped } = createDeps(ddev({ a: "stopped", b: "running" }));

    await enforceRunningLimit({ max: 1, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual([]);
    // Stopped outside the agent: recorded, so its next start is seen
    expect(getProject("a")?.status).toBe("stopped");
  });

  it("counts unhealthy and starting projects as running", async () => {
    accessed("a", 2 * HOUR);
    accessed("b", HOUR);
    accessed("c", MINUTE);
    const { deps, stopped } = createDeps(
      ddev({ a: "unhealthy", b: "starting", c: "paused" }),
    );

    await enforceRunningLimit({ max: 1, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual(["a"]);
  });

  it("never stops a project with idle_timeout: never", async () => {
    accessed("pinned", 5 * HOUR);
    accessed("a", HOUR);
    accessed("b", MINUTE);
    const { deps, stopped } = createDeps(
      ddev({ pinned: "running", a: "running", b: "running" }),
    );

    await enforceRunningLimit(
      { max: 2, neverStops: (name) => name === "pinned" },
      deps,
    );

    expect(stopped).toEqual(["a"]);
  });

  it("never stops a project the agent is starting", async () => {
    accessed("booting", 5 * HOUR);
    setProjectStatus("booting", "starting");
    accessed("a", HOUR);
    const { deps, stopped } = createDeps(ddev({ booting: "starting", a: "running" }));

    await enforceRunningLimit({ max: 1, neverStops: nothingIsNever }, deps);

    expect(stopped).toEqual(["a"]);
  });

  it("warns and stops nothing when every running project must stay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    accessed("a", HOUR);
    accessed("b", MINUTE);
    const { deps, stopped } = createDeps(ddev({ a: "running", b: "running" }));

    await enforceRunningLimit({ max: 1, neverStops: () => true }, deps);

    expect(stopped).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("max_running_projects is 1"));
  });

  it("leaves the status alone when a stop fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    accessed("a", HOUR);
    accessed("b", MINUTE);
    const { deps, stopped } = createDeps(ddev({ a: "running", b: "running" }), false);

    const result = await enforceRunningLimit(
      { max: 1, neverStops: nothingIsNever },
      deps,
    );

    expect(stopped).toEqual(["a"]);
    expect(result).toEqual([]);
    expect(getProject("a")?.status).toBe("running");
  });

  describe("a project started by a deploy", () => {
    // `trafic deploy` runs `ddev start` without the agent, so the database
    // still holds the state from before: stopped with an old last access, or
    // nothing at all. Read as is, that project would be the first one
    // stopped, right after the deploy that started it.

    it("is not stopped first when the database says it is stopped", async () => {
      accessed("deployed", 48 * HOUR);
      setProjectStatus("deployed", "stopped");
      accessed("a", 2 * HOUR);
      accessed("b", HOUR);
      const { deps, stopped } = createDeps(
        ddev({ deployed: "running", a: "running", b: "running" }),
      );

      await enforceRunningLimit({ max: 2, neverStops: nothingIsNever }, deps);

      expect(stopped).toEqual(["a"]);
      expect(getProject("deployed")).toMatchObject({ status: "running" });
      expect(getProject("deployed")!.lastAccess).toBeGreaterThan(Date.now() - MINUTE);
    });

    it("is not stopped first when the database has no record of it", async () => {
      accessed("a", 2 * HOUR);
      accessed("b", HOUR);
      const { deps, stopped } = createDeps(
        ddev({ deployed: "running", a: "running", b: "running" }),
      );

      await enforceRunningLimit({ max: 2, neverStops: nothingIsNever }, deps);

      expect(stopped).toEqual(["a"]);
      expect(getProject("deployed")?.status).toBe("running");
    });
  });
});
