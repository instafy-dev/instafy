import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function loadNotarize(env) {
  for (const key of Object.keys(env)) process.env[key] = env[key];
  delete require.cache[require.resolve("../scripts/notarize.cjs")];
  return require("../scripts/notarize.cjs");
}

const CREDS = { appPath: "/tmp/x.app", appleId: "a@b.c", appleIdPassword: "p", teamId: "T" };

test("electron-builder's own notarization pass is disabled", () => {
  // app-builder-lib notarizes inside signApp (macPackager.js:318), BEFORE the
  // afterSign hook runs, and enables itself purely from APPLE_ID +
  // APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID being present. Leaving it on
  // notarizes the bundle twice, and that first pass is not the one this file
  // wraps -- it uses app-builder-lib's own bundled @electron/notarize, so it
  // has no logging, no retry and no timeout. Run 30839030282 spent 1h58m in it.
  const build = require("../package.json").build;
  assert.equal(
    build.mac.notarize,
    false,
    "build.mac.notarize must be false, or electron-builder notarizes a second time unbounded",
  );
});

test("a hung attempt is bounded and retried rather than hanging forever", async () => {
  const { notarizeWithRetry } = loadNotarize({
    NOTARIZE_ATTEMPT_TIMEOUT_MS: "40",
    NOTARIZE_TOTAL_TIMEOUT_MS: "5000",
    NOTARIZE_ATTEMPTS: "2",
    NOTARIZE_BACKOFF_MS: "10",
  });
  let calls = 0;
  const notarize = () => {
    calls += 1;
    // Second attempt succeeds; the first never settles, as a stuck poll does.
    return calls === 1 ? new Promise(() => {}) : Promise.resolve();
  };
  await notarizeWithRetry({ ...CREDS, notarize });
  assert.equal(calls, 2, "the hung attempt must time out and a retry must follow");
});

test("the total budget is enforced across attempts", async () => {
  const { notarizeWithRetry } = loadNotarize({
    NOTARIZE_ATTEMPT_TIMEOUT_MS: "10000",
    NOTARIZE_TOTAL_TIMEOUT_MS: "120",
    NOTARIZE_ATTEMPTS: "5",
    NOTARIZE_BACKOFF_MS: "10",
  });
  let calls = 0;
  const startedAt = Date.now();
  await assert.rejects(
    notarizeWithRetry({ ...CREDS, notarize: () => { calls += 1; return new Promise(() => {}); } }),
    /timed out|exhausted/i,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5000, `must abandon inside the budget, took ${elapsed}ms`);
  assert.ok(calls < 5, `must stop before exhausting attempts, made ${calls}`);
});

test("a rejected submission still fails immediately", async () => {
  const { notarizeWithRetry } = loadNotarize({
    NOTARIZE_ATTEMPT_TIMEOUT_MS: "10000",
    NOTARIZE_TOTAL_TIMEOUT_MS: "10000",
    NOTARIZE_ATTEMPTS: "3",
    NOTARIZE_BACKOFF_MS: "10",
  });
  let calls = 0;
  await assert.rejects(
    notarizeWithRetry({
      ...CREDS,
      notarize: () => { calls += 1; return Promise.reject(new Error("Package Invalid: unsigned binary")); },
    }),
    /Package Invalid/,
  );
  assert.equal(calls, 1, "a real rejection must not be retried");
});

test("the deadline fires even when nothing else keeps the loop alive", async () => {
  // The regression this guards: an unref'd timer does not hold the event loop
  // open, so the deadline only fires if some other pending work happens to keep
  // the process running. That masks itself on any busy machine -- it passed
  // locally and failed only in CI -- so assert it in a child process where the
  // timer is the sole pending handle. If it is unref'd, the child exits 0
  // having silently skipped the timeout instead of rejecting.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = `
    const { withTimeout } = require(${JSON.stringify(path.join(packageRoot, "scripts", "notarize.cjs"))});
    withTimeout(new Promise(() => {}), 50, "probe").then(
      () => { console.log("RESOLVED"); },
      (error) => { console.log(/timed out/.test(error.message) ? "TIMED_OUT" : "OTHER"); },
    );
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", script], { timeout: 10_000 });
  assert.equal(
    stdout.trim(),
    "TIMED_OUT",
    "the deadline must fire with no other pending work; an unref'd timer prints nothing",
  );
});
