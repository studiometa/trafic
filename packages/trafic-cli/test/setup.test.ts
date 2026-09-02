import { describe, it, expect, vi, beforeEach } from "vitest";
import { setup } from "../src/commands/setup.js";
import * as ssh from "../src/ssh.js";
import type { SetupOptions } from "../src/types.js";

// Mock SSH module
vi.mock("../src/ssh.js", () => ({
  exec: vi.fn(),
  test: vi.fn(),
}));

// Suppress console output
const mockedLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockedWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

const mockedExec = vi.mocked(ssh.exec);
const mockedTest = vi.mocked(ssh.test);

const baseOptions: SetupOptions = {
  host: "server.example.com",
  user: "root",
  port: 22,
  sshOptions: "",
  tld: "previews.example.com",
  agentVersion: "latest",
  noHardening: false,
  noDocker: false,
  noDdev: false,
  dryRun: false,
};

const OS_RELEASE = 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n';

/**
 * Reply to the read-only probes issued by the setup command.
 * Anything else resolves to an empty successful result.
 */
function mockServer(overrides: Record<string, string> = {}): void {
  const replies: Record<string, string> = {
    "cat /etc/os-release": OS_RELEASE,
    "id -u": "0",
    "node --version": "v24.5.0",
    "command -v npm || true": "/usr/bin/npm",
    "/usr/bin/npm prefix -g": "/usr",
    ...overrides,
  };

  mockedExec.mockImplementation(async (_options, command) => ({
    stdout: replies[command] ?? "",
    stderr: "",
    exitCode: 0,
  }));
}

/** All commands passed to ssh.exec. */
function commands(): string[] {
  return mockedExec.mock.calls.map((call) => call[1]);
}

/** Everything printed to stdout, in dry-run mode the remote commands. */
function logs(): string[] {
  return mockedLog.mock.calls.map((call) => String(call[0]));
}

describe("setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTest.mockResolvedValue(true);
    mockServer();
  });

  it("skips the Node.js install when a recent Node.js is present", async () => {
    await setup(baseOptions);

    expect(commands().some((c) => c.includes("apt-get install -y nodejs"))).toBe(false);
    expect(commands().some((c) => c.includes("nodesource"))).toBe(false);
  });

  it("adds the NodeSource apt repository when Node.js is missing", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    const cmds = commands();
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
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    const repoLine = commands().find((c) => c.includes("nodesource.list"))!;
    expect(repoLine).toContain("signed-by=/etc/apt/keyrings/nodesource.gpg");
    expect(commands().some((c) => c.includes("apt-key"))).toBe(false);
  });

  it("runs apt non-interactively so needrestart cannot hang the session", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    for (const c of commands().filter((c) => c.includes("apt-get install"))) {
      expect(c).toContain("DEBIAN_FRONTEND=noninteractive");
      expect(c).toContain("NEEDRESTART_MODE=a");
    }
  });

  it("installs curl and gnupg when the apt repo setup needs them", async () => {
    const absent = ["command -v node", "command -v curl", "command -v gpg"];
    mockedTest.mockImplementation(async (_options, command) =>
      !absent.includes(command),
    );

    await setup(baseOptions);

    const apt = commands().find((c) => c.includes("apt-get install"))!;
    expect(apt).toContain("curl");
    expect(apt).toContain("gnupg");
    expect(apt).toContain("ca-certificates");
  });

  it("skips the dependency install when curl and gnupg are present", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    expect(
      commands().some((c) => c.includes("apt-get install") && c.includes("gnupg")),
    ).toBe(false);
  });

  it("never pipes a remote script into a shell", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    // A pipeline only reports the exit code of its last command, so piping
    // curl into anything hides a failed download
    for (const c of commands()) {
      if (c.includes("curl")) {
        expect(c).not.toContain("|");
      }
    }
  });

  it("installs Node.js when the installed version is too old", async () => {
    mockServer({ "node --version": "v20.11.0" });

    await setup(baseOptions);

    expect(commands().some((c) => c.includes("apt-get install -y nodejs"))).toBe(true);
  });

  it("installs the agent and runs its setup with the TLD", async () => {
    await setup(baseOptions);

    expect(
      commands().some((c) =>
        c.includes("npm install -g @studiometa/trafic-agent@latest"),
      ),
    ).toBe(true);

    const setupCommand = commands().find((c) => c.includes(" setup "));
    expect(setupCommand).toBe(
      "/usr/bin/trafic-agent setup --tld=previews.example.com --ssh-users=ddev",
    );
  });

  it("installs the requested agent version", async () => {
    await setup({ ...baseOptions, agentVersion: "0.1.22" });

    expect(
      commands().some((c) =>
        c.includes("npm install -g @studiometa/trafic-agent@0.1.22"),
      ),
    ).toBe(true);
  });

  it("does not symlink the agent when the npm prefix is on root's PATH", async () => {
    // An apt Node.js has prefix /usr, so the binary is in /usr/bin already
    await setup(baseOptions);

    expect(
      commands().some((c) => c.includes("ln -sf") && c.includes("trafic-agent")),
    ).toBe(false);
  });

  it.each(["/usr", "/usr/local"])(
    "does not symlink the agent onto itself for prefix %s",
    async (prefix) => {
      mockServer({ "/usr/bin/npm prefix -g": prefix });

      await setup(baseOptions);

      expect(
        commands().some((c) => c.includes("ln -sf") && c.includes("trafic-agent")),
      ).toBe(false);
    },
  );

  it("symlinks the agent when the npm prefix is not on root's PATH", async () => {
    // A leftover version-manager install: `which trafic-agent` would fail for
    // the systemd unit without the link
    mockServer({
      "/usr/bin/npm prefix -g": "/opt/fnm/node-versions/v24.20.0/installation",
    });

    await setup(baseOptions);

    expect(
      commands().some((c) =>
        c.includes(
          "ln -sf /opt/fnm/node-versions/v24.20.0/installation/bin/trafic-agent /usr/local/bin/trafic-agent",
        ),
      ),
    ).toBe(true);
  });

  it("adds the connecting user to --ssh-users", async () => {
    mockServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu" });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    // Hardening writes AllowUsers; without this the connecting user is
    // locked out on their next connection
    expect(setupCommand).toContain("--ssh-users=ddev,ubuntu");
  });

  it("adds the connecting user alongside an explicit --ssh-users list", async () => {
    mockServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", sshUsers: "deploy" });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=deploy,ubuntu");
  });

  it("does not duplicate the connecting user when already listed", async () => {
    mockServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", sshUsers: "ubuntu,ddev" });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=ubuntu,ddev");
  });

  it("does not add root to --ssh-users, the agent always allows it", async () => {
    await setup(baseOptions);

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=ddev");
    expect(setupCommand).not.toContain("root");
  });

  it("trims whitespace in an explicit --ssh-users list", async () => {
    mockServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "ubuntu", sshUsers: " deploy , ci " });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--ssh-users=deploy,ci,ubuntu");
  });

  it("forwards the trusted proxy hop count when given", async () => {
    await setup({ ...baseOptions, trustedProxyHops: "2" });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--trusted-proxy-hops=2");
  });

  it("omits the flag when not given, letting the agent default apply", async () => {
    await setup(baseOptions);

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
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
    });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand).toContain("--email=admin@example.com");
    expect(setupCommand).toContain("--no-hardening");
    expect(setupCommand).toContain("--no-docker");
    expect(setupCommand).toContain("--no-ddev");
    expect(setupCommand).toContain("--ssh-users=ddev,deploy");
  });

  it("prefixes privileged commands with sudo for a non-root user", async () => {
    mockServer({ "id -u": "1000" });

    await setup({ ...baseOptions, user: "deploy" });

    const setupCommand = commands().find((c) => c.includes(" setup "))!;
    expect(setupCommand.startsWith("sudo -n ")).toBe(true);
  });

  it("fails when a non-root user has no passwordless sudo", async () => {
    mockServer({ "id -u": "1000" });
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "sudo -n true",
    );

    await expect(setup({ ...baseOptions, user: "deploy" })).rejects.toThrow(
      /passwordless sudo/,
    );
  });

  it("runs no privileged command in dry-run mode", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup({ ...baseOptions, dryRun: true });

    const mutating = commands().filter(
      (c) =>
        c.includes("apt-get install") ||
        c.includes("nodesource") ||
        c.includes("npm install") ||
        c.includes(" setup "),
    );
    expect(mutating).toEqual([]);
  });

  it("warns when the agent service is not active after the setup", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "systemctl is-active --quiet trafic-agent",
    );

    await setup(baseOptions);

    const warnings = mockedWarn.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((w) => w.includes("not active"))).toBe(true);
  });

  it("fails when npm is missing after installing Node.js", async () => {
    mockServer({ "command -v npm || true": "" });

    await expect(setup(baseOptions)).rejects.toThrow(/npm not found/);
  });

  it("keeps going in dry-run mode when npm is not installed yet", async () => {
    mockServer({ "command -v npm || true": "" });
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup({ ...baseOptions, dryRun: true });

    // The binary path cannot be resolved yet, so fall back to the bare name
    expect(
      logs().some((l) =>
        l.includes("trafic-agent setup --tld=previews.example.com"),
      ),
    ).toBe(true);
  });

  it("continues when /etc/os-release has no PRETTY_NAME", async () => {
    mockServer({ "cat /etc/os-release": "ID=ubuntu\n" });

    await setup(baseOptions);

    expect(commands().some((c) => c.includes(" setup "))).toBe(true);
  });

  it("warns on a non-Ubuntu server but continues", async () => {
    mockServer({
      "cat /etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
    });

    await setup(baseOptions);

    expect(commands().some((c) => c.includes(" setup "))).toBe(true);
  });
});
