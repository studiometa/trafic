import { writeFileSync } from "node:fs";
import { step, success, info, exec, commandExists } from "./steps.js";

/**
 * Install system dependencies required by Trafic
 */
export function installSystemDeps(): void {
  step("Install system dependencies");

  exec("apt-get update -qq", { silent: true });
  exec("DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y jq curl rsync", { silent: true });

  success("System dependencies installed: jq, curl, rsync");
}

/**
 * Add the official DDEV apt repository and GPG key.
 * Idempotent: safe to call even if the repository is already configured.
 */
export function addDdevAptRepo(): void {
  exec("install -m 0755 -d /etc/apt/keyrings", { silent: true });
  exec(
    "curl -fsSL https://pkg.ddev.com/apt/gpg.key | gpg --dearmor | tee /etc/apt/keyrings/ddev.gpg > /dev/null",
    { silent: true },
  );
  exec("chmod a+r /etc/apt/keyrings/ddev.gpg", { silent: true });
  exec(
    "echo \"deb [signed-by=/etc/apt/keyrings/ddev.gpg] https://pkg.ddev.com/apt/ * *\" | tee /etc/apt/sources.list.d/ddev.list > /dev/null",
    { silent: true },
  );
}

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

  // Install DDEV via the official apt repository
  // See https://docs.ddev.com/en/stable/users/install/ddev-installation/#debianubuntu
  info("Adding DDEV apt repository...");
  addDdevAptRepo();

  info("Installing DDEV...");
  exec("apt-get update -qq", { silent: true });
  exec("DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y ddev", { silent: true });

  // Initialize mkcert certificate authority for the ddev user.
  // mkcert installs the CA into the home directory of the current user.
  // Since setup runs as root, we must point HOME to the ddev user's home
  // so the CA is trusted by DDEV when it runs as that user.
  exec("HOME=/home/ddev mkcert -install", { silent: true });
  exec("chown -R ddev:ddev /home/ddev/.local/share/mkcert", { silent: true });

  const version = exec("ddev --version 2>/dev/null | head -1", { silent: true });
  success(`DDEV installed: ${version?.trim() ?? "unknown version"}`);
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

  // Configure all global settings in a single call
  exec(
    ddevCmd(
      `ddev config global --project-tld=${tld} --router-http-port=80 --router-https-port=443 --use-letsencrypt=${email ? "true" : "false"} ${email ? `--letsencrypt-email=${email}` : ""} --instrumentation-opt-in=false`,
    ),
    { silent: true },
  );

  success(`DDEV configured with TLD: ${tld}`);
  info(`Ensure DNS is configured: *.${tld} → server IP`);

  if (email) {
    success(`Let's Encrypt enabled with email: ${email}`);
  }

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
  exec("mkdir -p /home/ddev/.ddev/traefik", { silent: true });
  exec("chown -R ddev:ddev /home/ddev/.ddev", { silent: true });

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
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/trafic.yaml", { silent: true });

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
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/dynamic.yaml", { silent: true });

  success("Traefik configured with Trafic middleware");
}
