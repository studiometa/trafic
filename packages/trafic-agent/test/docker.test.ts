import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  installDocker,
  configureDocker,
  setupDockerPrune,
  addDockerAddressPools,
  restartDocker,
  DAEMON_CONFIG,
  DOCKER_ADDRESS_POOLS,
} from "../src/setup/docker.js";
import { runDockerAddressPoolsMigration } from "../src/setup/migrations/0018__docker_address_pools.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("installDocker", () => {
  it("skips the install when Docker is already present", () => {
    const io = createFakeIo({
      present: ["docker"],
      output: { "docker --version": "Docker version 27.0.0\n" },
    });

    installDocker(io);

    expect(io.ran("get.docker.com")).toBe(false);
  });

  it("downloads the install script before running it", () => {
    const io = createFakeIo();

    installDocker(io);

    // Piping the download into sh would report only sh's exit code
    const download = io.commands.find((c) => c.includes("get.docker.com"))!;
    expect(download).toContain("-o /tmp/get-docker.sh");
    expect(download).not.toContain("|");
    expect(io.ran("sh /tmp/get-docker.sh")).toBe(true);
  });

  it("removes the install script afterwards", () => {
    const io = createFakeIo();

    installDocker(io);

    expect(io.ran("rm /tmp/get-docker.sh")).toBe(true);
  });

  it("enables Docker so it survives a reboot", () => {
    const io = createFakeIo();

    installDocker(io);

    expect(io.ran("systemctl enable docker")).toBe(true);
    expect(io.ran("systemctl start docker")).toBe(true);
  });

  it("adds the ddev user to the docker group", () => {
    const io = createFakeIo();

    installDocker(io);

    // ddev runs the containers, so it needs the socket
    expect(io.ran("usermod -aG docker ddev")).toBe(true);
  });
});

describe("configureDocker", () => {
  it("caps container log size so logs cannot fill the disk", () => {
    const io = createFakeIo();

    configureDocker(io);

    const config = JSON.parse(io.written(DAEMON_CONFIG));
    expect(config["log-opts"]["max-size"]).toBe("10m");
    expect(config["log-opts"]["max-file"]).toBe("3");
  });

  it("keeps containers running across a daemon restart", () => {
    const io = createFakeIo();

    configureDocker(io);

    const config = JSON.parse(io.written(DAEMON_CONFIG));
    expect(config["live-restore"]).toBe(true);
    expect(config["storage-driver"]).toBe("overlay2");
  });

  it("merges into an existing config instead of replacing it", () => {
    const io = createFakeIo({
      files: {
        [DAEMON_CONFIG]: JSON.stringify({ "insecure-registries": ["x:5000"] }),
      },
    });

    configureDocker(io);

    const config = JSON.parse(io.written(DAEMON_CONFIG));
    expect(config["insecure-registries"]).toEqual(["x:5000"]);
    expect(config["live-restore"]).toBe(true);
  });

  it("leaves an unparseable config alone", () => {
    const io = createFakeIo({ files: { [DAEMON_CONFIG]: "{ not json" } });

    configureDocker(io);

    // Overwriting a config we cannot read could break the daemon
    expect(io.writes.has(DAEMON_CONFIG)).toBe(false);
    expect(io.ran("systemctl restart docker")).toBe(false);
  });

  it("gives Docker room for one network per project", () => {
    const io = createFakeIo();

    configureDocker(io);

    // The built-in pools run out at about 31 networks
    const config = JSON.parse(io.written(DAEMON_CONFIG));
    expect(config["default-address-pools"]).toEqual([{ base: "172.16.0.0/12", size: 24 }]);
  });

  it("restarts Docker to apply the config", () => {
    const io = createFakeIo();

    configureDocker(io);

    // A reload does not apply default-address-pools
    expect(io.ran("systemctl restart docker")).toBe(true);
    expect(io.ran("systemctl reload docker")).toBe(false);
  });
});

describe("restartDocker", () => {
  const overlay2 = { [DAEMON_CONFIG]: JSON.stringify({ "storage-driver": "overlay2" }) };
  const projects = JSON.stringify({
    raw: [
      { name: "alpha", status: "running" },
      { name: "beta", status: "stopped" },
      { name: "gamma", status: "running" },
    ],
  });

  it("restarts in place when the storage driver stays the same", () => {
    const io = createFakeIo({
      present: ["ddev"],
      files: overlay2,
      output: { "docker info": "overlay2" },
    });

    restartDocker(io);

    // live-restore keeps the containers up, so nothing is stopped
    expect(io.commands).toContain("systemctl restart docker");
    expect(io.ran("ddev poweroff")).toBe(false);
  });

  it("stops the projects before a restart that switches the storage driver", () => {
    const io = createFakeIo({
      present: ["ddev"],
      files: overlay2,
      output: { "docker info": "overlayfs", "ddev list -j": projects },
    });

    restartDocker(io);

    // dockerd forgets containers made with another driver, while live-restore
    // keeps their processes holding the database volumes
    const poweroff = io.commands.findIndex((c) => c.includes("ddev poweroff"));
    const restart = io.commands.indexOf("systemctl restart docker");
    expect(poweroff).toBeGreaterThan(-1);
    expect(poweroff).toBeLessThan(restart);
  });

  it("starts the projects that were running again after the switch", () => {
    const io = createFakeIo({
      present: ["ddev"],
      files: overlay2,
      output: { "docker info": "overlayfs", "ddev list -j": projects },
    });

    restartDocker(io);

    const start = io.commands.findIndex((c) => c.includes("ddev start alpha gamma"));
    expect(start).toBeGreaterThan(io.commands.indexOf("systemctl restart docker"));
    expect(io.ran("beta")).toBe(false);
  });

  it("does not compare when the config sets no storage driver", () => {
    const io = createFakeIo({
      present: ["ddev"],
      files: { [DAEMON_CONFIG]: "{}" },
      output: { "docker info": "overlayfs" },
    });

    restartDocker(io);

    // Docker keeps its current driver, so containers survive the restart
    expect(io.ran("ddev poweroff")).toBe(false);
    expect(io.commands).toContain("systemctl restart docker");
  });

  it("restarts in place when Docker does not answer", () => {
    const io = createFakeIo({ present: ["ddev"], files: overlay2, fails: ["docker info"] });

    restartDocker(io);

    expect(io.ran("ddev poweroff")).toBe(false);
    expect(io.commands).toContain("systemctl restart docker");
  });

  it("skips DDEV on a fresh server where it is not installed yet", () => {
    const io = createFakeIo({ files: overlay2, output: { "docker info": "overlayfs" } });

    restartDocker(io);

    // setup configures Docker before it installs DDEV
    expect(io.ran("ddev poweroff")).toBe(false);
    expect(io.ran("ddev start")).toBe(false);
    expect(io.commands).toContain("systemctl restart docker");
  });
});

describe("addDockerAddressPools", () => {
  it("adds the pools to an existing config", () => {
    const io = createFakeIo({
      files: { [DAEMON_CONFIG]: JSON.stringify({ "live-restore": true }) },
    });

    expect(addDockerAddressPools(io)).toBe(true);

    const config = JSON.parse(io.written(DAEMON_CONFIG));
    expect(config["live-restore"]).toBe(true);
    expect(config["default-address-pools"]).toEqual(DOCKER_ADDRESS_POOLS);
  });

  it("writes a config when there is none", () => {
    const io = createFakeIo();

    expect(addDockerAddressPools(io)).toBe(true);

    const config = JSON.parse(io.written(DAEMON_CONFIG));
    expect(config["default-address-pools"]).toEqual(DOCKER_ADDRESS_POOLS);
  });

  it("keeps pools an operator already set", () => {
    const pools = [{ base: "10.10.0.0/16", size: 24 }];
    const io = createFakeIo({
      files: { [DAEMON_CONFIG]: JSON.stringify({ "default-address-pools": pools }) },
    });

    expect(addDockerAddressPools(io)).toBe(false);

    expect(io.writes.has(DAEMON_CONFIG)).toBe(false);
  });

  it("leaves an unparseable config alone", () => {
    const io = createFakeIo({ files: { [DAEMON_CONFIG]: "{ not json" } });

    expect(addDockerAddressPools(io)).toBe(false);

    expect(io.writes.has(DAEMON_CONFIG)).toBe(false);
  });
});

describe("0018__docker_address_pools migration", () => {
  it("restarts Docker after adding the pools", () => {
    const io = createFakeIo({ files: { [DAEMON_CONFIG]: "{}" } });

    runDockerAddressPoolsMigration(io);

    expect(JSON.parse(io.written(DAEMON_CONFIG))["default-address-pools"]).toEqual(
      DOCKER_ADDRESS_POOLS,
    );
    expect(io.ran("systemctl restart docker")).toBe(true);
  });

  it("does not restart Docker when the pools are already set", () => {
    const io = createFakeIo({
      files: { [DAEMON_CONFIG]: JSON.stringify({ "default-address-pools": DOCKER_ADDRESS_POOLS }) },
    });

    runDockerAddressPoolsMigration(io);

    // A restart briefly drops the router, so skip it when nothing changed
    expect(io.ran("systemctl restart docker")).toBe(false);
  });

  it("stops the projects first when the restart switches the storage driver", () => {
    const io = createFakeIo({
      present: ["ddev"],
      files: { [DAEMON_CONFIG]: JSON.stringify({ "storage-driver": "overlay2" }) },
      output: { "docker info": "overlayfs" },
    });

    runDockerAddressPoolsMigration(io);

    // Servers set up before 0.1.47 ran the containerd store until this restart
    expect(io.ran("ddev poweroff")).toBe(true);
  });
});

describe("setupDockerPrune", () => {
  it("schedules a weekly prune", () => {
    const io = createFakeIo();

    setupDockerPrune(io);

    const cron = io.written("/etc/cron.d/trafic-docker-prune");
    expect(cron).toContain("0 3 * * 0");
    expect(cron).toContain("docker system prune -af --volumes");
  });

  it("makes the cron file readable by cron", () => {
    const io = createFakeIo();

    setupDockerPrune(io);

    expect(io.ran("chmod 644 /etc/cron.d/trafic-docker-prune")).toBe(true);
  });
});
