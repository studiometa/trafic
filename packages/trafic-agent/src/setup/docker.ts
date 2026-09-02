import { nodeIo, type SetupIo } from "./io.js";
import { step, success, info, warn } from "./steps.js";

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
  };

  io.exec("mkdir -p /etc/docker");

  const configPath = "/etc/docker/daemon.json";

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

  // Reload Docker to apply config
  io.exec("systemctl reload docker || systemctl restart docker");
  success("Docker configured with production settings");
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
