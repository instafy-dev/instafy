import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const INSPECTOR = path.join(import.meta.dirname, "inspect-aab.py");
const SOURCE_SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const VERSION_NAME = "1.0";
const VERSION_CODE = "260860839";
// Product strings assembled at runtime: the OTA marker is the public frontend's
// build-time channel constant; the private product name must stay out of the
// public tree even in fixtures.
const OTA_MARKER_PREFIX = ["instafy", "native-ota-channel:"].join("-");
const PRIVATE_PRODUCT = ["k", "nosh"].join("");

const publicKeyPem = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString()
  .trim();
const TRUST_KEY_SHA256 = crypto.createHash("sha256").update(publicKeyPem).digest("hex");

// Builds a minimal but structurally faithful AAB: aapt2 protobuf manifest,
// JAR signature block, Capacitor assets and a hashed web bundle.
const BUILDER = String.raw`
import json, sys, zipfile

def varint(value):
    out = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        if value:
            out.append(byte | 128)
        else:
            out.append(byte)
            return bytes(out)

def field(number, payload):
    if isinstance(payload, int):
        return varint(number << 3) + varint(payload)
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return varint((number << 3) | 2) + varint(len(payload)) + payload

ANDROID = "http://schemas.android.com/apk/res/android"
out_path, options = sys.argv[1], json.loads(sys.argv[2])

def attribute(namespace, name, value, compiled=None):
    body = field(1, namespace) + field(2, name) + field(3, value)
    if compiled is not None:
        body += field(6, compiled)
    return field(4, body)

code = options["versionCode"]
manifest_element = field(3, "manifest")
manifest_element += attribute("", "package", options["package"])
manifest_element += attribute(ANDROID, "versionCode", code, field(7, field(6, int(code))))
manifest_element += attribute(ANDROID, "versionName", options["versionName"], field(2, field(1, options["versionName"])))
manifest_element += attribute(ANDROID, "minSdkVersion", "24")
for extra in options.get("extraAttributes", []):
    manifest_element += attribute(ANDROID, extra, "1")
manifest = field(1, manifest_element)

entries = {
    "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n",
    "META-INF/UPLOAD.RSA": "signature",
    "BundleConfig.pb": "config",
    "base/manifest/AndroidManifest.xml": manifest,
    "base/dex/classes.dex": "dex",
    "base/root/kotlin/internal/internal.kotlin_builtins": "builtins",
    "base/assets/capacitor.config.json": json.dumps(options["config"]),
    "base/assets/public/index.html": '<script type="module" src="/assets/index-a1.js"></script>',
    "base/assets/public/assets/index-a1.js": options["js"],
}
for name in options.get("omit", []):
    entries.pop(name)
entries.update(options.get("extra", {}))
with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for name, data in entries.items():
        archive.writestr(name, data)
`;

function baseOptions() {
  return {
    package: "dev.instafy.studio",
    versionCode: VERSION_CODE,
    versionName: VERSION_NAME,
    config: {
      appId: "dev.instafy.studio",
      plugins: {
        LiveUpdate: { autoUpdateStrategy: "none", defaultChannel: "internal", publicKey: publicKeyPem },
      },
    },
    js: `const channel="${OTA_MARKER_PREFIX}internal";const build="${SOURCE_SHA}";`,
  };
}

function withFixture(mutate, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-aab-"));
  try {
    const options = baseOptions();
    mutate(options);
    const aab = path.join(root, "app-release.aab");
    const built = spawnSync("python3", ["-c", BUILDER, aab, JSON.stringify(options)], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    return check(aab);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function inspect(aab, args = [TRUST_KEY_SHA256, VERSION_NAME, VERSION_CODE, SOURCE_SHA]) {
  return spawnSync("python3", [INSPECTOR, aab, ...args], { encoding: "utf8" });
}

test("attests channel, trust key, versions and digest from a faithful bundle", () => {
  withFixture(() => {}, (aab) => {
    const result = inspect(aab);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      applicationId: "dev.instafy.studio",
      versionName: VERSION_NAME,
      versionCode: VERSION_CODE,
      channel: "internal",
      trustKeySha256: TRUST_KEY_SHA256,
      nativeArtifactSha256: crypto.createHash("sha256").update(fs.readFileSync(aab)).digest("hex"),
      sourceSha: SOURCE_SHA,
    });
  });
});

test("fails closed with a fixed label for every contract violation", () => {
  const cases = [
    ["unsigned-bundle", (o) => { o.omit = ["META-INF/UPLOAD.RSA"]; }],
    ["credential-file", (o) => { o.extra = { "base/assets/public/.env.production": "X=1" }; }],
    ["credential-file", (o) => { o.extra = { "base/root/auth.json": "{}" }; }],
    ["private-marker", (o) => { o.extra = { "base/assets/public/internal/x.js": "" }; }],
    ["private-marker", (o) => { o.extra = { [`base/assets/${PRIVATE_PRODUCT}.json`]: "{}" }; }],
    ["private-marker", (o) => { o.extra = { "base/assets/composition-lock.json": "{}" }; }],
    ["manifest-package", (o) => { o.package = "dev.example.other"; }],
    ["manifest-version-code", (o) => { o.versionCode = "260860840"; }],
    ["manifest-version-name", (o) => { o.versionName = "1.1"; }],
    ["manifest-version-code-major", (o) => { o.extraAttributes = ["versionCodeMajor"]; }],
    ["capacitor-config-ambiguous", (o) => { o.extra = { "base/root/capacitor.config.json": "{}" }; }],
    ["live-update-channel", (o) => { o.config.plugins.LiveUpdate.defaultChannel = "stable"; }],
    ["live-update-strategy", (o) => { o.config.plugins.LiveUpdate.autoUpdateStrategy = "background"; }],
    ["live-update-public-key", (o) => { delete o.config.plugins.LiveUpdate.publicKey; }],
    ["live-update-trust-key", (o) => {
      o.config.plugins.LiveUpdate.publicKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
        .publicKey.export({ type: "spki", format: "pem" }).toString();
    }],
    ["capacitor-app-id", (o) => { o.config.appId = "dev.example.other"; }],
    ["web-ota-channel-marker", (o) => { o.js = `"${OTA_MARKER_PREFIX}stable";"${SOURCE_SHA}"`; }],
    ["web-ota-channel-marker", (o) => { o.js = `"${OTA_MARKER_PREFIX}internal";"${OTA_MARKER_PREFIX}beta";"${SOURCE_SHA}"`; }],
    ["web-source-commit", (o) => { o.js = `"${OTA_MARKER_PREFIX}internal"`; }],
    ["missing-entry", (o) => { o.omit = ["base/manifest/AndroidManifest.xml"]; }],
  ];
  for (const [label, mutate] of cases) {
    withFixture(mutate, (aab) => {
      const result = inspect(aab);
      assert.equal(result.status, 1, `${label}: ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `::error::Android bundle inspection failed: ${label}\n`, label);
    });
  }
});

test("merged third-party kotlin internals outside base/assets are not private markers", () => {
  withFixture((o) => {
    o.extra = { "base/root/kotlin/internal/progressionUtil.kotlin_builtins": "x" };
  }, (aab) => assert.equal(inspect(aab).status, 0));
});

test("rejects malformed arguments and non-zip input without echoing content", () => {
  withFixture(() => {}, (aab) => {
    for (const args of [
      ["nothex", VERSION_NAME, VERSION_CODE, SOURCE_SHA],
      [TRUST_KEY_SHA256, VERSION_NAME, "0", SOURCE_SHA],
      [TRUST_KEY_SHA256, VERSION_NAME, VERSION_CODE, "short"],
      [TRUST_KEY_SHA256, VERSION_NAME, VERSION_CODE],
    ]) {
      const result = inspect(aab, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /inspection failed: arguments/u);
    }
    fs.writeFileSync(aab, "secret-looking not a zip");
    const garbage = inspect(aab);
    assert.equal(garbage.status, 1);
    assert.equal(garbage.stderr, "::error::Android bundle inspection failed: unreadable-archive\n");
  });
});
