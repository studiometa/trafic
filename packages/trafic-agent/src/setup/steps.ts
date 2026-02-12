import { execSync } from "node:child_process";
import { writeFileSync as fsWriteFile } from "node:fs";

let stepNumber = 0;
let dryRun = false;

/**
 * Set dry-run mode
 */
export function setDryRun(value: boolean): void {
  dryRun = value;
}

/**
 * Reset step counter
 */
export function resetSteps(): void {
  stepNumber = 0;
}

/**
 * Log a step
 */
export function step(message: string): void {
  stepNumber++;
  console.log(`\n\x1b[36m[${stepNumber}]\x1b[0m ${message}`);
}

/**
 * Log success
 */
export function success(message: string): void {
  console.log(`    \x1b[32m✓\x1b[0m ${message}`);
}

/**
 * Log warning
 */
export function warn(message: string): void {
  console.log(`    \x1b[33m⚠\x1b[0m ${message}`);
}

/**
 * Log error
 */
export function error(message: string): void {
  console.log(`    \x1b[31m✗\x1b[0m ${message}`);
}

/**
 * Log info
 */
export function info(message: string): void {
  console.log(`    ${message}`);
}

/**
 * Execute a command (or show in dry-run mode)
 */
export function exec(command: string, options?: { silent?: boolean }): string {
  if (dryRun) {
    if (!options?.silent) {
      console.log(`    \x1b[90m$ ${command}\x1b[0m`);
    }
    return "";
  }

  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: options?.silent ? "pipe" : "inherit",
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    throw new Error(`Command failed: ${command}\n${e.stderr ?? ""}`);
  }
}

/**
 * Execute a command and return output (silent)
 */
export function execSilent(command: string): string {
  if (dryRun) {
    return "";
  }

  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Check if a command exists
 */
export function commandExists(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if running as root
 */
export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Write a file (or show in dry-run mode)
 */
export function writeFile(path: string, content: string): void {
  if (dryRun) {
    console.log(`    \x1b[90mWrite ${path}:\x1b[0m`);
    const lines = content.split("\n").slice(0, 5);
    for (const line of lines) {
      console.log(`    \x1b[90m  ${line}\x1b[0m`);
    }
    if (content.split("\n").length > 5) {
      console.log(`    \x1b[90m  ...\x1b[0m`);
    }
    return;
  }

  fsWriteFile(path, content);
}
