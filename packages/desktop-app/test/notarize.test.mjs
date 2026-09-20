import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { isTransientNotarizationFailure, notarizeWithRetry } =
  require("../scripts/notarize.cjs");

test("the real failure from run 30822804681 is classified transient", () => {
  const real = new Error(
    'HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 ' +
      '"The Internet connection appears to be offline.")',
  );
  assert.equal(isTransientNotarizationFailure(real), true);
});

test("a rejected submission is NOT retried", () => {
  assert.equal(
    isTransientNotarizationFailure(new Error("Package Invalid: The binary is not signed.")),
    false,
  );
  assert.equal(
    isTransientNotarizationFailure(new Error("Unable to authenticate: invalid credentials")),
    false,
  );
});

test("notarization HTTP retries require an explicit status code in the message", () => {
  for (const status of [502, 503, 504]) {
    for (const message of [
      `HTTP ${status}`,
      `HTTP/1.1 ${status} upstream unavailable`,
      `HTTP status code: ${status}`,
      `Request failed with status code ${status}`,
      `Failed to notarize via notarytool\nHTTPError(statusCode: ${status}, error: nil)`,
      `Failed to notarize via notarytool\nHTTPError(statusCode: Optional(${status}), error: nil)`,
    ]) {
      assert.equal(isTransientNotarizationFailure(new Error(message)), true, message);
    }
    for (const message of [
      "Package Invalid: unsigned binary",
      `Package Invalid: /tmp/fixture${status}/app.app`,
      `Package Invalid: C:\\fixture${status}\\app.app`,
      `Package Invalid: submission-id-${status}-rejected`,
      `Package Invalid: /tmp/status-code-${status}/app.app`,
      `Package Invalid: /tmp/HTTP ${status}/app.app`,
      `Package Invalid: /tmp/status code: ${status}/app.app`,
      `notarytool exited with code ${status}`,
      `notarytool exit status ${status}`,
      `HTTP ${status}0`,
      `HTTP 1${status}`,
      `status code: ${status}-submission-id`,
      `status code: ${status}_submission_id`,
      `status code: ${status}.json`,
    ]) {
      assert.equal(isTransientNotarizationFailure(new Error(message)), false, message);
    }
  }
  for (const message of [
    "Unable to authenticate: invalid credentials; HTTP 401",
    "Package Invalid: HTTP 400",
    "HTTPError(statusCode: Optional(403), error: nil)",
  ]) {
    assert.equal(isTransientNotarizationFailure(new Error(message)), false, message);
  }
  for (const message of [
    "Bad Gateway", "Service Unavailable", "Gateway Timeout", "Gateway Time-out",
    "network is unreachable", "network down", "request timed out", "request timeout",
    "read ECONNRESET", "connect ETIMEDOUT", "getaddrinfo ENOTFOUND",
    "getaddrinfo EAI_AGAIN", "socket hang up",
  ]) {
    assert.equal(isTransientNotarizationFailure(new Error(message)), true, message);
  }
});

test("notarization retry classification ignores stack paths and line numbers", () => {
  for (const status of [502, 503, 504]) {
    const rejection = new Error("Package Invalid: unsigned binary");
    rejection.stack = `${rejection.message}\n` +
      `    at fixture (/tmp/lease-inert-${status}-fixture/test.mjs:${status}:${status})\n` +
      "    at networkTimeout (/tmp/HTTP503/notarize.test.mjs:1:1)";
    assert.equal(isTransientNotarizationFailure(rejection), false);
  }
});

test("a rejected submission with numeric fixture paths is attempted exactly once", async (t) => {
  const priorAttempts = process.env.NOTARIZE_ATTEMPTS;
  process.env.NOTARIZE_ATTEMPTS = "3";
  t.after(() => {
    if (priorAttempts === undefined) delete process.env.NOTARIZE_ATTEMPTS;
    else process.env.NOTARIZE_ATTEMPTS = priorAttempts;
  });
  for (const status of [502, 503, 504]) {
    const rejection = new Error(`Package Invalid: /tmp/fixture${status}/unsigned.app`);
    rejection.stack = `${rejection.message}\n    at fixture (/tmp/lease${status}/test.mjs:${status}:1)`;
    let calls = 0;
    await assert.rejects(notarizeWithRetry({
      appPath: "/tmp/inert-notarize-test.app", appleId: "inert", appleIdPassword: "inert", teamId: "inert",
      notarize: async () => { calls += 1; throw rejection; },
    }), (error) => error === rejection);
    assert.equal(calls, 1, "an invalid bundle must not retry because a fixture path contains an HTTP status number");
  }
});

test("retries a transport failure then succeeds", async () => {
  let calls = 0;
  process.env.NOTARIZE_ATTEMPTS = "2";
  await notarizeWithRetry({
    appPath: "/tmp/x.app", appleId: "a", appleIdPassword: "b", teamId: "c",
    notarize: async () => {
      calls += 1;
      if (calls === 1) throw new Error("Error Domain=NSURLErrorDomain Code=-1009 offline");
    },
  });
  assert.equal(calls, 2, "should have retried exactly once");
});

test("a non-transient failure fails on the first attempt", async () => {
  let calls = 0;
  process.env.NOTARIZE_ATTEMPTS = "3";
  await assert.rejects(
    notarizeWithRetry({
      appPath: "/tmp/x.app", appleId: "a", appleIdPassword: "b", teamId: "c",
      notarize: async () => { calls += 1; throw new Error("Package Invalid"); },
    }),
    /Package Invalid/u,
  );
  assert.equal(calls, 1, "must not retry a rejection");
});
