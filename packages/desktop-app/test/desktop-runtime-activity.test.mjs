import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const modulePath = path.join(packageRoot, "dist", "desktopRuntimeActivity.js");
const {
  DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE,
  DesktopRuntimeHttpError,
  assertDesktopRuntimeResumed,
  buildConsentChangeRestartOptions,
  buildDesktopRuntimeDrainUrl,
  buildDesktopRuntimeResumeUrl,
  buildDesktopRuntimeStopUrl,
  canResumeDesktopRuntimeAfterFailedQuit,
  confirmDesktopRuntimeReplacement,
  createDesktopQuitWaitControl,
  desktopRuntimeExitedForDeletedSpace,
  readDesktopRuntimeActiveJobCount,
  resolveDesktopRuntimeControllerCredentialAction,
  resolveDesktopRuntimeLaunchGrantUserId,
  resolveRefreshedDesktopRuntimeAccessToken,
  runDesktopRuntimeExitCleanup,
  withRefreshedDesktopRuntimeAccess,
  withDesktopRuntimeTimeout,
} = await import(modulePath);

test("desktop runtime credential reuse rotates only the same ambient user binding", () => {
  const ambientUserOne = { kind: "ambient", userId: "user-1" };
  const base = {
    currentControllerUrl: "https://controller.example",
    currentCredentialProvenance: ambientUserOne,
    currentAccessToken: "old-token",
    requestedControllerUrl: "https://controller.example",
    requestedCredentialProvenance: ambientUserOne,
    requestedAccessToken: "new-token",
  };

  assert.equal(resolveDesktopRuntimeControllerCredentialAction(base), "rotate");
  assert.equal(
    resolveDesktopRuntimeControllerCredentialAction({
      ...base,
      requestedAccessToken: "old-token",
    }),
    "reuse",
  );
  assert.equal(
    resolveDesktopRuntimeControllerCredentialAction({
      ...base,
      requestedCredentialProvenance: { kind: "ambient", userId: "user-2" },
    }),
    "replace",
  );
  assert.equal(
    resolveDesktopRuntimeControllerCredentialAction({
      ...base,
      requestedControllerUrl: "https://other-controller.example",
    }),
    "replace",
  );
});

test("fixed desktop runtime credentials require an exact token pair", () => {
  const base = {
    currentControllerUrl: "https://controller.example",
    currentCredentialProvenance: { kind: "fixed" },
    currentAccessToken: "fixed-token",
    requestedControllerUrl: "https://controller.example",
    requestedCredentialProvenance: { kind: "fixed" },
    requestedAccessToken: "fixed-token",
  };
  assert.equal(resolveDesktopRuntimeControllerCredentialAction(base), "reuse");
  assert.equal(
    resolveDesktopRuntimeControllerCredentialAction({
      ...base,
      requestedAccessToken: "other-fixed-token",
    }),
    "replace",
  );
});

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
    credentialProvenance: { kind: "ambient", userId: "user-1" },
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
      credentialProvenance: { kind: "ambient", userId: "user-1" },
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

test("withRefreshedDesktopRuntimeAccess never substitutes ambient access for fixed credentials", async () => {
  let refreshes = 0;
  const requestedTokens = [];
  await assert.rejects(
    withRefreshedDesktopRuntimeAccess({
      credentialProvenance: { kind: "fixed" },
      getAccessToken: () => "fixed-override-token",
      refreshAccessToken: async () => {
        refreshes += 1;
      },
      request: async (accessToken) => {
        requestedTokens.push(accessToken);
        throw new DesktopRuntimeHttpError(403);
      },
    }),
    /HTTP 403/,
  );
  assert.equal(refreshes, 0);
  assert.deepEqual(requestedTokens, ["fixed-override-token"]);
});

test("ambient refresh stays bound to the runtime's originating user", () => {
  const provenance = { kind: "ambient", userId: "user-1" };
  assert.equal(
    resolveRefreshedDesktopRuntimeAccessToken(provenance, {
      accessToken: "fresh-token",
      userId: "user-1",
    }),
    "fresh-token",
  );
  assert.equal(
    resolveRefreshedDesktopRuntimeAccessToken(provenance, {
      accessToken: "other-user-token",
      userId: "user-2",
    }),
    null,
  );
  assert.equal(
    resolveRefreshedDesktopRuntimeAccessToken(
      { kind: "fixed" },
      { accessToken: "ambient-token", userId: "user-1" },
    ),
    null,
  );
});

test("withDesktopRuntimeTimeout bounds a renderer session read that never settles", async (t) => {
  // The production timeout is intentionally unreferenced. Advance its clock
  // explicitly so this isolated Node test cannot exit before it fires.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(
    withDesktopRuntimeTimeout(
      new Promise(() => undefined),
      5,
      "Visible session refresh",
    ),
    /timed out/i,
  );
  t.mock.timers.tick(5);
  await rejected;
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
  await runDesktopRuntimeExitCleanup(Promise.reject(exitError), async (error, exit) => {
    observed.push(error, exit);
  });
  assert.deepEqual(observed, [exitError, null]);
});

test("exit cleanup sees how the runtime exited", async () => {
  const observed = [];
  await runDesktopRuntimeExitCleanup(
    Promise.resolve({ code: DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE, signal: null }),
    async (error, exit) => {
      observed.push(error, exit);
    },
  );
  assert.deepEqual(observed, [
    null,
    { code: DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE, signal: null },
  ]);
});

test("the space-deleted exit status is the one runtime-agent exits with", () => {
  const agentSource = fs.readFileSync(
    path.resolve(packageRoot, "..", "runtime-agent", "src", "agent.rs"),
    "utf8",
  );
  const declared = agentSource.match(/pub const SPACE_DELETED_EXIT_CODE: i32 = (\d+);/);
  assert.ok(declared, "runtime-agent declares SPACE_DELETED_EXIT_CODE");
  assert.equal(Number(declared[1]), DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE);
});

test("only the runtime's space-deleted exit status reads as a deleted space", () => {
  assert.equal(
    desktopRuntimeExitedForDeletedSpace({ code: DESKTOP_RUNTIME_SPACE_DELETED_EXIT_CODE, signal: null }),
    true,
  );
  for (const exit of [
    { code: 0, signal: null },
    { code: 1, signal: null },
    { code: 70, signal: null },
    { code: null, signal: "SIGTERM" },
    null,
  ]) {
    assert.equal(desktopRuntimeExitedForDeletedSpace(exit), false, JSON.stringify(exit));
  }
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

function replacementProbe({ activeJobCount = 0, fenceError = null, stop = false } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      fence: async () => {
        calls.push("fence");
        if (fenceError) {
          throw fenceError;
        }
        return activeJobCount;
      },
      ask: async (count) => {
        calls.push(["ask", count]);
        return stop;
      },
      resume: async () => {
        calls.push("resume");
      },
      onError: (stage) => calls.push(["error", stage]),
    },
  };
}

test("replacing a runtime without a launch grant goes ahead as before, with no fence", async () => {
  const probe = replacementProbe({ activeJobCount: 3 });
  assert.equal(
    await confirmDesktopRuntimeReplacement({
      previousHeldLaunchGrant: false,
      consentChange: false,
      ...probe.options,
    }),
    "replace",
  );
  assert.deepEqual(probe.calls, []);
});

test("the replace prompt appears when a granted runtime, or one a consent change replaces, is busy", async () => {
  for (const reason of [
    { previousHeldLaunchGrant: true, consentChange: false },
    { previousHeldLaunchGrant: false, consentChange: true },
    { previousHeldLaunchGrant: true, consentChange: true },
  ]) {
    const idle = replacementProbe({ activeJobCount: 0 });
    assert.equal(await confirmDesktopRuntimeReplacement({ ...reason, ...idle.options }), "replace");
    assert.deepEqual(idle.calls, ["fence"], "an idle runtime is fenced and replaced without asking");

    const stop = replacementProbe({ activeJobCount: 2, stop: true });
    assert.equal(await confirmDesktopRuntimeReplacement({ ...reason, ...stop.options }), "replace");
    assert.deepEqual(stop.calls, ["fence", ["ask", 2]]);

    const keep = replacementProbe({ activeJobCount: 1, stop: false });
    assert.equal(await confirmDesktopRuntimeReplacement({ ...reason, ...keep.options }), "keep");
    assert.deepEqual(keep.calls, ["fence", ["ask", 1], "resume"], "Keep working resumes the runtime");
  }
});

test("an unknown job count asks too; it never replaces silently", async () => {
  const keep = replacementProbe({ fenceError: new Error("controller unreachable") });
  assert.equal(
    await confirmDesktopRuntimeReplacement({
      previousHeldLaunchGrant: true,
      consentChange: false,
      ...keep.options,
    }),
    "keep",
  );
  assert.deepEqual(keep.calls, ["fence", ["error", "fence"], ["ask", null], "resume"]);

  const stop = replacementProbe({ fenceError: new Error("controller unreachable"), stop: true });
  assert.equal(
    await confirmDesktopRuntimeReplacement({
      previousHeldLaunchGrant: false,
      consentChange: true,
      ...stop.options,
    }),
    "replace",
  );
  assert.deepEqual(stop.calls, ["fence", ["error", "fence"], ["ask", null]]);
});

test("a start's launch grants are for its bound user, never for a Personal Browser start", () => {
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(
    resolveDesktopRuntimeLaunchGrantUserId({ enablePersonalBrowser: false, boundUserId: userId }),
    userId,
  );
  assert.equal(
    resolveDesktopRuntimeLaunchGrantUserId({ enablePersonalBrowser: true, boundUserId: userId }),
    null,
  );
  assert.equal(
    resolveDesktopRuntimeLaunchGrantUserId({ enablePersonalBrowser: false, boundUserId: null }),
    null,
  );
});

test("a consent change's replacement starts with its bound user's current token, else the retained one", () => {
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const restartOptions = {
    projectId: "space-1",
    controllerUrl: "https://controller.example",
    // What the runtime started with, or what a fence's 401 refreshed it to.
    controllerAccessToken: "retained-token",
  };
  const build = (currentSession, launchGrantUserId = userId) =>
    buildConsentChangeRestartOptions({ restartOptions, launchGrantUserId, currentSession });

  assert.deepEqual(build({ accessToken: "current-token", userId: userId.toUpperCase() }), {
    ...restartOptions,
    controllerAccessToken: "current-token",
  });
  // Another user's session never starts it.
  assert.equal(
    build({ accessToken: "other-token", userId: otherUserId }).controllerAccessToken,
    "retained-token",
  );
  // No session, or no token: the retained one.
  assert.equal(build(null).controllerAccessToken, "retained-token");
  assert.equal(build({ accessToken: " ", userId }).controllerAccessToken, "retained-token");
  // A runtime bound to nobody keeps its own token.
  assert.equal(
    build({ accessToken: "current-token", userId }, null).controllerAccessToken,
    "retained-token",
  );
  // The replaced runtime's own options are left as they were.
  assert.equal(restartOptions.controllerAccessToken, "retained-token");
  assert.notEqual(build(null), restartOptions);
});
