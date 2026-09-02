import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shell layer so the setup functions can be inspected without
// touching the machine running the tests
vi.mock("../src/setup/steps.js", () => ({
  step: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  exec: vi.fn(),
  commandExists: vi.fn(),
}));

const steps = await import("../src/setup/steps.js");
const { installNode, addNodeSourceAptRepo } = await import(
  "../src/setup/agent.js"
);
const { installSystemDeps } = await import("../src/setup/ddev.js");

const mockedExec = vi.mocked(steps.exec);
const mockedCommandExists = vi.mocked(steps.commandExists);

/** All shell commands passed to exec. */
function commands(): string[] {
  return mockedExec.mock.calls.map((call) => String(call[0]));
}

describe("addNodeSourceAptRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockReturnValue("");
  });

  it("writes the keyring and a signed-by repository line", () => {
    addNodeSourceAptRepo();

    const cmds = commands();
    expect(cmds.some((c) => c.includes("install -m 0755 -d /etc/apt/keyrings"))).toBe(
      true,
    );
    expect(
      cmds.some((c) =>
        c.includes("https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"),
      ),
    ).toBe(true);

    const repoLine = cmds.find((c) => c.includes("sources.list.d/nodesource.list"))!;
    expect(repoLine).toContain("signed-by=/etc/apt/keyrings/nodesource.gpg");
    expect(repoLine).toContain("node_24.x nodistro main");
  });

  it("does not use the deprecated apt-key", () => {
    addNodeSourceAptRepo();

    expect(commands().some((c) => c.includes("apt-key"))).toBe(false);
  });

  it("does not pipe the key download into another command", () => {
    addNodeSourceAptRepo();

    // A pipeline only reports the exit code of its last command, so piping
    // curl into gpg into tee would hide a failed key download
    for (const c of commands()) {
      if (c.includes("curl")) {
        expect(c).not.toContain("|");
      }
    }
  });
});

describe("installNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockReturnValue("");
  });

  it("skips the install when Node.js is already present", () => {
    mockedCommandExists.mockReturnValue(true);
    mockedExec.mockReturnValue("v24.20.0\n");

    installNode();

    expect(commands().some((c) => c.includes("apt-get install"))).toBe(false);
    expect(commands().some((c) => c.includes("nodesource"))).toBe(false);
  });

  it("adds the apt repository and installs nodejs when Node.js is missing", () => {
    mockedCommandExists.mockReturnValue(false);

    installNode();

    const cmds = commands();
    expect(cmds.some((c) => c.includes("sources.list.d/nodesource.list"))).toBe(true);
    expect(cmds.some((c) => c.includes("apt-get update -qq"))).toBe(true);
    expect(cmds.some((c) => c.includes("apt-get install -y nodejs"))).toBe(true);
  });

  it("installs nodejs non-interactively", () => {
    mockedCommandExists.mockReturnValue(false);

    installNode();

    const install = commands().find((c) => c.includes("apt-get install -y nodejs"))!;
    expect(install).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(install).toContain("NEEDRESTART_MODE=a");
  });

  it("no longer installs a Node.js version manager", () => {
    mockedCommandExists.mockReturnValue(false);

    installNode();

    for (const c of commands()) {
      expect(c).not.toContain("fnm");
      expect(c).not.toContain("/opt/fnm");
    }
  });
});

describe("installSystemDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockReturnValue("");
  });

  it("installs the tools needed to add an apt repository", () => {
    installSystemDeps();

    const install = commands().find((c) => c.includes("apt-get install"))!;
    // gpg --dearmor and https repositories need these, and the DDEV repo is
    // added before Node.js is installed
    expect(install).toContain("gnupg");
    expect(install).toContain("ca-certificates");
    expect(install).toContain("curl");
  });
});
