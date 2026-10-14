import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Check every skill of the repository against the Agent Skills spec
 * (https://agentskills.io/specification). Clients other than Claude Code
 * refuse a skill with other frontmatter keys, and installers match the
 * name to the directory.
 */
const skillsDir = fileURLToPath(new URL("../../../skills/", import.meta.url));
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const SPEC_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];

/** Split a SKILL.md into its frontmatter keys and its body. */
function parseSkill(content: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);

  if (!match) {
    throw new Error("No frontmatter");
  }

  const fields: Record<string, string> = {};

  // Top-level `key: value` lines; the keys of `metadata` are indented
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);

    if (field) {
      fields[field[1]!] = field[2]!;
    }
  }

  return { fields, body: match[2]! };
}

describe("skills", () => {
  it("has the trafic-cli and trafic-agent skills", () => {
    expect(skills).toEqual(expect.arrayContaining(["trafic-cli", "trafic-agent"]));
  });

  describe.each(skills)("%s", (dir) => {
    const { fields, body } = parseSkill(readFileSync(`${skillsDir}${dir}/SKILL.md`, "utf-8"));

    it("has only frontmatter keys of the spec", () => {
      expect(SPEC_KEYS).toEqual(expect.arrayContaining(Object.keys(fields)));
    });

    it("has a name that is valid and the same as its directory", () => {
      expect(fields.name).toBe(dir);
      expect(fields.name!.length).toBeLessThanOrEqual(64);
      expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("has a description of 1 to 1024 characters", () => {
      expect(fields.description?.length).toBeGreaterThan(0);
      expect(fields.description!.length).toBeLessThanOrEqual(1024);
    });

    it("has a body under 500 lines", () => {
      expect(body.split("\n").length).toBeLessThan(500);
    });
  });
});
