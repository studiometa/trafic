import { describe, it, expect } from "vitest";
import { parseDuration, validateConfig } from "../src/utils/config.js";
import type { AgentConfig } from "../src/types.js";

describe("parseDuration", () => {
  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
    expect(parseDuration("5m")).toBe(5 * 60 * 1000);
  });

  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(60 * 60 * 1000);
    expect(parseDuration("2h")).toBe(2 * 60 * 60 * 1000);
  });

  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30 * 1000);
  });

  it("parses combined durations", () => {
    expect(parseDuration("1h30m")).toBe((60 + 30) * 60 * 1000);
    expect(parseDuration("2h15m30s")).toBe((2 * 3600 + 15 * 60 + 30) * 1000);
  });

  it("returns 0 for invalid durations", () => {
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("invalid")).toBe(0);
  });
});

describe("validateConfig", () => {
  const validConfig: AgentConfig = {
    tld: "example.com",
    port: 9876,
    dbPath: "/var/lib/trafic/db.sqlite",
    projectListPath: "/home/ddev/.ddev/project_list.yaml",
    projectsDir: "/home/ddev/www",
    idleTimeout: "30m",
    idleCheckInterval: "5m",
    auth: {
      defaultPolicy: "basic",
      allowedIps: [],
      tokens: [],
      basicAuth: [],
      rules: [],
    },
  };

  it("returns no errors for valid config", () => {
    expect(validateConfig(validConfig)).toEqual([]);
  });

  it("requires tld", () => {
    const config = { ...validConfig, tld: "" };
    const errors = validateConfig(config);
    expect(errors).toContain("tld is required");
  });

  it("validates port range", () => {
    expect(validateConfig({ ...validConfig, port: 0 })).toContain(
      "port must be between 1 and 65535",
    );
    expect(validateConfig({ ...validConfig, port: 70000 })).toContain(
      "port must be between 1 and 65535",
    );
    expect(validateConfig({ ...validConfig, port: 8080 })).toEqual([]);
  });

  it("validates default policy", () => {
    const config = {
      ...validConfig,
      auth: { ...validConfig.auth, defaultPolicy: "invalid" as "allow" },
    };
    const errors = validateConfig(config);
    expect(errors).toContain(
      'auth.default_policy must be "allow", "deny", "basic", or "token"',
    );
  });

  it("accepts token as default policy", () => {
    const config = {
      ...validConfig,
      auth: { ...validConfig.auth, defaultPolicy: "token" as const },
    };
    expect(validateConfig(config)).toEqual([]);
  });
});
