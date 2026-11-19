import { writeFileSync, rmSync, existsSync } from "node:fs";
import { exec } from "../steps.js";
import { getDockerGatewayIp } from "../ddev.js";
import type { Migration } from "../types.js";

/**
 * Migration 0008: Switch Traefik from catch-all router to entry point middleware.
 *
 * The previous approach used a low-priority catch-all router (priority=1) with
 * ppreview-auth middleware in dynamic.yaml. This failed because DDEV's project-specific
 * routers always win — they have higher priority and no ppreview-auth middleware.
 *
 * The correct approach (from the previous ppreview v1 with DDEV 1.24) is to attach
 * the middleware at the entry point level via a static_config.*.yaml file that DDEV
 * merges into .static_config.yaml on every start. This ensures every request on
 * http-80 and http-443 passes through auth regardless of which router handles it.
 *
 * Changes:
 * - Write static_config.ppreview.yaml: attaches ppreview-auth@file + ppreview-errors@file
 *   to the http-80 and http-443 entry points
 * - Write ppreview.yaml to custom-global-config/ (survives DDEV 1.25+ config purge)
 * - Remove the old dynamic.yaml catch-all router
 */
export const migration0008TraefikEntrypointMiddleware: Migration = {
  id: "0008__traefik_entrypoint_middleware",
  description:
    "Switch Traefik auth from catch-all router to entry point middleware",

  run(): void {
    const gatewayIp = getDockerGatewayIp();

    // Dynamic config: middleware + service definitions
    const dynamicConfig = `# ppreview: Forward auth middleware definition
http:
  middlewares:
    ppreview-auth:
      forwardAuth:
        address: "http://${gatewayIp}:9876/__auth__"
        authResponseHeaders:
          - "X-Ppreview-Project"

    ppreview-errors:
      errors:
        status:
          - "502"
          - "503"
        service: ppreview-service
        query: "/"

  services:
    ppreview-service:
      loadBalancer:
        servers:
          - url: "http://${gatewayIp}:9876"
`;

    exec("mkdir -p /home/ddev/.ddev/traefik/custom-global-config", { silent: true });
    writeFileSync("/home/ddev/.ddev/traefik/ppreview.yaml", dynamicConfig);
    writeFileSync("/home/ddev/.ddev/traefik/custom-global-config/ppreview.yaml", dynamicConfig);
    exec("chown -R ddev:ddev /home/ddev/.ddev/traefik", { silent: true });

    // Static config: attach middleware to entry points
    const staticConfig = `entryPoints:
  http-80:
    http:
      middlewares:
        - ppreview-auth@file
        - ppreview-errors@file
  http-443:
    http:
      middlewares:
        - ppreview-auth@file
        - ppreview-errors@file
`;

    writeFileSync("/home/ddev/.ddev/traefik/static_config.ppreview.yaml", staticConfig);
    exec("chown ddev:ddev /home/ddev/.ddev/traefik/static_config.ppreview.yaml", { silent: true });

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
