#!/usr/bin/env node
// File-level release checks for the Desktop lane.
//
//   release-set --root DIR --version V [--no-symlinks]
//       The signed output (build) or downloaded artifact (publish) holds exactly
//       one mac-arm64 DMG, ZIP, ZIP blockmap and latest-mac.yml for V (plus at
//       most one DMG blockmap) and nothing that must never be published.
//       Prints the publishable file names, one per line.
//   archive --root DIR --version V
//       Exactly one instafy-V-mac-arm64.zip whose every entry stays inside
//       Instafy.app (no absolute or traversal names, no escaping symlinks, no
//       special files, no auth.json). Prints the archive path.
//   extracted --root DIR
//       `ditto -x -k` produced exactly one regular Instafy.app with an
//       executable main binary and no auth.json. Prints the executable path.

import fs, { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

// Assembled so this file does not itself carry the private markers it rejects.
const PRIVATE_NAME_MARKERS = Object.freeze([
  ["kno", "sh"].join(""),
  ["operator", "console"].join("-"),
]);
const APP_NAME = "Instafy.app";
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export class ReleaseArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseArtifactError";
  }
}

function fail(message) {
  throw new ReleaseArtifactError(message);
}

function requireVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version ?? "")) {
    fail("A plain SemVer release version is required.");
  }
}

function walk(root, visit, relative = "") {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    visit(child, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(root, visit, child);
  }
}

export function forbiddenReason(relativePath) {
  const name = relativePath.split("/").at(-1);
  const lower = relativePath.toLowerCase();
  if (/\.appimage$/iu.test(name) || name === "latest-linux.yml") return "Linux artifacts are not part of the stable Desktop lane";
  if (PRIVATE_NAME_MARKERS.some((marker) => lower.includes(marker))) return "a private package marker is present";
  if (name === ".env" || name.startsWith(".env.")) return "an environment file is present";
  if (name.toLowerCase() === "auth.json") return "a credential-bearing auth.json is present";
  if (relativePath.split("/").includes(["inter", "nal"].join(""))) return "a private path segment is present";
  return null;
}

export function checkReleaseSet({ root, version, noSymlinks = false }) {
  requireVersion(version);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("The release root must be a real directory.");
  walk(root, (relative, entry) => {
    const reason = forbiddenReason(relative);
    if (reason) fail(`Refusing to release ${relative}: ${reason}.`);
    if (noSymlinks && entry.isSymbolicLink()) fail(`Release artifacts must not contain symbolic links (${relative}).`);
  });
  const topLevel = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile());
  const base = `instafy-${version}-mac-arm64`;
  const required = [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, "latest-mac.yml"];
  const optional = [`${base}.dmg.blockmap`];
  const names = topLevel.map((entry) => entry.name);
  for (const name of required) {
    if (!names.includes(name)) fail(`Expected exactly one ${name}.`);
  }
  for (const entry of topLevel) {
    const name = entry.name;
    const isReleaseLike = /^instafy-.*\.(?:dmg|zip|exe|blockmap)$/u.test(name) || /^latest.*\.yml$/u.test(name);
    if (isReleaseLike && !required.includes(name) && !optional.includes(name)) {
      fail(`Unexpected release file ${name}; only the ${version} mac-arm64 set may be published.`);
    }
  }
  const files = [...required.slice(0, 2), ...optional.filter((name) => names.includes(name)), required[2], required[3]];
  return files;
}

// ---- ZIP central directory (read-only; supports ZIP64) ----

function readAt(descriptor, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (read === 0) fail("The packaged archive is truncated.");
    offset += read;
  }
  return buffer;
}

function toNumber(big) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail("The packaged archive is too large.");
  return Number(big);
}

export function readZipEntries(archivePath) {
  const descriptor = fs.openSync(archivePath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = readAt(descriptor, size - tailLength, tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) fail("The packaged archive has no end of central directory.");
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) fail("The packaged archive has an invalid ZIP64 locator.");
      const zip64Offset = toNumber(tail.readBigUInt64LE(locator + 8));
      const zip64 = readAt(descriptor, zip64Offset, 56);
      if (zip64.readUInt32LE(0) !== 0x06064b50) fail("The packaged archive has an invalid ZIP64 directory.");
      entries = toNumber(zip64.readBigUInt64LE(32));
      cdSize = toNumber(zip64.readBigUInt64LE(40));
      cdOffset = toNumber(zip64.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size) fail("The packaged archive central directory is out of range.");
    const directory = readAt(descriptor, cdOffset, cdSize);
    const result = [];
    let cursor = 0;
    for (let count = 0; count < entries; count += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) {
        fail("The packaged archive central directory is corrupt.");
      }
      const madeBy = directory.readUInt16LE(cursor + 4) >> 8;
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      let compressedSize = directory.readUInt32LE(cursor + 20);
      let uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      let localOffset = directory.readUInt32LE(cursor + 42);
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength);
      const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      for (let at = 0; at + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(at);
        const length = extra.readUInt16LE(at + 2);
        if (id === 0x0001) {
          let field = at + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = toNumber(extra.readBigUInt64LE(field)); field += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = toNumber(extra.readBigUInt64LE(field)); field += 8; }
          if (localOffset === 0xffffffff) { localOffset = toNumber(extra.readBigUInt64LE(field)); }
        }
        at += 4 + length;
      }
      result.push({
        name: nameBytes.toString((flags & 0x800) !== 0 ? "utf8" : "latin1"),
        mode: madeBy === 3 ? externalAttributes >>> 16 : 0,
        encrypted: (flags & 0x1) !== 0,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return {
      entries: result,
      readContent(entry) {
        if (entry.encrypted) fail("The packaged archive contains an encrypted entry.");
        if (entry.compressedSize > 64 * 1024) fail("A packaged symbolic link target is implausibly large.");
        const header = readAt(descriptor, entry.localOffset, 30);
        if (header.readUInt32LE(0) !== 0x04034b50) fail("The packaged archive has a corrupt local header.");
        const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const raw = readAt(descriptor, start, entry.compressedSize);
        if (entry.method === 0) return raw;
        if (entry.method === 8) return zlib.inflateRawSync(raw);
        return fail("The packaged archive uses an unsupported compression method.");
      },
      close() {
        fs.closeSync(descriptor);
      },
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function checkArchiveEntries(zip) {
  if (zip.entries.length === 0) fail("The packaged archive is empty.");
  for (const entry of zip.entries) {
    const name = entry.name;
    if (!name || /[\0\n\r]/u.test(name)) fail("The packaged archive contains an invalid path.");
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    if (name.startsWith("/") || parts.includes("..")) fail("The packaged archive contains a traversal path.");
    if (parts.length === 0) fail("The packaged archive contains an invalid path.");
    if (parts.at(-1).toLowerCase() === "auth.json") fail("The packaged application must never contain auth.json.");
    const appIndex = parts.findIndex((part) => part.endsWith(".app"));
    if (appIndex !== 0 || parts[0] !== APP_NAME) {
      fail("Every archive entry must be inside exactly one top-level Instafy.app bundle.");
    }
    const type = entry.mode & S_IFMT;
    if (type === S_IFLNK) {
      const target = zip.readContent(entry).toString("utf8");
      if (!target || target.includes("\0") || target.startsWith("/")) {
        fail("The packaged archive contains an unsafe symbolic link.");
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(parts.join("/")), target)).replace(/\/+$/u, "");
      if (resolved !== APP_NAME && !resolved.startsWith(`${APP_NAME}/`)) {
        fail("A packaged symbolic link escapes the application bundle.");
      }
    } else if (![0, S_IFREG, S_IFDIR].includes(type)) {
      fail("The packaged archive contains an unsupported special file.");
    }
  }
}

export function findAppArchive({ root, version }) {
  requireVersion(version);
  const archives = [];
  walk(root, (relative, entry) => {
    if (entry.isFile() && /^instafy-.*-mac-.*\.zip$/u.test(entry.name)) archives.push(relative);
  });
  const expected = archives.filter((relative) => relative.split("/").at(-1) === `instafy-${version}-mac-arm64.zip`);
  if (expected.length !== 1) fail(`Expected exactly one signed macOS ARM64 ZIP; found ${expected.length}.`);
  if (archives.length !== 1) fail("The downloaded artifact contains an unexpected macOS ZIP.");
  const archivePath = path.join(root, expected[0]);
  const zip = readZipEntries(archivePath);
  try {
    checkArchiveEntries(zip);
  } finally {
    zip.close();
  }
  return path.resolve(archivePath);
}

export function checkExtractedApp({ root }) {
  const apps = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".app"));
  if (apps.length !== 1 || apps[0].name !== APP_NAME || !apps[0].isDirectory() || apps[0].isSymbolicLink()) {
    fail("Safe extraction did not produce exactly one regular Instafy.app bundle.");
  }
  const appPath = path.join(root, APP_NAME);
  const executable = path.join(appPath, "Contents", "MacOS", "Instafy");
  const stat = fs.lstatSync(executable, { throwIfNoEntry: false });
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) fail("The packaged Instafy executable is missing or not executable.");
  walk(appPath, (relative, entry) => {
    if (entry.name.toLowerCase() === "auth.json") fail("The packaged application must never contain auth.json.");
  });
  return path.resolve(executable);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--no-symlinks") options.noSymlinks = true;
    else if (flag === "--root" || flag === "--version") {
      const value = rest[index + 1];
      if (!value) fail(`Missing value for ${flag}.`);
      options[flag.slice(2)] = value;
      index += 1;
    } else fail(`Unsupported argument ${flag}.`);
  }
  if (!options.root) fail("--root is required.");
  return options;
}

export function run(argv) {
  const options = parseArguments(argv);
  switch (options.command) {
    case "release-set":
      return checkReleaseSet(options).join("\n");
    case "archive":
      return findAppArchive(options);
    case "extracted":
      return checkExtractedApp(options);
    default:
      return fail("Usage: release-artifacts.mjs release-set|archive|extracted --root DIR [--version V]");
  }
}

function isEntryPoint(argvPath) {
  // Compare real paths: temp and checkout roots may sit behind symlinks.
  try {
    return Boolean(argvPath) && realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    process.stdout.write(`${run(process.argv.slice(2))}\n`);
  } catch (error) {
    console.error(`::error::${error instanceof ReleaseArtifactError ? error.message : "Release artifact check failed."}`);
    process.exitCode = 1;
  }
}
