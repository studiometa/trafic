import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the shell and filesystem layers so hardening can be inspected without
// touching the machine running the tests
vi.mock("../src/setup/steps.js", () => ({
  step: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  exec: vi.fn(),
  commandExists: vi.fn(),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

const steps = await import("../src/setup/steps.js");
const fs = await import("node:fs");
const { hardenSsh, resolveAllowedUsers } = await import(
  "../src/setup/hardening.js"
);

const mockedExec = vi.mocked(steps.exec);
const mockedWrite = vi.mocked(fs.writeFileSync);

/** Content written to the sshd drop-in config. */
function sshdConfig(): string {
  const call = mockedWrite.mock.calls.find((c) =>
    String(c[0]).includes("sshd_config.d/trafic.conf"),
  );
  return String(call?.[1] ?? "");
}

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
  const originalSudoUser = process.env.SUDO_USER;

  beforeEach(() => {
    vi.clearAllMocks();
    // An empty result means `sshd -t` reported no error
    mockedExec.mockReturnValue("");
    delete process.env.SUDO_USER;
  });

  afterEach(() => {
    if (originalSudoUser === undefined) {
      delete process.env.SUDO_USER;
    } else {
      process.env.SUDO_USER = originalSudoUser;
    }
  });

  it("writes AllowUsers with root and the given users", () => {
    hardenSsh(["ddev"]);

    expect(sshdConfig()).toContain("AllowUsers root ddev");
  });

  it("includes the sudo user in AllowUsers", () => {
    process.env.SUDO_USER = "ubuntu";

    hardenSsh(["ddev"]);

    // Without this the invoking user is refused on their next connection,
    // and reloading sshd keeps the current session alive so it looks fine
    expect(sshdConfig()).toContain("AllowUsers root ddev ubuntu");
  });

  it("does not list root twice when invoked through sudo as root", () => {
    process.env.SUDO_USER = "root";

    hardenSsh(["ddev"]);

    expect(sshdConfig()).toContain("AllowUsers root ddev\n");
  });

  it("disables password authentication and keeps root on keys only", () => {
    hardenSsh(["ddev"]);

    const config = sshdConfig();
    expect(config).toContain("PasswordAuthentication no");
    expect(config).toContain("PermitRootLogin prohibit-password");
  });

  it("reverts the drop-in when sshd rejects the config", () => {
    mockedExec.mockImplementation((command) =>
      String(command).includes("sshd -t") ? "error" : "",
    );

    hardenSsh(["ddev"]);

    expect(
      commandsRun().some((c) => c.includes("rm /etc/ssh/sshd_config.d/trafic.conf")),
    ).toBe(true);
    expect(commandsRun().some((c) => c.includes("systemctl reload"))).toBe(false);
  });

  it("reloads sshd once the config passes validation", () => {
    hardenSsh(["ddev"]);

    expect(commandsRun().some((c) => c.includes("systemctl reload ssh"))).toBe(true);
  });
});

/** All shell commands passed to exec. */
function commandsRun(): string[] {
  return mockedExec.mock.calls.map((call) => String(call[0]));
}
