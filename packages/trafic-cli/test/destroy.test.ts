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
  noBackup: false,
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

    expect(mockedExec).toHaveBeenCalledTimes(3);
    const commands = mockedExec.mock.calls.map((c) => c[1]);
    expect(commands[0]).toContain("trafic-agent backup --name my-app");
    expect(commands[1]).toContain("ddev delete");
    expect(commands[2]).toContain("rm -rf");
  });

  it("skips backup when --no-backup is set", async () => {
    mockedTest.mockResolvedValue(true);

    await destroy({ ...baseOptions, noBackup: true });

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
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // backup
      .mockRejectedValueOnce(new Error("ddev delete failed")) // ddev delete
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // rm -rf

    await destroy(baseOptions);

    // Should still call rm -rf (backup + delete + rm)
    expect(mockedExec).toHaveBeenCalledTimes(3);
    expect(mockedExec.mock.calls[2]![1]).toContain("rm -rf");
  });

  it("continues destroy if backup fails", async () => {
    mockedTest.mockResolvedValue(true);
    mockedExec
      .mockRejectedValueOnce(new Error("backup failed")) // backup
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // ddev delete
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // rm -rf

    await destroy(baseOptions);

    // Should still delete and rm (backup failure is non-blocking)
    expect(mockedExec).toHaveBeenCalledTimes(3);
    expect(mockedExec.mock.calls[1]![1]).toContain("ddev delete");
    expect(mockedExec.mock.calls[2]![1]).toContain("rm -rf");
  });
});
