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
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

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
    "command -v npm || true": "/usr/local/bin/npm",
    "/usr/local/bin/npm prefix -g": "/opt/fnm/aliases/default",
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

describe("setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTest.mockResolvedValue(true);
    mockServer();
  });

  it("skips the Node.js install when a recent Node.js is present", async () => {
    await setup(baseOptions);

    expect(commands().some((c) => c.includes("fnm install"))).toBe(false);
    expect(commands().some((c) => c.includes("fnm.vercel.app"))).toBe(false);
  });

  it("installs Node.js via fnm when Node.js is missing", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    const fnmCommands = commands().filter((c) => c.includes("fnm"));
    expect(fnmCommands.length).toBeGreaterThan(0);
    expect(fnmCommands.some((c) => c.includes("fnm install 24"))).toBe(true);
    expect(
      commands().some((c) =>
        c.includes("ln -sf /opt/fnm/aliases/default/bin/node /usr/local/bin/node"),
      ),
    ).toBe(true);
  });

  it("installs curl and unzip when the fnm installer needs them", async () => {
    const absent = ["command -v node", "command -v curl", "command -v unzip"];
    mockedTest.mockImplementation(async (_options, command) =>
      !absent.includes(command),
    );

    await setup(baseOptions);

    const apt = commands().find((c) => c.includes("apt-get install"))!;
    expect(apt).toContain("curl");
    expect(apt).toContain("unzip");
    expect(apt).toContain("ca-certificates");
  });

  it("skips the apt install when curl and unzip are present", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    expect(commands().some((c) => c.includes("apt-get"))).toBe(false);
  });

  it("downloads the fnm installer instead of piping it into sudo bash", async () => {
    mockedTest.mockImplementation(async (_options, command) =>
      command !== "command -v node",
    );

    await setup(baseOptions);

    // A pipe would report the exit code of bash and hide a curl failure
    expect(commands().some((c) => c.includes("fnm.vercel.app") && c.includes("|"))).toBe(
      false,
    );
    expect(
      commands().some((c) => c.includes("curl -fsSL https://fnm.vercel.app/install -o")),
    ).toBe(true);
  });

  it("installs Node.js when the installed version is too old", async () => {
    mockServer({ "node --version": "v20.11.0" });

    await setup(baseOptions);

    expect(commands().some((c) => c.includes("fnm install 24"))).toBe(true);
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
      "/opt/fnm/aliases/default/bin/trafic-agent setup --tld=previews.example.com",
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

  it("symlinks the agent binary into /usr/local/bin", async () => {
    await setup(baseOptions);

    expect(
      commands().some((c) =>
        c.includes(
          "ln -sf /opt/fnm/aliases/default/bin/trafic-agent /usr/local/bin/trafic-agent",
        ),
      ),
    ).toBe(true);
  });

  it("does not symlink the agent onto itself", async () => {
    mockServer({ "/usr/local/bin/npm prefix -g": "/usr/local" });

    await setup(baseOptions);

    expect(commands().some((c) => c.includes("ln -sf") && c.includes("trafic-agent"))).toBe(
      false,
    );
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
      (c) => c.includes("fnm") || c.includes("npm install") || c.includes(" setup "),
    );
    expect(mutating).toEqual([]);
  });

  it("warns on a non-Ubuntu server but continues", async () => {
    mockServer({
      "cat /etc/os-release": 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n',
    });

    await setup(baseOptions);

    expect(commands().some((c) => c.includes(" setup "))).toBe(true);
  });
});
