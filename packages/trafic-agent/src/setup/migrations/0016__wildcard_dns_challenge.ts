import { info } from "../steps.js";
import {
  configureTraefik,
  findRunningProject,
  DNS_RESOLVER,
  ROUTER_COMPOSE_OVERRIDE,
  STATIC_CONFIG,
  TLS_STORE_CONFIG,
} from "../ddev.js";
import { nodeIo, type SetupIo } from "../io.js";
import { loadConfig } from "../../utils/config.js";
import type { Migration } from "../types.js";
import type { TlsConfig } from "../../types.js";

/**
 * Migration 0016: apply the wildcard DNS-01 certificate on servers that ask
 * for one in their config.
 *
 * `tls.dns_provider` is read by `configureTraefik`, which setup runs on a
 * fresh server. An existing server has the config but none of the files, so
 * this writes them: the resolver in `static_config.trafic.yaml`, the default
 * TLS store in `custom-global-config/0-trafic-tls.yaml`, and the provider
 * credentials in `router-compose.trafic.yaml`.
 *
 * Why the router is removed and a project started, rather than restarted
 * (the 0010 rationale, plus one more): Traefik reads its configuration from
 * the ddev-global-cache volume, and DDEV only copies `~/.ddev/traefik` into
 * that volume and merges `static_config.*.yaml` into `.static_config.yaml`
 * when a project starts. And DDEV 1.25 reads `router-compose.*.yaml` only
 * when it *recreates* the router: a running, healthy router just gets the
 * Traefik config pushed (StartDdevRouter, `needsRecreation`). Seen on a live
 * server — the static config was merged, the credentials never reached the
 * container. Removing the router first forces the recreation; `ddev start`
 * brings it back within seconds with the new environment.
 *
 * The container is found by its compose label, not by name: when compose
 * recreates a container it renames the old one `<id>_ddev-router`, and a
 * failed recreation can leave it that way. `docker restart ddev-router` then
 * silently does nothing — also seen on that server.
 *
 * Two details this depends on:
 * - Traefik's file provider keeps the FIRST `tls.stores.default` it reads in
 *   directory order and logs "TLS store default already configured,
 *   skipping" for the rest. DDEV writes an empty one in
 *   `default_config.yaml`, so the agent's file is named `0-trafic-tls.yaml`
 *   to sort ahead of it.
 * - DDEV keeps `certResolver: acme-tlsChallenge` on every project router, and
 *   that is fine: Traefik skips a per-host ACME request once the default
 *   store already holds a certificate matching the host with wildcard
 *   semantics. So `use_letsencrypt` stays true — the ACME account email comes
 *   from it — and the per-host quota use stops on its own.
 *
 * `ddev poweroff` is deliberately not used: the server runs live previews and
 * a project start is enough to regenerate the config and recreate the router.
 *
 * Idempotent: skipped when no DNS provider is configured, and when all three
 * files are already in place.
 */
export const migration0016WildcardDnsChallenge: Migration = {
  id: "0016__wildcard_dns_challenge",
  description: "Apply the wildcard DNS-01 certificate where one is configured",

  run(): void {
    runWildcardMigration();
  },
};

/**
 * The migration body, with its effects injected so tests can drive it.
 *
 * `tls` defaults to the server's own config: the migration runs after setup
 * wrote /etc/trafic/config.toml, so that file is the only source.
 */
export function runWildcardMigration(
  io: SetupIo = nodeIo,
  tls: TlsConfig = loadConfig().tls,
): void {
  if (!tls.dnsProvider) {
    // Per-host certificates stay as they are
    return;
  }

  const resolverConfigured =
    io.fileExists(STATIC_CONFIG) && io.readFile(STATIC_CONFIG).includes(`${DNS_RESOLVER}:`);

  if (
    resolverConfigured &&
    io.fileExists(TLS_STORE_CONFIG) &&
    io.fileExists(ROUTER_COMPOSE_OVERRIDE)
  ) {
    return;
  }

  configureTraefik({ tls }, io);

  const project = findRunningProject(io);

  if (!project) {
    info("No running project — the next deploy applies the wildcard certificate");
    return;
  }

  // A running router keeps its environment: DDEV only re-reads the compose
  // override when it recreates the container
  const router = findRouterContainer(io);

  if (router) {
    io.execSilent(`docker rm -f ${router}`);
  }

  // Regenerates .static_config.yaml and the router compose from the files
  // above, and recreates ddev-router with the provider credentials
  io.exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev start ${project}'`, {
    silent: true,
  });
}

/**
 * The ddev-router container id, whatever its current name.
 *
 * Compose labels survive the `<id>_ddev-router` rename a recreation leaves
 * behind; the container name does not.
 */
export function findRouterContainer(io: SetupIo = nodeIo): string | undefined {
  const id = io
    .execSilent("docker ps -aq --filter label=com.docker.compose.service=ddev-router")
    .trim();

  return id.split("\n")[0] || undefined;
}
