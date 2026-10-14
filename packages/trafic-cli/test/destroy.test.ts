import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_MARGIN_MS, destroy } from "../src/commands/destroy.js";
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
      /; trafic-agent destroy 'preview-42--my-app' --backup --timeout '600s'$/,
    );
  });

  it("gives the agent the timeout as the time limit of the backup", async () => {
    expect(await remoteCommand({ ...baseOptions, backup: true, timeout: "1h" })).toMatch(
      /; trafic-agent destroy 'my-app' --backup --timeout '1h'$/,
    );
  });

  it("gives the remote command more time than the backup", async () => {
    // Else the SSH connection is cut before the agent fails a slow backup
    // cleanly, and the start, the stop and ddev delete have no time left
    const io = createFakeSshIo();

    await destroy({ ...baseOptions, backup: true, timeout: "1h" }, io);

    expect(BACKUP_MARGIN_MS).toBe(10 * 60 * 1000);
    expect(io.execOptions[0]?.timeoutMs).toBe(60 * 60 * 1000 + BACKUP_MARGIN_MS);
  });

  it("gives the remote command the default timeout plus the margin without a timeout", async () => {
    const io = createFakeSshIo();

    await destroy({ ...baseOptions, backup: true }, io);

    expect(io.execOptions[0]?.timeoutMs).toBe(10 * 60 * 1000 + BACKUP_MARGIN_MS);
  });

  it("refuses a timeout that is not a duration before it connects", async () => {
    const io = createFakeSshIo();

    await expect(destroy({ ...baseOptions, backup: true, timeout: "1h; rm -rf ~" }, io)).rejects.toThrow(
      /Invalid timeout/,
    );

    expect(io.commands).toEqual([]);
  });

  it("keeps the timeout to itself without a backup", async () => {
    // The agent uses it for the backup only; the remote command gets it as
    // it is
    const io = createFakeSshIo();

    await destroy({ ...baseOptions, timeout: "1h" }, io);

    expect(io.commands[0]).toMatch(/; trafic-agent destroy 'my-app'$/);
    expect(io.execOptions[0]?.timeoutMs).toBeUndefined();
  });

  it("asks the agent to schedule the removal when a delay is given", async () => {
    expect(await remoteCommand({ ...baseOptions, preview: "42", delay: "48h" })).toMatch(
      /; trafic-agent destroy 'preview-42--my-app' --delay '48h'$/,
    );
  });

  it("keeps the backup for a scheduled removal", async () => {
    expect(await remoteCommand({ ...baseOptions, backup: true, delay: "48h" })).toMatch(
      /; trafic-agent destroy 'my-app' --backup --timeout '600s' --delay '48h'$/,
    );
  });

  it("gives the agent the timeout for the backup of a scheduled removal", async () => {
    expect(
      await remoteCommand({ ...baseOptions, backup: true, timeout: "1h", delay: "48h" }),
    ).toMatch(/; trafic-agent destroy 'my-app' --backup --timeout '1h' --delay '48h'$/);
  });

  it("quotes the delay for the remote shell", async () => {
    expect(await remoteCommand({ ...baseOptions, delay: "48h; rm -rf ~" })).toMatch(
      /; trafic-agent destroy 'my-app' --delay '48h; rm -rf ~'$/,
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
