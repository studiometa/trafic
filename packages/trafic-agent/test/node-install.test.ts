import { describe, it, expect, vi, beforeEach } from "vitest";
import { installNode, addNodeSourceAptRepo } from "../src/setup/agent.js";
import { installSystemDeps } from "../src/setup/ddev.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const REPO_LIST = "/etc/apt/sources.list.d/nodesource.list";

describe("addNodeSourceAptRepo", () => {
  it("writes the keyring and a signed-by repository line", () => {
    const io = createFakeIo();

    addNodeSourceAptRepo(io);

    expect(io.ran("install -m 0755 -d /etc/apt/keyrings")).toBe(true);
    expect(
      io.ran("https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"),
    ).toBe(true);

    const repoLine = io.commands.find((c) => c.includes(REPO_LIST))!;
    expect(repoLine).toContain("signed-by=/etc/apt/keyrings/nodesource.gpg");
    expect(repoLine).toContain("node_24.x nodistro main");
  });

  it("does not use the deprecated apt-key", () => {
    const io = createFakeIo();

    addNodeSourceAptRepo(io);

    expect(io.ran("apt-key")).toBe(false);
  });

  it("does not pipe the key download into another command", () => {
    const io = createFakeIo();

    addNodeSourceAptRepo(io);

    // A pipeline only reports the exit code of its last command, so piping
    // curl into gpg into tee would hide a failed key download
    for (const command of io.commands) {
      if (command.includes("curl")) {
        expect(command).not.toContain("|");
      }
    }
  });

  it("cleans up the temporary key files", () => {
    const io = createFakeIo();

    addNodeSourceAptRepo(io);

    expect(io.ran("rm -f /tmp/trafic-nodesource.key")).toBe(true);
  });
});

describe("installNode", () => {
  it("skips the install when Node.js is already present", () => {
    const io = createFakeIo({
      present: ["node"],
      output: { "node --version": "v24.20.0\n" },
    });

    installNode(io);

    expect(io.ran("apt-get install")).toBe(false);
    expect(io.ran("nodesource")).toBe(false);
  });

  it("adds the apt repository and installs nodejs when Node.js is missing", () => {
    const io = createFakeIo();

    installNode(io);

    expect(io.ran(REPO_LIST)).toBe(true);
    expect(io.ran("apt-get update -qq")).toBe(true);
    expect(io.ran("apt-get install -y nodejs")).toBe(true);
  });

  it("installs nodejs non-interactively", () => {
    const io = createFakeIo();

    installNode(io);

    const install = io.commands.find((c) => c.includes("install -y nodejs"))!;
    expect(install).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(install).toContain("NEEDRESTART_MODE=a");
  });

  it("no longer installs a Node.js version manager", () => {
    const io = createFakeIo();

    installNode(io);

    for (const command of io.commands) {
      expect(command).not.toContain("fnm");
      expect(command).not.toContain("/opt/fnm");
    }
  });
});

describe("installSystemDeps", () => {
  it("installs the tools needed to add an apt repository", () => {
    const io = createFakeIo();

    installSystemDeps(io);

    const install = io.commands.find((c) => c.includes("apt-get install"))!;
    // gpg --dearmor and https repositories need these, and the DDEV repo is
    // added before Node.js is installed
    expect(install).toContain("gnupg");
    expect(install).toContain("ca-certificates");
    expect(install).toContain("curl");
    expect(install).toContain("jq");
    expect(install).toContain("rsync");
  });

  it("updates the package lists first", () => {
    const io = createFakeIo();

    installSystemDeps(io);

    expect(io.commands[0]).toContain("apt-get update");
  });
});
