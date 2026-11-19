import { execSilent } from "../steps.js";
import { purgeTraefikAcmeStorage } from "../ddev.js";
import type { Migration } from "../types.js";

/**
 * Migration 0011: drop Traefik's Let's Encrypt storage where it is disabled.
 *
 * `use_letsencrypt=false` stops DDEV asking for new certificates but leaves
 * the issued ones in acme.json inside the ddev-global-cache volume. Traefik
 * loads them again on restart, so a server that had Let's Encrypt on at some
 * point keeps serving those certificates from a port that is now only
 * reachable through a host ingress.
 *
 * That broke a live server: the ingress verifies the loopback hop against the
 * mkcert root, the resurrected Let's Encrypt certificate failed validation,
 * and every request answered 502 with "certificate signed by unknown
 * authority" until the storage was moved aside.
 *
 * Only runs where Let's Encrypt is off — with it on, those certificates are
 * the ones being served on purpose.
 *
 * Traefik holds the certificate in memory, so removing the file is not enough
 * on its own; the router is restarted. Restarting the router is safe here
 * because no config needs re-copying from the host — unlike a config change,
 * which needs a project start.
 */
export const migration0011PurgeAcmeWhenDisabled: Migration = {
  id: "0011__purge_acme_when_disabled",
  description: "Remove Traefik's Let's Encrypt storage when it is disabled",

  run(): void {
    const globalConfig = execSilent("su - ddev -c 'ddev config global'");

    if (!/^use-letsencrypt=false$/m.test(globalConfig)) {
      // Enabled, or the config could not be read — leave the certificates be
      return;
    }

    if (!purgeTraefikAcmeStorage()) {
      return;
    }

    // The running Traefik still holds what it loaded at startup
    execSilent("docker restart ddev-router");
  },
};
