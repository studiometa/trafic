import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { exec, test, rsync, classifyPath, parseDuration } from "../src/ssh.js";
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

describe("ssh.parseDuration", () => {
  it("reads second, minute and hour suffixes", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("reads a bare number as minutes", () => {
    // The default is documented as "10m", so minutes is the intuitive unit
    expect(parseDuration("30")).toBe(1_800_000);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseDuration("  5m  ")).toBe(300_000);
  });

  it("returns undefined for an unusable value", () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("10 minutes")).toBeUndefined();
    expect(parseDuration("-5m")).toBeUndefined();
    expect(parseDuration("10d")).toBeUndefined();
    // Zero would make every command time out immediately
    expect(parseDuration("0m")).toBeUndefined();
  });
});

describe("ssh.exec timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("honours the timeout from the options", async () => {
    mockExecFileSuccess();

    await exec({ ...defaultOptions, timeout: "45m" }, "echo hi");

    const [, , execOptions] = mockedExecFile.mock.calls[0]!;
    expect(execOptions).toMatchObject({ timeout: 2_700_000 });
  });

  it("falls back to ten minutes without a timeout", async () => {
    mockExecFileSuccess();

    await exec(defaultOptions, "echo hi");

    const [, , execOptions] = mockedExecFile.mock.calls[0]!;
    expect(execOptions).toMatchObject({ timeout: 600_000 });
  });

  it("lets an explicit per-command timeout win", async () => {
    mockExecFileSuccess();

    await exec({ ...defaultOptions, timeout: "45m" }, "echo hi", {
      timeoutMs: 5_000,
    });

    const [, , execOptions] = mockedExecFile.mock.calls[0]!;
    expect(execOptions).toMatchObject({ timeout: 5_000 });
  });
});

describe("ssh.rsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const asDirectory = () => "directory" as const;
  const asFile = () => "file" as const;
  const asMissing = () => "missing" as const;

  it("calls rsync with correct arguments", async () => {
    mockExecFileSuccess();

    await rsync("dist/", "/home/ddev/www/my-app/dist/", defaultOptions, asDirectory);

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockedExecFile.mock.calls[0]!;
    expect(cmd).toBe("rsync");
    expect(args).toContain("-azv");
    expect(args).toContain("--delete");
    expect(args).toContain("dist/");
    expect(args).toContain("ddev@server.example.com:/home/ddev/www/my-app/dist/");
  });

  it("appends trailing slash to a directory", async () => {
    mockExecFileSuccess();

    await rsync("dist", "/home/ddev/www/my-app/dist", defaultOptions, asDirectory);

    const [, args] = mockedExecFile.mock.calls[0]!;
    // localPath should have trailing slash
    expect(args).toContain("dist/");
  });

  it("syncs a single file without a trailing slash", async () => {
    mockExecFileSuccess();

    await rsync(
      "web/wp-config.php",
      "/home/ddev/www/my-app/web/wp-config.php",
      defaultOptions,
      asFile,
    );

    const [, args] = mockedExecFile.mock.calls[0]!;
    // A trailing slash would make rsync fail with "not a directory"
    expect(args).toContain("web/wp-config.php");
    expect(args).not.toContain("web/wp-config.php/");
  });

  it("omits --delete for a single file", async () => {
    mockExecFileSuccess();

    await rsync("web/.htaccess", "/home/ddev/www/my-app/web/.htaccess", defaultOptions, asFile);

    const [, args] = mockedExecFile.mock.calls[0]!;
    expect(args).not.toContain("--delete");
  });

  it("throws when the local path does not exist", async () => {
    mockExecFileSuccess();

    await expect(
      rsync("vendor", "/home/ddev/www/my-app/vendor", defaultOptions, asMissing),
    ).rejects.toThrow(/Cannot sync "vendor"/);

    // A silent skip would report a successful deploy with a missing artifact
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("classifies a real directory, file and absent path", () => {
    // Anchored to this file so the result does not depend on the cwd
    const src = join(import.meta.dirname, "..", "src");

    expect(classifyPath(src)).toBe("directory");
    expect(classifyPath(join(src, "ssh.ts"))).toBe("file");
    expect(classifyPath(join(src, "does-not-exist"))).toBe("missing");
  });
});
