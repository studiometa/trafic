#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadConfig, parseTimeout, validateConfig } from "./utils/config.js";
import { startServer } from "./server.js";
import { startIdleScheduler } from "./tasks/stop-idle.js";
import { cancelScheduledDestroy, closeDb, getScheduledDestroys, initDb } from "./utils/db.js";
import { destroyProject } from "./tasks/destroy-project.js";
import {
  scheduleProjectDestroy,
  startScheduledDestroyScheduler,
} from "./tasks/destroy-scheduled.js";
import { startBackupSweepScheduler } from "./tasks/backup.js";
import { setup, audit } from "./setup/index.js";
import { isRoot } from "./setup/steps.js";
import { listMigrations } from "./setup/migrations/index.js";
import { runUpgrade } from "./setup/upgrade.js";
import type { AgentConfig } from "./types.js";

declare const __VERSION__: string;

const HELP = `
trafic-agent — Server agent for DDEV preview environments

Usage:
  trafic-agent <command> [options]

Commands:
  start                   Start the agent server
  setup                   Setup a new server (Docker, DDEV, hardening)
  upgrade                 Check for a new version, install it, run migrations, restart the service
  update                  Alias for upgrade
  audit                   Run security audit checks
  destroy <name>          Remove a project: DDEV project, directory, database records,
                          now or after a delay
  version                 Show version
  help                    Show this help

Start options:
  -c, --config <path>     Path to config file (default: /etc/trafic/config.toml)
  -p, --port <port>       Override port from config

Setup options:
  --tld <domain>          TLD for DDEV projects (required on first run, reused from config on re-runs)
  --email <email>         Email for Let's Encrypt certificates
  --dns-provider <name>   DNS-01 provider (lego name, e.g. cloudflare). Turns on the
                          wildcard *.<tld> certificate; requires --email
  --dns-env KEY=VALUE     Credential for that provider, repeatable
  --no-hardening          Skip server hardening steps
  --no-root-ssh           Disable root SSH login (recovery via rescue mode only)
  --no-docker             Skip Docker installation
  --no-ddev               Skip DDEV installation
  --ssh-users <users>     Comma-separated list of SSH users to allow (default: ddev)
  --trusted-proxy-hops <n> Proxies in front of the agent (default: 1; 2 behind a CDN).
                          Written to the generated config; ignored if one exists
  --dry-run               Show what would be done without making changes

Destroy options:
  -c, --config <path>     Path to config file (default: /etc/trafic/config.toml)
  --backup                Back up the database and upload directories first, to
                          [backup] dir. If the backup fails, nothing is removed
  --timeout <duration>    Time limit of the backup, the database dump and the files
                          archive together: 10m, 90s, 1h; a bare number is minutes
                          (default: 40m)
  --delay <duration>      Remove nothing now: schedule the removal after this delay
                          (e.g. 48h). The agent removes the project when it is due
  --cancel                Cancel the scheduled removal of the project
  --list                  List the scheduled removals

Upgrade/update options:
  --dry-run               Show what would be done without making changes
  --list                  List all migrations and their status (no install or restart)

Examples:
  # Start the agent
  trafic-agent start
  trafic-agent start --config /path/to/config.toml

  # Setup a new server
  sudo trafic-agent setup --tld=previews.example.com
  sudo trafic-agent setup --tld=previews.example.com --trusted-proxy-hops=2
  sudo trafic-agent setup --tld=previews.example.com --email=admin@example.com

  # Setup with one wildcard certificate instead of one per preview
  sudo trafic-agent setup --tld=previews.example.com --email=admin@example.com \\
    --dns-provider=cloudflare --dns-env=CF_DNS_API_TOKEN=xxx

  sudo trafic-agent setup --tld=previews.example.com --no-hardening --dry-run

  # Upgrade: install latest version, run migrations, restart service
  sudo trafic-agent upgrade
  sudo trafic-agent upgrade --dry-run
  trafic-agent upgrade --list
  sudo trafic-agent update          # alias for upgrade

  # Run security audit
  trafic-agent audit

  # Remove a project (as the ddev user, never as root)
  trafic-agent destroy preview-42--my-app
  trafic-agent destroy preview-42--my-app --backup
  trafic-agent destroy preview-42--my-app --backup --timeout 1h
  trafic-agent destroy preview-42--my-app --delay 48h --backup
  trafic-agent destroy preview-42--my-app --cancel
  trafic-agent destroy --list
`;

function printHelp(): void {
  console.log(HELP.trim());
}

function printVersion(): void {
  console.log(__VERSION__);
}

/** Print the configuration errors and exit with code 1, if there are any. */
function exitOnConfigErrors(config: AgentConfig): void {
  const errors = validateConfig(config);

  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

async function runStart(values: Record<string, unknown>): Promise<void> {
  // Load config
  const config = loadConfig(values.config as string | undefined);

  // Override port if specified
  if (values.port) {
    config.port = parseInt(values.port as string, 10);
  }

  exitOnConfigErrors(config);

  // Graceful shutdown
  const shutdown = (): void => {
    console.log("\nShutting down...");
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start server and schedulers
  startServer(config);
  startIdleScheduler(config);
  startBackupSweepScheduler(config);
  startScheduledDestroyScheduler(config);
}

/**
 * Remove a project. Runs as the ddev user, next to the running service: both
 * open the same database, so the config is read the same way `start` reads it.
 */
async function runDestroy(
  values: Record<string, unknown>,
  name: string | undefined,
): Promise<void> {
  // DDEV refuses to run as root, so the directory would go and leave the
  // containers behind, and root could leave files in the database directory
  // that the service cannot write to
  if (isRoot()) {
    console.error("Error: run trafic-agent destroy as the ddev user, not root");
    process.exit(1);
  }

  if (!name && !values.list) {
    console.error("Error: a project name is required");
    console.error("Example: trafic-agent destroy preview-42--my-app");
    process.exit(1);
  }

  // Reject a bad duration rather than quietly using the default: the flag
  // exists to raise the limit for a large backup
  const timeout = values.timeout as string | undefined;
  const timeoutMs = timeout === undefined ? undefined : parseTimeout(timeout);

  if (timeout !== undefined && timeoutMs === undefined) {
    console.error(`Error: invalid --timeout "${timeout}". Expected a duration such as 10m, 90s or 1h`);
    process.exit(1);
  }

  // A relative or empty backup.dir would put the backup in the working
  // directory, which start refuses
  const config = loadConfig(values.config as string | undefined);
  exitOnConfigErrors(config);
  initDb(config.dbPath);

  const backup = values.backup as boolean | undefined;
  const delay = values.delay as string | undefined;

  try {
    if (values.list) {
      printScheduledDestroys();
    } else if (values.cancel) {
      console.log(
        cancelScheduledDestroy(name!)
          ? `Cancelled the scheduled removal of ${name}`
          : `No removal scheduled for ${name}`,
      );
    } else if (delay !== undefined) {
      const destroyAt = scheduleProjectDestroy(name!, delay, config, { backup });
      console.log(
        `Scheduled the removal of ${name} at ${destroyAt.toISOString()}${backup ? ", after a backup" : ""}`,
      );
    } else {
      await destroyProject(name!, config, { backup, timeoutMs });
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

/** Print the scheduled removals, soonest first. */
function printScheduledDestroys(): void {
  const scheduled = getScheduledDestroys();

  if (scheduled.length === 0) {
    console.log("No removal scheduled");
    return;
  }

  for (const { name, destroyAt, backup } of scheduled) {
    console.log(`${new Date(destroyAt).toISOString()}  ${name}${backup ? "  (backup)" : ""}`);
  }
}

function handleUpgrade(values: Record<string, unknown>): void {
  const dryRun = values["dry-run"] as boolean | undefined;
  const list = values.list as boolean | undefined;

  if (list) {
    const entries = listMigrations();
    console.log("\nMigrations:\n");

    for (const { migration, status } of entries) {
      const icon = status === "applied" ? "\x1b[32m✓\x1b[0m" : "\x1b[36m→\x1b[0m";
      const label = status === "applied" ? "\x1b[90m(applied)\x1b[0m" : "(pending)";
      console.log(`  ${icon} \x1b[1m${migration.id.padEnd(30)}\x1b[0m ${migration.description.padEnd(55)} ${label}`);
    }

    console.log("");
    return;
  }

  console.log("\n\x1b[1m🚦 Trafic Server Upgrade\x1b[0m\n");

  if (dryRun) {
    console.log("\x1b[33m⚠ Dry-run mode: no changes will be made\x1b[0m\n");
  }

  // Build re-exec args so flags survive the binary swap after a self-update
  const reExecArgs = ["upgrade", ...(dryRun ? ["--dry-run"] : [])];
  runUpgrade(dryRun ?? false, reExecArgs);

  if (!dryRun) {
    console.log("\n\x1b[32m✓ Upgrade complete!\x1b[0m\n");
  }
}

/**
 * Parse --trusted-proxy-hops, failing loudly rather than writing a config
 * that would quietly break the IP allowlist.
 */
function parseTrustedProxyHops(raw?: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const hops = Number(raw);

  if (!Number.isInteger(hops) || hops < 1) {
    console.error(
      `Error: --trusted-proxy-hops must be a whole number of 1 or more, got "${raw}"`,
    );
    console.error("  1 = ddev-router/Traefik alone, 2 = a CDN in front of it");
    process.exit(1);
  }

  return hops;
}

/**
 * Parse repeated --dns-env KEY=VALUE pairs.
 *
 * A bad entry stops setup: a provider silently missing its token fails much
 * later, as an ACME error in the router log.
 */
function parseDnsEnv(entries?: string[]): Record<string, string> {
  const env: Record<string, string> = {};

  for (const entry of entries ?? []) {
    const separator = entry.indexOf("=");
    const key = separator === -1 ? entry : entry.slice(0, separator);

    if (separator === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.error(`Error: --dns-env must be KEY=VALUE, got "${entry}"`);
      process.exit(1);
    }

    env[key] = entry.slice(separator + 1);
  }

  return env;
}

async function runSetup(values: Record<string, unknown>): Promise<void> {
  // Load existing config to use as defaults on re-runs
  const existingConfig = loadConfig();
  const tld = (values.tld as string | undefined) ?? (existingConfig.tld || undefined);

  if (!tld) {
    console.error("Error: --tld is required for setup");
    console.error("Example: trafic-agent setup --tld=previews.example.com");
    process.exit(1);
  }

  // Re-runs keep what the config already says, so a setup run for another
  // reason cannot silently drop the wildcard certificate
  const dnsProvider =
    (values["dns-provider"] as string | undefined) ?? existingConfig.tls.dnsProvider;
  const dnsEnv = {
    ...existingConfig.tls.dnsEnv,
    ...parseDnsEnv(values["dns-env"] as string[] | undefined),
  };

  if (dnsProvider && !values.email) {
    console.error("Error: --dns-provider requires --email");
    console.error("  Let's Encrypt refuses an ACME account without one");
    process.exit(1);
  }

  await setup({
    tld,
    dnsProvider,
    dnsEnv,
    // Not a flag: a CA override is a config-file decision, kept across re-runs
    caServer: existingConfig.tls.caServer,
    trustedProxyHops: parseTrustedProxyHops(values["trusted-proxy-hops"] as string | undefined),
    email: values.email as string | undefined,
    noHardening: values["no-hardening"] as boolean | undefined,
    noRootSsh: values["no-root-ssh"] as boolean | undefined,
    noDocker: values["no-docker"] as boolean | undefined,
    noDdev: values["no-ddev"] as boolean | undefined,
    sshUsers: values["ssh-users"]
      ? (values["ssh-users"] as string).split(",").map((s) => s.trim())
      : undefined,
    dryRun: values["dry-run"] as boolean | undefined,
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // Common
      help: { type: "boolean", short: "h" },

      // Start options
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },

      // Setup options
      tld: { type: "string" },
      email: { type: "string" },
      "no-hardening": { type: "boolean" },
      "no-root-ssh": { type: "boolean" },
      "no-docker": { type: "boolean" },
      "no-ddev": { type: "boolean" },
      "ssh-users": { type: "string" },
      "dns-provider": { type: "string" },
      "dns-env": { type: "string", multiple: true },
      "trusted-proxy-hops": { type: "string" },
      "dry-run": { type: "boolean" },

      // Upgrade and destroy options
      list: { type: "boolean" },

      // Destroy options
      backup: { type: "boolean" },
      timeout: { type: "string" },
      delay: { type: "string" },
      cancel: { type: "boolean" },
    },
  });

  const command = positionals[0] ?? "help";

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case "help":
      printHelp();
      break;

    case "version":
      printVersion();
      break;

    case "start":
      await runStart(values);
      break;

    case "setup":
      await runSetup(values);
      break;

    case "upgrade":
    case "update":
      handleUpgrade(values);
      break;

    case "audit":
      await audit();
      break;

    case "destroy":
      await runDestroy(values, positionals[1]);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
