import { existsSync, readFileSync } from "node:fs";
import { commandExists, exec, execSilent, writeFile } from "./steps.js";

/**
 * The effectful operations the setup steps need.
 *
 * Injected into every setup function so tests can drive them with plain
 * fakes — no module mocking — and so dry-run has one place to intercept
 * writes instead of each module reaching for `node:fs` itself.
 */
export interface SetupIo {
  /** Run a shell command. Throws when it exits non-zero. */
  exec(command: string, options?: { silent?: boolean }): string;
  /**
   * Run a probe. Returns trimmed stdout, or "" when the command fails.
   *
   * Use this wherever a non-zero exit is an answer rather than an error —
   * `id -u ddev` on a server without that user, for instance.
   */
  execSilent(command: string): string;
  /** Whether a command is on the PATH. */
  commandExists(command: string): boolean;
  /** Write a file. Honours dry-run. */
  writeFile(path: string, content: string): void;
  /** Whether a path exists. */
  fileExists(path: string): boolean;
  /** Read a UTF-8 file. */
  readFile(path: string): string;
  /** Process environment, for values like SUDO_USER. */
  env: Record<string, string | undefined>;
}

/**
 * The real implementation, used when no io is injected.
 *
 * `writeFile` comes from steps.js rather than `node:fs` so writes are
 * skipped in dry-run mode. Reads stay direct: they change nothing.
 */
export const nodeIo: SetupIo = {
  exec,
  execSilent,
  commandExists,
  writeFile,
  fileExists: existsSync,
  readFile: (path) => readFileSync(path, "utf-8"),
  env: process.env,
};
