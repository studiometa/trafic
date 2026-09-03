import { execFile, type ExecFileOptions } from "node:child_process";
import { statSync } from "node:fs";
import { info } from "./steps.js";
import type { SSHOptions } from "./types.js";

/**
 * Result of a command execution.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Build the base SSH arguments for a connection.
 */
function buildSSHArgs(options: SSHOptions): string[] {
  const args: string[] = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-p",
    String(options.port),
  ];

  if (options.sshOptions) {
    // Split extra SSH options respecting quotes
    const extra = options.sshOptions.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    args.push(...extra);
  }

  return args;
}

/**
 * Build the SSH destination string (user@host).
 */
function buildDestination(options: SSHOptions): string {
  return `${options.user}@${options.host}`;
}

/**
 * Default timeout for a remote command (10 minutes).
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Execute a command on a remote host via SSH.
 */
export async function exec(
  options: SSHOptions,
  command: string,
  execOptions: ExecOptions = {},
): Promise<ExecResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, log } = execOptions;
  const args = [...buildSSHArgs(options), buildDestination(options), command];

  // `log` stands in for commands carrying secrets, so nothing sensitive
  // reaches the job output
  info(`ssh ${options.user}@${options.host} ${truncate(log ?? command, 80)}`);

  return run("ssh", args, timeoutMs);
}

/**
 * Options for a single remote command.
 */
export interface ExecOptions {
  /** Timeout in milliseconds (default: 10 minutes) */
  timeoutMs?: number;
  /** Printed instead of the command itself, for commands holding secrets */
  log?: string;
}

/**
 * Test if a condition is true on the remote host.
 * Returns true if the command exits with code 0.
 */
export async function test(
  options: SSHOptions,
  command: string,
): Promise<boolean> {
  try {
    const result = await exec(options, command);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** What a local sync path turned out to be. */
export type PathKind = "directory" | "file" | "missing";

/**
 * Tell whether a local path is a directory, a file, or absent.
 */
export function classifyPath(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Rsync a local path to the remote server.
 *
 * Directories and files need different flags. A directory is synced by its
 * contents, so it takes a trailing slash and `--delete` to drop files the
 * build no longer produces. A single file is copied as itself: a trailing
 * slash makes rsync fail with "not a directory", and `--delete` means nothing
 * for a transfer that is not a directory.
 *
 * Files matter because build steps produce them — a Composer scaffold writing
 * `web/wp-config.php`, for instance — and they are as much a build artifact as
 * `vendor/`.
 */
export async function rsync(
  localPath: string,
  remotePath: string,
  options: SSHOptions,
  classify: (path: string) => PathKind = classifyPath,
): Promise<ExecResult> {
  const kind = classify(localPath);

  // Fail loudly: a silent skip would leave the server missing a build
  // artifact and the deployment would look like it succeeded.
  if (kind === "missing") {
    throw new Error(
      `Cannot sync "${localPath}": no such file or directory. Did the build produce it?`,
    );
  }

  const isDirectory = kind === "directory";

  const sshCmd = [
    "ssh",
    ...buildSSHArgs(options),
  ].join(" ");

  const args = [
    "-azv",
    ...(isDirectory ? ["--delete"] : []),
    "-e",
    sshCmd,
    isDirectory && !localPath.endsWith("/") ? `${localPath}/` : localPath,
    `${buildDestination(options)}:${remotePath}`,
  ];

  info(`rsync ${localPath} → ${options.host}:${remotePath}`);

  return run("rsync", args);
}

/**
 * Execute a local command and return the result.
 */
function run(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const execOptions: ExecFileOptions = {
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout: timeoutMs,
    };

    execFile(command, args, execOptions, (err, stdoutBuf, stderrBuf) => {
      const stdout = String(stdoutBuf);
      const stderr = String(stderrBuf);
      const exitCode =
        err && "code" in err ? (err.code as number) : err ? 1 : 0;

      // Print output in real-time style
      if (stdout) {
        for (const line of stdout.split("\n")) {
          if (line.trim()) {
            info(line);
          }
        }
      }
      if (stderr) {
        for (const line of stderr.split("\n")) {
          if (line.trim()) {
            info(line);
          }
        }
      }

      if (err && exitCode !== 0) {
        reject(
          Object.assign(
            new Error(
              `Command failed: ${command} (exit code ${exitCode})\n${stderr}`,
            ),
            { stdout, stderr, exitCode },
          ),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode: 0 });
    });
  });
}

/**
 * Truncate a string for display.
 */
function truncate(str: string, maxLength: number): string {
  const oneLine = str.replace(/\n/g, " ").trim();
  return oneLine.length > maxLength
    ? `${oneLine.slice(0, maxLength)}…`
    : oneLine;
}
