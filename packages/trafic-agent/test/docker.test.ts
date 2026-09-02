import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  installDocker,
  configureDocker,
  setupDockerPrune,
} from "../src/setup/docker.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const DAEMON_CONFIG = "/etc/docker/daemon.json";

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
    expect(io.ran("systemctl reload docker")).toBe(false);
  });

  it("reloads Docker to apply the config", () => {
    const io = createFakeIo();

    configureDocker(io);

    expect(io.ran("systemctl reload docker")).toBe(true);
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
