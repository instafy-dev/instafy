import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  DEFAULT_PIN,
  MANIFEST,
  checkPackActivity,
  installFromFolder,
  installPinned,
  isDoneForm,
  isLiveLabel,
  treeDigest,
  validatePin,
} from "./install-skill-packs.mjs";

const COMMIT = "1".repeat(40);
const script = path.join(import.meta.dirname, "install-skill-packs.mjs");

function header(name, { size = 0, type = "0", mode = 0o644, linkname = "", prefix = "" } = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padded(data) {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

/// A ustar archive like `git archive` writes: a pax global header with the commit, then entries.
function tarball(entries, { commit = COMMIT } = {}) {
  const parts = [];
  if (commit !== null) {
    const pax = Buffer.from(paxRecord("comment", commit));
    parts.push(header("pax_global_header", { size: pax.length, type: "g" }), padded(pax));
  }
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    parts.push(header(entry.name, { size: entry.type === "0" || !entry.type ? data.length : 0, type: entry.type ?? "0", mode: entry.mode, linkname: entry.linkname }));
    if (!entry.type || entry.type === "0") parts.push(padded(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

function packFiles(name, { version = "0.1.0", extra = {}, manifest = {} } = {}) {
  const files = new Map(Object.entries({
    "SKILL.md": `---\nname: ${name}\ndescription: test pack\n---\n\n# Test\n`,
    "scripts/run.mjs": "console.log('hi');\n",
    ...extra,
  }).map(([rel, text]) => [rel, Buffer.from(text)]));
  const tree = treeDigest(files);
  files.set(MANIFEST, Buffer.from(JSON.stringify({ schema: 1, name, version, skills: ["SKILL.md"], entry: "scripts/run.mjs", engines: { node: ">=22" }, ...tree, ...manifest })));
  return { files, tree };
}

function packEntries(name, files, root = `skills/${name}`) {
  const entries = [{ name: "skills/", type: "5", mode: 0o775 }, { name: `${root}/`, type: "5", mode: 0o775 }];
  for (const [rel, data] of files) entries.push({ name: `${root}/${rel}`, data, mode: rel.endsWith(".mjs") ? 0o775 : 0o664 });
  return entries;
}

async function withServer(routes, run) {
  const server = http.createServer((request, response) => {
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    if (route.redirect) {
      response.writeHead(302, { location: route.redirect }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/gzip" }).end(route.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function pinFor(name, base, archive, tree, overrides = {}) {
  return {
    schema: 1,
    packs: [{
      name,
      repo: "instafy-dev/test-pack",
      version: "0.1.0",
      tag: "v0.1.0",
      commit: COMMIT,
      path: `skills/${name}`,
      url: `${base}/${name}.tar.gz`,
      sha256: createHash("sha256").update(archive).digest("hex"),
      tree_sha256: tree.tree_sha256,
      license: "AGPL-3.0-only",
      ...overrides,
    }],
  };
}

function tempOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-packs-"));
}

async function install(pin, out) {
  return installPinned({ pin, out, urlPrefix: "http://127.0.0.1:", allowLoopbackHttp: true });
}

async function expectRefused(entries, pattern, { name = "demo", tree, commit = COMMIT, overrides = {} } = {}) {
  const archive = tarball(entries, { commit });
  const out = tempOut();
  await withServer({ [`/${name}.tar.gz`]: { body: archive } }, async (base) => {
    const pin = pinFor(name, base, archive, tree ?? { tree_sha256: "a".repeat(64) }, overrides);
    await assert.rejects(install(pin, out), pattern);
  });
  assert.ok(!fs.existsSync(path.join(out, name)), "nothing is installed after a refusal");
}

test("a pinned pack is downloaded, checked and installed, and a repeat install changes nothing", async () => {
  const { files, tree } = packFiles("demo");
  const archive = tarball(packEntries("demo", files));
  const out = tempOut();
  await withServer({ "/demo.tar.gz": { body: archive } }, async (base) => {
    const pin = pinFor("demo", base, archive, tree);
    assert.deepEqual(await install(pin, out), [{ name: "demo", version: "0.1.0", status: "installed" }]);
    assert.equal(fs.readFileSync(path.join(out, "demo", "SKILL.md"), "utf8"), files.get("SKILL.md").toString());
    assert.equal(fs.statSync(path.join(out, "demo", "scripts", "run.mjs")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(out, "demo", "SKILL.md")).mode & 0o777, 0o644);
    const installed = JSON.parse(fs.readFileSync(path.join(out, "installed.json"), "utf8"));
    assert.equal(installed.packs[0].pinned, true);
    assert.equal(installed.packs[0].tree_sha256, tree.tree_sha256);
    const before = fs.statSync(path.join(out, "demo", "SKILL.md")).mtimeMs;
    assert.deepEqual(await install(pin, out), [{ name: "demo", version: "0.1.0", status: "unchanged" }]);
    assert.equal(fs.statSync(path.join(out, "demo", "SKILL.md")).mtimeMs, before);
    // A changed installed copy is replaced from the archive.
    fs.writeFileSync(path.join(out, "demo", "SKILL.md"), "edited");
    assert.equal((await install(pin, out))[0].status, "installed");
    assert.equal(fs.readFileSync(path.join(out, "demo", "SKILL.md"), "utf8"), files.get("SKILL.md").toString());
  });
});

test("an archive whose sha256 is not the pinned one is refused before it is read", async () => {
  const { files, tree } = packFiles("demo");
  await expectRefused(packEntries("demo", files), /archive sha256 [0-9a-f]{64} is not the pinned 0{64}/u, {
    tree,
    overrides: { sha256: "0".repeat(64) },
  });
});

test("links, absolute paths and paths that leave the pack are refused", async () => {
  const { files, tree } = packFiles("demo");
  const base = packEntries("demo", files);
  await expectRefused([...base, { name: "skills/demo/link", type: "2", linkname: "/etc/passwd" }], /symbolic link entries are not allowed/u, { tree });
  await expectRefused([...base, { name: "skills/demo/hard", type: "1", linkname: "skills/demo/SKILL.md" }], /hard link entries are not allowed/u, { tree });
  await expectRefused([...base, { name: "skills/demo/../../evil.mjs", data: "x" }], /leaves its folder/u, { tree });
  await expectRefused([...base, { name: "/etc/evil", data: "x" }], /is not a relative path/u, { tree });
  await expectRefused([...base, { name: "skills/other/x.md", data: "x" }], /outside the pack folder/u, { tree });
});

test("an archive made from another commit, or with no commit, is refused", async () => {
  const { files, tree } = packFiles("demo");
  await expectRefused(packEntries("demo", files), /made from commit 2{40}, not the pinned 1{40}/u, { tree, commit: "2".repeat(40) });
  await expectRefused(packEntries("demo", files), /made from commit \(none\)/u, { tree, commit: null });
});

test("a manifest that names another pack, or a stale tree hash, is refused", async () => {
  const other = packFiles("other");
  await expectRefused(packEntries("demo", other.files), /names "other"/u, { tree: other.tree });
  const stale = packFiles("demo", { manifest: { tree_sha256: "b".repeat(64) } });
  await expectRefused(packEntries("demo", stale.files), /does not match \.instafy-pack\.json/u, { tree: stale.tree });
  const fresh = packFiles("demo");
  await expectRefused(packEntries("demo", fresh.files), /is not the pinned c{64}/u, {
    tree: fresh.tree,
    overrides: { tree_sha256: "c".repeat(64) },
  });
});

test("oversized packs and decompression bombs are refused", async () => {
  const many = {};
  for (let index = 0; index < 257; index += 1) many[`reference/${index}.md`] = "x";
  const crowded = packFiles("demo", { extra: many });
  await expectRefused(packEntries("demo", crowded.files), /more than 256 files/u, { tree: crowded.tree });
  const heavy = packFiles("demo", { extra: { "big.bin": "y".repeat(8 * 1024 * 1024 + 1) } });
  await expectRefused(packEntries("demo", heavy.files), /more than 8388608 bytes/u, { tree: heavy.tree });
  const bomb = packFiles("demo", { extra: { "a.bin": "z".repeat(6 * 1024 * 1024), "b.bin": "z".repeat(6 * 1024 * 1024), "c.bin": "z".repeat(6 * 1024 * 1024) } });
  await expectRefused(packEntries("demo", bomb.files), /unpacks to more than 16777216 bytes/u, { tree: bomb.tree });
});

test("downloads stay on https and the pin names a release asset", async () => {
  const pin = validatePin(JSON.parse(fs.readFileSync(DEFAULT_PIN, "utf8")));
  assert.ok(pin.packs.length >= 1);
  for (const pack of pin.packs) {
    assert.match(pack.url, /^https:\/\/github\.com\/instafy-dev\/[^/]+\/releases\/download\/v\d+\.\d+\.\d+\//u);
    assert.match(pack.sha256, /^[0-9a-f]{64}$/u);
    assert.match(pack.commit, /^[0-9a-f]{40}$/u);
    assert.match(pack.tree_sha256, /^[0-9a-f]{64}$/u);
  }
  const bad = structuredClone(pin);
  bad.packs[0].url = bad.packs[0].url.replace("https://github.com/instafy-dev/", "https://example.com/instafy-dev/");
  assert.throws(() => validatePin(bad), /url must start with https:\/\/github\.com\/instafy-dev\//u);
  const http = structuredClone(pin);
  http.packs[0].url = http.packs[0].url.replace("https:", "http:");
  assert.throws(() => validatePin(http), /url must start with/u);

  const { files, tree } = packFiles("demo");
  const archive = tarball(packEntries("demo", files));
  await withServer({ "/demo.tar.gz": { redirect: "http://example.com/demo.tar.gz" } }, async (base) => {
    await assert.rejects(install(pinFor("demo", base, archive, tree), tempOut()), /refusing a non-https download: http:\/\/example\.com/u);
  });
});

test("--require-pinned refuses a local pack folder, which is installed unpinned otherwise", () => {
  const source = tempOut();
  const { files } = packFiles("demo");
  for (const [rel, data] of files) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), data);
  }
  const refused = spawnSync(process.execPath, [script, "--require-pinned", "--from", source, "--out", tempOut()], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--require-pinned refuses --from/u);

  const out = tempOut();
  installFromFolder({ from: source, out });
  const installed = JSON.parse(fs.readFileSync(path.join(out, "installed.json"), "utf8"));
  assert.deepEqual(installed.packs.map(({ name, pinned }) => ({ name, pinned })), [{ name: "demo", pinned: false }]);
  fs.symlinkSync("/etc/passwd", path.join(source, "link"));
  assert.throws(() => installFromFolder({ from: source, out: tempOut() }), /links are not allowed/u);
});

const MAP_ACTIVITY = {
  run: {
    "add-point": { live: "Looking up places", done: { one: "looked up a place", other: "looked up {n} places", some: "looked up places" } },
    validate: { live: "Checking the map", done: "built the map", role: "outcome", when: "success" },
    "*": { live: "Working on the map", role: "quiet" },
  },
};

test("activity labels follow the same rules as the runtime and Studio", () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "packages", "runtime-contracts", "src", "chat_activity_fixtures.json"), "utf8"));
  for (const label of fixtures.liveValid) assert.ok(isLiveLabel(label), label);
  for (const label of fixtures.liveInvalid) assert.ok(!isLiveLabel(label), label);
  for (const label of fixtures.doneValid) assert.ok(isDoneForm(label, false), label);
  for (const label of fixtures.doneInvalid) assert.ok(!isDoneForm(label, false), label);
  for (const label of fixtures.doneCountValid) assert.ok(isDoneForm(label, true), label);
  for (const label of fixtures.doneCountInvalid) assert.ok(!isDoneForm(label, true), label);
});

test("a pack's activity labels name its bin commands and break no rule", () => {
  const files = new Map([["scripts/run.mjs", Buffer.from("")]]);
  const manifest = (overrides) => ({ bin: { run: "scripts/run.mjs" }, activity: MAP_ACTIVITY, ...overrides });
  assert.equal(checkPackActivity(manifest({}), files), null);
  assert.equal(checkPackActivity({}, files), null, "a pack without labels");
  for (const [overrides, pattern] of [
    [{ bin: undefined }, /only commands declared in `bin`/u],
    [{ bin: { git: "scripts/run.mjs" }, activity: { git: MAP_ACTIVITY.run } }, /not a command name/u],
    [{ bin: { run: "scripts/missing.mjs" } }, /not a file inside the pack/u],
    [{ activity: { other: MAP_ACTIVITY.run } }, /not a command in `bin`/u],
    [{ activity: { run: { "add-point": { live: "Visit example.com", done: "looked up a place" } } } }, /live breaks/u],
    [{ activity: { run: { "add-point": { live: "Looking up places", done: "see https://example.com" } } } }, /done breaks/u],
    [{ activity: { run: { "add-point": { live: "Looking up places", done: { one: "looked up a place", other: "looked up {n} places" } } } } }, /`some` form/u],
    [{ activity: { run: { "add-point": { live: "Looking up places", done: { one: "a", other: "looked up places", some: "b" } } } } }, /done.other/u],
    [{ activity: { run: { "add-point": { live: "Looking up places" } } } }, /needs done words/u],
    [{ activity: { run: { "Add Point": { live: "Working", role: "quiet" } } } }, /not a subcommand name/u],
  ]) {
    assert.match(checkPackActivity(manifest(overrides), files) ?? "", pattern, JSON.stringify(overrides));
  }
});

test("a pack whose activity labels break a rule still installs, with a warning", () => {
  for (const [activity, warned] of [[MAP_ACTIVITY, false], [{ run: { "*": { live: "Open example.com", role: "quiet" } } }, true]]) {
    const source = tempOut();
    const { files } = packFiles("demo", { manifest: { bin: { run: "scripts/run.mjs" }, activity } });
    for (const [rel, data] of files) {
      fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
      fs.writeFileSync(path.join(source, rel), data);
    }
    const lines = [];
    const out = tempOut();
    assert.deepEqual(installFromFolder({ from: source, out, log: (line) => lines.push(line) }).map(({ status }) => status), ["installed"]);
    assert.ok(fs.existsSync(path.join(out, "demo", MANIFEST)));
    assert.equal(lines.some((line) => /activity labels break the label rules/u.test(line)), warned, lines.join("\n"));
  }
});
