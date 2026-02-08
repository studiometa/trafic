import { describe, it, expect } from "vitest";
import { resolveProjectName } from "../src/types.js";

describe("resolveProjectName", () => {
  it("returns the name as-is without preview", () => {
    expect(resolveProjectName("my-app")).toBe("my-app");
  });

  it("returns the name as-is when preview is undefined", () => {
    expect(resolveProjectName("my-app", undefined)).toBe("my-app");
  });

  it("prefixes with preview-<iid>-- when preview is set", () => {
    expect(resolveProjectName("my-app", "42")).toBe("preview-42--my-app");
  });

  it("handles numeric-like preview strings", () => {
    expect(resolveProjectName("wordpress-project", "123")).toBe(
      "preview-123--wordpress-project",
    );
  });
});
