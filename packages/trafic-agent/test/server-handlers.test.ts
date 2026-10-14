import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handleAuth,
  handleErrors,
  handleStatus,
  handleRequest,
  getEffectiveAuthConfig,
  makeRoomUnderLimit,
  releaseStatusesAtStart,
} from "../src/server.js";
import {
  initDb,
  closeDb,
  getDb,
  getProject,
  setProjectStatus,
  updateProjectAccess,
} from "../src/utils/db.js";
import type { DdevRunner } from "../src/utils/ddev.js";
import {
  createFakeDeps,
  captureResponse,
  request,
  defaultAuth,
} from "./helpers/fake-server-deps.js";

console.log = () => {};
console.error = () => {};

/** Let the start that runs after the response settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const CREDENTIALS = `Basic ${Buffer.from("user:pass").toString("base64")}`;
const HOSTS = { "app.example.com": "app" };

describe("getEffectiveAuthConfig", () => {
  it("uses the global policy for an unknown project", () => {
    const { deps } = createFakeDeps();

    expect(getEffectiveAuthConfig(undefined, deps).defaultPolicy).toBe("basic");
  });

  it("uses the global policy when the project sets none", () => {
    const { deps } = createFakeDeps({ hostnames: HOSTS });

    expect(getEffectiveAuthConfig("app", deps).defaultPolicy).toBe("basic");
  });

  it("lets a project override the policy", () => {
    const { deps } = createFakeDeps({ projectPolicies: { app: "allow" } });

    expect(getEffectiveAuthConfig("app", deps).defaultPolicy).toBe("allow");
  });

  it("keeps the rest of the global config when overriding", () => {
    const { deps } = createFakeDeps({ projectPolicies: { app: "allow" } });

    // Only the policy is per-project; credentials stay server-wide
    expect(getEffectiveAuthConfig("app", deps).basicAuth).toEqual(
      defaultAuth.basicAuth,
    );
  });
});

describe("handleAuth", () => {
  it("allows a request with valid credentials", () => {
    const { deps, recorded } = createFakeDeps({ hostnames: HOSTS });
    const out = captureResponse();

    handleAuth(
      request({ "x-forwarded-host": "app.example.com", authorization: CREDENTIALS }),
      out.res,
      deps,
    );

    expect(out.status()).toBe(200);
    expect(recorded.accessed).toEqual(["app"]);
  });

  it("challenges a request without credentials", () => {
    const { deps } = createFakeDeps({ hostnames: HOSTS });
    const out = captureResponse();

    handleAuth(request({ "x-forwarded-host": "app.example.com" }), out.res, deps);

    expect(out.status()).toBe(401);
    // Without this the browser never shows a prompt
    expect(out.headers()["WWW-Authenticate"]).toContain("Basic");
  });

  it("records the path and client address of an allowed request", () => {
    const { deps, recorded } = createFakeDeps({ hostnames: HOSTS });

    handleAuth(
      request({
        "x-forwarded-host": "app.example.com",
        "x-forwarded-uri": "/wp/wp-admin/",
        authorization: CREDENTIALS,
      }),
      captureResponse().res,
      deps,
    );

    expect(recorded.logged).toEqual([
      { project: "app", path: "/wp/wp-admin/", ip: "172.18.0.5" },
    ]);
  });

  it("logs nothing for a hostname that is not a project", () => {
    const { deps, recorded } = createFakeDeps({ hostnames: {} });

    handleAuth(
      request({ "x-forwarded-host": "nope.example.com", authorization: CREDENTIALS }),
      captureResponse().res,
      deps,
    );

    expect(recorded.accessed).toEqual([]);
    expect(recorded.logged).toEqual([]);
  });

  it("applies a project's own policy", () => {
    const { deps } = createFakeDeps({
      hostnames: HOSTS,
      projectPolicies: { app: "allow" },
    });
    const out = captureResponse();

    handleAuth(request({ "x-forwarded-host": "app.example.com" }), out.res, deps);

    // The project opted out of auth, so no credentials are needed
    expect(out.status()).toBe(200);
  });
});

describe("handleErrors", () => {
  it("shows the error page for an unknown hostname", async () => {
    const { deps } = createFakeDeps({ hostnames: {} });
    const out = captureResponse();

    await handleErrors(request({ "x-forwarded-host": "nope.example.com" }), out.res, deps);

    expect(out.status()).toBe(404);
    expect(out.body()).toContain("error:");
  });

  it("shows the waiting page and starts a stopped project", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
    });
    const out = captureResponse();

    await handleErrors(request({ "x-forwarded-host": "app.example.com" }), out.res, deps);
    await settle();

    expect(out.status()).toBe(503);
    expect(out.headers()["Retry-After"]).toBe("5");
    expect(recorded.started).toEqual(["app"]);
  });

  it("makes room under the running limit before it starts the project", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
    });

    await handleErrors(
      request({ "x-forwarded-host": "app.example.com" }),
      captureResponse().res,
      deps,
    );
    await settle();

    // Marked "starting" first: that is how the limit counts it as running
    expect(recorded.steps).toEqual(["app starting", "make room", "start app", "app running"]);
  });

  it("still starts the project when making room fails", async () => {
    // A page that never comes up is worse than one project over the limit
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
      makeRoomFails: true,
    });

    await handleErrors(
      request({ "x-forwarded-host": "app.example.com" }),
      captureResponse().res,
      deps,
    );
    await settle();

    expect(recorded.started).toEqual(["app"]);
    expect(recorded.statuses).toContainEqual(["app", "running"]);
  });

  it("marks the project starting before it responds", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
    });

    await handleErrors(
      request({ "x-forwarded-host": "app.example.com" }),
      captureResponse().res,
      deps,
    );

    expect(recorded.statuses[0]).toEqual(["app", "starting"]);
  });

  it("does not start a project that is already starting", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "starting" } },
    });
    const out = captureResponse();

    await handleErrors(request({ "x-forwarded-host": "app.example.com" }), out.res, deps);

    await settle();

    // Every request during a start would otherwise pile up another ddev start
    expect(out.status()).toBe(503);
    expect(recorded.started).toEqual([]);
    expect(recorded.steps).toEqual([]);
  });

  it("does not start a project that trafic-agent destroy is removing", async () => {
    // A start would stop the backup's own start, or bring back the
    // containers that ddev delete removes
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "destroying" } },
    });
    const out = captureResponse();

    await handleErrors(request({ "x-forwarded-host": "app.example.com" }), out.res, deps);
    await settle();

    expect(out.status()).toBe(503);
    expect(out.body()).toContain("error:This project is being removed");
    expect(recorded.steps).toEqual([]);
  });

  it("starts a project whose removal or start was killed", async () => {
    // Its process is gone, so nothing will ever set the status back
    for (const status of ["destroying", "starting"] as const) {
      const { deps, recorded } = createFakeDeps({
        hostnames: HOSTS,
        records: { app: { status } },
        stale: ["app"],
      });

      await handleErrors(
        request({ "x-forwarded-host": "app.example.com" }),
        captureResponse().res,
        deps,
      );
      await settle();

      expect(recorded.started).toEqual(["app"]);
    }
  });

  it("records the project running once the start succeeds", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
      startSucceeds: true,
    });

    await handleErrors(
      request({ "x-forwarded-host": "app.example.com" }),
      captureResponse().res,
      deps,
    );
    await settle();

    expect(recorded.statuses).toContainEqual(["app", "running"]);
  });

  it("records it stopped when the start fails, rather than leaving it starting", async () => {
    // Leaving it "starting" forever would wedge the waiting page
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
      startSucceeds: false,
    });

    await handleErrors(
      request({ "x-forwarded-host": "app.example.com" }),
      captureResponse().res,
      deps,
    );
    await settle();

    expect(recorded.statuses).toContainEqual(["app", "stopped"]);
  });

  it("records it stopped when the start throws", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
      startThrows: true,
    });

    await handleErrors(
      request({ "x-forwarded-host": "app.example.com" }),
      captureResponse().res,
      deps,
    );
    await settle();

    expect(recorded.steps).toEqual(["app starting", "make room", "start app", "app stopped"]);
  });

  it("falls back to the Host header when there is no forwarded host", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
    });

    await handleErrors(request({ host: "app.example.com" }), captureResponse().res, deps);
    await settle();

    expect(recorded.started).toEqual(["app"]);
  });
});

describe("handleStatus", () => {
  it("rejects a request with no project", async () => {
    const { deps } = createFakeDeps();
    const out = captureResponse();

    await handleStatus(request({}, "/__status__"), out.res, deps);

    expect(out.status()).toBe(400);
  });

  it("reports a running project as ready", async () => {
    const { deps } = createFakeDeps({ info: { app: { status: "running" } } });
    const out = captureResponse();

    await handleStatus(request({}, "/__status__?project=app"), out.res, deps);

    expect(JSON.parse(out.body())).toMatchObject({ status: "running", ready: true });
  });

  it("is not ready while the project is still starting", async () => {
    const { deps } = createFakeDeps({ info: { app: { status: "starting" } } });
    const out = captureResponse();

    await handleStatus(request({}, "/__status__?project=app"), out.res, deps);

    expect(JSON.parse(out.body()).ready).toBe(false);
  });

  it("falls back to the recorded status when ddev cannot say", async () => {
    const { deps } = createFakeDeps({ records: { app: { status: "starting" } } });
    const out = captureResponse();

    await handleStatus(request({}, "/__status__?project=app"), out.res, deps);

    expect(JSON.parse(out.body()).status).toBe("starting");
  });

  it("says unknown when neither source knows the project", async () => {
    const { deps } = createFakeDeps();
    const out = captureResponse();

    await handleStatus(request({}, "/__status__?project=ghost"), out.res, deps);

    expect(JSON.parse(out.body()).status).toBe("unknown");
  });
});

describe("handleRequest routing", () => {
  it("sends /__auth__ to the auth handler", async () => {
    const { deps, recorded } = createFakeDeps({ hostnames: HOSTS });

    await handleRequest(
      request(
        { "x-forwarded-host": "app.example.com", authorization: CREDENTIALS },
        "/__auth__",
      ),
      captureResponse().res,
      deps,
    );

    expect(recorded.accessed).toEqual(["app"]);
  });

  it("sends /__auth__ with a query to the auth handler too", async () => {
    // Routing on the raw target sent these to the waiting page instead,
    // which answered 503 and started an already-running project
    const { deps, recorded } = createFakeDeps({ hostnames: HOSTS });

    await handleRequest(
      request(
        { "x-forwarded-host": "app.example.com", authorization: CREDENTIALS },
        "/__auth__?s=search+term",
      ),
      captureResponse().res,
      deps,
    );

    expect(recorded.accessed).toEqual(["app"]);
  });

  it("answers /__health__ with the version", async () => {
    const { deps } = createFakeDeps();
    const out = captureResponse();

    await handleRequest(request({}, "/__health__"), out.res, deps);

    expect(out.status()).toBe(200);
    expect(JSON.parse(out.body()).status).toBe("ok");
  });

  it("sends anything else to the waiting page", async () => {
    const { deps, recorded } = createFakeDeps({
      hostnames: HOSTS,
      records: { app: { status: "stopped" } },
    });

    await handleRequest(
      request({ "x-forwarded-host": "app.example.com" }, "/some/page"),
      captureResponse().res,
      deps,
    );
    await settle();

    expect(recorded.started).toEqual(["app"]);
  });

  it("answers 500 rather than throwing when a handler fails", async () => {
    const { deps } = createFakeDeps({ hostnames: HOSTS });
    const broken = {
      ...deps,
      hostnameIndex: {
        get() {
          throw new Error("index exploded");
        },
      } as unknown as Map<string, string>,
    };
    const out = captureResponse();

    await handleRequest(request({}, "/__auth__"), out.res, broken);

    expect(out.status()).toBe(500);
  });
});

describe("makeRoomUnderLimit", () => {
  const HOUR = 60 * 60 * 1000;

  /** A ddev that lists every given project running and records each call. */
  function runningDdev(names: string[], calls: string[][]): DdevRunner {
    const raw = names.map((name) => ({ name, status: "running", approot: `/home/ddev/www/${name}` }));

    return (args) => {
      calls.push(args);
      return Promise.resolve({ ok: true, stdout: args[0] === "list" ? JSON.stringify({ raw }) : "" });
    };
  }

  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("keeps a project whose own config says idle_timeout: never", async () => {
    updateProjectAccess("pinned", () => Date.now() - 5 * HOUR);
    updateProjectAccess("a", () => Date.now() - 2 * HOUR);
    updateProjectAccess("b", () => Date.now() - HOUR);
    const calls: string[][] = [];

    const stopped = await makeRoomUnderLimit(
      2,
      new Map([["pinned", { idle_timeout: "never" }]]),
      runningDdev(["pinned", "a", "b"], calls),
    );

    expect(stopped).toEqual(["a"]);
    expect(calls).toEqual([["list", "-j"], ["stop", "a"]]);
    expect(getProject("pinned")?.status).toBe("running");
  });

  it("asks nothing of ddev without a limit", async () => {
    const calls: string[][] = [];

    await expect(makeRoomUnderLimit(0, new Map(), runningDdev(["a"], calls))).resolves.toEqual([]);

    expect(calls).toEqual([]);
  });
});

describe("releaseStatusesAtStart", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("sets back a start that the stopped service had in flight", () => {
    // Its id can be the one of this new service after a reboot, which
    // would look alive
    setProjectStatus("app", "starting");

    expect(releaseStatusesAtStart()).toEqual(["app"]);
    expect(getProject("app")?.status).toBe("running");
  });

  it("keeps a removal that trafic-agent destroy still runs", () => {
    // The service can restart in the middle of a removal run over SSH
    setProjectStatus("app", "destroying");
    getDb().prepare("UPDATE projects SET status_pid = ? WHERE name = ?").run(process.ppid, "app");

    expect(releaseStatusesAtStart()).toEqual([]);
    expect(getProject("app")?.status).toBe("destroying");
  });

  it("sets back a removal whose process is gone", () => {
    setProjectStatus("app", "destroying");

    expect(releaseStatusesAtStart(() => false)).toEqual(["app"]);
    expect(getProject("app")?.status).toBe("running");
  });
});
