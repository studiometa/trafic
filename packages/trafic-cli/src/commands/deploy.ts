import * as ssh from "../ssh.js";
import { error, info, warn, step, success, resetSteps } from "../steps.js";
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
export async function deploy(
  options: DeployOptions,
  io: ssh.SshIo = ssh.nodeSshIo,
): Promise<void> {
  resetSteps();

  const projectName = resolveProjectName(options.name, options.preview);
  const projectDir = `${options.projectsDir}/${projectName}`;

  info(`Project: ${projectName}`);
  info(`Server: ${options.user}@${options.host}:${options.port}`);
  info(`Branch: ${options.branch}`);
  info(`Directory: ${projectDir}`);

  // 1. Clone or pull
  step("Update source code");

  const exists = await io.test(options, `test -d ${projectDir}/.git`);

  if (exists) {
    info("Repository exists, fetching latest changes…");
    await io.exec(
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
    await io.exec(
      options,
      `git clone --depth 1 --branch ${options.branch} ${options.repo} ${projectDir}`,
    );

    // Write DDEV local config for first deployment
    info("Writing DDEV local config…");
    const localConfig = [
      `name: ${projectName}`,
      "override_config: true",
      ...(await resolveRouterPorts(options, io)),
      "",
    ].join("\\n");

    await io.exec(
      options,
      [
        `cd ${projectDir}`,
        `mkdir -p .ddev`,
        `printf '${localConfig}' > .ddev/config.local.yaml`,
        `touch ${CLONED_MARKER}`,
      ].join(" && "),
    );
  }

  // 2. Start DDEV if needed
  if (!options.noStart) {
    step("Start DDEV container");

    const statusResult = await io.exec(
      options,
      `cd ${projectDir} && ddev describe -j 2>/dev/null | jq -r '.raw.status // "stopped"'`,
    );

    const status = statusResult.stdout.trim();

    if (status !== "running") {
      info(`Status: ${status} — starting DDEV…`);
      await io.exec(options, `cd ${projectDir} && DDEV_NONINTERACTIVE=true ddev start`);
    } else {
      info("Container already running");
    }
  }

  // 3. Before script (on server, outside container)
  if (options.beforeScript) {
    step("Run before-script");
    await io.exec(options, `cd ${projectDir} && ${options.beforeScript}`);
  }

  // 4. Rsync build artifacts
  if (options.sync) {
    step("Sync build artifacts");

    const paths = options.sync.split(",").map((p) => p.trim());

    for (const localPath of paths) {
      const remotePath = `${projectDir}/${localPath}`;
      const result = await io.rsync(localPath, remotePath, options);

      // Say what the mirror removed. --delete is correct for a build
      // artifact, but a deletion nobody expected — a plugin installed by
      // hand and absent from the manifest, say — is otherwise invisible
      // among rsync's per-file output.
      const removed = ssh.formatDeletions(ssh.summarizeDeletions(result.stdout));

      if (removed) {
        warn(`${localPath}: ${removed}`);
      }
    }
  }

  // 5. Create script (on server, only on the deploy that created the project)
  //
  // Runs after the sync so the code is in place, and before the container
  // script so that script can rely on whatever this seeded. Skipped for an
  // existing project: seeding is not idempotent — `ddev pull` overwrites the
  // database, which would discard the environment's content on every deploy.
  if (options.createScript) {
    await runCreateScript(options, projectDir, exists, io);
  }

  // 6. Script inside DDEV container
  if (options.script) {
    step("Run deploy script in DDEV container");
    await runContainerScript(options, projectDir, io);
  }

  // 7. After script (on server, outside container)
  if (options.afterScript) {
    step("Run after-script");
    await io.exec(options, `cd ${projectDir} && ${options.afterScript}`);
  }

  // 8. Verify
  step("Verify deployment");

  try {
    await io.exec(options, `cd ${projectDir} && ddev describe`);
  } catch {
    error("Could not verify deployment — ddev describe failed");
  }

  success(`Deployed ${projectName} from ${options.branch}`);
}

/** Name of the generated script, written into the project directory. */
const CONTAINER_SCRIPT = ".trafic-deploy.sh";

/**
 * Written once this tool has cloned the repository.
 *
 * Its absence on a project that already has a `.git` means the environment
 * was created by an earlier version, which left nothing on disk to say
 * whether the create-script had run.
 */
const CLONED_MARKER = ".trafic-cloned";

/** Written once the create-script has completed. */
const CREATED_MARKER = ".trafic-created";

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
  io: ssh.SshIo,
): Promise<void> {
  const env = Object.entries(options.env ?? {});

  if (env.length > 0) {
    info(`Environment: ${env.map(([key]) => key).join(", ")}`);
  }

  const script = [
    "set -o errexit",
    ...env.map(([key, value]) => `export ${key}=${ssh.shellQuote(value)}`),
    options.script ?? "",
    "",
  ].join("\n");

  const encoded = Buffer.from(script, "utf-8").toString("base64");

  try {
    await io.exec(
      options,
      `cd ${projectDir} && printf %s ${encoded} | base64 -d > ${CONTAINER_SCRIPT} && chmod 600 ${CONTAINER_SCRIPT}`,
      // The payload holds the environment values
      { log: `write ${CONTAINER_SCRIPT}` },
    );

    await io.exec(options, `cd ${projectDir} && ddev exec bash ${CONTAINER_SCRIPT}`);
  } finally {
    // Leaving it behind would leave the values on disk
    await io.exec(options, `cd ${projectDir} && rm -f ${CONTAINER_SCRIPT}`);
  }
}

/**
 * Run the create-script, once per environment.
 *
 * Keyed on a marker rather than on the project directory being absent. A
 * first deploy that fails after the clone — a sync error, say — leaves the
 * directory in place, and keying on that made every later deploy skip the
 * create-script: the environment stayed unseeded for good, with no way to
 * recover but to destroy it. Seen on a real first deploy, which left a
 * project whose `.env` was never written.
 *
 * The marker is written only after the script succeeds, so a create-script
 * that fails runs again on the next deploy.
 */
async function runCreateScript(
  options: DeployOptions,
  projectDir: string,
  existedBefore: boolean,
  io: ssh.SshIo,
): Promise<void> {
  const created = await io.test(options, `test -f ${projectDir}/${CREATED_MARKER}`);

  if (created) {
    info("Create-script already ran for this environment — skipping");
    return;
  }

  const cloned = await io.test(options, `test -f ${projectDir}/${CLONED_MARKER}`);

  // An environment that predates the markers. Assume the create-script ran:
  // re-running it would re-seed a database that has been live since, and
  // losing that content is worse than skipping a step that was probably
  // already done. Recorded so the question is settled from now on.
  if (existedBefore && !cloned) {
    info("Environment predates the create-script marker — assuming it ran");
    await io.exec(options, `touch ${projectDir}/${CREATED_MARKER}`);
    return;
  }

  step("Run create-script");
  await io.exec(options, `cd ${projectDir} && ${options.createScript}`);
  await io.exec(options, `touch ${projectDir}/${CREATED_MARKER}`);
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
async function resolveRouterPorts(
  options: DeployOptions,
  io: ssh.SshIo,
): Promise<string[]> {
  const config = await io.exec(
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
