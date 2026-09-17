#!/usr/bin/env node
// Pins the downloads Worker's public contract before a deploy: a silent
// prefix, bucket or route change would orphan every published object.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const WRANGLER_TOML = "packages/downloads-worker/wrangler.toml";

function fail(message) {
  throw new Error(message);
}

function stripComments(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/u, "").replace(/^\s*#.*$/u, ""))
    .join("\n");
}

function single(text, pattern, label) {
  const values = [...text.matchAll(pattern)].map((match) => match[1]);
  if (values.length !== 1) fail(`${label} must be declared exactly once`);
  return values[0];
}

export function verifyWranglerContract(source) {
  const text = stripComments(source);
  const expect = (actual, expected, label) => {
    if (actual !== expected) fail(`${label} must be ${expected}`);
  };
  expect(single(text, /^name\s*=\s*"([^"]*)"\s*$/gmu, "name"), "instafy-downloads", "Worker name");
  expect(single(text, /^main\s*=\s*"([^"]*)"\s*$/gmu, "main"), "src/index.ts", "Worker entry");
  expect(
    single(text, /^DESKTOP_DOWNLOADS_PREFIX\s*=\s*"([^"]*)"\s*$/gmu, "DESKTOP_DOWNLOADS_PREFIX"),
    "desktop-app",
    "DESKTOP_DOWNLOADS_PREFIX",
  );
  expect(
    single(text, /^MOBILE_OTA_DOWNLOADS_PREFIX\s*=\s*"([^"]*)"\s*$/gmu, "MOBILE_OTA_DOWNLOADS_PREFIX"),
    "mobile",
    "MOBILE_OTA_DOWNLOADS_PREFIX",
  );
  const bucketBlocks = text.split(/^\[\[r2_buckets\]\]\s*$/mu).slice(1);
  if (bucketBlocks.length !== 1) fail("Exactly one R2 bucket binding is required");
  const block = bucketBlocks[0].split(/^\[/mu)[0];
  expect(single(block, /^binding\s*=\s*"([^"]*)"\s*$/gmu, "binding"), "DOWNLOADS_BUCKET", "R2 binding");
  expect(single(block, /^bucket_name\s*=\s*"([^"]*)"\s*$/gmu, "bucket_name"), "instafy-downloads", "R2 bucket");
  const patterns = [...text.matchAll(/pattern\s*=\s*"([^"]*)"/gu)].map((match) => match[1]);
  if (patterns.length !== 1 || patterns[0] !== "downloads.instafy.dev/*") {
    fail("The Worker must declare exactly the route downloads.instafy.dev/*");
  }
  expect(single(text, /zone_name\s*=\s*"([^"]*)"/gu, "zone_name"), "instafy.dev", "Route zone");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    verifyWranglerContract(fs.readFileSync(path.resolve(process.argv[2] ?? WRANGLER_TOML), "utf8"));
    console.log("[downloads-worker] wrangler.toml still declares the published downloads contract.");
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
