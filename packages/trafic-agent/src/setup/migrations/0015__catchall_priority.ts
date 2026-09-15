import { existsSync, readFileSync } from "node:fs";
import { exec, info } from "../steps.js";
import { configureTraefik, findRunningProject } from "../ddev.js";
import type { Migration } from "../types.js";

const DYNAMIC_CONFIG = "/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml";

/**
 * Migration 0015: raise the Trafic catch-all routers above DDEV's own.
 *
 * DDEV 1.25.4's router image adds two catch-all routers of its own in
 * `default_config.yaml` — `ddev-router-fallback-http` and
 * `ddev-router-fallback-https`, from the `traefik_global_config_template.yaml`
 * template in ddev/ddev. They carry the rule `PathPrefix(`/`)` at priority 1,
 * on every router entry point, and point at a socat responder that answers
 * 404. Trafic's own catch-all routers used priority 1 too.
 *
 * With equal priority and identical rules Traefik picked DDEV's, so a stopped
 * project answered DDEV's 404 page instead of the Trafic waiting page, and
 * scale-to-zero never restarted it — the waiting page is what triggers the
 * restart. Observed in the access log of a live server:
 * `"GET /rien-a-mettre.html HTTP/2.0" 404 ...
 * "http-443-ddev-router-fallback-https@file"`.
 *
 * `trafic-agent upgrade` installs DDEV 1.25.4, so every upgraded server is
 * affected. Priority 2 puts the Trafic routers back in front, and is still far
 * below any project router, so per-project routing and auth are unchanged.
 *
 * Traefik reads its config from the ddev-global-cache volume, and DDEV copies
 * `~/.ddev/traefik/custom-global-config/*.yaml` into it on any `ddev start` —
 * `PushGlobalTraefikConfig` runs even when the router is already up. Starting
 * one project that is already running is therefore enough to load the new
 * priority; `ddev poweroff` would stop every preview on the server for no
 * gain, so it is not used. When nothing runs, there is nothing to push to and
 * the next project start applies it.
 *
 * Unrelated and not addressed here: DDEV 1.25.4 also logs "Router count
 * mismatch" warnings, because its two fallback definitions attach to every
 * entry point while its health check counts definitions. That is DDEV's own
 * check against DDEV's own routers.
 *
 * Idempotent: skipped when the config is missing, and when no `priority: 1`
 * is left in it.
 */
export const migration0015CatchallPriority: Migration = {
  id: "0015__catchall_priority",
  description: "Raise the Traefik catch-all routers above DDEV's fallback routers",

  run(): void {
    if (!existsSync(DYNAMIC_CONFIG)) {
      return;
    }

    if (!readFileSync(DYNAMIC_CONFIG, "utf-8").includes("priority: 1")) {
      return;
    }

    // Rewrites both configs from the server's actual router ports
    configureTraefik();

    const project = findRunningProject();

    if (!project) {
      info("No project is running — the new priority applies on the next project start.");
      return;
    }

    exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev start ${project}'`, { silent: true });
  },
};
