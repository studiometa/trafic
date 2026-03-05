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
  /** Script to run before deploy (on server, outside container) */
  beforeScript?: string;
  /** Script to run after deploy (on server, outside container) */
  afterScript?: string;
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
  /** Skip backup before destroy (default: false) */
  noBackup: boolean;
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
