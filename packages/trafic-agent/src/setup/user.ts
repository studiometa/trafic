import { nodeIo, type SetupIo } from "./io.js";
import { step, success, info, warn } from "./steps.js";

/**
 * Write /etc/sudoers.d/trafic-ddev allowing the ddev user to run
 * ddev-hostname without a password. Idempotent — safe to call multiple times.
 */
export function configureDdevSudoers(io: SetupIo = nodeIo): void {
  const sudoersContent = `# Trafic: allow ddev user to run ddev-hostname without a password.
# ddev-hostname manages /etc/hosts and always calls sudo internally.
ddev ALL=(ALL) NOPASSWD: /usr/bin/ddev-hostname
`;
  io.writeFile("/etc/sudoers.d/trafic-ddev", sudoersContent);
  io.exec("chmod 440 /etc/sudoers.d/trafic-ddev", { silent: true });
  success("Configured passwordless sudo for ddev-hostname");
}

/**
 * Create the ddev user with proper permissions
 */
export function createDdevUser(io: SetupIo = nodeIo): void {
  step("Create ddev user");

  // Check if user exists
  const userExists = io.execSilent("id -u ddev");
  if (userExists) {
    info("User 'ddev' already exists");
  } else {
    io.exec("useradd -m -s /bin/bash ddev");
    success("Created user 'ddev'");
  }

  // Add to docker group (will be created by Docker install)
  io.exec("usermod -aG docker ddev 2>/dev/null || true", { silent: true });

  // Create www directory
  io.exec("mkdir -p /home/ddev/www");
  io.exec("chown ddev:ddev /home/ddev/www");
  io.exec("chmod 750 /home/ddev/www");
  success("Created /home/ddev/www");

  // Create .ssh directory if needed
  io.exec("mkdir -p /home/ddev/.ssh");
  io.exec("chmod 700 /home/ddev/.ssh");
  io.exec("chown ddev:ddev /home/ddev/.ssh");

  // Allow ddev user to run ddev-hostname without a password.
  // ddev-hostname manages /etc/hosts entries and always calls sudo internally,
  // even when DDEV_NONINTERACTIVE=true. Without this rule, any ddev command
  // that touches hostname resolution (start, restart, poweroff + start) will
  // fail with "sudo: a terminal is required to read the password".
  configureDdevSudoers(io);
  success("User ddev configured");
}

/**
 * Setup authorized_keys for ddev user
 */
export function setupAuthorizedKeys(
  publicKey?: string,
  io: SetupIo = nodeIo,
): void {
  if (!publicKey) {
    warn("No SSH public key provided, skipping authorized_keys setup");
    return;
  }

  step("Setup SSH authorized_keys");

  const authKeysPath = "/home/ddev/.ssh/authorized_keys";
  io.exec(`touch ${authKeysPath}`);
  io.exec(`chmod 600 ${authKeysPath}`);
  io.exec(`chown ddev:ddev ${authKeysPath}`);

  // Check if key already exists
  const existing = io.execSilent(`cat ${authKeysPath}`);
  if (existing.includes(publicKey.trim())) {
    info("SSH key already authorized");
  } else {
    io.exec(`echo '${publicKey}' >> ${authKeysPath}`);
    success("Added SSH public key");
  }
}
