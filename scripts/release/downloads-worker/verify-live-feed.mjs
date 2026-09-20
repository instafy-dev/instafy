#!/usr/bin/env node
// Post-deploy proof (no credentials): the freshly deployed Worker still serves
// what is already shipping. env: DOWNLOADS_BASE_URL, MOBILE_OTA_DOWNLOADS_PREFIX,
// LATEST_OTA_TAG (optional; newest ota-v* GitHub Release tag).

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CONTRACT = "desktop-stable-pointer-v1";

function fail(message) {
  throw new Error(message);
}

export async function verifyLiveFeed({
  baseUrl = "https://downloads.instafy.dev",
  desktopPrefix = "desktop-app",
  mobilePrefix = "mobile",
  latestOtaTag = "",
  fetchImpl = fetch,
  log = console.log,
}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search) {
    fail("DOWNLOADS_BASE_URL must be a credential-free HTTPS origin");
  }
  const root = baseUrl.replace(/\/+$/u, "");
  const get = (key, method = "GET") =>
    fetchImpl(`${root}/${key}`, { method, redirect: "manual", headers: { "cache-control": "no-cache" } });

  const latest = await get(`${desktopPrefix}/latest.json`);
  if (latest.status !== 200) fail(`${desktopPrefix}/latest.json returned ${latest.status}`);
  if (latest.headers.get("x-instafy-downloads-contract") !== CONTRACT) {
    fail(`${desktopPrefix}/latest.json is missing the ${CONTRACT} contract header`);
  }
  const feed = await latest.json();
  if (typeof feed?.version !== "string" || feed.tag !== `desktop-app-v${feed.version}`) {
    fail("latest.json tag does not match its version");
  }

  const mac = await get(`${desktopPrefix}/stable/latest-mac.yml`);
  if (mac.status !== 200) fail(`${desktopPrefix}/stable/latest-mac.yml returned ${mac.status}`);

  const contract = await get(`${desktopPrefix}/stable-pointer-contract.json`);
  if (contract.status !== 200 || !isDeepStrictEqual(await contract.json(), { schemaVersion: 1, stableAliases: "immutable-pointer" })) {
    fail("stable-pointer-contract.json does not declare the immutable-pointer contract");
  }

  const pointer = await get(`${desktopPrefix}/stable-release.json`);
  if (pointer.status !== 404) fail("The private stable-release.json pointer must not be publicly served");

  let otaManifest = null;
  if (latestOtaTag) {
    if (!/^ota-v[0-9a-f]{12}$/u.test(latestOtaTag)) fail("LATEST_OTA_TAG is not an ota-v tag");
    otaManifest = `${mobilePrefix}/${latestOtaTag}.manifest.json`;
    const head = await get(otaManifest, "HEAD");
    if (head.status !== 200 || !String(head.headers.get("cache-control") ?? "").includes("immutable")) {
      fail(`${otaManifest} is not served as an immutable object`);
    }
  }
  log(`[downloads-worker] Live feed verified: ${feed.tag}${otaManifest ? `, ${otaManifest}` : ""}.`);
  return { desktopTag: feed.tag, otaManifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyLiveFeed({
    baseUrl: process.env.DOWNLOADS_BASE_URL || undefined,
    desktopPrefix: process.env.DESKTOP_DOWNLOADS_PREFIX || undefined,
    mobilePrefix: process.env.MOBILE_OTA_DOWNLOADS_PREFIX || undefined,
    latestOtaTag: process.env.LATEST_OTA_TAG ?? "",
  }).catch((error) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
