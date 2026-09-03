import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { startProject, stopProject, getProjectInfo } from "../src/utils/ddev.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.spyOn(console, "error").mockImplementation(() => {});

const mockedExecFile = vi.mocked(execFile);

/** Resolve the command's callback on a later macrotask, like a real process. */
function finishLater(stdout = "", error: Error | null = null) {
  mockedExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    callback: (e: Error | null, out: string) => void,
  ) => {
    setTimeout(() => {
      callback(error, stdout);
    }, 10);
    return undefined;
  }) as never);
}

describe("startProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not block the event loop while the project starts", async () => {
    finishLater();
    const order: string[] = [];

    const starting = startProject("my-app").then(() => order.push("start"));
    // A request arriving while the start is in flight must be served. With
    // execSync this callback could not run until ddev returned, which froze
    // forward auth for every project and produced request timeouts.
    const meanwhile = new Promise<void>((r) => {
      setTimeout(() => {
        order.push("other request");
        r();
      }, 0);
    });

    await Promise.all([starting, meanwhile]);

    expect(order).toEqual(["other request", "start"]);
  });

  it("resolves true when ddev succeeds", async () => {
    finishLater();
    await expect(startProject("my-app")).resolves.toBe(true);
  });

  it("resolves false instead of throwing when ddev fails", async () => {
    // The caller records the outcome; a rejection here would leave the
    // project stuck on "starting" and wedge the waiting page
    finishLater("", new Error("exit status 1"));
    await expect(startProject("my-app")).resolves.toBe(false);
  });

  it("passes the project name as an argument, not shell text", async () => {
    finishLater();
    await startProject("my-app");

    const [command, args] = mockedExecFile.mock.calls[0]!;
    expect(command).toBe("ddev");
    expect(args).toEqual(["start", "my-app"]);
  });
});

describe("stopProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves true when ddev succeeds", async () => {
    finishLater();
    await expect(stopProject("my-app")).resolves.toBe(true);
  });

  it("resolves false when ddev fails", async () => {
    finishLater("", new Error("boom"));
    await expect(stopProject("my-app")).resolves.toBe(false);
  });
});

describe("getProjectInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the project status", async () => {
    finishLater(
      JSON.stringify({ raw: { name: "my-app", status: "running", approot: "/x" } }),
    );

    const info = await getProjectInfo("my-app");

    expect(info?.status).toBe("running");
    expect(info?.appRoot).toBe("/x");
  });

  it("returns undefined when ddev fails", async () => {
    finishLater("", new Error("no such project"));
    await expect(getProjectInfo("my-app")).resolves.toBeUndefined();
  });

  it("returns undefined for output that is not JSON", async () => {
    finishLater("not json at all");
    await expect(getProjectInfo("my-app")).resolves.toBeUndefined();
  });

  it("returns undefined when the payload has no raw section", async () => {
    finishLater(JSON.stringify({ something: "else" }));
    await expect(getProjectInfo("my-app")).resolves.toBeUndefined();
  });
});
