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
 * Steps:
 * 1. Check that the agent is installed
 * 2. Run `trafic-agent destroy` on the server
 */
export async function destroy(
  options: DestroyOptions,
  io: ssh.SshIo = ssh.nodeSshIo,
): Promise<void> {
  resetSteps();

  const projectName = resolveProjectName(options.name, options.preview);

  info(`Project: ${projectName}`);
  info(`Server: ${options.user}@${options.host}:${options.port}`);

  // 1. Check the agent
  step("Check the Trafic agent");

  if (!(await io.test(options, "command -v trafic-agent"))) {
    throw new Error(
      `trafic-agent is not on the PATH of ${options.user}@${options.host}. Set the server up with \`trafic setup\`, then try again`,
    );
  }

  // 2. Destroy the project
  step("Destroy the project");

  await io.exec(options, `trafic-agent destroy ${ssh.shellQuote(projectName)}`);

  success(`Destroy of ${projectName} complete`);
}
