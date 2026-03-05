import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDockerGatewayIp } from "../ddev.js";
import type { Migration } from "../types.js";

const TRAFIC_YAML = "/home/ddev/.ddev/traefik/trafic.yaml";

/**
 * Migration 0006: Fix the Docker gateway IP in trafic.yaml.
 *
 * Migration 0005 inspected the default `bridge` network (172.17.0.1) instead
 * of the `ddev_default` network (typically 172.18.0.1) that ddev-router
 * actually runs on. This migration rewrites trafic.yaml with the correct IP.
 *
 * Idempotent: re-reads the file and only writes if the IP has changed.
 */
export const migration0006TraefikGatewayIpFix: Migration = {
  id: "0006__traefik_gateway_ip_fix",
  description: "Fix Docker gateway IP in Traefik config (use ddev_default network)",

  run(): void {
    if (!existsSync(TRAFIC_YAML)) {
      return;
    }

    const content = readFileSync(TRAFIC_YAML, "utf-8");
    const gatewayIp = getDockerGatewayIp();

    const updated = content.replace(
      /http:\/\/[\w.]+:9876/g,
      `http://${gatewayIp}:9876`,
    );

    if (updated === content) {
      return;
    }

    writeFileSync(TRAFIC_YAML, updated, "utf-8");
  },
};
