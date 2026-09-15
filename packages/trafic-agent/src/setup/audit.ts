import type { AuditCheck } from "./types.js";
import { nodeIo, type SetupIo } from "./io.js";
import { loadConfig } from "../utils/config.js";
import { ROUTER_COMPOSE_OVERRIDE } from "./ddev.js";
import type { AgentConfig } from "../types.js";

/**
 * Check if a service is active
 */
function isServiceActive(service: string, io: SetupIo): boolean {
  return io.execSilent(`systemctl is-active ${service}`) === "active";
}

/** Read a file, or "" when it does not exist. */
function readOrEmpty(path: string, io: SetupIo): string {
  return io.fileExists(path) ? io.readFile(path) : "";
}

/**
 * Audit SSH configuration
 */
export function auditSsh(io: SetupIo = nodeIo): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Check root login
  const config =
    readOrEmpty("/etc/ssh/sshd_config", io) +
    "\n" +
    readOrEmpty("/etc/ssh/sshd_config.d/trafic.conf", io);

  const rootLoginDisabled =
    config.includes("PermitRootLogin no") ||
    config.includes("PermitRootLogin prohibit-password");
  checks.push({
    name: "SSH root login",
    status: rootLoginDisabled ? "pass" : "fail",
    message: rootLoginDisabled
      ? "Root login disabled"
      : "Root login may be enabled",
    fix: "Add 'PermitRootLogin no' to /etc/ssh/sshd_config.d/trafic.conf",
  });

  const passwordAuthDisabled = config.includes("PasswordAuthentication no");
  checks.push({
    name: "SSH password auth",
    status: passwordAuthDisabled ? "pass" : "warn",
    message: passwordAuthDisabled
      ? "Password authentication disabled"
      : "Password authentication may be enabled",
    fix: "Add 'PasswordAuthentication no' to /etc/ssh/sshd_config.d/trafic.conf",
  });

  return checks;
}

/**
 * Audit firewall configuration
 */
export function auditFirewall(io: SetupIo = nodeIo): AuditCheck[] {
  const checks: AuditCheck[] = [];

  const ufwStatus = io.execSilent("ufw status");
  const isActive = ufwStatus.includes("Status: active");

  checks.push({
    name: "Firewall (UFW)",
    status: isActive ? "pass" : "fail",
    message: isActive ? "UFW is active" : "UFW is not active",
    fix: "Run: ufw enable",
  });

  if (isActive) {
    const allows22 = ufwStatus.includes("22/tcp");
    const allows80 = ufwStatus.includes("80/tcp");
    const allows443 = ufwStatus.includes("443/tcp");

    if (allows22 && allows80 && allows443) {
      checks.push({
        name: "Firewall ports",
        status: "pass",
        message: "Required ports (22, 80, 443) are open",
      });
    } else {
      checks.push({
        name: "Firewall ports",
        status: "warn",
        message: "Some required ports may be blocked",
        fix: "Run: ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp",
      });
    }
  }

  return checks;
}

/**
 * Audit security services
 */
export function auditServices(io: SetupIo = nodeIo): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Fail2ban
  const fail2banActive = isServiceActive("fail2ban", io);
  checks.push({
    name: "Fail2ban",
    status: fail2banActive ? "pass" : "warn",
    message: fail2banActive ? "Fail2ban is active" : "Fail2ban is not running",
    fix: "Run: apt install fail2ban && systemctl enable fail2ban --now",
  });

  // Unattended upgrades
  const unattendedActive = isServiceActive("unattended-upgrades", io);
  checks.push({
    name: "Automatic updates",
    status: unattendedActive ? "pass" : "warn",
    message: unattendedActive
      ? "Unattended upgrades enabled"
      : "Automatic updates not configured",
    fix: "Run: apt install unattended-upgrades && dpkg-reconfigure unattended-upgrades",
  });

  // Trafic agent
  const agentActive = isServiceActive("trafic-agent", io);
  checks.push({
    name: "Trafic agent",
    status: agentActive ? "pass" : "fail",
    message: agentActive
      ? "Trafic agent is running"
      : "Trafic agent is not running",
    fix: "Run: systemctl start trafic-agent",
  });

  return checks;
}

/**
 * Audit Docker
 */
export function auditDocker(io: SetupIo = nodeIo): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Docker running
  const dockerActive = isServiceActive("docker", io);
  checks.push({
    name: "Docker",
    status: dockerActive ? "pass" : "fail",
    message: dockerActive ? "Docker is running" : "Docker is not running",
    fix: "Run: systemctl start docker",
  });

  // Dangling images
  const danglingImages = io.execSilent("docker images -f dangling=true -q | wc -l");
  const count = parseInt(danglingImages, 10) || 0;
  if (count > 0) {
    checks.push({
      name: "Docker cleanup",
      status: "warn",
      message: `${count} dangling Docker images`,
      fix: "Run: docker system prune -f",
    });
  }

  // Disk usage
  const diskUsage = io.execSilent("df -h / | awk 'NR==2{print $5}'");
  const usagePercent = parseInt(diskUsage, 10) || 0;
  checks.push({
    name: "Disk usage",
    status: usagePercent > 90 ? "fail" : usagePercent > 80 ? "warn" : "pass",
    message: `Disk usage: ${diskUsage}`,
    fix: usagePercent > 80 ? "Consider cleaning up old projects or Docker resources" : undefined,
  });

  return checks;
}

/**
 * Audit file permissions
 */
export function auditPermissions(io: SetupIo = nodeIo): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Config file
  if (io.fileExists("/etc/trafic/config.toml")) {
    const stats = io.execSilent("stat -c '%a' /etc/trafic/config.toml");
    const isSecure = stats === "640" || stats === "600";
    checks.push({
      name: "Config permissions",
      status: isSecure ? "pass" : "warn",
      message: isSecure
        ? "Config file has secure permissions"
        : `Config file permissions: ${stats} (should be 640)`,
      fix: "Run: chmod 640 /etc/trafic/config.toml",
    });
  }

  // Projects directory
  if (io.fileExists("/home/ddev/www")) {
    const owner = io.execSilent("stat -c '%U:%G' /home/ddev/www");
    const isCorrect = owner === "ddev:ddev";
    checks.push({
      name: "Projects directory",
      status: isCorrect ? "pass" : "warn",
      message: isCorrect
        ? "Projects directory owned by ddev"
        : `Projects directory owner: ${owner}`,
      fix: "Run: chown ddev:ddev /home/ddev/www",
    });
  }

  return checks;
}

/**
 * Audit the wildcard certificate, where one is configured.
 *
 * Two things go wrong silently: the certificate is never issued (a wrong
 * token, a zone the token cannot edit), and the token file ends up readable
 * by everyone.
 */
export function auditWildcardTls(
  config: AgentConfig,
  io: SetupIo = nodeIo,
): AuditCheck[] {
  if (!config.tls.dnsProvider) {
    return [];
  }

  const checks: AuditCheck[] = [];

  checks.push(wildcardCertificateCheck(config.tld, io));

  if (io.fileExists(ROUTER_COMPOSE_OVERRIDE)) {
    const mode = io.execSilent(`stat -c '%a' ${ROUTER_COMPOSE_OVERRIDE}`);
    const isSecure = mode === "600";

    checks.push({
      name: "DNS credentials permissions",
      status: isSecure ? "pass" : "warn",
      message: isSecure
        ? "Router compose override is readable by its owner only"
        : `Router compose override permissions: ${mode} (should be 600)`,
      fix: `Run: chmod 600 ${ROUTER_COMPOSE_OVERRIDE}`,
    });
  }

  return checks;
}

/** Look for the wildcard certificate in Traefik's DNS-01 ACME storage. */
function wildcardCertificateCheck(tld: string, io: SetupIo): AuditCheck {
  const fix =
    "Check the router log for ACME errors: docker logs ddev-router 2>&1 | grep -i acme";

  const mountpoint = io.execSilent(
    "docker volume inspect ddev-global-cache --format '{{.Mountpoint}}'",
  );

  if (!mountpoint) {
    return {
      name: "Wildcard certificate",
      status: "warn",
      message: "Traefik's storage volume (ddev-global-cache) was not found",
      fix,
    };
  }

  const storage = `${mountpoint}/traefik/acme-dns.json`;

  if (!io.fileExists(storage)) {
    return {
      name: "Wildcard certificate",
      status: "warn",
      message: "No DNS-01 certificate has been issued yet",
      fix,
    };
  }

  const issued = hasCertificateFor(io.readFile(storage), tld);

  return {
    name: "Wildcard certificate",
    status: issued ? "pass" : "warn",
    message: issued
      ? `Wildcard certificate issued for *.${tld}`
      : `No certificate for ${tld} in Traefik's DNS-01 storage`,
    fix: issued ? undefined : fix,
  };
}

/**
 * Whether Traefik's ACME storage holds a certificate whose main domain is the
 * TLD — which is the wildcard one, since that is what the default store asks
 * for.
 *
 * The file is keyed by resolver name, each with a Certificates array.
 */
export function hasCertificateFor(storage: string, tld: string): boolean {
  let parsed: unknown;

  try {
    parsed = JSON.parse(storage);
  } catch {
    return false;
  }

  if (parsed === null || typeof parsed !== "object") {
    return false;
  }

  for (const resolver of Object.values(parsed as Record<string, unknown>)) {
    const certificates = (resolver as { Certificates?: unknown }).Certificates;

    if (!Array.isArray(certificates)) {
      continue;
    }

    for (const certificate of certificates) {
      const main = (certificate as { domain?: { main?: unknown } }).domain?.main;

      if (main === tld) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Run all audit checks
 */
export function runAudit(io: SetupIo = nodeIo, config: AgentConfig = loadConfig()): AuditCheck[] {
  return [
    ...auditSsh(io),
    ...auditFirewall(io),
    ...auditServices(io),
    ...auditDocker(io),
    ...auditPermissions(io),
    ...auditWildcardTls(config, io),
  ];
}

/**
 * Print audit results
 */
export function printAuditResults(checks: AuditCheck[]): void {
  console.log("\n\x1b[1mSecurity Audit Results\x1b[0m\n");

  for (const check of checks) {
    const icon =
      check.status === "pass"
        ? "\x1b[32m✓\x1b[0m"
        : check.status === "warn"
          ? "\x1b[33m⚠\x1b[0m"
          : "\x1b[31m✗\x1b[0m";

    console.log(`${icon} \x1b[1m${check.name}\x1b[0m: ${check.message}`);

    if (check.fix && check.status !== "pass") {
      console.log(`  \x1b[90m${check.fix}\x1b[0m`);
    }
  }

  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  console.log(
    `\n\x1b[1mSummary:\x1b[0m ${passed} passed, ${warnings} warnings, ${failed} failed`,
  );
}
