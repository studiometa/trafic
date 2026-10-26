import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { step, success, info, warn, exec, execSilent, isRoot } from "./steps.js";
import { runPendingMigrations } from "./migrations/index.js";
import { findRunningProjects } from "./ddev.js";
import { loadConfig } from "../utils/config.js";
import {
  closeDb,
  getProject,
  initDb,
  releaseStaleStatuses,
  setProjectStatus,
} from "../utils/db.js";
import type { ProjectRecord } from "../types.js";

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
 * The installed apt package version of DDEV, or null when it cannot be read.
 */
export function ddevVersion(): string | null {
  return execSilent("dpkg-query --show --showformat='${Version}' ddev") || null;
}

/**
 * Upgrade DDEV from its apt repository. Throws when apt fails.
 *
 * DDEV is left out of unattended-upgrades on purpose — a major landing on its
 * own can break running previews — so it is updated here, where an operator
 * is watching. `--only-upgrade` never installs DDEV on a server that does not
 * already have it.
 */
export function upgradeDdev(dryRun: boolean): void {
  exec(
    "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update",
    { silent: !dryRun },
  );
  exec(
    "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y --only-upgrade ddev",
    { silent: !dryRun },
  );
}

/**
 * A project name that is safe in a shell command. DDEV accepts hostname
 * labels only, so a name that fails this check does not come from DDEV.
 */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** Return the name, or throw when it is not safe in a shell command. */
function checkProjectName(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new Error(`Invalid project name: "${name}"`);
  }

  return name;
}

/**
 * Download the images that the installed DDEV uses for these projects.
 * Throws when DDEV fails.
 *
 * DDEV refuses to run as root, so the command runs as the ddev user.
 */
export function downloadDdevImages(projects: string[]): void {
  const names = projects.map(checkProjectName).join(" ");
  exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev utility download-images ${names}'`, {
    silent: true,
  });
}

/**
 * Stop and start one DDEV project, so that it runs on the images of the
 * installed DDEV. Throws when DDEV fails.
 */
export function restartProject(name: string): void {
  exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev restart ${checkProjectName(name)}'`, {
    silent: true,
  });
}

/**
 * The project statuses in the agent database, which the running service
 * reads too.
 */
export interface ProjectStatuses {
  get: (name: string) => ProjectRecord["status"] | undefined;
  set: (name: string, status: "starting" | "running") => void;
  close: () => void;
}

/**
 * Open the agent database. Throws when the config or the database cannot
 * be opened.
 *
 * The upgrade runs as root, and the database belongs to the ddev user. When
 * root creates the journal files, SQLite gives them the owner of the
 * database. But `initDb` would create a missing database owned by root, which
 * the service could then not write: a missing database is an error here.
 *
 * The statuses that a killed process left behind are released first, so
 * that a project is not skipped for a start or a removal that no longer runs.
 */
export function openProjectStatuses(): ProjectStatuses {
  const { dbPath } = loadConfig();

  if (!existsSync(dbPath)) {
    throw new Error(`${dbPath} does not exist`);
  }

  initDb(dbPath);
  releaseStaleStatuses();

  return {
    get: (name) => getProject(name)?.status,
    set: (name, status) => setProjectStatus(name, status),
    close: closeDb,
  };
}

/**
 * What the upgrade sequence needs from the outside world.
 *
 * Injected so the orchestration can be tested without reaching npm, writing
 * to the filesystem or replacing the running process — the last of which is
 * why `reExecNewBinary` is here rather than called directly.
 */
export interface UpgradeIo {
  /** The version of the process running the upgrade. */
  currentVersion: string;
  /** Whether an earlier run already re-execed, guarding against a loop. */
  alreadyReExeced: boolean;
  isRoot: () => boolean;
  fetchLatestVersion: () => string | null;
  installLatestAgent: (dryRun: boolean) => void;
  getInstalledVersion: () => string | null;
  reExecNewBinary: (args: string[]) => never;
  restartAgentService: (dryRun: boolean) => void;
  runPendingMigrations: (dryRun: boolean) => void;
  /** The installed DDEV version, or null when DDEV is absent. */
  ddevVersion: () => string | null;
  upgradeDdev: (dryRun: boolean) => void;
  /** Names of the running DDEV projects. */
  listRunningProjects: () => string[];
  downloadDdevImages: (projects: string[]) => void;
  restartProject: (name: string) => void;
  openProjectStatuses: () => ProjectStatuses;
}

/** The real collaborators, used unless a caller passes their own. */
export function nodeUpgradeIo(): UpgradeIo {
  return {
    currentVersion: __VERSION__,
    alreadyReExeced: process.env["TRAFIC_UPGRADE_REEXEC"] === "1",
    isRoot,
    fetchLatestVersion,
    installLatestAgent,
    getInstalledVersion,
    reExecNewBinary,
    restartAgentService,
    runPendingMigrations,
    ddevVersion,
    upgradeDdev,
    listRunningProjects: () => findRunningProjects(),
    downloadDdevImages,
    restartProject,
    openProjectStatuses,
  };
}

/**
 * Full upgrade sequence:
 *  1. Check for a new version on npm
 *  2. Install it globally if one is found — then re-exec the new binary
 *     so that steps 3 and 4 run with the new migration registry
 *  3. Run pending migrations
 *  4. Update DDEV from its apt repository
 *  5. Restart the running DDEV projects, when the DDEV version changed
 *  6. Restart the systemd service
 */
export function runUpgrade(
  dryRun = false,
  reExecArgs?: string[],
  io: UpgradeIo = nodeUpgradeIo(),
): void {
  if (!io.isRoot() && !dryRun) {
    console.error("    \x1b[31m✗\x1b[0m This command must be run as root");
    console.log("  Run: sudo trafic-agent upgrade");
    process.exit(1);
  }

  // Guard against infinite re-exec loops: only re-exec once per upgrade run.
  const alreadyReExeced = io.alreadyReExeced;

  // ── Step 1: Check for updates ─────────────────────────────────────────────
  step("Check for updates");

  const current = io.currentVersion;
  info(`Current version: ${current}`);

  const latest = io.fetchLatestVersion();

  if (!latest) {
    warn("Could not reach npm registry — skipping version check");
  } else if (isNewer(current, latest)) {
    success(`New version available: ${latest}`);

    // ── Step 2: Install ───────────────────────────────────────────────────
    step("Install latest version");
    io.installLatestAgent(dryRun);

    if (!dryRun) {
      // Verify the installed version actually changed before re-execing —
      // npm can serve stale cache and leave the old binary in place.
      const installedVersion = io.getInstalledVersion();

      if (!alreadyReExeced && installedVersion && isNewer(current, installedVersion)) {
        success(`Installed @studiometa/trafic-agent@${installedVersion}`);
        // Re-exec the newly installed binary so steps 3 and 4 run with the
        // new migration registry — the current process only knows about
        // migrations that existed at the time it was compiled.
        io.reExecNewBinary(reExecArgs ?? ["upgrade"]);
      } else if (installedVersion) {
        success(`Installed @studiometa/trafic-agent@${installedVersion}`);
      }
    }
  } else {
    success(`Already up to date (${current})`);
  }

  // ── Step 3: Run pending migrations ───────────────────────────────────────
  step("Run pending migrations");
  io.runPendingMigrations(dryRun);

  // ── Step 4: Update DDEV ──────────────────────────────────────────────────
  step("Update DDEV");
  const ddevUpdated = upgradeDdevStep(dryRun, io);

  // ── Step 5: Restart running projects ─────────────────────────────────────
  step("Restart running projects");
  restartProjectsStep(dryRun, ddevUpdated, io);

  // ── Step 6: Restart service ───────────────────────────────────────────────
  step("Restart trafic-agent service");
  io.restartAgentService(dryRun);
  if (!dryRun) {
    success("Service restarted");
  }
}

/**
 * Update DDEV, reporting the version on either side of the apt call.
 * Returns whether the DDEV version changed, which dry-run mode cannot know.
 *
 * A failed apt run must not cost the server its service restart, so the
 * error is warned about and the upgrade carries on.
 */
function upgradeDdevStep(dryRun: boolean, io: UpgradeIo): boolean {
  const before = io.ddevVersion();

  if (!dryRun && before === null) {
    info("DDEV is not installed — skipping");
    return false;
  }

  if (before) {
    info(`Current: ${before}`);
  }

  try {
    io.upgradeDdev(dryRun);
  } catch (err) {
    warn(`DDEV update failed: ${errorMessage(err)}`);
    return false;
  }

  if (dryRun) {
    return false;
  }

  const after = io.ddevVersion();
  if (after && after !== before) {
    success(`DDEV updated: ${after}`);
    return true;
  }

  success("DDEV up to date");
  return false;
}

/**
 * Restart the running DDEV projects after a DDEV update.
 *
 * A running project keeps the containers of the DDEV that started it, and so
 * the old webserver image and its PHP, until it stops. Stopped and paused
 * projects get the new images at their next start, so only the running ones
 * restart, and never with `ddev start --all`.
 *
 * The images are downloaded first, while the projects still run. Then the
 * projects restart one at a time, so only one of them is down at a time.
 *
 * The running service keeps serving requests meanwhile. Each project is
 * marked "starting" during its restart: the idle sweep and
 * max_running_projects never stop a project with that status, and the
 * waiting page does not start it a second time. When this process is killed,
 * the service sets the status back (releaseStaleStatuses).
 *
 * A failed restart does not stop the upgrade: the service restart that
 * follows matters more. The failures are listed at the end.
 */
function restartProjectsStep(dryRun: boolean, ddevUpdated: boolean, io: UpgradeIo): void {
  if (!dryRun && !ddevUpdated) {
    info("DDEV did not change — skipping");
    return;
  }

  // `ddev list` runs as the ddev user through `su`, which asks for a
  // password when the caller is not root
  if (dryRun && !io.isRoot()) {
    info("Would restart the running projects if the DDEV version changes");
    return;
  }

  const projects = io.listRunningProjects();

  if (projects.length === 0) {
    info("No project is running");
    return;
  }

  if (dryRun) {
    info(`Would restart these projects if the DDEV version changes: ${projects.join(", ")}`);
    return;
  }

  info(`Download the new DDEV images for ${projects.length} project(s)`);

  try {
    io.downloadDdevImages(projects);
  } catch (err) {
    // `ddev restart` downloads what is missing itself, only with the
    // project down meanwhile
    warn(`Image download failed: ${errorMessage(err)}`);
  }

  let statuses: ProjectStatuses | null = null;

  try {
    statuses = io.openProjectStatuses();
  } catch (err) {
    warn(
      `Could not open the agent database, the service can stop or start a project during its restart: ${errorMessage(err)}`,
    );
  }

  const failed: string[] = [];
  let restarted = 0;

  try {
    for (const name of projects) {
      const status = statuses?.get(name);

      // The waiting page is starting it, or trafic-agent destroy is
      // removing it: a restart now would fight that process
      if (status === "starting" || status === "destroying") {
        info(`Skip ${name}: its status is "${status}"`);
        continue;
      }

      info(`Restart ${name}`);

      try {
        restartOneProject(name, statuses, io);
        restarted++;
      } catch (err) {
        warn(`Could not restart ${name}: ${errorMessage(err)}`);
        failed.push(name);
      }
    }
  } finally {
    statuses?.close();
  }

  if (restarted > 0) {
    success(`Restarted ${restarted} project(s)`);
  }

  if (failed.length > 0) {
    warn(`Failed to restart: ${failed.join(", ")}`);
  }
}

/**
 * Restart one project, marked "starting" while DDEV works on it.
 *
 * The status goes back to "running" after a failure too. The project ran
 * before, and "running" is also what releaseStaleStatuses sets: the idle
 * sweep checks the project against DDEV and records it as stopped when it is
 * down, and a request to a project that is down reaches the waiting page,
 * which starts it. "stopped" would be wrong for a project that a failed
 * restart left up.
 */
function restartOneProject(name: string, statuses: ProjectStatuses | null, io: UpgradeIo): void {
  statuses?.set(name, "starting");

  try {
    io.restartProject(name);
  } finally {
    statuses?.set(name, "running");
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
