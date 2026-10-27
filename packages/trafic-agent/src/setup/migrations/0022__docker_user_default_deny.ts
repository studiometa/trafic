import { readRouterPorts } from "../ddev.js";
import { configureDockerFirewall, DOCKER_FIREWALL_SCRIPT } from "../docker-firewall.js";
import { nodeIo, type SetupIo } from "../io.js";
import type { Migration } from "../types.js";

/**
 * Migration 0022: close every Docker-published port that has no forward auth.
 *
 * The script that 0012 installed dropped a fixed list of ports: DDEV's tool
 * ports. A DDEV add-on that sets `HTTP_EXPOSE` or `HTTPS_EXPOSE`
 * (Elasticsearch on 9200/9201, Tika, Solr…) makes ddev-router publish one
 * more port, with a Traefik entry point that has no forward auth. That port
 * was not in the list, so it answered the internet with no authentication.
 *
 * The new script allows only the ports with forward auth — the router's HTTP
 * and HTTPS ports, and the tool ports whose entry point carries
 * `trafic-auth@file` in the static config — and drops every other forwarded
 * port from outside Docker's networks. Mailpit and xhgui are now reachable
 * from outside, behind forward auth; before, they were dropped.
 *
 * It also removes the per-port rules of the old script, the ports an
 * operator added to its `PORTS` by hand included, so the hand fix is
 * replaced, not stacked.
 *
 * Runs only where the old script exists: a server set up with `--no-ddev`
 * has no DDEV router and no script. Idempotent: the script rebuilds its own
 * chain on each run, and writing it again gives the same file.
 */
export const migration0022DockerUserDefaultDeny: Migration = {
  id: "0022__docker_user_default_deny",
  description: "Close every Docker-published port that has no forward auth",

  run(): void {
    runDockerUserDefaultDenyMigration();
  },
};

/** The migration body, with its effects injected so tests can drive it. */
export function runDockerUserDefaultDenyMigration(io: SetupIo = nodeIo): void {
  if (!io.fileExists(DOCKER_FIREWALL_SCRIPT)) {
    return;
  }

  configureDockerFirewall(readRouterPorts(io), io);
}
