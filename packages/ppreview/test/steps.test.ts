import { describe, it, expect, vi, beforeEach } from "vitest";
import { step, info, success, error, warn, resetSteps } from "../src/steps.js";

describe("steps logger", () => {
  beforeEach(() => {
    resetSteps();
    vi.restoreAllMocks();
  });

  it("step() outputs numbered steps", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    step("First step");
    step("Second step");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toContain("[1]");
    expect(spy.mock.calls[0]![0]).toContain("First step");
    expect(spy.mock.calls[1]![0]).toContain("[2]");
    expect(spy.mock.calls[1]![0]).toContain("Second step");
  });

  it("resetSteps() resets the counter", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    step("Step one");
    resetSteps();
    step("Step one again");

    expect(spy.mock.calls[1]![0]).toContain("[1]");
  });

  it("info() outputs a dimmed message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    info("some info");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("some info");
  });

  it("success() outputs a green message", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    success("it worked");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("✓");
  });

  it("error() outputs a red message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    error("it failed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("✗");
  });

  it("warn() outputs a yellow message", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn("be careful");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("⚠");
  });
});
