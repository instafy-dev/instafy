import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadProofRoute, readServedAssets, readSyncedProofAssets } from "./android-debug-ota-proof.mjs";

function fixture(t, { separateProviders = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-asset-proof-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(root, "index.html"), '<script type="module" crossorigin src="/assets/index-entry.js"></script>');
  fs.writeFileSync(path.join(assets, "index-entry.js"), 'console.log("entry");');
  fs.writeFileSync(path.join(assets, "StudioRoute-route.js"), 'export const route = "studio";');
  // Other packages can also emit index chunks; they are not the app entry.
  fs.writeFileSync(path.join(assets, "index-plugin.js"), 'export const plugin = true;');
  if (separateProviders) {
    fs.writeFileSync(path.join(assets, "StudioProviders-lazy.js"), 'throw new Error("Do not execute providers during asset proof");');
  }
  return { root, assets, proof: readSyncedProofAssets(assets) };
}

function pageFixture(proof, { observed = ["index-entry.js"], responses = {} } = {}) {
  const origin = "https://localhost";
  const entries = observed.map((file) => ({ name: `${origin}/assets/${file}`, initiatorType: "script" }));
  const requests = [];
  const timers = new Set();
  const context = vm.createContext({
    URL, Uint8Array, AbortController,
    location: { origin },
    performance: { getEntriesByType: () => entries },
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    setTimeout: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      entries.push({ name: url, initiatorType: "fetch" });
      const file = new URL(url).pathname.split("/").pop();
      const override = responses[file];
      const status = override?.status ?? 200;
      const bytes = Buffer.from(override?.bytes ?? proof.find((asset) => asset.file === file)?.syncedBytes ?? "missing");
      return {
        ok: status >= 200 && status < 300,
        status,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
  });
  const execute = (callback, argument) => vm.runInContext(`(${callback.toString()})`, context)(argument);
  let currentUrl = `${origin}/login`;
  return {
    requests, entries, timers,
    url: () => currentUrl,
    goto: async (url) => {
      assert.equal(url, `${origin}/studio`);
      // The auth guard redirects without ever requesting the provider chunk.
      currentUrl = `${origin}/login?redirect=%2Fstudio`;
    },
    waitForFunction: async (callback, argument) => {
      assert.equal(await execute(callback, argument), true, "The expected entry was not observed as a script.");
    },
    evaluate: async (callback, argument) => JSON.parse(JSON.stringify(await execute(callback, argument))),
  };
}

test("the synced HTML identifies the app entry among other index chunks", (t) => {
  const { proof } = fixture(t);
  assert.deepEqual(proof.map(({ role, file }) => ({ role, file })), [
    { role: "index", file: "index-entry.js" },
    { role: "StudioRoute", file: "StudioRoute-route.js" },
  ]);
});

test("signed-out routing verifies a lazy provider asset without requiring or executing it", async (t) => {
  const { proof } = fixture(t, { separateProviders: true });
  const page = pageFixture(proof);
  await loadProofRoute(page, proof);
  assert.match(page.url(), /\/login\?/u);
  const assets = await readServedAssets(page, proof);
  assert.equal(assets.length, 3);
  for (const asset of assets) {
    const expected = proof.find((entry) => entry.file === asset.file);
    assert.equal(asset.sha256, crypto.createHash("sha256").update(expected.syncedBytes).digest("hex"));
    assert.equal(asset.observedBeforeProbe, asset.role === "index");
  }
  for (const { url, options } of page.requests) {
    assert.match(url, /^https:\/\/localhost\/assets\//u);
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(page.timers.size, 0);
});

test("a bundled-provider build proves both emitted entry and StudioRoute assets", async (t) => {
  const { proof } = fixture(t);
  const page = pageFixture(proof, { observed: ["index-entry.js", "StudioRoute-route.js"] });
  await loadProofRoute(page, proof);
  const assets = await readServedAssets(page, proof);
  assert.equal(assets.length, 2);
  assert.ok(assets.every((asset) => asset.observedBeforeProbe));
});

test("a previous explicit probe does not become evidence that a lazy resource loaded", async (t) => {
  const { proof } = fixture(t, { separateProviders: true });
  const page = pageFixture(proof);
  await readServedAssets(page, proof);
  const second = await readServedAssets(page, proof);
  assert.equal(second.find((asset) => asset.role === "StudioProviders").observedBeforeProbe, false);
});

test("an unrelated index script or an explicit fetch cannot substitute for the loaded app entry", async (t) => {
  const { proof } = fixture(t);
  const page = pageFixture(proof, { observed: ["index-plugin.js"] });
  page.entries.push({ name: "https://localhost/assets/index-entry.js", initiatorType: "fetch" });
  await assert.rejects(loadProofRoute(page, proof), /expected entry was not observed/u);
});

test("an emitted but missing lazy provider response fails instead of being skipped", async (t) => {
  const { proof } = fixture(t, { separateProviders: true });
  const page = pageFixture(proof, { responses: { "StudioProviders-lazy.js": { status: 404 } } });
  await assert.rejects(readServedAssets(page, proof), /StudioProviders-lazy.js: 404/u);
  assert.equal(page.timers.size, 0);
});

test("wrong bytes and an HTML fallback response fail exact asset comparison", async (t) => {
  const { proof } = fixture(t);
  for (const bytes of ["old bundle bytes", "<!doctype html><title>Instafy</title>"]) {
    const page = pageFixture(proof, { responses: { "StudioRoute-route.js": { bytes } } });
    await assert.rejects(readServedAssets(page, proof), /not byte-identical/u);
    assert.equal(page.timers.size, 0);
  }
});

test("missing or ambiguous synced route files fail before contacting a device", (t) => {
  const { assets } = fixture(t);
  fs.rmSync(path.join(assets, "StudioRoute-route.js"));
  assert.throws(() => readSyncedProofAssets(assets), /exactly one synced StudioRoute/u);
  fs.writeFileSync(path.join(assets, "StudioRoute-one.js"), "one");
  fs.writeFileSync(path.join(assets, "StudioRoute-two.js"), "two");
  assert.throws(() => readSyncedProofAssets(assets), /exactly one synced StudioRoute/u);
});

test("missing entry bytes and stale duplicated provider chunks fail", (t) => {
  const { assets } = fixture(t, { separateProviders: true });
  fs.writeFileSync(path.join(assets, "StudioProviders-stale.js"), "stale");
  assert.throws(() => readSyncedProofAssets(assets), /Multiple synced StudioProviders/u);
  fs.rmSync(path.join(assets, "StudioProviders-stale.js"));
  fs.rmSync(path.join(assets, "index-entry.js"));
  assert.throws(() => readSyncedProofAssets(assets), /ENOENT/u);
});

test("a missing referenced provider chunk is not mistaken for a bundled-provider build", (t) => {
  const { assets } = fixture(t);
  fs.writeFileSync(path.join(assets, "StudioRoute-route.js"), 'const providers = () => import("./StudioProviders-missing.js");');
  assert.throws(() => readSyncedProofAssets(assets), /Referenced StudioProviders asset StudioProviders-missing.js is missing/u);
});

test("both phases compare against the same synced byte snapshot", async (t) => {
  const { assets, proof } = fixture(t);
  fs.writeFileSync(path.join(assets, "StudioRoute-route.js"), "a later concurrent build");
  const page = pageFixture(proof);
  const initial = await readServedAssets(page, proof);
  const relaunch = await readServedAssets(pageFixture(proof), proof);
  assert.deepEqual(relaunch, initial);
});

test("the CLI help runs through an absolute path or symlink without accessing a device", (t) => {
  const { root } = fixture(t);
  const script = fileURLToPath(new URL("./android-debug-ota-proof.mjs", import.meta.url));
  const alias = path.join(root, "proof-alias.mjs");
  fs.symlinkSync(script, alias);
  for (const invokedPath of [script, alias]) {
    const output = execFileSync(process.execPath, [invokedPath, "--help"], {
      encoding: "utf8", env: { ...process.env, ANDROID_ADB: "/nonexistent-adb" },
    });
    assert.match(output, /Usage: node scripts\/android-debug-ota-proof.mjs/u);
  }
});
