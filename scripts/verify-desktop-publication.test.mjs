import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  parseDesktopUpdaterYaml,
  verifyDesktopPublicRelease,
} from "./verify-desktop-publication.mjs";

const BASE_URL = "https://downloads.example.test";
const FEED_URL = `${BASE_URL}/desktop-app/stable`;
const VERSION = "1.2.3";
const TAG = `desktop-app-v${VERSION}`;
const SOURCE_SHA = "a".repeat(40);

function integrity(body) {
  return {
    sha512: createHash("sha512").update(body).digest("base64"),
    size: body.byteLength,
  };
}

function updaterYaml(entries) {
  return [
    `version: ${VERSION}`,
    "files:",
    ...entries.flatMap(({ name, body }) => {
      const { sha512, size } = integrity(body);
      return [`  - url: ${name}`, `    sha512: ${sha512}`, `    size: ${size}`];
    }),
    `path: ${entries[0].name}`,
    `sha512: ${integrity(entries[0].body).sha512}`,
    "releaseDate: '2026-07-21T12:00:00.000Z'",
    "",
  ].join("\n");
}

function stableFixture() {
  const files = {
    "instafy-1.2.3-mac-arm64.dmg": Buffer.from("signed macOS disk image"),
    "instafy-1.2.3-mac-arm64.zip": Buffer.from("signed macOS updater archive"),
    "instafy-1.2.3-win.exe": Buffer.from("signed Windows installer"),
    "instafy-1.2.3-mac-arm64.zip.blockmap": Buffer.from("mac blockmap"),
    "instafy-1.2.3-win.exe.blockmap": Buffer.from("windows blockmap"),
  };
  const latest = {
    tag: TAG,
    version: VERSION,
    channel: "stable",
    sourceSha: SOURCE_SHA,
    publishedAt: "2026-07-21T12:00:00Z",
    feedUrl: FEED_URL,
    architectures: { mac: ["arm64"] },
    artifacts: {
      macDmg: `${FEED_URL}/instafy-1.2.3-mac-arm64.dmg`,
      macZip: `${FEED_URL}/instafy-1.2.3-mac-arm64.zip`,
      windowsExe: `${FEED_URL}/instafy-1.2.3-win.exe`,
    },
  };
  const macYaml = updaterYaml([
    { name: "instafy-1.2.3-mac-arm64.zip", body: files["instafy-1.2.3-mac-arm64.zip"] },
    { name: "instafy-1.2.3-mac-arm64.dmg", body: files["instafy-1.2.3-mac-arm64.dmg"] },
  ]);
  const windowsYaml = updaterYaml([
    { name: "instafy-1.2.3-win.exe", body: files["instafy-1.2.3-win.exe"] },
  ]);
  const resources = new Map([
    ["/desktop-app/stable/latest.json", JSON.stringify(latest)],
    ["/desktop-app/latest.json", JSON.stringify(latest)],
    [`/desktop-app/${TAG}/latest.json`, JSON.stringify(latest)],
    ["/desktop-app/stable/latest-mac.yml", macYaml],
    ["/desktop-app/stable/latest.yml", windowsYaml],
    [`/desktop-app/${TAG}/latest-mac.yml`, macYaml],
    [`/desktop-app/${TAG}/latest.yml`, windowsYaml],
    ...Object.entries(files).map(([name, body]) => [`/desktop-app/stable/${name}`, body]),
    ...Object.entries(files).map(([name, body]) => [`/desktop-app/${TAG}/${name}`, body]),
  ]);
  return { files, resources };
}

function internalFixture() {
  const feedUrl = `${BASE_URL}/desktop-app/internal`;
  const tag = `desktop-app-v${VERSION}-internal-deadbeef-42-1`;
  const files = {
    "instafy-1.2.3-mac-x64.dmg": Buffer.from("engineering macOS disk image"),
    "instafy-1.2.3-mac-x64.zip": Buffer.from("engineering macOS updater archive"),
    "instafy-1.2.3-win.exe": Buffer.from("engineering Windows installer"),
    "instafy-1.2.3-linux.AppImage": Buffer.from("engineering Linux AppImage"),
    "instafy-1.2.3-mac-x64.zip.blockmap": Buffer.from("mac blockmap"),
    "instafy-1.2.3-win.exe.blockmap": Buffer.from("windows blockmap"),
    "instafy-1.2.3-linux.AppImage.blockmap": Buffer.from("linux blockmap"),
  };
  const latest = {
    tag,
    version: VERSION,
    channel: "internal",
    sourceSha: SOURCE_SHA,
    publishedAt: "2026-07-21T12:00:00Z",
    feedUrl,
    architectures: { mac: ["x64"] },
    artifacts: {
      macDmg: `${feedUrl}/instafy-1.2.3-mac-x64.dmg`,
      macZip: `${feedUrl}/instafy-1.2.3-mac-x64.zip`,
      windowsExe: `${feedUrl}/instafy-1.2.3-win.exe`,
      linuxAppImage: `${feedUrl}/instafy-1.2.3-linux.AppImage`,
    },
  };
  const macYaml = updaterYaml([
    { name: "instafy-1.2.3-mac-x64.zip", body: files["instafy-1.2.3-mac-x64.zip"] },
    { name: "instafy-1.2.3-mac-x64.dmg", body: files["instafy-1.2.3-mac-x64.dmg"] },
  ]);
  const windowsYaml = updaterYaml([
    { name: "instafy-1.2.3-win.exe", body: files["instafy-1.2.3-win.exe"] },
  ]);
  const linuxYaml = updaterYaml([
    { name: "instafy-1.2.3-linux.AppImage", body: files["instafy-1.2.3-linux.AppImage"] },
  ]);
  const resources = new Map([
    ["/desktop-app/internal/latest.json", JSON.stringify(latest)],
    ["/desktop-app/internal/latest-mac.yml", macYaml],
    ["/desktop-app/internal/latest.yml", windowsYaml],
    ["/desktop-app/internal/latest-linux.yml", linuxYaml],
    [`/desktop-app/${tag}/latest-mac.yml`, macYaml],
    [`/desktop-app/${tag}/latest.yml`, windowsYaml],
    [`/desktop-app/${tag}/latest-linux.yml`, linuxYaml],
    ...Object.entries(files).map(([name, body]) => [`/desktop-app/internal/${name}`, body]),
    ...Object.entries(files).map(([name, body]) => [`/desktop-app/${tag}/${name}`, body]),
  ]);
  return { feedUrl, tag, resources };
}

function mockFetch(resources, requests) {
  return async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    const body = resources.get(url.pathname);
    if (body === undefined) return new Response("missing", { status: 404 });
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    const stableAlias =
      url.pathname === "/desktop-app/latest.json" ||
      url.pathname.startsWith("/desktop-app/stable/") ||
      url.pathname.startsWith(`/desktop-app/${TAG}/`);
    const releaseHeaders = stableAlias
      ? { "x-instafy-desktop-release": TAG }
      : {};
    if (init.headers?.range === "bytes=0-0") {
      return new Response(bytes.subarray(0, 1), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "1",
          "content-range": `bytes 0-0/${bytes.byteLength}`,
          ...releaseHeaders,
        },
      });
    }
    return new Response(init.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength), ...releaseHeaders },
    });
  };
}

const quietLogger = { log() {}, warn() {} };

test("verifies stable aliases, updater metadata, public artifact checksums, and blockmaps", async () => {
  const { resources } = stableFixture();
  const requests = [];
  const result = await verifyDesktopPublicRelease({
    downloadsBaseUrl: BASE_URL,
    desktopPrefix: "desktop-app",
    channel: "stable",
    expectedVersion: VERSION,
    expectedTag: TAG,
    expectedSourceSha: SOURCE_SHA,
    fetchImpl: mockFetch(resources, requests),
    metadataAttempts: 1,
    artifactAttempts: 1,
    retryDelayMs: 0,
    logger: quietLogger,
  });

  assert.deepEqual(result, { feedUrl: FEED_URL, artifactsVerified: 3, blockmapsVerified: 2 });
  assert.ok(requests.length > 0);
  assert.ok(requests.some(({ url }) => url.pathname.startsWith(`/desktop-app/${TAG}/`)));
  assert.ok(requests.some(({ init }) => init.headers?.range === "bytes=0-0"));
  for (const { url, init } of requests) {
    assert.equal(url.protocol, "https:");
    assert.ok(url.searchParams.has("instafy-publication-check"));
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers["cache-control"], "no-cache");
  }
});

test("verifies the immutable candidate without reading live stable aliases", async () => {
  const { resources } = stableFixture();
  for (const key of [...resources.keys()]) {
    if (key === "/desktop-app/latest.json" || key.startsWith("/desktop-app/stable/")) {
      resources.delete(key);
    }
  }
  const requests = [];
  const result = await verifyDesktopPublicRelease({
    downloadsBaseUrl: BASE_URL,
    desktopPrefix: "desktop-app",
    channel: "stable",
    expectedVersion: VERSION,
    expectedTag: TAG,
    expectedSourceSha: SOURCE_SHA,
    phase: "candidate",
    fetchImpl: mockFetch(resources, requests),
    metadataAttempts: 1,
    artifactAttempts: 1,
    retryDelayMs: 0,
    logger: quietLogger,
  });

  assert.deepEqual(result, { feedUrl: FEED_URL, artifactsVerified: 3, blockmapsVerified: 2 });
  assert.ok(requests.every(({ url }) => url.pathname.startsWith(`/desktop-app/${TAG}/`)));
});

test("rejects non-canonical numeric prerelease identifiers before any public request", async () => {
  const fetchImpl = async () => {
    throw new Error("fetch must not run for invalid release metadata");
  };

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: "1.2.3-01",
      expectedTag: "desktop-app-v1.2.3-01",
      expectedSourceSha: SOURCE_SHA,
      fetchImpl,
    }),
    /expectedVersion must be valid SemVer/,
  );
});

test("candidate verification catches bad immutable bytes before stable selection", async () => {
  const { resources } = stableFixture();
  resources.set(
    `/desktop-app/${TAG}/instafy-1.2.3-win.exe`,
    Buffer.from("corrupt candidate"),
  );

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      phase: "candidate",
      fetchImpl: mockFetch(resources, []),
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /immutable candidate artifact instafy-1\.2\.3-win\.exe failed.*does not match metadata size/s,
  );
});

test("verifies the unsigned internal channel including its Linux updater feed", async () => {
  const { feedUrl, tag, resources } = internalFixture();
  const result = await verifyDesktopPublicRelease({
    downloadsBaseUrl: BASE_URL,
    desktopPrefix: "desktop-app",
    channel: "internal",
    expectedVersion: VERSION,
    expectedTag: tag,
    expectedSourceSha: SOURCE_SHA,
    fetchImpl: mockFetch(resources, []),
    metadataAttempts: 1,
    artifactAttempts: 1,
    retryDelayMs: 0,
    logger: quietLogger,
  });

  assert.deepEqual(result, { feedUrl, artifactsVerified: 4, blockmapsVerified: 3 });
});

test("fails closed when a public artifact does not match the updater SHA-512", async () => {
  const { resources } = stableFixture();
  resources.set("/desktop-app/stable/instafy-1.2.3-win.exe", Buffer.from("different public bytes"));

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      fetchImpl: mockFetch(resources, []),
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /channel artifact instafy-1\.2\.3-win\.exe failed.*does not match metadata size/s,
  );
});

test("fails closed when an immutable tag artifact differs from its channel copy", async () => {
  const { resources } = stableFixture();
  const original = resources.get("/desktop-app/stable/instafy-1.2.3-win.exe");
  resources.set(
    `/desktop-app/${TAG}/instafy-1.2.3-win.exe`,
    Buffer.alloc(original.byteLength, "x"),
  );

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      fetchImpl: mockFetch(resources, []),
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /immutable artifact instafy-1\.2\.3-win\.exe failed.*SHA-512 does not match updater metadata/s,
  );
});

test("fails closed when immutable updater YAML differs from the channel copy", async () => {
  const { resources } = stableFixture();
  resources.set(`/desktop-app/${TAG}/latest.yml`, `${resources.get(`/desktop-app/${TAG}/latest.yml`)}# drift\n`);

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      fetchImpl: mockFetch(resources, []),
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /Immutable latest\.yml bytes differ from the channel copy/,
  );
});

test("fails closed when an immutable blockmap checksum differs from its channel copy", async () => {
  const { resources } = stableFixture();
  const original = resources.get("/desktop-app/stable/instafy-1.2.3-win.exe.blockmap");
  resources.set(
    `/desktop-app/${TAG}/instafy-1.2.3-win.exe.blockmap`,
    Buffer.alloc(original.byteLength, "x"),
  );

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      fetchImpl: mockFetch(resources, []),
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /Immutable and channel blockmap checksum or size differs for instafy-1\.2\.3-win\.exe\.blockmap/,
  );
});

test("retries a stale successful metadata response until the expected release reaches the edge", async () => {
  const { resources } = stableFixture();
  const regularFetch = mockFetch(resources, []);
  let stableManifestRequests = 0;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/desktop-app/stable/latest.json" && stableManifestRequests++ === 0) {
      const stale = JSON.parse(resources.get(url.pathname));
      stale.version = "1.2.2";
      return new Response(JSON.stringify(stale), { status: 200 });
    }
    return regularFetch(input, init);
  };

  const result = await verifyDesktopPublicRelease({
    downloadsBaseUrl: BASE_URL,
    channel: "stable",
    expectedVersion: VERSION,
    expectedTag: TAG,
    expectedSourceSha: SOURCE_SHA,
    fetchImpl,
    metadataAttempts: 2,
    artifactAttempts: 1,
    retryDelayMs: 0,
    logger: quietLogger,
  });

  assert.equal(stableManifestRequests, 2);
  assert.equal(result.artifactsVerified, 3);
});

test("fails closed when the unversioned stable alias does not match the channel manifest", async () => {
  const { resources } = stableFixture();
  const stale = JSON.parse(resources.get("/desktop-app/latest.json"));
  stale.version = "1.2.2";
  resources.set("/desktop-app/latest.json", JSON.stringify(stale));

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      fetchImpl: mockFetch(resources, []),
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /desktop-app\/latest\.json does not exactly match stable\/latest\.json/,
  );
});

test("fails closed when a stable manifest bypasses the atomic release pointer", async () => {
  const { resources } = stableFixture();
  const regularFetch = mockFetch(resources, []);
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/desktop-app/latest.json") {
      return new Response(resources.get(url.pathname), { status: 200 });
    }
    return regularFetch(input, init);
  };

  await assert.rejects(
    verifyDesktopPublicRelease({
      downloadsBaseUrl: BASE_URL,
      channel: "stable",
      expectedVersion: VERSION,
      expectedTag: TAG,
      expectedSourceSha: SOURCE_SHA,
      fetchImpl,
      metadataAttempts: 1,
      artifactAttempts: 1,
      retryDelayMs: 0,
      logger: quietLogger,
    }),
    /desktop-app\/latest\.json.*not resolved through atomic release pointer/,
  );
});

test("rejects incomplete updater checksum metadata", () => {
  assert.throws(
    () =>
      parseDesktopUpdaterYaml(
        ["version: 1.2.3", "files:", "  - url: instafy-1.2.3-win.exe", "    size: 10", ""].join("\n"),
      ),
    /canonical base64-encoded SHA-512 digest/,
  );
});

test("a macOS-only stable release verifies without any Windows manifest", async () => {
  // The exact shape of the first real stable release (run 31324077906):
  // Windows disabled, arm64 macOS only. The candidate phase failed there by
  // polling desktop-app-v0.2.0/latest.yml — a Windows updater manifest no
  // build had produced — for 18 attempts of HTTP 404. A release must only be
  // asked to prove the platforms it actually contains.
  const { files, resources } = stableFixture();
  for (const key of [...resources.keys()]) {
    if (key.endsWith("/latest.yml") || key.includes("-win.exe")) resources.delete(key);
  }
  for (const key of ["/desktop-app/stable/latest.json", "/desktop-app/latest.json", `/desktop-app/${TAG}/latest.json`]) {
    const latest = JSON.parse(resources.get(key));
    delete latest.artifacts.windowsExe;
    resources.set(key, JSON.stringify(latest));
  }
  delete files["instafy-1.2.3-win.exe"];
  delete files["instafy-1.2.3-win.exe.blockmap"];

  const result = await verifyDesktopPublicRelease({
    downloadsBaseUrl: BASE_URL,
    desktopPrefix: "desktop-app",
    channel: "stable",
    expectedVersion: VERSION,
    expectedTag: TAG,
    expectedSourceSha: SOURCE_SHA,
    fetchImpl: mockFetch(resources, []),
    metadataAttempts: 1,
    artifactAttempts: 1,
    retryDelayMs: 0,
    logger: quietLogger,
  });
  assert.deepEqual(result, { feedUrl: FEED_URL, artifactsVerified: 2, blockmapsVerified: 1 });
});
