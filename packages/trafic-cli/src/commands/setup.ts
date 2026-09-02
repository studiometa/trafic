import * as ssh from "../ssh.js";
import { info, step, success, warn, resetSteps } from "../steps.js";
import type { SetupOptions } from "../types.js";

/** Timeout for the server setup step (Docker + DDEV installs are slow). */
const SETUP_TIMEOUT_MS = 45 * 60 * 1000;

/** Node.js major version required by the agent. */
const NODE_MAJOR = 24;

/** SSH user allowed after hardening when --ssh-users is not given. */
const DEFAULT_SSH_USER = "ddev";

/** NodeSource apt repository — nodejs.org points here for apt installs. */
const NODESOURCE_REPO_URL = "https://deb.nodesource.com";
const NODESOURCE_KEY_URL = `${NODESOURCE_REPO_URL}/gpgkey/nodesource-repo.gpg.key`;
const NODESOURCE_KEYRING = "/etc/apt/keyrings/nodesource.gpg";
const KEY_TMP = "/tmp/trafic-nodesource.key";
const KEYRING_TMP = "/tmp/trafic-nodesource.gpg";

/**
 * Setup a new server: bootstrap Node.js, install the Trafic agent,
 * then run `trafic-agent setup` on the server.
 *
 * Steps:
 * 1. Check the server (OS, privileges)
 * 2. Install Node.js (skipped when already present)
 * 3. Install the Trafic agent
 * 4. Run the agent setup (Docker, DDEV, Traefik, systemd, hardening)
 * 5. Verify the agent service
 */
export async function setup(options: SetupOptions): Promise<void> {
  resetSteps();

  info(`Server: ${options.user}@${options.host}:${options.port}`);
  info(`TLD: ${options.tld}`);
  info(`Agent version: ${options.agentVersion}`);

  if (!options.noHardening) {
    const sshUsers = resolveSshUsers(options);
    info(`SSH access after hardening: root, ${sshUsers.join(", ")}`);

    if (!options.sshUsers && options.user !== "root") {
      info(`  ${options.user} added automatically — it is the user you connect as`);
    }
  }

  if (options.dryRun) {
    warn("Dry-run mode: no changes will be made on the server");
  }

  // 1. Check the server
  step("Check the server");

  const os = await ssh.exec(options, "cat /etc/os-release");
  const prettyName = /^PRETTY_NAME="?(.*?)"?$/m.exec(os.stdout)?.[1];

  if (prettyName) {
    info(`OS: ${prettyName}`);

    if (!/ubuntu/i.test(prettyName)) {
      warn(`Trafic targets Ubuntu 24.04 LTS — ${prettyName} is untested`);
    }
  }

  const sudo = await resolveSudo(options);

  // 2. Install Node.js
  step("Install Node.js");

  await installNode(options, sudo);

  // 3. Install the Trafic agent
  step("Install the Trafic agent");

  const agentBin = await installAgent(options, sudo);

  // 4. Run the agent setup
  step("Setup the server");

  const setupCommand = `${sudo}${agentBin} setup ${buildAgentSetupArgs(options).join(" ")}`;

  if (options.dryRun) {
    info(setupCommand);
  } else {
    await ssh.exec(options, setupCommand, SETUP_TIMEOUT_MS);
  }

  // 5. Verify the agent service
  step("Verify the agent service");

  if (options.dryRun) {
    info("Skipped (dry-run)");
  } else {
    const active = await ssh.test(
      options,
      "systemctl is-active --quiet trafic-agent",
    );

    if (active) {
      info("trafic-agent service is active");
    } else {
      warn(
        "trafic-agent service is not active — check `journalctl -u trafic-agent -n 50`",
      );
    }
  }

  if (options.dryRun) {
    success(`Dry-run complete — ${options.host} was not modified`);
    return;
  }

  success(`Server ${options.host} is set up`);

  console.log("");
  info("Next steps:");
  info(`  1. Point wildcard DNS *.${options.tld} to this server`);
  info("  2. Edit /etc/trafic/config.toml to configure authentication");
  info("  3. Add CI SSH public keys to /home/ddev/.ssh/authorized_keys");
  info("  4. Deploy a project:");
  info(
    `     npx @studiometa/trafic-cli deploy --host=${options.host} --name=my-app`,
  );
}

/**
 * Resolve the prefix needed to run privileged commands.
 * Returns an empty string when the SSH user is already root.
 */
async function resolveSudo(options: SetupOptions): Promise<string> {
  const uid = await ssh.exec(options, "id -u");

  if (uid.stdout.trim() === "0") {
    info("Privileges: root");
    return "";
  }

  const canSudo = await ssh.test(options, "sudo -n true");

  if (!canSudo) {
    throw new Error(
      `User ${options.user} is not root and has no passwordless sudo on ${options.host}. ` +
        "Connect as root (--user root) or grant passwordless sudo — SSH runs in batch mode, " +
        "so a password prompt cannot be answered.",
    );
  }

  info(`Privileges: sudo as ${options.user}`);

  return "sudo -n ";
}

/**
 * Install Node.js from the NodeSource apt repository, the same way the agent
 * setup does. Skipped when a recent enough Node.js is already installed.
 *
 * apt puts node and npm in /usr/bin and keeps them patched through
 * unattended-upgrades, which the hardening step configures.
 */
async function installNode(
  options: SetupOptions,
  sudo: string,
): Promise<void> {
  const hasNode = await ssh.test(options, "command -v node");

  if (hasNode) {
    const version = (await ssh.exec(options, "node --version")).stdout.trim();
    const major = Number.parseInt(version.replace(/^v/, ""), 10);

    if (Number.isNaN(major) || major >= NODE_MAJOR) {
      info(`Node.js already installed: ${version}`);
      return;
    }

    warn(
      `Node.js ${version} is older than v${NODE_MAJOR} — installing v${NODE_MAJOR} from apt`,
    );
  }

  // A minimal Ubuntu image ships with none of these
  const missing: string[] = [];

  for (const tool of ["curl", "gpg"]) {
    if (!(await ssh.test(options, `command -v ${tool}`))) {
      missing.push(tool === "gpg" ? "gnupg" : tool);
    }
  }

  if (missing.length > 0) {
    info(`Missing dependencies: ${missing.join(", ")}`);
  }

  // NEEDRESTART_MODE=a: needrestart otherwise prompts, and SSH runs in batch
  // mode, so an interactive prompt would hang the whole setup
  const apt = `${sudo}env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get`;

  const commands = [
    `${sudo}apt-get update -qq`,
    ...(missing.length > 0
      ? [`${apt} install -y -qq ${["ca-certificates", ...missing].join(" ")}`]
      : []),
    `${sudo}install -m 0755 -d /etc/apt/keyrings`,
    // Download and dearmor as separate commands: piping curl into gpg into
    // tee would report only tee's exit code and hide a failed key download,
    // which then surfaces as a confusing GPG error on the next apt-get update
    `curl -fsSL ${NODESOURCE_KEY_URL} -o ${KEY_TMP}`,
    `gpg --batch --yes --dearmor -o ${KEYRING_TMP} ${KEY_TMP}`,
    `${sudo}install -m 0644 ${KEYRING_TMP} ${NODESOURCE_KEYRING}`,
    `rm -f ${KEY_TMP} ${KEYRING_TMP}`,
    `echo "deb [signed-by=${NODESOURCE_KEYRING}] ${NODESOURCE_REPO_URL}/node_${NODE_MAJOR}.x nodistro main" | ${sudo}tee /etc/apt/sources.list.d/nodesource.list > /dev/null`,
    `${sudo}apt-get update -qq`,
    `${apt} install -y nodejs`,
  ];

  for (const command of commands) {
    if (options.dryRun) {
      info(command);
    } else {
      await ssh.exec(options, command);
    }
  }

  if (!options.dryRun) {
    const version = (await ssh.exec(options, "node --version")).stdout.trim();
    info(`Node.js installed: ${version}`);
  }
}

/** npm global prefixes whose bin directory is already on root's PATH. */
const ROOT_PATH_PREFIXES = ["/usr", "/usr/local"];

/**
 * Install @studiometa/trafic-agent globally and return the path to its binary.
 *
 * The agent setup resolves the binary with `which trafic-agent` for the systemd
 * unit, so it has to sit on root's PATH. An apt Node.js puts it in /usr/bin
 * already; a version manager prefix does not, so link it into /usr/local/bin.
 */
async function installAgent(
  options: SetupOptions,
  sudo: string,
): Promise<string> {
  const npm = (await ssh.exec(options, "command -v npm || true")).stdout.trim();

  if (!npm) {
    if (options.dryRun) {
      info("npm not found — it would be installed by the previous step");
      return "trafic-agent";
    }

    throw new Error("npm not found on the server after installing Node.js");
  }

  const install = `${sudo}${npm} install -g @studiometa/trafic-agent@${options.agentVersion}`;

  if (options.dryRun) {
    info(install);
    return "trafic-agent";
  }

  await ssh.exec(options, install);

  const prefix = (await ssh.exec(options, `${npm} prefix -g`)).stdout.trim();
  const agentBin = `${prefix}/bin/trafic-agent`;

  if (!ROOT_PATH_PREFIXES.includes(prefix)) {
    info(`npm prefix ${prefix} is not on root's PATH — linking the binary`);
    await ssh.exec(
      options,
      `${sudo}ln -sf ${agentBin} /usr/local/bin/trafic-agent`,
    );
  }

  info(`Agent installed: ${agentBin}`);

  return agentBin;
}

/**
 * Build the argument list forwarded to `trafic-agent setup`.
 */
function buildAgentSetupArgs(options: SetupOptions): string[] {
  const args = [`--tld=${options.tld}`];

  if (options.email) {
    args.push(`--email=${options.email}`);
  }

  if (options.noHardening) {
    args.push("--no-hardening");
  }

  if (options.noDocker) {
    args.push("--no-docker");
  }

  if (options.noDdev) {
    args.push("--no-ddev");
  }

  // Always explicit, so a dry-run shows exactly who will keep SSH access
  args.push(`--ssh-users=${resolveSshUsers(options).join(",")}`);

  return args;
}

/**
 * Resolve the SSH users allowed after hardening.
 *
 * The user running the setup is always included. Hardening writes an
 * `AllowUsers` directive, so leaving that user out locks them out on their
 * next connection — with no warning, because reloading sshd keeps the
 * current session alive. root needs no entry: the agent always allows it.
 */
export function resolveSshUsers(options: SetupOptions): string[] {
  const users = (options.sshUsers ?? DEFAULT_SSH_USER)
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);

  if (options.user !== "root" && !users.includes(options.user)) {
    users.push(options.user);
  }

  return users;
}
