import SKILL from "../../../../skills/trafic-cli/SKILL.md?raw";

/**
 * Print the agent skill of the CLI, skills/trafic-cli/SKILL.md.
 *
 * The file is bundled at build time, so it always matches this version,
 * whatever copy of the skill an agent installed from the repository.
 */
export function skill(): void {
  process.stdout.write(SKILL);
}
