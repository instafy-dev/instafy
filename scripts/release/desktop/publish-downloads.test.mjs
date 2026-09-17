import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const laneDir = import.meta.dirname;
const scriptsDir = path.resolve(laneDir, "..", "..");
const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";
const VERSION = "0.2.13";
const TAG = `desktop-app-v${VERSION}`;
const PUBLISHED_AT = "2026-09-16T08:00:00Z";

const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [, , , , action, , target, , file, ...rest] = process.argv;
const key = target.slice(target.indexOf("/") + 1);
const stored = path.join(process.env.FAKE_STORE, key);
const options = {};
for (let i = 0; i < rest.length; i += 2) options[rest[i]] = rest[i + 1];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "wrangler", action, key, cache: options["--cache-control"], type: options["--content-type"] }) + "\\n");
if (action === "get") {
  if (process.env.FAKE_GET_ERROR === key) { console.error("fetch failed"); process.exit(1); }
  if (!fs.existsSync(stored)) { console.error("The specified key does not exist."); process.exit(1); }
  fs.copyFileSync(stored, file);
} else if (action === "put") {
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.copyFileSync(file, stored);
} else if (action === "delete") {
  fs.rmSync(stored, { force: true });
}
`;

const FAKE_GH = `#!/usr/bin/env node
const route = process.argv[3];
if (route.includes("/git/ref/tags/")) {
  if (!process.env.FAKE_TAG_SHA) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
  console.log("commit " + process.env.FAKE_TAG_SHA);
} else if (route.includes("/compare/")) {
  console.log(process.env.FAKE_COMPARE || "ahead");
} else if (route.includes("/releases/tags/")) {
  if (process.env.FAKE_RELEASE_EXISTS) { console.log("{}"); process.exit(0); }
  console.error("gh: Not Found (HTTP 404)"); process.exit(1);
} else { process.exit(2); }
`;

const FAKE_CURL = `#!/bin/sh
if [ -n "$FAKE_CONTRACT" ]; then printf '%s' "$FAKE_CONTRACT"; else printf '%s' '{"schemaVersion":1,"stableAliases":"immutable-pointer"}'; fi
`;

const FAKE_VERIFY = `import fs from "node:fs";
const phase = process.env.DESKTOP_PUBLICATION_PHASE;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "verify", phase }) + "\\n");
if (process.env.FAKE_FAIL_PHASE === phase) process.exit(1);
`;

function setup() {
  // Real path: the metadata script only runs as main when argv matches its real path.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-publish-")));
  const repo = path.join(root, "repo");
  const lane = path.join(repo, "scripts", "release", "desktop");
  fs.mkdirSync(lane, { recursive: true });
  for (const name of ["publish-downloads.sh", "release-artifacts.mjs"]) {
    fs.copyFileSync(path.join(laneDir, name), path.join(lane, name));
  }
  fs.copyFileSync(path.join(scriptsDir, "create-desktop-release-metadata.mjs"), path.join(repo, "scripts", "create-desktop-release-metadata.mjs"));
  fs.writeFileSync(path.join(repo, "scripts", "verify-desktop-publication.mjs"), FAKE_VERIFY);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const [name, body] of [["wrangler", FAKE_WRANGLER], ["gh", FAKE_GH], ["curl", FAKE_CURL]]) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  const artifacts = path.join(root, "artifacts");
  fs.mkdirSync(artifacts);
  for (const name of [`instafy-${VERSION}-mac-arm64.dmg`, `instafy-${VERSION}-mac-arm64.dmg.blockmap`, `instafy-${VERSION}-mac-arm64.zip`, `instafy-${VERSION}-mac-arm64.zip.blockmap`, "latest-mac.yml"]) {
    fs.writeFileSync(path.join(artifacts, name), `bytes of ${name}`);
  }
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  return { root, repo, bin, artifacts, store, log: path.join(root, "log.jsonl") };
}

function pointerBytes(version, sha = SHA) {
  return `${JSON.stringify({ schemaVersion: 1, channel: "stable", tag: `desktop-app-v${version}`, version, sourceSha: sha, publishedAt: "2026-08-01T00:00:00Z" }, null, 2)}\n`;
}

function publish(ctx, extraEnv = {}, args = []) {
  fs.rmSync(ctx.log, { force: true });
  const output = path.join(ctx.root, `output-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", [path.join(ctx.repo, "scripts", "release", "desktop", "publish-downloads.sh"), ...args], {
    encoding: "utf8",
    env: {
      PATH: `${ctx.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      WRANGLER: path.join(ctx.bin, "wrangler"),
      DOWNLOADS_BUCKET: "instafy-downloads",
      DOWNLOADS_BASE_URL: "https://downloads.instafy.dev/",
      DESKTOP_DOWNLOADS_PREFIX: "desktop-app",
      TAG,
      VERSION,
      SOURCE_SHA: SHA,
      RELEASE_PUBLISHED_AT: PUBLISHED_AT,
      ARTIFACT_DIR: ctx.artifacts,
      WORK_DIR: path.join(ctx.root, "work"),
      GITHUB_REPOSITORY: "instafy-dev/instafy",
      GH_TOKEN: "fake",
      CLOUDFLARE_API_TOKEN: "fake",
      CLOUDFLARE_ACCOUNT_ID: "fake",
      GITHUB_OUTPUT: output,
      FAKE_STORE: ctx.store,
      FAKE_LOG: ctx.log,
      FAKE_TAG_SHA: SHA,
      ...extraEnv,
    },
  });
  const log = fs.existsSync(ctx.log)
    ? fs.readFileSync(ctx.log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { ...result, log, output: fs.readFileSync(output, "utf8") };
}

const writes = (log) => log.filter((entry) => entry.action === "put" || entry.action === "delete" || entry.tool === "verify")
  .map((entry) => (entry.tool === "verify" ? `verify:${entry.phase}` : `${entry.action}:${entry.key}:${entry.cache ?? ""}`));

function withCtx(fn) {
  const ctx = setup();
  try {
    fn(ctx);
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const CHANNEL = "public, max-age=120";

test("first release publishes payloads, feeds, candidate, pointer, publication in order", () => {
  withCtx((ctx) => {
    const result = publish(ctx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const prefix = `desktop-app/${TAG}`;
    const pair = (name) => [`put:${prefix}/${name}:${IMMUTABLE}`, `put:desktop-app/stable/${name}:${CHANNEL}`];
    assert.deepEqual(writes(result.log), [
      ...pair(`instafy-${VERSION}-mac-arm64.dmg`),
      ...pair(`instafy-${VERSION}-mac-arm64.zip`),
      ...pair(`instafy-${VERSION}-mac-arm64.dmg.blockmap`),
      ...pair(`instafy-${VERSION}-mac-arm64.zip.blockmap`),
      ...pair("latest-mac.yml"),
      ...pair("latest.json"),
      `put:desktop-app/latest.json:${CHANNEL}`,
      "verify:candidate",
      "put:desktop-app/stable-release.json:no-store",
      "verify:publication",
    ]);
    const types = Object.fromEntries(result.log.filter((e) => e.action === "put").map((e) => [path.basename(e.key), e.type]));
    assert.equal(types[`instafy-${VERSION}-mac-arm64.dmg`], "application/x-apple-diskimage");
    assert.equal(types[`instafy-${VERSION}-mac-arm64.zip`], "application/zip");
    assert.equal(types["latest-mac.yml"], "text/yaml");
    assert.equal(types["latest.json"], "application/json");
    assert.equal(types[`instafy-${VERSION}-mac-arm64.zip.blockmap`], "application/octet-stream");
    const latest = JSON.parse(fs.readFileSync(path.join(ctx.store, "desktop-app", "latest.json"), "utf8"));
    assert.equal(latest.feedUrl, "https://downloads.instafy.dev/desktop-app/stable");
    assert.deepEqual(latest.artifacts, {
      macDmg: `https://downloads.instafy.dev/desktop-app/stable/instafy-${VERSION}-mac-arm64.dmg`,
      macZip: `https://downloads.instafy.dev/desktop-app/stable/instafy-${VERSION}-mac-arm64.zip`,
    });
    assert.equal(Object.hasOwn(latest.artifacts, "windowsExe"), false);
    assert.match(result.output, /^previous_stable_version=$/mu);
  });
});

test("a newer release replaces the prior pointer and reports its version", () => {
  withCtx((ctx) => {
    fs.mkdirSync(path.join(ctx.store, "desktop-app"), { recursive: true });
    fs.writeFileSync(path.join(ctx.store, "desktop-app", "stable-release.json"), pointerBytes("0.2.12"));
    const result = publish(ctx);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.output, /^previous_stable_version=0\.2\.12$/mu);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.store, "desktop-app", "stable-release.json"), "utf8")).tag, TAG);
  });
});

test("a non-newer live pointer, moved tag, lost ancestry or existing Release writes nothing", () => {
  const cases = [
    [{}, (ctx) => {
      fs.mkdirSync(path.join(ctx.store, "desktop-app"), { recursive: true });
      fs.writeFileSync(path.join(ctx.store, "desktop-app", "stable-release.json"), pointerBytes("0.2.14"));
    }, /newer|transition|must be/iu],
    [{ FAKE_TAG_SHA: "0".repeat(40) }, () => {}, /no longer resolves/u],
    [{ FAKE_COMPARE: "diverged" }, () => {}, /no longer contains/u],
    [{ FAKE_RELEASE_EXISTS: "1" }, () => {}, /already exists/u],
    [{ FAKE_CONTRACT: "{}" }, () => {}, /stable-pointer contract/u],
    [{ FAKE_GET_ERROR: "desktop-app/stable-release.json" }, () => {}, /prove absence/u],
  ];
  for (const [env, prepare, pattern] of cases) {
    withCtx((ctx) => {
      prepare(ctx);
      const result = publish(ctx, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, pattern);
      assert.deepEqual(writes(result.log), []);
    });
  }
});

test("immutable objects are never overwritten with different bytes", () => {
  withCtx((ctx) => {
    const key = path.join(ctx.store, "desktop-app", TAG, `instafy-${VERSION}-mac-arm64.dmg`);
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, "different bytes");
    const result = publish(ctx);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Refusing to overwrite immutable desktop-app\/desktop-app-v0\.2\.13\/instafy-0\.2\.13-mac-arm64\.dmg/u);
    assert.equal(writes(result.log).some((entry) => entry.includes("stable-release.json")), false);
  });
});

test("failed publication verification restores the prior pointer, and a re-run reuses identical bytes", () => {
  withCtx((ctx) => {
    const pointerPath = path.join(ctx.store, "desktop-app", "stable-release.json");
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    fs.writeFileSync(pointerPath, pointerBytes("0.2.12"));
    const failed = publish(ctx, { FAKE_FAIL_PHASE: "publication" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /Restored the exact prior stable pointer/u);
    assert.equal(fs.readFileSync(pointerPath, "utf8"), pointerBytes("0.2.12"));
    const rerun = publish(ctx);
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.match(rerun.stdout, /Reusing byte-identical desktop-app\/desktop-app-v0\.2\.13\/instafy-0\.2\.13-mac-arm64\.dmg/u);
  });
});

test("failed verification of a first pointer deletes it", () => {
  withCtx((ctx) => {
    const result = publish(ctx, { FAKE_FAIL_PHASE: "publication" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Deleted the first stable pointer/u);
    assert.equal(fs.existsSync(path.join(ctx.store, "desktop-app", "stable-release.json")), false);
  });
});

test("a re-run after the pointer was selected skips the pointer write", () => {
  withCtx((ctx) => {
    assert.equal(publish(ctx).status, 0);
    const rerun = publish(ctx, { PREVIOUS_STABLE_HINT: "0.2.12" });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.match(rerun.stdout, /already selects desktop-app-v0\.2\.13/u);
    assert.equal(writes(rerun.log).includes("put:desktop-app/stable-release.json:no-store"), false);
    assert.deepEqual(writes(rerun.log).slice(-2), ["verify:candidate", "verify:publication"]);
    assert.match(rerun.output, /^previous_stable_version=0\.2\.12$/mu);
  });
});

test("recheck-only mode checks authority without touching R2", () => {
  withCtx((ctx) => {
    const ok = publish(ctx, { WRANGLER: "", CLOUDFLARE_API_TOKEN: "" }, ["--recheck-only"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.deepEqual(ok.log, []);
    const moved = publish(ctx, { FAKE_TAG_SHA: "1".repeat(40) }, ["--recheck-only"]);
    assert.notEqual(moved.status, 0);
    assert.match(moved.stdout, /no longer resolves/u);
    const released = publish(ctx, { FAKE_RELEASE_EXISTS: "1" }, ["--recheck-only"]);
    assert.notEqual(released.status, 0);
    assert.equal(publish(ctx, {}, ["--publish-everything"]).status, 1);
  });
});
