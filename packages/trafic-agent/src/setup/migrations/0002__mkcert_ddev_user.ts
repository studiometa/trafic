import { existsSync } from "node:fs";
import { exec } from "../steps.js";
import type { Migration } from "../types.js";

/**
 * Migration 0002: Install mkcert CA in the ddev user trust store.
 *
 * Previously, `mkcert -install` was called as root without overriding HOME,
 * so the CA was stored under ~root/.local/share/mkcert. DDEV runs as the
 * `ddev` user and looks for the CA in its own home directory — so it never
 * found it, reporting mkcert as not installed.
 *
 * Fix: run `mkcert -install` with HOME=/home/ddev so the CA lands in the
 * ddev user trust store, then chown the directory to ddev:ddev.
 *
 * Condition: skip if /home/ddev/.local/share/mkcert already exists,
 * which means the CA is already installed for the ddev user.
 */
export const migration0002MkcertDdevUser: Migration = {
  id: "0002__mkcert_ddev_user",
  description: "Install mkcert CA in the ddev user trust store",

  run(): void {
    // Already installed for the ddev user — nothing to do
    if (existsSync("/home/ddev/.local/share/mkcert")) {
      return;
    }

    exec("HOME=/home/ddev mkcert -install", { silent: true });
    exec("chown -R ddev:ddev /home/ddev/.local/share/mkcert", { silent: true });
  },
};
