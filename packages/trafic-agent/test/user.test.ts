import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDdevUser,
  configureDdevSudoers,
  setupAuthorizedKeys,
} from "../src/setup/user.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const SUDOERS = "/etc/sudoers.d/trafic-ddev";
const AUTH_KEYS = "/home/ddev/.ssh/authorized_keys";

describe("configureDdevSudoers", () => {
  it("allows only ddev-hostname without a password", () => {
    const io = createFakeIo();

    configureDdevSudoers(io);

    const sudoers = io.written(SUDOERS);
    expect(sudoers).toContain("ddev ALL=(ALL) NOPASSWD: /usr/bin/ddev-hostname");
    // A broader rule would hand the ddev user full root
    expect(sudoers).not.toContain("NOPASSWD: ALL");
  });

  it("writes the file with the mode sudo requires", () => {
    const io = createFakeIo();

    configureDdevSudoers(io);

    // sudo refuses to read a sudoers file that is group or world writable
    expect(io.ran(`chmod 440 ${SUDOERS}`)).toBe(true);
  });
});

describe("createDdevUser", () => {
  it("creates the user when it does not exist", () => {
    const io = createFakeIo();

    createDdevUser(io);

    expect(io.ran("useradd -m -s /bin/bash ddev")).toBe(true);
  });

  it("does not recreate an existing user", () => {
    const io = createFakeIo({ output: { "id -u ddev": "1001" } });

    createDdevUser(io);

    expect(io.ran("useradd")).toBe(false);
  });

  it("treats a failing id lookup as 'user absent', not an error", () => {
    // `id -u ddev` exits non-zero on a server without that user, which is
    // every fresh install. Probing with exec instead of execSilent turned
    // that into a thrown error and broke setup at step 2.
    const io = createFakeIo({ fails: ["id -u ddev"] });

    expect(() => createDdevUser(io)).not.toThrow();
    expect(io.ran("useradd -m -s /bin/bash ddev")).toBe(true);
  });

  it("creates the projects directory owned by ddev", () => {
    const io = createFakeIo();

    createDdevUser(io);

    expect(io.ran("mkdir -p /home/ddev/www")).toBe(true);
    expect(io.ran("chown ddev:ddev /home/ddev/www")).toBe(true);
    expect(io.ran("chmod 750 /home/ddev/www")).toBe(true);
  });

  it("creates .ssh with the mode sshd requires", () => {
    const io = createFakeIo();

    createDdevUser(io);

    // sshd ignores authorized_keys when .ssh is group or world accessible
    expect(io.ran("chmod 700 /home/ddev/.ssh")).toBe(true);
    expect(io.ran("chown ddev:ddev /home/ddev/.ssh")).toBe(true);
  });

  it("configures the ddev-hostname sudoers rule", () => {
    const io = createFakeIo();

    createDdevUser(io);

    // Without it, any ddev command touching hostnames fails with
    // "sudo: a terminal is required to read the password"
    expect(io.written(SUDOERS)).toContain("/usr/bin/ddev-hostname");
  });

  it("tolerates the docker group not existing yet", () => {
    const io = createFakeIo();

    createDdevUser(io);

    const groupAdd = io.commands.find((c) => c.includes("usermod -aG docker"))!;
    expect(groupAdd).toContain("|| true");
  });
});

describe("setupAuthorizedKeys", () => {
  it("does nothing without a key", () => {
    const io = createFakeIo();

    setupAuthorizedKeys(undefined, io);

    expect(io.commands).toEqual([]);
  });

  it("appends the key with the mode sshd requires", () => {
    const io = createFakeIo();

    setupAuthorizedKeys("ssh-ed25519 AAAA test@example.com", io);

    expect(io.ran(`chmod 600 ${AUTH_KEYS}`)).toBe(true);
    expect(io.ran(`chown ddev:ddev ${AUTH_KEYS}`)).toBe(true);
    expect(io.ran("ssh-ed25519 AAAA test@example.com")).toBe(true);
  });

  it("handles an unreadable authorized_keys as empty", () => {
    const key = "ssh-ed25519 AAAA test@example.com";
    const io = createFakeIo({ fails: ["cat "] });

    expect(() => setupAuthorizedKeys(key, io)).not.toThrow();
    expect(io.ran(`echo '${key}' >>`)).toBe(true);
  });

  it("does not append a key that is already authorized", () => {
    const key = "ssh-ed25519 AAAA test@example.com";
    const io = createFakeIo({ output: { [`cat ${AUTH_KEYS}`]: key } });

    setupAuthorizedKeys(key, io);

    expect(io.ran(`echo '${key}' >>`)).toBe(false);
  });
});
