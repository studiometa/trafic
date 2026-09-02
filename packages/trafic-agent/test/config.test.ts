import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseDuration, validateConfig } from "../src/utils/config.js";
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

describe("loadConfig trusted_proxy_hops", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trafic-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a config file holding just an [auth] section and load it. */
  function loadAuth(authSection: string) {
    const path = join(dir, "config.toml");
    writeFileSync(path, `tld = "example.com"\n\n[auth]\n${authSection}\n`);
    return loadConfig(path).auth;
  }

  it("defaults to a single trusted proxy", () => {
    expect(loadAuth('default_policy = "basic"').trustedProxyHops).toBe(1);
  });

  it("reads an explicit hop count", () => {
    expect(loadAuth("trusted_proxy_hops = 2").trustedProxyHops).toBe(2);
  });

  it.each([
    ["0", "trusted_proxy_hops = 0"],
    ["negative", "trusted_proxy_hops = -1"],
    ["fractional", "trusted_proxy_hops = 1.5"],
    ["a string", 'trusted_proxy_hops = "two"'],
  ])("falls back to the default for %s", (_label, line) => {
    // Zero would read the socket peer — always a proxy — so the IP
    // allowlist would silently never match
    expect(loadAuth(line).trustedProxyHops).toBe(1);
  });

  it("defaults when the config has no auth section at all", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, 'tld = "example.com"\n');

    expect(loadConfig(path).auth.trustedProxyHops).toBe(1);
  });
});
