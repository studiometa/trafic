import { readAuthenticatedPorts, type RouterPorts } from "./ddev.js";
import { nodeIo, type SetupIo } from "./io.js";
import { step, success, info } from "./steps.js";

/** Where the rule script lives, so systemd and a human can both run it. */
export const DOCKER_FIREWALL_SCRIPT = "/usr/local/sbin/trafic-docker-firewall";

/** The unit that reapplies the rules after Docker starts. */
export const DOCKER_FIREWALL_UNIT =
  "/etc/systemd/system/trafic-docker-firewall.service";

/** The chain that holds the rules. DOCKER-USER only jumps to it. */
export const DOCKER_FIREWALL_CHAIN = "TRAFIC-DOCKER-USER";

/**
 * Docker's own bridge ranges, exempted so containers and the host gateway can
 * still reach a published port. Containers normally talk to each other by
 * container address rather than through the published port, so this is a
 * safety valve rather than a requirement.
 */
const DOCKER_IPV4_NETS = "172.16.0.0/12";
const DOCKER_IPV6_NETS = "fd00::/8";

/**
 * The rules of the script before this version: one DROP per port, and one
 * RETURN per port for Docker's networks, put directly in DOCKER-USER. Matched
 * by shape, not by port, so the ports an operator added to `PORTS` by hand
 * are removed too.
 */
const LEGACY_RULE =
  "^-A DOCKER-USER (-s [0-9a-f.:/]+ )?-p tcp -m conntrack --ctorigdstport [0-9]+ --ctdir ORIGINAL -j (DROP|RETURN)$";

/**
 * Build the script that closes every port Docker publishes, except the ports
 * with forward auth, to traffic from outside Docker's networks.
 *
 * Why close by default. A DDEV add-on that sets `HTTP_EXPOSE` or
 * `HTTPS_EXPOSE` (Elasticsearch, Tika, Solr, OpenSearch, Adminer…) makes
 * ddev-router publish one more port on 0.0.0.0, with a Traefik entry point
 * that has no forward auth. A list of ports to drop cannot know these ports
 * in advance, so the list is reversed: only the ports with forward auth are
 * allowed — the router's web ports and DDEV's tool ports (Mailpit, xhgui) —
 * and every other forwarded port is dropped.
 *
 * A port in `toolPorts` is reachable from the internet, and only forward
 * auth protects it. configureDockerFirewall takes them from
 * `readAuthenticatedPorts()` for that reason.
 *
 * Why the network layer and not Traefik. Each add-on adds its own entry point
 * when it starts, and Traefik's static config is read only when the router
 * starts. Forward auth on those entry points would need the agent to follow
 * every add-on. A drop rule needs to know nothing about them.
 *
 * Why UFW cannot do it. Docker puts its DNAT in `nat/PREROUTING` and its
 * filtering in the `DOCKER` chain of `FORWARD`, both evaluated before UFW's
 * chains, so `ufw default deny incoming` never sees these packets.
 * `DOCKER-USER` is the hook Docker provides for this case: it is jumped to
 * first in `FORWARD` and Docker never flushes it.
 *
 * What the rules match, and why it is safe:
 *
 * - Only packets Docker has DNAT'd (`--ctstate DNAT`), that is, packets sent
 *   to a published port. Traffic between containers, outbound traffic from
 *   containers and its replies are not DNAT'd, so they pass.
 * - Only the original direction (`--ctdir ORIGINAL`), so the replies of an
 *   allowed connection are never dropped.
 * - Not from Docker's own networks, so a container can still reach a
 *   published port through the host.
 * - The allowed ports are matched on the *original* destination port
 *   (`--ctorigdstport`). In `FORWARD`, the destination is already the
 *   container, so `--dport` would match the container's side of the mapping.
 *
 * The rules do not target the router by address: its container address
 * changes each time DDEV recreates it, and the script runs when Docker
 * starts, before the router exists. So they apply to every published port.
 * On a Trafic server that is the intent. Only ddev-router publishes on
 * 0.0.0.0 (`router_bind_all_interfaces`). DDEV binds the web, db and xhgui
 * host ports of a project to 127.0.0.1, unless the project sets
 * `bind_all_interfaces`; then these ports are closed too, which is correct,
 * because they skip forward auth. A port bound to 127.0.0.1 never goes
 * through `FORWARD`: a connection from the host is local traffic (`OUTPUT`,
 * or Docker's userland proxy), and a packet from outside to 127.0.0.1 is
 * dropped as a martian. So Traefik's monitor port (10999, on 127.0.0.1) and
 * SSH tunnels to a published port work as before.
 *
 * The ports are written into the script. When DDEV substitutes a router port
 * because 80 or 443 is busy (30000-32000 since DDEV 1.25.5), the substitute
 * port is dropped: the rules fail closed. Run `setup` again after a change of
 * a router or tool port in DDEV's global config.
 *
 * The rules live in their own chain, flushed and rebuilt on each run, with
 * one jump at the top of DOCKER-USER. So a second run gives the same rules,
 * and a removed port does not stay allowed. The script also removes the
 * per-port rules of its previous version, ports added by hand included.
 *
 * A network-edge firewall is not a substitute. Measured on an OVH server with
 * its Edge Firewall enabled and a correct deny-all rule: a published tool port
 * still accepted a connection from another host inside OVH in 114ms, while a
 * port with nothing listening was dropped and timed out at 12s. These rules
 * apply to every packet regardless of where it came from.
 */
export function buildDockerFirewallScript(
  routerPorts: RouterPorts,
  toolPorts: string[],
): string {
  const allowed = [...new Set([routerPorts.http, routerPorts.https, ...toolPorts])];

  return `#!/bin/sh
# Trafic: close every port Docker publishes, except the ports with forward
# auth (ddev-router's web ports, DDEV's tools), to traffic from outside
# Docker's networks.
#
# Generated by trafic-agent setup. Reapplied at boot by
# trafic-docker-firewall.service, because Docker recreates DOCKER-USER empty
# and nothing else restores what we put there.
#
# Why close by default: a DDEV add-on with HTTP_EXPOSE or HTTPS_EXPOSE
# (Elasticsearch, Solr, Tika...) makes ddev-router publish one more port, with
# no forward auth. Its number is not known in advance, so only the ports with
# forward auth are allowed and every other forwarded port is dropped.
#
# Why not UFW: Docker's DNAT sits in nat/PREROUTING and its filtering in the
# DOCKER chain of FORWARD, both evaluated before UFW's chains, so
# "ufw default deny incoming" never sees these packets. DOCKER-USER is the
# hook Docker provides — jumped to first in FORWARD, never flushed by Docker.
#
# Only DNAT'd packets (sent to a published port) in the original direction
# are dropped: traffic between containers, outbound traffic and replies pass.
# Ports bound to 127.0.0.1 never go through FORWARD, so SSH tunnels work.
#
# The match is on the ORIGINAL destination port: after DNAT the destination is
# the container, so --dport would match the wrong side of the mapping.
set -eu

CHAIN="${DOCKER_FIREWALL_CHAIN}"
ALLOWED_PORTS="${allowed.join(" ")}"

apply() {
  cmd="$1"
  nets="$2"

  command -v "$cmd" >/dev/null 2>&1 || return 0

  # Docker creates DOCKER-USER for each family it filters. Without it, there
  # is no forwarded path to close for that family.
  "$cmd" -n -L DOCKER-USER >/dev/null 2>&1 || return 0

  # Remove the per-port rules of the previous version of this script,
  # including the ports added to its PORTS by hand
  "$cmd" -S DOCKER-USER \\
    | grep -E -- '${LEGACY_RULE}' \\
    | while read -r rule; do
        # Word splitting is intended: the pattern above allows no quotes
        # shellcheck disable=SC2086
        "$cmd" -D DOCKER-USER \${rule#-A DOCKER-USER }
      done

  # Rebuild our chain from scratch, so a second run gives the same rules
  "$cmd" -N "$CHAIN" 2>/dev/null || true
  "$cmd" -F "$CHAIN"

  # Docker's own networks keep their access
  "$cmd" -A "$CHAIN" -s "$nets" -j RETURN

  # The router's web ports and DDEV's tool ports: forward auth applies
  for port in $ALLOWED_PORTS; do
    "$cmd" -A "$CHAIN" -p tcp -m conntrack --ctorigdstport "$port" -j RETURN
  done

  # Every other published port, add-on ports included
  "$cmd" -A "$CHAIN" -m conntrack --ctstate DNAT --ctdir ORIGINAL -j DROP

  # Exactly one jump, at the top of DOCKER-USER
  while "$cmd" -C DOCKER-USER -j "$CHAIN" 2>/dev/null; do
    "$cmd" -D DOCKER-USER -j "$CHAIN"
  done
  "$cmd" -I DOCKER-USER -j "$CHAIN"
}

apply iptables ${DOCKER_IPV4_NETS}
apply ip6tables ${DOCKER_IPV6_NETS}
`;
}

/** The systemd unit that reapplies the rules after Docker starts. */
export function buildDockerFirewallUnit(): string {
  return `[Unit]
Description=Trafic - close Docker-published ports that have no forward auth
# Docker recreates DOCKER-USER empty on start, so the rules have to go back
# afterwards. PartOf means a docker restart reapplies them too.
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${DOCKER_FIREWALL_SCRIPT}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Install the DOCKER-USER rules and apply them now.
 *
 * The tool ports are read from the Traefik static config on disk, not passed
 * in: the firewall opens a tool port only when its entry point carries
 * `trafic-auth@file`, so the two lists cannot differ. Call this after
 * configureTraefik.
 *
 * The unit is restarted rather than started: it is a oneshot that stays
 * active, so `enable --now` on a server that already has it would not run
 * the new script.
 */
export function configureDockerFirewall(
  routerPorts: RouterPorts,
  io: SetupIo = nodeIo,
): void {
  step("Close Docker-published ports that have no forward auth");

  const web = [routerPorts.http, routerPorts.https];
  const toolPorts = readAuthenticatedPorts(io).filter((port) => !web.includes(port));

  io.writeFile(DOCKER_FIREWALL_SCRIPT, buildDockerFirewallScript(routerPorts, toolPorts));
  io.exec(`chmod 0755 ${DOCKER_FIREWALL_SCRIPT}`, { silent: true });

  io.writeFile(DOCKER_FIREWALL_UNIT, buildDockerFirewallUnit());
  io.exec("systemctl daemon-reload", { silent: true });
  io.exec("systemctl enable trafic-docker-firewall.service", { silent: true });
  io.exec("systemctl restart trafic-docker-firewall.service", { silent: true });

  success(
    `Docker-published ports closed from outside, except ${[...new Set([...web, ...toolPorts])].join(", ")}`,
  );
  info("These live in DOCKER-USER, not UFW — `ufw status` will not show them");
}
