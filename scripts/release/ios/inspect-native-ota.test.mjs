import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = new URL("./inspect-native-ota.py", import.meta.url).pathname;
const SOURCE = "2".repeat(40);
const PUBLIC_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
const TRUST = createHash("sha256").update(PUBLIC_KEY.trim()).digest("hex");
const MARKER_PREFIX = `${["instafy", "native", "ota", "channel"].join("-")}:`;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const python = spawnSync("python3", ["--version"]).status === 0;

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal stored ZIP writer so the fixture needs no zip tool or Xcode.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(header, filename, data);
    centrals.push(central, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function fixture({ channel = "internal", key = PUBLIC_KEY, marker = "internal", markers = 1, source = SOURCE, build = "81", extraConfig = false } = {}) {
  const prefix = "Payload/App.app/";
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.instafy.studio</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`;
  const config = { appId: "dev.instafy.studio", plugins: { LiveUpdate: { defaultChannel: channel, autoUpdateStrategy: "none", publicKey: key } } };
  const markerText = Array.from({ length: markers }, () => `"${MARKER_PREFIX}${marker}"`).join(",");
  return [
    [`${prefix}Info.plist`, plist],
    [`${prefix}capacitor.config.json`, JSON.stringify(config)],
    ...(extraConfig ? [["Payload/App.app/Frameworks/capacitor.config.json", "{}"]] : []),
    [`${prefix}public/index.html`, '<script type="module" src="/assets/index-main.js"></script>'],
    [`${prefix}public/assets/index-main.js`, `${"im" + "port"} "./ota.js"; console.log("${source}");`],
    [`${prefix}public/assets/ota.js`, `export const channels = [${markerText}];`],
  ];
}

function inspect(entries, trust = TRUST, source = SOURCE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-ota-inspect-"));
  try {
    const ipa = path.join(dir, "Instafy.ipa");
    fs.writeFileSync(ipa, zip(entries));
    const result = spawnSync("python3", [SCRIPT, ipa, source, trust], { encoding: "utf8" });
    return { ...result, digest: sha(fs.readFileSync(ipa)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("proves channel, trust key, marker and source commit of an IPA", { skip: !python }, () => {
  const result = inspect(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    lane: "ios",
    applicationId: "dev.instafy.studio",
    nativeVersion: "1.0",
    nativeBuild: "81",
    nativeArtifactSha256: result.digest,
    channel: "internal",
    trustKeySha256: TRUST,
    marker: `${MARKER_PREFIX}internal`,
    sourceSha: SOURCE,
  });
});

test("fails closed with a fixed message on any contract drift", { skip: !python }, () => {
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const cases = [
    ["wrong channel", fixture({ channel: "stable" })],
    ["wrong key", fixture({ key: other })],
    ["marker for another channel", fixture({ marker: "stable" })],
    ["duplicate marker", fixture({ markers: 2 })],
    ["missing source commit", fixture({ source: "3".repeat(40) })],
    ["ambiguous config", fixture({ extraConfig: true })],
  ];
  for (const [name, entries] of cases) {
    const result = inspect(entries);
    assert.equal(result.status, 1, name);
    assert.equal(result.stderr.trim(), "Native OTA archive inspection failed", name);
    assert.equal(result.stdout, "", name);
  }
  assert.equal(inspect(fixture(), "0".repeat(64)).status, 1);
  assert.equal(inspect(fixture(), TRUST, "not-a-sha").status, 1);
});
