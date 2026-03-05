import { exec, execSilent } from "../steps.js";
import type { Migration } from "../types.js";

/**
 * Migration 0007: Allow trafic-agent port 9876 from Docker bridge subnets in UFW.
 *
 * UFW does not automatically allow traffic from Docker bridge networks.
 * Without this rule, ddev-router cannot reach the trafic-agent forward-auth
 * endpoint (172.18.0.1:9876), causing all auth checks to time out and traffic
 * to pass through unauthenticated.
 *
 * Condition: skip if the rule already exists.
 */
export const migration0007UfwDockerTraficPort: Migration = {
  id: "0007__ufw_docker_trafic_port",
  description: "Allow trafic-agent port 9876 from Docker bridge subnets in UFW",

  run(): void {
    const existing = execSilent("ufw status | grep '9876'");
    if (existing.includes("9876")) {
      return;
    }

    exec("ufw allow from 172.16.0.0/12 to any port 9876 comment 'trafic-agent from Docker'", {
      silent: true,
    });
  },
};
