import { describe, it, expect } from "vitest";
import { routePath } from "../src/server.js";

describe("routePath", () => {
  it("returns the path unchanged when there is no query", () => {
    expect(routePath("/__auth__")).toBe("/__auth__");
    expect(routePath("/__health__")).toBe("/__health__");
  });

  it("drops the query string", () => {
    // The whole point: routing used to compare the raw target, so a query
    // threw every internal route off and the request fell to the waiting page
    expect(routePath("/__auth__?s=search+term")).toBe("/__auth__");
    expect(routePath("/__status__?project=scalian")).toBe("/__status__");
    expect(routePath("/__tls__?domain=scalian.preprod.ikko.fr")).toBe("/__tls__");
    expect(routePath("/__health__?x=1")).toBe("/__health__");
  });

  it("drops the fragment", () => {
    expect(routePath("/__auth__#frag")).toBe("/__auth__");
  });

  it("treats a trailing slash as the same endpoint", () => {
    expect(routePath("/__auth__/")).toBe("/__auth__");
    expect(routePath("/__auth__/?x=1")).toBe("/__auth__");
  });

  it("keeps a subpath, so the prefix branches still match", () => {
    expect(routePath("/__auth__/nested")).toBe("/__auth__/nested");
    expect(routePath("/__status__/scalian")).toBe("/__status__/scalian");
  });

  it("keeps the root as a single slash", () => {
    expect(routePath("/")).toBe("/");
    expect(routePath("/?nocache=1")).toBe("/");
  });

  it("falls back to the root for a missing target", () => {
    expect(routePath(undefined)).toBe("/");
    expect(routePath("")).toBe("/");
  });

  it("reads the path out of an absolute target", () => {
    // A proxy may send absolute-form; the host must not decide the route
    expect(routePath("http://example.com/__auth__?x=1")).toBe("/__auth__");
  });

  it("does not let a malformed target pick a route", () => {
    expect(routePath("http://")).toBe("/");
  });

  it("routes an application path with a query to the waiting page, not auth", () => {
    // wp-admin redirects here, and it must not be mistaken for an endpoint
    const path = routePath("/wp/wp-login.php?redirect_to=%2Fwp%2Fwp-admin%2F");

    expect(path).toBe("/wp/wp-login.php");
    expect(path.startsWith("/__")).toBe(false);
  });
});
