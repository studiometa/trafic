import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMigrations,
  ALL_MIGRATIONS,
  MIGRATIONS_STATE_FILE,
} from "../src/setup/migrations/index.js";
import { migration0001DdevAptRepo } from "../src/setup/migrations/0001__ddev_apt_repo.js";

// ---------------------------------------------------------------------------
// Temp-dir helper
// ---------------------------------------------------------------------------

function useTempDir(): { dir: string } {
  const ref = { dir: "" };

  beforeEach(() => {
    ref.dir = join(
      tmpdir(),
      `trafic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(ref.dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(ref.dir, { recursive: true, force: true });
  });

  return ref;
}

// ---------------------------------------------------------------------------
// State file constant
// ---------------------------------------------------------------------------

describe("MIGRATIONS_STATE_FILE", () => {
  it("points to the expected path", () => {
    expect(MIGRATIONS_STATE_FILE).toBe("/etc/trafic/.migrations.json");
  });
});

// ---------------------------------------------------------------------------
// State round-trip (without writing to /etc/trafic)
// ---------------------------------------------------------------------------

describe("migration state JSON format", () => {
  const tmp = useTempDir();

  it("can be serialised and deserialised correctly", () => {
    const stateFile = join(tmp.dir, ".migrations.json");
    const state = { applied: ["0001__ddev_apt_repo"] };

    writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");

    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as { applied: string[] };

    expect(parsed.applied).toEqual(["0001__ddev_apt_repo"]);
  });

  it("handles an empty applied list", () => {
    const stateFile = join(tmp.dir, ".migrations.json");
    const state = { applied: [] };

    writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf-8");

    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as { applied: string[] };

    expect(parsed.applied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ALL_MIGRATIONS registry
// ---------------------------------------------------------------------------

describe("ALL_MIGRATIONS", () => {
  it("is a non-empty ordered array", () => {
    expect(Array.isArray(ALL_MIGRATIONS)).toBe(true);
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it("each migration has id, description and run()", () => {
    for (const m of ALL_MIGRATIONS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.description).toBe("string");
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.run).toBe("function");
    }
  });

  it("migration IDs are unique", () => {
    const ids = ALL_MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("first migration is 0001__ddev_apt_repo", () => {
    expect(ALL_MIGRATIONS[0].id).toBe("0001__ddev_apt_repo");
  });
});

// ---------------------------------------------------------------------------
// Pending-detection logic (pure, no I/O)
// ---------------------------------------------------------------------------

describe("pending migration detection", () => {
  it("detects pending migrations when none have been applied", () => {
    const migrations = [
      { id: "test__alpha", description: "Alpha", run: () => {} },
      { id: "test__beta", description: "Beta", run: () => {} },
    ];
    const state = { applied: [] as string[] };
    const pending = migrations.filter((m) => !state.applied.includes(m.id));

    expect(pending.map((m) => m.id)).toEqual(["test__alpha", "test__beta"]);
  });

  it("excludes already-applied migrations from the pending list", () => {
    const migrations = [
      { id: "test__alpha", description: "Alpha", run: () => {} },
      { id: "test__beta", description: "Beta", run: () => {} },
    ];
    const state = { applied: ["test__alpha"] };
    const pending = migrations.filter((m) => !state.applied.includes(m.id));

    expect(pending.map((m) => m.id)).toEqual(["test__beta"]);
  });

  it("returns no pending migrations when all are applied", () => {
    const migrations = [
      { id: "test__alpha", description: "Alpha", run: () => {} },
    ];
    const state = { applied: ["test__alpha"] };
    const pending = migrations.filter((m) => !state.applied.includes(m.id));

    expect(pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Runner logic (pure, no I/O)
// ---------------------------------------------------------------------------

describe("migration runner logic", () => {
  it("calls run() for each pending migration", () => {
    const ranIds: string[] = [];

    const migrations = [
      { id: "test__alpha", description: "Alpha", run: () => { ranIds.push("test__alpha"); } },
      { id: "test__beta", description: "Beta", run: () => { ranIds.push("test__beta"); } },
    ];

    const state = { applied: ["test__alpha"] };
    const pending = migrations.filter((m) => !state.applied.includes(m.id));

    for (const m of pending) {
      m.run();
      state.applied.push(m.id);
    }

    expect(ranIds).toEqual(["test__beta"]);
    expect(state.applied).toEqual(["test__alpha", "test__beta"]);
  });

  it("dry-run skips run() and does not update state", () => {
    const ranIds: string[] = [];
    const dryRun = true;

    const migrations = [
      { id: "test__alpha", description: "Alpha", run: () => { ranIds.push("test__alpha"); } },
    ];

    const state = { applied: [] as string[] };
    const pending = migrations.filter((m) => !state.applied.includes(m.id));

    for (const m of pending) {
      if (!dryRun) {
        m.run();
        state.applied.push(m.id);
      }
    }

    expect(ranIds).toEqual([]);
    expect(state.applied).toEqual([]);
  });

  it("persists state after each migration (partial-failure safety)", () => {
    const persisted: string[][] = [];

    const migrations = [
      { id: "test__alpha", description: "Alpha", run: () => {} },
      { id: "test__beta", description: "Beta", run: () => {} },
    ];

    const state = { applied: [] as string[] };

    for (const m of migrations) {
      m.run();
      state.applied.push(m.id);
      // Capture a snapshot as if we had written the state to disk
      persisted.push([...state.applied]);
    }

    // After first migration: only alpha written
    expect(persisted[0]).toEqual(["test__alpha"]);
    // After second migration: both written
    expect(persisted[1]).toEqual(["test__alpha", "test__beta"]);
  });
});

// ---------------------------------------------------------------------------
// markAllMigrationsApplied logic
// ---------------------------------------------------------------------------

describe("markAllMigrationsApplied logic", () => {
  it("adds all migration IDs to applied without duplicates", () => {
    const allIds = ALL_MIGRATIONS.map((m) => m.id);
    const state = { applied: [] as string[] };

    for (const migration of ALL_MIGRATIONS) {
      if (!state.applied.includes(migration.id)) {
        state.applied.push(migration.id);
      }
    }

    expect(state.applied).toEqual(allIds);
    expect(new Set(state.applied).size).toBe(state.applied.length);
  });

  it("does not duplicate already-applied migrations (idempotent)", () => {
    const allIds = ALL_MIGRATIONS.map((m) => m.id);
    const state = { applied: [...allIds] };

    // Apply again
    for (const migration of ALL_MIGRATIONS) {
      if (!state.applied.includes(migration.id)) {
        state.applied.push(migration.id);
      }
    }

    expect(state.applied.length).toBe(allIds.length);
  });

  it("works with a partially-applied state", () => {
    const allIds = ALL_MIGRATIONS.map((m) => m.id);
    // Start with the first migration already applied
    const state = { applied: [allIds[0]] };

    for (const migration of ALL_MIGRATIONS) {
      if (!state.applied.includes(migration.id)) {
        state.applied.push(migration.id);
      }
    }

    expect(state.applied).toEqual(allIds);
  });
});

// ---------------------------------------------------------------------------
// listMigrations
// ---------------------------------------------------------------------------

describe("listMigrations", () => {
  it("returns an entry for every migration in ALL_MIGRATIONS", () => {
    const entries = listMigrations();
    expect(entries.length).toBe(ALL_MIGRATIONS.length);
  });

  it("each entry has migration and status fields", () => {
    const entries = listMigrations();
    for (const entry of entries) {
      expect(entry.migration).toBeDefined();
      expect(["applied", "pending"]).toContain(entry.status);
    }
  });

  it("migration IDs in entries match ALL_MIGRATIONS order", () => {
    const entries = listMigrations();
    const entryIds = entries.map((e) => e.migration.id);
    const allIds = ALL_MIGRATIONS.map((m) => m.id);
    expect(entryIds).toEqual(allIds);
  });
});

// ---------------------------------------------------------------------------
// 0001__ddev_apt_repo migration definition
// ---------------------------------------------------------------------------

describe("0001__ddev_apt_repo migration", () => {
  it("has the correct id", () => {
    expect(migration0001DdevAptRepo.id).toBe("0001__ddev_apt_repo");
  });

  it("has a non-empty description", () => {
    expect(migration0001DdevAptRepo.description.length).toBeGreaterThan(0);
  });

  it("exposes a run() function", () => {
    expect(typeof migration0001DdevAptRepo.run).toBe("function");
  });
});
