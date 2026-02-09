#!/usr/bin/env node

/**
 * Integration test runner
 *
 * Uses Docker to run an Ubuntu 24.04 container with SSH for testing.
 * Works locally and in CI (GitHub Actions).
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg) {
  console.log(`\x1b[36m[integration]\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m[integration]\x1b[0m ${msg}`);
}

// ============================================================================
// Docker
// ============================================================================

function isDockerInstalled() {
  try {
    execSync("which docker", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isDockerRunning() {
  try {
    execSync("docker info", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find or generate an SSH key for the Docker container
 */
function getSSHKeyPath() {
  // Check common SSH key locations
  const sshDir = join(homedir(), ".ssh");
  const keyTypes = ["id_ed25519", "id_rsa", "id_ecdsa"];

  for (const keyType of keyTypes) {
    const pubKeyPath = join(sshDir, `${keyType}.pub`);
    if (existsSync(pubKeyPath)) {
      return pubKeyPath;
    }
  }

  // Generate a temporary key for CI
  const tempKeyDir = join(tmpdir(), "trafic-test-ssh");
  const tempKeyPath = join(tempKeyDir, "id_ed25519");
  const tempPubKeyPath = `${tempKeyPath}.pub`;

  if (!existsSync(tempPubKeyPath)) {
    log("Generating temporary SSH key for tests...");
    mkdirSync(tempKeyDir, { recursive: true, mode: 0o700 });
    execSync(
      `ssh-keygen -t ed25519 -f "${tempKeyPath}" -N "" -C "trafic-test"`,
      { stdio: "pipe" },
    );
    chmodSync(tempKeyPath, 0o600);
  }

  return tempPubKeyPath;
}

function startDockerContainer() {
  log("Starting Docker SSH container...");
  try {
    const composeFile = join(__dirname, "docker-compose.yml");
    const sshKeyPath = getSSHKeyPath();

    log(`Using SSH key: ${sshKeyPath}`);

    // Stop any existing container
    execSync(`docker compose -f "${composeFile}" down 2>/dev/null || true`, {
      stdio: "pipe",
    });

    // Start container with SSH key
    execSync(`docker compose -f "${composeFile}" up -d --build`, {
      stdio: "inherit",
      cwd: __dirname,
      env: {
        ...process.env,
        SSH_AUTH_KEY: sshKeyPath,
      },
    });

    // Wait for SSH to be ready
    log("Waiting for SSH to be ready...");
    let attempts = 0;
    const maxAttempts = 30;

    // Get the private key path (remove .pub)
    const privateKeyPath = sshKeyPath.replace(/\.pub$/, "");

    while (attempts < maxAttempts) {
      try {
        execSync(
          `ssh -i "${privateKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p 2222 testuser@localhost echo ok`,
          { stdio: "pipe" },
        );
        return { privateKeyPath };
      } catch {
        attempts++;
        execSync("sleep 1");
      }
    }

    error("SSH container failed to start");
    return null;
  } catch (err) {
    error(`Failed to start Docker container: ${err.message}`);
    return null;
  }
}

function stopDockerContainer() {
  try {
    const composeFile = join(__dirname, "docker-compose.yml");
    execSync(`docker compose -f "${composeFile}" down`, { stdio: "pipe" });
  } catch {
    // Ignore errors
  }
}

// ============================================================================
// Test runner
// ============================================================================

function runTests(options = {}) {
  const withCoverage = process.argv.includes("--coverage");

  const args = ["vitest", "run", "test/integration/"];
  if (withCoverage) {
    args.push("--coverage");
  }

  // Set environment variables for tests
  const env = {
    ...process.env,
    TRAFIC_TEST_SSH_KEY: options.privateKeyPath,
  };

  return new Promise((resolve) => {
    const child = spawn("npx", args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env,
    });

    child.on("close", (code) => {
      resolve(code);
    });
  });
}

async function main() {
  // Check Docker
  if (!isDockerInstalled()) {
    error("Docker is not installed. Skipping integration tests.");
    error("Install Docker from https://docker.com/");
    process.exit(0);
  }

  if (!isDockerRunning()) {
    error("Docker is not running. Skipping integration tests.");
    error("Start Docker and try again.");
    process.exit(0);
  }

  // Start container
  const options = startDockerContainer();
  if (!options) {
    error("Failed to start test container. Skipping integration tests.");
    process.exit(0);
  }

  log("\nStarting integration tests...\n");

  const exitCode = await runTests(options);

  // Cleanup
  stopDockerContainer();

  process.exit(exitCode);
}

main().catch((err) => {
  error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
