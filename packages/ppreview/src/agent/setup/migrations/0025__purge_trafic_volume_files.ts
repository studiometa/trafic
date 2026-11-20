import { nodeIo, type SetupIo } from "../io.js";
import { info } from "../steps.js";
import type { Migration } from "../types.js";

const GLOBAL_CACHE_VOLUME = "ddev-global-cache";

/**
 * Migration 0025: remove the Trafic copies of the Traefik files from the
 * ddev-global-cache volume.
 *
 * Traefik reads its config from the ddev-global-cache volume, and DDEV copies
 * ~/.ddev/traefik into it when a project starts. DDEV only adds and replaces
 * files there: it never removes one. Migration 0024 removed the Trafic files
 * from ~/.ddev/traefik, but their copies stayed in the volume, so Traefik
 * kept loading the `trafic-*` middlewares and routers next to the
 * `ppreview-*` ones. On a preprod server this blocked the router until the
 * copies were removed by hand.
 *
 * Traefik watches the config directory, but it reads the static config only
 * at startup, so the router restarts when a file was removed. No config needs
 * a copy from the host, so a restart is enough (see migration 0011). The
 * previews are down for the few seconds the router takes to come back.
 *
 * Idempotent: on a server without the old files it does nothing.
 */
export const migration0025PurgeTraficVolumeFiles: Migration = {
  id: "0025__purge_trafic_volume_files",
  description: "Remove the Trafic Traefik files from the ddev-global-cache volume",

  run(): void {
    purgeTraficVolumeFiles();
  },
};

/**
 * Remove the `*trafic*` files of Traefik from the volume. Returns whether it
 * removed any.
 *
 * The volume's mountpoint is resolved on the host, as for the ACME storage:
 * the router container may be down.
 */
export function purgeTraficVolumeFiles(io: SetupIo = nodeIo): boolean {
  const mountpoint = io
    .execSilent(`docker volume inspect ${GLOBAL_CACHE_VOLUME} --format '{{.Mountpoint}}'`)
    .trim();

  if (!mountpoint) {
    return false;
  }

  const traefik = `${mountpoint}/traefik`;
  const found = io
    .execSilent(`ls -d ${traefik}/*trafic* ${traefik}/config/*trafic* 2>/dev/null`)
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);

  if (found.length === 0) {
    return false;
  }

  io.exec(`rm -f ${found.join(" ")}`, { silent: true });
  info(`Removed from the ${GLOBAL_CACHE_VOLUME} volume: ${found.join(", ")}`);

  // Fails when the router does not run: it reads the volume when it starts
  io.execSilent("docker restart ddev-router");

  return true;
}
