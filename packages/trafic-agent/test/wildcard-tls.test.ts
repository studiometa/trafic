import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStaticConfig,
  buildTlsStoreConfig,
  buildRouterComposeOverride,
  configureTraefik,
  readLetsEncryptSettings,
  readProjectTld,
  ROUTER_COMPOSE_OVERRIDE,
  TLS_STORE_CONFIG,
} from "../src/setup/ddev.js";
import { createAgentConfig } from "../src/setup/agent.js";
import { warnIfWildcardNotApplied } from "../src/utils/tls.js";
import { hasCertificateFor } from "../src/setup/audit.js";
import { loadConfig } from "../src/utils/config.js";
import { createFakeIo } from "./helpers/fake-io.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const STATIC_CONFIG = "/home/ddev/.ddev/traefik/static_config.trafic.yaml";
const GLOBAL_CONFIG = "su - ddev -c 'ddev config global'";

/** A DDEV global config with Let's Encrypt on, as setup --email leaves it. */
const LETS_ENCRYPT_ON = [
  "project-tld=previews.example.com",
  "use-letsencrypt=true",
  "letsencrypt-email=admin@example.com",
  "router-http-port=80",
  "router-https-port=443",
].join("\n");

describe("buildStaticConfig with a DNS-01 resolver", () => {
  const tls = { provider: "cloudflare", email: "admin@example.com" };

  it("keeps the entry points and adds the resolver", () => {
    const config = buildStaticConfig([], { http: "80", https: "443" }, tls);

    expect(config).toContain("  http-443:");
    expect(config).toContain("certificatesResolvers:");
    expect(config).toContain("  acme-dns:");
    expect(config).toContain('provider: "cloudflare"');
    expect(config).toContain('email: "admin@example.com"');
  });

  it("keeps the resolver storage apart from DDEV's own acme.json", () => {
    // Sharing the file would mix the per-host certificates with the wildcard
    expect(buildStaticConfig([], undefined, tls)).toContain(
      "storage: /mnt/ddev-global-cache/traefik/acme-dns.json",
    );
  });

  it("asks public resolvers for the challenge record", () => {
    const config = buildStaticConfig([], undefined, tls);

    expect(config).toContain('- "1.1.1.1:53"');
    expect(config).toContain('- "9.9.9.9:53"');
  });

  it("omits caServer unless one is configured", () => {
    expect(buildStaticConfig([], undefined, tls)).not.toContain("caServer");
  });

  it("emits caServer when one is configured", () => {
    const config = buildStaticConfig([], undefined, {
      ...tls,
      caServer: "https://acme-staging-v02.api.letsencrypt.org/directory",
    });

    expect(config).toContain(
      'caServer: "https://acme-staging-v02.api.letsencrypt.org/directory"',
    );
    // The key after it must stay at the same indentation
    expect(config).toContain("      dnsChallenge:");
  });

  it("adds nothing without tls options", () => {
    expect(buildStaticConfig(["8025"])).not.toContain("certificatesResolvers");
  });
});

describe("buildTlsStoreConfig", () => {
  it("asks for the TLD and its wildcard", () => {
    const config = buildTlsStoreConfig("previews.example.com");

    expect(config).toContain('main: "previews.example.com"');
    expect(config).toContain('- "*.previews.example.com"');
  });

  it("points the store at the DNS-01 resolver", () => {
    expect(buildTlsStoreConfig("example.com")).toContain("resolver: acme-dns");
  });

  it("defines the default store", () => {
    // Traefik serves defaultGeneratedCert to every host without its own
    const config = buildTlsStoreConfig("example.com");

    expect(config).toContain("stores:");
    expect(config).toContain("    default:");
    expect(config).toContain("      defaultGeneratedCert:");
  });
});

describe("buildRouterComposeOverride", () => {
  it("passes each credential to the router container", () => {
    const config = buildRouterComposeOverride({
      CF_DNS_API_TOKEN: "secret",
      CF_ZONE_API_TOKEN: "other",
    });

    expect(config).toContain("  ddev-router:");
    expect(config).toContain('      - "CF_DNS_API_TOKEN=secret"');
    expect(config).toContain('      - "CF_ZONE_API_TOKEN=other"');
  });

  it("escapes a value that would break the YAML scalar", () => {
    const config = buildRouterComposeOverride({ TOKEN: 'a"b\\c' });

    expect(config).toContain('- "TOKEN=a\\"b\\\\c"');
  });
});

describe("readLetsEncryptSettings", () => {
  it("reads the account from DDEV's global config", () => {
    const io = createFakeIo({ output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON } });

    expect(readLetsEncryptSettings(io)).toEqual({
      enabled: true,
      email: "admin@example.com",
    });
  });

  it("reports Let's Encrypt off", () => {
    const io = createFakeIo({
      output: { [GLOBAL_CONFIG]: "use-letsencrypt=false\n" },
    });

    expect(readLetsEncryptSettings(io).enabled).toBe(false);
  });

  it("reports nothing when the config cannot be read", () => {
    const io = createFakeIo({ fails: [GLOBAL_CONFIG] });

    expect(readLetsEncryptSettings(io)).toEqual({ enabled: false, email: undefined });
  });
});

describe("readProjectTld", () => {
  it("reads the TLD from DDEV's global config", () => {
    const io = createFakeIo({ output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON } });

    expect(readProjectTld(io)).toBe("previews.example.com");
  });

  it("returns an empty string when DDEV says nothing", () => {
    expect(readProjectTld(createFakeIo())).toBe("");
  });
});

describe("configureTraefik with a DNS provider", () => {
  const tls = { dnsProvider: "cloudflare", dnsEnv: { CF_DNS_API_TOKEN: "secret" } };

  function configure(extra: Parameters<typeof createFakeIo>[0] = {}) {
    const io = createFakeIo({
      output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON },
      ...extra,
    });

    configureTraefik({ tls }, io);

    return io;
  }

  it("writes the resolver into the static config", () => {
    expect(configure().written(STATIC_CONFIG)).toContain("acme-dns:");
  });

  it("writes the TLS store to a file Traefik reads before DDEV's", () => {
    // The file provider keeps the first default store it sees, and DDEV's
    // default_config.yaml holds an empty one
    const io = configure();

    expect(TLS_STORE_CONFIG).toContain("custom-global-config/0-trafic-tls.yaml");
    expect(io.written(TLS_STORE_CONFIG)).toContain('main: "previews.example.com"');
  });

  it("writes the credentials to the router compose override, mode 600", () => {
    const io = configure();

    expect(io.written(ROUTER_COMPOSE_OVERRIDE)).toContain("CF_DNS_API_TOKEN=secret");
    // Created empty and restricted first: a chmod after the write would
    // leave the token readable by everyone for as long as it takes
    expect(
      io.ran(`install -m 600 -o ddev -g ddev /dev/null ${ROUTER_COMPOSE_OVERRIDE}`),
    ).toBe(true);
  });

  it("quotes the provider name in the static config", () => {
    // The name is not validated, and an unquoted YAML scalar holding a colon
    // or a newline would inject keys into the resolver
    const io = createFakeIo({ output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON } });

    configureTraefik({ tls: { ...tls, dnsProvider: 'x", a: "b' } }, io);

    expect(io.written(STATIC_CONFIG)).toContain('provider: "x\\", a: \\"b"');
  });

  it("uses the TLD it is given over DDEV's", () => {
    const io = createFakeIo({ output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON } });

    configureTraefik({ tls, tld: "other.example.com" }, io);

    expect(io.written(TLS_STORE_CONFIG)).toContain('main: "other.example.com"');
  });

  it("refuses to run with Let's Encrypt disabled", () => {
    // Without an account email Let's Encrypt rejects the registration, and
    // failing here says so instead of leaving an ACME error in a router log
    const io = createFakeIo({
      output: { [GLOBAL_CONFIG]: "project-tld=x.example.com\nuse-letsencrypt=false" },
    });

    expect(() => configureTraefik({ tls }, io)).toThrow(/--email/);
  });

  it("refuses to run when DDEV has no TLD", () => {
    const io = createFakeIo({
      output: {
        [GLOBAL_CONFIG]: "use-letsencrypt=true\nletsencrypt-email=admin@example.com",
      },
    });

    expect(() => configureTraefik({ tls }, io)).toThrow(/TLD/);
  });
});

describe("configureTraefik without a DNS provider", () => {
  it("writes no wildcard files", () => {
    const io = createFakeIo({ output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON } });

    configureTraefik({ tls: { dnsEnv: {} } }, io);

    expect(io.writes.has(TLS_STORE_CONFIG)).toBe(false);
    expect(io.writes.has(ROUTER_COMPOSE_OVERRIDE)).toBe(false);
    expect(io.written(STATIC_CONFIG)).not.toContain("acme-dns");
  });

  it("removes the wildcard files left by an earlier run", () => {
    // No compatibility path: the resolver is gone from the static config, so
    // a store pointing at it would leave every host on the default certificate
    const io = createFakeIo({
      output: { [GLOBAL_CONFIG]: LETS_ENCRYPT_ON },
      files: { [TLS_STORE_CONFIG]: "tls:\n", [ROUTER_COMPOSE_OVERRIDE]: "services:\n" },
    });

    configureTraefik({ tls: { dnsEnv: {} } }, io);

    expect(io.ran(`rm -f ${TLS_STORE_CONFIG}`)).toBe(true);
    expect(io.ran(`rm -f ${ROUTER_COMPOSE_OVERRIDE}`)).toBe(true);
  });
});

describe("createAgentConfig with a DNS provider", () => {
  it("writes the [tls] section", () => {
    const io = createFakeIo();

    createAgentConfig(
      {
        tld: "previews.example.com",
        dnsProvider: "cloudflare",
        dnsEnv: { CF_DNS_API_TOKEN: "secret" },
      },
      io,
    );

    const config = io.written("/etc/trafic/config.toml");

    expect(config).toContain("[tls]");
    expect(config).toContain('dns_provider = "cloudflare"');
    expect(config).toContain("[tls.dns_env]");
    expect(config).toContain('CF_DNS_API_TOKEN = "secret"');
  });

  it("writes no [tls] section without a provider", () => {
    const io = createFakeIo();

    createAgentConfig({ tld: "previews.example.com" }, io);

    expect(io.written("/etc/trafic/config.toml")).not.toContain("[tls]");
  });

  it("escapes the provider name it was given", () => {
    // The name is never validated, and an unescaped quote would close the
    // TOML string and let the rest of the value add keys of its own
    const io = createFakeIo();

    createAgentConfig(
      { tld: "previews.example.com", dnsProvider: 'x"\nport = 1', dnsEnv: {} },
      io,
    );

    expect(io.written("/etc/trafic/config.toml")).toContain(
      'dns_provider = "x\\"\\nport = 1"',
    );
  });

  it("leaves an existing config alone", () => {
    const io = createFakeIo({ files: { "/etc/trafic/config.toml": "tld = 'x'\n" } });

    createAgentConfig(
      { tld: "previews.example.com", dnsProvider: "cloudflare", dnsEnv: {} },
      io,
    );

    expect(io.writes.has("/etc/trafic/config.toml")).toBe(false);
  });

  it("masks the credentials in the snippet printed for an existing config", () => {
    // The snippet goes to the terminal and to the CI job log of whoever ran
    // `trafic setup` — a provider token belongs in neither
    const io = createFakeIo({ files: { "/etc/trafic/config.toml": "tld = 'x'\n" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    createAgentConfig(
      {
        tld: "previews.example.com",
        dnsProvider: "cloudflare",
        dnsEnv: { CF_DNS_API_TOKEN: "secret" },
      },
      io,
    );

    const printed = log.mock.calls.map((call) => call.join(" ")).join("\n");
    log.mockRestore();

    expect(printed).toContain("[tls.dns_env]");
    expect(printed).toContain("REPLACE_ME");
    expect(printed).not.toContain("secret");
  });
});

describe("loadConfig tls section", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trafic-tls-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function load(body: string) {
    const path = join(dir, "config.toml");
    writeFileSync(path, `tld = "example.com"\n${body}\n`);
    return loadConfig(path);
  }

  it("defaults to no provider and no credentials", () => {
    expect(load("").tls).toEqual({ dnsEnv: {} });
  });

  it("reads the provider, the CA server and the credentials", () => {
    const { tls } = load(
      [
        "[tls]",
        'dns_provider = "cloudflare"',
        'ca_server = "https://acme-staging-v02.api.letsencrypt.org/directory"',
        "[tls.dns_env]",
        'CF_DNS_API_TOKEN = "secret"',
      ].join("\n"),
    );

    expect(tls.dnsProvider).toBe("cloudflare");
    expect(tls.caServer).toBe(
      "https://acme-staging-v02.api.letsencrypt.org/directory",
    );
    expect(tls.dnsEnv).toEqual({ CF_DNS_API_TOKEN: "secret" });
  });
});

describe("warnIfWildcardNotApplied", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trafic-warn-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = (dnsProvider?: string) =>
    ({ tls: { dnsProvider, dnsEnv: {} } }) as Parameters<
      typeof warnIfWildcardNotApplied
    >[0];

  it("warns when the config asks for a wildcard Traefik never got", () => {
    const path = join(dir, "static_config.trafic.yaml");
    writeFileSync(path, "entryPoints:\n");

    expect(warnIfWildcardNotApplied(config("cloudflare"), path)).toBe(true);
  });

  it("warns when the static config is missing entirely", () => {
    expect(
      warnIfWildcardNotApplied(config("cloudflare"), join(dir, "missing.yaml")),
    ).toBe(true);
  });

  it("stays quiet once the resolver is configured", () => {
    const path = join(dir, "static_config.trafic.yaml");
    writeFileSync(path, "certificatesResolvers:\n  acme-dns:\n");

    expect(warnIfWildcardNotApplied(config("cloudflare"), path)).toBe(false);
  });

  it("stays quiet when no provider is configured", () => {
    expect(warnIfWildcardNotApplied(config(), join(dir, "missing.yaml"))).toBe(false);
  });
});

describe("hasCertificateFor", () => {
  const storage = JSON.stringify({
    "acme-dns": {
      Certificates: [
        { domain: { main: "previews.example.com", sans: ["*.previews.example.com"] } },
      ],
    },
  });

  it("finds the wildcard certificate", () => {
    expect(hasCertificateFor(storage, "previews.example.com")).toBe(true);
  });

  it("does not match another domain", () => {
    expect(hasCertificateFor(storage, "other.example.com")).toBe(false);
  });

  it("handles an empty or broken store", () => {
    expect(hasCertificateFor("", "example.com")).toBe(false);
    expect(hasCertificateFor("{}", "example.com")).toBe(false);
    expect(hasCertificateFor('{"acme-dns":{}}', "example.com")).toBe(false);
  });
});
