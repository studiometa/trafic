import { writeFileSync } from "node:fs";
import { step, success, info, exec, commandExists } from "./steps.js";

/**
 * Install DDEV
 */
export function installDdev(): void {
  step("Install DDEV");

  if (commandExists("ddev")) {
    const version = exec("ddev --version 2>/dev/null | head -1", { silent: true });
    info(`DDEV already installed: ${version?.trim() ?? "unknown version"}`);
    return;
  }

  // Install DDEV manually (the official script has issues with non-interactive shells)
  // Get latest release version
  info("Fetching latest DDEV version...");
  const latestVersion = exec(
    "curl -fsSL https://api.github.com/repos/ddev/ddev/releases/latest | grep '\"tag_name\"' | sed -E 's/.*\"([^\"]+)\".*/\\1/'",
    { silent: true },
  )?.trim();

  if (!latestVersion) {
    throw new Error("Could not determine latest DDEV version");
  }

  info(`Installing DDEV ${latestVersion}...`);

  // Download and extract
  const arch = exec("uname -m", { silent: true })?.trim() === "x86_64" ? "amd64" : "arm64";
  const tarball = `ddev_linux-${arch}.${latestVersion}.tar.gz`;
  const url = `https://github.com/ddev/ddev/releases/download/${latestVersion}/${tarball}`;

  exec(`curl -fsSL -o /tmp/${tarball} ${url}`);
  exec(`tar -xzf /tmp/${tarball} -C /tmp ddev`);

  // Install to /usr/local/bin (we're root)
  exec("mv /tmp/ddev /usr/local/bin/ddev");
  exec("chmod +x /usr/local/bin/ddev");
  exec(`rm -f /tmp/${tarball}`);

  // Also install mkcert for local HTTPS
  info("Installing mkcert...");
  const mkcertVersion = exec(
    "curl -fsSL https://api.github.com/repos/FiloSottile/mkcert/releases/latest | grep '\"tag_name\"' | sed -E 's/.*\"([^\"]+)\".*/\\1/'",
    { silent: true },
  )?.trim();

  if (mkcertVersion) {
    const mkcertBin = `mkcert-${mkcertVersion}-linux-${arch}`;
    exec(`curl -fsSL -o /usr/local/bin/mkcert https://github.com/FiloSottile/mkcert/releases/download/${mkcertVersion}/${mkcertBin}`);
    exec("chmod +x /usr/local/bin/mkcert");
  }

  success(`DDEV ${latestVersion} installed`);
}

/**
 * Configure DDEV global settings for production
 *
 * Note on DNS and /etc/hosts:
 * When using a custom TLD (not ddev.site), DDEV may try to edit /etc/hosts
 * if it can't resolve project hostnames via DNS. To avoid this:
 * 1. Configure DNS so *.{tld} resolves to the server's IP (recommended)
 * 2. Or install dnsmasq for local wildcard DNS resolution
 *
 * With proper DNS, DDEV won't need sudo for hostname management.
 */
export function configureDdev(tld: string, email?: string): void {
  step("Configure DDEV");

  // Run as ddev user
  const ddevCmd = (cmd: string) => `su - ddev -c '${cmd}'`;

  // Configure global settings
  // use_dns_when_possible=true (default) means DDEV uses DNS resolution
  // and only falls back to /etc/hosts if DNS fails
  exec(
    ddevCmd(
      `ddev config global --project-tld=${tld} --router-http-port=80 --router-https-port=443 --use-letsencrypt=${email ? "true" : "false"} ${email ? `--letsencrypt-email=${email}` : ""}`,
    ),
  );

  success(`DDEV configured with TLD: ${tld}`);
  info(`Ensure DNS is configured: *.${tld} → server IP`);

  if (email) {
    success(`Let's Encrypt enabled with email: ${email}`);
  }

  // Disable instrumentation (telemetry)
  exec(ddevCmd("ddev config global --instrumentation-opt-in=false"));

  success("DDEV global settings configured");
}

/**
 * Install dnsmasq for local DNS resolution (optional)
 * This allows the server itself to resolve *.{tld} hostnames
 * without needing to edit /etc/hosts for each project
 */
export function installDnsmasq(tld: string): void {
  step("Install dnsmasq for local DNS");

  exec("apt-get update && apt-get install -y dnsmasq", { silent: true });

  // Get server's public IP
  const serverIp = exec(
    "curl -4 -s ifconfig.me || hostname -I | awk '{print $1}'",
    { silent: true },
  )?.trim() || "127.0.0.1";

  // Configure dnsmasq to resolve *.{tld} to server IP
  const dnsmasqConfig = `# Trafic: Local DNS for DDEV projects
# Resolve all *.${tld} to this server
address=/${tld}/${serverIp}

# Don't read /etc/resolv.conf
no-resolv

# Use upstream DNS for everything else
server=1.1.1.1
server=8.8.8.8

# Listen on localhost only
listen-address=127.0.0.1
bind-interfaces
`;

  writeFileSync("/etc/dnsmasq.d/trafic.conf", dnsmasqConfig);

  // Configure system to use local dnsmasq
  exec("systemctl restart dnsmasq");
  exec("systemctl enable dnsmasq");

  // Update resolv.conf to use local DNS first
  info("Configure /etc/resolv.conf to use 127.0.0.1 as primary DNS");

  success(`dnsmasq configured: *.${tld} → ${serverIp}`);
}

/**
 * Configure Traefik for forward auth
 */
export function configureTraefik(): void {
  step("Configure Traefik for forward auth");

  // Create custom Traefik config directory
  exec("mkdir -p /home/ddev/.ddev/traefik");
  exec("chown -R ddev:ddev /home/ddev/.ddev");

  // Static configuration for Trafic middleware
  const staticConfig = `# Trafic: Forward auth middleware
http:
  middlewares:
    trafic-auth:
      forwardAuth:
        address: "http://host.docker.internal:9876/__auth__"
        authResponseHeaders:
          - "X-Trafic-Project"

    trafic-errors:
      errors:
        status:
          - "502"
          - "503"
        service: trafic-service
        query: "/"

  services:
    trafic-service:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:9876"
`;

  writeFileSync("/home/ddev/.ddev/traefik/trafic.yaml", staticConfig);
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/trafic.yaml");

  // Create default router config that applies middleware to all projects
  const routerConfig = `# Trafic: Default router configuration
# This file makes all DDEV projects use the Trafic auth middleware
http:
  routers:
    trafic-catch-all:
      rule: "HostRegexp(\`.+\`)"
      priority: 1
      middlewares:
        - trafic-auth
        - trafic-errors
      service: api@internal
`;

  writeFileSync("/home/ddev/.ddev/traefik/dynamic.yaml", routerConfig);
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/dynamic.yaml");

  success("Traefik configured with Trafic middleware");
}
