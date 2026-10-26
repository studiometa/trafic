import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ddevVersion,
  downloadDdevImages,
  isNewer,
  restartProject,
  runUpgrade,
  upgradeDdev,
  type ProjectStatuses,
  type UpgradeIo,
} from "../src/setup/upgrade.js";
import { exec, execSilent } from "../src/setup/steps.js";
import type { ProjectRecord } from "../src/types.js";

// `ddevVersion` and `upgradeDdev` run package and apt commands that must not
// reach the test machine. The progress logging stays real.
vi.mock("../src/setup/steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/setup/steps.js")>()),
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
    downloaded: string[][];
    projectsRestarted: string[];
    /** Each status change, as "name:status" */
    statuses: string[];
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
      downloaded: [],
      projectsRestarted: [],
      statuses: [],
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
      listRunningProjects: () => ["app-a", "app-b"],
      downloadDdevImages: (projects) => {
        recorded.downloaded.push(projects);
        recorded.order.push("download");
      },
      restartProject: (name) => {
        recorded.projectsRestarted.push(name);
        recorded.order.push(`restart ${name}`);
      },
      openProjectStatuses: () => fakeStatuses(recorded),
      ...overrides,
    };

    return { io, recorded };
  }

  function fakeStatuses(
    recorded: Recorded,
    initial: Record<string, ProjectRecord["status"]> = {},
  ): ProjectStatuses {
    const rows = new Map(Object.entries(initial));

    return {
      get: (name) => rows.get(name),
      set: (name, status) => {
        rows.set(name, status);
        recorded.statuses.push(`${name}:${status}`);
        recorded.order.push(`${name}:${status}`);
      },
      close: () => void recorded.order.push("close"),
    };
  }

  /** A DDEV version that changes with the apt upgrade. */
  function ddevUpdates(): () => string {
    let calls = 0;
    return () => (calls++ === 0 ? "1.25.4" : "1.25.5");
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

  describe("restart of the running projects", () => {
    it("restarts nothing when the DDEV version did not change", () => {
      const { io, recorded } = fakeIo({ ddevVersion: () => "1.25.4" });

      runUpgrade(false, undefined, io);

      expect(recorded.downloaded).toEqual([]);
      expect(recorded.projectsRestarted).toEqual([]);
      expect(recorded.restarted).toEqual([false]);
    });

    it("restarts nothing when apt fails", () => {
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        upgradeDdev: () => {
          throw new Error("apt-get failed");
        },
      });

      runUpgrade(false, undefined, io);

      expect(recorded.projectsRestarted).toEqual([]);
      expect(recorded.restarted).toEqual([false]);
    });

    it("restarts the running projects only, one at a time", () => {
      // listRunningProjects gives the running ones; stopped and paused
      // projects get the new images at their next start
      const { io, recorded } = fakeIo({ ddevVersion: ddevUpdates() });

      runUpgrade(false, undefined, io);

      expect(recorded.projectsRestarted).toEqual(["app-a", "app-b"]);
    });

    it("downloads the images before the first restart, and restarts the service last", () => {
      const { io, recorded } = fakeIo({ ddevVersion: ddevUpdates() });

      runUpgrade(false, undefined, io);

      expect(recorded.downloaded).toEqual([["app-a", "app-b"]]);
      expect(recorded.order.filter((entry) => !entry.includes(":"))).toEqual([
        "migrations",
        "ddev",
        "download",
        "restart app-a",
        "restart app-b",
        "close",
        "restart",
      ]);
    });

    it("still restarts the projects when the image download fails", () => {
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        downloadDdevImages: () => {
          throw new Error("pull failed");
        },
      });

      runUpgrade(false, undefined, io);

      expect(recorded.projectsRestarted).toEqual(["app-a", "app-b"]);
    });

    it("marks each project starting during its restart, then running", () => {
      const { io, recorded } = fakeIo({ ddevVersion: ddevUpdates() });

      runUpgrade(false, undefined, io);

      expect(recorded.order.slice(recorded.order.indexOf("download") + 1, -2)).toEqual([
        "app-a:starting",
        "restart app-a",
        "app-a:running",
        "app-b:starting",
        "restart app-b",
        "app-b:running",
      ]);
    });

    it("continues after a failed restart and lists the failure", () => {
      const logs: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        listRunningProjects: () => ["app-a", "app-b", "app-c"],
        restartProject: (name) => {
          recorded.projectsRestarted.push(name);
          if (name === "app-b") {
            throw new Error("ddev restart failed");
          }
        },
      });

      runUpgrade(false, undefined, io);
      log.mockRestore();

      expect(recorded.projectsRestarted).toEqual(["app-a", "app-b", "app-c"]);
      expect(recorded.restarted).toEqual([false]);
      expect(logs.some((line) => line.includes("Failed to restart: app-b"))).toBe(true);
    });

    it("sets a project back to running after a failed restart", () => {
      // It ran before; the idle sweep checks it against DDEV from there
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        listRunningProjects: () => ["app-a"],
        restartProject: () => {
          throw new Error("ddev restart failed");
        },
      });

      runUpgrade(false, undefined, io);

      expect(recorded.statuses).toEqual(["app-a:starting", "app-a:running"]);
    });

    it("skips a project that the agent is starting or removing", () => {
      const recordedStatuses: Recorded["statuses"] = [];
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        listRunningProjects: () => ["app-a", "app-b", "app-c"],
      });
      io.openProjectStatuses = () =>
        fakeStatuses(
          { ...recorded, statuses: recordedStatuses },
          { "app-a": "starting", "app-b": "destroying", "app-c": "running" },
        );

      runUpgrade(false, undefined, io);

      expect(recorded.projectsRestarted).toEqual(["app-c"]);
      expect(recordedStatuses).toEqual(["app-c:starting", "app-c:running"]);
    });

    it("restarts without the status guard when the database cannot be opened", () => {
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        openProjectStatuses: () => {
          throw new Error("/var/lib/trafic/db.sqlite does not exist");
        },
      });

      runUpgrade(false, undefined, io);

      expect(recorded.projectsRestarted).toEqual(["app-a", "app-b"]);
      expect(recorded.statuses).toEqual([]);
    });

    it("does nothing when no project runs", () => {
      const opened = vi.fn();
      const { io, recorded } = fakeIo({
        ddevVersion: ddevUpdates(),
        listRunningProjects: () => [],
        openProjectStatuses: opened,
      });

      runUpgrade(false, undefined, io);

      expect(recorded.downloaded).toEqual([]);
      expect(opened).not.toHaveBeenCalled();
    });

    it("lists the projects in dry-run mode and changes nothing", () => {
      const logs: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
      const opened = vi.fn();
      const { io, recorded } = fakeIo({ openProjectStatuses: opened });

      runUpgrade(true, undefined, io);
      log.mockRestore();

      expect(recorded.downloaded).toEqual([]);
      expect(recorded.projectsRestarted).toEqual([]);
      expect(opened).not.toHaveBeenCalled();
      expect(logs.some((line) => line.includes("app-a, app-b"))).toBe(true);
    });

    it("does not list the projects in a non-root dry-run", () => {
      // `su - ddev` would ask for a password
      const listed = vi.fn(() => ["app-a"]);
      const { io } = fakeIo({ isRoot: () => false, listRunningProjects: listed });

      runUpgrade(true, undefined, io);

      expect(listed).not.toHaveBeenCalled();
    });
  });
});

describe("ddevVersion", () => {
  beforeEach(() => {
    vi.mocked(execSilent).mockReset().mockReturnValue("");
  });

  it("returns the installed apt package version", () => {
    vi.mocked(execSilent).mockReturnValue("1.25.3");

    expect(ddevVersion()).toBe("1.25.3");
    expect(execSilent).toHaveBeenCalledWith("dpkg-query --show --showformat='${Version}' ddev");
  });

  it("returns null when the DDEV package is not installed", () => {
    // execSilent swallows a failing command and hands back an empty string
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

describe("downloadDdevImages", () => {
  beforeEach(() => {
    vi.mocked(exec).mockReset().mockReturnValue("");
  });

  it("downloads the images of the projects as the ddev user", () => {
    // DDEV refuses to run as root
    downloadDdevImages(["app-a", "app-b"]);

    expect(exec).toHaveBeenCalledWith(
      "su - ddev -c 'DDEV_NONINTERACTIVE=true ddev utility download-images app-a app-b'",
      { silent: true },
    );
  });

  it("refuses a name that is not safe in a shell command", () => {
    expect(() => downloadDdevImages(["app-a", "x'; rm -rf / #"])).toThrow("Invalid project name");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("restartProject", () => {
  beforeEach(() => {
    vi.mocked(exec).mockReset().mockReturnValue("");
  });

  it("restarts one project as the ddev user", () => {
    restartProject("app-a");

    expect(exec).toHaveBeenCalledWith(
      "su - ddev -c 'DDEV_NONINTERACTIVE=true ddev restart app-a'",
      { silent: true },
    );
  });

  it("refuses a name that is not safe in a shell command", () => {
    expect(() => restartProject("$(reboot)")).toThrow("Invalid project name");
    expect(() => restartProject("")).toThrow("Invalid project name");
    expect(exec).not.toHaveBeenCalled();
  });
});
