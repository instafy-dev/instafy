import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  findAppReleaseConfiguration,
  planSigningBinding,
  verifyResolvedBuildSettings,
  verifySignedProject,
} from "./bind-signing.mjs";

const RELEASE_ID = "504EC3181FED79650016851F";
const INPUTS = {
  scheme: "App",
  bundleId: "dev.instafy.studio",
  team: "ABCDE12345",
  certSha1: "c".repeat(40),
  keychain: "/tmp/runner/instafy-ios-signing.keychain-db",
  profileUuid: "11111111-2222-3333-4444-555555555555",
};

function fixtureProject() {
  const settings = (overrides = {}) => ({
    CODE_SIGN_ENTITLEMENTS: "App/App.release.entitlements",
    CODE_SIGN_STYLE: "Automatic",
    CURRENT_PROJECT_VERSION: "81",
    DEVELOPMENT_TEAM: "",
    MARKETING_VERSION: "1.0",
    PRODUCT_BUNDLE_IDENTIFIER: "dev.instafy.studio",
    ...overrides,
  });
  return {
    objects: {
      "504EC3031FED79650016851F": { isa: "PBXNativeTarget", name: "App", productType: "com.apple.product-type.application", buildConfigurationList: "LIST0000000000000000APP0" },
      "UITESTS00000000000000000": { isa: "PBXNativeTarget", name: "AppUITests", productType: "com.apple.product-type.bundle.ui-testing", buildConfigurationList: "LIST0000000000000000UIT0" },
      LIST0000000000000000APP0: { isa: "XCConfigurationList", buildConfigurations: ["504EC3171FED79650016851F", RELEASE_ID] },
      LIST0000000000000000UIT0: { isa: "XCConfigurationList", buildConfigurations: ["AAAAAAAAAAAAAAAAAAAAAAAA"] },
      "504EC3171FED79650016851F": { isa: "XCBuildConfiguration", name: "Debug", buildSettings: settings({ CODE_SIGN_ENTITLEMENTS: "App/App.debug.entitlements" }) },
      [RELEASE_ID]: { isa: "XCBuildConfiguration", name: "Release", buildSettings: settings() },
      AAAAAAAAAAAAAAAAAAAAAAAA: { isa: "XCBuildConfiguration", name: "Release", buildSettings: settings({ PRODUCT_BUNDLE_IDENTIFIER: "dev.instafy.studio.uitests" }) },
    },
  };
}

// Apply a PlistBuddy command plan to a JSON project (test double for PlistBuddy).
function applyPlan(project, commands) {
  const next = structuredClone(project);
  for (const command of commands) {
    const match = /^(Set|Add) :objects:([A-F0-9]{24}):buildSettings:([A-Z_]+) (?:string )?(.+)$/u.exec(command);
    assert.ok(match, command);
    const settings = next.objects[match[2]].buildSettings;
    if (match[1] === "Add") assert.equal(Object.hasOwn(settings, match[3]), false);
    else assert.equal(Object.hasOwn(settings, match[3]), true);
    settings[match[3]] = match[4];
  }
  return next;
}

test("plans the five PlistBuddy edits for only the App Release configuration", () => {
  const project = fixtureProject();
  const plan = planSigningBinding(project, INPUTS);
  assert.equal(plan.configurationId, RELEASE_ID);
  assert.deepEqual(plan.commands, [
    `Set :objects:${RELEASE_ID}:buildSettings:CODE_SIGN_STYLE Manual`,
    `Set :objects:${RELEASE_ID}:buildSettings:DEVELOPMENT_TEAM ABCDE12345`,
    `Add :objects:${RELEASE_ID}:buildSettings:CODE_SIGN_IDENTITY string ${"c".repeat(40)}`,
    `Add :objects:${RELEASE_ID}:buildSettings:OTHER_CODE_SIGN_FLAGS string --keychain /tmp/runner/instafy-ios-signing.keychain-db`,
    `Add :objects:${RELEASE_ID}:buildSettings:PROVISIONING_PROFILE_SPECIFIER string 11111111-2222-3333-4444-555555555555`,
  ]);
  const signed = applyPlan(project, plan.commands);
  assert.equal(verifySignedProject(project, signed, RELEASE_ID, INPUTS), true);
  const drift = structuredClone(signed);
  drift.objects["504EC3171FED79650016851F"].buildSettings.CODE_SIGN_STYLE = "Manual";
  assert.throws(() => verifySignedProject(project, drift, RELEASE_ID, INPUTS), /project-semantic-diff/u);
});

test("refuses unexpected preconditions and invalid inputs", () => {
  const mutate = (fn) => { const project = fixtureProject(); fn(project.objects[RELEASE_ID].buildSettings, project); return project; };
  const cases = [
    [mutate((s) => { s.CODE_SIGN_STYLE = "Manual"; }), /unexpected-app-release-signing-state/u],
    [mutate((s) => { s.DEVELOPMENT_TEAM = "ZZZZZ99999"; }), /unexpected-app-release-signing-state/u],
    [mutate((s) => { s.CODE_SIGN_IDENTITY = "x"; }), /unexpected-app-release-signing-state/u],
    [mutate((s) => { s.CODE_SIGN_ENTITLEMENTS = "App/App.debug.entitlements"; }), /unexpected-app-release-signing-state/u],
    [mutate((s) => { s.PRODUCT_BUNDLE_IDENTIFIER = "dev.instafy.other"; }), /unexpected-app-release-signing-state/u],
    [mutate((_s, p) => { p.objects.DUPLICATE0000000000000000 = { ...p.objects["504EC3031FED79650016851F"] }; }), /app-target/u],
  ];
  for (const [project, expected] of cases) assert.throws(() => planSigningBinding(project, INPUTS), expected);
  assert.throws(() => planSigningBinding(fixtureProject(), { ...INPUTS, team: "bad" }), /team/u);
  assert.throws(() => planSigningBinding(fixtureProject(), { ...INPUTS, keychain: "/tmp/login.keychain-db" }), /keychain/u);
  assert.throws(() => planSigningBinding(fixtureProject(), { ...INPUTS, certSha1: "C".repeat(40) }), /certificate/u);
});

test("resolved xcodebuild settings must name the exact manual signing authority", () => {
  const resolved = [{
    target: "App",
    buildSettings: {
      CODE_SIGN_STYLE: "Manual",
      DEVELOPMENT_TEAM: INPUTS.team,
      PRODUCT_BUNDLE_IDENTIFIER: INPUTS.bundleId,
      CODE_SIGN_IDENTITY: INPUTS.certSha1,
      PROVISIONING_PROFILE_SPECIFIER: INPUTS.profileUuid,
      OTHER_CODE_SIGN_FLAGS: `--keychain ${INPUTS.keychain}`,
    },
  }];
  assert.equal(verifyResolvedBuildSettings(resolved, INPUTS), true);
  const withLegacyProfile = structuredClone(resolved);
  withLegacyProfile[0].buildSettings.PROVISIONING_PROFILE = "legacy";
  assert.throws(() => verifyResolvedBuildSettings(withLegacyProfile, INPUTS), /resolved-build-settings/u);
  assert.throws(() => verifyResolvedBuildSettings([...resolved, ...resolved], INPUTS), /resolved-build-settings/u);
});

test("the committed pbxproj satisfies the preconditions (macOS plutil only)", { skip: process.platform !== "darwin" }, () => {
  const file = path.resolve(import.meta.dirname, "../../../packages/frontend/ios/App/App.xcodeproj/project.pbxproj");
  const project = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
  assert.equal(findAppReleaseConfiguration(project, INPUTS), RELEASE_ID);
  assert.ok(fs.statSync(file).isFile());
});
