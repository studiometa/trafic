import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ddevVersion,
  isNewer,
  runUpgrade,
  upgradeDdev,
  type UpgradeIo,
} from "../src/setup/upgrade.js";
import { commandExists, exec, execSilent } from "../src/setup/steps.js";

// `ddevVersion` and `upgradeDdev` reach for the server's own `ddev` and apt,
// which a test machine may or may not have. Only the three collaborators that
// touch the outside world are replaced; the progress logging stays real.
vi.mock("../src/setup/steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/setup/steps.js")>()),
  commandExists: vi.fn(() => false),
  exec: vi.fn(() => ""),
  execSilent: vi.fn(() => ""),
}));

// runUpgrade prints its progress; keep it out of the test output
console.log = () => {};
console.error = () => {};

describe("isNewer", () => {
  it("returns true when major is greater", () => {
    expect(isNewer("1.0.0", "2.0.0")).toBe(true);
  });

  it("returns true when minor is greater", () => {
    expect(isNewer("0.1.0", "0.2.0")).toBe(true);
  });

  it("returns true when patch is greater", () => {
    expect(isNewer("0.1.12", "0.1.13")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewer("0.1.13", "0.1.13")).toBe(false);
  });

  it("returns false when current is greater (patch)", () => {
    expect(isNewer("0.1.13", "0.1.12")).toBe(false);
  });

  it("returns false when current is greater (minor)", () => {
    expect(isNewer("0.2.0", "0.1.99")).toBe(false);
  });

  it("returns false when current is greater (major)", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(false);
  });

  it("handles v-prefixed versions", () => {
    expect(isNewer("v0.1.12", "v0.1.13")).toBe(true);
    expect(isNewer("v0.1.13", "v0.1.13")).toBe(false);
  });
});

describe("runUpgrade", () => {
  interface Recorded {
    installed: boolean[];
    reExeced: string[][];
    migrated: boolean[];
    restarted: boolean[];
    ddevUpgraded: boolean[];
    order: string[];
  }

  function fakeIo(
    overrides: Partial<UpgradeIo> = {},
  ): { io: UpgradeIo; recorded: Recorded } {
    const recorded: Recorded = {
      installed: [],
      reExeced: [],
      migrated: [],
      restarted: [],
      ddevUpgraded: [],
      order: [],
    };

    const io: UpgradeIo = {
      currentVersion: "0.1.0",
      alreadyReExeced: false,
      isRoot: () => true,
      fetchLatestVersion: () => "0.1.0",
      installLatestAgent: (dryRun) => void recorded.installed.push(dryRun),
      getInstalledVersion: () => "0.1.0",
      reExecNewBinary: ((args: string[]) => {
        recorded.reExeced.push(args);
        // The real one replaces the process; stopping here is the closest
        // a test can get without exiting the runner
        throw new Error("re-exec");
      }) as UpgradeIo["reExecNewBinary"],
      restartAgentService: (dryRun) => {
        recorded.restarted.push(dryRun);
        recorded.order.push("restart");
      },
      runPendingMigrations: (dryRun) => {
        recorded.migrated.push(dryRun);
        recorded.order.push("migrations");
      },
      ddevVersion: () => "ddev version v1.24.0",
      upgradeDdev: (dryRun) => {
        recorded.ddevUpgraded.push(dryRun);
        recorded.order.push("ddev");
      },
      ...overrides,
    };

    return { io, recorded };
  }

  it("skips the install when already up to date", () => {
    const { io, recorded } = fakeIo({ fetchLatestVersion: () => "0.1.0" });

    runUpgrade(false, undefined, io);

    expect(recorded.installed).toEqual([]);
  });

  it("still runs migrations and restarts when up to date", () => {
    // A release can add a migration without changing the agent the server
    // already runs, so these must not be skipped alongside the install
    const { io, recorded } = fakeIo();

    runUpgrade(false, undefined, io);

    expect(recorded.migrated).toEqual([false]);
    expect(recorded.restarted).toEqual([false]);
  });

  it("installs when a newer version is published", () => {
    const { io, recorded } = fakeIo({
      fetchLatestVersion: () => "0.2.0",
      getInstalledVersion: () => "0.1.0",
    });

    runUpgrade(false, undefined, io);

    expect(recorded.installed).toEqual([false]);
  });

  it("re-execs the new binary so it runs its own migrations", () => {
    // The running process only knows the migrations it was compiled with
    const { io, recorded } = fakeIo({
      fetchLatestVersion: () => "0.2.0",
      getInstalledVersion: () => "0.2.0",
    });

    expect(() => runUpgrade(false, ["upgrade"], io)).toThrow("re-exec");
    expect(recorded.reExeced).toEqual([["upgrade"]]);
  });

  it("does not re-exec when npm left the old version in place", () => {
    // npm can serve a stale cache; re-execing the same binary would loop
    const { io, recorded } = fakeIo({
      fetchLatestVersion: () => "0.2.0",
      getInstalledVersion: () => "0.1.0",
    });

    runUpgrade(false, undefined, io);

    expect(recorded.reExeced).toEqual([]);
    expect(recorded.migrated).toEqual([false]);
  });

  it("does not re-exec twice", () => {
    const { io, recorded } = fakeIo({
      alreadyReExeced: true,
      fetchLatestVersion: () => "0.2.0",
      getInstalledVersion: () => "0.2.0",
    });

    runUpgrade(false, undefined, io);

    expect(recorded.reExeced).toEqual([]);
  });

  it("carries on when the registry cannot be reached", () => {
    // An unreachable registry must not stop migrations that are already due
    const { io, recorded } = fakeIo({ fetchLatestVersion: () => null });

    runUpgrade(false, undefined, io);

    expect(recorded.installed).toEqual([]);
    expect(recorded.migrated).toEqual([false]);
    expect(recorded.restarted).toEqual([false]);
  });

  it("never re-execs in dry-run mode", () => {
    const { io, recorded } = fakeIo({
      fetchLatestVersion: () => "0.2.0",
      getInstalledVersion: () => "0.2.0",
    });

    runUpgrade(true, undefined, io);

    expect(recorded.reExeced).toEqual([]);
    expect(recorded.installed).toEqual([true]);
    expect(recorded.migrated).toEqual([true]);
    expect(recorded.restarted).toEqual([true]);
  });

  it("updates DDEV after the migrations and before the restart", () => {
    const { io, recorded } = fakeIo();

    runUpgrade(false, undefined, io);

    expect(recorded.ddevUpgraded).toEqual([false]);
    expect(recorded.order).toEqual(["migrations", "ddev", "restart"]);
  });

  it("skips the DDEV update when DDEV is not installed", () => {
    const { io, recorded } = fakeIo({ ddevVersion: () => null });

    runUpgrade(false, undefined, io);

    expect(recorded.ddevUpgraded).toEqual([]);
    expect(recorded.restarted).toEqual([false]);
  });

  it("warns on a failed DDEV update and still restarts the service", () => {
    // An apt failure must not cost the server its restart
    const { io, recorded } = fakeIo({
      upgradeDdev: () => {
        throw new Error("apt-get failed");
      },
    });

    runUpgrade(false, undefined, io);

    expect(recorded.restarted).toEqual([false]);
  });

  it("shows the DDEV commands in dry-run without probing for ddev", () => {
    const { io, recorded } = fakeIo();

    runUpgrade(true, undefined, io);

    expect(recorded.ddevUpgraded).toEqual([true]);
  });

  it("runs as a non-root dry-run without exiting", () => {
    const { io, recorded } = fakeIo({ isRoot: () => false });

    runUpgrade(true, undefined, io);

    expect(recorded.migrated).toEqual([true]);
  });
});

describe("ddevVersion", () => {
  beforeEach(() => {
    vi.mocked(commandExists).mockReset().mockReturnValue(false);
    vi.mocked(execSilent).mockReset().mockReturnValue("");
  });

  it("returns null when ddev is not on the server", () => {
    expect(ddevVersion()).toBeNull();
    expect(execSilent).not.toHaveBeenCalled();
  });

  it("returns the first line reported by ddev --version", () => {
    vi.mocked(commandExists).mockReturnValue(true);
    vi.mocked(execSilent).mockReturnValue("ddev version v1.24.3");

    expect(ddevVersion()).toBe("ddev version v1.24.3");
  });

  it("returns null when ddev is installed but reports nothing", () => {
    // execSilent swallows a failing command and hands back an empty string
    vi.mocked(commandExists).mockReturnValue(true);
    vi.mocked(execSilent).mockReturnValue("");

    expect(ddevVersion()).toBeNull();
  });
});

describe("upgradeDdev", () => {
  beforeEach(() => {
    vi.mocked(exec).mockReset().mockReturnValue("");
  });

  it("refreshes the apt lists before upgrading", () => {
    upgradeDdev(false);

    const commands = vi.mocked(exec).mock.calls.map((call) => String(call[0]));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("apt-get update");
    expect(commands[1]).toContain("apt-get install -y --only-upgrade ddev");
  });

  it("never installs DDEV on a server that does not have it", () => {
    // `--only-upgrade` is what keeps this from adding DDEV to a plain server
    upgradeDdev(false);

    const install = String(vi.mocked(exec).mock.calls[1]?.[0]);
    expect(install).toContain("--only-upgrade");
  });

  it("answers apt prompts for itself", () => {
    upgradeDdev(false);

    for (const call of vi.mocked(exec).mock.calls) {
      expect(String(call[0])).toContain("DEBIAN_FRONTEND=noninteractive");
      expect(String(call[0])).toContain("NEEDRESTART_MODE=a");
    }
  });

  it("shows the commands in dry-run instead of hiding them", () => {
    upgradeDdev(true);

    for (const call of vi.mocked(exec).mock.calls) {
      expect(call[1]).toEqual({ silent: false });
    }
  });
});
