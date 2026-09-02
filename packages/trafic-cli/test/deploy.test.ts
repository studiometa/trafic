import { describe, it, expect, vi, beforeEach } from "vitest";
import { deploy } from "../src/commands/deploy.js";
import * as ssh from "../src/ssh.js";
import type { DeployOptions } from "../src/types.js";

// Mock SSH module
vi.mock("../src/ssh.js", () => ({
  exec: vi.fn(),
  test: vi.fn(),
  rsync: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const mockedExec = vi.mocked(ssh.exec);
const mockedTest = vi.mocked(ssh.test);
const mockedRsync = vi.mocked(ssh.rsync);

const baseOptions: DeployOptions = {
  host: "server.example.com",
  user: "ddev",
  port: 22,
  sshOptions: "",
  repo: "https://github.com/example/repo.git",
  branch: "main",
  name: "my-app",
  projectsDir: "~/www",
  noStart: false,
  timeout: "10m",
};

describe("deploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockedRsync.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("clones the repo on first deploy", async () => {
    mockedTest.mockResolvedValue(false); // project does not exist
    // ddev describe returns "stopped"
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git clone
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev config
    mockedExec.mockResolvedValueOnce({ stdout: "stopped\n", stderr: "", exitCode: 0 }); // ddev describe -j
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev start
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev describe

    await deploy(baseOptions);

    // Should call git clone (first exec after test)
    expect(mockedExec.mock.calls[0]![1]).toContain("git clone");
  });

  it("fetches on existing repo", async () => {
    mockedTest.mockResolvedValue(true); // project exists
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git fetch
    mockedExec.mockResolvedValueOnce({ stdout: "running\n", stderr: "", exitCode: 0 }); // ddev describe -j
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev describe

    await deploy(baseOptions);

    expect(mockedExec.mock.calls[0]![1]).toContain("git fetch");
  });

  it("creates preview environment with correct name", async () => {
    mockedTest.mockResolvedValue(false);
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git clone
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev config
    mockedExec.mockResolvedValueOnce({ stdout: "stopped\n", stderr: "", exitCode: 0 }); // ddev describe -j
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev start
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev describe

    await deploy({ ...baseOptions, preview: "42" });

    // The clone command should target the preview directory
    expect(mockedExec.mock.calls[0]![1]).toContain("preview-42--my-app");
  });

  it("skips ddev start when noStart is true", async () => {
    mockedTest.mockResolvedValue(true);
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git fetch
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev describe

    await deploy({ ...baseOptions, noStart: true });

    // Should not call ddev describe -j or ddev start
    const allCommands = mockedExec.mock.calls.map((c) => c[1]);
    expect(allCommands.some((cmd) => cmd.includes("ddev start"))).toBe(false);
  });

  it("runs rsync when sync is provided", async () => {
    mockedTest.mockResolvedValue(true);
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git fetch
    mockedExec.mockResolvedValueOnce({ stdout: "running\n", stderr: "", exitCode: 0 }); // ddev describe -j
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev describe

    await deploy({ ...baseOptions, sync: "dist/" });

    expect(mockedRsync).toHaveBeenCalledOnce();
    expect(mockedRsync.mock.calls[0]![0]).toBe("dist/");
  });

  it("runs script inside ddev container", async () => {
    mockedTest.mockResolvedValue(true);
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git fetch
    mockedExec.mockResolvedValueOnce({ stdout: "running\n", stderr: "", exitCode: 0 }); // ddev describe -j
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev exec script
    mockedExec.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // ddev describe

    await deploy({ ...baseOptions, script: "composer install --no-dev" });

    const allCommands = mockedExec.mock.calls.map((c) => c[1]);
    expect(allCommands.some((cmd) => cmd.includes('ddev exec'))).toBe(true);
  });
});

describe("deploy container script", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockedTest.mockResolvedValue(true);
  });

  /** All commands passed to ssh.exec. */
  function commands(): string[] {
    return mockedExec.mock.calls.map((call) => call[1]);
  }

  /** The script decoded from the base64 payload written to the server. */
  function writtenScript(): string {
    const write = commands().find((c) => c.includes("base64 -d"))!;
    const encoded = /printf %s (\S+) \|/.exec(write)![1];
    return Buffer.from(encoded, "base64").toString("utf-8");
  }

  it("exports each env entry before the script", async () => {
    await deploy({
      ...baseOptions,
      script: "composer install",
      env: { COMPOSER_AUTH: '{"http-basic":{"x":{"username":"u"}}}', CI: "true" },
    });

    const script = writtenScript();
    expect(script).toContain(
      `export COMPOSER_AUTH='{"http-basic":{"x":{"username":"u"}}}'`,
    );
    expect(script).toContain("export CI='true'");
    expect(script).toContain("composer install");
  });

  it("keeps env values out of the logged command", async () => {
    await deploy({
      ...baseOptions,
      script: "composer install",
      env: { COMPOSER_AUTH: "s3cr3t-token-value" },
    });

    const write = mockedExec.mock.calls.find((call) =>
      call[1].includes("base64 -d"),
    )!;
    // The payload is logged through the override, never the command itself
    expect(write[2]?.log).toBe("write .trafic-deploy.sh");
  });

  it("aborts the script on the first failing command", async () => {
    await deploy({ ...baseOptions, script: "false\nnpm run build" });

    // Without errexit a failed composer install would still report success
    expect(writtenScript().startsWith("set -o errexit")).toBe(true);
  });

  it("survives a script containing quotes", async () => {
    const script = `php -r 'echo "hi";'`;

    await deploy({ ...baseOptions, script });

    expect(writtenScript()).toContain(script);
  });

  it("escapes single quotes in env values", async () => {
    await deploy({
      ...baseOptions,
      script: "true",
      env: { TOKEN: "it's-quoted" },
    });

    expect(writtenScript()).toContain(`export TOKEN='it'\\''s-quoted'`);
  });

  it("runs the script through bash in the container", async () => {
    await deploy({ ...baseOptions, script: "composer install" });

    expect(
      commands().some((c) => c.includes("ddev exec bash .trafic-deploy.sh")),
    ).toBe(true);
  });

  it("removes the script afterwards", async () => {
    await deploy({ ...baseOptions, script: "composer install" });

    expect(commands().some((c) => c.includes("rm -f .trafic-deploy.sh"))).toBe(
      true,
    );
  });

  it("removes the script even when it fails", async () => {
    mockedExec.mockImplementation(async (_o, command) => {
      if (command.includes("ddev exec bash")) {
        throw new Error("build failed");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await expect(
      deploy({ ...baseOptions, script: "composer install", env: { T: "x" } }),
    ).rejects.toThrow("build failed");

    // Otherwise the env values stay on disk after a failed build
    expect(commands().some((c) => c.includes("rm -f .trafic-deploy.sh"))).toBe(
      true,
    );
  });

  it("writes no script when none is given", async () => {
    await deploy(baseOptions);

    expect(commands().some((c) => c.includes(".trafic-deploy.sh"))).toBe(false);
  });
});
