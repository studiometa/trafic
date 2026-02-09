import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AuditCheck } from "./types.js";

/**
 * Run a command silently and return output
 */
function execSilent(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

/**
 * Check if a service is active
 */
function isServiceActive(service: string): boolean {
  const status = execSilent(`systemctl is-active ${service}`);
  return status === "active";
}

/**
 * Audit SSH configuration
 */
function auditSsh(): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Check root login
  const sshdConfig = existsSync("/etc/ssh/sshd_config")
    ? readFileSync("/etc/ssh/sshd_config", "utf-8")
    : "";
  const traficConfig = existsSync("/etc/ssh/sshd_config.d/trafic.conf")
    ? readFileSync("/etc/ssh/sshd_config.d/trafic.conf", "utf-8")
    : "";

  const config = sshdConfig + "\n" + traficConfig;

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
function auditFirewall(): AuditCheck[] {
  const checks: AuditCheck[] = [];

  const ufwStatus = execSilent("ufw status");
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
function auditServices(): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Fail2ban
  const fail2banActive = isServiceActive("fail2ban");
  checks.push({
    name: "Fail2ban",
    status: fail2banActive ? "pass" : "warn",
    message: fail2banActive ? "Fail2ban is active" : "Fail2ban is not running",
    fix: "Run: apt install fail2ban && systemctl enable fail2ban --now",
  });

  // Unattended upgrades
  const unattendedActive = isServiceActive("unattended-upgrades");
  checks.push({
    name: "Automatic updates",
    status: unattendedActive ? "pass" : "warn",
    message: unattendedActive
      ? "Unattended upgrades enabled"
      : "Automatic updates not configured",
    fix: "Run: apt install unattended-upgrades && dpkg-reconfigure unattended-upgrades",
  });

  // Trafic agent
  const agentActive = isServiceActive("trafic-agent");
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
function auditDocker(): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Docker running
  const dockerActive = isServiceActive("docker");
  checks.push({
    name: "Docker",
    status: dockerActive ? "pass" : "fail",
    message: dockerActive ? "Docker is running" : "Docker is not running",
    fix: "Run: systemctl start docker",
  });

  // Dangling images
  const danglingImages = execSilent(
    "docker images -f dangling=true -q | wc -l",
  );
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
  const diskUsage = execSilent("df -h / | awk 'NR==2{print $5}'");
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
function auditPermissions(): AuditCheck[] {
  const checks: AuditCheck[] = [];

  // Config file
  if (existsSync("/etc/trafic/config.toml")) {
    const stats = execSilent("stat -c '%a' /etc/trafic/config.toml");
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
  if (existsSync("/home/ddev/www")) {
    const owner = execSilent("stat -c '%U:%G' /home/ddev/www");
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
 * Run all audit checks
 */
export function runAudit(): AuditCheck[] {
  return [
    ...auditSsh(),
    ...auditFirewall(),
    ...auditServices(),
    ...auditDocker(),
    ...auditPermissions(),
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
