import { nodeIo, type SetupIo } from "./io.js";
import { step, success, info } from "./steps.js";

/**
 * Install system dependencies required by Trafic
 */
export function installSystemDeps(io: SetupIo = nodeIo): void {
  step("Install system dependencies");

  io.exec("apt-get update -qq", { silent: true });
  // gnupg and ca-certificates are needed to add the DDEV and NodeSource
  // apt repositories — a minimal Ubuntu image ships with neither
  io.exec(
    "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y jq curl rsync gnupg ca-certificates",
    { silent: true },
  );

  success("System dependencies installed: jq, curl, rsync, gnupg, ca-certificates");
}

/**
 * Add the official DDEV apt repository and GPG key.
 * Idempotent: safe to call even if the repository is already configured.
 */
export function addDdevAptRepo(io: SetupIo = nodeIo): void {
  io.exec("install -m 0755 -d /etc/apt/keyrings", { silent: true });
  io.exec(
    "curl -fsSL https://pkg.ddev.com/apt/gpg.key | gpg --dearmor | tee /etc/apt/keyrings/ddev.gpg > /dev/null",
    { silent: true },
  );
  io.exec("chmod a+r /etc/apt/keyrings/ddev.gpg", { silent: true });
  io.exec(
    "echo \"deb [signed-by=/etc/apt/keyrings/ddev.gpg] https://pkg.ddev.com/apt/ * *\" | tee /etc/apt/sources.list.d/ddev.list > /dev/null",
    { silent: true },
  );
}

/**
 * Install DDEV
 */
export function installDdev(io: SetupIo = nodeIo): void {
  step("Install DDEV");

  if (io.commandExists("ddev")) {
    const version = io.exec("ddev --version 2>/dev/null | head -1", { silent: true });
    info(`DDEV already installed: ${version?.trim() ?? "unknown version"}`);
    return;
  }

  // Install DDEV via the official apt repository
  // See https://docs.ddev.com/en/stable/users/install/ddev-installation/#debianubuntu
  info("Adding DDEV apt repository...");
  addDdevAptRepo(io);

  info("Installing DDEV...");
  io.exec("apt-get update -qq", { silent: true });
  io.exec("DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y ddev", { silent: true });

  // Initialize mkcert certificate authority for the ddev user.
  // mkcert installs the CA into the home directory of the current user.
  // Since setup runs as root, we must point HOME to the ddev user's home
  // so the CA is trusted by DDEV when it runs as that user.
  io.exec("HOME=/home/ddev mkcert -install", { silent: true });
  io.exec("chown -R ddev:ddev /home/ddev/.local/share/mkcert", { silent: true });

  const version = io.exec("ddev --version 2>/dev/null | head -1", { silent: true });
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
export function configureDdev(
  tld: string,
  email?: string,
  io: SetupIo = nodeIo,
): void {
  step("Configure DDEV");

  // Run as ddev user
  const ddevCmd = (cmd: string) => `su - ddev -c '${cmd}'`;

  // Configure all global settings in a single call
  io.exec(
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
export function installDnsmasq(tld: string, io: SetupIo = nodeIo): void {
  step("Install dnsmasq for local DNS");

  io.exec("apt-get update && apt-get install -y dnsmasq", { silent: true });

  // Get server's public IP
  const serverIp = io.exec(
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

  io.writeFile("/etc/dnsmasq.d/trafic.conf", dnsmasqConfig);

  // Configure system to use local dnsmasq
  io.exec("systemctl restart dnsmasq");
  io.exec("systemctl enable dnsmasq");

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
export function getDockerGatewayIp(io: SetupIo = nodeIo): string {
  // Prefer the ddev_default network gateway — that's the network ddev-router is on
  const ddevIp = io.execSilent(
    "docker network inspect ddev_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'",
  );
  if (ddevIp) return ddevIp;

  // Fall back to the default bridge network
  const bridgeIp = io.execSilent(
    "docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'",
  );
  return bridgeIp || "172.17.0.1";
}

/** DDEV tool ports, used when the global config does not say otherwise */
const DEFAULT_TOOL_PORTS = {
  "mailpit-http-port": "8025",
  "mailpit-https-port": "8026",
  "xhgui-http-port": "8143",
  "xhgui-https-port": "8142",
} as const;

/**
 * Read the ports DDEV publishes its tools on.
 *
 * ddev-router publishes these on 0.0.0.0, and Docker bypasses UFW for
 * published ports, so a firewall rule cannot protect them — the forward auth
 * middleware is the only thing that can. Read them rather than hardcode: they
 * are configurable, and an entry point Traefik does not know about is ignored.
 */
export function readToolPorts(io: SetupIo = nodeIo): string[] {
  const output = io.execSilent("su - ddev -c 'ddev config global'");
  const ports: string[] = [];

  for (const [key, fallback] of Object.entries(DEFAULT_TOOL_PORTS)) {
    const match = new RegExp(`^${key}=(\\d+)$`, "m").exec(output);
    ports.push(match?.[1] ?? fallback);
  }

  return [...new Set(ports)];
}

/**
 * Build the static config attaching forward auth to every entry point.
 *
 * The error page middleware stays on the web entry points only: a 502 from a
 * stopped project should show the waiting page, while a tool port has nothing
 * to wait for.
 */
export function buildStaticConfig(toolPorts: string[]): string {
  const webEntryPoint = (name: string) => `  ${name}:
    http:
      middlewares:
        - trafic-auth@file
        - trafic-errors@file
`;

  const toolEntryPoint = (port: string) => `  http-${port}:
    http:
      middlewares:
        - trafic-auth@file
`;

  return `entryPoints:
${webEntryPoint("http-80")}${webEntryPoint("http-443")}${toolPorts.map(toolEntryPoint).join("")}`;
}

/**
 * Configure Traefik for forward auth
 */
export function configureTraefik(io: SetupIo = nodeIo): void {
  step("Configure Traefik for forward auth");

  // Create custom Traefik config directories
  io.exec("mkdir -p /home/ddev/.ddev/traefik/custom-global-config", { silent: true });
  io.exec("chown -R ddev:ddev /home/ddev/.ddev", { silent: true });

  // Use the Docker bridge gateway IP instead of host.docker.internal —
  // the latter is not available on Linux without extra Docker configuration.
  const gatewayIp = getDockerGatewayIp(io);

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

  routers:
    # Lowest priority, so a DDEV project router always wins. It only matches
    # when none does - which is what a stopped project produces, because DDEV
    # removes that project's router and Traefik would otherwise answer 404.
    # Without this the waiting page never appears and scale-to-zero never
    # restarts anything. Auth is unaffected: it is attached at the entry
    # point, not here, so this cannot reintroduce the bypass that #27 fixed.
    #
    # Two of them, because a router carrying tls only matches HTTPS entry
    # points: one alone would leave plain HTTP answering 404.
    trafic-catchall:
      rule: "PathPrefix(\`/\`)"
      priority: 1
      service: trafic-service

    trafic-catchall-tls:
      rule: "PathPrefix(\`/\`)"
      priority: 1
      service: trafic-service
      tls: {}

  services:
    trafic-service:
      loadBalancer:
        servers:
          - url: "http://${gatewayIp}:9876"
`;

  io.writeFile("/home/ddev/.ddev/traefik/trafic.yaml", dynamicConfig);
  io.exec("chown ddev:ddev /home/ddev/.ddev/traefik/trafic.yaml", { silent: true });
  io.writeFile("/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", dynamicConfig);
  io.exec("chown ddev:ddev /home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", { silent: true });

  // Static configuration: attaches trafic-auth and trafic-errors to the
  // http-80 and http-443 entry points so every request goes through auth —
  // regardless of which project router handles it.
  // DDEV merges all static_config.*.yaml files into .static_config.yaml on start.
  const staticConfig = buildStaticConfig(readToolPorts(io));

  io.writeFile("/home/ddev/.ddev/traefik/static_config.trafic.yaml", staticConfig);
  io.exec("chown ddev:ddev /home/ddev/.ddev/traefik/static_config.trafic.yaml", { silent: true });

  success("Traefik configured with Trafic middleware");
}
