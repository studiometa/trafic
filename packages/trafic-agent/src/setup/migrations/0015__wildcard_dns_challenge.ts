import { existsSync, readFileSync } from "node:fs";
import { exec, execSilent, info } from "../steps.js";
import {
  configureTraefik,
  DNS_RESOLVER,
  ROUTER_COMPOSE_OVERRIDE,
  TLS_STORE_CONFIG,
  TRAEFIK_DIR,
} from "../ddev.js";
import { loadConfig } from "../../utils/config.js";
import type { Migration } from "../types.js";

const STATIC_CONFIG = `${TRAEFIK_DIR}/static_config.trafic.yaml`;

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
 * Why a project start rather than a router restart alone (the 0010
 * rationale): Traefik reads its configuration from the ddev-global-cache
 * volume, and DDEV only copies `~/.ddev/traefik` into that volume — and only
 * merges `static_config.*.yaml` into `.static_config.yaml`, and
 * `router-compose.*.yaml` into the router compose — when a project starts. A
 * `docker restart ddev-router` alone would reload the old files.
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

    // Regenerates .static_config.yaml and the router compose from the files
    // above, and recreates ddev-router with the provider credentials
    exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev start ${project}'`, {
      silent: true,
    });

    // The router that comes back reads the new static config; restart it so
    // the resolver is picked up even when DDEV reused the container
    execSilent("docker restart ddev-router");
  },
};

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
