import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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

/**
 * Split a SKILL.md into its frontmatter and its body. The frontmatter goes
 * through a YAML parser, as installers read it: a line parser would accept a
 * description that YAML refuses or cuts short.
 */
function parseSkill(content: string): {
  frontmatter: string;
  fields: Record<string, unknown>;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);

  if (!match) {
    throw new Error("No frontmatter");
  }

  return { frontmatter: match[1]!, fields: parse(match[1]!), body: match[2]! };
}

describe("parseSkill", () => {
  it("refuses a frontmatter that is not valid YAML", () => {
    expect(() => parseSkill("---\nname: x\ndescription: Use it: now\n---\n")).toThrow();
  });
});

describe("skills", () => {
  it("has the trafic-cli and trafic-agent skills", () => {
    expect(skills).toEqual(expect.arrayContaining(["trafic-cli", "trafic-agent"]));
  });

  describe.each(skills)("%s", (dir) => {
    const { frontmatter, fields, body } = parseSkill(readFileSync(`${skillsDir}${dir}/SKILL.md`, "utf-8"));

    it("has only frontmatter keys of the spec", () => {
      expect(SPEC_KEYS).toEqual(expect.arrayContaining(Object.keys(fields)));
    });

    it("has a name that is valid and the same as its directory", () => {
      expect(fields.name).toBe(dir);
      expect((fields.name as string).length).toBeLessThanOrEqual(64);
      expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("has a description of 1 to 1024 characters", () => {
      expect(typeof fields.description).toBe("string");
      expect((fields.description as string).length).toBeGreaterThan(0);
      expect((fields.description as string).length).toBeLessThanOrEqual(1024);
    });

    it("has a description that YAML reads in full", () => {
      // A " #" starts a comment, and YAML drops the rest of the line
      const line = frontmatter.split("\n").find((l) => l.startsWith("description:"));

      expect([
        `description: ${fields.description as string}`,
        `description: ${JSON.stringify(fields.description)}`,
      ]).toContain(line);
    });

    it("has a body under 500 lines", () => {
      expect(body.split("\n").length).toBeLessThan(500);
    });
  });
});
