import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

describe("trafic-agent", () => {
  const argv = process.argv;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  /** Run the CLI with these arguments and return what it printed. */
  async function run(args: string[]): Promise<string[]> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // A failure must fail the test, not end the test process
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    process.argv = ["node", "trafic-agent", ...args];

    // The module runs its command when it loads
    await import("../src/cli.js");
    await vi.waitFor(() => expect(log).toHaveBeenCalled());

    return log.mock.calls.map((call) => call.join(" "));
  }

  it.each([["version"], ["--version"], ["-v"]])("prints the version with %s", async (arg) => {
    expect(await run([arg])).toEqual([pkg.version]);
  });
});
