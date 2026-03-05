import { writeFileSync, rmSync, existsSync } from "node:fs";
import { exec } from "../steps.js";
import { getDockerGatewayIp } from "../ddev.js";
import type { Migration } from "../types.js";

/**
 * Migration 0008: Switch Traefik from catch-all router to entry point middleware.
 *
 * The previous approach used a low-priority catch-all router (priority=1) with
 * trafic-auth middleware in dynamic.yaml. This failed because DDEV's project-specific
 * routers always win — they have higher priority and no trafic-auth middleware.
 *
 * The correct approach (from the previous trafic v1 with DDEV 1.24) is to attach
 * the middleware at the entry point level via a static_config.*.yaml file that DDEV
 * merges into .static_config.yaml on every start. This ensures every request on
 * http-80 and http-443 passes through auth regardless of which router handles it.
 *
 * Changes:
 * - Write static_config.trafic.yaml: attaches trafic-auth@file + trafic-errors@file
 *   to the http-80 and http-443 entry points
 * - Write trafic.yaml to custom-global-config/ (survives DDEV 1.25+ config purge)
 * - Remove the old dynamic.yaml catch-all router
 */
export const migration0008TraefikEntrypointMiddleware: Migration = {
  id: "0008__traefik_entrypoint_middleware",
  description:
    "Switch Traefik auth from catch-all router to entry point middleware",

  run(): void {
    const gatewayIp = getDockerGatewayIp();

    // Dynamic config: middleware + service definitions
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

    exec("mkdir -p /home/ddev/.ddev/traefik/custom-global-config", { silent: true });
    writeFileSync("/home/ddev/.ddev/traefik/trafic.yaml", dynamicConfig);
    writeFileSync("/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml", dynamicConfig);
    exec("chown -R ddev:ddev /home/ddev/.ddev/traefik", { silent: true });

    // Static config: attach middleware to entry points
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

    // Remove the old catch-all router config — it's superseded by entry point middleware
    const oldDynamicYaml = "/home/ddev/.ddev/traefik/dynamic.yaml";
    if (existsSync(oldDynamicYaml)) {
      rmSync(oldDynamicYaml);
    }

    // Restart DDEV router to apply the new static config
    exec("su - ddev -c 'DDEV_NONINTERACTIVE=true ddev poweroff && ddev start --all'", {
      silent: false,
    });
  },
};
