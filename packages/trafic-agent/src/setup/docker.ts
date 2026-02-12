import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { step, success, info, exec, commandExists, warn } from "./steps.js";

/**
 * Install Docker using the official script
 */
export function installDocker(): void {
  step("Install Docker");

  if (commandExists("docker")) {
    const version = exec("docker --version", { silent: true });
    info(`Docker already installed: ${version?.trim() ?? "unknown version"}`);
    return;
  }

  // Install Docker using official script
  info("Downloading Docker install script...");
  exec("curl -fsSL https://get.docker.com -o /tmp/get-docker.sh");
  exec("sh /tmp/get-docker.sh");
  exec("rm /tmp/get-docker.sh");

  // Enable and start Docker
  exec("systemctl enable docker");
  exec("systemctl start docker");

  success("Docker installed and started");

  // Add ddev user to docker group
  exec("usermod -aG docker ddev");
  success("Added ddev user to docker group");
}

/**
 * Configure Docker for production use
 */
export function configureDocker(): void {
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

  exec("mkdir -p /etc/docker");

  const configPath = "/etc/docker/daemon.json";

  // Check if config already exists
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8"));
      // Merge with existing config
      const merged = { ...existing, ...daemonConfig };
      writeFileSync(configPath, JSON.stringify(merged, null, 2));
      info("Merged with existing Docker config");
    } catch {
      warn("Could not parse existing Docker config, skipping");
      return;
    }
  } else {
    writeFileSync(configPath, JSON.stringify(daemonConfig, null, 2));
  }

  // Reload Docker to apply config
  exec("systemctl reload docker || systemctl restart docker");
  success("Docker configured with production settings");
}

/**
 * Setup Docker system prune cron job
 */
export function setupDockerPrune(): void {
  step("Setup Docker cleanup cron");

  const cronContent = `# Trafic: Clean up Docker resources weekly
0 3 * * 0 root docker system prune -af --volumes 2>&1 | logger -t docker-prune
`;

  writeFileSync("/etc/cron.d/trafic-docker-prune", cronContent);
  exec("chmod 644 /etc/cron.d/trafic-docker-prune");

  success("Docker prune scheduled weekly at 3am on Sundays");
}
