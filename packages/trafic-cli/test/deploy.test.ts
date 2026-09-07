import { describe, it, expect } from "vitest";
import { deploy } from "../src/commands/deploy.js";
import { createFakeSshIo } from "./helpers/fake-ssh-io.js";
import type { DeployOptions } from "../src/types.js";

// The steps print progress; keep it out of the test output
console.log = () => {};
console.error = () => {};
const warnings: string[] = [];
console.warn = (message?: unknown) => void warnings.push(String(message));

const baseOptions: DeployOptions = {
  host: "server.example.com",
  user: "ddev",
  port: 22,
  sshOptions: "",
  repo: "https://github.com/example/repo.git",
  branch: "main",
  name: "my-app",
  projectsDir: "~/www",
  noStart: false,
  timeout: "10m",
};

describe("deploy source update", () => {
  it("clones when the project is not there yet", async () => {
    const io = createFakeSshIo({ exists: false });

    await deploy(baseOptions, io);

    expect(io.commands[0]).toContain("git clone");
  });

  it("fetches when the repository is already there", async () => {
    const io = createFakeSshIo({ exists: true });

    await deploy(baseOptions, io);

    expect(io.commands[0]).toContain("git fetch");
  });

  it("uses the preview directory for a preview", async () => {
    const io = createFakeSshIo({ exists: false });

    await deploy({ ...baseOptions, preview: "42" }, io);

    expect(io.commands[0]).toContain("preview-42--my-app");
  });

  it("writes the local config only on a fresh clone", async () => {
    const fresh = createFakeSshIo({ exists: false });
    const existing = createFakeSshIo({ exists: true });

    await deploy(baseOptions, fresh);
    await deploy(baseOptions, existing);

    // Overwriting it on every deploy would discard the router ports a
    // running project depends on
    expect(fresh.commands.some((c) => c.includes("config.local.yaml"))).toBe(true);
    expect(existing.commands.some((c) => c.includes("config.local.yaml"))).toBe(false);
  });
});

describe("deploy router ports", () => {
  it("pins the ports the server reports", async () => {
    const io = createFakeSshIo({
      exists: false,
      output: {
        "ddev config global": "router-http-port=8080\nrouter-https-port=8443\n",
      },
    });

    await deploy(baseOptions, io);

    const write = io.commands.find((c) => c.includes("config.local.yaml"))!;
    expect(write).toContain('router_http_port: "8080"');
    expect(write).toContain('router_https_port: "8443"');
  });

  it("leaves the ports alone when the config cannot be read", async () => {
    const io = createFakeSshIo({ exists: false, output: {} });

    await deploy(baseOptions, io);

    const write = io.commands.find((c) => c.includes("config.local.yaml"))!;
    // Guessing would be worse than letting DDEV decide
    expect(write).not.toContain("router_http_port");
  });
});

describe("deploy start", () => {
  it("starts a stopped project", async () => {
    const io = createFakeSshIo({ output: { "ddev describe -j": "stopped\n" } });

    await deploy(baseOptions, io);

    expect(io.commands.some((c) => c.includes("ddev start"))).toBe(true);
  });

  it("leaves a running project alone", async () => {
    const io = createFakeSshIo({ output: { "ddev describe -j": "running\n" } });

    await deploy(baseOptions, io);

    expect(io.commands.some((c) => c.includes("ddev start"))).toBe(false);
  });

  it("skips the start entirely with --no-start", async () => {
    const io = createFakeSshIo({ output: { "ddev describe -j": "stopped\n" } });

    await deploy({ ...baseOptions, noStart: true }, io);

    expect(io.commands.some((c) => c.includes("ddev start"))).toBe(false);
  });
});

describe("deploy sync", () => {
  it("syncs each path to its place under the project", async () => {
    const io = createFakeSshIo();

    await deploy({ ...baseOptions, sync: "vendor,dist" }, io);

    expect(io.syncs).toEqual([
      ["vendor", "~/www/my-app/vendor"],
      ["dist", "~/www/my-app/dist"],
    ]);
  });

  it("syncs nothing when no paths are given", async () => {
    const io = createFakeSshIo();

    await deploy(baseOptions, io);

    expect(io.syncs).toEqual([]);
  });
});

describe("deploy sync deletion reporting", () => {
  function deletionWarnings(): string {
    return warnings.join("\n");
  }

  it("warns about what the mirror removed", async () => {
    warnings.length = 0;
    const io = createFakeSshIo({
      rsyncStdout:
        "deleting headers-security-advanced-hsts-wp/index.php\ndeleting headers-security-advanced-hsts-wp/\n",
    });

    await deploy({ ...baseOptions, sync: "web/wp-content/plugins" }, io);

    // Silent removal is how a hand-installed plugin disappeared unnoticed
    expect(deletionWarnings()).toContain("web/wp-content/plugins");
    expect(deletionWarnings()).toContain("removed 2 paths");
    expect(deletionWarnings()).toContain("headers-security-advanced-hsts-wp");
  });

  it("says nothing when the sync removed nothing", async () => {
    warnings.length = 0;
    const io = createFakeSshIo({
      rsyncStdout: "sending incremental file list\n./\ndist/app.js\n",
    });

    await deploy({ ...baseOptions, sync: "dist" }, io);

    expect(deletionWarnings()).not.toContain("removed");
  });

  it("reports each synced path separately", async () => {
    warnings.length = 0;
    const io = createFakeSshIo({ rsyncStdout: "deleting stale.txt\n" });

    await deploy({ ...baseOptions, sync: "vendor,dist" }, io);

    expect(deletionWarnings()).toContain("vendor:");
    expect(deletionWarnings()).toContain("dist:");
  });
});

describe("deploy create-script", () => {
  it("runs on the deploy that creates the project", async () => {
    const io = createFakeSshIo({ exists: false });

    await deploy({ ...baseOptions, createScript: "ddev pull prod-db -y" }, io);

    expect(io.commands.some((c) => c.includes("ddev pull prod-db -y"))).toBe(true);
  });

  it("does not run for an existing project", async () => {
    const io = createFakeSshIo({ exists: true });

    await deploy({ ...baseOptions, createScript: "ddev pull prod-db -y" }, io);

    // Seeding is destructive: ddev pull overwrites the database, so
    // repeating it would discard the environment's content
    expect(io.commands.some((c) => c.includes("ddev pull prod-db -y"))).toBe(false);
  });

  it("runs in the project directory", async () => {
    const io = createFakeSshIo({ exists: false });

    await deploy({ ...baseOptions, createScript: "ddev pull prod-db -y" }, io);

    expect(io.commands.find((c) => c.includes("ddev pull"))).toContain(
      "cd ~/www/my-app",
    );
  });

  it("runs before the container script", async () => {
    const io = createFakeSshIo({ exists: false });

    await deploy(
      { ...baseOptions, createScript: "ddev pull prod-db -y", script: "wp cache flush" },
      io,
    );

    const seed = io.commands.findIndex((c) => c.includes("ddev pull"));
    const script = io.commands.findIndex((c) => c.includes(".trafic-deploy.sh"));

    // So a container script can rely on what the seed put in place
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(script).toBeGreaterThan(seed);
  });

  it("stops the deploy when seeding fails", async () => {
    const io = createFakeSshIo({ exists: false, fails: ["ddev pull"] });

    // A half-imported database is worse than a failed pipeline
    await expect(
      deploy({ ...baseOptions, createScript: "ddev pull prod-db -y" }, io),
    ).rejects.toThrow(/ddev pull/);
  });
});

describe("deploy container script", () => {
  /** The script decoded from the base64 payload written to the server. */
  function writtenScript(commands: string[]): string {
    const write = commands.find((c) => c.includes("base64 -d"))!;
    const encoded = /printf %s (\S+) \|/.exec(write)![1]!;
    return Buffer.from(encoded, "base64").toString("utf-8");
  }

  it("exports each env entry before the script", async () => {
    const io = createFakeSshIo();

    await deploy(
      {
        ...baseOptions,
        script: "composer install",
        env: { COMPOSER_AUTH: '{"http-basic":{"x":{"username":"u"}}}', CI: "true" },
      },
      io,
    );

    const script = writtenScript(io.commands);
    expect(script).toContain(
      `export COMPOSER_AUTH='{"http-basic":{"x":{"username":"u"}}}'`,
    );
    expect(script).toContain("export CI='true'");
    expect(script).toContain("composer install");
  });

  it("keeps env values out of the logged command", async () => {
    const io = createFakeSshIo();

    await deploy(
      { ...baseOptions, script: "composer install", env: { COMPOSER_AUTH: "s3cr3t" } },
      io,
    );

    const index = io.commands.findIndex((c) => c.includes("base64 -d"));
    expect(io.execOptions[index]?.log).toBe("write .trafic-deploy.sh");
  });

  it("aborts the script on the first failing command", async () => {
    const io = createFakeSshIo();

    await deploy({ ...baseOptions, script: "false\nnpm run build" }, io);

    // Without errexit a failed composer install would still report success
    expect(writtenScript(io.commands).startsWith("set -o errexit")).toBe(true);
  });

  it("survives a script containing quotes", async () => {
    const io = createFakeSshIo();
    const script = `php -r 'echo "hi";'`;

    await deploy({ ...baseOptions, script }, io);

    expect(writtenScript(io.commands)).toContain(script);
  });

  it("escapes single quotes in env values", async () => {
    const io = createFakeSshIo();

    await deploy({ ...baseOptions, script: "true", env: { TOKEN: "it's-quoted" } }, io);

    expect(writtenScript(io.commands)).toContain(`export TOKEN='it'\\''s-quoted'`);
  });

  it("runs the script through bash in the container", async () => {
    const io = createFakeSshIo();

    await deploy({ ...baseOptions, script: "composer install" }, io);

    expect(
      io.commands.some((c) => c.includes("ddev exec bash .trafic-deploy.sh")),
    ).toBe(true);
  });

  it("removes the script afterwards", async () => {
    const io = createFakeSshIo();

    await deploy({ ...baseOptions, script: "composer install" }, io);

    expect(io.commands.some((c) => c.includes("rm -f .trafic-deploy.sh"))).toBe(true);
  });

  it("removes the script even when it fails", async () => {
    const io = createFakeSshIo({ fails: ["ddev exec bash"] });

    await expect(deploy({ ...baseOptions, script: "build" }, io)).rejects.toThrow();

    // Otherwise the env values stay on disk after a failed build
    expect(io.commands.some((c) => c.includes("rm -f .trafic-deploy.sh"))).toBe(true);
  });

  it("writes no script when none is given", async () => {
    const io = createFakeSshIo();

    await deploy(baseOptions, io);

    expect(io.commands.some((c) => c.includes(".trafic-deploy.sh"))).toBe(false);
  });
});

describe("deploy verify", () => {
  it("does not fail the deploy when verification fails", async () => {
    // Only the verify step, which runs `ddev describe` without -j
    const io = createFakeSshIo({
      failsWhen: (command) =>
        command.includes("ddev describe") && !command.includes("-j"),
    });

    // The work is done by then; a describe that cannot read is not a reason
    // to report failure
    await expect(deploy(baseOptions, io)).resolves.toBeUndefined();
  });
});
