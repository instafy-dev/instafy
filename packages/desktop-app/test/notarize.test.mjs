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
