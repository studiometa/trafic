import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { skill } from "../src/commands/skill.js";

const file = readFileSync(new URL("../../../skills/trafic-cli/SKILL.md", import.meta.url), "utf-8");

describe("skill", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the SKILL.md of the CLI", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    skill();

    const out = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(out).toBe(file);
    expect(out).toMatch(/^---\nname: trafic-cli\n/);
  });
});
