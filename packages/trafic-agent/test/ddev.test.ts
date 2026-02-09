import { describe, it, expect } from "vitest";
import { buildHostnameIndex, getProjectFromHostname } from "../src/utils/ddev.js";

describe("buildHostnameIndex", () => {
  it("builds hostname index from projects", () => {
    const projects = new Map([
      ["my-project", "/home/ddev/www/my-project"],
      ["another-app", "/home/ddev/www/another-app"],
    ]);

    const index = buildHostnameIndex(projects, "preview.example.com");

    expect(index.get("my-project.preview.example.com")).toBe("my-project");
    expect(index.get("another-app.preview.example.com")).toBe("another-app");
    expect(index.size).toBe(2);
  });

  it("handles empty projects", () => {
    const index = buildHostnameIndex(new Map(), "example.com");
    expect(index.size).toBe(0);
  });
});

describe("getProjectFromHostname", () => {
  const projects = new Map([
    ["my-project", "/home/ddev/www/my-project"],
    ["preview-42--starter", "/home/ddev/www/preview-42--starter"],
  ]);
  const index = buildHostnameIndex(projects, "preview.example.com");

  it("returns project name for valid hostname", () => {
    expect(getProjectFromHostname("my-project.preview.example.com", index)).toBe(
      "my-project",
    );
  });

  it("handles preview environments", () => {
    expect(
      getProjectFromHostname("preview-42--starter.preview.example.com", index),
    ).toBe("preview-42--starter");
  });

  it("returns undefined for unknown hostname", () => {
    expect(
      getProjectFromHostname("unknown.preview.example.com", index),
    ).toBeUndefined();
  });

  it("returns undefined for wrong TLD", () => {
    expect(getProjectFromHostname("my-project.other.com", index)).toBeUndefined();
  });
});
