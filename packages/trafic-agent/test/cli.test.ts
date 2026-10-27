import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
const skill = readFileSync(new URL("../../../skills/trafic-agent/SKILL.md", import.meta.url), "utf-8");

describe("trafic-agent", () => {
  const argv = process.argv;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  /** Run the CLI with these arguments and return what it printed. */
  async function run(args: string[]): Promise<{ out: string[]; err: string[] }> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A failure must fail the test, not end the test process
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    process.argv = ["node", "trafic-agent", ...args];

    // The module runs its command when it loads
    await import("../src/cli.js");
    await vi.waitFor(() => expect(log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0));

    const lines = (calls: unknown[][]) => calls.map((call) => call.join(" "));
    return { out: lines(log.mock.calls), err: lines(error.mock.calls) };
  }

  it.each([["version"], ["--version"], ["-v"]])("prints the version with %s", async (arg) => {
    expect((await run([arg])).out).toEqual([pkg.version]);
  });

  it("enables dry-run mode before upgrading", async () => {
    vi.doMock("../src/setup/upgrade.js", () => ({ runUpgrade: vi.fn() }));
    const steps = await import("../src/setup/steps.js");
    const setDryRunSpy = vi.spyOn(steps, "setDryRun");

    await run(["upgrade", "--dry-run"]);

    expect(setDryRunSpy).toHaveBeenCalledWith(true);
    steps.setDryRun(false);
  });

  it("prints the skill of the agent", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "trafic-agent", "skill"];

    await import("../src/cli.js");
    await vi.waitFor(() => expect(write).toHaveBeenCalled());

    const out = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    write.mockRestore();
    expect(out).toBe(skill);
    expect(out).toMatch(/^---\nname: trafic-agent\n/);
  });

  // Root reads the config anyway, and destroy refuses to run as root
  it.skipIf(process.getuid?.() === 0)(
    "says which user to connect as when destroy cannot read the config",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "trafic-cli-"));
      const config = join(root, "config.toml");
      writeFileSync(config, 'tld = "previews.example.com"\n');
      chmodSync(config, 0o000);

      try {
        const { err } = await run(["destroy", "app", "--config", config]);

        expect(err).toEqual([`Error: cannot read ${config} (EACCES): connect as the ddev user`]);
        expect(process.exitCode).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
