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
      `ddev config global --project-tld=${tld} --router-http-port=80 --router-https-port=443 --router-bind-all-interfaces=true --use-letsencrypt=${email ? "true" : "false"} ${email ? `--letsencrypt-email=${email}` : ""} --instrumentation-opt-in=false`,
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
 * Get the Docker gateway IP reachable from inside DDEV containers on Linux.
 * DDEV runs containers on the `ddev_default` network — we inspect that first.
 * Falls back to the default `bridge` network, then to 172.17.0.1.
 * `host.docker.internal` is not available on Linux without extra configuration.
 */
export function getDockerGatewayIp(): string {
  // Prefer the ddev_default network gateway — that's the network ddev-router is on
  const ddevIp = exec(
    "docker network inspect ddev_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null",
    { silent: true },
  )?.trim();
  if (ddevIp) return ddevIp;

  // Fall back to the default bridge network
  const bridgeIp = exec(
    "docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null",
    { silent: true },
  )?.trim();
  return bridgeIp || "172.17.0.1";
}

/**
 * Configure Traefik for forward auth
 */
export function configureTraefik(): void {
  step("Configure Traefik for forward auth");

  // Create custom Traefik config directories
  exec("mkdir -p /home/ddev/.ddev/traefik/custom-global-config", { silent: true });
  exec("chown -R ddev:ddev /home/ddev/.ddev", { silent: true });

  // Use the Docker bridge gateway IP instead of host.docker.internal —
  // the latter is not available on Linux without extra Docker configuration.
  const gatewayIp = getDockerGatewayIp();

  // Dynamic configuration: defines the trafic-auth and trafic-errors middlewares
  // and the trafic-service backend pointing at the agent.
  // Written to:
  //   - custom-global-config/ — picked up by DDEV 1.25+ (survives config dir purge on restart)
  //   - traefik root — also watched by older DDEV versions
  const dynamicConfig = `# Trafic: Forward auth middleware definition
http:
  middlewares:
    trafic-auth:
      forwardAuth:
        address: "http://${gatewayIp}:9876/__auth__"
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
          - url: "http://${gatewayIp}:9876"
`;

  writeFileSync("/home/ddev/.ddev/traefik/trafic.yaml", dynamicConfig);
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/trafic.yaml", { silent: true });
  writeFileSync("/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", dynamicConfig);
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", { silent: true });

  // Static configuration: attaches trafic-auth and trafic-errors to the
  // http-80 and http-443 entry points so every request goes through auth —
  // regardless of which project router handles it.
  // DDEV merges all static_config.*.yaml files into .static_config.yaml on start.
  const staticConfig = `entryPoints:
  http-80:
    http:
      middlewares:
        - trafic-auth@file
        - trafic-errors@file
  http-443:
    http:
      middlewares:
        - trafic-auth@file
        - trafic-errors@file
`;

  writeFileSync("/home/ddev/.ddev/traefik/static_config.trafic.yaml", staticConfig);
  exec("chown ddev:ddev /home/ddev/.ddev/traefik/static_config.trafic.yaml", { silent: true });

  success("Traefik configured with Trafic middleware");
}
