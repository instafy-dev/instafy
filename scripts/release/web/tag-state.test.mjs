import assert from "node:assert/strict";
import test from "node:test";

import { assertBound, readTagState } from "./tag-state.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const TAG_OBJECT = "1111111111111111111111111111111111111111";
const TAG = "web-v8ddffed21d44";
const base = "repos/instafy-dev/instafy";

function fakeGh(routes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args[0]);
    const route = routes[args[0]];
    if (route === undefined) return { status: 1, stdout: "", notFound: true };
    if (route === "error") return { status: 1, stdout: "", notFound: false };
    return { status: 0, stdout: JSON.stringify(route), notFound: false };
  };
  return { gh, calls };
}

test("a lightweight tag on main still binds its commit", () => {
  const { gh, calls } = fakeGh({
    [`${base}/git/ref/tags/${TAG}`]: { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } },
    [`${base}/compare/${SHA}...main`]: { status: "ahead" },
  });
  const state = readTagState({ tag: TAG, gh });
  assert.deepEqual(state, { tagSha: SHA, compareStatus: "ahead" });
  assert.equal(assertBound(state, SHA), true);
  assert.deepEqual(calls, [`${base}/git/ref/tags/${TAG}`, `${base}/compare/${SHA}...main`]);
});

test("annotated and retry tags are peeled to their commit", () => {
  const retry = `${TAG}-r3`;
  const { gh } = fakeGh({
    [`${base}/git/ref/tags/${retry}`]: { ref: `refs/tags/${retry}`, object: { type: "tag", sha: TAG_OBJECT } },
    [`${base}/git/tags/${TAG_OBJECT}`]: { object: { type: "commit", sha: SHA } },
    [`${base}/compare/${SHA}...main`]: { status: "identical" },
  });
  assert.equal(readTagState({ tag: retry, gh }).tagSha, SHA);
});

test("moved tags, commits that left main and lookup errors fail closed", () => {
  const ref = { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } };
  assert.throws(() => assertBound({ tagSha: TAG_OBJECT, compareStatus: "ahead" }, SHA), /no longer resolves/u);
  assert.throws(() => assertBound({ tagSha: SHA, compareStatus: "diverged" }, SHA), /protected main/u);
  assert.throws(() => readTagState({ tag: TAG, gh: fakeGh({ [`${base}/git/ref/tags/${TAG}`]: "error" }).gh }), /lookup failed: tag/u);
  assert.throws(() => readTagState({ tag: TAG, gh: fakeGh({}).gh }), /lookup failed: tag/u);
  assert.throws(() => readTagState({ tag: "ota-v8ddffed21d44", gh: () => assert.fail("no lookup") }), /Invalid hosted web tag/u);
  assert.throws(
    () => readTagState({ tag: TAG, gh: fakeGh({ [`${base}/git/ref/tags/${TAG}`]: { ref: "refs/tags/other", object: ref.object } }).gh }),
    /different tag ref/u,
  );
});
