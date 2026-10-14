import * as ssh from "../ssh.js";
import { info, step, success, resetSteps } from "../steps.js";
import type { DestroyOptions } from "../types.js";
import { resolveProjectName } from "../types.js";

/**
 * Destroy a DDEV project on a remote server.
 *
 * The removal itself lives in the agent, `trafic-agent destroy`, so the
 * server can also remove a project on its own. The agent finds the project
 * directory from its own config and deletes the DDEV project, the directory
 * and the project's records in its database.
 *
 * One remote command checks that the agent is installed and runs it. A
 * separate check could not tell a missing agent from an SSH failure, and
 * would report a connection error as a missing agent.
 */
export async function destroy(
  options: DestroyOptions,
  io: ssh.SshIo = ssh.nodeSshIo,
): Promise<void> {
  resetSteps();

  const projectName = resolveProjectName(options.name, options.preview);
  const destroyCommand = `trafic-agent destroy ${ssh.shellQuote(projectName)}`;
  const missingAgent = ssh.shellQuote(
    `trafic-agent is not on the PATH of ${options.user}@${options.host}. Set the server up with \`trafic setup\`, then try again`,
  );

  info(`Project: ${projectName}`);
  info(`Server: ${options.user}@${options.host}:${options.port}`);

  step("Destroy the project");

  await io.exec(
    options,
    `command -v trafic-agent >/dev/null || { echo ${missingAgent} >&2; exit 127; }; ${destroyCommand}`,
    { log: destroyCommand },
  );

  success(`Destroy of ${projectName} complete`);
}
