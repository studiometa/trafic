import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  readForwardAuthAddress,
  rewriteForwardAuthAddress,
} from "../src/utils/traefik.js";
import { readToolPorts, buildStaticConfig } from "../src/setup/ddev.js";
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
