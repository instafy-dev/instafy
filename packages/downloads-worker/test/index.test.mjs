import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.ts";

function createObject(body = "payload", contentType = "application/octet-stream") {
  const bytes = new TextEncoder().encode(body);
  return {
    _bytes: bytes,
    body: bytes,
    httpEtag: '"fixture-etag"',
    size: bytes.byteLength,
    uploaded: new Date("2026-07-21T12:00:00Z"),
    writeHttpMetadata(headers) {
      headers.set("content-type", contentType);
    },
  };
}

function createEnv(objects, options = {}) {
  const requestedKeys = [];
  const requestedRanges = [];
  const desktopPrefix = Object.hasOwn(options, "desktopPrefix")
    ? options.desktopPrefix
    : "desktop-app";
  const mobilePrefix = Object.hasOwn(options, "mobilePrefix")
    ? options.mobilePrefix
    : "mobile";
  return {
    requestedKeys,
    requestedRanges,
    env: {
      ...(typeof desktopPrefix === "string" ? { DESKTOP_DOWNLOADS_PREFIX: desktopPrefix } : {}),
      ...(typeof mobilePrefix === "string"
        ? { MOBILE_OTA_DOWNLOADS_PREFIX: mobilePrefix }
        : {}),
      DOWNLOADS_BUCKET: {
        async head(key) {
          requestedKeys.push(key);
          const object = objects.get(key);
          if (!object) return null;
          const { body: _body, _bytes, ...metadata } = object;
          return metadata;
        },
        async get(key, options = {}) {
          requestedKeys.push(key);
          const object = objects.get(key);
          if (!object) return null;
          if (!options.range) return object;
          requestedRanges.push(options.range);
          const { offset, length } = options.range;
          return {
            ...object,
            body: object._bytes.slice(offset, offset + length),
            range: { offset, length },
          };
        },
      },
    },
  };
}

const POINTER_KEY = "desktop-app/stable-release.json";
const RELEASE_TAG = "desktop-app-v1.2.3";

function pointerObject(overrides = {}) {
  return createObject(
    JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      tag: RELEASE_TAG,
      version: "1.2.3",
      sourceSha: "a".repeat(40),
      publishedAt: "2026-07-21T12:00:00Z",
      ...overrides,
    }),
    "application/json",
  );
}

test("serves updater metadata with short caching and ignores cache-busting queries", async () => {
  const { env, requestedKeys } = createEnv(
    new Map([
      [POINTER_KEY, pointerObject()],
      [`desktop-app/${RELEASE_TAG}/latest-mac.yml`, createObject("version: 1.2.3", "text/yaml")],
      ["desktop-app/stable/latest-mac.yml", createObject("legacy mixed feed", "text/yaml")],
    ]),
  );
  const response = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/latest-mac.yml?publication=123"),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(requestedKeys, [POINTER_KEY, `desktop-app/${RELEASE_TAG}/latest-mac.yml`]);
  assert.equal(response.headers.get("cache-control"), "public, max-age=120");
  assert.equal(response.headers.get("content-type"), "text/yaml");
  assert.equal(response.headers.get("etag"), '"fixture-etag"');
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "14");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-instafy-desktop-release"), RELEASE_TAG);
  assert.equal(response.headers.get("x-instafy-downloads-contract"), "desktop-stable-pointer-v1");
  assert.equal(await response.text(), "version: 1.2.3");
});

test("stable and public latest aliases resolve one immutable release and ignore legacy objects", async () => {
  const latest = createObject('{"version":"1.2.3","channel":"stable"}', "application/json");
  const { env, requestedKeys } = createEnv(
    new Map([
      [POINTER_KEY, pointerObject()],
      [`desktop-app/${RELEASE_TAG}/latest.json`, latest],
      ["desktop-app/latest.json", createObject('{"version":"0.1.2"}', "application/json")],
      ["desktop-app/stable/latest.json", createObject('{"version":"0.1.1"}', "application/json")],
    ]),
  );

  const stable = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/latest.json"),
    env,
  );
  const publicAlias = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/latest.json"),
    env,
  );

  assert.equal(await stable.text(), '{"version":"1.2.3","channel":"stable"}');
  assert.equal(await publicAlias.text(), '{"version":"1.2.3","channel":"stable"}');
  assert.equal(stable.headers.get("x-instafy-desktop-release"), RELEASE_TAG);
  assert.equal(publicAlias.headers.get("x-instafy-desktop-release"), RELEASE_TAG);
  assert.deepEqual(requestedKeys, [
    POINTER_KEY,
    `desktop-app/${RELEASE_TAG}/latest.json`,
    POINTER_KEY,
    `desktop-app/${RELEASE_TAG}/latest.json`,
  ]);
});

test("configured prefixes own desktop aliases and mobile immutable cache behavior", async () => {
  const prefix = "products/desktop";
  const mobilePrefix = "products/mobile";
  const pointerKey = `${prefix}/stable-release.json`;
  const immutableLatestKey = `${prefix}/${RELEASE_TAG}/latest.json`;
  const immutableFeedKey = `${prefix}/${RELEASE_TAG}/latest-mac.yml`;
  const mobileBundleKey = `${mobilePrefix}/2026.07.22.zip`;
  const { env, requestedKeys } = createEnv(
    new Map([
      [pointerKey, pointerObject()],
      [immutableLatestKey, createObject('{"version":"1.2.3"}', "application/json")],
      [immutableFeedKey, createObject("version: 1.2.3", "text/yaml")],
      [mobileBundleKey, createObject("mobile bundle", "application/zip")],
    ]),
    { desktopPrefix: prefix, mobilePrefix },
  );

  const contract = await worker.fetch(
    new Request(`https://downloads.example.test/${prefix}/stable-pointer-contract.json`),
    env,
  );
  const latest = await worker.fetch(
    new Request(`https://downloads.example.test/${prefix}/latest.json`),
    env,
  );
  const stableFeed = await worker.fetch(
    new Request(`https://downloads.example.test/${prefix}/stable/latest-mac.yml`),
    env,
  );
  const mobileBundle = await worker.fetch(
    new Request(`https://downloads.example.test/${mobileBundleKey}`),
    env,
  );

  assert.equal(contract.status, 200);
  assert.equal(await latest.text(), '{"version":"1.2.3"}');
  assert.equal(latest.headers.get("x-instafy-desktop-release"), RELEASE_TAG);
  assert.equal(await stableFeed.text(), "version: 1.2.3");
  assert.equal(
    mobileBundle.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.deepEqual(requestedKeys, [
    pointerKey,
    immutableLatestKey,
    pointerKey,
    immutableFeedKey,
    mobileBundleKey,
  ]);
  assert.equal(requestedKeys.some((key) => key.startsWith("desktop-app/")), false);
  assert.equal(requestedKeys.some((key) => key.startsWith("mobile/")), false);
});

test("missing or unsafe configured prefixes fail closed without reading R2", async () => {
  for (const options of [
    { desktopPrefix: "../desktop" },
    { mobilePrefix: "mobile//ota" },
    { desktopPrefix: undefined },
    { mobilePrefix: undefined },
    { desktopPrefix: "products", mobilePrefix: "products/mobile" },
    { desktopPrefix: "products/desktop", mobilePrefix: "products" },
    { desktopPrefix: "products", mobilePrefix: "products" },
  ]) {
    const { env, requestedKeys } = createEnv(new Map(), options);
    const response = await worker.fetch(
      new Request("https://downloads.example.test/desktop/latest.json"),
      env,
    );

    assert.equal(response.status, 500, JSON.stringify(options));
    assert.equal(response.headers.get("cache-control"), "no-store", JSON.stringify(options));
    assert.equal(response.headers.get("access-control-allow-origin"), "*", JSON.stringify(options));
    assert.match(
      response.headers.get("access-control-expose-headers") ?? "",
      /X-Instafy-Downloads-Contract/i,
      JSON.stringify(options),
    );
    assert.equal(
      response.headers.get("x-instafy-downloads-contract"),
      "desktop-stable-pointer-v1",
      JSON.stringify(options),
    );
    assert.deepEqual(requestedKeys, [], JSON.stringify(options));
  }
});

test("missing pointer makes JSON manifests quietly unavailable while invalid pointers fail", async () => {
  const missingEnv = createEnv(
    new Map([["desktop-app/latest.json", createObject('{"version":"0.1.2"}', "application/json")]]),
  );
  const invalidEnv = createEnv(
    new Map([
      [POINTER_KEY, pointerObject({ tag: "desktop-app-v0.1.2" })],
      ["desktop-app/stable/latest.json", createObject("legacy")],
    ]),
  );

  const missing = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/latest.json"),
    missingEnv.env,
  );
  const invalid = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/latest.json"),
    invalidEnv.env,
  );

  assert.equal(missing.status, 204);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(invalid.status, 503);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  assert.deepEqual(missingEnv.requestedKeys, [POINTER_KEY]);
  assert.deepEqual(invalidEnv.requestedKeys, [POINTER_KEY]);
});

test("missing pointer keeps updater feeds and unknown stable files at 404", async () => {
  const { env, requestedKeys } = createEnv(new Map());
  const feed = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/latest-mac.yml"),
    env,
  );
  const missing = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/missing.exe"),
    env,
  );

  assert.equal(feed.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(feed.headers.get("cache-control"), "no-store");
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(requestedKeys, [POINTER_KEY, POINTER_KEY]);
});

test("rejects non-canonical numeric prerelease identifiers in stable pointers", async () => {
  const version = "1.2.3-01";
  const { env, requestedKeys } = createEnv(
    new Map([
      [
        POINTER_KEY,
        pointerObject({ version, tag: `desktop-app-v${version}` }),
      ],
    ]),
  );

  const response = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/latest.json"),
    env,
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(requestedKeys, [POINTER_KEY]);
});

test("exposes a non-publishing contract probe while keeping the pointer private", async () => {
  const { env, requestedKeys } = createEnv(new Map([[POINTER_KEY, pointerObject()]]));
  const contract = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable-pointer-contract.json"),
    env,
  );
  const pointer = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable-release.json"),
    env,
  );

  assert.deepEqual(await contract.json(), {
    schemaVersion: 1,
    stableAliases: "immutable-pointer",
  });
  assert.equal(contract.headers.get("cache-control"), "no-store");
  assert.equal(pointer.status, 404);
  assert.deepEqual(requestedKeys, []);
});

test("serves immutable versioned installers as attachments", async () => {
  const key = "desktop-app/desktop-app-v1.2.3/instafy-studio-1.2.3-win.exe";
  const { env } = createEnv(new Map([[key, createObject("installer")]]));
  const response = await worker.fetch(new Request(`https://downloads.instafy.dev/${key}`), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="instafy-studio-1.2.3-win.exe"',
  );
});

test("HEAD exposes artifact metadata without a response body", async () => {
  const publicKey = "desktop-app/stable/instafy-studio-1.2.3-mac-arm64.zip.blockmap";
  const storageKey = `desktop-app/${RELEASE_TAG}/instafy-studio-1.2.3-mac-arm64.zip.blockmap`;
  const { env, requestedKeys } = createEnv(new Map([[storageKey, createObject("blockmap")]]));
  const response = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${publicKey}`, { method: "HEAD" }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), "8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="instafy-studio-1.2.3-mac-arm64.zip.blockmap"');
  assert.equal(response.headers.get("x-instafy-desktop-release"), RELEASE_TAG);
  assert.deepEqual(requestedKeys, [storageKey]);
});

test("serves a standards-correct explicit single byte range", async () => {
  const key = "desktop-app/desktop-app-v1.2.3/instafy-studio-1.2.3-win.exe";
  const { env, requestedKeys, requestedRanges } = createEnv(new Map([[key, createObject("installer")]]));
  const response = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${key}`, { headers: { range: "bytes=0-0" } }),
    env,
  );

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 0-0/9");
  assert.equal(response.headers.get("content-length"), "1");
  assert.equal(await response.text(), "i");
  assert.deepEqual(requestedKeys, [key, key]);
  assert.deepEqual(requestedRanges, [{ offset: 0, length: 1 }]);
});

test("supports open-ended and suffix single ranges", async () => {
  const key = "desktop-app/desktop-app-v1.2.3/sample.zip";
  const { env, requestedRanges } = createEnv(new Map([[key, createObject("0123456789")]]));
  const openEnded = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${key}`, { headers: { range: "bytes=7-" } }),
    env,
  );
  const suffix = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${key}`, { headers: { range: "bytes=-4" } }),
    env,
  );

  assert.equal(openEnded.status, 206);
  assert.equal(openEnded.headers.get("content-range"), "bytes 7-9/10");
  assert.equal(await openEnded.text(), "789");
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 6-9/10");
  assert.equal(await suffix.text(), "6789");
  assert.deepEqual(requestedRanges, [
    { offset: 7, length: 3 },
    { offset: 6, length: 4 },
  ]);
});

test("ignores unsupported range forms and returns the full representation", async () => {
  const key = "desktop-app/desktop-app-v1.2.3/sample.zip";
  const { env, requestedRanges } = createEnv(new Map([[key, createObject("0123456789")]]));
  for (const range of ["bytes=0-0,2-2", "items=0-1", "bytes=banana"]) {
    const response = await worker.fetch(
      new Request(`https://downloads.instafy.dev/${key}`, { headers: { range } }),
      env,
    );
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get("accept-ranges"), "bytes", range);
    assert.equal(response.headers.get("content-range"), null, range);
    assert.equal(await response.text(), "0123456789", range);
  }
  assert.deepEqual(requestedRanges, []);
});

test("rejects unsatisfiable single byte ranges with 416", async () => {
  const key = "desktop-app/desktop-app-v1.2.3/sample.zip";
  const { env, requestedRanges } = createEnv(new Map([[key, createObject("0123456789")]]));
  for (const range of ["bytes=10-", "bytes=5-4", "bytes=-0"]) {
    const response = await worker.fetch(
      new Request(`https://downloads.instafy.dev/${key}`, { headers: { range } }),
      env,
    );
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("accept-ranges"), "bytes", range);
    assert.equal(response.headers.get("content-range"), "bytes */10", range);
  }
  assert.deepEqual(requestedRanges, []);
});

test("honors If-Range validators before returning a partial representation", async () => {
  const key = "desktop-app/desktop-app-v1.2.3/sample.zip";
  const { env, requestedRanges } = createEnv(new Map([[key, createObject("0123456789")]]));
  const matching = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${key}`, {
      headers: { range: "bytes=0-0", "if-range": '"fixture-etag"' },
    }),
    env,
  );
  const stale = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${key}`, {
      headers: { range: "bytes=0-0", "if-range": '"old-etag"' },
    }),
    env,
  );

  assert.equal(matching.status, 206);
  assert.equal(await matching.text(), "0");
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), "0123456789");
  assert.deepEqual(requestedRanges, [{ offset: 0, length: 1 }]);
});

test("CORS preflight and unsupported methods do not read R2", async () => {
  const { env, requestedKeys } = createEnv(new Map());
  const preflight = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/latest.json", { method: "OPTIONS" }),
    env,
  );
  const post = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/latest.json", { method: "POST" }),
    env,
  );

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET,HEAD,OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Range, If-Range");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.deepEqual(requestedKeys, []);
});

test("missing and root objects return 404", async () => {
  const { env, requestedKeys } = createEnv(new Map());
  const missing = await worker.fetch(
    new Request("https://downloads.instafy.dev/desktop-app/stable/missing.exe"),
    env,
  );
  const root = await worker.fetch(new Request("https://downloads.instafy.dev/"), env);

  assert.equal(missing.status, 404);
  assert.equal(root.status, 404);
  assert.deepEqual(requestedKeys, [POINTER_KEY]);
});

test("post-rename artifact names resolve to their immutable release exactly like legacy names", async () => {
  // 0.2.3 renamed artifacts from instafy-studio-<v>-* to instafy-<v>-*.
  // Both generations must parse forever: old immutable prefixes keep their
  // original filenames and installed pre-rename clients still fetch them.
  const publicKey = "desktop-app/stable/instafy-1.2.3-mac-arm64.zip.blockmap";
  const storageKey = `desktop-app/${RELEASE_TAG}/instafy-1.2.3-mac-arm64.zip.blockmap`;
  const { env, requestedKeys } = createEnv(new Map([[storageKey, createObject("blockmap")]]));
  const response = await worker.fetch(
    new Request(`https://downloads.instafy.dev/${publicKey}`),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-instafy-desktop-release"), RELEASE_TAG);
  assert.deepEqual(requestedKeys, [storageKey]);
});
