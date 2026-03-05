import { existsSync } from "node:fs";
import { configureDdevSudoers } from "../user.js";
import type { Migration } from "../types.js";

/**
 * Migration 0004: Allow ddev user to run ddev-hostname without a password.
 *
 * ddev-hostname manages /etc/hosts entries and always calls sudo internally,
 * even when DDEV_NONINTERACTIVE=true. Without this sudoers rule, any ddev
 * command that touches hostname resolution (start, restart, poweroff + start)
 * fails with "sudo: a terminal is required to read the password".
 *
 * Condition: skip if /etc/sudoers.d/trafic-ddev already exists.
 */
export const migration0004DdevHostnameSudoers: Migration = {
  id: "0004__ddev_hostname_sudoers",
  description: "Allow ddev user to run ddev-hostname without a password",

  run(): void {
    if (existsSync("/etc/sudoers.d/trafic-ddev")) {
      return;
    }

    configureDdevSudoers();
  },
};
