import type { SetupOptions } from "./types.js";
import { step, info, error, setDryRun, resetSteps, isRoot } from "./steps.js";
import { createDdevUser } from "./user.js";
import { installDocker, configureDocker, setupDockerPrune } from "./docker.js";
import { installDdev, configureDdev, configureTraefik } from "./ddev.js";
import { installNode, installAgent, createAgentConfig, createSystemdService } from "./agent.js";
import { hardenServer } from "./hardening.js";
import { runAudit, printAuditResults } from "./audit.js";

export * from "./types.js";
export * from "./audit.js";

/**
 * Run the full server setup
 */
export async function setup(options: SetupOptions): Promise<void> {
  resetSteps();
  setDryRun(options.dryRun ?? false);

  console.log("\n\x1b[1m🚦 Trafic Server Setup\x1b[0m\n");

  if (options.dryRun) {
    console.log("\x1b[33m⚠ Dry-run mode: no changes will be made\x1b[0m\n");
  }

  // Check root
  if (!isRoot() && !options.dryRun) {
    error("This command must be run as root");
    console.log("  Run: sudo trafic-agent setup ...");
    process.exit(1);
  }

  info(`TLD: ${options.tld}`);
  if (options.email) {
    info(`Let's Encrypt email: ${options.email}`);
  }
  if (options.noHardening) {
    info("Hardening: disabled");
  }

  try {
    // Step 1: Create ddev user
    createDdevUser();

    // Step 2: Install Docker
    if (!options.noDocker) {
      installDocker();
      configureDocker();
      setupDockerPrune();
    } else {
      step("Install Docker");
      info("Skipped (--no-docker)");
    }

    // Step 3: Install DDEV
    if (!options.noDdev) {
      installDdev();
      configureDdev(options.tld, options.email);
      configureTraefik();
    } else {
      step("Install DDEV");
      info("Skipped (--no-ddev)");
    }

    // Step 4: Install Node.js
    installNode();

    // Step 5: Install and configure agent
    installAgent();
    createAgentConfig(options.tld, options.email);
    createSystemdService();

    // Step 6: Server hardening
    if (!options.noHardening) {
      const sshUsers = options.sshUsers ?? ["ddev"];
      hardenServer(sshUsers);
    } else {
      step("Server hardening");
      info("Skipped (--no-hardening)");
    }

    // Done
    console.log("\n\x1b[32m✓ Setup complete!\x1b[0m\n");
    console.log("Next steps:");
    console.log(`  1. Edit /etc/trafic/config.toml to configure authentication`);
    console.log(`  2. Add SSH public keys to /home/ddev/.ssh/authorized_keys`);
    console.log(`  3. Deploy your first project:`);
    console.log(`     npx @studiometa/trafic-cli deploy --host=<this-server> --name=my-app`);
    console.log(`\nYour projects will be available at https://<name>.${options.tld}`);
  } catch (err) {
    error(`Setup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/**
 * Run security audit
 */
export async function audit(): Promise<void> {
  const checks = runAudit();
  printAuditResults(checks);

  const failed = checks.filter((c) => c.status === "fail").length;
  if (failed > 0) {
    process.exit(1);
  }
}
