import { info, warn } from "../steps.js";
import { nodeIo, type SetupIo } from "../io.js";
import type { Migration } from "../types.js";

/** How long a container gets to stop after SIGTERM, in seconds. */
export const STOP_TIMEOUT = 600;

/**
 * Migration 0019: stop the containers Docker lost track of in migration 0018.
 *
 * 0018 restarted Docker to apply the address pools. On a server set up before
 * 0.1.47, Docker ran the containerd image store (`overlayfs`) although
 * daemon.json asked for `overlay2`, and the restart switched the driver.
 * dockerd skips containers created with another driver, so it forgot every
 * running container — but `live-restore` had left their processes running.
 * Those orphans keep the locks on the project volumes: each new database
 * container exits on "Can't lock aria control file", each Elasticsearch on
 * "failed to obtain node locks", and the project never starts again. Seen
 * on a live server: 66 orphans, 27 of them databases.
 *
 * containerd still knows the orphans: they are the tasks in the `moby`
 * namespace with no matching Docker container. Each one gets SIGTERM, which
 * MariaDB, MySQL and Elasticsearch handle as a clean shutdown, and as long as
 * it needs. No SIGKILL: a database killed mid-write is the one outcome worse
 * than the outage, so a process that does not stop is reported and left
 * alone. The stopped tasks are then deleted, which ends their shims.
 *
 * Nothing is restarted here: the volumes are free again, and the agent starts
 * each project on its next request, on the new driver.
 *
 * Idempotent: does nothing when every containerd task belongs to a container
 * Docker knows.
 */
export const migration0019RecoverOrphanContainers: Migration = {
  id: "0019__recover_orphan_containers",
  description: "Stop the containers Docker lost track of when it changed storage driver",

  run(): void {
    recoverOrphanContainers();
  },
};

/** A containerd task: the container id, its PID 1 on the host, its status. */
interface Task {
  id: string;
  pid: string;
  status: string;
}

/**
 * The migration body, with its effects injected so tests can drive it.
 */
export function recoverOrphanContainers(io: SetupIo = nodeIo): void {
  const known = new Set(io.execSilent("docker ps -aq --no-trunc").split("\n").filter(Boolean));
  const orphans = parseTasks(io.execSilent("ctr -n moby tasks ls")).filter(
    (task) => !known.has(task.id),
  );

  if (orphans.length === 0) {
    return;
  }

  info(`Stopping ${orphans.length} container(s) Docker no longer tracks`);

  const running = orphans.filter((task) => task.status === "RUNNING");

  for (const task of running) {
    io.execSilent(`kill -TERM ${task.pid}`);
  }

  const stuck = running.filter((task) => {
    io.execSilent(`timeout ${STOP_TIMEOUT} tail --pid=${task.pid} -f /dev/null`);
    return io.fileExists(`/proc/${task.pid}`);
  });

  for (const task of orphans.filter((task) => !stuck.includes(task))) {
    io.execSilent(`ctr -n moby tasks delete ${task.id}`);
  }

  for (const task of stuck) {
    warn(`Container ${task.id.slice(0, 12)} (PID ${task.pid}) did not stop, left running`);
  }
}

/**
 * Parse `ctr tasks ls`: a header, then one `TASK PID STATUS` row per task.
 */
function parseTasks(output: string): Task[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 3)
    .map(([id, pid, status]) => ({ id: id!, pid: pid!, status: status! }));
}
