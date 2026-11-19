import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDockerGatewayIp } from "../ddev.js";
import type { Migration } from "../types.js";

const PPREVIEW_YAML = "/home/ddev/.ddev/traefik/ppreview.yaml";

/**
 * Migration 0005: Replace host.docker.internal with the Docker bridge gateway IP
 * in the Traefik forward-auth config.
 *
 * host.docker.internal is a Docker Desktop / macOS feature and is not available
 * on Linux without explicit configuration. The Traefik router container cannot
 * resolve it, so forward-auth requests silently fail and all traffic bypasses
 * authentication.
 *
 * Fix: replace all occurrences of host.docker.internal in ppreview.yaml with the
 * actual Docker bridge gateway IP (typically 172.17.0.1 or 172.18.0.1).
 *
 * Condition: skip if ppreview.yaml doesn't exist or already uses an IP address.
 */
export const migration0005TraefikGatewayIp: Migration = {
  id: "0005__traefik_gateway_ip",
  description: "Replace host.docker.internal with Docker bridge gateway IP in Traefik config",

  run(): void {
    if (!existsSync(PPREVIEW_YAML)) {
      return;
    }

    const content = readFileSync(PPREVIEW_YAML, "utf-8");
    const gatewayIp = getDockerGatewayIp();

    // Replace host.docker.internal (original broken value) or any previously
    // written IP that no longer matches the current gateway (e.g. if the
    // migration ran before ddev_default existed and wrote 172.17.0.1 instead).
    const updated = content
      .replaceAll("host.docker.internal", gatewayIp)
      .replace(/http:\/\/\d+\.\d+\.\d+\.\d+:9876/g, `http://${gatewayIp}:9876`);

    if (updated === content) {
      return;
    }

    writeFileSync(PPREVIEW_YAML, updated, "utf-8");
  },
};
