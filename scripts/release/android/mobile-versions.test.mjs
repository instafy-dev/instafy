import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ANDROID_BUILD_GRADLE,
  assertVersionCode,
  readCommittedAndroidVersion,
  readCommittedAndroidVersionFromRoot,
} from "./mobile-versions.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const committed = fs.readFileSync(path.join(repositoryRoot, ANDROID_BUILD_GRADLE), "utf8");

test("reads the committed Android identity from the real build.gradle", () => {
  const version = readCommittedAndroidVersionFromRoot(repositoryRoot);
  assert.equal(version.applicationId, "dev.instafy.studio");
  assert.match(version.versionName, /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u);
  assert.match(version.versionCode, /^[1-9][0-9]{0,9}$/u);
  assert.deepEqual(readCommittedAndroidVersion(committed), version);
});

test("CLI prints the exact committed tuple", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "mobile-versions.mjs"), repositoryRoot],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), readCommittedAndroidVersion(committed));
});

test("fails closed on ambiguous or rebound version sources", () => {
  const cases = [
    ["duplicate versionCode default", committed.replace(
      /(def resolvedVersionCode = \d+)/u,
      "$1\ndef resolvedVersionCode = 7",
    ), /exactly one committed resolvedVersionCode/u],
    ["missing versionName default", committed.replace(
      /def resolvedVersionName = versionNameOverride \?: "[^"]+"/u,
      'def resolvedVersionName = "1.0"',
    ), /exactly one committed resolvedVersionName/u],
    ["foreign applicationId", committed.replace(
      'applicationId "dev.instafy.studio"',
      'applicationId "dev.example.other"',
    ), /applicationId must be exactly/u],
    ["second applicationId", committed.replace(
      'applicationId "dev.instafy.studio"',
      'applicationId "dev.instafy.studio"\n        applicationId "dev.instafy.studio"',
    ), /applicationId must be exactly/u],
    ["literal defaultConfig versionCode", committed.replace(
      "versionCode resolvedVersionCode",
      "versionCode 99",
    ), /must consume resolvedVersionCode/u],
    ["versionName consumed twice", committed.replace(
      "versionName resolvedVersionName",
      "versionName resolvedVersionName\n        versionName resolvedVersionName",
    ), /must consume resolvedVersionCode/u],
  ];
  for (const [name, source, error] of cases) {
    assert.notEqual(source, committed, `fixture did not change: ${name}`);
    assert.throws(() => readCommittedAndroidVersion(source), error, name);
  }
});

test("bounds versionCode to the Play limit", () => {
  assert.equal(assertVersionCode("2100000000"), "2100000000");
  assert.throws(() => assertVersionCode("2100000001"), /exceeds the Google Play bound/u);
  assert.throws(() => assertVersionCode("012"), /positive decimal/u);
  assert.throws(() => assertVersionCode(12), /positive decimal/u);
});
