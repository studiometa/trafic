import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadProjectConfig,
  shouldNeverStop,
  getIdleTimeoutMs,
} from "../src/utils/project-config.js";

const TEST_DIR = "/tmp/trafic-test-project";

describe("loadProjectConfig", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, ".ddev"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns empty config when file doesn't exist", () => {
    const config = loadProjectConfig(TEST_DIR);
    expect(config).toEqual({});
  });

  it("loads auth_policy from config file", () => {
    writeFileSync(
      join(TEST_DIR, ".ddev", "config.trafic.yaml"),
      "auth_policy: allow\n",
    );
    const config = loadProjectConfig(TEST_DIR);
    expect(config.auth_policy).toBe("allow");
  });

  it("loads idle_timeout from config file", () => {
    writeFileSync(
      join(TEST_DIR, ".ddev", "config.trafic.yaml"),
      "idle_timeout: 2h\n",
    );
    const config = loadProjectConfig(TEST_DIR);
    expect(config.idle_timeout).toBe("2h");
  });

  it("loads both settings from config file", () => {
    writeFileSync(
      join(TEST_DIR, ".ddev", "config.trafic.yaml"),
      `# Trafic settings
auth_policy: basic
idle_timeout: never
`,
    );
    const config = loadProjectConfig(TEST_DIR);
    expect(config.auth_policy).toBe("basic");
    expect(config.idle_timeout).toBe("never");
  });

  it("validates auth_policy values", () => {
    writeFileSync(
      join(TEST_DIR, ".ddev", "config.trafic.yaml"),
      "auth_policy: invalid\n",
    );
    const config = loadProjectConfig(TEST_DIR);
    expect(config.auth_policy).toBeUndefined();
  });

  it("accepts all valid auth_policy values", () => {
    for (const policy of ["allow", "deny", "basic", "token"]) {
      writeFileSync(
        join(TEST_DIR, ".ddev", "config.trafic.yaml"),
        `auth_policy: ${policy}\n`,
      );
      const config = loadProjectConfig(TEST_DIR);
      expect(config.auth_policy).toBe(policy);
    }
  });

  it("handles quoted values", () => {
    writeFileSync(
      join(TEST_DIR, ".ddev", "config.trafic.yaml"),
      `auth_policy: "allow"
idle_timeout: '4h'
`,
    );
    const config = loadProjectConfig(TEST_DIR);
    expect(config.auth_policy).toBe("allow");
    expect(config.idle_timeout).toBe("4h");
  });

  it("ignores comments and empty lines", () => {
    writeFileSync(
      join(TEST_DIR, ".ddev", "config.trafic.yaml"),
      `# This is a comment
auth_policy: allow

# Another comment
idle_timeout: 1h
`,
    );
    const config = loadProjectConfig(TEST_DIR);
    expect(config.auth_policy).toBe("allow");
    expect(config.idle_timeout).toBe("1h");
  });
});

describe("shouldNeverStop", () => {
  it("returns true for 'never'", () => {
    expect(shouldNeverStop({ idle_timeout: "never" })).toBe(true);
    expect(shouldNeverStop({ idle_timeout: "NEVER" })).toBe(true);
    expect(shouldNeverStop({ idle_timeout: "Never" })).toBe(true);
  });

  it("returns false for other values", () => {
    expect(shouldNeverStop({ idle_timeout: "30m" })).toBe(false);
    expect(shouldNeverStop({ idle_timeout: "4h" })).toBe(false);
    expect(shouldNeverStop({})).toBe(false);
  });
});

describe("getIdleTimeoutMs", () => {
  it("returns undefined when not set", () => {
    expect(getIdleTimeoutMs({})).toBeUndefined();
  });

  it("returns undefined for 'never'", () => {
    expect(getIdleTimeoutMs({ idle_timeout: "never" })).toBeUndefined();
  });

  it("parses minutes", () => {
    expect(getIdleTimeoutMs({ idle_timeout: "30m" })).toBe(30 * 60 * 1000);
  });

  it("parses hours", () => {
    expect(getIdleTimeoutMs({ idle_timeout: "4h" })).toBe(4 * 60 * 60 * 1000);
  });

  it("parses combined durations", () => {
    expect(getIdleTimeoutMs({ idle_timeout: "1h30m" })).toBe(90 * 60 * 1000);
  });

  it("parses seconds", () => {
    expect(getIdleTimeoutMs({ idle_timeout: "45s" })).toBe(45 * 1000);
  });
});
