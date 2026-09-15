import { existsSync, readFileSync } from "node:fs";
import { exec, execSilent, info } from "../steps.js";
import {
  configureTraefik,
  DNS_RESOLVER,
  ROUTER_COMPOSE_OVERRIDE,
  STATIC_CONFIG,
  TLS_STORE_CONFIG,
} from "../ddev.js";
import { loadConfig } from "../../utils/config.js";
import type { Migration } from "../types.js";

/**
 * Migration 0015: apply the wildcard DNS-01 certificate on servers that ask
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
export const migration0015WildcardDnsChallenge: Migration = {
  id: "0015__wildcard_dns_challenge",
  description: "Apply the wildcard DNS-01 certificate where one is configured",

  run(): void {
    const { tls } = loadConfig();

    if (!tls.dnsProvider) {
      // Per-host certificates stay as they are
      return;
    }

    const resolverConfigured =
      existsSync(STATIC_CONFIG) &&
      readFileSync(STATIC_CONFIG, "utf-8").includes(`${DNS_RESOLVER}:`);

    if (
      resolverConfigured &&
      existsSync(TLS_STORE_CONFIG) &&
      existsSync(ROUTER_COMPOSE_OVERRIDE)
    ) {
      return;
    }

    configureTraefik({ tls });

    const project = findRunningProject();

    if (!project) {
      info("No running project — the next deploy applies the wildcard certificate");
      return;
    }

    // A running router keeps its environment: DDEV only re-reads the compose
    // override when it recreates the container
    const router = findRouterContainer();

    if (router) {
      execSilent(`docker rm -f ${router}`);
    }

    // Regenerates .static_config.yaml and the router compose from the files
    // above, and recreates ddev-router with the provider credentials
    exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev start ${project}'`, {
      silent: true,
    });
  },
};

/**
 * The ddev-router container id, whatever its current name.
 *
 * Compose labels survive the `<id>_ddev-router` rename a recreation leaves
 * behind; the container name does not.
 */
export function findRouterContainer(): string | undefined {
  const id = execSilent(
    "docker ps -aq --filter label=com.docker.compose.service=ddev-router",
  ).trim();

  return id.split("\n")[0] || undefined;
}

/**
 * Name one running DDEV project, or undefined when none is running.
 *
 * `ddev list -j` is the only source that reports a live status —
 * project_list.yaml records where a project lives, not whether it runs. A
 * stopped project is never started here: waking a scaled-to-zero preview is
 * not this migration's business.
 */
function findRunningProject(): string | undefined {
  const json = execSilent("su - ddev -c 'ddev list -j'");

  if (!json) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(json) as {
      raw?: Array<{ name?: string; status?: string }>;
    };

    return parsed.raw?.find((project) => project.status === "running")?.name;
  } catch {
    return undefined;
  }
}
