import { describe, it, expect } from "vitest";
import {
  matchIp,
  matchHostname,
  parseBasicAuth,
  parseBearerToken,
  checkAuth,
} from "../src/utils/auth.js";
import type { AuthConfig } from "../src/types.js";

describe("matchIp", () => {
  it("matches exact IP", () => {
    expect(matchIp("192.168.1.1", "192.168.1.1")).toBe(true);
    expect(matchIp("192.168.1.1", "192.168.1.2")).toBe(false);
  });

  it("matches wildcard patterns", () => {
    expect(matchIp("192.168.1.1", "192.168.*.*")).toBe(true);
    expect(matchIp("192.168.1.1", "192.168.1.*")).toBe(true);
    expect(matchIp("10.0.0.1", "192.168.*.*")).toBe(false);
  });

  it("matches CIDR notation", () => {
    expect(matchIp("192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(matchIp("192.168.1.255", "192.168.1.0/24")).toBe(true);
    expect(matchIp("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(matchIp("10.0.0.1", "10.0.0.0/8")).toBe(true);
  });
});

describe("matchHostname", () => {
  it("matches exact hostname", () => {
    expect(matchHostname("example.com", "example.com")).toBe(true);
    expect(matchHostname("example.com", "other.com")).toBe(false);
  });

  it("matches wildcard patterns", () => {
    expect(matchHostname("sub.example.com", "*.example.com")).toBe(true);
    expect(matchHostname("deep.sub.example.com", "*.example.com")).toBe(true);
    expect(matchHostname("example.com", "*.example.com")).toBe(false);
  });

  it("matches single char wildcard", () => {
    expect(matchHostname("test1.example.com", "test?.example.com")).toBe(true);
    expect(matchHostname("test12.example.com", "test?.example.com")).toBe(false);
  });
});

describe("parseBasicAuth", () => {
  it("parses valid basic auth header", () => {
    const header = "Basic " + Buffer.from("user:pass").toString("base64");
    expect(parseBasicAuth(header)).toEqual({ username: "user", password: "pass" });
  });

  it("handles password with colons", () => {
    const header = "Basic " + Buffer.from("user:pass:word").toString("base64");
    expect(parseBasicAuth(header)).toEqual({ username: "user", password: "pass:word" });
  });

  it("returns null for invalid header", () => {
    expect(parseBasicAuth("Bearer token")).toBeNull();
    expect(parseBasicAuth("Basic !!!")).toBeNull();
    expect(parseBasicAuth("")).toBeNull();
  });
});

describe("parseBearerToken", () => {
  it("parses valid bearer token", () => {
    expect(parseBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("returns null for invalid header", () => {
    expect(parseBearerToken("Basic xxx")).toBeNull();
    expect(parseBearerToken("")).toBeNull();
  });
});

describe("checkAuth", () => {
  const baseConfig: AuthConfig = {
    defaultPolicy: "deny",
    allowedIps: [],
    tokens: [],
    basicAuth: [],
    rules: [],
  };

  it("allows whitelisted IPs", () => {
    const config: AuthConfig = {
      ...baseConfig,
      allowedIps: ["192.168.1.0/24"],
    };
    const result = checkAuth(
      { hostname: "test.com", ip: "192.168.1.100" },
      config,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ip");
  });

  it("applies default deny policy", () => {
    const result = checkAuth(
      { hostname: "test.com", ip: "10.0.0.1" },
      baseConfig,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("default");
  });

  it("applies default allow policy", () => {
    const config: AuthConfig = { ...baseConfig, defaultPolicy: "allow" };
    const result = checkAuth(
      { hostname: "test.com", ip: "10.0.0.1" },
      config,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("default");
  });

  it("validates basic auth", () => {
    const config: AuthConfig = {
      ...baseConfig,
      defaultPolicy: "basic",
      basicAuth: ["admin:secret"],
    };

    const validHeader = "Basic " + Buffer.from("admin:secret").toString("base64");
    const invalidHeader = "Basic " + Buffer.from("admin:wrong").toString("base64");

    expect(
      checkAuth({ hostname: "test.com", ip: "10.0.0.1", authorization: validHeader }, config)
        .allowed,
    ).toBe(true);

    expect(
      checkAuth({ hostname: "test.com", ip: "10.0.0.1", authorization: invalidHeader }, config)
        .allowed,
    ).toBe(false);
  });

  it("validates bearer tokens", () => {
    const config: AuthConfig = {
      ...baseConfig,
      defaultPolicy: "basic",
      tokens: ["secret-token"],
    };

    expect(
      checkAuth(
        { hostname: "test.com", ip: "10.0.0.1", authorization: "Bearer secret-token" },
        config,
      ).allowed,
    ).toBe(true);

    expect(
      checkAuth(
        { hostname: "test.com", ip: "10.0.0.1", authorization: "Bearer wrong-token" },
        config,
      ).allowed,
    ).toBe(false);
  });

  it("applies per-hostname rules", () => {
    const config: AuthConfig = {
      ...baseConfig,
      defaultPolicy: "deny",
      rules: [
        { match: "public.*", policy: "allow" },
        { match: "private.*", policy: "basic" },
      ],
      basicAuth: ["user:pass"],
    };

    expect(
      checkAuth({ hostname: "public.example.com", ip: "10.0.0.1" }, config).allowed,
    ).toBe(true);

    expect(
      checkAuth({ hostname: "private.example.com", ip: "10.0.0.1" }, config).allowed,
    ).toBe(false);

    const validHeader = "Basic " + Buffer.from("user:pass").toString("base64");
    expect(
      checkAuth(
        { hostname: "private.example.com", ip: "10.0.0.1", authorization: validHeader },
        config,
      ).allowed,
    ).toBe(true);
  });
});
