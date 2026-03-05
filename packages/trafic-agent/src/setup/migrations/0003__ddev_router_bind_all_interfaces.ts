import { exec } from "../steps.js";
import type { Migration } from "../types.js";

/**
 * Migration 0003: Enable router_bind_all_interfaces in DDEV global config.
 *
 * The initial setup did not set --router-bind-all-interfaces=true, which
 * caused ddev-router to bind only on 127.0.0.1. External traffic (including
 * Cloudflare proxying) could not reach the router, resulting in 521 errors.
 *
 * This migration enables the flag and restarts the DDEV router so the change
 * takes effect immediately.
 *
 * Idempotent: ddev config global is safe to re-run with the same value.
 */
export const migration0003DdevRouterBindAllInterfaces: Migration = {
  id: "0003__ddev_router_bind_all_interfaces",
  description: "Bind ddev-router on all interfaces (fix 521 for external traffic)",

  run(): void {
    exec("su - ddev -c 'ddev config global --router-bind-all-interfaces=true'", { silent: true });
    // Restart all running projects so the router picks up the new bind setting
    exec("su - ddev -c 'ddev poweroff'", { silent: true });
    exec("su - ddev -c 'ddev start --all'", { silent: true });
  },
};
