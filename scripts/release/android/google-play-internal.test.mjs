import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assessPreflight,
  canonicalSha256,
  createGoogleServiceAccountAssertion,
  decidePublication,
  observeGoogleStore,
  publishGoogleInternal,
  reconcileGoogleInternal,
  resolveGoogleAccessToken,
  safeProviderUrl,
  selectAndroidVersionCode,
  summarizeGoogleState,
  validateObservation,
} from "./google-play-internal.mjs";

const GOOGLE_ORIGIN = "https://androidpublisher.googleapis.com";
const APPLICATION_ID = "dev.instafy.studio";
const ACCESS_TOKEN = "provider-access-token-that-is-long-enough";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const SHA1 = "1".repeat(40);
const OLD_SHA256 = "2".repeat(64);
const OTHER_SHA256 = "3".repeat(64);
const HELPER = path.join(import.meta.dirname, "google-play-internal.mjs");

const googleKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const googlePrivateKey = googleKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const SERVICE_ACCOUNT = Object.freeze({
  type: "service_account",
  client_email: "release-bot@example.iam.gserviceaccount.com",
  private_key: googlePrivateKey,
  token_uri: "https://oauth2.googleapis.com/token",
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function googleBundle(versionCode, sha256 = OLD_SHA256, sha1 = SHA1) {
  return { versionCode: Number(versionCode), sha1, sha256 };
}

function googleRelease(status, versionCodes, name = "release") {
  return { status, versionCodes: versionCodes.map(String), name };
}

function normalizedGoogleState({ bundles = [], releases = [] } = {}) {
  return {
    schemaVersion: 1,
    provider: "google-play",
    applicationId: APPLICATION_ID,
    track: "internal",
    bundles: bundles.map((value) => ({
      versionCode: String(value.versionCode),
      sha1: value.sha1,
      sha256: value.sha256,
    })).sort((left, right) => Number(left.versionCode) - Number(right.versionCode)),
    releases: releases.map((value) => ({
      name: value.name,
      status: value.status,
      versionCodes: [...new Set(value.versionCodes.map(String))].sort(
        (left, right) => Number(left) - Number(right),
      ),
    })).sort((left, right) =>
      `${left.status}\0${left.versionCodes.join(",")}\0${left.name}`.localeCompare(
        `${right.status}\0${right.versionCodes.join(",")}\0${right.name}`,
      )),
  };
}

function observation(options = {}) {
  const state = normalizedGoogleState(options);
  return {
    ...state,
    ...summarizeGoogleState(state),
    stateSha256: canonicalSha256(state),
    observedAt: NOW.toISOString(),
  };
}

function createGooglePublishFetch({
  beforeBundles = [],
  beforeReleases = [],
  afterBundles = beforeBundles,
  afterReleases = beforeReleases,
  uploadResponse,
  commitStatus = 200,
} = {}) {
  const calls = [];
  let openedEdits = 0;
  const fetchImpl = async (value, init = {}) => {
    const url = value instanceof URL ? value : new URL(value);
    const method = init.method ?? "GET";
    calls.push({ url: url.toString(), pathname: url.pathname, search: url.search, method, init });
    assert.equal(url.origin, GOOGLE_ORIGIN);
    assert.equal(init.redirect, "error");
    const prefix = `/androidpublisher/v3/applications/${APPLICATION_ID}`;
    if (method === "POST" && url.pathname === `${prefix}/edits`) {
      openedEdits += 1;
      return json({ id: openedEdits === 1 ? "edit-before" : "edit-after" });
    }
    const isBefore = url.pathname.includes("/edits/edit-before");
    const bundles = isBefore ? beforeBundles : afterBundles;
    const releases = isBefore ? beforeReleases : afterReleases;
    if (method === "GET" && url.pathname.endsWith("/bundles")) {
      return json({ kind: "androidpublisher#bundlesListResponse", bundles });
    }
    if (method === "GET" && url.pathname.endsWith("/tracks/internal")) {
      return json({ track: "internal", releases });
    }
    if (
      method === "POST" &&
      url.pathname === `/upload/androidpublisher/v3/applications/${APPLICATION_ID}/edits/edit-before/bundles`
    ) {
      assert.equal(url.searchParams.get("uploadType"), "media");
      assert.equal(init.headers["content-type"], "application/octet-stream");
      assert.ok(Buffer.isBuffer(init.body));
      return json(uploadResponse);
    }
    if (method === "PUT" && url.pathname === `${prefix}/edits/edit-before/tracks/internal`) {
      return json(JSON.parse(init.body));
    }
    if (method === "POST" && url.pathname === `${prefix}/edits/edit-before:validate`) {
      return json({ id: "edit-before" });
    }
    if (method === "POST" && url.pathname === `${prefix}/edits/edit-before:commit`) {
      assert.equal(url.searchParams.get("changesInReviewBehavior"), "ERROR_IF_IN_REVIEW");
      return commitStatus >= 400
        ? json({ error: { message: "ambiguous" } }, commitStatus)
        : json({ id: "edit-before", expiryTimeSeconds: "0" });
    }
    if (method === "DELETE" && url.pathname.startsWith(`${prefix}/edits/`)) return empty();
    assert.fail(`unexpected Google Play request: ${method} ${url}`);
  };
  return { fetchImpl, calls, openedEdits: () => openedEdits };
}

function createGoogleObservationFetch({
  bundlesPayload = { kind: "androidpublisher#bundlesListResponse", bundles: [] },
  trackPayload = { track: "internal", releases: [] },
  trackStatus = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async (value, init = {}) => {
    const url = value instanceof URL ? value : new URL(value);
    const method = init.method ?? "GET";
    calls.push({ method, pathname: url.pathname });
    const prefix = `/androidpublisher/v3/applications/${APPLICATION_ID}`;
    if (method === "POST" && url.pathname === `${prefix}/edits`) return json({ id: "observation-edit" });
    if (method === "GET" && url.pathname.endsWith("/bundles")) return json(bundlesPayload);
    if (method === "GET" && url.pathname.endsWith("/tracks/internal")) return json(trackPayload, trackStatus);
    if (method === "DELETE" && url.pathname.endsWith("/observation-edit")) return empty();
    assert.fail(`unexpected Google Play observation request: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

test("creates and validates the exact Google Android Publisher assertion", () => {
  const { assertion, tokenUri } = createGoogleServiceAccountAssertion({ serviceAccount: SERVICE_ACCOUNT, now: NOW });
  assert.equal(tokenUri, "https://oauth2.googleapis.com/token");
  const [encodedHeader, encodedPayload, encodedSignature] = assertion.split(".");
  assert.deepEqual(decodeJwtPart(encodedHeader), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeJwtPart(encodedPayload), {
    iss: SERVICE_ACCOUNT.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: tokenUri,
    iat: 1_788_350_400,
    exp: 1_788_354_000,
  });
  assert.equal(
    crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      googleKeys.publicKey,
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );
  for (const token_uri of [
    "https://example.com/token",
    "https://oauth2.googleapis.com/not-token",
    "http://oauth2.googleapis.com/token",
    "https://release-bot@oauth2.googleapis.com/token",
    "https://oauth2.googleapis.com/token?audience=other",
    "https://oauth2.googleapis.com/token#other",
    "not a url",
  ]) {
    assert.throws(
      () => createGoogleServiceAccountAssertion({ serviceAccount: { ...SERVICE_ACCOUNT, token_uri }, now: NOW }),
      /token endpoint is not allowlisted/u,
    );
  }
  assert.throws(
    () => createGoogleServiceAccountAssertion({
      serviceAccount: { ...SERVICE_ACCOUNT, type: "authorized_user" },
      now: NOW,
    }),
    /service-account key is invalid/u,
  );
  assert.throws(
    () => createGoogleServiceAccountAssertion({ serviceAccount: SERVICE_ACCOUNT, now: new Date(Number.NaN) }),
    /JWT clock is invalid/u,
  );
});

test("exchanges the Google assertion only at the allowlisted endpoint", async () => {
  const calls = [];
  const token = await resolveGoogleAccessToken({
    serviceAccount: SERVICE_ACCOUNT,
    now: NOW,
    fetchImpl: async (value, init) => {
      calls.push({ value, init });
      return json({ access_token: ACCESS_TOKEN, token_type: "Bearer" });
    },
  });
  assert.equal(token, ACCESS_TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(calls[0].init.body.get("assertion").split(".").length, 3);
});

test("observes Google state in a disposable edit, summarizes it and closes the edit", async () => {
  const bundles = [googleBundle(20), googleBundle(2, OTHER_SHA256)];
  const releases = [googleRelease("completed", [20, 2], "stable")];
  const { fetchImpl, calls } = createGooglePublishFetch({ beforeBundles: bundles, beforeReleases: releases });
  const result = await observeGoogleStore({ applicationId: APPLICATION_ID, accessToken: ACCESS_TOKEN, fetchImpl, now: NOW });
  assert.deepEqual(result.bundles.map((value) => value.versionCode), ["2", "20"]);
  assert.deepEqual(result.releases[0].versionCodes, ["2", "20"]);
  assert.equal(result.stateSha256, canonicalSha256(normalizedGoogleState({ bundles, releases })));
  assert.equal(result.observedAt, NOW.toISOString());
  assert.equal(result.highestCommittedCode, 20);
  assert.equal(result.publicationGate, "clear");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET", "GET", "DELETE"]);
  assert.deepEqual(validateObservation(result), result);
});

test("accepts only exact Google bundles and internal-track response shapes", async (t) => {
  const validBundles = { kind: "androidpublisher#bundlesListResponse", bundles: [googleBundle(4)] };
  const cases = [
    { name: "missing bundles response kind", bundlesPayload: { bundles: [] }, error: /bundles response kind is invalid/u },
    { name: "missing bundles array", bundlesPayload: { kind: "androidpublisher#bundlesListResponse" }, error: /bundles response items is invalid or unbounded/u },
    {
      name: "bundle versionCode exceeds provider bound",
      bundlesPayload: { kind: "androidpublisher#bundlesListResponse", bundles: [googleBundle(2_100_000_001)] },
      error: /bundle versionCode is invalid or exceeds the provider bound/u,
    },
    { name: "wrong track identity", bundlesPayload: validBundles, trackPayload: { track: "production", releases: [] }, error: /not the internal track/u },
    { name: "missing track releases array", bundlesPayload: validBundles, trackPayload: { track: "internal" }, error: /track response releases is invalid or unbounded/u },
    {
      name: "duplicate release versionCodes",
      bundlesPayload: validBundles,
      trackPayload: { track: "internal", releases: [googleRelease("completed", [4, 4])] },
      error: /duplicate versionCodes/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { fetchImpl, calls } = createGoogleObservationFetch(entry);
      await assert.rejects(
        observeGoogleStore({ applicationId: APPLICATION_ID, accessToken: ACCESS_TOKEN, fetchImpl, now: NOW }),
        entry.error,
      );
      assert.equal(calls.at(-1).method, "DELETE");
    });
  }
  await t.test("a 404 internal track is the only empty-track response", async () => {
    const { fetchImpl } = createGoogleObservationFetch({
      bundlesPayload: validBundles,
      trackPayload: { error: { message: "not found" } },
      trackStatus: 404,
    });
    const result = await observeGoogleStore({ applicationId: APPLICATION_ID, accessToken: ACCESS_TOKEN, fetchImpl, now: NOW });
    assert.deepEqual(result.releases, []);
  });
});

test("rejects Google provider identifiers that could escape the API path", async () => {
  let calls = 0;
  await assert.rejects(
    observeGoogleStore({
      applicationId: APPLICATION_ID,
      accessToken: ACCESS_TOKEN,
      now: NOW,
      fetchImpl: async (value) => {
        calls += 1;
        assert.equal(new URL(value).origin, GOOGLE_ORIGIN);
        return json({ id: "../../attacker" });
      },
    }),
    /edit ID is invalid/u,
  );
  assert.equal(calls, 1);
});

test("allowlists normal and upload Google API paths independently", () => {
  assert.equal(
    safeProviderUrl("/androidpublisher/v3/applications/dev.instafy.studio/edits", GOOGLE_ORIGIN, "normal").pathname,
    "/androidpublisher/v3/applications/dev.instafy.studio/edits",
  );
  assert.equal(
    safeProviderUrl(
      "/upload/androidpublisher/v3/applications/dev.instafy.studio/edits/one/bundles",
      GOOGLE_ORIGIN,
      "upload",
      { upload: true },
    ).pathname,
    "/upload/androidpublisher/v3/applications/dev.instafy.studio/edits/one/bundles",
  );
  assert.throws(
    () => safeProviderUrl("https://attacker.example/androidpublisher/v3/applications/x", GOOGLE_ORIGIN, "normal"),
    /escaped its provider origin/u,
  );
  assert.throws(
    () => safeProviderUrl("/androidpublisher/v3/x", "https://oauth2.googleapis.com", "other origin"),
    /escaped its provider origin/u,
  );
  assert.throws(
    () => safeProviderUrl("/upload/androidpublisher/v3/applications/x", GOOGLE_ORIGIN, "normal"),
    /escaped its provider API path/u,
  );
  assert.throws(
    () => safeProviderUrl("/androidpublisher/v3/applications/x", GOOGLE_ORIGIN, "upload", { upload: true }),
    /escaped its provider API path/u,
  );
});

test("publishes Google internal in the exact edit sequence, then authenticates provider readback", async () => {
  const artifactBytes = Buffer.from("reserved Android App Bundle");
  const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  const beforeBundles = [googleBundle(8, OLD_SHA256)];
  const beforeReleases = [googleRelease("completed", [8], "1.0 (8)")];
  const afterBundles = [...beforeBundles, googleBundle(9, artifactSha256)];
  const afterReleases = [googleRelease("completed", [9], "1.1 (9)")];
  const { fetchImpl, calls } = createGooglePublishFetch({
    beforeBundles,
    beforeReleases,
    afterBundles,
    afterReleases,
    uploadResponse: googleBundle(9, artifactSha256),
  });
  const result = await publishGoogleInternal({
    applicationId: APPLICATION_ID,
    versionCode: "9",
    versionName: "1.1",
    artifactBytes,
    artifactSha256,
    expectedStateSha256: canonicalSha256(normalizedGoogleState({ bundles: beforeBundles, releases: beforeReleases })),
    accessToken: ACCESS_TOKEN,
    fetchImpl,
    now: NOW,
  });
  assert.equal(result.bundles.find((value) => value.versionCode === "9").sha256, artifactSha256);

  const prefix = `/androidpublisher/v3/applications/${APPLICATION_ID}`;
  const operations = calls.map((call) => {
    if (call.pathname.endsWith("/bundles") && call.method === "POST") return "upload";
    if (call.pathname.endsWith("/tracks/internal") && call.method === "PUT") return "track";
    if (call.pathname.endsWith(":validate")) return "validate";
    if (call.pathname.endsWith(":commit")) return "commit";
    return `${call.method} ${call.pathname.replace(prefix, "")}`;
  });
  assert.deepEqual(operations, [
    "POST /edits",
    "GET /edits/edit-before/bundles",
    "GET /edits/edit-before/tracks/internal",
    "upload",
    "track",
    "validate",
    "commit",
    "POST /edits",
    "GET /edits/edit-after/bundles",
    "GET /edits/edit-after/tracks/internal",
    "DELETE /edits/edit-after",
  ]);
  const trackCall = calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(trackCall.init.body), {
    track: "internal",
    releases: [{ status: "completed", name: "1.1 (9)", versionCodes: ["9"] }],
  });
  assert.equal(calls.find((call) => call.pathname.endsWith(":commit")).search, "?changesInReviewBehavior=ERROR_IF_IN_REVIEW");
});

test("recovers a successful Google commit from an ambiguous provider response without retrying", async () => {
  const artifactBytes = Buffer.from("ambiguously committed bundle");
  const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  const { fetchImpl, calls, openedEdits } = createGooglePublishFetch({
    afterBundles: [googleBundle(21, artifactSha256)],
    afterReleases: [googleRelease("completed", [21], "2.1 (21)")],
    uploadResponse: googleBundle(21, artifactSha256),
    commitStatus: 503,
  });
  const result = await publishGoogleInternal({
    applicationId: APPLICATION_ID,
    versionCode: "21",
    versionName: "2.1",
    artifactBytes,
    artifactSha256,
    expectedStateSha256: canonicalSha256(normalizedGoogleState()),
    accessToken: ACCESS_TOKEN,
    fetchImpl,
    now: NOW,
  });
  assert.equal(result.bundles[0].sha256, artifactSha256);
  assert.equal(openedEdits(), 2);
  assert.equal(calls.filter((call) => call.pathname.endsWith("/bundles") && call.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.pathname.endsWith(":commit")).length, 1);
  assert.equal(calls.some((call) => call.method === "DELETE" && call.pathname.endsWith("/edit-before")), false);
});

test("fails an ambiguous Google commit whose fresh readback does not match", async () => {
  const artifactBytes = Buffer.from("bundle not visible after commit");
  const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  const { fetchImpl, calls } = createGooglePublishFetch({
    uploadResponse: googleBundle(22, artifactSha256),
    commitStatus: 503,
  });
  await assert.rejects(
    publishGoogleInternal({
      applicationId: APPLICATION_ID,
      versionCode: "22",
      versionName: "2.2",
      artifactBytes,
      artifactSha256,
      expectedStateSha256: canonicalSha256(normalizedGoogleState()),
      accessToken: ACCESS_TOKEN,
      fetchImpl,
      now: NOW,
    }),
    /commit is ambiguous or did not converge/u,
  );
  assert.equal(calls.filter((call) => call.pathname.endsWith(":commit")).length, 1);
});

test("reconciles only an exact single completed Google internal release", async () => {
  const artifactSha256 = crypto.createHash("sha256").update("published bundle").digest("hex");
  const bundles = [googleBundle(25, artifactSha256)];
  const exact = createGooglePublishFetch({
    beforeBundles: bundles,
    beforeReleases: [googleRelease("completed", [25], "2.5 (25)")],
  });
  const result = await reconcileGoogleInternal({
    applicationId: APPLICATION_ID,
    versionCode: "25",
    versionName: "2.5",
    artifactSha256,
    accessToken: ACCESS_TOKEN,
    fetchImpl: exact.fetchImpl,
    now: NOW,
  });
  assert.equal(result.bundles[0].sha256, artifactSha256);
  assert.deepEqual(exact.calls.map((call) => call.method), ["POST", "GET", "GET", "DELETE"]);

  for (const [label, releases, sha] of [
    ["different name", [googleRelease("completed", [25], "different name")], artifactSha256],
    ["draft", [googleRelease("draft", [25], "2.5 (25)")], artifactSha256],
    ["two releases", [googleRelease("completed", [25], "2.5 (25)"), googleRelease("completed", [24], "x")], artifactSha256],
    ["different bytes", [googleRelease("completed", [25], "2.5 (25)")], OTHER_SHA256],
  ]) {
    const conflicting = createGooglePublishFetch({
      beforeBundles: [googleBundle(24), googleBundle(25, artifactSha256)],
      beforeReleases: releases,
    });
    await assert.rejects(
      reconcileGoogleInternal({
        applicationId: APPLICATION_ID,
        versionCode: "25",
        versionName: "2.5",
        artifactSha256: sha,
        accessToken: ACCESS_TOKEN,
        fetchImpl: conflicting.fetchImpl,
        now: NOW,
      }),
      /does not prove the reserved internal release/u,
      label,
    );
  }
});

test("rejects artifact digest mismatch before making a Google provider call", async () => {
  let calls = 0;
  await assert.rejects(
    publishGoogleInternal({
      applicationId: APPLICATION_ID,
      versionCode: "30",
      versionName: "3.0",
      artifactBytes: Buffer.from("actual bytes"),
      artifactSha256: OTHER_SHA256,
      expectedStateSha256: "4".repeat(64),
      accessToken: ACCESS_TOKEN,
      fetchImpl: async () => { calls += 1; return json({}); },
      now: NOW,
    }),
    /bundle bytes differ from their reserved digest/u,
  );
  assert.equal(calls, 0);
});

test("fails closed on changed, unsafe, or conflicting Google state and abandons the edit", async (t) => {
  const artifactBytes = Buffer.from("reserved conflicting-state bundle");
  const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  const cases = [
    { name: "preflight digest changed", beforeBundles: [], beforeReleases: [], expectedStateSha256: "f".repeat(64), error: /state changed after the reviewed build preflight/u },
    { name: "draft track state", beforeBundles: [googleBundle(4)], beforeReleases: [googleRelease("draft", [4])], error: /contains draft, staged, or halted state/u },
    { name: "halted track state", beforeBundles: [googleBundle(4)], beforeReleases: [googleRelease("halted", [4])], error: /contains draft, staged, or halted state/u },
    { name: "in-progress track state", beforeBundles: [googleBundle(4)], beforeReleases: [googleRelease("inProgress", [4])], error: /contains draft, staged, or halted state/u },
    { name: "same versionCode with different bytes", beforeBundles: [googleBundle(30, OTHER_SHA256)], beforeReleases: [googleRelease("completed", [30])], error: /versionCode exists with different bytes/u },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { fetchImpl, calls } = createGooglePublishFetch({
        beforeBundles: entry.beforeBundles,
        beforeReleases: entry.beforeReleases,
        uploadResponse: googleBundle(30, artifactSha256),
      });
      await assert.rejects(
        publishGoogleInternal({
          applicationId: APPLICATION_ID,
          versionCode: "30",
          versionName: "3.0",
          artifactBytes,
          artifactSha256,
          expectedStateSha256: entry.expectedStateSha256 ?? canonicalSha256(
            normalizedGoogleState({ bundles: entry.beforeBundles, releases: entry.beforeReleases }),
          ),
          accessToken: ACCESS_TOKEN,
          fetchImpl,
          now: NOW,
        }),
        entry.error,
      );
      assert.equal(calls.filter((call) => call.pathname.endsWith("/bundles") && call.method === "POST").length, 0);
      assert.equal(calls.filter((call) => call.pathname.endsWith(":commit")).length, 0);
      assert.equal(calls.filter((call) => call.method === "DELETE" && call.pathname.endsWith("/edit-before")).length, 1);
    });
  }
});

test("one-shot preflight refuses existing, non-monotonic or gated versionCodes", () => {
  const clean = observation({
    bundles: [googleBundle(260860838)],
    releases: [googleRelease("completed", [260860838], "1.0 (260860838)")],
  });
  assert.deepEqual(assessPreflight(clean, "260860839"), { ok: true, problems: [], stateSha256: clean.stateSha256 });
  assert.equal(selectAndroidVersionCode(clean, "260860839").action, "publish");
  assert.match(assessPreflight(clean, "260860838").problems.join("\n"), /already exists[\s\S]*not above/u);
  assert.match(assessPreflight(clean, "5").problems.join("\n"), /not above the highest uploaded versionCode 260860838/u);
  const draft = observation({
    bundles: [googleBundle(7)],
    releases: [googleRelease("draft", [7])],
  });
  assert.equal(draft.publicationGate, "attention");
  assert.match(assessPreflight(draft, "8").problems.join("\n"), /draft, staged or halted[\s\S]*gate needs attention/u);
  const orphan = observation({ bundles: [], releases: [googleRelease("completed", [3])] });
  assert.equal(orphan.publicationGate, "attention");
  assert.equal(assessPreflight(observation(), "1").ok, true);
  assert.throws(() => assessPreflight({ ...clean, stateSha256: "0".repeat(64) }, "9"), /digest does not match/u);
  assert.throws(() => assessPreflight({ ...clean, highestCommittedCode: 1 }, "9"), /summary does not match/u);
});

test("publish decision: unchanged -> publish, exact live release -> reconcile, anything else fails", () => {
  const sha = "a".repeat(64);
  const pre = observation({ bundles: [googleBundle(8)], releases: [googleRelease("completed", [8], "1.0 (8)")] });
  const args = { versionCode: "9", versionName: "1.0", artifactSha256: sha };
  assert.deepEqual(decidePublication({ pre, current: { ...pre, observedAt: "2026-09-02T12:05:00.000Z" }, ...args }), {
    action: "publish",
    baselineStateSha256: pre.stateSha256,
  });
  const live = observation({
    bundles: [googleBundle(8), googleBundle(9, sha)],
    releases: [googleRelease("completed", [9], "1.0 (9)")],
  });
  assert.equal(decidePublication({ pre, current: live, ...args }).action, "reconcile");
  const moved = observation({ bundles: [googleBundle(8), googleBundle(10)], releases: [] });
  assert.throws(() => decidePublication({ pre, current: moved, ...args }), /state moved after the build preflight/u);
  const otherBytes = observation({
    bundles: [googleBundle(8), googleBundle(9, OTHER_SHA256)],
    releases: [googleRelease("completed", [9], "1.0 (9)")],
  });
  assert.throws(() => decidePublication({ pre, current: otherBytes, ...args }), /state moved/u);
  const stalePre = observation({ bundles: [googleBundle(9, OTHER_SHA256)], releases: [] });
  assert.throws(
    () => decidePublication({ pre: stalePre, current: stalePre, ...args }),
    /preflight no longer holds/u,
  );
});

test("CLI: offline commands, bounded AAB reads and no path or credential disclosure", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "google-play-internal-test-"));
  const run = (args, env = {}) => spawnSync(process.execPath, [HELPER, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: temporary, ...env },
  });
  try {
    const pre = observation({ bundles: [googleBundle(8)], releases: [googleRelease("completed", [8], "1.0 (8)")] });
    const prePath = path.join(temporary, "pre.json");
    fs.writeFileSync(prePath, JSON.stringify(pre));

    await t.test("preflight passes, warns in dry runs and fails in release runs", () => {
      assert.equal(run(["android-preflight", prePath, "9"]).status, 0);
      const dry = run(["android-preflight", prePath, "8", "--dry-run"]);
      assert.equal(dry.status, 0);
      assert.match(dry.stdout, /^::warning::Google Play preflight: versionCode 8 already exists/mu);
      const release = run(["android-preflight", prePath, "8"]);
      assert.equal(release.status, 1);
      assert.match(release.stdout, /^::error::Google Play preflight/mu);
      assert.match(release.stderr, /one-shot preflight refused/u);
    });

    await t.test("decide prints canonical JSON", () => {
      const result = run(["android-decide", prePath, prePath, "9", "1.0", "a".repeat(64)]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).action, "publish");
    });

    await t.test("publish rejects a symlink without disclosing its path", () => {
      const target = path.join(temporary, "target.aab");
      const link = path.join(temporary, "linked-secret-name.aab");
      fs.writeFileSync(target, "not an Android bundle");
      fs.symlinkSync(target, link);
      const result = run(["android-publish", APPLICATION_ID, "31", "3.1", link, "a".repeat(64), "b".repeat(64)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Android bundle file is invalid or unbounded/u);
      assert.doesNotMatch(result.stderr, /linked-secret-name/u);
      assert.equal(result.stdout, "");
    });

    await t.test("publish rejects an oversized sparse file before reading it", () => {
      const oversized = path.join(temporary, "oversized.aab");
      fs.closeSync(fs.openSync(oversized, "w"));
      fs.truncateSync(oversized, 10 * 1024 * 1024 * 1024 + 1);
      const result = run(["android-publish", APPLICATION_ID, "31", "3.1", oversized, "a".repeat(64), "b".repeat(64)]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Android bundle file is invalid or unbounded/u);
    });

    await t.test("a regular file reaches credential validation; malformed credentials are not echoed", () => {
      const regular = path.join(temporary, "regular.aab");
      fs.writeFileSync(regular, "bounded bytes");
      const missing = run(["android-publish", APPLICATION_ID, "31", "3.1", regular, "a".repeat(64), "b".repeat(64)]);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is required/u);
      const secretish = "{not-json-private-material";
      const malformed = run(["android-observe", APPLICATION_ID], { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: secretish });
      assert.equal(malformed.status, 1);
      assert.match(malformed.stderr, /is not valid JSON/u);
      assert.doesNotMatch(malformed.stderr + malformed.stdout, /private-material/u);
    });

    await t.test("unknown commands print usage", () => {
      const result = run(["android-delete-everything"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /usage: google-play-internal\.mjs/u);
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
