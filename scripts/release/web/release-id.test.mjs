import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { RELEASE_ID_PREFIX, computeHostedReleaseId, hostedBuildMetadata } from "./release-id.mjs";

const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";

test("the release id is the v3 digest of exactly the public release commit", () => {
  assert.equal(RELEASE_ID_PREFIX, "instafy-hosted-frontend:v3");
  assert.equal(computeHostedReleaseId(SHA), createHash("sha256").update(`instafy-hosted-frontend:v3:${SHA}`).digest("hex"));
  assert.notEqual(computeHostedReleaseId(SHA), computeHostedReleaseId("0".repeat(40)));
  assert.deepEqual(Object.keys(hostedBuildMetadata(SHA)), ["schemaVersion", "releaseId"]);
  assert.equal(hostedBuildMetadata(SHA).schemaVersion, 2);
});

test("anything but a full lowercase sha is refused", () => {
  for (const bad of [undefined, "", SHA.toUpperCase(), SHA.slice(0, 12), `${SHA}0`]) {
    assert.throws(() => computeHostedReleaseId(bad), /40-character/u);
  }
});
