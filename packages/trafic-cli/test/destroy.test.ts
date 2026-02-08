import { describe, it, expect, vi, beforeEach } from "vitest";
import { destroy } from "../src/commands/destroy.js";
import * as ssh from "../src/ssh.js";
import type { DestroyOptions } from "../src/types.js";

// Mock SSH module
vi.mock("../src/ssh.js", () => ({
  exec: vi.fn(),
  test: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

const mockedExec = vi.mocked(ssh.exec);
const mockedTest = vi.mocked(ssh.test);

const baseOptions: DestroyOptions = {
  host: "server.example.com",
  user: "ddev",
  port: 22,
  sshOptions: "",
  name: "my-app",
  projectsDir: "~/www",
};

describe("destroy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("does nothing if project does not exist", async () => {
    mockedTest.mockResolvedValue(false);

    await destroy(baseOptions);

    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("deletes DDEV project and removes directory", async () => {
    mockedTest.mockResolvedValue(true);

    await destroy(baseOptions);

    expect(mockedExec).toHaveBeenCalledTimes(2);
    const commands = mockedExec.mock.calls.map((c) => c[1]);
    expect(commands[0]).toContain("ddev delete");
    expect(commands[1]).toContain("rm -rf");
  });

  it("uses preview name when preview is set", async () => {
    mockedTest.mockResolvedValue(true);

    await destroy({ ...baseOptions, preview: "42" });

    const testCommand = mockedTest.mock.calls[0]![1];
    expect(testCommand).toContain("preview-42--my-app");

    const deleteCommand = mockedExec.mock.calls[0]![1];
    expect(deleteCommand).toContain("preview-42--my-app");
  });

  it("continues if ddev delete fails", async () => {
    mockedTest.mockResolvedValue(true);
    mockedExec
      .mockRejectedValueOnce(new Error("ddev delete failed")) // ddev delete
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // rm -rf

    await destroy(baseOptions);

    // Should still call rm -rf
    expect(mockedExec).toHaveBeenCalledTimes(2);
    expect(mockedExec.mock.calls[1]![1]).toContain("rm -rf");
  });
});
