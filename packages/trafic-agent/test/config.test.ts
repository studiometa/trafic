import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseDuration, parseTimeout, validateConfig } from "../src/utils/config.js";
import type { AgentConfig } from "../src/types.js";

describe("parseTimeout", () => {
  it.each([
    ["90s", 90 * 1000],
    ["10m", 10 * 60 * 1000],
    ["1h", 60 * 60 * 1000],
    // The trafic CLI reads a bare number as minutes, and passes it on as is
    ["30", 30 * 60 * 1000],
  ])("parses %j", (value, expected) => {
    expect(parseTimeout(value)).toBe(expected);
  });

  it.each(["", "0", "0m", "-5m", "1h30m", "10 minutes", "abc", "1.5h"])(
    "rejects %j",
    (value) => {
      expect(parseTimeout(value)).toBeUndefined();
    },
  );
});

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
      trustedProxyHops: 1,
    },
    tls: {
      dnsEnv: {},
    },
    backup: {
      dir: "/var/backups/trafic",
      retainDays: 14,
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

  it.each(["backups", ""])("requires an absolute backup directory, not %j", (dir) => {
    const config = { ...validConfig, backup: { ...validConfig.backup, dir } };
    expect(validateConfig(config)).toContain("backup.dir must be an absolute path");
  });

  it.each([
    ["projects_dir itself", "/home/ddev/www"],
    ["projects_dir with a trailing slash", "/home/ddev/www/"],
    ["inside projects_dir", "/home/ddev/www/backups"],
    ["inside a project directory", "/home/ddev/www/app/backups"],
    ["a parent of projects_dir", "/home/ddev"],
    ["a parent of projects_dir, not normalized", "/home/ddev/www/.."],
  ])("rejects a backup directory that is %s", (_, dir) => {
    // trafic-agent destroy would remove the backup with the project
    const config = { ...validConfig, projectsDir: "/home/ddev/www", backup: { ...validConfig.backup, dir } };
    expect(validateConfig(config)).toContain(
      "backup.dir must not be projects_dir, be inside it or contain it",
    );
  });

  it.each(["/home/ddev/backups", "/home/ddev/www-backups"])(
    "accepts a backup directory next to projects_dir: %s",
    (dir) => {
      const config = { ...validConfig, projectsDir: "/home/ddev/www", backup: { ...validConfig.backup, dir } };
      expect(validateConfig(config)).toEqual([]);
    },
  );

  it.each([0, -1, 1.5])("rejects retain_days = %s", (retainDays) => {
    // 0 would remove each backup as soon as the sweep sees it
    const config = { ...validConfig, backup: { ...validConfig.backup, retainDays } };
    expect(validateConfig(config)).toContain(
      "backup.retain_days must be a whole number of 1 or more",
    );
  });
});

describe("loadConfig backup", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trafic-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function load(content: string) {
    const path = join(dir, "config.toml");
    writeFileSync(path, `tld = "example.com"\n${content}\n`);
    return loadConfig(path).backup;
  }

  it("defaults to /var/backups/trafic and 14 days", () => {
    expect(load("")).toEqual({ dir: "/var/backups/trafic", retainDays: 14 });
  });

  it("reads the [backup] section", () => {
    expect(load('[backup]\ndir = "/srv/backups"\nretain_days = 30')).toEqual({
      dir: "/srv/backups",
      retainDays: 30,
    });
  });

  it("keeps the default for a key the section leaves out", () => {
    expect(load("[backup]\nretain_days = 7")).toEqual({
      dir: "/var/backups/trafic",
      retainDays: 7,
    });
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
