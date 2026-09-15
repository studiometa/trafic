import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const waitTemplate = readFileSync(
  fileURLToPath(new URL("../templates/wait.html", import.meta.url)),
  "utf-8",
);

describe("waiting page template", () => {
  it("prevents search indexing", () => {
    expect(waitTemplate).toContain('<meta name="robots" content="noindex">');
  });
});
