import { describe, it, expect } from "vitest";
import { allowTlsFor } from "../src/server.js";
import { buildHostnameIndex } from "../src/utils/ddev.js";

const projects = new Map([
  ["scalian", "/home/ddev/www/scalian"],
  ["preview-42--scalian", "/home/ddev/www/preview-42--scalian"],
]);
const index = buildHostnameIndex(projects, "preprod.ikko.fr");

describe("allowTlsFor", () => {
  it("allows a known project hostname", () => {
    expect(allowTlsFor("scalian.preprod.ikko.fr", index)).toBe(true);
  });

  it("allows a preview hostname", () => {
    // The reason on-demand TLS is needed at all: these appear and vanish
    expect(allowTlsFor("preview-42--scalian.preprod.ikko.fr", index)).toBe(true);
  });

  it("refuses an unknown hostname", () => {
    // Otherwise anyone pointing DNS at this server burns Let's Encrypt quota,
    // which is per registered domain and shared by every preview
    expect(allowTlsFor("not-a-project.preprod.ikko.fr", index)).toBe(false);
  });

  it("refuses a hostname on another domain", () => {
    expect(allowTlsFor("scalian.evil.example.com", index)).toBe(false);
  });

  it("refuses the bare TLD", () => {
    expect(allowTlsFor("preprod.ikko.fr", index)).toBe(false);
  });

  it("refuses an empty domain", () => {
    expect(allowTlsFor("", index)).toBe(false);
  });

  it("matches case-insensitively, as DNS is", () => {
    expect(allowTlsFor("Scalian.PreProd.Ikko.FR", index)).toBe(true);
  });

  it("refuses everything when no projects are loaded", () => {
    expect(allowTlsFor("scalian.preprod.ikko.fr", new Map())).toBe(false);
  });
});
