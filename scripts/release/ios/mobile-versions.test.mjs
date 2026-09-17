import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseIosVersions, readIosVersions } from "./mobile-versions.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function project({ marketing = ["1.0", "1.0"], build = ["81", "81"], bundles = ["dev.instafy.studio", "dev.instafy.studio.uitests"] } = {}) {
  return [
    ...marketing.map((value) => `\t\t\t\tMARKETING_VERSION = ${value};`),
    ...build.map((value) => `\t\t\t\tCURRENT_PROJECT_VERSION = ${value};`),
    ...bundles.map((value) => `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${value};`),
  ].join("\n");
}

test("reads the committed iOS version tuple of this checkout", () => {
  const versions = readIosVersions(repositoryRoot);
  assert.match(versions.name, /^[0-9]+(?:\.[0-9]+){1,3}$/u);
  assert.match(versions.code, /^[1-9][0-9]*$/u);
  const text = fs.readFileSync(path.join(repositoryRoot, "packages/frontend/ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  assert.deepEqual(parseIosVersions(text), versions);
});

test("parses one consistent version and keeps the app identity", () => {
  assert.deepEqual(parseIosVersions(project()), { name: "1.0", code: "81" });
  assert.deepEqual(parseIosVersions(project({ marketing: ["1.2.3"], build: ["260860839"] })), { name: "1.2.3", code: "260860839" });
});

test("rejects drift, malformed values and foreign bundle identifiers", () => {
  assert.throws(() => parseIosVersions(project({ marketing: ["1.0", "1.1"] })), /MARKETING_VERSION must have one consistent/u);
  assert.throws(() => parseIosVersions(project({ build: ["81", "82"] })), /CURRENT_PROJECT_VERSION must have one consistent/u);
  assert.throws(() => parseIosVersions(project({ build: [] })), /CURRENT_PROJECT_VERSION/u);
  assert.throws(() => parseIosVersions(project({ build: ["081"] })), /positive integer/u);
  assert.throws(() => parseIosVersions(project({ build: ["$(BUILD)"] })), /positive integer/u);
  assert.throws(() => parseIosVersions(project({ marketing: ["1"] })), /dotted numeric/u);
  assert.throws(() => parseIosVersions(project({ bundles: ["dev.instafy.other"] })), /identity/u);
  assert.throws(() => parseIosVersions(project({ bundles: ["dev.instafy.studio", "dev.example.app"] })), /identity/u);
});
