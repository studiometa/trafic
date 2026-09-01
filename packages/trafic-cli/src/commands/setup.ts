import * as ssh from "../ssh.js";
import { info, step, success, warn, resetSteps } from "../steps.js";
import type { SetupOptions } from "../types.js";

/** Timeout for the server setup step (Docker + DDEV installs are slow). */
const SETUP_TIMEOUT_MS = 45 * 60 * 1000;

/** Node.js major version required by the agent. */
const NODE_MAJOR = 24;

/** Content of the fnm profile script, written to /etc/profile.d/fnm.sh. */
const FNM_PROFILE = [
  "# Trafic: fnm (Node.js version manager)",
  'export FNM_DIR="/opt/fnm"',
  'export PATH="/opt/fnm:$PATH"',
  'eval "$(fnm env)"',
].join("\\n");

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
 * Install Node.js via fnm, the same way the agent setup does.
 * Skipped when a recent enough Node.js is already installed.
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
      `Node.js ${version} is older than v${NODE_MAJOR} — installing v${NODE_MAJOR} via fnm`,
    );
  }

  // The fnm installer needs curl and unzip — a minimal Ubuntu image has neither
  const missing: string[] = [];

  for (const tool of ["curl", "unzip"]) {
    if (!(await ssh.test(options, `command -v ${tool}`))) {
      missing.push(tool);
    }
  }

  if (missing.length > 0) {
    info(`Missing dependencies: ${missing.join(", ")}`);
  }

  const commands = [
    ...(missing.length > 0
      ? [
          `${sudo}apt-get update -qq`,
          `${sudo}env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${["ca-certificates", ...missing].join(" ")}`,
        ]
      : []),
    // Download first: piping into `sudo bash` would hide a curl failure,
    // because the pipeline only reports the exit code of bash
    `curl -fsSL https://fnm.vercel.app/install -o /tmp/trafic-fnm-install.sh`,
    `${sudo}bash /tmp/trafic-fnm-install.sh --install-dir /opt/fnm --skip-shell`,
    `rm -f /tmp/trafic-fnm-install.sh`,
    `printf '${FNM_PROFILE}\\n' | ${sudo}tee /etc/profile.d/fnm.sh > /dev/null`,
    `${sudo}chmod 644 /etc/profile.d/fnm.sh`,
    `${sudo}env FNM_DIR=/opt/fnm /opt/fnm/fnm install ${NODE_MAJOR}`,
    `${sudo}env FNM_DIR=/opt/fnm /opt/fnm/fnm default ${NODE_MAJOR}`,
    ...["node", "npm", "npx"].map(
      (bin) =>
        `${sudo}ln -sf /opt/fnm/aliases/default/bin/${bin} /usr/local/bin/${bin}`,
    ),
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

/**
 * Install @studiometa/trafic-agent globally and return the path to its binary.
 *
 * The binary is symlinked into /usr/local/bin so that it stays on root's PATH —
 * the agent setup resolves it with `which trafic-agent` for the systemd unit.
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

  if (prefix !== "/usr/local") {
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

  if (options.sshUsers) {
    args.push(`--ssh-users=${options.sshUsers}`);
  }

  return args;
}
