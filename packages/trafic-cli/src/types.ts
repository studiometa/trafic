/**
 * SSH connection options.
 */
export interface SSHOptions {
  /** SSH host */
  host: string;
  /** SSH user (default: "ddev") */
  user: string;
  /** SSH port (default: 22) */
  port: number;
  /** Extra SSH options (e.g. "-J jump@host") */
  sshOptions: string;
  /**
   * Per-command timeout, as a duration such as "10m" or "90s".
   *
   * Applies to each remote command, not to the deploy as a whole. Raise it
   * for a step that is legitimately slow — seeding a large database, for
   * instance — since a timeout mid-import leaves the environment half-built.
   */
  timeout?: string;
}

/**
 * Setup command options.
 */
export interface SetupOptions extends SSHOptions {
  /** TLD for DDEV projects (e.g. "previews.example.com") */
  tld: string;
  /** Email for Let's Encrypt certificates */
  email?: string;
  /** Version of @studiometa/trafic-agent to install (default: "latest") */
  agentVersion: string;
  /** Whether to skip server hardening */
  noHardening: boolean;
  /** Whether to disable root SSH login entirely */
  noRootSsh: boolean;
  /** Whether to skip Docker installation */
  noDocker: boolean;
  /** Whether to skip DDEV installation */
  noDdev: boolean;
  /** SSH users to allow after hardening (comma-separated) */
  sshUsers?: string;
  /** Proxies in front of the agent, written to the generated config */
  trustedProxyHops?: string;
  /** Whether to print the remote commands without running them */
  dryRun: boolean;
}

/**
 * Deploy command options.
 */
export interface DeployOptions extends SSHOptions {
  /** Git repository URL */
  repo: string;
  /** Branch to deploy */
  branch: string;
  /** DDEV project name */
  name: string;
  /** MR/PR number for preview environments */
  preview?: string;
  /** Paths to rsync (comma-separated) */
  sync?: string;
  /** Script to run inside the DDEV container */
  script?: string;
  /**
   * Environment for the container script, as KEY=VALUE pairs.
   *
   * Only the container script sees these — before- and after-scripts run on
   * the server, outside the container, as they always have.
   */
  env?: Record<string, string>;
  /** Script to run before deploy (on server, outside container) */
  beforeScript?: string;
  /** Script to run after deploy (on server, outside container) */
  afterScript?: string;
  /**
   * Script to run only on the deploy that creates the project (on server,
   * outside container).
   *
   * For one-time setup that must not repeat: seeding a database, for
   * instance. `ddev pull` overwrites the database it imports into, so running
   * it on every deploy would discard the environment's content each time.
   */
  createScript?: string;
  /** Projects directory on the server (default: "~/www") */
  projectsDir: string;
  /** Whether to skip starting the DDEV container */
  noStart: boolean;
  /** Timeout duration (default: "10m") */
  timeout: string;
}

/**
 * Destroy command options.
 */
export interface DestroyOptions extends SSHOptions {
  /** DDEV project name */
  name: string;
  /** MR/PR number for preview environments */
  preview?: string;
  /** Projects directory on the server (default: "~/www") */
  projectsDir: string;
}

/**
 * Resolved project name (with preview prefix if applicable).
 */
export function resolveProjectName(
  name: string,
  preview?: string,
): string {
  return preview ? `preview-${preview}--${name}` : name;
}
