import { existsSync, readFileSync } from "node:fs";
import { exec } from "../steps.js";
import { configureTraefik } from "../ddev.js";
import { createSystemdService } from "../agent.js";
import type { Migration } from "../types.js";

const UNIT_PATH = "/etc/systemd/system/trafic-agent.service";
const DYNAMIC_CONFIG = "/home/ddev/.ddev/traefik/trafic.yaml";

/**
 * Migration 0009: Make scale-to-zero actually work.
 *
 * Two independent faults meant a stopped project never came back.
 *
 * The waiting page never appeared. `ddev stop` removes the project's router,
 * so no router matches and Traefik answers 404 — and entry point middlewares
 * do not run without a router match, so `trafic-errors` (which only lists 502
 * and 503) never saw it. Migration 0008 removed the catch-all router to fix an
 * auth bypass, which was right, but it also removed the only thing catching
 * these requests. A catch-all at priority 1 is safe now that auth lives on the
 * entry point: a project router always outranks it.
 *
 * Auto-start could not have worked either. The unit set
 * `ReadWritePaths=/var/lib/trafic /home/ddev/.ddev`, but `ddev start` writes
 * to /home/ddev/www/<project>/.ddev/.webimageBuild and to buildx state in
 * /home/ddev/.docker, both of which ProtectHome=read-only refused.
 *
 * Rewrites both the Traefik config and the systemd unit. Idempotent: skipped
 * once the catch-all is present and the unit grants the home.
 */
export const migration0009ScaleToZeroFixes: Migration = {
  id: "0009__scale_to_zero_fixes",
  description: "Fix scale-to-zero: waiting page router and agent write access",

  run(): void {
    const unitNeedsWrite =
      !existsSync(UNIT_PATH) ||
      !/^ReadWritePaths=.*\/home\/ddev(\s|$)/m.test(
        readFileSync(UNIT_PATH, "utf-8"),
      );

    const configNeedsCatchall =
      !existsSync(DYNAMIC_CONFIG) ||
      !readFileSync(DYNAMIC_CONFIG, "utf-8").includes("trafic-catchall");

    if (configNeedsCatchall) {
      // Rewrites both dynamic config copies and the static config, and
      // recomputes the gateway IP while it is there
      configureTraefik();

      // Traefik reads its config from the ddev-global-cache volume, and DDEV
      // only copies ~/.ddev/traefik into it when a project starts. Restarting
      // the router alone leaves the old config in place.
      exec("su - ddev -c 'DDEV_NONINTERACTIVE=true ddev poweroff && ddev start --all'", {
        silent: true,
      });
    }

    if (unitNeedsWrite) {
      // Rewrites the unit with the corrected ReadWritePaths, then reloads and
      // restarts the agent
      createSystemdService();
    }
  },
};
