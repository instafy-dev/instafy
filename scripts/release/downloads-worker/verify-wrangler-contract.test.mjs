import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { WRANGLER_TOML, verifyWranglerContract } from "./verify-wrangler-contract.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const source = fs.readFileSync(path.join(repositoryRoot, WRANGLER_TOML), "utf8");

test("the committed wrangler.toml declares the published downloads contract", () => {
  assert.equal(verifyWranglerContract(source), true);
});

test("prefix, bucket, name and route drift are refused", () => {
  assert.throws(() => verifyWranglerContract(source.replace('MOBILE_OTA_DOWNLOADS_PREFIX = "mobile"', 'MOBILE_OTA_DOWNLOADS_PREFIX = "ota"')), /MOBILE_OTA_DOWNLOADS_PREFIX must be mobile/u);
  assert.throws(() => verifyWranglerContract(source.replace('DESKTOP_DOWNLOADS_PREFIX = "desktop-app"', 'DESKTOP_DOWNLOADS_PREFIX = "desktop"')), /DESKTOP_DOWNLOADS_PREFIX/u);
  assert.throws(() => verifyWranglerContract(source.replace('bucket_name = "instafy-downloads"', 'bucket_name = "other"')), /R2 bucket/u);
  assert.throws(() => verifyWranglerContract(source.replace('name = "instafy-downloads"', 'name = "other"')), /Worker name/u);
  assert.throws(() => verifyWranglerContract(source.replace("downloads.instafy.dev/*", "downloads.instafy.dev/mobile/*")), /route/u);
  assert.throws(() => verifyWranglerContract(`${source}\n[[r2_buckets]]\nbinding = "EXTRA"\nbucket_name = "extra"\n`), /Exactly one R2 bucket/u);
});

test("commented-out declarations do not satisfy the contract", () => {
  const commented = source.replace('MOBILE_OTA_DOWNLOADS_PREFIX = "mobile"', '# MOBILE_OTA_DOWNLOADS_PREFIX = "mobile"');
  assert.throws(() => verifyWranglerContract(commented), /exactly once/u);
});
