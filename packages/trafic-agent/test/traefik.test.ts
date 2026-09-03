import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  readForwardAuthAddress,
  rewriteForwardAuthAddress,
  syncForwardAuthAddress,
} from "../src/utils/traefik.js";
import {
  readToolPorts,
  readRouterPorts,
  buildStaticConfig,
  buildDynamicConfig,
} from "../src/setup/ddev.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const DYNAMIC = `http:
  middlewares:
    trafic-auth:
      forwardAuth:
        address: "http://172.17.0.1:9876/__auth__"
  services:
    trafic-service:
      loadBalancer:
        servers:
          - url: "http://172.17.0.1:9876"
`;

describe("readForwardAuthAddress", () => {
  it("reads the configured host", () => {
    expect(readForwardAuthAddress(DYNAMIC)).toBe("172.17.0.1");
  });

  it("returns undefined when there is no agent URL", () => {
    expect(readForwardAuthAddress("http:\n  middlewares: {}\n")).toBeUndefined();
  });
});

describe("rewriteForwardAuthAddress", () => {
  it("updates both the middleware and the service URL", () => {
    const updated = rewriteForwardAuthAddress(DYNAMIC, "172.18.0.1");

    // Leaving the service behind would send the waiting page nowhere
    expect(updated).toContain('address: "http://172.18.0.1:9876/__auth__"');
    expect(updated).toContain('url: "http://172.18.0.1:9876"');
    expect(updated).not.toContain("172.17.0.1");
  });

  it("keeps the port", () => {
    const updated = rewriteForwardAuthAddress(
      'address: "http://172.17.0.1:9999/__auth__"',
      "10.0.0.1",
    );

    expect(updated).toContain("http://10.0.0.1:9999/__auth__");
  });

  it("is a no-op when the address already matches", () => {
    expect(rewriteForwardAuthAddress(DYNAMIC, "172.17.0.1")).toBe(DYNAMIC);
  });
});

describe("readToolPorts", () => {
  it("reads the ports from the DDEV global config", () => {
    const io = createFakeIo({
      output: {
        "ddev config global": [
          "mailpit-http-port=8025",
          "mailpit-https-port=8026",
          "xhgui-http-port=8143",
          "xhgui-https-port=8142",
        ].join("\n"),
      },
    });

    expect(readToolPorts(io)).toEqual(["8025", "8026", "8143", "8142"]);
  });

  it("honours non-default ports", () => {
    const io = createFakeIo({
      output: { "ddev config global": "mailpit-https-port=2053" },
    });

    expect(readToolPorts(io)).toContain("2053");
  });

  it("falls back to the DDEV defaults when the config cannot be read", () => {
    const io = createFakeIo({ fails: ["ddev config global"] });

    expect(readToolPorts(io)).toEqual(["8025", "8026", "8143", "8142"]);
  });

  it("does not repeat a port used twice", () => {
    const io = createFakeIo({
      output: {
        "ddev config global": "mailpit-http-port=8025\nxhgui-http-port=8025",
      },
    });

    expect(readToolPorts(io).filter((p) => p === "8025")).toHaveLength(1);
  });
});

describe("buildStaticConfig", () => {
  it("attaches auth to the web entry points", () => {
    const config = buildStaticConfig([]);

    expect(config).toContain("http-80");
    expect(config).toContain("http-443");
    expect(config).toContain("trafic-auth@file");
    expect(config).toContain("trafic-errors@file");
  });

  it("attaches auth to each tool entry point", () => {
    const config = buildStaticConfig(["8026", "8142"]);

    // Docker publishes these on 0.0.0.0 and bypasses UFW, so the middleware
    // is the only protection they get
    expect(config).toContain("http-8026");
    expect(config).toContain("http-8142");
  });

  it("keeps the error page off the tool entry points", () => {
    const config = buildStaticConfig(["8026"]);
    const toolBlock = config.slice(config.indexOf("http-8026"));

    // A tool port has no stopped project to show a waiting page for
    expect(toolBlock).toContain("trafic-auth@file");
    expect(toolBlock).not.toContain("trafic-errors@file");
  });
});

describe("syncForwardAuthAddress", () => {
  const PROJECT_LIST = "/home/ddev/.ddev/project_list.yaml";
  const ROOT = "/home/ddev/.ddev/traefik/trafic.yaml";
  const GLOBAL = "/home/ddev/.ddev/traefik/custom-global-config/trafic.yaml";
  const DDEV_NET = "docker network inspect ddev_default";

  it("corrects a stale address in the config Traefik reads", () => {
    const io = createFakeIo({
      files: { [GLOBAL]: DYNAMIC },
      output: { [DDEV_NET]: "172.18.0.1\n" },
    });

    syncForwardAuthAddress(PROJECT_LIST, io);

    expect(io.written(GLOBAL)).toContain("172.18.0.1");
    expect(io.written(GLOBAL)).not.toContain("172.17.0.1");
  });

  it("leaves the retired root copy alone", () => {
    // DDEV 1.25 copies custom-global-config into the volume and never reads
    // the traefik root; migration 0010 deletes that copy
    const io = createFakeIo({
      files: { [ROOT]: DYNAMIC, [GLOBAL]: DYNAMIC },
      output: { [DDEV_NET]: "172.18.0.1\n" },
    });

    syncForwardAuthAddress(PROJECT_LIST, io);

    expect(io.writes.has(ROOT)).toBe(false);
  });

  it("writes nothing when the address is already right", () => {
    const io = createFakeIo({
      files: { [GLOBAL]: DYNAMIC },
      output: { [DDEV_NET]: "172.17.0.1\n" },
    });

    syncForwardAuthAddress(PROJECT_LIST, io);

    expect(io.writes.size).toBe(0);
  });

  it("skips a config file that does not exist", () => {
    const io = createFakeIo({
      files: {},
      output: { [DDEV_NET]: "172.18.0.1\n" },
    });

    syncForwardAuthAddress(PROJECT_LIST, io);

    expect(io.writes.size).toBe(0);
  });

  it("leaves a config with no agent URL alone", () => {
    const io = createFakeIo({
      files: { [ROOT]: "http:\n  middlewares: {}\n" },
      output: { [DDEV_NET]: "172.18.0.1\n" },
    });

    syncForwardAuthAddress(PROJECT_LIST, io);

    expect(io.writes.size).toBe(0);
  });

  it("does not throw when the gateway cannot be determined", () => {
    // No docker network at all: getDockerGatewayIp falls back to 172.17.0.1
    const io = createFakeIo({
      files: { [ROOT]: DYNAMIC },
      fails: ["docker network inspect"],
    });

    expect(() => syncForwardAuthAddress(PROJECT_LIST, io)).not.toThrow();
    expect(io.writes.size).toBe(0);
  });

  it("does not throw when the file cannot be written", () => {
    const io = createFakeIo({
      files: { [ROOT]: DYNAMIC },
      output: { [DDEV_NET]: "172.18.0.1\n" },
    });
    io.writeFile = vi.fn(() => {
      throw new Error("read-only file system");
    });

    // An agent that refuses to start would be worse than a stale address
    expect(() => syncForwardAuthAddress(PROJECT_LIST, io)).not.toThrow();
  });

  it("resolves the traefik directory from the project list path", () => {
    const io = createFakeIo({
      files: { "/custom/.ddev/traefik/custom-global-config/trafic.yaml": DYNAMIC },
      output: { [DDEV_NET]: "172.18.0.1\n" },
    });

    syncForwardAuthAddress("/custom/.ddev/project_list.yaml", io);

    expect(io.writes.has("/custom/.ddev/traefik/custom-global-config/trafic.yaml")).toBe(true);
  });
});

describe("readRouterPorts", () => {
  it("reads the ports from the global config", () => {
    const io = createFakeIo({
      output: {
        "su - ddev -c 'ddev config global'":
          "router-http-port=8080\nrouter-https-port=8443\nproject-tld=example.com\n",
      },
    });

    expect(readRouterPorts(io)).toEqual({ http: "8080", https: "8443" });
  });

  it("falls back to 80 and 443 when the config says nothing", () => {
    const io = createFakeIo({ output: { "su - ddev -c 'ddev config global'": "project-tld=x\n" } });

    expect(readRouterPorts(io)).toEqual({ http: "80", https: "443" });
  });

  it("falls back when the config cannot be read at all", () => {
    const io = createFakeIo({ fails: ["su - ddev -c 'ddev config global'"] });

    expect(readRouterPorts(io)).toEqual({ http: "80", https: "443" });
  });
});

describe("buildDynamicConfig", () => {
  /** Count how many entry points each router names. */
  function routerEntryPointCounts(config: string): number[] {
    // Each router block ends at the next two-space-indented key
    return [...config.matchAll(/    trafic-catchall(?:-tls)?:\n((?:      .*\n)*)/g)].map(
      (match) => (match[1]!.match(/^        - http-\d+$/gm) ?? []).length,
    );
  }

  it("names exactly one entry point per router", () => {
    // The whole point: a router naming none is instantiated on every entry
    // point, and DDEV's health check compares definitions to instances
    expect(routerEntryPointCounts(buildDynamicConfig("172.18.0.1"))).toEqual([1, 1]);
  });

  it("uses the server's router ports", () => {
    const config = buildDynamicConfig("172.18.0.1", { http: "8080", https: "8443" });

    expect(config).toContain("- http-8080");
    expect(config).toContain("- http-8443");
    expect(config).not.toContain("- http-80\n");
  });

  it("defaults to 80 and 443", () => {
    const config = buildDynamicConfig("172.18.0.1");

    expect(config).toContain("- http-80");
    expect(config).toContain("- http-443");
  });

  it("puts tls on the https router only", () => {
    const config = buildDynamicConfig("172.18.0.1", { http: "80", https: "443" });
    const tlsBlock = config.slice(config.indexOf("trafic-catchall-tls:"));
    const plainBlock = config.slice(
      config.indexOf("trafic-catchall:"),
      config.indexOf("trafic-catchall-tls:"),
    );

    expect(tlsBlock).toContain("tls: {}");
    expect(plainBlock).not.toContain("tls: {}");
  });

  it("points the middleware and service at the gateway", () => {
    const config = buildDynamicConfig("10.1.2.3");

    expect(config).toContain("http://10.1.2.3:9876/__auth__");
    expect(config).toContain("http://10.1.2.3:9876");
  });

  it("keeps the catch-all at the lowest priority", () => {
    // A project router must always outrank it, or auth policy per project breaks
    const priorities = [...buildDynamicConfig("172.18.0.1").matchAll(/priority: (\d+)/g)].map(
      (m) => Number(m[1]),
    );

    expect(priorities).toEqual([1, 1]);
  });
});

describe("buildStaticConfig with router ports", () => {
  it("attaches the web middlewares to the configured router ports", () => {
    const config = buildStaticConfig(["8025", "8026"], { http: "8080", https: "8443" });

    expect(config).toContain("  http-8080:");
    expect(config).toContain("  http-8443:");
    expect(config).not.toContain("  http-80:");
    expect(config).not.toContain("  http-443:");
  });

  it("does not emit an entry point twice when a tool shares a router port", () => {
    // A duplicate key makes the whole static config invalid
    const config = buildStaticConfig(["80", "8025"], { http: "80", https: "443" });

    expect([...config.matchAll(/^  http-80:$/gm)]).toHaveLength(1);
  });

  it("gives the error page to web entry points only", () => {
    const config = buildStaticConfig(["8025"], { http: "80", https: "443" });
    const tools = config.slice(config.indexOf("  http-8025:"));

    // A tool port has nothing to wait for
    expect(tools).toContain("trafic-auth@file");
    expect(tools).not.toContain("trafic-errors@file");
  });
});
