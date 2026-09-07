import { describe, it, expect, beforeEach } from "vitest";
import { setup } from "../src/commands/setup.js";
import { createFakeSshIo, type FakeSshIo } from "./helpers/fake-ssh-io.js";
import type { SetupOptions } from "../src/types.js";

const OS_RELEASE = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';

const baseOptions: SetupOptions = {
  host: "server.example.com",
  user: "root",
  port: 22,
  sshOptions: "",
  tld: "previews.example.com",
  agentVersion: "latest",
  noHardening: false,
  noRootSsh: false,
  noDocker: false,
  noDdev: false,
  dryRun: false,
};

/** Everything printed to stdout, which in dry-run mode is the remote commands. */
const printed: string[] = [];
console.log = (message?: unknown) => void printed.push(String(message));
console.error = () => {};
console.warn = (message?: unknown) => void printed.push(String(message));

/**
 * A server that answers the probes setup makes.
 *
 * Injected rather than mocked, so setup's real decisions run: whether Node
 * is recent enough, whether the apt prerequisites are present, and whether
 * the npm prefix is already on root's PATH.
 */
function fakeServer(
  overrides: Record<string, string> = {},
  tests?: (command: string) => boolean,
): FakeSshIo {
  return createFakeSshIo({
    tests,
    output: {
      "cat /etc/os-release": OS_RELEASE,
      "id -u": "0",
      "node --version": "v24.5.0",
      "command -v npm || true": "/usr/bin/npm",
      "/usr/bin/npm prefix -g": "/usr",
      ...overrides,
    },
  });
}

describe("setup", () => {
  let io: FakeSshIo;

  beforeEach(() => {
    printed.length = 0;
    io = fakeServer();
  });

  it("skips the Node.js install when a recent Node.js is present", async () => {
    await setup(baseOptions, io);

    expect(io.commands.some((c) => c.includes("apt-get install -y nodejs"))).toBe(false);
    expect(io.commands.some((c) => c.includes("nodesource"))).toBe(false);
  });

  it("adds the NodeSource apt repository when Node.js is missing", async () => {
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup(baseOptions, io);

    const cmds = io.commands;
    expect(
      cmds.some((c) =>
        c.includes("curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"),
      ),
    ).toBe(true);
    expect(
      cmds.some((c) => c.includes("/etc/apt/sources.list.d/nodesource.list")),
    ).toBe(true);
    expect(cmds.some((c) => c.includes("node_24.x nodistro main"))).toBe(true);
    expect(cmds.some((c) => c.includes("apt-get install -y nodejs"))).toBe(true);
  });

  it("signs the NodeSource repository with a keyring instead of apt-key", async () => {
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup(baseOptions, io);

    const repoLine = io.commands.find((c) => c.includes("nodesource.list"))!;
    expect(repoLine).toContain("signed-by=/etc/apt/keyrings/nodesource.gpg");
    expect(io.commands.some((c) => c.includes("apt-key"))).toBe(false);
  });

  it("runs apt non-interactively so needrestart cannot hang the session", async () => {
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup(baseOptions, io);

    for (const c of io.commands.filter((c) => c.includes("apt-get install"))) {
      expect(c).toContain("DEBIAN_FRONTEND=noninteractive");
      expect(c).toContain("NEEDRESTART_MODE=a");
    }
  });

  it("installs curl and gnupg when the apt repo setup needs them", async () => {
    const absent = ["command -v node", "command -v curl", "command -v gpg"];
    io = fakeServer({}, (command) => !absent.includes(command));

    await setup(baseOptions, io);

    const apt = io.commands.find((c) => c.includes("apt-get install"))!;
    expect(apt).toContain("curl");
    expect(apt).toContain("gnupg");
    expect(apt).toContain("ca-certificates");
  });

  it("skips the dependency install when curl and gnupg are present", async () => {
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup(baseOptions, io);

    expect(
      io.commands.some((c) => c.includes("apt-get install") && c.includes("gnupg")),
    ).toBe(false);
  });

  it("never pipes a remote script into a shell", async () => {
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup(baseOptions, io);

    // A pipeline only reports the exit code of its last command, so piping
    // curl into anything hides a failed download
    for (const c of io.commands) {
      if (c.includes("curl")) {
        expect(c).not.toContain("|");
      }
    }
  });

  it("installs Node.js when the installed version is too old", async () => {
    io = fakeServer({ "node --version": "v20.11.0" });

    await setup(baseOptions, io);

    expect(io.commands.some((c) => c.includes("apt-get install -y nodejs"))).toBe(true);
    });

  it("installs the agent and runs its setup with the TLD", async () => {
    await setup(baseOptions, io);

    expect(
      io.commands.some((c) =>
        c.includes("npm install -g @studiometa/trafic-agent@latest"),
      ),
    ).toBe(true);

    const setupCommand = io.commands.find((c) => c.includes(" setup "));
    expect(setupCommand).toBe(
      "/usr/bin/trafic-agent setup --tld=previews.example.com --ssh-users=ddev",
    );
  });

  it("installs the requested agent version", async () => {
    await setup({ ...baseOptions, agentVersion: "0.1.22" }, io);

    expect(
      io.commands.some((c) =>
        c.includes("npm install -g @studiometa/trafic-agent@0.1.22"),
      ),
    ).toBe(true);
  });

  it("does not symlink the agent when the npm prefix is on root's PATH", async () => {
    // An apt Node.js has prefix /usr, so the binary is in /usr/bin already
    await setup(baseOptions, io);

    expect(
      io.commands.some((c) => c.includes("ln -sf") && c.includes("trafic-agent")),
    ).toBe(false);
  });

  it.each(["/usr", "/usr/local"])(
    "does not symlink the agent onto itself for prefix %s",
    async (prefix) => {
    io = fakeServer({ "/usr/bin/npm prefix -g": prefix });

      await setup(baseOptions, io);

      expect(
        io.commands.some((c) => c.includes("ln -sf") && c.includes("trafic-agent")),
      ).toBe(false);
    },
  );

  it("symlinks the agent when the npm prefix is not on root's PATH", async () => {
    // A leftover version-manager install: `which trafic-agent` would fail for
    // the systemd unit without the link
    io = fakeServer({
      "/usr/bin/npm prefix -g": "/opt/fnm/node-versions/v24.20.0/installation",
    });

    await setup(baseOptions, io);

    expect(
      io.commands.some((c) =>
        c.includes(
          "ln -sf /opt/fnm/node-versions/v24.20.0/installation/bin/trafic-agent /usr/local/bin/trafic-agent",
        ),
      ),
    ).toBe(true);
  });

  it("adds the connecting user to --ssh-users", async () => {
    io = fakeServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu" }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    // Hardening writes AllowUsers; without this the connecting user is
    // locked out on their next connection
    expect(setupCommand).toContain("--ssh-users=ddev,ubuntu");
    });

  it("adds the connecting user alongside an explicit --ssh-users list", async () => {
    io = fakeServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", sshUsers: "deploy" }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=deploy,ubuntu");
    });

  it("does not duplicate the connecting user when already listed", async () => {
    io = fakeServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", sshUsers: "ubuntu,ddev" }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=ubuntu,ddev");
    });

  it("does not add root to --ssh-users, the agent always allows it", async () => {
    await setup(baseOptions, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=ddev");
    expect(setupCommand).not.toContain("root");
  });

  it("trims whitespace in an explicit --ssh-users list", async () => {
    io = fakeServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", sshUsers: " deploy , ci " }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=deploy,ci,ubuntu");
    });

  it("forwards --no-root-ssh when set", async () => {
    io = fakeServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", noRootSsh: true }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--no-root-ssh");
    // The connecting user must survive, or nobody can log in at all
    expect(setupCommand).toContain("--ssh-users=ddev,ubuntu");
    });

  it("omits --no-root-ssh by default", async () => {
    await setup(baseOptions, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).not.toContain("--no-root-ssh");
  });

  it("forwards the trusted proxy hop count when given", async () => {
    await setup({ ...baseOptions, trustedProxyHops: "2" }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--trusted-proxy-hops=2");
  });

  it("omits the flag when not given, letting the agent default apply", async () => {
    await setup(baseOptions, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).not.toContain("--trusted-proxy-hops");
  });

  it("forwards the optional agent setup flags", async () => {
    await setup({
      ...baseOptions,
      email: "admin@example.com",
      noHardening: true,
      noDocker: true,
      noDdev: true,
      sshUsers: "ddev,deploy",
    }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--email=admin@example.com");
    expect(setupCommand).toContain("--no-hardening");
    expect(setupCommand).toContain("--no-docker");
    expect(setupCommand).toContain("--no-ddev");
    expect(setupCommand).toContain("--ssh-users=ddev,deploy");
  });

  it("prefixes privileged commands with sudo for a non-root user", async () => {
    io = fakeServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "deploy" }, io);

    const setupCommand = io.commands.find((c) => c.includes(" setup "))!;
    expect(setupCommand.startsWith("sudo -n ")).toBe(true);
    });

  it("fails when a non-root user has no passwordless sudo", async () => {
    io = fakeServer(
      { "id -u": "1000" },
      (command) => command !== "sudo -n true",
    );

    await expect(setup({ ...baseOptions, user: "deploy" }, io)).rejects.toThrow(
      /passwordless sudo/,
    );
    });

  it("runs no privileged command in dry-run mode", async () => {
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup({ ...baseOptions, dryRun: true }, io);

    const mutating = io.commands.filter(
      (c) =>
        c.includes("apt-get install") ||
        c.includes("nodesource") ||
        c.includes("npm install") ||
        c.includes(" setup "),
    );
    expect(mutating).toEqual([]);
  });

  it("warns when the agent service is not active after the setup", async () => {
    io = fakeServer({}, (command) => command !== "systemctl is-active --quiet trafic-agent");

    await setup(baseOptions, io);

    expect(printed.some((line) => line.includes("not active"))).toBe(true);
  });

  it("fails when npm is missing after installing Node.js", async () => {
    io = fakeServer({ "command -v npm || true": "" });

    await expect(setup(baseOptions, io)).rejects.toThrow(/npm not found/);
    });

  it("keeps going in dry-run mode when npm is not installed yet", async () => {
    io = fakeServer({ "command -v npm || true": "" });
    io = fakeServer({}, (command) => command !== "command -v node");

    await setup({ ...baseOptions, dryRun: true }, io);

    // The binary path cannot be resolved yet, so fall back to the bare name
    expect(
      printed.some((l) =>
        l.includes("trafic-agent setup --tld=previews.example.com"),
      ),
    ).toBe(true);
    });

  it("continues when /etc/os-release has no PRETTY_NAME", async () => {
    io = fakeServer({ "cat /etc/os-release": "ID=ubuntu\n" });

    await setup(baseOptions, io);

    expect(io.commands.some((c) => c.includes(" setup "))).toBe(true);
    });

  it("warns on a non-Ubuntu server but continues", async () => {
    io = fakeServer({
      "cat /etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
    });

    await setup(baseOptions, io);

    expect(io.commands.some((c) => c.includes(" setup "))).toBe(true);
  });
});
