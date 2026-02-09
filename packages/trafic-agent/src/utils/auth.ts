import type { AuthConfig, AuthRequest, AuthResult, AuthRule } from "../types.js";

/**
 * Check if an IP matches a pattern (supports CIDR notation)
 */
export function matchIp(ip: string, pattern: string): boolean {
  // Exact match
  if (ip === pattern) return true;

  // CIDR notation
  if (pattern.includes("/")) {
    return matchCidr(ip, pattern);
  }

  // Wildcard (e.g., 192.168.*)
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
    );
    return regex.test(ip);
  }

  return false;
}

/**
 * Match IP against CIDR range
 */
function matchCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split("/");
  const mask = parseInt(bits, 10);

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);

  if (ipNum === null || rangeNum === null) return false;

  const maskNum = ~((1 << (32 - mask)) - 1);
  return (ipNum & maskNum) === (rangeNum & maskNum);
}

/**
 * Convert IP string to number
 */
function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0; // Convert to unsigned
}

/**
 * Match hostname against a glob pattern
 */
export function matchHostname(hostname: string, pattern: string): boolean {
  // Exact match
  if (hostname === pattern) return true;

  // Glob pattern
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(hostname);
}

/**
 * Parse Basic auth header
 */
export function parseBasicAuth(
  header: string,
): { username: string; password: string } | null {
  if (!header.startsWith("Basic ")) return null;

  try {
    const encoded = header.slice(6);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) return null;

    return {
      username: decoded.slice(0, colonIndex),
      password: decoded.slice(colonIndex + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Parse Bearer token from header
 */
export function parseBearerToken(header: string): string | null {
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7);
}

/**
 * Check authentication for a request
 */
export function checkAuth(request: AuthRequest, config: AuthConfig): AuthResult {
  const { hostname, ip, authorization } = request;

  // Get real IP (handle X-Forwarded-For)
  const realIp = request.forwardedFor?.split(",")[0].trim() ?? ip;

  // Check IP whitelist first (always allows)
  for (const pattern of config.allowedIps) {
    if (matchIp(realIp, pattern)) {
      return { allowed: true, reason: "ip" };
    }
  }

  // Check per-hostname rules
  for (const rule of config.rules) {
    if (matchHostname(hostname, rule.match)) {
      return checkRule(rule, realIp, authorization, config);
    }
  }

  // Apply default policy
  return applyDefaultPolicy(config, realIp, authorization);
}

/**
 * Check a specific rule
 */
function checkRule(
  rule: AuthRule,
  ip: string,
  authorization: string | undefined,
  config: AuthConfig,
): AuthResult {
  // Rule-specific IP whitelist
  if (rule.allowedIps) {
    for (const pattern of rule.allowedIps) {
      if (matchIp(ip, pattern)) {
        return { allowed: true, reason: "rule" };
      }
    }
  }

  switch (rule.policy) {
    case "allow":
      return { allowed: true, reason: "rule" };

    case "deny":
      return { allowed: false, reason: "rule" };

    case "token": {
      if (!authorization) return { allowed: false, reason: "rule" };
      const token = parseBearerToken(authorization);
      const tokens = rule.tokens ?? config.tokens;
      if (token && tokens.includes(token)) {
        return { allowed: true, reason: "token" };
      }
      return { allowed: false, reason: "rule" };
    }

    case "basic": {
      if (!authorization) return { allowed: false, reason: "rule" };
      const creds = parseBasicAuth(authorization);
      if (creds) {
        const credString = `${creds.username}:${creds.password}`;
        if (config.basicAuth.includes(credString)) {
          return { allowed: true, reason: "basic" };
        }
      }
      return { allowed: false, reason: "rule" };
    }

    default:
      return { allowed: false, reason: "rule" };
  }
}

/**
 * Apply default policy
 */
function applyDefaultPolicy(
  config: AuthConfig,
  ip: string,
  authorization: string | undefined,
): AuthResult {
  switch (config.defaultPolicy) {
    case "allow":
      return { allowed: true, reason: "default" };

    case "deny":
      return { allowed: false, reason: "default" };

    case "basic": {
      if (!authorization) return { allowed: false, reason: "default" };
      const creds = parseBasicAuth(authorization);
      if (creds) {
        const credString = `${creds.username}:${creds.password}`;
        if (config.basicAuth.includes(credString)) {
          return { allowed: true, reason: "basic" };
        }
      }
      // Also check tokens as fallback
      const token = parseBearerToken(authorization);
      if (token && config.tokens.includes(token)) {
        return { allowed: true, reason: "token" };
      }
      return { allowed: false, reason: "default" };
    }

    case "token": {
      if (!authorization) return { allowed: false, reason: "default" };
      const token = parseBearerToken(authorization);
      if (token && config.tokens.includes(token)) {
        return { allowed: true, reason: "token" };
      }
      return { allowed: false, reason: "default" };
    }

    default:
      return { allowed: false, reason: "default" };
  }
}
