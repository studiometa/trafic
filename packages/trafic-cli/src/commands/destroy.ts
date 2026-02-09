import * as ssh from "../ssh.js";
import { info, step, success, resetSteps, warn } from "../steps.js";
import type { DestroyOptions } from "../types.js";
import { resolveProjectName } from "../types.js";

/**
 * Destroy a DDEV project on a remote server.
 *
 * Steps:
 * 1. Backup the database (unless --no-backup)
 * 2. Stop and delete the DDEV project
 * 3. Remove the project directory
 */
export async function destroy(options: DestroyOptions): Promise<void> {
  resetSteps();

  const projectName = resolveProjectName(options.name, options.preview);
  const projectDir = `${options.projectsDir}/${projectName}`;

  info(`Project: ${projectName}`);
  info(`Server: ${options.user}@${options.host}:${options.port}`);
  info(`Directory: ${projectDir}`);

  // Check if the project directory exists
  const exists = await ssh.test(options, `test -d ${projectDir}`);

  if (!exists) {
    warn(`Project directory ${projectDir} does not exist — nothing to destroy`);
    return;
  }

  // 1. Backup database before destroy
  if (!options.noBackup) {
    step("Backup database before destroy");

    try {
      await ssh.exec(options, `trafic-agent backup --name ${projectName}`);
    } catch (err) {
      warn("Backup failed — continuing with destroy");
      info(String(err));
    }
  }

  // 2. Stop and delete DDEV project
  step("Delete DDEV project");

  try {
    await ssh.exec(
      options,
      `cd ${projectDir} && ddev delete -Oy`,
    );
  } catch (err) {
    warn("DDEV delete failed — project may not be a valid DDEV project");
    info(String(err));
  }

  // 2. Remove the project directory
  step("Remove project directory");

  await ssh.exec(options, `rm -rf ${projectDir}`);

  success(`Destroyed ${projectName}`);
}
