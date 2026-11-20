import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../../src/agent/setup/migrations/index.js";
import {
  migration0025PurgeTraficVolumeFiles,
  purgeTraficVolumeFiles,
} from "../../src/agent/setup/migrations/0025__purge_trafic_volume_files.js";
import { createFakeIo } from "./helpers/fake-io.js";

const INSPECT = "docker volume inspect ddev-global-cache --format '{{.Mountpoint}}'";
const MOUNT = "/var/lib/docker/volumes/ddev-global-cache/_data";
const LS = `find ${MOUNT}/traefik -maxdepth 2 -type f -name '*trafic*'`;

describe("migration 0025: purge the Trafic files from the volume", () => {
  it("is registered last, after 0023", () => {
    const ids = ALL_MIGRATIONS.map((m) => m.id);

    expect(ids.at(-1)).toBe(migration0025PurgeTraficVolumeFiles.id);
    expect(ids.at(-2)).toBe("0023__router_restart_policy");
  });

  it("removes the old static and dynamic files, then restarts the router", () => {
    const io = createFakeIo({
      output: {
        [INSPECT]: `${MOUNT}\n`,
        [LS]: [
          `${MOUNT}/traefik/static_config.trafic.yaml`,
          `${MOUNT}/traefik/config/trafic.yaml`,
          `${MOUNT}/traefik/config/0-trafic-tls.yaml`,
          "",
        ].join("\n"),
      },
    });

    expect(purgeTraficVolumeFiles(io)).toBe(true);

    expect(io.commands).toContain(
      `rm -f ${MOUNT}/traefik/static_config.trafic.yaml ${MOUNT}/traefik/config/trafic.yaml ${MOUNT}/traefik/config/0-trafic-tls.yaml`,
    );
    const remove = io.commands.findIndex((c) => c.startsWith("rm -f"));
    expect(io.commands.indexOf("docker restart ddev-router")).toBeGreaterThan(remove);
  });

  it("leaves the router alone when the volume has no old file", () => {
    const io = createFakeIo({ output: { [INSPECT]: `${MOUNT}\n`, [LS]: "" } });

    expect(purgeTraficVolumeFiles(io)).toBe(false);
    expect(io.ran("rm -f")).toBe(false);
    expect(io.ran("docker restart")).toBe(false);
  });

  it("does nothing on a server without the volume", () => {
    const io = createFakeIo();

    expect(purgeTraficVolumeFiles(io)).toBe(false);
    expect(io.commands).toEqual([INSPECT]);
  });

  it("does not fail when the router does not run", () => {
    const io = createFakeIo({
      output: { [INSPECT]: `${MOUNT}\n`, [LS]: `${MOUNT}/traefik/config/trafic.yaml\n` },
      fails: ["docker restart ddev-router"],
    });

    expect(purgeTraficVolumeFiles(io)).toBe(true);
  });
});
