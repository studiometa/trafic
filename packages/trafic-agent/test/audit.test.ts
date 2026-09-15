import { describe, it, expect, vi } from "vitest";
import {
  auditSsh,
  auditFirewall,
  auditServices,
  auditDocker,
  auditPermissions,
  auditWildcardTls,
  printAuditResults,
  runAudit,
} from "../src/setup/audit.js";
import { ROUTER_COMPOSE_OVERRIDE } from "../src/setup/ddev.js";
import type { AuditCheck } from "../src/setup/types.js";
import type { AgentConfig } from "../src/types.js";
import { createFakeIo } from "./helpers/fake-io.js";

/** The check with that name, or undefined. */
function find(checks: AuditCheck[], name: string): AuditCheck | undefined {
  return checks.find((check) => check.name === name);
}

/** Status of the named check. */
function status(checks: AuditCheck[], name: string): string | undefined {
  return find(checks, name)?.status;
}

/** An agent config carrying only what the audit reads. */
function agentConfig(tls: Partial<AgentConfig["tls"]> = {}): AgentConfig {
  return {
    tld: "previews.example.com",
    tls: { dnsEnv: {}, ...tls },
  } as AgentConfig;
}

describe("auditSsh", () => {
  it("passes when root login and password auth are both off", () => {
    const io = createFakeIo({
      files: {
        "/etc/ssh/sshd_config": "Port 22\n",
        "/etc/ssh/sshd_config.d/trafic.conf":
          "PermitRootLogin no\nPasswordAuthentication no\n",
      },
    });

    const checks = auditSsh(io);

    expect(status(checks, "SSH root login")).toBe("pass");
    expect(status(checks, "SSH password auth")).toBe("pass");
  });

  it("accepts prohibit-password as a disabled root login", () => {
    // The Ubuntu default: a key still works, a password never does
    const io = createFakeIo({
      files: { "/etc/ssh/sshd_config": "PermitRootLogin prohibit-password\n" },
    });

    expect(status(auditSsh(io), "SSH root login")).toBe("pass");
  });

  it("fails on root login and warns on password auth when nothing is set", () => {
    // No sshd_config at all: both reads must fall back to an empty string
    // rather than throwing halfway through the audit
    const checks = auditSsh(createFakeIo());

    expect(status(checks, "SSH root login")).toBe("fail");
    expect(status(checks, "SSH password auth")).toBe("warn");
  });
});

describe("auditFirewall", () => {
  it("reports the ports only once UFW is active", () => {
    const io = createFakeIo({ output: { "ufw status": "Status: inactive" } });
    const checks = auditFirewall(io);

    expect(status(checks, "Firewall (UFW)")).toBe("fail");
    expect(find(checks, "Firewall ports")).toBeUndefined();
  });

  it("passes when the three required ports are open", () => {
    const io = createFakeIo({
      output: {
        "ufw status": "Status: active\n22/tcp ALLOW\n80/tcp ALLOW\n443/tcp ALLOW",
      },
    });
    const checks = auditFirewall(io);

    expect(status(checks, "Firewall (UFW)")).toBe("pass");
    expect(status(checks, "Firewall ports")).toBe("pass");
  });

  it("warns when one of the required ports is missing", () => {
    const io = createFakeIo({
      output: { "ufw status": "Status: active\n22/tcp ALLOW\n80/tcp ALLOW" },
    });

    expect(status(auditFirewall(io), "Firewall ports")).toBe("warn");
  });
});

describe("auditServices", () => {
  it("passes every service that systemd reports active", () => {
    const io = createFakeIo({ output: { "systemctl is-active": "active" } });
    const checks = auditServices(io);

    expect(checks.map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
  });

  it("fails the agent and warns for the rest when nothing runs", () => {
    // A missing fail2ban is a warning, a missing agent means no auth at all
    const checks = auditServices(createFakeIo());

    expect(status(checks, "Fail2ban")).toBe("warn");
    expect(status(checks, "Automatic updates")).toBe("warn");
    expect(status(checks, "Trafic agent")).toBe("fail");
  });
});

describe("auditDocker", () => {
  it("passes a running Docker with a quiet disk", () => {
    const io = createFakeIo({
      output: {
        "systemctl is-active docker": "active",
        "dangling=true": "0",
        "df -h": "42%",
      },
    });
    const checks = auditDocker(io);

    expect(status(checks, "Docker")).toBe("pass");
    expect(find(checks, "Docker cleanup")).toBeUndefined();
    expect(status(checks, "Disk usage")).toBe("pass");
    expect(find(checks, "Disk usage")?.fix).toBeUndefined();
  });

  it("warns about dangling images only when there are some", () => {
    const io = createFakeIo({
      output: { "dangling=true": "7", "df -h": "10%" },
    });

    expect(find(auditDocker(io), "Docker cleanup")?.message).toBe(
      "7 dangling Docker images",
    );
  });

  it("warns past 80% of the disk and fails past 90%", () => {
    const warn = auditDocker(createFakeIo({ output: { "df -h": "85%" } }));
    const fail = auditDocker(createFakeIo({ output: { "df -h": "95%" } }));

    expect(status(warn, "Disk usage")).toBe("warn");
    expect(find(warn, "Disk usage")?.fix).toBeDefined();
    expect(status(fail, "Disk usage")).toBe("fail");
  });

  it("fails Docker when the daemon is down", () => {
    expect(status(auditDocker(createFakeIo()), "Docker")).toBe("fail");
  });
});

describe("auditPermissions", () => {
  it("checks nothing that is not installed", () => {
    expect(auditPermissions(createFakeIo())).toEqual([]);
  });

  it("passes 640 and 600 on the config file", () => {
    const io = createFakeIo({
      files: { "/etc/trafic/config.toml": "" },
      output: { "stat -c '%a' /etc/trafic/config.toml": "600" },
    });

    expect(status(auditPermissions(io), "Config permissions")).toBe("pass");
  });

  it("warns on a world-readable config and on a foreign projects directory", () => {
    const io = createFakeIo({
      files: { "/etc/trafic/config.toml": "", "/home/ddev/www": "" },
      output: {
        "stat -c '%a' /etc/trafic/config.toml": "644",
        "stat -c '%U:%G' /home/ddev/www": "root:root",
      },
    });
    const checks = auditPermissions(io);

    expect(find(checks, "Config permissions")?.message).toContain("644");
    expect(find(checks, "Projects directory")?.message).toContain("root:root");
  });

  it("passes a projects directory owned by ddev", () => {
    const io = createFakeIo({
      files: { "/home/ddev/www": "" },
      output: { "stat -c '%U:%G' /home/ddev/www": "ddev:ddev" },
    });

    expect(status(auditPermissions(io), "Projects directory")).toBe("pass");
  });
});

describe("auditWildcardTls", () => {
  const VOLUME = "docker volume inspect ddev-global-cache";
  const STORAGE = "/var/lib/docker/volumes/ddev-global-cache/_data/traefik/acme-dns.json";

  const issued = JSON.stringify({
    "acme-dns": { Certificates: [{ domain: { main: "previews.example.com" } }] },
  });

  it("checks nothing without a DNS provider", () => {
    expect(auditWildcardTls(agentConfig(), createFakeIo())).toEqual([]);
  });

  it("warns when Traefik's storage volume is missing", () => {
    const checks = auditWildcardTls(
      agentConfig({ dnsProvider: "cloudflare" }),
      createFakeIo(),
    );

    expect(find(checks, "Wildcard certificate")?.message).toContain("ddev-global-cache");
  });

  it("warns when no certificate has been issued yet", () => {
    const io = createFakeIo({
      output: { [VOLUME]: "/var/lib/docker/volumes/ddev-global-cache/_data" },
    });

    expect(find(auditWildcardTls(agentConfig({ dnsProvider: "cloudflare" }), io), "Wildcard certificate")?.message).toBe(
      "No DNS-01 certificate has been issued yet",
    );
  });

  it("passes once the storage holds the certificate for the TLD", () => {
    const io = createFakeIo({
      output: { [VOLUME]: "/var/lib/docker/volumes/ddev-global-cache/_data" },
      files: { [STORAGE]: issued },
    });
    const check = find(
      auditWildcardTls(agentConfig({ dnsProvider: "cloudflare" }), io),
      "Wildcard certificate",
    );

    expect(check?.status).toBe("pass");
    expect(check?.fix).toBeUndefined();
  });

  it("warns when the storage holds someone else's certificate", () => {
    const io = createFakeIo({
      output: { [VOLUME]: "/var/lib/docker/volumes/ddev-global-cache/_data" },
      files: {
        [STORAGE]: JSON.stringify({
          "acme-dns": { Certificates: [{ domain: { main: "other.example.com" } }] },
        }),
      },
    });
    const check = find(
      auditWildcardTls(agentConfig({ dnsProvider: "cloudflare" }), io),
      "Wildcard certificate",
    );

    expect(check?.status).toBe("warn");
    expect(check?.fix).toContain("docker logs ddev-router");
  });

  it("passes the credentials file at mode 600", () => {
    const io = createFakeIo({
      files: { [ROUTER_COMPOSE_OVERRIDE]: "services:\n" },
      output: { [`stat -c '%a' ${ROUTER_COMPOSE_OVERRIDE}`]: "600" },
    });

    expect(
      status(
        auditWildcardTls(agentConfig({ dnsProvider: "cloudflare" }), io),
        "DNS credentials permissions",
      ),
    ).toBe("pass");
  });

  it("warns on a credentials file anyone can read", () => {
    // It holds the provider token: 644 hands it to every user on the server
    const io = createFakeIo({
      files: { [ROUTER_COMPOSE_OVERRIDE]: "services:\n" },
      output: { [`stat -c '%a' ${ROUTER_COMPOSE_OVERRIDE}`]: "644" },
    });
    const check = find(
      auditWildcardTls(agentConfig({ dnsProvider: "cloudflare" }), io),
      "DNS credentials permissions",
    );

    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("644");
  });

  it("checks no permissions when the credentials file is absent", () => {
    const checks = auditWildcardTls(
      agentConfig({ dnsProvider: "cloudflare" }),
      createFakeIo(),
    );

    expect(find(checks, "DNS credentials permissions")).toBeUndefined();
  });
});

describe("runAudit", () => {
  it("collects every group, wildcard checks included", () => {
    const io = createFakeIo({ output: { "systemctl is-active": "active" } });
    const names = runAudit(io, agentConfig({ dnsProvider: "cloudflare" })).map(
      (check) => check.name,
    );

    expect(names).toContain("SSH root login");
    expect(names).toContain("Firewall (UFW)");
    expect(names).toContain("Trafic agent");
    expect(names).toContain("Docker");
    expect(names).toContain("Wildcard certificate");
  });

  it("leaves the wildcard checks out when no provider is configured", () => {
    const names = runAudit(createFakeIo(), agentConfig()).map((check) => check.name);

    expect(names).not.toContain("Wildcard certificate");
  });
});

describe("printAuditResults", () => {
  it("prints a fix for a failing check but not for a passing one", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    printAuditResults([
      { name: "Docker", status: "pass", message: "running", fix: "not shown" },
      { name: "Firewall", status: "warn", message: "inactive", fix: "ufw enable" },
      { name: "Agent", status: "fail", message: "stopped" },
    ]);

    const printed = log.mock.calls.map((call) => call.join(" ")).join("\n");
    log.mockRestore();

    expect(printed).toContain("ufw enable");
    expect(printed).not.toContain("not shown");
    expect(printed).toContain("1 passed, 1 warnings, 1 failed");
  });
});
