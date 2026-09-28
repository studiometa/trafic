import { addDdevAptRepo, DDEV_SOURCES } from "../ddev.js";
import { nodeIo, type SetupIo } from "../io.js";
import type { Migration } from "../types.js";

/** The Gemfury source file setup wrote before this release. */
const OLD_SOURCES = "/etc/apt/sources.list.d/ddev.list";

/** The dearmoured keyring that source was signed by. */
const OLD_KEYRING = "/etc/apt/keyrings/ddev.gpg";

/**
 * Migration 0017: move the DDEV apt repository from Gemfury to Cloudsmith.
 *
 * DDEV 1.25.4 moved its Debian and RPM packages to Cloudsmith
 * (ddev/ddev#8698) and its install docs now name
 * `https://packages.ddev.com/public/deb/ubuntu` with the key at
 * `https://packages.ddev.com/public/gpg.key`. The former Gemfury host,
 * `pkg.ddev.com`, still receives packages and DDEV has announced no
 * retirement date, so nothing is broken today — but a server left on the old
 * repository would stop seeing new DDEV releases the day it is switched off,
 * and `trafic-agent upgrade` runs `apt-get install --only-upgrade ddev`
 * against whatever repository is configured.
 *
 * The old files are removed rather than left alongside the new ones, as
 * DDEV's own instructions do: two sources offering the same package make apt
 * pick by version and would leave the Gemfury host in the picture for as
 * long as it answers. `setup` writes only the Cloudsmith source, so a fresh
 * server and an upgraded one end up identical.
 *
 * Idempotent: skipped once the Cloudsmith source file is in place, and each
 * removal is guarded by the file's existence.
 */
export const migration0017DdevAptCloudsmith: Migration = {
  id: "0017__ddev_apt_cloudsmith",
  description: "Move the DDEV apt repository from Gemfury to Cloudsmith",

  run(): void {
    runDdevAptCloudsmithMigration();
  },
};

/** The migration body, with its effects injected so tests can drive it. */
export function runDdevAptCloudsmithMigration(io: SetupIo = nodeIo): void {
  if (io.fileExists(DDEV_SOURCES)) {
    // Already on Cloudsmith
    return;
  }

  if (io.fileExists(OLD_SOURCES)) {
    io.exec(`rm -f ${OLD_SOURCES}`, { silent: true });
  }

  if (io.fileExists(OLD_KEYRING)) {
    io.exec(`rm -f ${OLD_KEYRING}`, { silent: true });
  }

  addDdevAptRepo(io);

  // So the next apt-get install --only-upgrade ddev sees the new repository
  io.exec("apt-get update -qq", { silent: true });
}
