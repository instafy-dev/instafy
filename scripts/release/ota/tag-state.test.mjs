import assert from "node:assert/strict";
import test from "node:test";

import { assertUnpublished, readTagState } from "./tag-state.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const TAG_OBJECT = "1111111111111111111111111111111111111111";
const TAG = "ota-v8ddffed21d44";

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

const base = `repos/instafy-dev/instafy`;

test("a lightweight tag on main with no release is unpublished", () => {
  const { gh, calls } = fakeGh({
    [`${base}/git/ref/tags/${TAG}`]: { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } },
    [`${base}/compare/${SHA}...main`]: { status: "ahead" },
  });
  const state = readTagState({ tag: TAG, gh });
  assert.deepEqual(state, { tagSha: SHA, compareStatus: "ahead", releaseExists: false });
  assert.equal(assertUnpublished(state, SHA), true);
  assert.deepEqual(calls, [`${base}/git/ref/tags/${TAG}`, `${base}/compare/${SHA}...main`, `${base}/releases/tags/${TAG}`]);
});

test("annotated tags are peeled to their commit", () => {
  const { gh } = fakeGh({
    [`${base}/git/ref/tags/${TAG}`]: { ref: `refs/tags/${TAG}`, object: { type: "tag", sha: TAG_OBJECT } },
    [`${base}/git/tags/${TAG_OBJECT}`]: { object: { type: "commit", sha: SHA } },
    [`${base}/compare/${SHA}...main`]: { status: "identical" },
  });
  assert.equal(readTagState({ tag: TAG, gh }).tagSha, SHA);
});

test("moved tags, left main, existing releases and lookup errors fail closed", () => {
  const ref = { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: SHA } };
  assert.throws(() => assertUnpublished({ tagSha: null, compareStatus: null, releaseExists: false }, SHA), /no longer resolves/u);
  assert.throws(() => assertUnpublished({ tagSha: SHA, compareStatus: "diverged", releaseExists: false }, SHA), /protected main/u);
  assert.throws(() => assertUnpublished({ tagSha: SHA, compareStatus: "ahead", releaseExists: true }, SHA), /one-shot/u);
  assert.throws(() => readTagState({ tag: TAG, gh: fakeGh({ [`${base}/git/ref/tags/${TAG}`]: "error" }).gh }), /tag lookup failed/u);
  assert.throws(
    () => readTagState({
      tag: TAG,
      gh: fakeGh({
        [`${base}/git/ref/tags/${TAG}`]: ref,
        [`${base}/compare/${SHA}...main`]: { status: "ahead" },
        [`${base}/releases/tags/${TAG}`]: "error",
      }).gh,
    }),
    /release lookup failed/u,
  );
  assert.throws(() => readTagState({ tag: "desktop-app-v1.0.0", gh: () => assert.fail("no lookup") }), /Invalid OTA tag/u);
  assert.throws(
    () => readTagState({ tag: TAG, gh: fakeGh({ [`${base}/git/ref/tags/${TAG}`]: { ref: "refs/tags/other", object: ref.object } }).gh }),
    /different tag ref/u,
  );
});
