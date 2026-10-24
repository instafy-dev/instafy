import assert from "node:assert/strict";
import test from "node:test";

import {
  combineReleaseBumps,
  isReleaseRelevantPath,
  parseChangesetReleases,
} from "./check-changeset-pr.mjs";

test("parses package bumps and requires a non-empty summary", () => {
  assert.deepEqual(
    parseChangesetReleases(`---\n"@instafy/cli": minor\n---\n\nA breaking customer CLI change.\n`),
    [{ name: "@instafy/cli", bump: "minor" }],
  );
  assert.throws(
    () => parseChangesetReleases(`---\n"@instafy/cli": patch\n---\n\n`),
    /summary must not be empty/u,
  );
});

test("requires release intent for package bytes but not package-only tests", () => {
  assert.equal(isReleaseRelevantPath("packages/instafy-cli/src/index.ts"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-cli/README.md"), true);
  assert.equal(isReleaseRelevantPath("packages/provider-contract/provider-core.js"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-cli/test/package-artifact.test.mjs"), false);
  assert.equal(isReleaseRelevantPath("packages/provider-contract/test/contracts.test.mjs"), false);
  assert.equal(isReleaseRelevantPath("docs/CLI.md"), false);
  // the binder ships inside the CLI (dist/bind): its code is the CLI's code, its tests and examples are not
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/src/server.mjs"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/client/bind-client.js"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/bin/instafy-bind.mjs"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/LICENSE"), true);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/README.md"), false);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/tests/server.test.mjs"), false);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind/examples/hello/index.html"), false);
  assert.equal(isReleaseRelevantPath("packages/instafy-bind-other/src/x.mjs"), false);
});

test("combines multiple changesets using the highest SemVer bump", () => {
  const combined = combineReleaseBumps([
    { releases: [{ name: "@instafy/cli", bump: "patch" }] },
    { releases: [{ name: "@instafy/cli", bump: "minor" }] },
    { releases: [{ name: "@instafy/provider-contract", bump: "patch" }] },
  ]);
  assert.deepEqual([...combined], [
    ["@instafy/cli", "minor"],
    ["@instafy/provider-contract", "patch"],
  ]);
});

test("rejects changesets for unapproved public packages", () => {
  assert.throws(
    () => combineReleaseBumps([{ releases: [{ name: "@instafy/unknown", bump: "patch" }] }]),
    /unapproved package/u,
  );
});
