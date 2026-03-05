import { existsSync } from "node:fs";
import { exec } from "../steps.js";
import { addDdevAptRepo } from "../ddev.js";
import type { Migration } from "../types.js";

/**
 * Migration 0001: Migrate DDEV from manual tarball to apt repository.
 *
 * Old installs downloaded a tarball from GitHub releases. This migration
 * removes the manually-installed binaries and reinstalls DDEV via the
 * official apt repository so future updates are handled by apt.
 *
 * Condition: skip if /etc/apt/sources.list.d/ddev.list already exists,
 * which means the apt repository is already configured.
 */
export const migration0001DdevAptRepo: Migration = {
  id: "0001__ddev_apt_repo",
  description: "Migrate DDEV from manual tarball to apt repository",

  run(): void {
    // Already using the apt repository — nothing to do
    if (existsSync("/etc/apt/sources.list.d/ddev.list")) {
      return;
    }

    // 1. Remove manually-installed DDEV binaries
    exec("rm -f /usr/local/bin/ddev /usr/local/bin/ddev-hostname /usr/local/bin/mkcert", {
      silent: true,
    });

    // 2. Add the official DDEV apt repository
    addDdevAptRepo();

    // 3. Install DDEV via apt
    exec("apt-get update -qq", { silent: true });
    exec("DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y ddev", {
      silent: true,
    });

    // 4. Re-install mkcert CA (mkcert is now bundled with DDEV via apt)
    exec("mkcert -install", { silent: true });
  },
};
