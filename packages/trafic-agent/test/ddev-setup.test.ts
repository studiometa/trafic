import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addDdevAptRepo,
  installDdev,
  configureDdev,
  installDnsmasq,
  getDockerGatewayIp,
  configureTraefik,
} from "../src/setup/ddev.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const TRAEFIK_DIR = "/home/ddev/.ddev/traefik";
const DDEV_NETWORK = "docker network inspect ddev_default";
const BRIDGE_NETWORK = "docker network inspect bridge";

describe("addDdevAptRepo", () => {
  it("writes the keyring and a signed-by repository line", () => {
    const io = createFakeIo();

    addDdevAptRepo(io);

    expect(io.ran("install -m 0755 -d /etc/apt/keyrings")).toBe(true);
    const repoLine = io.commands.find((c) =>
      c.includes("/etc/apt/sources.list.d/ddev.list"),
    )!;
    expect(repoLine).toContain("signed-by=/etc/apt/keyrings/ddev.gpg");
  });
});

describe("installDdev", () => {
  it("skips the install when DDEV is already present", () => {
    const io = createFakeIo({
      present: ["ddev"],
      output: { "ddev --version": "ddev version v1.24.0\n" },
    });

    installDdev(io);

    expect(io.ran("apt-get install -y ddev")).toBe(false);
  });

  it("adds the apt repository, then installs DDEV", () => {
    const io = createFakeIo();

    installDdev(io);

    expect(io.ran("/etc/apt/sources.list.d/ddev.list")).toBe(true);
    expect(io.ran("apt-get install -y ddev")).toBe(true);
  });

  it("installs the mkcert CA into the ddev user's trust store", () => {
    const io = createFakeIo();

    installDdev(io);

    // setup runs as root, so HOME has to point at the ddev user or DDEV
    // will not trust the certificates it generates
    expect(io.ran("HOME=/home/ddev mkcert -install")).toBe(true);
    expect(io.ran("chown -R ddev:ddev /home/ddev/.local/share/mkcert")).toBe(
      true,
    );
  });
});

describe("getDockerGatewayIp", () => {
  it("prefers the ddev_default network, where ddev-router runs", () => {
    const io = createFakeIo({
      output: { [DDEV_NETWORK]: "172.20.0.1\n", [BRIDGE_NETWORK]: "172.17.0.1\n" },
    });

    expect(getDockerGatewayIp(io)).toBe("172.20.0.1");
  });

  it("falls back to the default bridge network", () => {
    const io = createFakeIo({ output: { [BRIDGE_NETWORK]: "172.18.0.1\n" } });

    expect(getDockerGatewayIp(io)).toBe("172.18.0.1");
  });

  it("falls back to the conventional address when both fail", () => {
    const io = createFakeIo();

    expect(getDockerGatewayIp(io)).toBe("172.17.0.1");
  });

  it("falls back when the networks do not exist yet", () => {
    // On a fresh server ddev_default appears only once a project starts, and
    // `docker network inspect` exits non-zero for a missing network — the
    // documented fallback chain has to survive that
    const io = createFakeIo({ fails: ["docker network inspect"] });

    expect(() => getDockerGatewayIp(io)).not.toThrow();
    expect(getDockerGatewayIp(io)).toBe("172.17.0.1");
  });

  it("uses the bridge gateway when only ddev_default is missing", () => {
    const io = createFakeIo({
      fails: [DDEV_NETWORK],
      output: { [BRIDGE_NETWORK]: "172.19.0.1\n" },
    });

    expect(getDockerGatewayIp(io)).toBe("172.19.0.1");
  });
});

describe("configureTraefik", () => {
  const io = () =>
    createFakeIo({ output: { [DDEV_NETWORK]: "172.20.0.1\n" } });

  it("points forward auth at the gateway IP, not host.docker.internal", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    expect(config).toContain("http://172.20.0.1:9876/__auth__");
    // host.docker.internal does not resolve on Linux without extra setup,
    // which silently bypassed auth
    expect(config).not.toContain("host.docker.internal");
  });

  it("attaches the middlewares to both entry points", () => {
    const fake = io();

    configureTraefik(fake);

    const staticConfig = fake.written(
      `${TRAEFIK_DIR}/static_config.trafic.yaml`,
    );
    // Entry point level, so every request passes auth regardless of which
    // project router handles it
    expect(staticConfig).toContain("http-80");
    expect(staticConfig).toContain("http-443");
    expect(staticConfig).toContain("trafic-auth@file");
    expect(staticConfig).toContain("trafic-errors@file");
  });

  it("writes the dynamic config to both locations DDEV watches", () => {
    const fake = io();

    configureTraefik(fake);

    // custom-global-config survives the config dir purge on restart in
    // DDEV 1.25+; the traefik root is watched by older versions
    expect(fake.written(`${TRAEFIK_DIR}/trafic.yaml`)).not.toBe("");
    expect(
      fake.written(`${TRAEFIK_DIR}/custom-global-config/trafic.yaml`),
    ).not.toBe("");
  });

  it("serves the waiting page on 502 and 503", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    expect(config).toContain('"502"');
    expect(config).toContain('"503"');
    expect(config).toContain("service: trafic-service");
  });

  it("leaves the config owned by ddev", () => {
    const fake = io();

    configureTraefik(fake);

    expect(fake.ran(`chown ddev:ddev ${TRAEFIK_DIR}/trafic.yaml`)).toBe(true);
  });
});

describe("configureDdev", () => {
  it("sets the project TLD", () => {
    const io = createFakeIo();

    configureDdev("previews.example.com", undefined, io);

    expect(io.ran("--project-tld=previews.example.com")).toBe(true);
  });

  it("binds the router to all interfaces on the standard ports", () => {
    const io = createFakeIo();

    configureDdev("previews.example.com", undefined, io);

    const config = io.commands.find((c) => c.includes("ddev config global"))!;
    // Without bind-all-interfaces, external traffic gets a 521
    expect(config).toContain("--router-bind-all-interfaces=true");
    expect(config).toContain("--router-http-port=80");
    expect(config).toContain("--router-https-port=443");
  });

  it("enables Let's Encrypt only when given an email", () => {
    const withEmail = createFakeIo();
    configureDdev("previews.example.com", "admin@example.com", withEmail);
    expect(withEmail.ran("--use-letsencrypt=true")).toBe(true);
    expect(withEmail.ran("--letsencrypt-email=admin@example.com")).toBe(true);

    const withoutEmail = createFakeIo();
    configureDdev("previews.example.com", undefined, withoutEmail);
    expect(withoutEmail.ran("--use-letsencrypt=false")).toBe(true);
    expect(withoutEmail.ran("--letsencrypt-email")).toBe(false);
  });

  it("opts out of instrumentation", () => {
    const io = createFakeIo();

    configureDdev("previews.example.com", undefined, io);

    expect(io.ran("--instrumentation-opt-in=false")).toBe(true);
  });

  it("runs the configuration as the ddev user", () => {
    const io = createFakeIo();

    configureDdev("previews.example.com", undefined, io);

    // Global config lands in the invoking user's home directory
    expect(io.commands.find((c) => c.includes("ddev config global"))).toContain(
      "su - ddev -c",
    );
  });
});

describe("installDnsmasq", () => {
  it("resolves the wildcard TLD to the detected server IP", () => {
    const io = createFakeIo({ output: { "ifconfig.me": "203.0.113.10\n" } });

    installDnsmasq("previews.example.com", io);

    expect(io.written("/etc/dnsmasq.d/trafic.conf")).toContain(
      "address=/previews.example.com/203.0.113.10",
    );
  });

  it("falls back to localhost when the IP cannot be detected", () => {
    const io = createFakeIo();

    installDnsmasq("previews.example.com", io);

    expect(io.written("/etc/dnsmasq.d/trafic.conf")).toContain(
      "address=/previews.example.com/127.0.0.1",
    );
  });

  it("listens on localhost only", () => {
    const io = createFakeIo();

    installDnsmasq("previews.example.com", io);

    // An open resolver on a public server would be abused for amplification
    const config = io.written("/etc/dnsmasq.d/trafic.conf");
    expect(config).toContain("listen-address=127.0.0.1");
    expect(config).toContain("bind-interfaces");
  });

  it("enables dnsmasq so it survives a reboot", () => {
    const io = createFakeIo();

    installDnsmasq("previews.example.com", io);

    expect(io.ran("systemctl enable dnsmasq")).toBe(true);
  });
});

describe("configureTraefik catch-all router", () => {
  const io = () => createFakeIo({ output: { [DDEV_NETWORK]: "172.20.0.1\n" } });

  it("defines a catch-all router so stopped projects reach the agent", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    // ddev stop removes the project's router, so without this Traefik answers
    // 404 and the waiting page never appears
    expect(config).toContain("trafic-catchall");
    expect(config).toContain("service: trafic-service");
  });

  it("gives it the lowest priority so project routers always win", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    expect(config).toContain("priority: 1");
  });

  it("defines both a plain and a TLS catch-all", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    // A router carrying tls only matches HTTPS entry points, so one alone
    // leaves plain HTTP answering 404 — verified on a real server
    expect(config).toContain("trafic-catchall:");
    expect(config).toContain("trafic-catchall-tls:");
  });

  it("puts tls on exactly one of them", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    const routers = config.slice(config.indexOf("routers:"), config.indexOf("services:"));
    expect(routers.match(/tls: \{\}/g) ?? []).toHaveLength(1);
  });

  it("does not attach auth to the catch-all itself", () => {
    const fake = io();

    configureTraefik(fake);

    const config = fake.written(`${TRAEFIK_DIR}/trafic.yaml`);
    const router = config.slice(config.indexOf("trafic-catchall"));
    // Auth lives on the entry point. Attaching it here was the arrangement
    // that let project routers bypass it, which #27 fixed.
    expect(router).not.toContain("middlewares");
  });
});
