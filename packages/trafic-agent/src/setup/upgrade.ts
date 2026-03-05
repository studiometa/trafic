import { execSync } from "node:child_process";
import { step, success, info, warn, exec, isRoot } from "./steps.js";
import { runPendingMigrations } from "./migrations/index.js";

declare const __VERSION__: string;

/**
 * Fetch the latest published version of @studiometa/trafic-agent from the npm registry.
 * Returns null if the registry is unreachable.
 */
export function fetchLatestVersion(): string | null {
  try {
    return execSync("npm show @studiometa/trafic-agent version", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Compare two semver strings. Returns true if `next` is strictly greater than `current`.
 * Handles simple MAJOR.MINOR.PATCH without pre-release suffixes.
 */
export function isNewer(current: string, next: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, "").split(".").map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const [cMaj, cMin, cPat] = parse(current);
  const [nMaj, nMin, nPat] = parse(next);

  if (nMaj !== cMaj) return nMaj > cMaj;
  if (nMin !== cMin) return nMin > cMin;
  return nPat > cPat;
}

/**
 * Install the latest version of @studiometa/trafic-agent globally via npm.
 */
export function installLatestAgent(dryRun: boolean): void {
  exec("npm install -g @studiometa/trafic-agent@latest", { silent: !dryRun });
}

/**
 * Restart the trafic-agent systemd service.
 */
export function restartAgentService(dryRun: boolean): void {
  exec("systemctl restart trafic-agent", { silent: !dryRun });
}

/**
 * Full upgrade sequence:
 *  1. Check for a new version on npm
 *  2. Install it globally if one is found
 *  3. Run pending migrations
 *  4. Restart the systemd service
 */
export function runUpgrade(dryRun = false): void {
  if (!isRoot() && !dryRun) {
    console.error("    \x1b[31m✗\x1b[0m This command must be run as root");
    console.log("  Run: sudo trafic-agent upgrade");
    process.exit(1);
  }

  // ── Step 1: Check for updates ─────────────────────────────────────────────
  step("Check for updates");

  const current = __VERSION__;
  info(`Current version: ${current}`);

  const latest = fetchLatestVersion();

  if (!latest) {
    warn("Could not reach npm registry — skipping version check");
  } else if (isNewer(current, latest)) {
    success(`New version available: ${latest}`);

    // ── Step 2: Install ───────────────────────────────────────────────────
    step("Install latest version");
    installLatestAgent(dryRun);
    if (!dryRun) {
      success(`Installed @studiometa/trafic-agent@${latest}`);
    }
  } else {
    success(`Already up to date (${current})`);
  }

  // ── Step 3: Run pending migrations ───────────────────────────────────────
  step("Run pending migrations");
  runPendingMigrations(dryRun);

  // ── Step 4: Restart service ───────────────────────────────────────────────
  step("Restart trafic-agent service");
  restartAgentService(dryRun);
  if (!dryRun) {
    success("Service restarted");
  }
}
