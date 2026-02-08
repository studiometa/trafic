import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { exec, test, rsync } from "../src/ssh.js";
import type { SSHOptions } from "../src/types.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Suppress console output in tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const mockedExecFile = vi.mocked(execFile);

const defaultOptions: SSHOptions = {
  host: "server.example.com",
  user: "ddev",
  port: 22,
  sshOptions: "",
};

function mockExecFileSuccess(stdout = "", stderr = "") {
  mockedExecFile.mockImplementation(
    (_cmd: any, _args: any, _opts: any, callback: any) => {
      callback(null, stdout, stderr);
      return {} as any;
    },
  );
}

function mockExecFileFailure(code: number, stderr = "error") {
  mockedExecFile.mockImplementation(
    (_cmd: any, _args: any, _opts: any, callback: any) => {
      const err = Object.assign(new Error("command failed"), { code });
      callback(err, "", stderr);
      return {} as any;
    },
  );
}

describe("ssh.exec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes a command via SSH", async () => {
    mockExecFileSuccess("hello world\n");

    const result = await exec(defaultOptions, "echo hello");

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockedExecFile.mock.calls[0]!;
    expect(cmd).toBe("ssh");
    expect(args).toContain("ddev@server.example.com");
    expect(args).toContain("echo hello");
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("includes port in SSH args", async () => {
    mockExecFileSuccess();

    await exec({ ...defaultOptions, port: 2222 }, "ls");

    const [, args] = mockedExecFile.mock.calls[0]!;
    const portIndex = (args as string[]).indexOf("-p");
    expect((args as string[])[portIndex + 1]).toBe("2222");
  });

  it("includes extra SSH options", async () => {
    mockExecFileSuccess();

    await exec(
      { ...defaultOptions, sshOptions: '-J jump@bastion' },
      "ls",
    );

    const [, args] = mockedExecFile.mock.calls[0]!;
    expect(args).toContain("-J");
    expect(args).toContain("jump@bastion");
  });

  it("rejects on non-zero exit code", async () => {
    mockExecFileFailure(1, "not found");

    await expect(exec(defaultOptions, "false")).rejects.toThrow(
      "Command failed: ssh (exit code 1)",
    );
  });
});

describe("ssh.test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when command succeeds", async () => {
    mockExecFileSuccess();
    const result = await test(defaultOptions, "test -d /tmp");
    expect(result).toBe(true);
  });

  it("returns false when command fails", async () => {
    mockExecFileFailure(1);
    const result = await test(defaultOptions, "test -d /nonexistent");
    expect(result).toBe(false);
  });
});

describe("ssh.rsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls rsync with correct arguments", async () => {
    mockExecFileSuccess();

    await rsync("dist/", "/home/ddev/www/my-app/dist/", defaultOptions);

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockedExecFile.mock.calls[0]!;
    expect(cmd).toBe("rsync");
    expect(args).toContain("-azv");
    expect(args).toContain("--delete");
    expect(args).toContain("dist/");
    expect(args).toContain("ddev@server.example.com:/home/ddev/www/my-app/dist/");
  });

  it("appends trailing slash to local path", async () => {
    mockExecFileSuccess();

    await rsync("dist", "/home/ddev/www/my-app/dist", defaultOptions);

    const [, args] = mockedExecFile.mock.calls[0]!;
    // localPath should have trailing slash
    expect(args).toContain("dist/");
  });
});
