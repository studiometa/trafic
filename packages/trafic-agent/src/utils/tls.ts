import { existsSync, readFileSync } from "node:fs";
import { DNS_RESOLVER, STATIC_CONFIG } from "../setup/ddev.js";
import type { AgentConfig } from "../types.js";

/**
 * Warn when the config asks for a wildcard certificate that Traefik never got.
 *
 * The files are written by setup and by migration 0016, not by the running
 * agent: writing them needs root, and applying them needs a project start.
 * So this only reports, and says which command fixes it.
 */
export function warnIfWildcardNotApplied(
  config: AgentConfig,
  staticConfigPath: string = STATIC_CONFIG,
): boolean {
  if (!config.tls.dnsProvider) {
    return false;
  }

  const configured =
    existsSync(staticConfigPath) &&
    readFileSync(staticConfigPath, "utf-8").includes(`${DNS_RESOLVER}:`);

  if (configured) {
    return false;
  }

  console.warn(
    `tls.dns_provider is set to "${config.tls.dnsProvider}" but Traefik has no ${DNS_RESOLVER} resolver.`,
  );
  console.warn(
    "  The wildcard certificate is not being requested. Run `sudo trafic-agent upgrade`, or re-run setup.",
  );

  return true;
}
