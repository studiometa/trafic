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

/** Duration suffixes accepted in a timeout, in milliseconds. */
const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

/**
 * Parse a duration such as "10m", "90s" or "1h" into milliseconds.
 *
 * A bare number is read as minutes, matching the "10m" form the default is
 * documented in. Returns undefined for anything unparseable so the caller
 * decides between rejecting the value and falling back.
 */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^(\d+)([smh])?$/.exec(value.trim());

  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);

  if (amount <= 0) {
    return undefined;
  }

  return amount * DURATION_UNITS[match[2] ?? "m"]!;
}

/**
 * Runs a local command. Injected so tests drive the result directly rather
 * than replacing node:child_process for the whole module.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<ExecResult>;

/**
 * Execute a command on a remote host via SSH.
 */
export async function exec(
  options: SSHOptions,
  command: string,
  execOptions: ExecOptions = {},
): Promise<ExecResult> {
  const {
    timeoutMs = parseDuration(options.timeout) ?? DEFAULT_TIMEOUT_MS,
    log,
    runner = run,
  } = execOptions;
  const args = [...buildSSHArgs(options), buildDestination(options), command];

  // `log` stands in for commands carrying secrets, so nothing sensitive
  // reaches the job output
  info(`ssh ${options.user}@${options.host} ${truncate(log ?? command, 80)}`);

  return runner("ssh", args, timeoutMs);
}

/**
 * Options for a single remote command.
 */
export interface ExecOptions {
  /** Timeout in milliseconds (default: 10 minutes) */
  timeoutMs?: number;
  /** Printed instead of the command itself, for commands holding secrets */
  log?: string;
  /** Overrides how the command is run. Tests pass their own. */
  runner?: CommandRunner;
}

/**
 * Test if a condition is true on the remote host.
 * Returns true if the command exits with code 0.
 */
export async function test(
  options: SSHOptions,
  command: string,
  execOptions: ExecOptions = {},
): Promise<boolean> {
  try {
    const result = await exec(options, command, execOptions);
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

/** What a mirroring sync removed from the server. */
export interface DeletionSummary {
  /** How many paths rsync deleted. */
  files: number;
  /**
   * The distinct top-level entries affected, relative to the synced
   * directory. A whole plugin disappearing is the thing worth seeing; the
   * hundreds of files inside it are not.
   */
  entries: string[];
}

/**
 * Summarise the deletions in rsync's output.
 *
 * `--delete` is the right default for a build artifact — a file the build
 * stops producing should stop existing on the server — but with `-v` the
 * `deleting` lines are buried among every transferred path. On a real deploy
 * that hid a WordPress plugin being removed because it was installed by hand
 * and absent from `composer.json`: thousands of lines scrolled past and
 * nothing said a plugin had gone.
 */
export function summarizeDeletions(output: string): DeletionSummary {
  const deleted = output
    .split("\n")
    .map((line) => /^deleting (.+)$/.exec(line.trim())?.[1])
    .filter((path): path is string => Boolean(path));

  // Group by first path segment: one entry per plugin, theme or vendor
  // package rather than one per file inside it
  const entries = new Set(
    deleted.map((path) => path.replace(/^\.\//, "").split("/")[0] ?? path),
  );

  return { files: deleted.length, entries: [...entries].filter(Boolean).sort() };
}

/** Format a summary for a human, or undefined when nothing was removed. */
export function formatDeletions(
  summary: DeletionSummary,
  limit = 5,
): string | undefined {
  if (summary.files === 0) {
    return undefined;
  }

  const shown = summary.entries.slice(0, limit).join(", ");
  const rest = summary.entries.length - limit;
  const suffix = rest > 0 ? `, and ${rest} more` : "";
  const plural = summary.files === 1 ? "path" : "paths";

  return `removed ${summary.files} ${plural} under: ${shown}${suffix}`;
}

/** The parent of a remote path, for the `mkdir -p` that precedes a transfer. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");

  // No slash, or only the leading one: the parent is the root or the cwd,
  // both of which already exist
  return cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? "/" : ".";
}

/** Quote a value for a single-quoted shell string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  runner: CommandRunner = run,
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
    // Create the destination's parent before the transfer starts.
    //
    // rsync makes the destination directory itself, but never its parent: a
    // single file whose parent is missing fails with "No such file or
    // directory", and so does a directory nested more than one level deep.
    // Seen on a first deploy, where `web/index.php` came before the
    // `web/wp` that would have created `web/` — the order of the sync list
    // decided whether the deployment worked.
    //
    // `--rsync-path` rather than `--mkpath`: the flag needs rsync 3.2.3 on
    // both ends, and a runner older than that would fail on the option
    // itself. This runs in the remote shell, so any version does.
    "--rsync-path",
    `mkdir -p ${shellQuote(parentOf(remotePath))} && rsync`,
    "-e",
    sshCmd,
    isDirectory && !localPath.endsWith("/") ? `${localPath}/` : localPath,
    `${buildDestination(options)}:${remotePath}`,
  ];

  info(`rsync ${localPath} → ${options.host}:${remotePath}`);

  return runner("rsync", args, DEFAULT_TIMEOUT_MS);
}

/**
 * The remote operations a command performs.
 *
 * Injected so tests drive them directly rather than replacing this module.
 * One shape for every command, even where a command uses only part of it:
 * three near-identical interfaces would cost more than the unused field.
 */
export interface SshIo {
  exec: typeof exec;
  test: typeof test;
  rsync: typeof rsync;
}

/** The real operations, used unless a caller passes its own. */
export const nodeSshIo: SshIo = { exec, test, rsync };

/**
 * Execute a local command and return the result.
 */
export function run(
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
