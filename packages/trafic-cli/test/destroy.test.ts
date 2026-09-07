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
  projectsDir: "~/www",
};

describe("destroy", () => {
  it("does nothing when the project is not there", async () => {
    const io = createFakeSshIo({ exists: false });

    await destroy(baseOptions, io);

    expect(io.commands).toEqual([]);
  });

  it("deletes the DDEV project and then the directory", async () => {
    const io = createFakeSshIo({ exists: true });

    await destroy(baseOptions, io);

    expect(io.commands).toHaveLength(2);
    expect(io.commands[0]).toContain("ddev delete");
    expect(io.commands[1]).toContain("rm -rf");
  });

  it("targets the preview environment when one is given", async () => {
    const io = createFakeSshIo({ exists: true });

    await destroy({ ...baseOptions, preview: "42" }, io);

    expect(io.tested[0]).toContain("preview-42--my-app");
    expect(io.commands[0]).toContain("preview-42--my-app");
  });

  it("still removes the directory when ddev delete fails", async () => {
    // Otherwise a project DDEV has already forgotten could never be cleaned
    // up, and the next deploy would find a stale directory
    const io = createFakeSshIo({ exists: true, fails: ["ddev delete"] });

    await destroy(baseOptions, io);

    expect(io.commands).toHaveLength(2);
    expect(io.commands[1]).toContain("rm -rf");
  });
});
