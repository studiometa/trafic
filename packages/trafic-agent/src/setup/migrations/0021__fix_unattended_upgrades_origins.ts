import { rewriteUnattendedUpgradesConfig } from "../hardening.js";
import type { Migration } from "../types.js";

/**
 * Migration 0021: let unattended-upgrades run again.
 *
 * Migration 0014 and `setup` put the Docker entry,
 * `"origin=Docker,codename=${distro_codename}"`, in
 * `Unattended-Upgrade::Allowed-Origins`. That key only takes `origin:archive`
 * pairs: unattended-upgrades splits each entry on `:`, or on white space, into
 * exactly two parts. The Docker entry has neither, so each daily run stopped
 * with "Unable to parse Unattended-Upgrade::Allowed-Origins" and installed
 * nothing — not even Ubuntu's security updates.
 *
 * The config now keeps the `origin:archive` pairs in `Allowed-Origins` and
 * moves the Docker entry to `Origins-Pattern`. It also adds Ubuntu's
 * `-updates` pocket and Node.js from NodeSource.
 *
 * Idempotent: the file is rewritten only when it exists, starts with the
 * Trafic header and differs from the expected content. No service restart is
 * needed — unattended-upgrades reads the config on each daily run.
 */
export const migration0021FixUnattendedUpgradesOrigins: Migration = {
  id: "0021__fix_unattended_upgrades_origins",
  description: "Fix the unattended-upgrades origins that stopped each run",

  run(): void {
    rewriteUnattendedUpgradesConfig();
  },
};
