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
