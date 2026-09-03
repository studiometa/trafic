import * as ssh from "../ssh.js";
import { error, info, step, success, resetSteps } from "../steps.js";
import type { DeployOptions } from "../types.js";
import { resolveProjectName } from "../types.js";

/**
 * Deploy a project to a DDEV server.
 *
 * Steps:
 * 1. Clone or pull the repository
 * 2. Start DDEV container (if needed)
 * 3. Run before-script (on server, outside container)
 * 4. Rsync build artifacts
 * 5. Run script inside DDEV container
 * 6. Run after-script (on server, outside container)
 * 7. Verify deployment
 */
export async function deploy(options: DeployOptions): Promise<void> {
  resetSteps();

  const projectName = resolveProjectName(options.name, options.preview);
  const projectDir = `${options.projectsDir}/${projectName}`;

  info(`Project: ${projectName}`);
  info(`Server: ${options.user}@${options.host}:${options.port}`);
  info(`Branch: ${options.branch}`);
  info(`Directory: ${projectDir}`);

  // 1. Clone or pull
  step("Update source code");

  const exists = await ssh.test(options, `test -d ${projectDir}/.git`);

  if (exists) {
    info("Repository exists, fetching latest changes…");
    await ssh.exec(
      options,
      [
        `cd ${projectDir}`,
        `git remote set-url origin ${options.repo}`,
        `git fetch --depth=1 origin ${options.branch}`,
        `git checkout FETCH_HEAD`,
      ].join(" && "),
    );
  } else {
    info("Cloning repository…");
    await ssh.exec(
      options,
      `git clone --depth 1 --branch ${options.branch} ${options.repo} ${projectDir}`,
    );

    // Write DDEV local config for first deployment
    info("Writing DDEV local config…");
    const localConfig = [
      `name: ${projectName}`,
      "override_config: true",
      ...(await resolveRouterPorts(options)),
      "",
    ].join("\\n");

    await ssh.exec(
      options,
      [
        `cd ${projectDir}`,
        `mkdir -p .ddev`,
        `printf '${localConfig}' > .ddev/config.local.yaml`,
      ].join(" && "),
    );
  }

  // 2. Start DDEV if needed
  if (!options.noStart) {
    step("Start DDEV container");

    const statusResult = await ssh.exec(
      options,
      `cd ${projectDir} && ddev describe -j 2>/dev/null | jq -r '.raw.status // "stopped"'`,
    );

    const status = statusResult.stdout.trim();

    if (status !== "running") {
      info(`Status: ${status} — starting DDEV…`);
      await ssh.exec(options, `cd ${projectDir} && DDEV_NONINTERACTIVE=true ddev start`);
    } else {
      info("Container already running");
    }
  }

  // 3. Before script (on server, outside container)
  if (options.beforeScript) {
    step("Run before-script");
    await ssh.exec(options, `cd ${projectDir} && ${options.beforeScript}`);
  }

  // 4. Rsync build artifacts
  if (options.sync) {
    step("Sync build artifacts");

    const paths = options.sync.split(",").map((p) => p.trim());

    for (const localPath of paths) {
      const remotePath = `${projectDir}/${localPath}`;
      await ssh.rsync(localPath, remotePath, options);
    }
  }

  // 5. Script inside DDEV container
  if (options.script) {
    step("Run deploy script in DDEV container");
    await runContainerScript(options, projectDir);
  }

  // 6. After script (on server, outside container)
  if (options.afterScript) {
    step("Run after-script");
    await ssh.exec(options, `cd ${projectDir} && ${options.afterScript}`);
  }

  // 7. Verify
  step("Verify deployment");

  try {
    await ssh.exec(options, `cd ${projectDir} && ddev describe`);
  } catch {
    error("Could not verify deployment — ddev describe failed");
  }

  success(`Deployed ${projectName} from ${options.branch}`);
}

/** Name of the generated script, written into the project directory. */
const CONTAINER_SCRIPT = ".trafic-deploy.sh";

/**
 * Quote a value for a shell single-quoted string.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the deploy script inside the DDEV container.
 *
 * The script is written to a file and executed there rather than passed to
 * `ddev exec` inline. Two reasons: the environment can be exported around it,
 * and a script containing quotes no longer has to survive being nested inside
 * the remote command. The file is transferred base64-encoded, so nothing in
 * the script or the values is interpreted on the way.
 */
async function runContainerScript(
  options: DeployOptions,
  projectDir: string,
): Promise<void> {
  const env = Object.entries(options.env ?? {});

  if (env.length > 0) {
    info(`Environment: ${env.map(([key]) => key).join(", ")}`);
  }

  const script = [
    "set -o errexit",
    ...env.map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    options.script ?? "",
    "",
  ].join("\n");

  const encoded = Buffer.from(script, "utf-8").toString("base64");

  try {
    await ssh.exec(
      options,
      `cd ${projectDir} && printf %s ${encoded} | base64 -d > ${CONTAINER_SCRIPT} && chmod 600 ${CONTAINER_SCRIPT}`,
      // The payload holds the environment values
      { log: `write ${CONTAINER_SCRIPT}` },
    );

    await ssh.exec(options, `cd ${projectDir} && ddev exec bash ${CONTAINER_SCRIPT}`);
  } finally {
    // Leaving it behind would leave the values on disk
    await ssh.exec(options, `cd ${projectDir} && rm -f ${CONTAINER_SCRIPT}`);
  }
}

/**
 * Pin the project's router ports to the server's global DDEV setting.
 *
 * A project that pins its own `router_http_port` overrides the global one, and
 * DDEV then auto-assigns arbitrary free ports when the pinned pair is already
 * taken on the host. The project comes up on ports nothing is proxying to, so
 * it is unreachable — seen on a real server, where a preview landed on 33000
 * and 33001 while the router listened on 8080.
 *
 * Reading the server's value rather than assuming one keeps this correct for
 * any layout: where the router is on 80/443 the lines simply restate that.
 */
async function resolveRouterPorts(options: DeployOptions): Promise<string[]> {
  const config = await ssh.exec(
    options,
    "ddev config global 2>/dev/null || true",
    { log: "read ddev global config" },
  );

  const http = /^router-http-port=(\d+)$/m.exec(config.stdout)?.[1];
  const https = /^router-https-port=(\d+)$/m.exec(config.stdout)?.[1];

  if (!http || !https) {
    // Leave the project's own configuration alone rather than guess
    info("Could not read the router ports from the server — leaving them to DDEV");
    return [];
  }

  info(`Router ports: ${http}/${https} (from the server's global config)`);

  return [`router_http_port: "${http}"`, `router_https_port: "${https}"`];
}
