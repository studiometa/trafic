import { describe, it, expect } from "vitest";
import {
  buildDockerFirewallScript,
  buildDockerFirewallUnit,
  configureDockerFirewall,
  DOCKER_FIREWALL_SCRIPT,
  DOCKER_FIREWALL_UNIT,
} from "../src/setup/docker-firewall.js";
import { createFakeIo } from "./helpers/fake-io.js";

describe("buildDockerFirewallScript", () => {
  const script = buildDockerFirewallScript(["8025", "8026", "8142", "8143"]);

  /** The script without its comments, so prose cannot satisfy an assertion. */
  const code = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("matches the original destination port, not the post-DNAT one", () => {
    // By FORWARD the destination is the container, so --dport would match the
    // container's port — the same number today, but not if a published port
    // and a container port ever differ
    expect(code).toContain("--ctorigdstport");
    expect(code).not.toMatch(/--dport/);
  });

  it("puts the rules in DOCKER-USER", () => {
    // The only chain Docker jumps to first in FORWARD and never flushes
    expect(script).toContain("DOCKER-USER");
    expect(script).not.toContain("-A FORWARD");
  });

  it("carries every tool port it was given", () => {
    expect(script).toContain('PORTS="8025 8026 8142 8143"');
  });

  it("exempts Docker's own networks before dropping", () => {
    expect(script).toContain("172.16.0.0/12");
    expect(script).toContain("-j RETURN");
    expect(script).toContain("-j DROP");
  });

  it("inserts the exemption after the drop, so it ends up above it", () => {
    // Both use -I, so the last insert wins the top slot
    const drop = script.indexOf('-I DOCKER-USER -p tcp -m conntrack');
    const ret = script.indexOf('-I DOCKER-USER -p tcp -s "$nets"');

    expect(drop).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(drop);
  });

  it("removes an existing copy before inserting, so repeats do not stack", () => {
    expect(script).toContain("-C DOCKER-USER");
    expect(script).toContain("-D DOCKER-USER");
  });

  it("covers IPv6 with an IPv6 exemption range", () => {
    // A v4 range in an ip6tables rule would be rejected outright
    expect(script).toContain("apply ip6tables fd00::/8");
    expect(script).toContain("apply iptables 172.16.0.0/12");
  });

  it("skips a command that is not installed rather than failing", () => {
    expect(script).toContain('command -v "$cmd" >/dev/null 2>&1 || return 0');
  });

  it("stops on error", () => {
    expect(script).toContain("set -eu");
  });

  it("emits nothing for no tool ports", () => {
    expect(buildDockerFirewallScript([])).toContain('PORTS=""');
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

    configureDockerFirewall(["8025", "8143"], io);

    expect(io.written(DOCKER_FIREWALL_SCRIPT)).toContain("DOCKER-USER");
    expect(io.written(DOCKER_FIREWALL_UNIT)).toContain("ExecStart=");
    expect(io.ran(`chmod 0755 ${DOCKER_FIREWALL_SCRIPT}`)).toBe(true);
    expect(io.ran("systemctl daemon-reload")).toBe(true);
    expect(io.ran("enable --now trafic-docker-firewall.service")).toBe(true);
  });

  it("passes the ports through to the script", () => {
    const io = createFakeIo();

    configureDockerFirewall(["8025", "8143"], io);

    expect(io.written(DOCKER_FIREWALL_SCRIPT)).toContain('PORTS="8025 8143"');
  });
});
