import { execFile, type ExecFileOptions } from "node:child_process";
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
 * Execute a command on a remote host via SSH.
 */
export async function exec(
  options: SSHOptions,
  command: string,
): Promise<ExecResult> {
  const args = [...buildSSHArgs(options), buildDestination(options), command];

  info(`ssh ${options.user}@${options.host} ${truncate(command, 80)}`);

  return run("ssh", args);
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

/**
 * Rsync a local path to the remote server.
 */
export async function rsync(
  localPath: string,
  remotePath: string,
  options: SSHOptions,
): Promise<ExecResult> {
  const sshCmd = [
    "ssh",
    ...buildSSHArgs(options),
  ].join(" ");

  const args = [
    "-azv",
    "--delete",
    "-e",
    sshCmd,
    localPath.endsWith("/") ? localPath : `${localPath}/`,
    `${buildDestination(options)}:${remotePath}`,
  ];

  info(`rsync ${localPath} → ${options.host}:${remotePath}`);

  return run("rsync", args);
}

/**
 * Execute a local command and return the result.
 */
function run(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const execOptions: ExecFileOptions = {
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout: 10 * 60 * 1000, // 10 minutes
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
