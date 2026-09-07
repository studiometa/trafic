import { existsSync } from "node:fs";
import { configureDockerFirewall, DOCKER_FIREWALL_SCRIPT } from "../docker-firewall.js";
import { readToolPorts } from "../ddev.js";
import type { Migration } from "../types.js";

/**
 * Migration 0012: restrict the Docker-published DDEV tool ports.
 *
 * `ufw default deny incoming` never applied to them. Docker's DNAT sits in
 * `nat/PREROUTING` and its filtering in the `DOCKER` chain of `FORWARD`, both
 * evaluated before UFW's chains, so the ports ddev-router publishes for
 * Mailpit and xhgui have been reachable on every server regardless of what
 * `ufw status` showed.
 *
 * Forward auth answers those requests with a 401, so this was never an open
 * door — but it is a single control, and it was silently missing from those
 * exact entry points until 0.1.30, which is how xhgui came to answer the
 * internet unauthenticated.
 *
 * A provider firewall does not close it either. Measured on an OVH server
 * with the Edge Firewall enabled and denying these ports: a connection from
 * another host inside OVH still completed in 114ms, while a port with nothing
 * listening was dropped and timed out at 12s. Anyone able to rent a VM from
 * the same provider sits inside that blind spot.
 *
 * Idempotent: skipped once the script is installed. The script itself removes
 * any previous copy of each rule before inserting it, so reapplying is safe.
 */
export const migration0012DockerUserToolPorts: Migration = {
  id: "0012__docker_user_tool_ports",
  description: "Restrict Docker-published DDEV tool ports via DOCKER-USER",

  run(): void {
    if (existsSync(DOCKER_FIREWALL_SCRIPT)) {
      return;
    }

    configureDockerFirewall(readToolPorts());
  },
};
