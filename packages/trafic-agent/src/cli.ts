#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadConfig, validateConfig } from "./utils/config.js";
import { startServer } from "./server.js";
import { startIdleScheduler } from "./tasks/stop-idle.js";
import { startBackupScheduler } from "./tasks/backup-scheduler.js";
import { runBackup, listBackups, restoreProjectDb, findBackup, cleanOldBackups } from "./tasks/backup.js";
import { loadProjectList } from "./utils/ddev.js";
import { closeDb } from "./utils/db.js";
import { setup, audit } from "./setup/index.js";

declare const __VERSION__: string;

const HELP = `
trafic-agent — Server agent for DDEV preview environments

Usage:
  trafic-agent <command> [options]

Commands:
  start                   Start the agent server
  backup                  Backup project databases
  restore                 Restore a project database from backup
  setup                   Setup a new server (Docker, DDEV, hardening)
  audit                   Run security audit checks
  version                 Show version
  help                    Show this help

Start options:
  -c, --config <path>     Path to config file (default: /etc/trafic/config.toml)
  -p, --port <port>       Override port from config

Backup options:
  -c, --config <path>     Path to config file
  --name <name>           Backup a specific project (default: all)
  --list                  List available backups
  --clean                 Clean old backups beyond retention period

Restore options:
  -c, --config <path>     Path to config file
  --name <name>           Project name to restore (required)
  --date <YYYY-MM-DD>     Restore from a specific date (default: latest)
  --file <path>           Restore from a specific backup file

Setup options:
  --tld <domain>          TLD for DDEV projects (required)
  --email <email>         Email for Let's Encrypt certificates
  --no-hardening          Skip server hardening steps
  --no-docker             Skip Docker installation
  --no-ddev               Skip DDEV installation
  --ssh-users <users>     Comma-separated list of SSH users to allow (default: ddev)
  --dry-run               Show what would be done without making changes

Examples:
  # Start the agent
  trafic-agent start
  trafic-agent start --config /path/to/config.toml

  # Setup a new server
  sudo trafic-agent setup --tld=previews.example.com
  sudo trafic-agent setup --tld=previews.example.com --email=admin@example.com
  sudo trafic-agent setup --tld=previews.example.com --no-hardening --dry-run

  # Backup all projects
  trafic-agent backup
  trafic-agent backup --name my-app

  # List and clean backups
  trafic-agent backup --list
  trafic-agent backup --clean

  # Restore a project
  trafic-agent restore --name my-app
  trafic-agent restore --name my-app --date 2026-02-07

  # Run security audit
  trafic-agent audit
`;

function printHelp(): void {
  console.log(HELP.trim());
}

function printVersion(): void {
  console.log(__VERSION__);
}

async function runStart(values: Record<string, unknown>): Promise<void> {
  // Load config
  const config = loadConfig(values.config as string | undefined);

  // Override port if specified
  if (values.port) {
    config.port = parseInt(values.port as string, 10);
  }

  // Validate config
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

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

  if (config.backup.enabled) {
    startBackupScheduler(config);
  }
}

async function runSetup(values: Record<string, unknown>): Promise<void> {
  const tld = values.tld as string | undefined;

  if (!tld) {
    console.error("Error: --tld is required for setup");
    console.error("Example: trafic-agent setup --tld=previews.example.com");
    process.exit(1);
  }

  await setup({
    tld,
    email: values.email as string | undefined,
    noHardening: values["no-hardening"] as boolean | undefined,
    noDocker: values["no-docker"] as boolean | undefined,
    noDdev: values["no-ddev"] as boolean | undefined,
    sshUsers: values["ssh-users"]
      ? (values["ssh-users"] as string).split(",").map((s) => s.trim())
      : undefined,
    dryRun: values["dry-run"] as boolean | undefined,
  });
}

function runBackupCommand(values: Record<string, unknown>): void {
  const config = loadConfig(values.config as string | undefined);

  if (values.list) {
    const entries = listBackups(config.backup);
    if (entries.length === 0) {
      console.log("No backups found.");
      return;
    }

    // Group by date
    let currentDate = "";
    for (const entry of entries) {
      if (entry.date !== currentDate) {
        currentDate = entry.date;
        console.log(`\n${currentDate}:`);
      }
      const sizeMb = (entry.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(`  ${entry.project} (${sizeMb} MB)`);
    }
    return;
  }

  if (values.clean) {
    const removed = cleanOldBackups(config.backup);
    console.log(`Cleaned ${removed} old backup(s) (retention: ${config.backup.retainDays} days)`);
    return;
  }

  const projectName = values.name as string | undefined;
  const results = runBackup(config, {
    projectName,
    // Explicit CLI request: start stopped projects if targeting a specific one
    forceStart: !!projectName,
  });
  const failed = results.filter((r) => !r.success && !r.error?.includes("skipped"));
  if (failed.length > 0) {
    process.exit(1);
  }
}

function runRestoreCommand(values: Record<string, unknown>): void {
  const config = loadConfig(values.config as string | undefined);
  const name = values.name as string | undefined;

  if (!name) {
    console.error("Error: --name is required for restore");
    process.exit(1);
  }

  // Find the backup file
  let backupFile = values.file as string | undefined;

  if (!backupFile) {
    backupFile = findBackup(config.backup, name, values.date as string | undefined);
    if (!backupFile) {
      const dateHint = values.date ? ` on ${values.date}` : "";
      console.error(`No backup found for ${name}${dateHint}`);
      process.exit(1);
    }
  }

  // Find project directory
  const projects = loadProjectList(config.projectListPath);
  const projectDir = projects.get(name);

  if (!projectDir) {
    console.error(`Project ${name} not found in project list`);
    process.exit(1);
  }

  console.log(`Restoring ${name} from ${backupFile}`);
  const success = restoreProjectDb(name, projectDir, backupFile);

  if (!success) {
    process.exit(1);
  }
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
      "no-docker": { type: "boolean" },
      "no-ddev": { type: "boolean" },
      "ssh-users": { type: "string" },
      "dry-run": { type: "boolean" },

      // Backup options
      name: { type: "string" },
      list: { type: "boolean" },
      clean: { type: "boolean" },

      // Restore options
      date: { type: "string" },
      file: { type: "string" },
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

    case "backup":
      runBackupCommand(values);
      break;

    case "restore":
      runRestoreCommand(values);
      break;

    case "audit":
      await audit();
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
