import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const modulePath = path.join(packageRoot, "dist", "desktopRuntimeActivity.js");
const {
  DesktopRuntimeHttpError,
  assertDesktopRuntimeResumed,
  buildDesktopRuntimeDrainUrl,
  buildDesktopRuntimeResumeUrl,
  buildDesktopRuntimeStopUrl,
  canResumeDesktopRuntimeAfterFailedQuit,
  createDesktopQuitWaitControl,
  readDesktopRuntimeActiveJobCount,
  runDesktopRuntimeExitCleanup,
  withRefreshedDesktopRuntimeAccess,
  withDesktopRuntimeTimeout,
} = await import(modulePath);

test("buildDesktopRuntimeStopUrl preserves a configured controller path", () => {
  assert.equal(
    buildDesktopRuntimeStopUrl("https://controller.example/api/"),
    "https://controller.example/api/runtime/stop",
  );
});

test("buildDesktopRuntimeResumeUrl uses the exact runtime fence route", () => {
  assert.equal(
    buildDesktopRuntimeResumeUrl("https://controller.example", "project", "runtime"),
    "https://controller.example/projects/project/runtime/runtime/resume",
  );
});

test("buildDesktopRuntimeDrainUrl scopes the fence to the exact runtime", () => {
  assert.equal(
    buildDesktopRuntimeDrainUrl("https://controller.example", "project", "runtime/one"),
    "https://controller.example/projects/project/runtime/runtime%2Fone/drain",
  );
});

test("readDesktopRuntimeActiveJobCount selects the exact desktop runtime", () => {
  const now = Date.parse("2026-07-21T12:00:00Z");
  assert.equal(
    readDesktopRuntimeActiveJobCount(
      {
        ok: true,
        contractVersion: 1,
        runtimeId: "desktop",
        status: "draining",
        drainExpiresAt: "2026-07-21T12:01:30Z",
        activeJobCount: 1,
      },
      "desktop",
      now,
    ),
    1,
  );
});

test("readDesktopRuntimeActiveJobCount fails closed on missing or malformed state", () => {
  const now = Date.parse("2026-07-21T12:00:00Z");
  assert.throws(
    () =>
      readDesktopRuntimeActiveJobCount(
        {
          ok: true,
          contractVersion: 1,
          runtimeId: "other",
          status: "draining",
          drainExpiresAt: "2026-07-21T12:01:30Z",
          activeJobCount: 0,
        },
        "desktop",
        now,
      ),
    /not present/i,
  );
  assert.throws(
    () =>
      readDesktopRuntimeActiveJobCount(
        {
          ok: true,
          contractVersion: 1,
          runtimeId: "desktop",
          status: "draining",
          drainExpiresAt: "2026-07-21T12:01:30Z",
          activeJobCount: "1",
        },
        "desktop",
        now,
      ),
    /valid active job count/i,
  );
  assert.throws(
    () =>
      readDesktopRuntimeActiveJobCount(
        {
          ok: true,
          contractVersion: 1,
          runtimeId: "desktop",
          status: "ready",
          drainExpiresAt: "2026-07-21T12:01:30Z",
          activeJobCount: 0,
        },
        "desktop",
        now,
      ),
    /drain fence/i,
  );
  assert.throws(
    () =>
      readDesktopRuntimeActiveJobCount(
        {
          ok: true,
          contractVersion: 2,
          runtimeId: "desktop",
          status: "draining",
          drainExpiresAt: "2026-07-21T12:01:30Z",
          activeJobCount: 0,
        },
        "desktop",
        now,
      ),
    /drain fence/i,
  );
  assert.throws(
    () =>
      readDesktopRuntimeActiveJobCount(
        {
          ok: true,
          contractVersion: 1,
          runtimeId: "desktop",
          status: "draining",
          drainExpiresAt: "2026-07-21T12:00:05Z",
          activeJobCount: 0,
        },
        "desktop",
        now,
      ),
    /drain fence/i,
  );
});

test("assertDesktopRuntimeResumed validates the exact ready response", () => {
  assert.doesNotThrow(() =>
    assertDesktopRuntimeResumed(
      {
        ok: true,
        contractVersion: 1,
        runtimeId: "desktop",
        status: "ready",
        drainExpiresAt: null,
      },
      "desktop",
    ),
  );
  assert.throws(
    () =>
      assertDesktopRuntimeResumed(
        {
          ok: true,
          contractVersion: 1,
          runtimeId: "desktop",
          status: "draining",
          drainExpiresAt: "2026-07-21T12:01:30Z",
        },
        "desktop",
      ),
    /did not confirm/i,
  );
});

test("withRefreshedDesktopRuntimeAccess rotates an expired token once", async () => {
  let token = "expired";
  const requestedTokens = [];
  let refreshes = 0;

  const result = await withRefreshedDesktopRuntimeAccess({
    getAccessToken: () => token,
    refreshAccessToken: async () => {
      refreshes += 1;
      token = "fresh";
    },
    request: async (accessToken) => {
      requestedTokens.push(accessToken);
      if (accessToken === "expired") {
        throw new DesktopRuntimeHttpError(401);
      }
      return { ok: true };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(refreshes, 1);
  assert.deepEqual(requestedTokens, ["expired", "fresh"]);
});

test("withRefreshedDesktopRuntimeAccess does not retry non-authentication failures", async () => {
  let refreshes = 0;
  await assert.rejects(
    withRefreshedDesktopRuntimeAccess({
      getAccessToken: () => "token",
      refreshAccessToken: async () => {
        refreshes += 1;
      },
      request: async () => {
        throw new DesktopRuntimeHttpError(500);
      },
    }),
    /HTTP 500/,
  );
  assert.equal(refreshes, 0);
});

test("withDesktopRuntimeTimeout bounds a renderer session read that never settles", async () => {
  await assert.rejects(
    withDesktopRuntimeTimeout(
      new Promise(() => undefined),
      5,
      "Visible session refresh",
    ),
    /timed out/i,
  );
});

test("a coalesced second quit request can force or cancel one hung wait", async () => {
  const control = createDesktopQuitWaitControl();
  assert.equal(control.isSettled(), false);
  assert.equal(control.choose("force"), true);
  assert.equal(control.choose("cancel"), false);
  assert.equal(await control.promise, "force");
  assert.equal(control.isSettled(), true);
});

test("a rejected child exit observation still runs process-tree cleanup", async () => {
  const exitError = new Error("spawn failed after process creation");
  const observed = [];
  await runDesktopRuntimeExitCleanup(Promise.reject(exitError), async (error) => {
    observed.push(error);
  });
  assert.deepEqual(observed, [exitError]);
});

test("a failed quit resumes only before signals and while the runtime root is alive", () => {
  assert.equal(
    canResumeDesktopRuntimeAfterFailedQuit({
      localStopAttempted: false,
      runtimeRootAlive: true,
    }),
    true,
  );
  assert.equal(
    canResumeDesktopRuntimeAfterFailedQuit({
      localStopAttempted: true,
      runtimeRootAlive: true,
    }),
    false,
  );
  assert.equal(
    canResumeDesktopRuntimeAfterFailedQuit({
      localStopAttempted: false,
      runtimeRootAlive: false,
    }),
    false,
  );
});
