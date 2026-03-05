/**
 * A versioned server migration
 */
export interface Migration {
  /** Unique identifier, e.g. "0001__ddev_apt_repo" */
  id: string;
  /** Human-readable description shown in --list output and on run */
  description: string;
  /** Run the migration. Must be idempotent and non-interactive. */
  run(): void;
}

/**
 * Persisted migration state stored in /etc/trafic/.migrations.json
 */
export interface MigrationState {
  /** Ordered list of applied migration IDs */
  applied: string[];
}

/**
 * Entry returned by listMigrations()
 */
export interface MigrationListEntry {
  migration: Migration;
  status: "applied" | "pending";
}

/**
 * Setup command options
 */
export interface SetupOptions {
  /** TLD for DDEV projects (required) */
  tld: string;
  /** Email for Let's Encrypt certificates */
  email?: string;
  /** Skip hardening steps */
  noHardening?: boolean;
  /** Skip Docker installation (already installed) */
  noDocker?: boolean;
  /** Skip DDEV installation (already installed) */
  noDdev?: boolean;
  /** Additional SSH users to allow */
  sshUsers?: string[];
  /** Run in dry-run mode (show what would be done) */
  dryRun?: boolean;
}

/**
 * Step result
 */
export interface StepResult {
  success: boolean;
  message?: string;
  skipped?: boolean;
}

/**
 * Audit check result
 */
export interface AuditCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}
