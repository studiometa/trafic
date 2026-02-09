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

  // Install DDEV using the official install script
  info("Installing DDEV...");
  exec(
    "curl -fsSL https://ddev.com/install.sh | bash -s -- --version latest",
  );

  success("DDEV installed");
}

/**
 * Configure DDEV global settings for production
 */
export function configureDdev(tld: string, email?: string): void {
  step("Configure DDEV");

  // Run as ddev user
  const ddevCmd = (cmd: string) => `su - ddev -c '${cmd}'`;

  // Configure global settings
  exec(
    ddevCmd(
      `ddev config global --project-tld=${tld} --router-http-port=80 --router-https-port=443 --use-letsencrypt=${email ? "true" : "false"} ${email ? `--letsencrypt-email=${email}` : ""}`,
    ),
  );

  success(`DDEV configured with TLD: ${tld}`);

  if (email) {
    success(`Let's Encrypt enabled with email: ${email}`);
  }

  // Disable instrumentation (telemetry)
  exec(ddevCmd("ddev config global --instrumentation-opt-in=false"));

  // Start the router
  exec(ddevCmd("ddev poweroff || true"));
  exec(ddevCmd("ddev start"));

  success("DDEV router started");
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

  const { writeFileSync } = require("node:fs");
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
