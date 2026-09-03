import { existsSync, readFileSync } from "node:fs";
import { exec } from "../steps.js";
import { configureTraefik } from "../ddev.js";
import type { Migration } from "../types.js";

const DYNAMIC_CONFIG =
  "/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml";

/** The copy setup used to write for DDEV versions that watched the root. */
const STALE_CONFIG = "/home/ddev/.ddev/traefik/trafic.yaml";

/**
 * Migration 0010: pin the catch-all routers to their entry points.
 *
 * The routers added by 0009 named no entry point, so Traefik instantiated
 * each on every one. DDEV's router health check counts router *definitions*
 * across its config files and compares that to what Traefik reports, so two
 * definitions showing up as fourteen instances never matched. The check waited
 * out its timeout and `ddev start` failed after 60 seconds — on every server
 * setup produces, because setup configures the tool entry points.
 *
 * Observed on a live server: 37 routers loaded against 22 expected, health
 * still "starting" after 91s. With the routers pinned: 23 loaded, healthy
 * immediately.
 *
 * Traefik reads its config from the ddev-global-cache volume and DDEV only
 * copies `~/.ddev/traefik` into it when a project starts, so this restarts
 * DDEV rather than the router alone.
 *
 * Idempotent: skipped once the config names entry points.
 */
export const migration0010CatchallEntrypoints: Migration = {
  id: "0010__catchall_entrypoints",
  description: "Pin the Traefik catch-all routers to their entry points",

  run(): void {
    const pinned =
      existsSync(DYNAMIC_CONFIG) &&
      readFileSync(DYNAMIC_CONFIG, "utf-8").includes("entryPoints:");

    if (pinned && !existsSync(STALE_CONFIG)) {
      return;
    }

    if (!pinned) {
      // Rewrites both configs from the server's actual router ports
      configureTraefik();
    }

    // Nothing reads this on DDEV 1.25, and leaving it behind means two
    // sources of truth for anyone debugging the router
    if (existsSync(STALE_CONFIG)) {
      exec(`rm -f ${STALE_CONFIG}`, { silent: true });
    }

    if (!pinned) {
      exec(
        "su - ddev -c 'DDEV_NONINTERACTIVE=true ddev poweroff && ddev start --all'",
        { silent: true },
      );
    }
  },
};
