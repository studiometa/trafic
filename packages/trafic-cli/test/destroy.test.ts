import { describe, it, expect } from "vitest";
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
};

describe("destroy", () => {
  it("hands the removal to trafic-agent on the server", async () => {
    const io = createFakeSshIo({ exists: true });

    await destroy(baseOptions, io);

    expect(io.tested).toEqual(["command -v trafic-agent"]);
    expect(io.commands).toEqual(["trafic-agent destroy 'my-app'"]);
  });

  it("targets the preview environment when one is given", async () => {
    const io = createFakeSshIo({ exists: true });

    await destroy({ ...baseOptions, preview: "42" }, io);

    expect(io.commands).toEqual(["trafic-agent destroy 'preview-42--my-app'"]);
  });

  it("quotes the project name for the remote shell", async () => {
    const io = createFakeSshIo({ exists: true });

    await destroy({ ...baseOptions, name: "app; rm -rf ~" }, io);

    expect(io.commands).toEqual([`trafic-agent destroy 'app; rm -rf ~'`]);
  });

  it("fails with a clear message when the agent is not installed", async () => {
    const io = createFakeSshIo({ exists: false });

    await expect(destroy(baseOptions, io)).rejects.toThrow(
      /trafic-agent is not on the PATH of ddev@server\.example\.com/,
    );
    expect(io.commands).toEqual([]);
  });

  it("fails when the agent fails", async () => {
    // An unsafe path or a database error must fail the CI job, not pass it
    const io = createFakeSshIo({ exists: true, fails: ["trafic-agent destroy"] });

    await expect(destroy(baseOptions, io)).rejects.toThrow();
  });
});
