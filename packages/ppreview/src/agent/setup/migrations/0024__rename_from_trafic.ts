import { AGENT_UNIT, BACKUP_DIR, createSystemdService } from "../agent.js";
import {
  configureTraefik,
  findRunningProject,
  readRouterPorts,
  ROUTER_COMPOSE_OVERRIDE,
  STATIC_CONFIG,
  TLS_STORE_CONFIG,
  TRAEFIK_DIR,
} from "../ddev.js";
import {
  DOCKER_FIREWALL_UNIT,
  configureDockerFirewall,
} from "../docker-firewall.js";
import { SSHD_DROPIN, UNATTENDED_UPGRADES_CONFIG } from "../hardening.js";
import { nodeIo, type SetupIo } from "../io.js";
import { info } from "../steps.js";
import { loadConfig } from "../../utils/config.js";
import type { Migration } from "../types.js";
import type { TlsConfig } from "../../types.js";
import { findRouterContainer } from "./0016__wildcard_dns_challenge.js";

/**
 * The paths of a server set up before the rename, when the project was
 * called Trafic (`@studiometa/trafic-agent` 0.1.64 and earlier). This
 * migration is the only code that still knows them.
 */
export const LEGACY_ETC_DIR = "/etc/trafic";

/** Where the migration state was kept before the rename. */
export const LEGACY_MIGRATIONS_STATE_FILE = `${LEGACY_ETC_DIR}/.migrations.json`;

const LEGACY_LIB_DIR = "/var/lib/trafic";
const LEGACY_BACKUP_DIR = "/var/backups/trafic";
const LEGACY_AGENT_UNIT = "/etc/systemd/system/trafic-agent.service";
const LEGACY_FIREWALL_UNIT = "/etc/systemd/system/trafic-docker-firewall.service";
const LEGACY_FIREWALL_SCRIPT = "/usr/local/sbin/trafic-docker-firewall";
const LEGACY_FIREWALL_CHAIN = "TRAFIC-DOCKER-USER";

/** The Traefik files of the agent, written again with the new names. */
const LEGACY_TRAEFIK_FILES = [
  `${TRAEFIK_DIR}/static_config.trafic.yaml`,
  `${TRAEFIK_DIR}/custom-global-config/trafic.yaml`,
  `${TRAEFIK_DIR}/custom-global-config/0-trafic-tls.yaml`,
  "/home/ddev/.ddev/router-compose.trafic.yaml",
];

/** Files that only change their name: old path, new path. */
const RENAMED_FILES: [string, string][] = [
  ["/etc/ssh/sshd_config.d/trafic.conf", SSHD_DROPIN],
  ["/etc/security/limits.d/trafic.conf", "/etc/security/limits.d/ppreview.conf"],
  ["/etc/dnsmasq.d/trafic.conf", "/etc/dnsmasq.d/ppreview.conf"],
  ["/etc/sudoers.d/trafic-ddev", "/etc/sudoers.d/ppreview-ddev"],
  ["/etc/cron.d/trafic-docker-prune", "/etc/cron.d/ppreview-docker-prune"],
];

/** Files that keep their path, but whose comments name the old project. */
const FILES_WITH_OLD_NAME = [UNATTENDED_UPGRADES_CONFIG, "/etc/fail2ban/jail.local"];

const CONFIG_FILE = "/etc/ppreview/config.toml";

/**
 * Migration 0024: move a Trafic server to the ppreview names.
 *
 * The project was renamed from Trafic to ppreview. The new agent reads its
 * config, its database and its backups at new paths, runs as a new systemd
 * unit, and names its Traefik middlewares, routers and files `ppreview-*`.
 * This moves an existing server to these names:
 *
 * 1. Stops and removes the `trafic-agent` service, so nothing writes to the
 *    database while it moves.
 * 2. Moves /etc/trafic, /var/lib/trafic and /var/backups/trafic to their
 *    ppreview paths, and points `db_path` and `[backup] dir` of the config
 *    at the new paths.
 * 3. Installs and starts the `ppreview-agent` service.
 * 4. Writes the Traefik files with the new names, removes the old ones, and
 *    recreates ddev-router through a project start (see migration 0016 for
 *    why a restart is not enough). The previews are down for the few seconds
 *    the router takes to come back.
 * 5. Installs the Docker firewall with its new chain, then removes the old
 *    chain, unit and script. The new rules are in place before the old ones
 *    go, so no published port is open meanwhile.
 * 6. Renames the other files that setup wrote (SSH, limits, dnsmasq,
 *    sudoers, cron) and the old name in their comments.
 *
 * It runs first, before the migrations that a server can still have pending:
 * those use the new paths. The migration state moves with /etc/trafic, and
 * `loadMigrationState` reads it at its old path until then.
 *
 * Idempotent: each step looks for the old path first, and does nothing when
 * it is gone. When an old directory and its new one both exist, the
 * migration stops: merge them by hand, then run the upgrade again.
 */
export const migration0024RenameFromTrafic: Migration = {
  id: "0024__rename_from_trafic",
  description: "Move a Trafic server to the ppreview names",

  run(): void {
    runRenameFromTraficMigration();
  },
};

/**
 * The migration body, with its effects injected so tests can drive it.
 *
 * `tls` is read after the config moved: configureTraefik needs the DNS
 * provider credentials of `[tls]`, as in migration 0016.
 */
export function runRenameFromTraficMigration(
  io: SetupIo = nodeIo,
  tls: () => TlsConfig = () => loadConfig().tls,
): void {
  stopLegacyAgent(io);

  moveDirectory(LEGACY_ETC_DIR, "/etc/ppreview", io);
  moveDirectory(LEGACY_LIB_DIR, "/var/lib/ppreview", io);
  moveDirectory(LEGACY_BACKUP_DIR, BACKUP_DIR, io);
  renameConfigPaths(io);

  if (io.fileExists(CONFIG_FILE) && !io.fileExists(AGENT_UNIT)) {
    // Writes the unit, then enables and starts the service; upgrade
    // restarts it at the end
    createSystemdService(io);
  }

  const traefikMoved = renameTraefikFiles(tls, io);

  renameDockerFirewall(io);

  for (const [from, to] of RENAMED_FILES) {
    renameFile(from, to, io);
    replaceOldName(to, io);
  }

  for (const path of FILES_WITH_OLD_NAME) {
    replaceOldName(path, io);
  }

  if (traefikMoved) {
    recreateRouter(io);
  }
}

/** Stop and remove the `trafic-agent` service. */
function stopLegacyAgent(io: SetupIo): void {
  if (!io.fileExists(LEGACY_AGENT_UNIT)) {
    return;
  }

  io.exec("systemctl disable --now trafic-agent", { silent: true });
  io.exec(`rm -f ${LEGACY_AGENT_UNIT}`, { silent: true });
  io.exec("systemctl daemon-reload", { silent: true });
}

/**
 * Move a directory with its owner and its mode. Throws when both exist:
 * merging them could overwrite a config or a database.
 */
function moveDirectory(from: string, to: string, io: SetupIo): void {
  if (!io.fileExists(from)) {
    return;
  }

  if (io.fileExists(to)) {
    throw new Error(
      `${from} and ${to} both exist: move what ${from} holds into ${to}, remove ${from}, then run the upgrade again`,
    );
  }

  io.exec(`mv ${from} ${to}`, { silent: true });
}

/**
 * Point the paths of the config at the moved directories.
 *
 * Only these paths and the comments change: a value such as a password can
 * contain the old name and must stay as it is.
 */
function renameConfigPaths(io: SetupIo): void {
  if (!io.fileExists(CONFIG_FILE)) {
    return;
  }

  const current = io.readFile(CONFIG_FILE);
  const updated = current
    .split("\n")
    .map((line) =>
      line.trimStart().startsWith("#")
        ? renameText(line)
        : line
            .replaceAll(`${LEGACY_LIB_DIR}/`, "/var/lib/ppreview/")
            .replaceAll(LEGACY_BACKUP_DIR, BACKUP_DIR),
    )
    .join("\n");

  if (updated !== current) {
    io.writeFile(CONFIG_FILE, updated);
  }
}

/**
 * Write the Traefik files with the new names, and remove the old ones.
 * Returns whether old files were found, so the router must be recreated.
 *
 * The old files are removed before any project start: DDEV copies every file
 * of `custom-global-config` into the router, and the old routers would then
 * come back next to the new ones.
 */
function renameTraefikFiles(tls: () => TlsConfig, io: SetupIo): boolean {
  const legacy = LEGACY_TRAEFIK_FILES.filter((path) => io.fileExists(path));

  if (legacy.length === 0) {
    return false;
  }

  // Writes STATIC_CONFIG, the dynamic config, ROUTER_COMPOSE_OVERRIDE and,
  // with a DNS provider, TLS_STORE_CONFIG
  configureTraefik({ tls: tls() }, io);
  io.exec(`rm -f ${legacy.join(" ")}`, { silent: true });

  info(`Traefik files renamed: ${[STATIC_CONFIG, ROUTER_COMPOSE_OVERRIDE, TLS_STORE_CONFIG].join(", ")}`);

  return true;
}

/**
 * Install the Docker firewall under its new names, then remove the old one.
 *
 * configureDockerFirewall reads the ports with forward auth from the new
 * static config, so this runs after renameTraefikFiles.
 */
function renameDockerFirewall(io: SetupIo): void {
  if (!io.fileExists(LEGACY_FIREWALL_UNIT)) {
    return;
  }

  if (!io.fileExists(DOCKER_FIREWALL_UNIT)) {
    configureDockerFirewall(readRouterPorts(io), io);
  }

  io.exec(`systemctl disable ${LEGACY_FIREWALL_UNIT.split("/").pop()}`, { silent: true });
  io.exec(`rm -f ${LEGACY_FIREWALL_UNIT} ${LEGACY_FIREWALL_SCRIPT}`, { silent: true });
  io.exec("systemctl daemon-reload", { silent: true });

  // A family without the chain (no ip6tables, say) fails here, which is
  // fine: there is nothing to remove
  for (const cmd of ["iptables", "ip6tables"]) {
    io.execSilent(
      `while ${cmd} -D DOCKER-USER -j ${LEGACY_FIREWALL_CHAIN} 2>/dev/null; do :; done; ` +
        `${cmd} -F ${LEGACY_FIREWALL_CHAIN} && ${cmd} -X ${LEGACY_FIREWALL_CHAIN}`,
    );
  }
}

/** Rename a file. When the new one already exists, remove the old one. */
function renameFile(from: string, to: string, io: SetupIo): void {
  if (!io.fileExists(from)) {
    return;
  }

  io.exec(io.fileExists(to) ? `rm -f ${from}` : `mv ${from} ${to}`, { silent: true });
}

/** Replace the old name in a file that setup wrote. */
function replaceOldName(path: string, io: SetupIo): void {
  if (!io.fileExists(path)) {
    return;
  }

  const current = io.readFile(path);
  const updated = renameText(current);

  if (updated !== current) {
    io.writeFile(path, updated);
  }
}

/** "Trafic" and "trafic" become "ppreview": "trafic-agent upgrade", say. */
function renameText(text: string): string {
  return text.replace(/[Tt]rafic/g, "ppreview");
}

/**
 * Recreate ddev-router through a project start, so that it reads the new
 * static config and the new compose override. Without a running project,
 * the next project start does it.
 */
function recreateRouter(io: SetupIo): void {
  const project = findRunningProject(io);

  if (!project) {
    info("No running project — the next project start applies the new Traefik files");
    return;
  }

  const router = findRouterContainer(io);

  if (router) {
    io.execSilent(`docker rm -f ${router}`);
  }

  io.exec(`su - ddev -c 'DDEV_NONINTERACTIVE=true ddev start ${project}'`, {
    silent: true,
  });
}
