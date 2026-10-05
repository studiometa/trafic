import { nodeIo, type SetupIo } from "./io.js";
import { step, success, info, warn } from "./steps.js";
import { findRunningProjects } from "./ddev.js";

/**
 * Install Docker using the official script
 */
export function installDocker(io: SetupIo = nodeIo): void {
  step("Install Docker");

  if (io.commandExists("docker")) {
    const version = io.exec("docker --version", { silent: true });
    info(`Docker already installed: ${version?.trim() ?? "unknown version"}`);
    return;
  }

  // Install Docker using official script
  info("Downloading and running Docker install script...");
  io.exec("curl -fsSL https://get.docker.com -o /tmp/get-docker.sh");
  io.exec("sh /tmp/get-docker.sh", { silent: true });
  io.exec("rm /tmp/get-docker.sh");

  // Enable and start Docker
  io.exec("systemctl enable docker", { silent: true });
  io.exec("systemctl start docker", { silent: true });

  success("Docker installed and started");

  // Add ddev user to docker group
  io.exec("usermod -aG docker ddev", { silent: true });
  success("Added ddev user to docker group");
}

/** Docker daemon config file */
export const DAEMON_CONFIG = "/etc/docker/daemon.json";

/**
 * Address pools for the networks Docker creates.
 *
 * Every DDEV project gets its own network. Docker's built-in pools hold only
 * about 31 of them (15 × /16 in 172.17–31.x, 16 × /20 in 192.168.x), so a
 * server with ~30 projects fails with "all predefined address pools have
 * been fully subnetted". /24 subnets in 172.16.0.0/12 give 4096 networks,
 * and keep every network inside the range the firewall rules already allow
 * (hardening.ts, docker-firewall.ts) — the built-in 192.168.x pools are not.
 */
export const DOCKER_ADDRESS_POOLS = [{ base: "172.16.0.0/12", size: 24 }];

/**
 * Add the address pools to an existing daemon config.
 *
 * Returns true when the config was changed. Leaves a config that already
 * sets pools alone (an operator choice), and one it cannot parse.
 */
export function addDockerAddressPools(io: SetupIo = nodeIo): boolean {
  let config: Record<string, unknown> = {};

  if (io.fileExists(DAEMON_CONFIG)) {
    try {
      config = JSON.parse(io.readFile(DAEMON_CONFIG));
    } catch {
      warn("Could not parse existing Docker config, skipping");
      return false;
    }
  }

  if ("default-address-pools" in config) {
    return false;
  }

  io.exec("mkdir -p /etc/docker");
  io.writeFile(
    DAEMON_CONFIG,
    JSON.stringify({ ...config, "default-address-pools": DOCKER_ADDRESS_POOLS }, null, 2),
  );
  return true;
}

/**
 * Configure Docker for production use
 */
export function configureDocker(io: SetupIo = nodeIo): void {
  step("Configure Docker");

  // Create daemon.json with production settings
  const daemonConfig = {
    "log-driver": "json-file",
    "log-opts": {
      "max-size": "10m",
      "max-file": "3",
    },
    "storage-driver": "overlay2",
    "live-restore": true,
    "default-address-pools": DOCKER_ADDRESS_POOLS,
  };

  io.exec("mkdir -p /etc/docker");

  const configPath = DAEMON_CONFIG;

  // Check if config already exists
  if (io.fileExists(configPath)) {
    try {
      const existing = JSON.parse(io.readFile(configPath));
      // Merge with existing config
      const merged = { ...existing, ...daemonConfig };
      io.writeFile(configPath, JSON.stringify(merged, null, 2));
      info("Merged with existing Docker config");
    } catch {
      warn("Could not parse existing Docker config, skipping");
      return;
    }
  } else {
    io.writeFile(configPath, JSON.stringify(daemonConfig, null, 2));
  }

  // A reload applies neither default-address-pools nor storage-driver
  restartDocker(io);
  success("Docker configured with production settings");
}

/**
 * Restart Docker to apply daemon.json, without orphaning running containers.
 *
 * `live-restore` keeps containers running across a restart, but only when
 * the storage driver stays the same. Before 0.1.47, setup applied daemon.json
 * with a reload, and a reload does not apply `storage-driver`. Docker 29
 * defaults a fresh install to the containerd image store (`overlayfs`), so
 * such a server runs `overlayfs` while daemon.json says `overlay2`. The first
 * full restart switches the driver, and dockerd silently skips every
 * container created with the other one. Their processes keep running and
 * keep the locks on the database volumes. DDEV then creates new containers
 * that exit at once on "Can't lock aria control file". Seen on a live server
 * after migration 0018: 66 containers lost, 27 of them databases.
 *
 * So when the driver is about to change, the DDEV projects are stopped first,
 * which shuts their databases down cleanly, and the projects that were running
 * are started again on the new driver. Volumes do not depend on the storage
 * driver, so no data moves. Images are pulled again for the new driver.
 */
export function restartDocker(io: SetupIo = nodeIo): void {
  if (!switchesStorageDriver(io)) {
    io.exec("systemctl restart docker");
    return;
  }

  const running = findRunningProjects(io);

  warn("Docker changes its storage driver on restart, stopping DDEV projects first");

  if (io.commandExists("ddev")) {
    io.exec("su - ddev -c 'DDEV_NONINTERACTIVE=true ddev poweroff'", { silent: true });
  }

  io.exec("systemctl restart docker");

  if (running.length > 0) {
    info(`Starting ${running.length} project(s) again: ${running.join(", ")}`);
    io.exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev start ${running.join(" ")}'`, {
      silent: true,
    });
  }
}

/**
 * Whether a restart makes Docker use another storage driver.
 *
 * Compares the driver the daemon runs now with the one daemon.json asks for.
 * A config without `storage-driver` keeps the current one.
 */
function switchesStorageDriver(io: SetupIo): boolean {
  const active = io.execSilent("docker info --format '{{.Driver}}'");

  if (!active || !io.fileExists(DAEMON_CONFIG)) {
    return false;
  }

  try {
    const configured = JSON.parse(io.readFile(DAEMON_CONFIG))["storage-driver"];
    return typeof configured === "string" && configured !== active;
  } catch {
    return false;
  }
}

/**
 * Setup Docker system prune cron job
 */
export function setupDockerPrune(io: SetupIo = nodeIo): void {
  step("Setup Docker cleanup cron");

  const cronContent = `# Trafic: Clean up Docker resources weekly
0 3 * * 0 root docker system prune -af --volumes 2>&1 | logger -t docker-prune
`;

  io.writeFile("/etc/cron.d/trafic-docker-prune", cronContent);
  io.exec("chmod 644 /etc/cron.d/trafic-docker-prune");

  success("Docker prune scheduled weekly at 3am on Sundays");
}
