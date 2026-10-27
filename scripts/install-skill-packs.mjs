#!/usr/bin/env node
// Installs the skill packs pinned in packages/runtime-agent/skill-packs.json into one folder
// (default packages/runtime-agent/assets/skill-packs, the runtime image uses /opt/instafy/skill-packs).
//
// Each pack is a release tarball that `git archive` made from the pack's repository. The installer
//   1. downloads it over https from the pinned URL (redirects must stay on https),
//   2. checks its sha256 against the pin before reading anything in it,
//   3. reads the tar itself (gzip through node:zlib, at most 16 MB unpacked): only regular files and
//      folders, no links, no absolute or `..` paths, every entry under the pinned pack folder,
//   4. checks that the archive's pax global header names the pinned commit,
//   5. checks the pack's .instafy-pack.json (name, version, tree_sha256, size caps) and the content's
//      tree_sha256,
//   6. moves the pack into place in one rename and records it in installed.json.
// A pack that is already installed with the pinned tree_sha256 is left as it is.
//
// A pack's commands (`bin` in its manifest: {"uw": "scripts/uw.mjs"}) are checked with the pack: at
// most 8, plain names (a-z, 0-9, -) that are not reserved, each a file inside the pack. With
// --install-root <dir> (the absolute folder the packs are copied to, /opt/instafy/skill-packs in the
// runtime image) the installer also writes one shim per command to <out>/.bin/<name>, which runs
// `node <dir>/<pack>/<entry>`; the image puts them in /usr/local/bin. A name two packs declare gets
// no shim.
//
//   node scripts/install-skill-packs.mjs [--out <dir>] [--pin <skill-packs.json>] [--require-pinned] [--install-root <dir>]
//   node scripts/install-skill-packs.mjs --from <pack folder> [--out <dir>]   (pack authors: not pinned)
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PIN = path.join(repositoryRoot, "packages", "runtime-agent", "skill-packs.json");
export const DEFAULT_OUT = path.join(repositoryRoot, "packages", "runtime-agent", "assets", "skill-packs");
export const RELEASE_URL_PREFIX = "https://github.com/instafy-dev/";
export const MANIFEST = ".instafy-pack.json";
export const INSTALLED = "installed.json";
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;
// The same caps `/skills import` applies to one source.
export const MAX_PACK_FILES = 256;
export const MAX_PACK_BYTES = 8 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
export const BIN_DIR = ".bin";
export const BIN_MARKER = "# instafy:managed-pack-bin";
export const MAX_PACK_BINS = 8;
const BIN_NAME = /^[a-z][a-z0-9-]{1,31}$/u;
// The same names and prefixes packages/runtime-agent/src/skill_packs.rs refuses: the runtime's own
// tools, the commands every shell needs, the image's helpers (some reach /usr/local/bin after the
// pack commands) and Codex's commands.
export const RESERVED_BIN_NAMES = new Set([
  "instafy", "node", "npm", "npx", "pnpm", "pnpx", "yarn", "corepack", "git", "sh", "bash", "zsh", "dash",
  "env", "python", "python3", "pip", "codex", "runtime-agent", "curl", "wget", "sudo", "make",
  "applypatch", "rathole", "runtime-entrypoint", "browser-egress-proxy", "browser-webrtc-sender",
]);
export const RESERVED_BIN_PREFIXES = ["codex-", "instafy-"];

/// Whether a pack may declare the command `name`: plain, not reserved, outside the reserved prefixes.
export function isPackBinName(name) {
  return typeof name === "string" && BIN_NAME.test(name) && !RESERVED_BIN_NAMES.has(name) && !RESERVED_BIN_PREFIXES.some((prefix) => name.startsWith(prefix));
}
// A path written into a shim: plain characters only, single-quoted there.
const PLAIN_PATH = /^[A-Za-z0-9._/-]+$/u;

export class InstallError extends Error {}

function fail(message) {
  throw new InstallError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/// The pack content digest: every file except the manifest, in byte order of its "/"-separated path,
/// each fed as path, NUL, bytes, NUL. `files` is a Map of relative path to Buffer.
export function treeDigest(files) {
  const hash = createHash("sha256");
  let bytes = 0;
  let count = 0;
  for (const rel of [...files.keys()].filter((rel) => rel !== MANIFEST).sort(compareBytes)) {
    const data = files.get(rel);
    hash.update(rel).update("\0").update(data).update("\0");
    bytes += data.length;
    count += 1;
  }
  return { files: count, bytes, tree_sha256: hash.digest("hex") };
}

/// Reads every regular file under `dir` (refusing links) into a Map of relative path to Buffer.
export function readPackFolder(dir) {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`${child}: links are not allowed in a skill pack`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.set(child, fs.readFileSync(path.join(dir, child)));
      else fail(`${child}: only regular files and folders are allowed in a skill pack`);
    }
  };
  walk("");
  return files;
}

function safeRelative(rel, what) {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 512) fail(`${what}: bad path`);
  if (rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) fail(`${what}: ${JSON.stringify(rel)} is not a relative path`);
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === "." || segment === "..") fail(`${what}: ${JSON.stringify(rel)} leaves its folder`);
  }
  return rel;
}

export function validatePin(pin, { urlPrefix = RELEASE_URL_PREFIX } = {}) {
  if (!pin || pin.schema !== 1 || !Array.isArray(pin.packs)) fail("skill-packs.json: expected {schema: 1, packs: [...]}");
  const names = new Set();
  for (const pack of pin.packs) {
    const where = `skill-packs.json ${JSON.stringify(pack?.name)}`;
    if (!pack || typeof pack !== "object") fail(`${where}: not an object`);
    if (!NAME.test(pack.name ?? "")) fail(`${where}: name must match ${NAME}`);
    if (names.has(pack.name)) fail(`${where}: listed twice`);
    names.add(pack.name);
    if (!/^instafy-dev\/[A-Za-z0-9._-]+$/u.test(pack.repo ?? "")) fail(`${where}: repo must be instafy-dev/<repo>`);
    if (!VERSION.test(pack.version ?? "")) fail(`${where}: version must be x.y.z`);
    if (pack.tag !== `v${pack.version}`) fail(`${where}: tag must be v${pack.version}`);
    if (!HEX40.test(pack.commit ?? "")) fail(`${where}: commit must be 40 lowercase hex characters`);
    if (!HEX64.test(pack.sha256 ?? "")) fail(`${where}: sha256 must be 64 lowercase hex characters`);
    if (!HEX64.test(pack.tree_sha256 ?? "")) fail(`${where}: tree_sha256 must be 64 lowercase hex characters`);
    if (typeof pack.license !== "string" || !pack.license) fail(`${where}: license is required`);
    safeRelative(pack.path ?? `skills/${pack.name}`, `${where} path`);
    if (typeof pack.url !== "string" || !pack.url.startsWith(urlPrefix)) fail(`${where}: url must start with ${urlPrefix}`);
    if (urlPrefix === RELEASE_URL_PREFIX && !pack.url.startsWith(`https://github.com/${pack.repo}/releases/download/${pack.tag}/`)) {
      fail(`${where}: url must be a release asset of ${pack.repo} at ${pack.tag}`);
    }
  }
  return pin;
}

async function download(url, { allowLoopbackHttp = false, fetchImpl = fetch } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const parsed = new URL(current);
    const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(allowLoopbackHttp && loopback)) fail(`refusing a non-https download: ${parsed.origin}`);
    const response = await fetchImpl(current, { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) fail(`redirect without a location from ${parsed.origin}`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) fail(`download failed: HTTP ${response.status} from ${parsed.origin}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ARCHIVE_BYTES) fail(`archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES) fail(`archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  fail("too many redirects");
}

function cString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

function octal(buffer, start, length, what) {
  const text = cString(buffer, start, length).trim();
  if (!/^[0-7]*$/u.test(text)) fail(`tar: bad ${what} field`);
  return text ? Number.parseInt(text, 8) : 0;
}

function paxRecords(data) {
  const records = new Map();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) fail("tar: bad pax record");
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) fail("tar: bad pax record");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 0) fail("tar: bad pax record");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/// Parses a ustar/pax archive. Returns {comment, entries: [{path, type: "file"|"dir", mode, data}]}.
/// Every entry type except regular files, folders and pax headers is refused.
export function parseTar(tar) {
  const entries = [];
  let comment = null;
  let pending = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (checksum !== octal(header, 148, 8, "checksum")) fail("tar: header checksum mismatch");
    const size = octal(header, 124, 12, "size");
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) fail("tar: truncated entry");
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "g") {
      const records = paxRecords(data);
      if (records.has("comment")) comment = records.get("comment");
      continue;
    }
    if (type === "x") {
      pending = paxRecords(data);
      continue;
    }
    const prefix = cString(header, 345, 155);
    const name = cString(header, 0, 100);
    let entryPath = pending?.get("path") ?? (prefix ? `${prefix}/${name}` : name);
    const entrySize = pending?.has("size") ? Number(pending.get("size")) : size;
    pending = null;
    if (entrySize !== size) fail(`tar: ${entryPath}: pax size differs from the header`);
    if (type === "5") {
      entryPath = entryPath.replace(/\/+$/u, "");
      entries.push({ path: safeRelative(entryPath, "tar entry"), type: "dir", mode: octal(header, 100, 8, "mode") });
      continue;
    }
    if (type !== "0") {
      const kind = { 1: "hard link", 2: "symbolic link", 3: "character device", 4: "block device", 6: "fifo", 7: "contiguous file", L: "GNU long name", K: "GNU long link" }[type] ?? `type ${JSON.stringify(type)}`;
      fail(`tar: ${entryPath}: ${kind} entries are not allowed`);
    }
    entries.push({ path: safeRelative(entryPath, "tar entry"), type: "file", mode: octal(header, 100, 8, "mode"), data });
  }
  return { comment, entries };
}

/// Unpacks a release archive in memory and returns the pack's files (relative to the pack folder)
/// with their modes, after every check that does not need the manifest.
export function unpackArchive(archive, pack) {
  let tar;
  try {
    tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) fail(`archive unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
    fail(`archive is not gzip: ${error.message}`);
  }
  const { comment, entries } = parseTar(tar);
  if (comment !== pack.commit) fail(`archive was made from commit ${comment ?? "(none)"}, not the pinned ${pack.commit}`);
  const root = pack.path ?? `skills/${pack.name}`;
  const files = new Map();
  const executable = new Set();
  let bytes = 0;
  for (const entry of entries) {
    if (entry.path === root || root.startsWith(`${entry.path}/`)) {
      if (entry.type !== "dir") fail(`${entry.path}: expected a folder`);
      continue;
    }
    if (!entry.path.startsWith(`${root}/`)) fail(`${entry.path}: outside the pack folder ${root}`);
    const rel = entry.path.slice(root.length + 1);
    for (const segment of rel.split("/")) {
      if (!SAFE_SEGMENT.test(segment)) fail(`${entry.path}: unsupported characters in the path`);
    }
    if (entry.type === "dir") continue;
    if (files.has(rel)) fail(`${entry.path}: listed twice`);
    bytes += entry.data.length;
    // The manifest is not counted against the cap.
    if (files.size > MAX_PACK_FILES) fail(`more than ${MAX_PACK_FILES} files`);
    if (bytes > MAX_PACK_BYTES) fail(`more than ${MAX_PACK_BYTES} bytes`);
    files.set(rel, Buffer.from(entry.data));
    if (entry.mode & 0o111) executable.add(rel);
  }
  return { files, executable };
}

// Activity labels (docs/Chat-Activity.md): the same rules as runtime-contracts' chat_activity.rs,
// pinned by its chat_activity_fixtures.json.
const LABEL_PUNCTUATION = "'\u2019,.-\u2013\u00b7:;()&!?";
const SUBCOMMAND = /^(?:\*|[a-z0-9][a-z0-9-]{0,31})$/u;

export function isPlainLabelText(text) {
  if (typeof text !== "string" || text === "" || text.trim() !== text || text.includes("  ")) return false;
  const characters = [...text];
  if (!characters.every((character) => /\p{Alphabetic}/u.test(character) || /[0-9 ]/u.test(character) || LABEL_PUNCTUATION.includes(character))) return false;
  const dottedWord = characters.some((character, index) => character === "." && index + 1 < characters.length && (/\p{Alphabetic}/u.test(characters[index + 1]) || /[0-9]/u.test(characters[index + 1])));
  return !dottedWord && !text.toLowerCase().includes("www");
}

export function isLiveLabel(text) {
  return typeof text === "string" && !text.includes("{host}") && [...text].length <= 40 && /^\p{Uppercase}/u.test(text) && isPlainLabelText(text);
}

export function isDoneForm(text, count) {
  if (typeof text !== "string" || text.split("{n}").length - 1 !== (count ? 1 : 0)) return false;
  const filled = text.replace("{n}", "999");
  return !filled.includes("{host}") && [...filled].length <= 48 && /^\p{Lowercase}/u.test(filled) && isPlainLabelText(filled);
}

/// Checks a manifest's `bin` and `activity`. Returns null when they follow the rules (or there is
/// no `activity`), else the first rule broken. A pack that breaks one still installs; the runtime
/// drops its labels.
export function checkPackActivity(manifest, files) {
  if (manifest.activity === undefined) return null;
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(manifest.activity)) return "activity is not an object";
  if (!isObject(manifest.bin)) return "activity labels only commands declared in `bin`";
  const bins = Object.entries(manifest.bin);
  if (bins.length > MAX_PACK_BINS) return `bin declares more than ${MAX_PACK_BINS} commands`;
  for (const [name, entry] of bins) {
    if (!isPackBinName(name)) return `bin ${JSON.stringify(name)} is not a command name a pack may declare`;
    if (typeof entry !== "string" || !files.has(entry)) return `bin ${JSON.stringify(name)}: ${JSON.stringify(entry)} is not a file inside the pack`;
  }
  for (const [name, subcommands] of Object.entries(manifest.activity)) {
    if (!Object.hasOwn(manifest.bin, name)) return `activity ${JSON.stringify(name)} is not a command in \`bin\``;
    if (!isObject(subcommands)) return `activity ${JSON.stringify(name)} is not an object`;
    if (Object.keys(subcommands).length > 64) return `activity ${JSON.stringify(name)} labels more than 64 subcommands`;
    for (const [subcommand, label] of Object.entries(subcommands)) {
      const where = `activity ${name}.${subcommand}`;
      if (!SUBCOMMAND.test(subcommand)) return `${where}: not a subcommand name`;
      if (!isObject(label)) return `${where}: a label is an object`;
      const unknown = Object.keys(label).find((key) => !["live", "done", "role", "when"].includes(key));
      if (unknown) return `${where}: unknown field ${JSON.stringify(unknown)}`;
      if (!isLiveLabel(label.live)) return `${where}: live breaks the label rules`;
      const role = label.role ?? "content";
      if (!["content", "outcome", "quiet"].includes(role)) return `${where}: role is not content, outcome or quiet`;
      if (label.when !== undefined && label.when !== "success") return `${where}: when is not "success"`;
      if (label.done === undefined) {
        if (role !== "quiet") return `${where}: a content or outcome label needs done words`;
      } else if (typeof label.done === "string") {
        if (!isDoneForm(label.done, false)) return `${where}: done breaks the label rules`;
      } else if (isObject(label.done)) {
        const forms = label.done;
        if (Object.keys(forms).some((key) => !["one", "other", "some"].includes(key))) return `${where}: done has an unknown form`;
        if (!isDoneForm(forms.one, false)) return `${where}: done.one breaks the label rules`;
        if (forms.other !== undefined && !isDoneForm(forms.other, true)) return `${where}: done.other breaks the label rules`;
        if (forms.some !== undefined && !isDoneForm(forms.some, false)) return `${where}: done.some breaks the label rules`;
        if (forms.other !== undefined && forms.some === undefined) return `${where}: done needs a \`some\` form with \`other\``;
      } else {
        return `${where}: done breaks the label rules`;
      }
    }
  }
  return null;
}

/// Checks a pack's files against its manifest and, when pinned, against the pin.
export function checkPack(files, { name, version = null, tree_sha256 = null }) {
  const raw = files.get(MANIFEST);
  if (!raw) fail(`${name}: no ${MANIFEST}`);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${name}: ${MANIFEST} is not JSON`);
  }
  if (manifest.schema !== 1) fail(`${name}: ${MANIFEST} schema must be 1`);
  if (manifest.name !== name) fail(`${name}: ${MANIFEST} names ${JSON.stringify(manifest.name)}`);
  if (version !== null && manifest.version !== version) fail(`${name}: ${MANIFEST} version ${manifest.version} is not the pinned ${version}`);
  const tree = treeDigest(files);
  if (tree.files > MAX_PACK_FILES) fail(`${name}: ${tree.files} files, over the ${MAX_PACK_FILES}-file cap`);
  if (tree.bytes > MAX_PACK_BYTES) fail(`${name}: ${tree.bytes} bytes, over the ${MAX_PACK_BYTES}-byte cap`);
  if (manifest.tree_sha256 !== tree.tree_sha256) fail(`${name}: content tree_sha256 ${tree.tree_sha256} does not match ${MANIFEST} (${manifest.tree_sha256})`);
  if (tree_sha256 !== null && tree.tree_sha256 !== tree_sha256) fail(`${name}: content tree_sha256 ${tree.tree_sha256} is not the pinned ${tree_sha256}`);
  if (manifest.files !== undefined && manifest.files !== tree.files) fail(`${name}: ${MANIFEST} counts ${manifest.files} files, the pack has ${tree.files}`);
  if (manifest.bytes !== undefined && manifest.bytes !== tree.bytes) fail(`${name}: ${MANIFEST} counts ${manifest.bytes} bytes, the pack has ${tree.bytes}`);
  const skill = manifest.skill ?? manifest.skills?.[0];
  if (typeof skill !== "string" || !files.has(safeRelative(skill, `${name} skill`))) fail(`${name}: the skill file ${JSON.stringify(skill)} is missing`);
  const entry = manifest.cli?.entry ?? manifest.entry;
  if (entry !== undefined && (typeof entry !== "string" || !files.has(safeRelative(entry, `${name} entry`)))) fail(`${name}: the command ${JSON.stringify(entry)} is missing`);
  return { manifest, tree, bins: packBins(manifest, files, name), activityProblem: checkPackActivity(manifest, files) };
}

/// The commands a pack declares (`bin`: {name: entry}), checked: at most MAX_PACK_BINS, plain names
/// that are not reserved, each entry a file inside the pack. Returns [{name, entry}].
export function packBins(manifest, files, name) {
  if (manifest.bin === undefined) return [];
  if (!manifest.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) fail(`${name}: bin must map command names to files in the pack`);
  const bins = Object.entries(manifest.bin);
  if (bins.length > MAX_PACK_BINS) fail(`${name}: bin lists more than ${MAX_PACK_BINS} commands`);
  return bins.map(([bin, entry]) => {
    if (!isPackBinName(bin)) fail(`${name}: bin ${JSON.stringify(bin)} is not a command a pack may declare (a-z, 0-9 and -, 2 to 32 characters, not a reserved name)`);
    if (typeof entry !== "string" || !PLAIN_PATH.test(entry) || !files.has(safeRelative(entry, `${name} bin ${bin}`))) {
      fail(`${name}: the command ${bin} runs ${JSON.stringify(entry)}, which is not a file inside the pack`);
    }
    return { name: bin, entry };
  });
}

/// The shim for one command: `#!/bin/sh`, the marker the runtime looks for, then node on the entry.
export function binShim({ pack, version, entry, installRoot }) {
  return `#!/bin/sh\n${BIN_MARKER} ${pack} ${version}\nexec node '${installRoot}/${pack}/${entry}' "$@"\n`;
}

/// Writes <out>/.bin/<name> (mode 0755) for every command of the packs installed in `out`, running
/// the pack from `installRoot`. Replaces the folder; a name two packs declare gets no shim.
export function writeBinShims({ out, installRoot, log = () => {} }) {
  if (typeof installRoot !== "string" || !installRoot.startsWith("/") || !PLAIN_PATH.test(installRoot) || installRoot.split("/").some((segment) => segment === "." || segment === "..")) {
    fail(`--install-root must be an absolute path of plain characters, not ${JSON.stringify(installRoot)}`);
  }
  const root = installRoot.replace(/\/+$/u, "");
  const owners = new Map();
  for (const record of readInstalled(out).packs) {
    if (!NAME.test(record?.name ?? "")) continue;
    const { manifest, bins } = checkPack(readPackFolder(path.join(out, record.name)), { name: record.name });
    if (!VERSION.test(manifest.version ?? "")) fail(`${record.name}: ${MANIFEST} version must be x.y.z`);
    for (const bin of bins) owners.set(bin.name, [...(owners.get(bin.name) ?? []), { pack: record.name, version: manifest.version, entry: bin.entry }]);
  }
  const binDir = path.join(out, BIN_DIR);
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const written = [];
  for (const [name, declared] of [...owners].sort(([a], [b]) => compareBytes(a, b))) {
    if (declared.length > 1) {
      log(`warning: ${declared.map(({ pack }) => pack).join(" and ")} all declare the command ${name}; none of them gets it`);
      continue;
    }
    const file = path.join(binDir, name);
    fs.writeFileSync(file, binShim({ ...declared[0], installRoot: root }), { mode: 0o755, flag: "wx" });
    fs.chmodSync(file, 0o755);
    written.push(name);
    log(`${declared[0].pack}: command ${name}`);
  }
  return written;
}

function warnAboutActivity(name, activityProblem, log) {
  if (activityProblem) log(`${name}: warning: its activity labels break the label rules and are dropped (${activityProblem}); the pack still installs`);
}

function readInstalled(out) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(out, INSTALLED), "utf8"));
    return Array.isArray(parsed?.packs) ? parsed : { schema: 1, packs: [] };
  } catch {
    return { schema: 1, packs: [] };
  }
}

function writeAtomically(file, text) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(temporary, text, { mode: 0o644, flag: "wx" });
  fs.renameSync(temporary, file);
}

/// Writes `files` as `out/<name>` in one rename (the previous copy, if any, is removed after).
function placePack(out, name, files, executable) {
  fs.mkdirSync(out, { recursive: true, mode: 0o755 });
  const staging = path.join(out, `.staging-${name}-${randomUUID()}`);
  fs.mkdirSync(staging, { mode: 0o755 });
  try {
    for (const [rel, data] of files) {
      const destination = path.join(staging, ...rel.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      const mode = executable.has(rel) ? 0o755 : 0o644;
      fs.writeFileSync(destination, data, { mode, flag: "wx" });
      fs.chmodSync(destination, mode);
    }
    const target = path.join(out, name);
    const aside = path.join(out, `.replaced-${name}-${randomUUID()}`);
    const existed = fs.existsSync(target);
    if (existed) fs.renameSync(target, aside);
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (existed) fs.renameSync(aside, target);
      throw error;
    }
    if (existed) fs.rmSync(aside, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function alreadyInstalled(out, pack, installed) {
  const record = installed.packs.find((entry) => entry.name === pack.name);
  if (!record || record.pinned !== true || record.sha256 !== pack.sha256 || record.tree_sha256 !== pack.tree_sha256) return false;
  try {
    checkPack(readPackFolder(path.join(out, pack.name)), pack);
    return true;
  } catch {
    return false;
  }
}

/// Installs every pinned pack into `out`. Returns [{name, version, status: "installed"|"unchanged"}].
export async function installPinned({ pin, out, urlPrefix = RELEASE_URL_PREFIX, allowLoopbackHttp = false, fetchImpl = fetch, log = () => {} }) {
  validatePin(pin, { urlPrefix });
  const installed = readInstalled(out);
  const results = [];
  const records = [];
  for (const pack of pin.packs) {
    if (alreadyInstalled(out, pack, installed)) {
      log(`${pack.name}@${pack.version}: already installed`);
      results.push({ name: pack.name, version: pack.version, status: "unchanged" });
    } else {
      const archive = await download(pack.url, { allowLoopbackHttp, fetchImpl });
      const digest = sha256(archive);
      if (digest !== pack.sha256) fail(`${pack.name}: archive sha256 ${digest} is not the pinned ${pack.sha256}`);
      const { files, executable } = unpackArchive(archive, pack);
      warnAboutActivity(pack.name, checkPack(files, pack).activityProblem, log);
      placePack(out, pack.name, files, executable);
      log(`${pack.name}@${pack.version}: installed (${files.size} files)`);
      results.push({ name: pack.name, version: pack.version, status: "installed" });
    }
    records.push({ name: pack.name, version: pack.version, commit: pack.commit, sha256: pack.sha256, tree_sha256: pack.tree_sha256, license: pack.license, pinned: true });
  }
  // Packs this installer put here before that are no longer pinned.
  const pinned = new Set(pin.packs.map((pack) => pack.name));
  for (const old of installed.packs) {
    if (NAME.test(old?.name ?? "") && !pinned.has(old.name)) fs.rmSync(path.join(out, old.name), { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o755 });
  writeAtomically(path.join(out, INSTALLED), `${JSON.stringify({ schema: 1, packs: records }, null, 2)}\n`);
  return results;
}

/// Pack authors: installs a local pack folder as it is (recorded as not pinned).
export function installFromFolder({ from, out, log = () => {} }) {
  const files = readPackFolder(from);
  const raw = files.get(MANIFEST);
  const name = raw ? JSON.parse(raw.toString("utf8")).name : null;
  if (!NAME.test(name ?? "")) fail(`${from}: ${MANIFEST} needs a name matching ${NAME}`);
  const { manifest, tree, activityProblem } = checkPack(files, { name });
  warnAboutActivity(name, activityProblem, log);
  const executable = new Set([...files.keys()].filter((rel) => fs.statSync(path.join(from, rel)).mode & 0o111));
  placePack(out, name, files, executable);
  const installed = readInstalled(out);
  const records = installed.packs.filter((entry) => entry.name !== name);
  records.push({ name, version: manifest.version, tree_sha256: tree.tree_sha256, pinned: false });
  writeAtomically(path.join(out, INSTALLED), `${JSON.stringify({ schema: 1, packs: records }, null, 2)}\n`);
  log(`${name}@${manifest.version}: installed from ${from} (not pinned)`);
  return [{ name, version: manifest.version, status: "installed" }];
}

function parseArguments(argv) {
  const options = { out: DEFAULT_OUT, pin: DEFAULT_PIN, from: null, requirePinned: false, installRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) fail(`${argument} needs a value`);
      return next;
    };
    if (argument === "--out") options.out = path.resolve(value());
    else if (argument === "--pin") options.pin = path.resolve(value());
    else if (argument === "--from") options.from = path.resolve(value());
    else if (argument === "--require-pinned") options.requirePinned = true;
    else if (argument === "--install-root") options.installRoot = value();
    else fail(`unknown argument ${argument}`);
  }
  if (options.requirePinned && options.from) fail("--require-pinned refuses --from: only pinned release archives are installed");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const log = (line) => process.stdout.write(`[skill-packs] ${line}\n`);
  if (options.from) {
    installFromFolder({ from: options.from, out: options.out, log });
  } else {
    const pin = JSON.parse(fs.readFileSync(options.pin, "utf8"));
    await installPinned({ pin, out: options.out, log });
  }
  if (options.installRoot !== null) writeBinShims({ out: options.out, installRoot: options.installRoot, log });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[skill-packs] ${error instanceof InstallError ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
