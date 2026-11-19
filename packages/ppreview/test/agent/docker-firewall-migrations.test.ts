import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exec, writeFile } from "../../src/agent/setup/steps.js";
import { DOCKER_FIREWALL_SCRIPT } from "../../src/agent/setup/docker-firewall.js";
import { nodeIo } from "../../src/agent/setup/io.js";
import { STATIC_CONFIG } from "../../src/agent/setup/ddev.js";
import { migration0012DockerUserToolPorts } from "../../src/agent/setup/migrations/0012__docker_user_tool_ports.js";
import { migration0022DockerUserDefaultDeny } from "../../src/agent/setup/migrations/0022__docker_user_default_deny.js";

// run() uses the real io. Its commands and writes must not reach the test
// machine; the progress logging stays real.
vi.mock("../../src/agent/setup/steps.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agent/setup/steps.js")>()),
  exec: vi.fn(() => ""),
  execSilent: vi.fn(() => ""),
  writeFile: vi.fn(),
}));

console.log = () => {};

beforeEach(() => {
  vi.mocked(exec).mockClear();
  vi.mocked(writeFile).mockClear();
  vi.spyOn(nodeIo, "fileExists").mockImplementation((path) => path === STATIC_CONFIG);
  vi.spyOn(nodeIo, "readFile").mockReturnValue("entryPoints:\n");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Docker firewall migrations on a server without the script", () => {
  it("0012 installs the script with the router ports", () => {
    migration0012DockerUserToolPorts.run();

    expect(writeFile).toHaveBeenCalledWith(
      DOCKER_FIREWALL_SCRIPT,
      expect.stringContaining('ALLOWED_PORTS="80 443"'),
    );
    expect(exec).toHaveBeenCalledWith("systemctl restart ppreview-docker-firewall.service", {
      silent: true,
    });
  });

  it("0022 does nothing", () => {
    migration0022DockerUserDefaultDeny.run();

    expect(writeFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
