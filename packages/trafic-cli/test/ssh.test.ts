import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  exec,
  test as sshTest,
  rsync,
  run,
  classifyPath,
  parseDuration,
  parentOf,
  quoteRemotePath,
  type CommandRunner,
  type ExecResult,
} from "../src/ssh.js";
import type { SSHOptions } from "../src/types.js";

// The helpers print progress; keep it out of the test output
console.log = () => {};
console.error = () => {};

const defaultOptions: SSHOptions = {
  host: "server.example.com",
  user: "ddev",
  port: 22,
  sshOptions: "",
};

interface Call {
  command: string;
  args: string[];
  timeoutMs: number;
}

/** A runner that records what it was asked to do and returns a fixed result. */
function recorder(result: Partial<ExecResult> = {}) {
  const calls: Call[] = [];
  const runner: CommandRunner = (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, ...result });
  };

  return { calls, runner };
}

/** A runner that fails, as the real one does on a non-zero exit. */
const failingRunner: CommandRunner = () =>
  Promise.reject(new Error("Command failed: ssh (exit code 1)"));

describe("exec", () => {
  it("runs ssh against the destination with the command", async () => {
    const { calls, runner } = recorder({ stdout: "hello world\n" });

    const result = await exec(defaultOptions, "echo hello", { runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("ssh");
    expect(calls[0]!.args).toContain("ddev@server.example.com");
    expect(calls[0]!.args).toContain("echo hello");
    expect(result.stdout).toBe("hello world\n");
  });

  it("passes the port through", async () => {
    const { calls, runner } = recorder();

    await exec({ ...defaultOptions, port: 2222 }, "ls", { runner });

    const args = calls[0]!.args;
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("passes extra SSH options through, respecting quotes", async () => {
    const { calls, runner } = recorder();

    await exec({ ...defaultOptions, sshOptions: "-J jump@bastion" }, "ls", {
      runner,
    });

    expect(calls[0]!.args).toContain("-J");
    expect(calls[0]!.args).toContain("jump@bastion");
  });

  it("propagates a failure rather than swallowing it", async () => {
    await expect(
      exec(defaultOptions, "false", { runner: failingRunner }),
    ).rejects.toThrow("exit code 1");
  });

  describe("timeout", () => {
    it("uses the value from the options", async () => {
      const { calls, runner } = recorder();

      await exec({ ...defaultOptions, timeout: "45m" }, "echo hi", { runner });

      expect(calls[0]!.timeoutMs).toBe(2_700_000);
    });

    it("falls back to ten minutes when none is set", async () => {
      const { calls, runner } = recorder();

      await exec(defaultOptions, "echo hi", { runner });

      expect(calls[0]!.timeoutMs).toBe(600_000);
    });

    it("lets an explicit per-command value win", async () => {
      const { calls, runner } = recorder();

      await exec({ ...defaultOptions, timeout: "45m" }, "echo hi", {
        runner,
        timeoutMs: 5_000,
      });

      expect(calls[0]!.timeoutMs).toBe(5_000);
    });
  });
});

describe("test", () => {
  it("is true when the command succeeds", async () => {
    const { runner } = recorder();

    await expect(sshTest(defaultOptions, "test -d /tmp", { runner })).resolves.toBe(
      true,
    );
  });

  it("is false when the command fails, rather than throwing", async () => {
    await expect(
      sshTest(defaultOptions, "test -d /nope", { runner: failingRunner }),
    ).resolves.toBe(false);
  });
});

describe("run", () => {
  // No injection here on purpose: this is the seam everything else replaces,
  // so it is worth exercising against real processes
  it("resolves with the output of a command that succeeds", async () => {
    const result = await run("printf", ["hi"], 5000);

    expect(result.stdout).toBe("hi");
    expect(result.exitCode).toBe(0);
  });

  it("rejects with the exit code when a command fails", async () => {
    await expect(run("sh", ["-c", "exit 3"], 5000)).rejects.toThrow(
      /exit code 3/,
    );
  });
});

describe("parseDuration", () => {
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

describe("rsync", () => {
  const asDirectory = () => "directory" as const;
  const asFile = () => "file" as const;
  const asMissing = () => "missing" as const;

  it("mirrors a directory by its contents", async () => {
    const { calls, runner } = recorder();

    await rsync("dist", "/home/ddev/www/app/dist", defaultOptions, asDirectory, runner);

    const { command, args } = calls[0]!;
    expect(command).toBe("rsync");
    expect(args).toContain("-azv");
    expect(args).toContain("--delete");
    expect(args).toContain("dist/");
    expect(args).toContain("ddev@server.example.com:/home/ddev/www/app/dist");
  });

  it("does not double the trailing slash", async () => {
    const { calls, runner } = recorder();

    await rsync("dist/", "/x", defaultOptions, asDirectory, runner);

    expect(calls[0]!.args).toContain("dist/");
    expect(calls[0]!.args).not.toContain("dist//");
  });

  it("copies a single file as itself", async () => {
    const { calls, runner } = recorder();

    await rsync("web/wp-config.php", "/x/web/wp-config.php", defaultOptions, asFile, runner);

    // A trailing slash makes rsync fail with "not a directory"
    expect(calls[0]!.args).toContain("web/wp-config.php");
    expect(calls[0]!.args).not.toContain("web/wp-config.php/");
  });

  it("omits --delete for a single file, where it means nothing", async () => {
    const { calls, runner } = recorder();

    await rsync("web/.htaccess", "/x/web/.htaccess", defaultOptions, asFile, runner);

    expect(calls[0]!.args).not.toContain("--delete");
  });

  it("creates the destination's parent before transferring", async () => {
    const { calls, runner } = recorder();

    await rsync("web/index.php", "/x/web/index.php", defaultOptions, asFile, runner);

    // rsync makes the destination directory but never its parent: without
    // this, syncing a file before the directory that would have created its
    // parent failed with "No such file or directory"
    const index = calls[0]!.args.indexOf("--rsync-path");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.args[index + 1]).toBe("mkdir -p '/x/web' && rsync");
  });

  it("leaves a leading tilde for the remote shell to expand", async () => {
    const { calls, runner } = recorder();

    // The shape a deploy actually uses. Quoting the whole path made the
    // remote mkdir create a directory named "~", and the transfer failed on
    // the path it was meant to have created.
    await rsync(
      "web/index.php",
      "~/www/my-app/web/index.php",
      defaultOptions,
      asFile,
      runner,
    );

    const index = calls[0]!.args.indexOf("--rsync-path");
    expect(calls[0]!.args[index + 1]).toBe("mkdir -p ~/'www/my-app/web' && rsync");
  });

  it("refuses a path that does not exist instead of reporting success", async () => {
    const { calls, runner } = recorder();

    await expect(
      rsync("vendor", "/x/vendor", defaultOptions, asMissing, runner),
    ).rejects.toThrow(/Cannot sync "vendor"/);

    // A silent skip would leave the server missing a build artifact
    expect(calls).toHaveLength(0);
  });
});

describe("classifyPath", () => {
  // Real filesystem, anchored to this file so the cwd does not matter
  const src = join(import.meta.dirname, "..", "src");

  it("recognises a directory, a file and an absent path", () => {
    expect(classifyPath(src)).toBe("directory");
    expect(classifyPath(join(src, "ssh.ts"))).toBe("file");
    expect(classifyPath(join(src, "does-not-exist"))).toBe("missing");
  });
});

describe("parentOf", () => {
  it("drops the last segment", () => {
    expect(parentOf("/home/ddev/www/app/web/index.php")).toBe(
      "/home/ddev/www/app/web",
    );
    expect(parentOf("~/www/app/vendor")).toBe("~/www/app");
  });

  it("ignores a trailing slash", () => {
    expect(parentOf("/x/y/")).toBe("/x");
  });

  it("falls back to a path that always exists", () => {
    // Nothing to create in either case, and "" would make mkdir fail
    expect(parentOf("/top")).toBe("/");
    expect(parentOf("bare")).toBe(".");
  });
});

describe("quoteRemotePath", () => {
  it("keeps a leading tilde outside the quotes", () => {
    expect(quoteRemotePath("~/www/app/web")).toBe("~/'www/app/web'");
    expect(quoteRemotePath("~")).toBe("~");
  });

  it("quotes a path the shell has nothing to expand in", () => {
    expect(quoteRemotePath("/home/ddev/www/app")).toBe("'/home/ddev/www/app'");
  });

  it("quotes a tilde that is not the whole first segment", () => {
    // `~user` is a different expansion, and `a~b` is not one at all
    expect(quoteRemotePath("~user/www")).toBe("'~user/www'");
    expect(quoteRemotePath("a~b")).toBe("'a~b'");
  });
});
