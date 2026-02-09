import { step, success, info, exec, execSilent, warn } from "./steps.js";

/**
 * Create the ddev user with proper permissions
 */
export function createDdevUser(): void {
  step("Create ddev user");

  // Check if user exists
  const userExists = execSilent("id -u ddev 2>/dev/null");
  if (userExists) {
    info("User 'ddev' already exists");
  } else {
    exec("useradd -m -s /bin/bash ddev");
    success("Created user 'ddev'");
  }

  // Add to docker group (will be created by Docker install)
  exec("usermod -aG docker ddev 2>/dev/null || true", { silent: true });

  // Create www directory
  exec("mkdir -p /home/ddev/www");
  exec("chown ddev:ddev /home/ddev/www");
  exec("chmod 750 /home/ddev/www");
  success("Created /home/ddev/www");

  // Create .ssh directory if needed
  exec("mkdir -p /home/ddev/.ssh");
  exec("chmod 700 /home/ddev/.ssh");
  exec("chown ddev:ddev /home/ddev/.ssh");

  // Enable passwordless sudo for ddev and docker commands
  const sudoersContent = `# Trafic: Allow ddev user to manage DDEV and Docker
ddev ALL=(ALL) NOPASSWD: /usr/bin/ddev, /usr/bin/docker, /usr/bin/systemctl restart trafic-agent
`;

  exec(`echo '${sudoersContent}' > /etc/sudoers.d/trafic`);
  exec("chmod 440 /etc/sudoers.d/trafic");
  success("Configured sudo for ddev user");
}

/**
 * Setup authorized_keys for ddev user
 */
export function setupAuthorizedKeys(publicKey?: string): void {
  if (!publicKey) {
    warn("No SSH public key provided, skipping authorized_keys setup");
    return;
  }

  step("Setup SSH authorized_keys");

  const authKeysPath = "/home/ddev/.ssh/authorized_keys";
  exec(`touch ${authKeysPath}`);
  exec(`chmod 600 ${authKeysPath}`);
  exec(`chown ddev:ddev ${authKeysPath}`);

  // Check if key already exists
  const existing = execSilent(`cat ${authKeysPath}`);
  if (existing.includes(publicKey.trim())) {
    info("SSH key already authorized");
  } else {
    exec(`echo '${publicKey}' >> ${authKeysPath}`);
    success("Added SSH public key");
  }
}
