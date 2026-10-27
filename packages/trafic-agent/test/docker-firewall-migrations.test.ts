import { existsSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { exec, writeFile } from "../src/setup/steps.js";
import { DOCKER_FIREWALL_SCRIPT } from "../src/setup/docker-firewall.js";
import { migration0012DockerUserToolPorts } from "../src/setup/migrations/0012__docker_user_tool_ports.js";
import { migration0022DockerUserDefaultDeny } from "../src/setup/migrations/0022__docker_user_default_deny.js";

// run() uses the real io. Its commands and writes must not reach the test
// machine; the progress logging stays real.
vi.mock("../src/setup/steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/setup/steps.js")>()),
  exec: vi.fn(() => ""),
  execSilent: vi.fn(() => ""),
  writeFile: vi.fn(),
}));

console.log = () => {};

/** Whether this machine is a Trafic server, where run() takes the other path. */
const hasScript = existsSync(DOCKER_FIREWALL_SCRIPT);

beforeEach(() => {
  vi.mocked(exec).mockClear();
  vi.mocked(writeFile).mockClear();
});

describe.skipIf(hasScript)("Docker firewall migrations on a server without the script", () => {
  it("0012 installs the script with the router ports", () => {
    migration0012DockerUserToolPorts.run();

    expect(writeFile).toHaveBeenCalledWith(
      DOCKER_FIREWALL_SCRIPT,
      expect.stringContaining('ALLOWED_PORTS="80 443"'),
    );
    expect(exec).toHaveBeenCalledWith("systemctl restart trafic-docker-firewall.service", {
      silent: true,
    });
  });

  it("0022 does nothing", () => {
    migration0022DockerUserDefaultDeny.run();

    expect(writeFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
