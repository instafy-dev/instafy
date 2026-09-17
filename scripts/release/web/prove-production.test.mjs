import assert from "node:assert/strict";
import test from "node:test";

import { appBase, proveProduction, releaseIdFrom, servedReleaseId } from "./prove-production.mjs";

const RELEASE = "c".repeat(64);
const base = new URL("https://app.example.invalid");
const response = (ok, body = {}) => ({ ok, status: ok ? 200 : 503, json: async () => body });

test("only an exact https origin is accepted", () => {
  assert.equal(appBase("https://app.example.invalid").origin, "https://app.example.invalid");
  for (const bad of ["", "http://app.example.invalid", "https://user:pass@app.example.invalid", "https://app.example.invalid/?x=1"]) {
    assert.throws(() => appBase(bad), /PUBLIC_APP_URL/u);
  }
});

test("served metadata must have the exact schema", () => {
  assert.equal(releaseIdFrom({ schemaVersion: 2, releaseId: RELEASE }), RELEASE);
  assert.equal(releaseIdFrom({ schemaVersion: 1, releaseId: RELEASE }), "");
  assert.equal(releaseIdFrom({ schemaVersion: 2, releaseId: RELEASE, extra: true }), "");
});

test("proof converges only on the exact release and a healthy home and install page", async () => {
  const calls = [];
  let metadataCalls = 0;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("instafy-build.json")) {
      metadataCalls += 1;
      return response(true, { schemaVersion: 2, releaseId: metadataCalls < 2 ? "d".repeat(64) : RELEASE });
    }
    return response(true);
  };
  assert.equal(await proveProduction({ base, releaseId: RELEASE, runId: "7", fetchImpl, delayMs: 0, log: () => {} }), true);
  assert.ok(calls.some((url) => url === "https://app.example.invalid/instafy-build.json?release=7"));
  assert.ok(calls.includes("https://app.example.invalid/install"));
  assert.equal(await servedReleaseId({ base, runId: "7", fetchImpl }), RELEASE);
});

test("proof fails when production never converges or the smoke fails", async () => {
  const stale = async () => response(true, { schemaVersion: 2, releaseId: "d".repeat(64) });
  await assert.rejects(proveProduction({ base, releaseId: RELEASE, fetchImpl: stale, attempts: 2, delayMs: 0, log: () => {} }), /did not serve/u);
  const broken = async (url) => (String(url).includes("instafy-build.json") ? response(true, { schemaVersion: 2, releaseId: RELEASE }) : response(false));
  await assert.rejects(proveProduction({ base, releaseId: RELEASE, fetchImpl: broken, attempts: 1, delayMs: 0, log: () => {} }), /did not serve/u);
});
