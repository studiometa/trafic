import { addDockerOriginToUnattendedUpgrades } from "../hardening.js";
import type { Migration } from "../types.js";

/**
 * Migration 0014: apply Docker Engine security updates unattended.
 *
 * `setup` wrote an `Unattended-Upgrade::Allowed-Origins` list covering only
 * Ubuntu's own release, security and ESM pockets. Docker Engine is installed
 * from download.docker.com, which is none of them, so `docker-ce` was never
 * upgraded unless someone ran `apt-get upgrade` by hand — a Docker security
 * release could sit unapplied on a server indefinitely. The Release file
 * served by that repository carries `Origin: Docker` and `Label: Docker CE`,
 * and its dist is the Ubuntu codename, so
 * `"origin=Docker,codename=${distro_codename}"` is the entry that matches it.
 *
 * DDEV, installed from pkg.ddev.com, is deliberately not added: a DDEV major
 * landing unattended can break running previews. DDEV is updated by
 * `trafic-agent upgrade` instead, when an operator is there to see it.
 *
 * `configureUnattendedUpgrades` now writes the Docker entry, which covers
 * fresh installs. Servers set up by an earlier release still carry the old
 * list, so this migration regenerates the file — Trafic generates and owns
 * it, as its header comment states.
 *
 * Idempotent: the helper does nothing when the file is missing (a server set
 * up without hardening) or already names the Docker origin. No service
 * restart is needed — unattended-upgrades reads the config on each daily run.
 */
export const migration0014UnattendedUpgradesDockerOrigin: Migration = {
  id: "0014__unattended_upgrades_docker_origin",
  description: "Allow unattended upgrades of Docker Engine",

  run(): void {
    addDockerOriginToUnattendedUpgrades();
  },
};
