import {
  ROUTER_COMPOSE_OVERRIDE,
  STATIC_CONFIG,
  writeRouterComposeOverride,
} from "../ddev.js";
import { nodeIo, type SetupIo } from "../io.js";
import { loadConfig } from "../../utils/config.js";
import type { Migration } from "../types.js";
import type { TlsConfig } from "../../types.js";
import { findRouterContainer } from "./0016__wildcard_dns_challenge.js";

/** The line that gives ddev-router its restart policy in the override. */
const RESTART_POLICY = "restart: unless-stopped";

/**
 * Migration 0023: make Docker start ddev-router again after a reboot.
 *
 * DDEV's router compose template sets `restart: "no"`. After a reboot the
 * agent came back (systemd restarts it) but the router did not, so no
 * request reached the agent and the waiting page could not start any
 * project: the previews stayed down until someone ran `ddev start` over SSH.
 * Seen on a preprod server after a soft reboot.
 *
 * The router compose override now carries `restart: unless-stopped` on every
 * server, so the next time DDEV recreates the router it gets the policy.
 * Before, the override existed only where a DNS provider was configured.
 * This writes it again, with the credentials of `[tls]` when there are any.
 *
 * DDEV reads the override only when it recreates the router, so the running
 * router gets the same policy with `docker update`. That changes the policy
 * of the container in place: nothing restarts, no preview goes down.
 *
 * Runs only on a server with DDEV and the Trafic Traefik config: a server set
 * up with `--no-ddev` has no router. Idempotent: skipped when the override
 * already has the policy.
 */
export const migration0023RouterRestartPolicy: Migration = {
  id: "0023__router_restart_policy",
  description: "Make Docker start ddev-router again after a reboot",

  run(): void {
    runRouterRestartPolicyMigration();
  },
};

/**
 * The migration body, with its effects injected so tests can drive it.
 *
 * `tls` defaults to the server's own config, as in migration 0016: the
 * credentials must stay in the override when a DNS provider is configured.
 */
export function runRouterRestartPolicyMigration(
  io: SetupIo = nodeIo,
  tls: () => TlsConfig = () => loadConfig().tls,
): void {
  if (!io.fileExists(STATIC_CONFIG)) {
    return;
  }

  if (
    io.fileExists(ROUTER_COMPOSE_OVERRIDE) &&
    io.readFile(ROUTER_COMPOSE_OVERRIDE).includes(RESTART_POLICY)
  ) {
    return;
  }

  const config = tls();

  writeRouterComposeOverride(config.dnsProvider ? config.dnsEnv : {}, io);

  const router = findRouterContainer(io);

  if (router) {
    io.execSilent(`docker update --restart unless-stopped ${router}`);
  }
}
