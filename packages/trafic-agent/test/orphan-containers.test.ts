import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  migration0019RecoverOrphanContainers,
  recoverOrphanContainers,
  STOP_TIMEOUT,
} from "../src/setup/migrations/0019__recover_orphan_containers.js";
import { ALL_MIGRATIONS } from "../src/setup/migrations/index.js";
import { createFakeIo } from "./helpers/fake-io.js";

const KNOWN = "a".repeat(64);
const DB = "b".repeat(64);
const WEB = "c".repeat(64);
const DEAD = "d".repeat(64);

const tasks = (...rows: string[]) => ["TASK PID STATUS", ...rows].join("\n");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("0019__recover_orphan_containers migration", () => {
  it("is registered last, after the restart in 0018", () => {
    expect(ALL_MIGRATIONS.at(-1)).toBe(migration0019RecoverOrphanContainers);
  });

  it("does nothing when Docker knows every task", () => {
    const io = createFakeIo({
      output: {
        "docker ps": KNOWN,
        "ctr -n moby tasks ls": tasks(`${KNOWN} 100 RUNNING`),
      },
    });

    recoverOrphanContainers(io);

    expect(io.ran("kill")).toBe(false);
    expect(io.ran("tasks delete")).toBe(false);
  });

  it("sends SIGTERM to the orphans only", () => {
    const io = createFakeIo({
      output: {
        "docker ps": KNOWN,
        "ctr -n moby tasks ls": tasks(`${KNOWN} 100 RUNNING`, `${DB} 200 RUNNING`),
      },
    });

    recoverOrphanContainers(io);

    expect(io.commands).toContain("kill -TERM 200");
    expect(io.ran("kill -TERM 100")).toBe(false);
  });

  it("never sends SIGKILL", () => {
    const io = createFakeIo({
      output: {
        "docker ps": KNOWN,
        "ctr -n moby tasks ls": tasks(`${DB} 200 RUNNING`),
      },
      files: { "/proc/200": "" },
    });

    recoverOrphanContainers(io);

    // A database killed mid-write is worse than the outage
    expect(io.ran("-KILL")).toBe(false);
    expect(io.ran("-9")).toBe(false);
  });

  it("waits for each orphan to stop", () => {
    const io = createFakeIo({
      output: {
        "docker ps": KNOWN,
        "ctr -n moby tasks ls": tasks(`${DB} 200 RUNNING`),
      },
    });

    recoverOrphanContainers(io);

    const term = io.commands.indexOf("kill -TERM 200");
    const wait = io.commands.indexOf(`timeout ${STOP_TIMEOUT} tail --pid=200 -f /dev/null`);
    const remove = io.commands.indexOf(`ctr -n moby tasks delete ${DB}`);
    expect(term).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(term);
    expect(remove).toBeGreaterThan(wait);
  });

  it("deletes the tasks of orphans that already stopped", () => {
    const io = createFakeIo({
      output: {
        "docker ps": KNOWN,
        "ctr -n moby tasks ls": tasks(`${DEAD} 0 STOPPED`),
      },
    });

    recoverOrphanContainers(io);

    expect(io.commands).toContain(`ctr -n moby tasks delete ${DEAD}`);
    expect(io.ran("kill")).toBe(false);
  });

  it("leaves an orphan that does not stop and still frees the others", () => {
    const io = createFakeIo({
      output: {
        "docker ps": KNOWN,
        "ctr -n moby tasks ls": tasks(`${DB} 200 RUNNING`, `${WEB} 300 RUNNING`),
      },
      files: { "/proc/200": "" },
    });

    recoverOrphanContainers(io);

    expect(io.ran(`tasks delete ${DB}`)).toBe(false);
    expect(io.commands).toContain(`ctr -n moby tasks delete ${WEB}`);
  });

  it("does nothing when containerd does not answer", () => {
    const io = createFakeIo({ output: { "docker ps": KNOWN }, fails: ["ctr"] });

    recoverOrphanContainers(io);

    expect(io.ran("kill")).toBe(false);
  });
});
