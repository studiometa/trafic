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
    await ssh.exec(
      options,
      [
        `cd ${projectDir}`,
        `mkdir -p .ddev`,
        `printf 'name: ${projectName}\\noverride_config: true\\n' > .ddev/config.local.yaml`,
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
      await ssh.exec(options, `cd ${projectDir} && ddev start`);
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
    await ssh.exec(
      options,
      `cd ${projectDir} && ddev exec "${options.script}"`,
    );
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
