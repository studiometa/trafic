import { describe, it, expect } from "vitest";
import { isNewer } from "../src/setup/upgrade.js";

describe("isNewer", () => {
  it("returns true when major is greater", () => {
    expect(isNewer("1.0.0", "2.0.0")).toBe(true);
  });

  it("returns true when minor is greater", () => {
    expect(isNewer("0.1.0", "0.2.0")).toBe(true);
  });

  it("returns true when patch is greater", () => {
    expect(isNewer("0.1.12", "0.1.13")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewer("0.1.13", "0.1.13")).toBe(false);
  });

  it("returns false when current is greater (patch)", () => {
    expect(isNewer("0.1.13", "0.1.12")).toBe(false);
  });

  it("returns false when current is greater (minor)", () => {
    expect(isNewer("0.2.0", "0.1.99")).toBe(false);
  });

  it("returns false when current is greater (major)", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(false);
  });

  it("handles v-prefixed versions", () => {
    expect(isNewer("v0.1.12", "v0.1.13")).toBe(true);
    expect(isNewer("v0.1.13", "v0.1.13")).toBe(false);
  });
});
