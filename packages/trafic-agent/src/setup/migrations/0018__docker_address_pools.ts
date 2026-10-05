import { addDockerAddressPools } from "../docker.js";
import { nodeIo, type SetupIo } from "../io.js";
import type { Migration } from "../types.js";

/**
 * Migration 0018: give Docker enough address space for one network per
 * project.
 *
 * `setup` wrote a daemon.json without `default-address-pools`, so Docker
 * used its built-in pools: about 31 networks. Each DDEV project creates its
 * own `ddev-<name>_default` network, and a server with ~30 projects failed
 * to start the next one with "all predefined address pools have been fully
 * subnetted". The last 16 of those built-in networks are in 192.168.x,
 * outside the 172.16.0.0/12 range the firewall allows to reach the agent.
 *
 * `configureDocker` now writes /24 pools in 172.16.0.0/12, which covers
 * fresh installs. This migration adds them to existing servers.
 *
 * Docker reads the pools only at start, so the daemon is restarted.
 * `live-restore`, set by setup, keeps the running containers up. Existing
 * networks keep their subnets; only new networks get a /24, and Docker skips
 * subnets an existing network already uses.
 *
 * Idempotent: does nothing when the config already sets pools.
 */
export const migration0018DockerAddressPools: Migration = {
  id: "0018__docker_address_pools",
  description: "Give Docker address pools for one network per project",

  run(): void {
    runDockerAddressPoolsMigration();
  },
};

/**
 * The migration body, with its effects injected so tests can drive it.
 */
export function runDockerAddressPoolsMigration(io: SetupIo = nodeIo): void {
  if (addDockerAddressPools(io)) {
    io.exec("systemctl restart docker");
  }
}
