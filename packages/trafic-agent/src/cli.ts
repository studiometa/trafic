#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadConfig, validateConfig } from "./utils/config.js";
import { startServer } from "./server.js";
import { startIdleScheduler } from "./tasks/stop-idle.js";
import { closeDb } from "./utils/db.js";
import { setup, audit } from "./setup/index.js";

declare const __VERSION__: string;

const HELP = `
trafic-agent — Server agent for DDEV preview environments

Usage:
  trafic-agent <command> [options]

Commands:
  start                   Start the agent server
  setup                   Setup a new server (Docker, DDEV, hardening)
  audit                   Run security audit checks
  version                 Show version
  help                    Show this help

Start options:
  -c, --config <path>     Path to config file (default: /etc/trafic/config.toml)
  -p, --port <port>       Override port from config

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

  // Start server and scheduler
  startServer(config);
  startIdleScheduler(config);
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
