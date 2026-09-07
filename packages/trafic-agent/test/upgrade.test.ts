import { describe, it, expect } from "vitest";
import { isNewer, runUpgrade, type UpgradeIo } from "../src/setup/upgrade.js";

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
  }

  function fakeIo(
    overrides: Partial<UpgradeIo> = {},
  ): { io: UpgradeIo; recorded: Recorded } {
    const recorded: Recorded = {
      installed: [],
      reExeced: [],
      migrated: [],
      restarted: [],
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
      restartAgentService: (dryRun) => void recorded.restarted.push(dryRun),
      runPendingMigrations: (dryRun) => void recorded.migrated.push(dryRun),
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

  it("runs as a non-root dry-run without exiting", () => {
    const { io, recorded } = fakeIo({ isRoot: () => false });

    runUpgrade(true, undefined, io);

    expect(recorded.migrated).toEqual([true]);
  });
});
