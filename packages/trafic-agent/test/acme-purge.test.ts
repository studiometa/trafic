import { describe, it, expect } from "vitest";
import { purgeTraefikAcmeStorage, configureDdev } from "../src/setup/ddev.js";
import { createFakeIo } from "./helpers/fake-io.js";

const INSPECT =
  "docker volume inspect ddev-global-cache --format '{{.Mountpoint}}'";
const MOUNT = "/var/lib/docker/volumes/ddev-global-cache/_data";
const LS = `ls ${MOUNT}/traefik/acme.json ${MOUNT}/traefik/acme.json.* 2>/dev/null`;

describe("purgeTraefikAcmeStorage", () => {
  it("removes the storage when it exists", () => {
    const io = createFakeIo({
      output: {
        [INSPECT]: `${MOUNT}\n`,
        [LS]: `${MOUNT}/traefik/acme.json\n`,
      },
    });

    expect(purgeTraefikAcmeStorage(io)).toBe(true);
    expect(io.ran(`rm -f ${MOUNT}/traefik/acme.json`)).toBe(true);
  });

  it("also removes copies a hand-fix left behind", () => {
    const io = createFakeIo({
      output: {
        [INSPECT]: `${MOUNT}\n`,
        [LS]: `${MOUNT}/traefik/acme.json\n${MOUNT}/traefik/acme.json.disabled\n`,
      },
    });

    purgeTraefikAcmeStorage(io);

    // Leaving a renamed copy invites someone to restore it
    expect(io.ran("acme.json.*")).toBe(true);
  });

  it("does nothing when there is no storage", () => {
    const io = createFakeIo({ output: { [INSPECT]: `${MOUNT}\n`, [LS]: "" } });

    expect(purgeTraefikAcmeStorage(io)).toBe(false);
    expect(io.ran("rm -f")).toBe(false);
  });

  it("does nothing when the volume does not exist yet", () => {
    // A fresh server has no volume until the first project starts
    const io = createFakeIo({ fails: [INSPECT] });

    expect(purgeTraefikAcmeStorage(io)).toBe(false);
    expect(io.ran("rm -f")).toBe(false);
  });
});

describe("configureDdev and Let's Encrypt storage", () => {
  it("purges the storage when Let's Encrypt is off", () => {
    const io = createFakeIo({
      output: {
        [INSPECT]: `${MOUNT}\n`,
        [LS]: `${MOUNT}/traefik/acme.json\n`,
      },
    });

    configureDdev("previews.example.com", undefined, io);

    expect(io.ran("--use-letsencrypt=false")).toBe(true);
    // Without this, the next router restart serves a certificate the ingress
    // will not trust, and every request answers 502
    expect(io.ran("rm -f")).toBe(true);
  });

  it("keeps the storage when Let's Encrypt is on", () => {
    const io = createFakeIo({
      output: {
        [INSPECT]: `${MOUNT}\n`,
        [LS]: `${MOUNT}/traefik/acme.json\n`,
      },
    });

    configureDdev("previews.example.com", "admin@example.com", io);

    expect(io.ran("--use-letsencrypt=true")).toBe(true);
    // Those certificates are the ones being served on purpose
    expect(io.ran("rm -f")).toBe(false);
  });
});
