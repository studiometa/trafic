import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
 * Uses --prefer-online to bypass the local npm cache and always fetch the
 * latest published tarball.
 */
export function installLatestAgent(dryRun: boolean): void {
  exec("npm install -g @studiometa/trafic-agent@latest --prefer-online", { silent: !dryRun });
}

/**
 * Read the actual installed version of @studiometa/trafic-agent from its
 * package.json on disk — not from __VERSION__ which is baked in at build time.
 *
 * Resolves the package root by walking up from the trafic-agent binary:
 *   /usr/bin/trafic-agent -> /usr/lib/node_modules/@studiometa/trafic-agent/dist/cli.js
 *   -> /usr/lib/node_modules/@studiometa/trafic-agent/package.json
 *
 * Returns null if the file can't be read.
 */
export function getInstalledVersion(): string | null {
  try {
    // Resolve the real path of the binary (follow symlinks)
    const realBinary = execSync("readlink -f $(which trafic-agent)", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    // dist/cli.js -> up two dirs -> package root
    const pkgJson = `${realBinary.replace(/\/dist\/cli\.js$/, "")}/package.json`;
    const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

/**
 * Re-exec the newly installed trafic-agent binary with the same arguments.
 * Used after a self-update so the new binary runs its own migrations.
 * This function never returns — it replaces the current process.
 */
export function reExecNewBinary(args: string[]): never {
  const binary = execSync("which trafic-agent", { encoding: "utf-8", stdio: "pipe" }).trim();
  const result = spawnSync(binary, args, {
    stdio: "inherit",
    env: { ...process.env, TRAFIC_UPGRADE_REEXEC: "1" },
  });
  process.exit(result.status ?? 0);
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
 *  2. Install it globally if one is found — then re-exec the new binary
 *     so that steps 3 and 4 run with the new migration registry
 *  3. Run pending migrations
 *  4. Restart the systemd service
 */
export function runUpgrade(dryRun = false, reExecArgs?: string[]): void {
  if (!isRoot() && !dryRun) {
    console.error("    \x1b[31m✗\x1b[0m This command must be run as root");
    console.log("  Run: sudo trafic-agent upgrade");
    process.exit(1);
  }

  // Guard against infinite re-exec loops: only re-exec once per upgrade run.
  const alreadyReExeced = process.env["TRAFIC_UPGRADE_REEXEC"] === "1";

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
      // Verify the installed version actually changed before re-execing —
      // npm can serve stale cache and leave the old binary in place.
      const installedVersion = getInstalledVersion();

      if (!alreadyReExeced && installedVersion && isNewer(current, installedVersion)) {
        success(`Installed @studiometa/trafic-agent@${installedVersion}`);
        // Re-exec the newly installed binary so steps 3 and 4 run with the
        // new migration registry — the current process only knows about
        // migrations that existed at the time it was compiled.
        reExecNewBinary(reExecArgs ?? ["upgrade"]);
      } else if (installedVersion) {
        success(`Installed @studiometa/trafic-agent@${installedVersion}`);
      }
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
