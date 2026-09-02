import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hardenSsh,
  resolveAllowedUsers,
  configureFirewall,
  configureFail2ban,
  configureUnattendedUpgrades,
  configureSystemLimits,
  configureFilePermissions,
  hardenServer,
} from "../src/setup/hardening.js";
import { createFakeIo } from "./helpers/fake-io.js";

// The setup steps log their progress
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const SSHD_CONFIG = "/etc/ssh/sshd_config.d/trafic.conf";

describe("resolveAllowedUsers", () => {
  it("adds the sudo user so hardening cannot lock them out", () => {
    expect(resolveAllowedUsers(["ddev"], "ubuntu")).toEqual(["ddev", "ubuntu"]);
  });

  it("does not duplicate a sudo user already listed", () => {
    expect(resolveAllowedUsers(["ddev", "ubuntu"], "ubuntu")).toEqual([
      "ddev",
      "ubuntu",
    ]);
  });

  it("ignores root, which is always allowed", () => {
    expect(resolveAllowedUsers(["ddev"], "root")).toEqual(["ddev"]);
  });

  it("handles a direct root login with no sudo user", () => {
    expect(resolveAllowedUsers(["ddev"], undefined)).toEqual(["ddev"]);
  });

  it("trims and drops empty entries", () => {
    expect(resolveAllowedUsers([" ddev ", "", " ci "], "ubuntu")).toEqual([
      "ddev",
      "ci",
      "ubuntu",
    ]);
  });
});

describe("hardenSsh", () => {
  it("writes AllowUsers with root and the given users", () => {
    const io = createFakeIo();

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    expect(io.written(SSHD_CONFIG)).toContain("AllowUsers root ddev");
  });

  it("includes the sudo user in AllowUsers", () => {
    const io = createFakeIo({ env: { SUDO_USER: "ubuntu" } });

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    // Without this the invoking user is refused on their next connection,
    // and reloading sshd keeps the current session alive so it looks fine
    expect(io.written(SSHD_CONFIG)).toContain("AllowUsers root ddev ubuntu");
  });

  it("does not list root twice when invoked through sudo as root", () => {
    const io = createFakeIo({ env: { SUDO_USER: "root" } });

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    expect(io.written(SSHD_CONFIG)).toContain("AllowUsers root ddev\n");
  });

  it("disables password authentication and keeps root on keys only", () => {
    const io = createFakeIo();

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    const config = io.written(SSHD_CONFIG);
    expect(config).toContain("PasswordAuthentication no");
    expect(config).toContain("PermitRootLogin prohibit-password");
    expect(config).toContain("PubkeyAuthentication yes");
  });

  it("reverts the drop-in when sshd rejects the config", () => {
    const io = createFakeIo({ output: { "sshd -t": "error" } });

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    expect(io.ran(`rm ${SSHD_CONFIG}`)).toBe(true);
    expect(io.ran("systemctl reload")).toBe(false);
  });

  it("reloads sshd once the config passes validation", () => {
    const io = createFakeIo();

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    expect(io.ran("systemctl reload ssh")).toBe(true);
  });
});

describe("configureFirewall", () => {
  it("denies incoming traffic by default", () => {
    const io = createFakeIo({ present: ["ufw"] });

    configureFirewall(io);

    expect(io.ran("ufw default deny incoming")).toBe(true);
    expect(io.ran("ufw default allow outgoing")).toBe(true);
  });

  it("allows only SSH, HTTP and HTTPS from anywhere", () => {
    const io = createFakeIo({ present: ["ufw"] });

    configureFirewall(io);

    const allows = io.commands.filter((c) => c.startsWith("ufw allow"));
    expect(allows).toHaveLength(4);
    expect(io.ran("ufw allow 22/tcp")).toBe(true);
    expect(io.ran("ufw allow 80/tcp")).toBe(true);
    expect(io.ran("ufw allow 443/tcp")).toBe(true);
  });

  it("exposes the agent port to Docker subnets only", () => {
    const io = createFakeIo({ present: ["ufw"] });

    configureFirewall(io);

    // ddev-router reaches forward auth from a Docker bridge; the port must
    // not be reachable from the internet
    const agentRule = io.commands.find((c) => c.includes("9876"))!;
    expect(agentRule).toContain("from 172.16.0.0/12");
  });

  it("installs ufw when it is missing", () => {
    const io = createFakeIo();

    configureFirewall(io);

    expect(io.ran("apt-get install -y ufw")).toBe(true);
  });

  it("enables the firewall last", () => {
    const io = createFakeIo({ present: ["ufw"] });

    configureFirewall(io);

    expect(io.commands.at(-1)).toContain("ufw --force enable");
  });
});

describe("configureFail2ban", () => {
  it("enables the sshd jail", () => {
    const io = createFakeIo({ present: ["fail2ban-client"] });

    configureFail2ban(io);

    const jail = io.written("/etc/fail2ban/jail.local");
    expect(jail).toContain("[sshd]");
    expect(jail).toContain("enabled = true");
  });

  it("bans an SSH brute force for longer than the default", () => {
    const io = createFakeIo({ present: ["fail2ban-client"] });

    configureFail2ban(io);

    const jail = io.written("/etc/fail2ban/jail.local");
    expect(jail).toContain("maxretry = 3");
    expect(jail).toContain("bantime = 7200");
  });

  it("installs fail2ban when it is missing, then restarts it", () => {
    const io = createFakeIo();

    configureFail2ban(io);

    expect(io.ran("apt-get install -y fail2ban")).toBe(true);
    expect(io.ran("systemctl restart fail2ban")).toBe(true);
  });
});

describe("configureUnattendedUpgrades", () => {
  it("limits automatic upgrades to security origins", () => {
    const io = createFakeIo();

    configureUnattendedUpgrades(io);

    const config = io.written("/etc/apt/apt.conf.d/50unattended-upgrades");
    expect(config).toContain("${distro_id}:${distro_codename}-security");
    expect(config).toContain('Unattended-Upgrade::Automatic-Reboot "false"');
  });

  it("turns on the periodic upgrade timer", () => {
    const io = createFakeIo();

    configureUnattendedUpgrades(io);

    const periodic = io.written("/etc/apt/apt.conf.d/20auto-upgrades");
    expect(periodic).toContain('APT::Periodic::Unattended-Upgrade "1"');
    expect(io.ran("systemctl enable unattended-upgrades")).toBe(true);
  });
});

describe("configureSystemLimits", () => {
  it("raises the file descriptor limit for the ddev user", () => {
    const io = createFakeIo();

    configureSystemLimits(io);

    const limits = io.written("/etc/security/limits.d/trafic.conf");
    expect(limits).toContain("ddev soft nofile 65536");
    expect(limits).toContain("ddev hard nofile 65536");
  });
});

describe("configureFilePermissions", () => {
  it("keeps the state directory private to the ddev user", () => {
    const io = createFakeIo();

    configureFilePermissions(io);

    expect(io.ran("chmod 700 /var/lib/trafic")).toBe(true);
    expect(io.ran("chown ddev:ddev /var/lib/trafic")).toBe(true);
  });

  it("makes the config readable by the agent but not the world", () => {
    const io = createFakeIo({ files: { "/etc/trafic/config.toml": "" } });

    configureFilePermissions(io);

    // The config holds auth tokens and basic auth credentials
    expect(io.ran("chmod 640 /etc/trafic/config.toml")).toBe(true);
    expect(io.ran("chown root:ddev /etc/trafic/config.toml")).toBe(true);
  });

  it("skips the config permissions when no config exists yet", () => {
    const io = createFakeIo();

    configureFilePermissions(io);

    expect(io.ran("chmod 640 /etc/trafic/config.toml")).toBe(false);
  });
});

describe("hardenServer", () => {
  it("runs every hardening step with the injected io", () => {
    const io = createFakeIo({ present: ["ufw", "fail2ban-client"] });

    hardenServer({ sshUsers: ["ddev"] }, io);

    expect(io.written(SSHD_CONFIG)).not.toBe("");
    expect(io.written("/etc/fail2ban/jail.local")).not.toBe("");
    expect(io.written("/etc/security/limits.d/trafic.conf")).not.toBe("");
    expect(io.ran("ufw --force enable")).toBe(true);
    expect(io.ran("systemctl enable unattended-upgrades")).toBe(true);
  });

  it("passes the SSH users through to the sshd config", () => {
    const io = createFakeIo({ present: ["ufw", "fail2ban-client"] });

    hardenServer({ sshUsers: ["ddev", "deploy"] }, io);

    expect(io.written(SSHD_CONFIG)).toContain("AllowUsers root ddev deploy");
  });
});

describe("hardenSsh --no-root-ssh", () => {
  it("disables root login and drops it from AllowUsers", () => {
    const io = createFakeIo({ env: { SUDO_USER: "ubuntu" } });

    hardenSsh({ allowedUsers: ["ddev"], noRootSsh: true }, io);

    const config = io.written(SSHD_CONFIG);
    expect(config).toContain("PermitRootLogin no");
    expect(config).toContain("AllowUsers ddev ubuntu");
    expect(config).not.toContain("PermitRootLogin prohibit-password");
  });

  it("keeps root by default", () => {
    const io = createFakeIo({ env: { SUDO_USER: "ubuntu" } });

    hardenSsh({ allowedUsers: ["ddev"] }, io);

    const config = io.written(SSHD_CONFIG);
    expect(config).toContain("PermitRootLogin prohibit-password");
    expect(config).toContain("AllowUsers root ddev ubuntu");
  });

  it("still keeps the sudo user, so hardening cannot lock them out", () => {
    const io = createFakeIo({ env: { SUDO_USER: "ubuntu" } });

    hardenSsh({ allowedUsers: ["ddev"], noRootSsh: true }, io);

    expect(io.written(SSHD_CONFIG)).toContain("ubuntu");
  });

  it("warns when there is no sudo user to fall back on", () => {
    const io = createFakeIo();

    hardenSsh({ allowedUsers: ["ddev"], noRootSsh: true }, io);

    // Running straight as root leaves only ddev, which may have no key
    const warnings = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("rescue mode"))).toBe(true);
  });

  it("refuses to leave nobody able to log in", () => {
    const io = createFakeIo();

    expect(() =>
      hardenSsh({ allowedUsers: [], noRootSsh: true }, io),
    ).toThrow(/nobody could log in/);
  });

  it("passes the option through hardenServer", () => {
    const io = createFakeIo({
      present: ["ufw", "fail2ban-client"],
      env: { SUDO_USER: "ubuntu" },
    });

    hardenServer({ sshUsers: ["ddev"], noRootSsh: true }, io);

    expect(io.written(SSHD_CONFIG)).toContain("PermitRootLogin no");
  });
});
