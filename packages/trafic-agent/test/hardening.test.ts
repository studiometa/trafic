import { describe, it, expect } from "vitest";
import { resolveAllowedUsers } from "../src/setup/hardening.js";

describe("resolveAllowedUsers", () => {
  it("adds the sudo user so hardening cannot lock them out", () => {
    expect(resolveAllowedUsers(["ddev"], "ubuntu")).toEqual(["ddev", "ubuntu"]);
  });

  it("does not duplicate a sudo user already listed", () => {
    expect(resolveAllowedUsers(["ddev", "ubuntu"], "ubuntu")).toEqual([
      "ddev",
      "ubuntu",
    ]);
  });

  it("ignores root, which is always allowed", () => {
    expect(resolveAllowedUsers(["ddev"], "root")).toEqual(["ddev"]);
  });

  it("handles a direct root login with no sudo user", () => {
    expect(resolveAllowedUsers(["ddev"], undefined)).toEqual(["ddev"]);
  });

  it("trims and drops empty entries", () => {
    expect(resolveAllowedUsers([" ddev ", "", " ci "], "ubuntu")).toEqual([
      "ddev",
      "ci",
      "ubuntu",
    ]);
  });
});
