import { describe, it, expect } from "vitest";
import {
  buildDockerFirewallScript,
  buildDockerFirewallUnit,
  configureDockerFirewall,
  DOCKER_FIREWALL_CHAIN,
  DOCKER_FIREWALL_SCRIPT,
  DOCKER_FIREWALL_UNIT,
} from "../src/setup/docker-firewall.js";
import {
  buildStaticConfig,
  readAuthenticatedPorts,
  STATIC_CONFIG,
} from "../src/setup/ddev.js";
import { createFakeIo } from "./helpers/fake-io.js";

const ROUTER_PORTS = { http: "80", https: "443" };
const TOOL_PORTS = ["8025", "8026", "8143", "8142"];

/** The script without its comments, so prose cannot satisfy an assertion. */
function codeOf(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** The ports a generated script allows. */
function allowedPorts(script: string): string[] {
  return /^ALLOWED_PORTS="([^"]*)"$/m.exec(script)![1]!.split(" ").filter(Boolean);
}

describe("buildDockerFirewallScript", () => {
  const script = buildDockerFirewallScript(ROUTER_PORTS, TOOL_PORTS);
  const code = codeOf(script);

  it("allows the router web ports and the tool ports", () => {
    expect(code).toContain('ALLOWED_PORTS="80 443 8025 8026 8143 8142"');
  });

  it("allows the router ports a server was moved to", () => {
    const moved = buildDockerFirewallScript({ http: "8080", https: "8443" }, []);

    expect(moved).toContain('ALLOWED_PORTS="8080 8443"');
  });

  it("lists a port once when two lists share it", () => {
    const same = buildDockerFirewallScript({ http: "8080", https: "8080" }, ["8080", "2052"]);

    expect(same).toContain('ALLOWED_PORTS="8080 2052"');
  });

  it("names no port outside the allow list, so an unknown port is closed", () => {
    // The previous script dropped a list of ports; any port missing from
    // that list, like an add-on's 9200, stayed open
    const rest = code.replace(/^ALLOWED_PORTS=.*$/m, "");

    expect(rest).not.toMatch(/\b(80|443|8025|8026|8142|8143|9200)\b/);
    expect(code).not.toMatch(/^PORTS=/m);
  });

  it("drops every other DNAT'd packet in the original direction", () => {
    // Not DNAT'd: traffic between containers and outbound traffic.
    // Not the original direction: replies of an allowed connection.
    expect(code).toContain(
      '"$cmd" -A "$CHAIN" -m conntrack --ctstate DNAT --ctdir ORIGINAL -j DROP',
    );
  });

  it("matches the allowed ports on the original destination port", () => {
    // By FORWARD the destination is the container, so --dport would match
    // the container's side of the mapping
    expect(code).toContain(
      '"$cmd" -A "$CHAIN" -p tcp -m conntrack --ctorigdstport "$port" -j RETURN',
    );
    expect(code).not.toMatch(/--dport/);
  });

  it("exempts Docker's networks, then the allowed ports, then drops", () => {
    const exempt = code.indexOf('"$cmd" -A "$CHAIN" -s "$nets" -j RETURN');
    const allow = code.indexOf("--ctorigdstport \"$port\" -j RETURN");
    const drop = code.indexOf("-j DROP");

    expect(exempt).toBeGreaterThan(-1);
    expect(allow).toBeGreaterThan(exempt);
    expect(drop).toBeGreaterThan(allow);
  });

  it("keeps its rules in its own chain, jumped to from DOCKER-USER", () => {
    // DOCKER-USER is the only chain Docker jumps to first in FORWARD and
    // never flushes
    expect(code).toContain(`CHAIN="${DOCKER_FIREWALL_CHAIN}"`);
    expect(code).toContain('"$cmd" -I DOCKER-USER -j "$CHAIN"');
    expect(code).not.toContain("-A FORWARD");
  });

  it("rebuilds the chain on each run, so repeats give the same rules", () => {
    const create = code.indexOf('"$cmd" -N "$CHAIN" 2>/dev/null || true');
    const flush = code.indexOf('"$cmd" -F "$CHAIN"');
    const firstRule = code.indexOf('"$cmd" -A "$CHAIN"');

    expect(create).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(create);
    expect(firstRule).toBeGreaterThan(flush);
  });

  it("keeps exactly one jump in DOCKER-USER", () => {
    const remove = code.indexOf('while "$cmd" -C DOCKER-USER -j "$CHAIN"');
    const insert = code.indexOf('"$cmd" -I DOCKER-USER -j "$CHAIN"');

    expect(remove).toBeGreaterThan(-1);
    expect(code).toContain('"$cmd" -D DOCKER-USER -j "$CHAIN"');
    expect(insert).toBeGreaterThan(remove);
  });

  it("removes the per-port rules of the previous script before anything else", () => {
    const cleanup = code.indexOf('"$cmd" -S DOCKER-USER');
    const create = code.indexOf('"$cmd" -N "$CHAIN"');

    expect(cleanup).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(cleanup);
    expect(code).toContain('"$cmd" -D DOCKER-USER ${rule#-A DOCKER-USER }');
  });

  describe("the pattern that finds the previous rules", () => {
    const pattern = new RegExp(/grep -E -- '([^']+)'/.exec(code)![1]!);

    it.each([
      "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 8025 --ctdir ORIGINAL -j DROP",
      "-A DOCKER-USER -s 172.16.0.0/12 -p tcp -m conntrack --ctorigdstport 8025 --ctdir ORIGINAL -j RETURN",
      "-A DOCKER-USER -s fd00::/8 -p tcp -m conntrack --ctorigdstport 9201 --ctdir ORIGINAL -j RETURN",
      // A port an operator added to PORTS by hand
      "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 9200 --ctdir ORIGINAL -j DROP",
    ])("matches %s", (rule) => {
      expect(pattern.test(rule)).toBe(true);
    });

    it.each([
      "-N DOCKER-USER",
      `-A DOCKER-USER -j ${DOCKER_FIREWALL_CHAIN}`,
      "-A DOCKER-USER -j RETURN",
      "-A DOCKER-USER -s 10.0.0.0/8 -p tcp -m tcp --dport 22 -j DROP",
      // Shell metacharacters can never reach the unquoted -D arguments
      "-A DOCKER-USER -s $(id) -p tcp -m conntrack --ctorigdstport 1 --ctdir ORIGINAL -j DROP",
    ])("leaves %s alone", (rule) => {
      expect(pattern.test(rule)).toBe(false);
    });
  });

  it("covers IPv6 with an IPv6 exemption range", () => {
    // A v4 range in an ip6tables rule would be rejected outright
    expect(code).toContain("apply iptables 172.16.0.0/12");
    expect(code).toContain("apply ip6tables fd00::/8");
  });

  it("skips a family Docker does not filter rather than failing", () => {
    expect(code).toContain('command -v "$cmd" >/dev/null 2>&1 || return 0');
    expect(code).toContain('"$cmd" -n -L DOCKER-USER >/dev/null 2>&1 || return 0');
  });

  it("stops on error", () => {
    expect(code).toContain("set -eu");
  });
});

describe("buildDockerFirewallUnit", () => {
  const unit = buildDockerFirewallUnit();

  it("reapplies after Docker starts", () => {
    // Docker recreates DOCKER-USER empty, so ordering is the whole point
    expect(unit).toContain("After=docker.service");
    expect(unit).toContain("Requires=docker.service");
  });

  it("reapplies when Docker itself restarts", () => {
    expect(unit).toContain("PartOf=docker.service");
  });

  it("runs the installed script once and stays satisfied", () => {
    expect(unit).toContain(`ExecStart=${DOCKER_FIREWALL_SCRIPT}`);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("RemainAfterExit=yes");
  });
});

describe("configureDockerFirewall", () => {
  it("installs the script executable and enables the unit", () => {
    const io = createFakeIo();

    configureDockerFirewall(ROUTER_PORTS, io);

    expect(io.written(DOCKER_FIREWALL_SCRIPT)).toContain("DOCKER-USER");
    expect(io.written(DOCKER_FIREWALL_UNIT)).toContain("ExecStart=");
    expect(io.ran(`chmod 0755 ${DOCKER_FIREWALL_SCRIPT}`)).toBe(true);
    expect(io.ran("systemctl daemon-reload")).toBe(true);
    expect(io.ran("systemctl enable trafic-docker-firewall.service")).toBe(true);
  });

  it("restarts the unit, so a server that has it runs the new script", () => {
    // A oneshot unit with RemainAfterExit stays active: "enable --now" would
    // leave the old rules in place until the next reboot
    const io = createFakeIo();

    configureDockerFirewall(ROUTER_PORTS, io);

    const reload = io.commands.indexOf("systemctl daemon-reload");
    const restart = io.commands.indexOf("systemctl restart trafic-docker-firewall.service");

    expect(restart).toBeGreaterThan(reload);
    expect(io.ran("--now")).toBe(false);
  });

  it("passes the router ports through to the script", () => {
    const io = createFakeIo();

    configureDockerFirewall({ http: "8080", https: "8443" }, io);

    expect(io.written(DOCKER_FIREWALL_SCRIPT)).toContain('ALLOWED_PORTS="8080 8443"');
  });

  it("allows the tool ports of the static config", () => {
    const io = createFakeIo({
      files: { [STATIC_CONFIG]: buildStaticConfig(TOOL_PORTS, ROUTER_PORTS) },
    });

    configureDockerFirewall(ROUTER_PORTS, io);

    expect(io.written(DOCKER_FIREWALL_SCRIPT)).toContain(
      'ALLOWED_PORTS="80 443 8025 8026 8143 8142"',
    );
  });

  it("allows no tool port without a static config", () => {
    // No file means no forward auth on any tool entry point
    const io = createFakeIo();

    configureDockerFirewall(ROUTER_PORTS, io);

    expect(allowedPorts(io.written(DOCKER_FIREWALL_SCRIPT))).toEqual(["80", "443"]);
  });

  it.each([
    ["default tool ports", TOOL_PORTS, ROUTER_PORTS],
    ["custom tool ports", ["2052", "2053", "8143", "8142"], ROUTER_PORTS],
    ["a tool port equal to a router port", ["8080", "8026"], { http: "8080", https: "8443" }],
  ])("opens only ports that carry forward auth: %s", (_, toolPorts, routerPorts) => {
    // Ties the firewall to buildStaticConfig: a port the firewall opens to
    // the internet must have trafic-auth@file on its entry point
    const staticConfig = buildStaticConfig(toolPorts, routerPorts);
    const io = createFakeIo({ files: { [STATIC_CONFIG]: staticConfig } });

    configureDockerFirewall(routerPorts, io);

    const allowed = allowedPorts(io.written(DOCKER_FIREWALL_SCRIPT));
    const authenticated = [...staticConfig.matchAll(/^ {2}http-(\d+):\n.*\n.*\n\s+- trafic-auth@file$/gm)]
      .map((match) => match[1]);

    expect([...allowed].sort()).toEqual([...authenticated].sort());
    expect(allowed).toEqual(expect.arrayContaining([...toolPorts, routerPorts.http, routerPorts.https]));
  });
});

describe("readAuthenticatedPorts", () => {
  it("reads every entry point that carries trafic-auth", () => {
    const io = createFakeIo({
      files: { [STATIC_CONFIG]: buildStaticConfig(TOOL_PORTS, ROUTER_PORTS) },
    });

    expect(readAuthenticatedPorts(io)).toEqual(["80", "443", ...TOOL_PORTS]);
  });

  it("returns nothing when the static config does not exist", () => {
    expect(readAuthenticatedPorts(createFakeIo())).toEqual([]);
  });

  it("skips an entry point without trafic-auth", () => {
    const io = createFakeIo({
      files: {
        [STATIC_CONFIG]: `entryPoints:
  http-9200:
    http:
      middlewares:
        - trafic-errors@file
  web:
    http:
      middlewares:
        - trafic-auth@file
  http-8025:
    http:
      middlewares:
        - trafic-auth@file
`,
      },
    });

    expect(readAuthenticatedPorts(io)).toEqual(["8025"]);
  });

  it("stops at the end of the entryPoints section", () => {
    const staticConfig = buildStaticConfig(["8025"], ROUTER_PORTS, {
      provider: "cloudflare",
      email: "admin@example.com",
    });
    const io = createFakeIo({
      files: { [STATIC_CONFIG]: `${staticConfig}other:\n  http-9200:\n    - trafic-auth@file\n` },
    });

    expect(readAuthenticatedPorts(io)).toEqual(["80", "443", "8025"]);
  });
});
