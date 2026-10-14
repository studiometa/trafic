import * as ssh from "../ssh.js";
import { info, step, success, resetSteps } from "../steps.js";
import type { DestroyOptions } from "../types.js";
import { resolveProjectName } from "../types.js";

/**
 * Time of the remote command on top of the backup: `ddev describe`, the
 * start and the stop of a stopped project (up to 3 minutes) and `ddev
 * delete` (up to 5 minutes).
 */
export const BACKUP_MARGIN_MS = 10 * 60 * 1000;

/**
 * Destroy a DDEV project on a remote server.
 *
 * The removal itself lives in the agent, `trafic-agent destroy`, so the
 * server can also remove a project on its own. The agent finds the project
 * directory from its own config and deletes the DDEV project, the directory
 * and the project's records in its database. With `backup`, the agent first
 * backs up the database and the upload directories, and removes nothing if
 * that fails. The timeout then goes to the agent as the time limit of the
 * backup, and the remote command gets that limit plus BACKUP_MARGIN_MS for
 * the other steps, so the agent always fails a slow backup cleanly before
 * the SSH connection is cut.
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
  const args = [ssh.shellQuote(projectName)];
  // Without --backup, the remote command gets the timeout as it is
  let timeoutMs: number | undefined;

  // Only with --backup: the agent uses the timeout for the backup only
  if (options.backup) {
    const timeout = options.timeout ?? `${ssh.DEFAULT_TIMEOUT_MS / 1000}s`;
    const backupMs = ssh.parseDuration(timeout);

    if (backupMs === undefined) {
      throw new Error(`Invalid timeout: "${timeout}". Expected a duration such as "10m", "90s" or "1h"`);
    }

    args.push("--backup", "--timeout", ssh.shellQuote(timeout));
    timeoutMs = backupMs + BACKUP_MARGIN_MS;
  }

  const destroyCommand = `trafic-agent destroy ${args.join(" ")}`;
  const missingAgent = ssh.shellQuote(
    `trafic-agent is not on the PATH of ${options.user}@${options.host}. Set the server up with \`trafic setup\`, then try again`,
  );

  info(`Project: ${projectName}`);
  info(`Server: ${options.user}@${options.host}:${options.port}`);

  step("Destroy the project");

  await io.exec(
    options,
    `command -v trafic-agent >/dev/null || { echo ${missingAgent} >&2; exit 127; }; ${destroyCommand}`,
    { log: destroyCommand, timeoutMs },
  );

  success(`Destroy of ${projectName} complete`);
}
