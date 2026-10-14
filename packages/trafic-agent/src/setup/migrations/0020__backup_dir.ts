import { BACKUP_DIR, createBackupDir, createSystemdService } from "../agent.js";
import { nodeIo, type SetupIo } from "../io.js";
import type { Migration } from "../types.js";

const UNIT_PATH = "/etc/systemd/system/trafic-agent.service";

/**
 * Migration 0020: let the agent service write to the backup directory.
 *
 * The agent now removes old backups from /var/backups/trafic in a periodic
 * sweep, but the unit runs with `ProtectSystem=strict` and only lists
 * /var/lib/trafic and /home/ddev in `ReadWritePaths`, so every removal would
 * fail with a read-only file system error.
 *
 * Creates the directory first: hardening created it, but a server set up with
 * `--no-hardening` has none, and the ddev user cannot create it in
 * /var/backups. Then rewrites the unit, which lists the directory with the
 * `-` prefix: systemd refuses to start a unit whose `ReadWritePaths` names a
 * missing path, unless the path has that prefix.
 *
 * Idempotent: the unit is rewritten only while it does not list the backup
 * directory with the `-` prefix.
 */
export const migration0020BackupDir: Migration = {
  id: "0020__backup_dir",
  description: "Let the agent service write to the backup directory",

  run(): void {
    runBackupDirMigration();
  },
};

/** The migration body, with its effects injected so tests can drive it. */
export function runBackupDirMigration(io: SetupIo = nodeIo): void {
  createBackupDir(io);

  const unitAllowsBackups =
    io.fileExists(UNIT_PATH) &&
    new RegExp(`^ReadWritePaths=.*\\s-${BACKUP_DIR}(\\s|$)`, "m").test(io.readFile(UNIT_PATH));

  if (!unitAllowsBackups) {
    // Rewrites the unit, then reloads systemd; upgrade restarts the agent
    createSystemdService(io);
  }
}
