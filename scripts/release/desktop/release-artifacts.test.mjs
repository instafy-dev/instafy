import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  checkExtractedApp,
  checkReleaseSet,
  findAppArchive,
  forbiddenReason,
  readZipEntries,
} from "./release-artifacts.mjs";

const REG = 0o100644;
const DIR = 0o040755;
const LNK = 0o120777;

// Minimal ZIP writer: stored or deflated entries with Unix modes, optional ZIP64 end records.
function writeZip(file, entries, { zip64 = false, deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, mode, data = "" } of entries) {
    const raw = Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((mode << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, ...tail, end]));
}

const goodApp = [
  { name: "Instafy.app/", mode: DIR },
  { name: "Instafy.app/Contents/MacOS/Instafy", mode: 0o100755, data: "bin" },
  { name: "Instafy.app/Contents/Frameworks/Electron Framework.framework/Versions/Current", mode: LNK, data: "A" },
  { name: "Instafy.app/Contents/Frameworks/Electron Framework.framework/Resources", mode: LNK, data: "Versions/Current/Resources" },
];

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-artifacts-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function archiveCase(entries, options) {
  return withDir((dir) => {
    writeZip(path.join(dir, "instafy-0.2.13-mac-arm64.zip"), entries, options);
    return findAppArchive({ root: dir, version: "0.2.13" });
  });
}

test("zip reader parses classic, deflated and ZIP64 central directories", () => {
  for (const options of [{}, { deflate: true }, { zip64: true }]) {
    withDir((dir) => {
      const file = path.join(dir, "a.zip");
      writeZip(file, goodApp, options);
      const zip = readZipEntries(file);
      try {
        assert.deepEqual(zip.entries.map((entry) => entry.name), goodApp.map((entry) => entry.name));
        assert.equal(zip.readContent(zip.entries[3]).toString(), "Versions/Current/Resources");
      } finally {
        zip.close();
      }
    });
  }
});

test("a safe application archive is accepted", () => {
  assert.match(archiveCase(goodApp), /instafy-0\.2\.13-mac-arm64\.zip$/u);
  assert.match(archiveCase(goodApp, { deflate: true, zip64: true }), /\.zip$/u);
});

test("unsafe archive entries are rejected", () => {
  const cases = [
    [[...goodApp, { name: "../evil", mode: REG }], /traversal/u],
    [[...goodApp, { name: "/abs/file", mode: REG }], /traversal/u],
    [[...goodApp, { name: "Instafy.app/Contents/../../x", mode: REG }], /traversal/u],
    [[...goodApp, { name: "Other.app/Contents/x", mode: REG }], /Instafy\.app/u],
    [[...goodApp, { name: "README", mode: REG }], /Instafy\.app/u],
    [[...goodApp, { name: "Instafy.app/Contents/Resources/auth.json", mode: REG }], /auth\.json/u],
    [[...goodApp, { name: "Instafy.app/link", mode: LNK, data: "/etc/passwd" }], /unsafe symbolic link/u],
    [[...goodApp, { name: "Instafy.app/Contents/link", mode: LNK, data: "../../outside" }], /escapes/u],
    [[...goodApp, { name: "Instafy.app/fifo", mode: 0o010644 }], /special file/u],
    [[], /empty/u],
  ];
  for (const [entries, pattern] of cases) {
    assert.throws(() => archiveCase(entries), pattern);
  }
});

test("exactly one version-matched macOS ZIP must be present", () => {
  withDir((dir) => {
    assert.throws(() => findAppArchive({ root: dir, version: "0.2.13" }), /found 0/u);
    writeZip(path.join(dir, "instafy-0.2.13-mac-arm64.zip"), goodApp);
    writeZip(path.join(dir, "instafy-0.2.12-mac-arm64.zip"), goodApp);
    assert.throws(() => findAppArchive({ root: dir, version: "0.2.13" }), /unexpected macOS ZIP/u);
  });
});

function releaseDir(dir, names) {
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), name);
  }
}

const releaseNames = [
  "instafy-0.2.13-mac-arm64.dmg",
  "instafy-0.2.13-mac-arm64.dmg.blockmap",
  "instafy-0.2.13-mac-arm64.zip",
  "instafy-0.2.13-mac-arm64.zip.blockmap",
  "latest-mac.yml",
];

test("release set lists the publishable files in payload-first order", () => {
  withDir((dir) => {
    releaseDir(dir, [...releaseNames, "builder-debug.yml", "mac-arm64/Instafy.app/Contents/Info.plist"]);
    assert.deepEqual(checkReleaseSet({ root: dir, version: "0.2.13" }), [
      "instafy-0.2.13-mac-arm64.dmg",
      "instafy-0.2.13-mac-arm64.zip",
      "instafy-0.2.13-mac-arm64.dmg.blockmap",
      "instafy-0.2.13-mac-arm64.zip.blockmap",
      "latest-mac.yml",
    ]);
  });
  withDir((dir) => {
    releaseDir(dir, releaseNames.filter((name) => !name.endsWith(".dmg.blockmap")));
    assert.equal(checkReleaseSet({ root: dir, version: "0.2.13" }).length, 4);
  });
});

test("release set rejects missing, foreign and private files", () => {
  const cases = [
    [releaseNames.filter((name) => name !== "latest-mac.yml"), /latest-mac\.yml/u],
    [releaseNames.filter((name) => !name.endsWith(".zip.blockmap")), /zip\.blockmap/u],
    [[...releaseNames, "instafy-0.2.12-mac-arm64.dmg"], /Unexpected release file/u],
    [[...releaseNames, "instafy-0.2.13-win.exe"], /Unexpected release file/u],
    [[...releaseNames, "latest.yml"], /Unexpected release file/u],
    [[...releaseNames, "instafy-0.2.13.AppImage"], /Linux/u],
    [[...releaseNames, "latest-linux.yml"], /Linux/u],
    [[...releaseNames, "mac-arm64/.env.production"], /environment file/u],
    [[...releaseNames, "mac-arm64/Instafy.app/auth.json"], /auth\.json/u],
    [[...releaseNames, `${["inter", "nal"].join("")}/x`], /private path/u],
    [[...releaseNames, `${["kno", "sh"].join("")}.txt`], /private package/u],
  ];
  for (const [names, pattern] of cases) {
    withDir((dir) => {
      releaseDir(dir, names);
      assert.throws(() => checkReleaseSet({ root: dir, version: "0.2.13" }), pattern);
    });
  }
  withDir((dir) => {
    releaseDir(dir, releaseNames);
    fs.symlinkSync("latest-mac.yml", path.join(dir, "alias.yml"));
    assert.equal(checkReleaseSet({ root: dir, version: "0.2.13" }).length, 5);
    assert.throws(() => checkReleaseSet({ root: dir, version: "0.2.13", noSymlinks: true }), /symbolic links/u);
  });
  assert.equal(forbiddenReason("instafy-0.2.13-mac-arm64.dmg"), null);
  const nestedDependency = `mac-arm64/Instafy.app/Contents/Resources/app.asar.unpacked/node_modules/dep/${["inter", "nal"].join("")}/index.js`;
  assert.equal(forbiddenReason(nestedDependency), null);
  const dependencyDir = "mac-arm64/Instafy.app/Contents/Resources/app.asar.unpacked/node_modules/dep";
  for (const template of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
    assert.equal(forbiddenReason(`${dependencyDir}/${template}`), null, template);
  }
  for (const real of [".env", ".env.local", ".env.production", ".env.example.local", ".env.examples"]) {
    assert.match(forbiddenReason(`${dependencyDir}/${real}`) ?? "", /environment file/u, real);
  }
  assert.equal(forbiddenReason(`mac-arm64/Instafy.app/Contents/Resources/${["kno", "sh"].join("")}`) !== null, true);
});

test("extracted application must be one regular bundle with an executable", () => {
  withDir((dir) => {
    assert.throws(() => checkExtractedApp({ root: dir }), /exactly one/u);
    const executable = path.join(dir, "Instafy.app", "Contents", "MacOS", "Instafy");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "bin", { mode: 0o644 });
    assert.throws(() => checkExtractedApp({ root: dir }), /not executable/u);
    fs.chmodSync(executable, 0o755);
    assert.equal(checkExtractedApp({ root: dir }), path.resolve(executable));
    fs.writeFileSync(path.join(dir, "Instafy.app", "Contents", "auth.json"), "{}");
    assert.throws(() => checkExtractedApp({ root: dir }), /auth\.json/u);
  });
});
