import { dirname, join } from "node:path";
import { getDockerGatewayIp } from "../setup/ddev.js";
import { nodeIo, type SetupIo } from "../setup/io.js";

/**
 * Files DDEV reads the dynamic Traefik configuration from, relative to the
 * .ddev directory. Both are written by setup: DDEV 1.25+ picks up
 * custom-global-config, older versions watch the traefik root.
 */
const DYNAMIC_CONFIGS = [
  "traefik/trafic.yaml",
  "traefik/custom-global-config/trafic.yaml",
];

/** Matches the host in an agent URL, e.g. http://172.17.0.1:9876/__auth__ */
const AGENT_URL = /http:\/\/(\d+\.\d+\.\d+\.\d+):(\d+)/g;

/**
 * The address the forward-auth middleware currently points at.
 */
export function readForwardAuthAddress(content: string): string | undefined {
  const match = /http:\/\/(\d+\.\d+\.\d+\.\d+):\d+/.exec(content);
  return match?.[1];
}

/**
 * Point every agent URL in a dynamic config at a different host, keeping
 * each port as it was.
 */
export function rewriteForwardAuthAddress(
  content: string,
  gatewayIp: string,
): string {
  return content.replace(AGENT_URL, `http://${gatewayIp}:$2`);
}

/**
 * Correct the forward-auth address if the Docker gateway has moved.
 *
 * setup runs `configureTraefik` before any DDEV project exists, so the
 * `ddev_default` network is absent and the address falls back to the default
 * bridge. Once a project starts, that address is stale. Migration 0006 exists
 * to fix it on servers provisioned earlier, but `markAllMigrationsApplied()`
 * marks it applied on fresh ones, so nothing ever recomputed it.
 *
 * Traefik watches the dynamic config, so rewriting the file is enough — no
 * restart. Any failure is logged and ignored: a stale address is survivable,
 * an agent that will not start is not.
 */
export function syncForwardAuthAddress(
  projectListPath: string,
  io: SetupIo = nodeIo,
): void {
  try {
    const ddevDir = dirname(projectListPath);
    const gatewayIp = getDockerGatewayIp(io);
    const changed: string[] = [];

    for (const relative of DYNAMIC_CONFIGS) {
      const path = join(ddevDir, relative);

      if (!io.fileExists(path)) {
        continue;
      }

      const content = io.readFile(path);
      const current = readForwardAuthAddress(content);

      if (!current || current === gatewayIp) {
        continue;
      }

      io.writeFile(path, rewriteForwardAuthAddress(content, gatewayIp));
      changed.push(path);
    }

    if (changed.length > 0) {
      console.log(
        `Traefik forward auth: corrected address to ${gatewayIp} in ${changed.length} file(s)`,
      );
    }
  } catch (error) {
    console.warn(
      `Could not check the Traefik forward auth address: ${error instanceof Error ? error.message : error}`,
    );
  }
}
