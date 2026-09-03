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

/** The Docker volume Traefik keeps its state in. */
const GLOBAL_CACHE_VOLUME = "ddev-global-cache";

/**
 * Delete Traefik's ACME storage.
 *
 * Turning `use_letsencrypt` off stops DDEV asking for new certificates, but
 * it does not discard the ones already issued: Traefik keeps them in
 * acme.json inside the ddev-global-cache volume and serves them again after a
 * restart. On a server where a host ingress terminates TLS and verifies the
 * hop against the mkcert root, that resurrected certificate fails validation
 * and every request answers 502 — seen on a live server.
 *
 * The volume's mountpoint is resolved rather than reached through a
 * container, so this works whether or not ddev-router is running and needs no
 * extra image. Setup and migrations already run as root, which is what
 * reading a Docker volume from the host needs.
 *
 * Returns true when something was removed.
 */
export function purgeTraefikAcmeStorage(io: SetupIo = nodeIo): boolean {
  const mountpoint = io
    .execSilent(`docker volume inspect ${GLOBAL_CACHE_VOLUME} --format '{{.Mountpoint}}'`)
    .trim();

  if (!mountpoint) {
    // No volume yet — a fresh server has nothing to purge
    return false;
  }

  const acmeDir = `${mountpoint}/traefik`;

  // acme.json.* covers the copies a hand-fix or an upgrade may have left
  const found = io.execSilent(`ls ${acmeDir}/acme.json ${acmeDir}/acme.json.* 2>/dev/null`).trim();

  if (!found) {
    return false;
  }

  io.exec(`rm -f ${acmeDir}/acme.json ${acmeDir}/acme.json.*`, { silent: true });
  return true;
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
  } else if (purgeTraefikAcmeStorage(io)) {
    // Otherwise a certificate issued before it was turned off comes back on
    // the next router restart, and a proxy verifying against mkcert rejects it
    success("Removed Traefik's Let's Encrypt storage");
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

/** The ports ddev-router serves projects on. */
export interface RouterPorts {
  http: string;
  https: string;
}

/** Used when the global config does not say otherwise */
const DEFAULT_ROUTER_PORTS: RouterPorts = { http: "80", https: "443" };

/**
 * Read the ports ddev-router serves projects on.
 *
 * Traefik names an entry point after its port, so these decide what the
 * catch-all routers and the auth middleware must attach to. Hardcoding 80 and
 * 443 is wrong on any server where the router was moved — which is every
 * server running a host ingress in front of it.
 */
export function readRouterPorts(io: SetupIo = nodeIo): RouterPorts {
  const output = io.execSilent("su - ddev -c 'ddev config global'");

  const read = (key: string, fallback: string): string =>
    new RegExp(`^${key}=(\\d+)$`, "m").exec(output)?.[1] ?? fallback;

  return {
    http: read("router-http-port", DEFAULT_ROUTER_PORTS.http),
    https: read("router-https-port", DEFAULT_ROUTER_PORTS.https),
  };
}

/**
 * Build the static config attaching forward auth to every entry point.
 *
 * The error page middleware stays on the web entry points only: a 502 from a
 * stopped project should show the waiting page, while a tool port has nothing
 * to wait for.
 */
export function buildStaticConfig(
  toolPorts: string[],
  routerPorts: RouterPorts = DEFAULT_ROUTER_PORTS,
): string {
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

  // A tool port that happens to equal a router port must not be emitted
  // twice: a duplicate key makes the whole static config invalid
  const web = [routerPorts.http, routerPorts.https];
  const tools = toolPorts.filter((port) => !web.includes(port));

  return `entryPoints:
${web.map((port) => webEntryPoint(`http-${port}`)).join("")}${tools.map(toolEntryPoint).join("")}`;
}

/**
 * Build the dynamic config: the middlewares, the agent service, and the
 * catch-all routers that hand a stopped project to the waiting page.
 *
 * One catch-all per web entry point, each naming the entry point it serves.
 * A router that names none is instantiated by Traefik on *every* entry point,
 * and DDEV's router health check compares the number of router definitions in
 * its config files against the number Traefik reports. Two unpinned
 * definitions became fourteen instances on a server with six tool entry
 * points, so the counts never matched, the health check waited out its
 * timeout, and every `ddev start` failed after 60 seconds.
 */
export function buildDynamicConfig(
  gatewayIp: string,
  routerPorts: RouterPorts = DEFAULT_ROUTER_PORTS,
): string {
  return `# Trafic: Forward auth middleware definition
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
    # Lowest priority, so a DDEV project router always wins. These only match
    # when none does — which is what a stopped project produces, because DDEV
    # removes that project's router and Traefik would otherwise answer 404.
    # Without them the waiting page never appears and scale-to-zero never
    # restarts anything. Auth is unaffected: it is attached at the entry
    # point, not here, so this cannot reintroduce the bypass that #27 fixed.
    #
    # Each names exactly one entry point. Leaving entryPoints out attaches a
    # router to all of them, which breaks DDEV's router health check — it
    # counts definitions and compares them to what Traefik loaded.
    trafic-catchall:
      rule: "PathPrefix(\`/\`)"
      entryPoints:
        - http-${routerPorts.http}
      priority: 1
      service: trafic-service

    # Carries tls, so it only matches the https entry point. The plain one
    # above cannot serve it, and one alone would leave HTTP answering 404.
    trafic-catchall-tls:
      rule: "PathPrefix(\`/\`)"
      entryPoints:
        - http-${routerPorts.https}
      priority: 1
      service: trafic-service
      tls: {}

  services:
    trafic-service:
      loadBalancer:
        servers:
          - url: "http://${gatewayIp}:9876"
`;
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

  // Entry point names come from the ports, so both configs need them
  const routerPorts = readRouterPorts(io);

  // Dynamic configuration: the middlewares, the agent service and the
  // catch-all routers. Written to custom-global-config/, which DDEV copies
  // into the ddev-global-cache volume on project start. It used to be written
  // to the traefik root as well, for DDEV versions that watched it — nothing
  // reads that copy on 1.25, and having two made debugging harder.
  const dynamicConfig = buildDynamicConfig(gatewayIp, routerPorts);

  io.writeFile("/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", dynamicConfig);
  io.exec("chown ddev:ddev /home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", { silent: true });

  // Static configuration: attaches trafic-auth to every entry point DDEV
  // publishes, and trafic-errors to the web ones, so every request goes
  // through auth regardless of which project router handles it.
  // DDEV merges all static_config.*.yaml files into .static_config.yaml on start.
  const staticConfig = buildStaticConfig(readToolPorts(io), routerPorts);

  io.writeFile("/home/ddev/.ddev/traefik/static_config.trafic.yaml", staticConfig);
  io.exec("chown ddev:ddev /home/ddev/.ddev/traefik/static_config.trafic.yaml", { silent: true });

  info(`Entry points: http-${routerPorts.http}, http-${routerPorts.https} (web) plus tool ports`);

  success("Traefik configured with Trafic middleware");
}
