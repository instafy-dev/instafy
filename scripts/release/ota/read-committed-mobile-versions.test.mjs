import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseCommittedMobileVersions, readCommittedMobileVersions } from "./read-committed-mobile-versions.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const pbxproj = (marketing = "1.0", build = "81", extra = "") => `
\t\t\t\tCURRENT_PROJECT_VERSION = ${build};
\t\t\t\tMARKETING_VERSION = ${marketing};
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = dev.instafy.studio;
\t\t\t\tCURRENT_PROJECT_VERSION = ${build};
\t\t\t\tMARKETING_VERSION = ${marketing};
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = dev.instafy.studio.uitests;
${extra}`;

const gradle = ({ code = "260860839", name = "1.0", appId = "dev.instafy.studio", extra = "" } = {}) => `
def versionNameOverride = envOrNull("ANDROID_VERSION_NAME")
def resolvedVersionCode = ${code}
def resolvedVersionName = versionNameOverride ?: "${name}"
android {
    defaultConfig {
        applicationId "${appId}"
        versionCode resolvedVersionCode
        versionName resolvedVersionName
${extra}
    }
}
`;

test("reads the committed native tuple of the release source", () => {
  assert.deepEqual(parseCommittedMobileVersions({ pbxproj: pbxproj(), gradle: gradle() }), {
    ios: { marketingVersion: "1.0", buildNumber: "81" },
    android: { versionName: "1.0", versionCode: "260860839" },
  });
});

test("the checked-out public core parses", () => {
  const versions = readCommittedMobileVersions(repositoryRoot);
  assert.match(versions.ios.buildNumber, /^[1-9][0-9]*$/u);
  assert.match(versions.android.versionCode, /^[1-9][0-9]{0,9}$/u);
});

test("inconsistent or unsafe iOS values fail closed", () => {
  assert.throws(
    () => parseCommittedMobileVersions({ pbxproj: pbxproj("1.0", "81", "\t\tCURRENT_PROJECT_VERSION = 82;"), gradle: gradle() }),
    /CURRENT_PROJECT_VERSION must have one consistent/u,
  );
  assert.throws(
    () => parseCommittedMobileVersions({ pbxproj: pbxproj("1.0", "81", "\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.app;"), gradle: gradle() }),
    /application identity/u,
  );
  assert.throws(() => parseCommittedMobileVersions({ pbxproj: pbxproj("$(inherited)", "81"), gradle: gradle() }), /unsupported shape/u);
  assert.throws(() => parseCommittedMobileVersions({ pbxproj: "", gradle: gradle() }), /MARKETING_VERSION/u);
});

test("Android identity and single consumption are enforced", () => {
  const parse = (options) => parseCommittedMobileVersions({ pbxproj: pbxproj(), gradle: gradle(options) });
  assert.throws(() => parse({ appId: "com.example.app" }), /application identity/u);
  assert.throws(() => parse({ extra: "        versionCode 5" }), /exactly once/u);
  assert.throws(() => parse({ extra: "def resolvedVersionCode = 7" }), /exactly once/u);
  assert.throws(() => parse({ name: "1.0 beta" }), /unsupported shape/u);
});
