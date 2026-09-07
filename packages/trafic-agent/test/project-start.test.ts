import { describe, it, expect } from "vitest";
import {
  startProject,
  stopProject,
  getProjectInfo,
  type DdevRunner,
} from "../src/utils/ddev.js";

/** A runner that settles on a later macrotask, like a real process. */
function runnerThatFinishesLater(
  result: { ok: boolean; stdout: string },
  calls: string[][] = [],
): DdevRunner {
  return (args) => {
    calls.push(args);
    return new Promise((resolve) => {
      setTimeout(() => resolve(result), 10);
    });
  };
}

describe("startProject", () => {
  it("does not block the event loop while the project starts", async () => {
    const order: string[] = [];
    const run = runnerThatFinishesLater({ ok: true, stdout: "" });

    const starting = startProject("my-app", run).then(() => order.push("start"));
    // A request arriving while the start is in flight must be served. With
    // execSync this callback could not run until ddev returned, which froze
    // forward auth for every project and produced request timeouts.
    const meanwhile = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push("other request");
        resolve();
      }, 0);
    });

    await Promise.all([starting, meanwhile]);

    expect(order).toEqual(["other request", "start"]);
  });

  it("resolves true when ddev succeeds", async () => {
    const run = runnerThatFinishesLater({ ok: true, stdout: "" });

    await expect(startProject("my-app", run)).resolves.toBe(true);
  });

  it("resolves false instead of throwing when ddev fails", async () => {
    // The caller records the outcome; a rejection here would leave the
    // project stuck on "starting" and wedge the waiting page
    const run = runnerThatFinishesLater({ ok: false, stdout: "" });

    await expect(startProject("my-app", run)).resolves.toBe(false);
  });

  it("asks ddev to start that project", async () => {
    const calls: string[][] = [];
    const run = runnerThatFinishesLater({ ok: true, stdout: "" }, calls);

    await startProject("my-app", run);

    expect(calls).toEqual([["start", "my-app"]]);
  });
});

describe("stopProject", () => {
  it("resolves true when ddev succeeds", async () => {
    const run = runnerThatFinishesLater({ ok: true, stdout: "" });

    await expect(stopProject("my-app", run)).resolves.toBe(true);
  });

  it("resolves false when ddev fails", async () => {
    const run = runnerThatFinishesLater({ ok: false, stdout: "" });

    await expect(stopProject("my-app", run)).resolves.toBe(false);
  });

  it("asks ddev to stop that project", async () => {
    const calls: string[][] = [];
    const run = runnerThatFinishesLater({ ok: true, stdout: "" }, calls);

    await stopProject("my-app", run);

    expect(calls).toEqual([["stop", "my-app"]]);
  });
});

describe("getProjectInfo", () => {
  it("reads the project status", async () => {
    const run = runnerThatFinishesLater({
      ok: true,
      stdout: JSON.stringify({
        raw: { name: "my-app", status: "running", approot: "/x" },
      }),
    });

    const info = await getProjectInfo("my-app", run);

    expect(info?.status).toBe("running");
    expect(info?.appRoot).toBe("/x");
  });

  it("returns undefined when ddev fails", async () => {
    const run = runnerThatFinishesLater({ ok: false, stdout: "" });

    await expect(getProjectInfo("my-app", run)).resolves.toBeUndefined();
  });

  it("returns undefined for output that is not JSON", async () => {
    const run = runnerThatFinishesLater({ ok: true, stdout: "not json at all" });

    await expect(getProjectInfo("my-app", run)).resolves.toBeUndefined();
  });

  it("returns undefined when the payload has no raw section", async () => {
    const run = runnerThatFinishesLater({
      ok: true,
      stdout: JSON.stringify({ something: "else" }),
    });

    await expect(getProjectInfo("my-app", run)).resolves.toBeUndefined();
  });
});
