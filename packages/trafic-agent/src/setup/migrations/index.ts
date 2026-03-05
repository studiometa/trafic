import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Migration, MigrationState, MigrationListEntry } from "../types.js";
import { migration0001DdevAptRepo } from "./0001__ddev_apt_repo.js";

/** Path to the persisted migration state file */
export const MIGRATIONS_STATE_FILE = "/etc/trafic/.migrations.json";

/** Ordered registry of all known migrations */
export const ALL_MIGRATIONS: Migration[] = [migration0001DdevAptRepo];

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Load the current migration state from disk.
 * Returns an empty state if the file does not exist yet.
 */
export function loadMigrationState(): MigrationState {
  if (!existsSync(MIGRATIONS_STATE_FILE)) {
    return { applied: [] };
  }

  try {
    const raw = readFileSync(MIGRATIONS_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "applied" in parsed &&
      Array.isArray((parsed as { applied: unknown }).applied)
    ) {
      return parsed as MigrationState;
    }
  } catch {
    // Corrupted file — start fresh
  }

  return { applied: [] };
}

/**
 * Persist the migration state to disk.
 * Creates /etc/trafic/ if it does not exist.
 */
export function saveMigrationState(state: MigrationState): void {
  mkdirSync("/etc/trafic", { recursive: true });
  writeFileSync(MIGRATIONS_STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all migrations with their current status.
 */
export function listMigrations(): MigrationListEntry[] {
  const state = loadMigrationState();
  return ALL_MIGRATIONS.map((migration) => ({
    migration,
    status: state.applied.includes(migration.id) ? "applied" : "pending",
  }));
}

/**
 * Run all pending migrations and persist state after each one.
 *
 * When `dryRun` is true the runner prints what it would do without
 * executing anything or touching the state file.
 */
export function runPendingMigrations(dryRun = false): void {
  const state = loadMigrationState();
  const pending = ALL_MIGRATIONS.filter((m) => !state.applied.includes(m.id));

  if (pending.length === 0) {
    console.log("  No pending migrations.");
    return;
  }

  for (const migration of pending) {
    console.log(`\n  → \x1b[1m${migration.id}\x1b[0m  ${migration.description}`);

    if (dryRun) {
      console.log(`    \x1b[90m(dry-run: skipped)\x1b[0m`);
      continue;
    }

    migration.run();

    // Persist state immediately so a partial failure leaves a consistent state
    state.applied.push(migration.id);
    saveMigrationState(state);

    console.log(`    \x1b[32m✓ Applied\x1b[0m`);
  }
}

/**
 * Mark all known migrations as applied without running them.
 *
 * Called at the end of a fresh `setup()` run: a brand-new server has
 * already been configured correctly, so migrations that fix older
 * installations are not needed.
 */
export function markAllMigrationsApplied(): void {
  const state = loadMigrationState();

  for (const migration of ALL_MIGRATIONS) {
    if (!state.applied.includes(migration.id)) {
      state.applied.push(migration.id);
    }
  }

  saveMigrationState(state);
}
