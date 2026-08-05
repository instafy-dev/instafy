import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const build = require("../package.json").build;

// Assert what the patterns actually match, not merely that the strings are
// present -- a glob that excludes nothing would pass a presence check. Node's
// built-in matcher keeps this dependency-free.
import path from "node:path";

function excluded(filePath) {
  return build.files
    .filter((pattern) => typeof pattern === "string" && pattern.startsWith("!"))
    .some((pattern) => path.matchesGlob(filePath, pattern.slice(1)));
}

test("a dependency's test files never reach the shipped app", () => {
  // zod ships its TypeScript sources in the npm tarball, tests included, and one
  // of those tests contains the canonical jwt.io sample token. That token is
  // harmless -- its HMAC key is published on jwt.io's front page -- but it
  // tripped the fail-closed secret scan on the release artifact and blocked the
  // build, which is the same cost as a real leak.
  assert.ok(
    excluded("node_modules/zod/src/v4/mini/tests/string.test.ts"),
    "dependency .test.ts files must be excluded from the package",
  );
  assert.ok(
    excluded("node_modules/some-pkg/tests/fixtures/creds.json"),
    "dependency tests/ directories must be excluded from the package",
  );
});

test("excluding tests does not strip a dependency's runtime entry points", () => {
  // The exclusion is worthless if it also removes the code the app runs.
  for (const runtimeFile of [
    "node_modules/zod/index.cjs",
    "node_modules/zod/index.js",
    "node_modules/zod/package.json",
    "node_modules/zod/v4/mini/index.js",
    "node_modules/zod/src/index.ts",
  ]) {
    assert.equal(excluded(runtimeFile), false, `${runtimeFile} must still ship`);
  }
});

test("the app's own source is unaffected", () => {
  // These patterns are scoped to node_modules on purpose; a broader glob would
  // silently drop first-party files that happen to be named alike.
  assert.equal(excluded("dist/main.js"), false);
  assert.equal(excluded("dist/native/agent.node"), false);
});
