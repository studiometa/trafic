import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  installAgent,
  createAgentConfig,
  createSystemdService,
} from "../src/setup/agent.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const CONFIG_PATH = "/etc/trafic/config.toml";
const UNIT_PATH = "/etc/systemd/system/trafic-agent.service";

describe("installAgent", () => {
  it("installs the published package globally", () => {
    const io = createFakeIo();

    installAgent(io);

    expect(io.ran("npm install -g @studiometa/trafic-agent")).toBe(true);
  });
});

describe("createAgentConfig", () => {
  it("writes the TLD it was given", () => {
    const io = createFakeIo();

    createAgentConfig("previews.example.com", undefined, io);

    expect(io.written(CONFIG_PATH)).toContain('tld = "previews.example.com"');
  });

  it("defaults to requiring basic auth", () => {
    const io = createFakeIo();

    createAgentConfig("previews.example.com", undefined, io);

    // A default of anything open would expose every preview
    expect(io.written(CONFIG_PATH)).toContain('default_policy = "basic"');
  });

  it("restricts the config to root and the agent group", () => {
    const io = createFakeIo();

    createAgentConfig("previews.example.com", undefined, io);

    // The file holds auth tokens and basic auth credentials
    expect(io.ran(`chmod 640 ${CONFIG_PATH}`)).toBe(true);
    expect(io.ran(`chown root:ddev ${CONFIG_PATH}`)).toBe(true);
  });

  it("never overwrites an existing config", () => {
    const io = createFakeIo({
      files: { [CONFIG_PATH]: 'tld = "existing.example.com"\n' },
    });

    createAgentConfig("new.example.com", undefined, io);

    // Overwriting would wipe the operator's auth rules on a re-run
    expect(io.writes.has(CONFIG_PATH)).toBe(false);
  });

  it("creates the state directory owned by the agent user", () => {
    const io = createFakeIo();

    createAgentConfig("previews.example.com", undefined, io);

    expect(io.ran("mkdir -p /var/lib/trafic")).toBe(true);
    expect(io.ran("chown ddev:ddev /var/lib/trafic")).toBe(true);
  });
});

describe("createSystemdService", () => {
  it("uses the resolved binary path in ExecStart", () => {
    const io = createFakeIo({
      output: { "which trafic-agent": "/usr/bin/trafic-agent\n" },
    });

    createSystemdService(io);

    expect(io.written(UNIT_PATH)).toContain(
      "ExecStart=/usr/bin/trafic-agent start --config /etc/trafic/config.toml",
    );
  });

  it("falls back to a sensible path when the binary is not on PATH", () => {
    const io = createFakeIo();

    createSystemdService(io);

    expect(io.written(UNIT_PATH)).toContain("ExecStart=/usr/bin/trafic-agent");
  });

  it("runs the agent as the unprivileged ddev user", () => {
    const io = createFakeIo();

    createSystemdService(io);

    const unit = io.written(UNIT_PATH);
    expect(unit).toContain("User=ddev");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectSystem=strict");
  });

  it("grants write access only to the paths the agent needs", () => {
    const io = createFakeIo();

    createSystemdService(io);

    expect(io.written(UNIT_PATH)).toContain(
      "ReadWritePaths=/var/lib/trafic /home/ddev/.ddev",
    );
  });

  it("sets DDEV_NONINTERACTIVE so ddev-hostname never blocks a start", () => {
    const io = createFakeIo();

    createSystemdService(io);

    expect(io.written(UNIT_PATH)).toContain("Environment=DDEV_NONINTERACTIVE=true");
  });

  it("waits for Docker before starting", () => {
    const io = createFakeIo();

    createSystemdService(io);

    const unit = io.written(UNIT_PATH);
    expect(unit).toContain("After=network.target docker.service");
    expect(unit).toContain("Requires=docker.service");
  });

  it("restarts the agent if it exits", () => {
    const io = createFakeIo();

    createSystemdService(io);

    expect(io.written(UNIT_PATH)).toContain("Restart=always");
  });

  it("reloads systemd before enabling the unit", () => {
    const io = createFakeIo();

    createSystemdService(io);

    const reload = io.commands.indexOf("systemctl daemon-reload");
    const enable = io.commands.indexOf("systemctl enable trafic-agent");
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(reload);
  });
});
