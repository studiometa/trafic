#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadConfig, validateConfig } from "./utils/config.js";
import { startServer } from "./server.js";
import { startIdleScheduler } from "./tasks/stop-idle.js";
import { closeDb } from "./utils/db.js";

declare const __VERSION__: string;

const HELP = `
trafic-agent — Server agent for DDEV preview environments

Usage:
  trafic-agent [options]
  trafic-agent start [options]    Start the agent server
  trafic-agent version            Show version
  trafic-agent help               Show this help

Options:
  -c, --config <path>    Path to config file (default: /etc/trafic/config.toml)
  -p, --port <port>      Override port from config
  -h, --help             Show this help

Examples:
  trafic-agent start
  trafic-agent start --config /path/to/config.toml
  trafic-agent start --port 8080
`;

function printHelp(): void {
  console.log(HELP.trim());
}

function printVersion(): void {
  console.log(__VERSION__);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0] ?? "start";

  if (values.help || command === "help") {
    printHelp();
    process.exit(0);
  }

  if (command === "version") {
    printVersion();
    process.exit(0);
  }

  if (command !== "start") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  // Load config
  const config = loadConfig(values.config);

  // Override port if specified
  if (values.port) {
    config.port = parseInt(values.port, 10);
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

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
