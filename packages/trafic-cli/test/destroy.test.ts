import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destroy } from "../src/commands/destroy.js";
import { createFakeSshIo } from "./helpers/fake-ssh-io.js";
import type { DestroyOptions } from "../src/types.js";

// The steps print progress; keep it out of the test output
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const baseOptions: DestroyOptions = {
  host: "server.example.com",
  user: "ddev",
  port: 22,
  sshOptions: "",
  name: "my-app",
  backup: false,
};

/** The one remote command a destroy runs. */
async function remoteCommand(options: DestroyOptions = baseOptions): Promise<string> {
  const io = createFakeSshIo();
  await destroy(options, io);
  expect(io.commands).toHaveLength(1);
  return io.commands[0]!;
}

describe("destroy", () => {
  it("hands the removal to trafic-agent in one remote command", async () => {
    const io = createFakeSshIo();

    await destroy(baseOptions, io);

    // No separate check: it would report an SSH failure as a missing agent
    expect(io.tested).toEqual([]);
    expect(io.commands).toHaveLength(1);
    expect(io.commands[0]).toMatch(/^command -v trafic-agent >\/dev\/null \|\| \{/);
    expect(io.commands[0]).toMatch(/; trafic-agent destroy 'my-app'$/);
    expect(io.execOptions).toEqual([{ log: "trafic-agent destroy 'my-app'" }]);
  });

  it("targets the preview environment when one is given", async () => {
    expect(await remoteCommand({ ...baseOptions, preview: "42" })).toMatch(
      /; trafic-agent destroy 'preview-42--my-app'$/,
    );
  });

  it("asks the agent for a backup when one is wanted", async () => {
    expect(await remoteCommand({ ...baseOptions, preview: "42", backup: true })).toMatch(
      /; trafic-agent destroy 'preview-42--my-app' --backup$/,
    );
  });

  it("quotes the project name for the remote shell", async () => {
    expect(await remoteCommand({ ...baseOptions, name: "app; rm -rf ~" })).toMatch(
      /; trafic-agent destroy 'app; rm -rf ~'$/,
    );
  });

  it("fails when the remote command fails", async () => {
    // An unsafe path, a database error or an SSH error must fail the CI job
    const io = createFakeSshIo({ fails: ["trafic-agent destroy"] });

    await expect(destroy(baseOptions, io)).rejects.toThrow();
  });

  describe("remote command in a shell", () => {
    let bin: string;

    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), "trafic-destroy-bin-"));
    });

    afterEach(() => {
      rmSync(bin, { recursive: true, force: true });
    });

    /** Run the remote command with only `bin` on the PATH. */
    async function runRemote(): Promise<ReturnType<typeof spawnSync>> {
      return spawnSync("/bin/sh", ["-c", await remoteCommand()], {
        encoding: "utf-8",
        env: { PATH: bin },
      });
    }

    it("stops with exit code 127 and a clear message when the agent is missing", async () => {
      const result = await runRemote();

      expect(result.status).toBe(127);
      expect(result.stderr).toContain(
        "trafic-agent is not on the PATH of ddev@server.example.com. Set the server up with `trafic setup`, then try again",
      );
    });

    it("runs the agent and keeps its exit code when the agent is there", async () => {
      const agent = join(bin, "trafic-agent");
      writeFileSync(agent, '#!/bin/sh\necho "agent $*"\nexit 3\n');
      chmodSync(agent, 0o755);

      const result = await runRemote();

      expect(result.stdout).toBe("agent destroy my-app\n");
      expect(result.status).toBe(3);
    });
  });
});
