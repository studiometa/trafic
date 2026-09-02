import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exec,
  execSilent,
  commandExists,
  writeFile,
  setDryRun,
  resetSteps,
  step,
} from "../src/setup/steps.js";
import { nodeIo } from "../src/setup/io.js";

let dir = "";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "trafic-steps-"));
  resetSteps();
});

afterEach(() => {
  setDryRun(false);
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFile", () => {
  it("writes the file when not in dry-run mode", () => {
    const path = join(dir, "config.toml");

    writeFile(path, "tld = \"example.com\"\n");

    expect(readFileSync(path, "utf-8")).toBe("tld = \"example.com\"\n");
  });

  it("writes nothing in dry-run mode", () => {
    const path = join(dir, "config.toml");
    setDryRun(true);

    writeFile(path, "tld = \"example.com\"\n");

    // `setup --dry-run` promises no changes, so a write here would be a lie
    expect(existsSync(path)).toBe(false);
  });
});

describe("exec", () => {
  it("returns the output of a command", () => {
    expect(exec("echo hello", { silent: true }).trim()).toBe("hello");
  });

  it("throws with the command in the message when it fails", () => {
    expect(() => exec("exit 3", { silent: true })).toThrow(/exit 3/);
  });

  it("runs nothing in dry-run mode", () => {
    const path = join(dir, "created-by-exec");
    setDryRun(true);

    const result = exec(`touch ${path}`, { silent: true });

    expect(result).toBe("");
    expect(existsSync(path)).toBe(false);
  });
});

describe("execSilent", () => {
  it("returns trimmed output", () => {
    expect(execSilent("echo  spaced  ")).toBe("spaced");
  });

  it("returns an empty string instead of throwing on failure", () => {
    // Callers use it for probes where a failure just means "not found"
    expect(execSilent("exit 1")).toBe("");
  });
});

describe("commandExists", () => {
  it("finds a command on the PATH", () => {
    expect(commandExists("sh")).toBe(true);
  });

  it("reports a missing command", () => {
    expect(commandExists("definitely-not-a-real-command-xyz")).toBe(false);
  });
});

describe("step", () => {
  it("numbers steps from one after a reset", () => {
    const log = vi.mocked(console.log);
    log.mockClear();

    step("First");
    step("Second");

    expect(String(log.mock.calls[0]?.[0])).toContain("[1]");
    expect(String(log.mock.calls[1]?.[0])).toContain("[2]");
  });
});

describe("nodeIo", () => {
  it("writes through the dry-run aware writer", () => {
    const path = join(dir, "via-io.toml");
    setDryRun(true);

    nodeIo.writeFile(path, "x");

    // Modules used to import writeFileSync from node:fs directly, which
    // wrote real files during a dry-run
    expect(existsSync(path)).toBe(false);
  });

  it("still writes when dry-run is off", () => {
    const path = join(dir, "via-io.toml");

    nodeIo.writeFile(path, "x");

    expect(readFileSync(path, "utf-8")).toBe("x");
  });

  it("reads files as UTF-8 text", () => {
    const path = join(dir, "read-me");
    nodeIo.writeFile(path, "contents");

    expect(nodeIo.readFile(path)).toBe("contents");
    expect(nodeIo.fileExists(path)).toBe(true);
  });
});
