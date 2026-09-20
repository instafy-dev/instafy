import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT, verifyLiveFeed } from "./verify-live-feed.mjs";

const BASE = "https://downloads.instafy.dev";
const OTA_TAG = "ota-v8ddffed21d44";

function liveRoutes(overrides = {}) {
  const contractHeaders = { "x-instafy-downloads-contract": CONTRACT };
  return {
    [`GET ${BASE}/desktop-app/latest.json`]: () =>
      Response.json({ tag: "desktop-app-v0.2.12", version: "0.2.12", channel: "stable" }, { headers: contractHeaders }),
    [`GET ${BASE}/desktop-app/stable/latest-mac.yml`]: () => new Response("version: 0.2.12\n"),
    [`GET ${BASE}/desktop-app/stable-pointer-contract.json`]: () =>
      Response.json({ schemaVersion: 1, stableAliases: "immutable-pointer" }, { headers: contractHeaders }),
    [`GET ${BASE}/desktop-app/stable-release.json`]: () => new Response("Not found", { status: 404 }),
    [`HEAD ${BASE}/mobile/${OTA_TAG}.manifest.json`]: () =>
      new Response(null, { headers: { "cache-control": "public, max-age=31536000, immutable" } }),
    ...overrides,
  };
}

function stub(routes, calls = []) {
  return async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    return routes[key] ? routes[key]() : new Response("missing", { status: 404 });
  };
}

test("a healthy live feed passes, including the newest OTA manifest", async () => {
  const calls = [];
  const result = await verifyLiveFeed({ latestOtaTag: OTA_TAG, fetchImpl: stub(liveRoutes(), calls), log: () => {} });
  assert.deepEqual(result, { desktopTag: "desktop-app-v0.2.12", otaManifest: `mobile/${OTA_TAG}.manifest.json` });
  assert.equal(calls.length, 5);
});

test("without an OTA release the mobile check is skipped", async () => {
  const calls = [];
  await verifyLiveFeed({ fetchImpl: stub(liveRoutes(), calls), log: () => {} });
  assert.equal(calls.some((call) => call.includes("/mobile/")), false);
});

test("contract regressions fail closed", async () => {
  const run = (overrides, extra = {}) => verifyLiveFeed({ fetchImpl: stub(liveRoutes(overrides)), log: () => {}, ...extra });
  await assert.rejects(run({ [`GET ${BASE}/desktop-app/latest.json`]: () => Response.json({ tag: "desktop-app-v0.2.12", version: "0.2.12" }) }), /contract header/u);
  await assert.rejects(
    run({ [`GET ${BASE}/desktop-app/latest.json`]: () => Response.json({ tag: "desktop-app-v0.2.11", version: "0.2.12" }, { headers: { "x-instafy-downloads-contract": CONTRACT } }) }),
    /does not match its version/u,
  );
  await assert.rejects(run({ [`GET ${BASE}/desktop-app/stable/latest-mac.yml`]: () => new Response("", { status: 503 }) }), /latest-mac\.yml returned 503/u);
  await assert.rejects(run({ [`GET ${BASE}/desktop-app/stable-pointer-contract.json`]: () => Response.json({ schemaVersion: 2 }) }), /immutable-pointer/u);
  await assert.rejects(run({ [`GET ${BASE}/desktop-app/stable-release.json`]: () => Response.json({ tag: "x" }) }), /must not be publicly served/u);
  await assert.rejects(
    run({ [`HEAD ${BASE}/mobile/${OTA_TAG}.manifest.json`]: () => new Response(null, { headers: { "cache-control": "no-store" } }) }, { latestOtaTag: OTA_TAG }),
    /immutable object/u,
  );
  await assert.rejects(run({}, { latestOtaTag: "ota-internal" }), /not an ota-v tag/u);
  await assert.rejects(run({}, { baseUrl: "http://downloads.instafy.dev" }), /credential-free HTTPS/u);
});
