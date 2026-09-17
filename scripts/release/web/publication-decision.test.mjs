import assert from "node:assert/strict";
import test from "node:test";

import { decidePublication } from "./publication-decision.mjs";

const SOURCE = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const PREVIOUS = "0123456789abcdef0123456789abcdef01234567";
const RELEASE = "a".repeat(64);
const DEPLOYMENT = "11111111-2222-3333-4444-555555555555";
const facts = (overrides = {}) => ({
  sourceSha: SOURCE,
  releaseId: RELEASE,
  servedReleaseId: "b".repeat(64),
  previousDeploymentId: DEPLOYMENT,
  previousCommitHash: PREVIOUS,
  previousCompare: "ahead",
  ...overrides,
});

test("a newer commit deploys and records the deployment to restore", () => {
  assert.deepEqual(decidePublication(facts()), { action: "deploy", previousDeploymentId: DEPLOYMENT });
  assert.equal(decidePublication(facts({ previousCompare: "identical", previousCommitHash: SOURCE })).action, "deploy");
  assert.equal(decidePublication(facts({ previousCompare: "not-found" })).action, "deploy");
  assert.equal(decidePublication(facts({ previousCompare: "none", previousCommitHash: "" })).action, "deploy");
  assert.equal(decidePublication(facts({ servedReleaseId: "" })).action, "deploy");
});

test("an already served release is not redeployed", () => {
  assert.equal(decidePublication(facts({ servedReleaseId: RELEASE })).action, "already-serving");
  assert.equal(decidePublication(facts({ servedReleaseId: RELEASE, previousCompare: "behind" })).action, "already-serving");
});

test("a stale or unrelated commit is refused", () => {
  assert.throws(() => decidePublication(facts({ previousCompare: "behind" })), /stale publish/u);
  assert.throws(() => decidePublication(facts({ previousCompare: "diverged" })), /stale publish/u);
});

test("malformed facts fail closed", () => {
  assert.throws(() => decidePublication(facts({ sourceSha: "abc" })), /SOURCE_SHA/u);
  assert.throws(() => decidePublication(facts({ releaseId: "abc" })), /RELEASE_ID/u);
  assert.throws(() => decidePublication(facts({ previousDeploymentId: "" })), /production deployment/u);
  assert.throws(() => decidePublication(facts({ servedReleaseId: "xyz" })), /malformed release/u);
  assert.throws(() => decidePublication(facts({ previousCompare: "unknown" })), /comparison/u);
  assert.throws(() => decidePublication(facts({ previousCompare: "none" })), /commit hash/u);
  assert.throws(() => decidePublication(facts({ previousCommitHash: "" })), /commit hash/u);
});
