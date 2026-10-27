import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  assessAppleOneShot,
  cli,
  createAppStoreConnectJwt,
  deriveAppleCandidateState,
  downloadAppleAppStoreProfile,
  observeAppleStore,
  reconcileAppleBuild,
  reconcileExistingAppleBuild,
  resolveAppleTargets,
  safeProviderUrl,
  selectAppleBuildNumber,
} from "./asc.mjs";

const APPLE_ORIGIN = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = "dev.instafy.studio";
const NATIVE_VERSION = "1.0";
const ACCESS_TOKEN = "provider-access-token-that-is-long-enough";
const NOW = new Date("2026-09-02T12:00:00.000Z");
const IPA_MD5 = "4".repeat(32);
const IPA_MD5_BASE64 = Buffer.from(IPA_MD5, "hex").toString("base64");
const IPA_SHA256 = "5".repeat(64);
const IPA_SHA256_BASE64 = Buffer.from(IPA_SHA256, "hex").toString("base64");
const CERTIFICATE_BYTES = Buffer.from("fixture distribution certificate");
const CERTIFICATE_SHA256 = crypto.createHash("sha256").update(CERTIFICATE_BYTES).digest("hex");
const PROFILE_CONTENT = Buffer.from("fixture signed profile").toString("base64");
const appleKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const applePrivateKey = appleKeys.privateKey.export({ type: "pkcs8", format: "pem" });

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function appleApp(id = "app-1") {
  return { type: "apps", id, attributes: { bundleId: BUNDLE_ID } };
}

function appleVersion(id = "version-1", version = NATIVE_VERSION, platform = "IOS") {
  return { type: "preReleaseVersions", id, attributes: { version, platform } };
}

function appleBuild(id, buildNumber, processingState = "VALID", { expired = false, audience = "INTERNAL_ONLY" } = {}) {
  return {
    type: "builds",
    id,
    attributes: {
      version: String(buildNumber),
      processingState,
      buildAudienceType: audience,
      expired,
      uploadedDate: "2026-09-02T11:00:00Z",
      usesNonExemptEncryption: false,
    },
  };
}

function appleBuildUpload(id, buildNumber, state = "COMPLETE") {
  return {
    type: "buildUploads",
    id,
    attributes: {
      cfBundleShortVersionString: NATIVE_VERSION,
      cfBundleVersion: String(buildNumber),
      state: { errors: [], state, warnings: [] },
      platform: "IOS",
      uploadedDate: "2026-09-02T11:00:00Z",
    },
  };
}

function appleUploadFile(id, {
  sizeBytes = 1_024,
  md5 = IPA_MD5_BASE64,
  includeComposite = true,
  fileAlgorithm = null,
  fileHash = null,
  uti = "com.apple.ipa",
  deliveryState = "COMPLETE",
} = {}) {
  return {
    type: "buildUploadFiles",
    id,
    attributes: {
      assetDeliveryState: { state: deliveryState },
      fileName: "Instafy.ipa",
      fileSize: sizeBytes,
      sourceFileChecksums: {
        ...(includeComposite ? { composite: { algorithm: "MD5", hash: md5 } } : {}),
        ...(fileAlgorithm === null ? {} : { file: { algorithm: fileAlgorithm, hash: fileHash } }),
      },
      uti,
    },
  };
}

function appleGroup(id, { internal = true, allBuilds = false } = {}) {
  return { type: "betaGroups", id, attributes: { name: id, isInternalGroup: internal, hasAccessToAllBuilds: allBuilds } };
}

function createAppleFetch({
  apps = [appleApp()],
  uploads = [],
  uploadFiles = {},
  versions = [appleVersion()],
  builds = [],
  groups = [appleGroup("group-1", { allBuilds: true })],
  groupBuilds = {},
  betaStates = {},
  onAssignment = () => {},
} = {}) {
  const calls = [];
  const fetchImpl = async (value, init = {}) => {
    const url = value instanceof URL ? value : new URL(value);
    const method = init.method ?? "GET";
    calls.push({ url: url.toString(), method, init });
    assert.equal(init.redirect, "error");
    if (method === "GET" && url.pathname === "/v1/apps") return json({ data: apps, links: { next: null } });
    if (method === "GET" && url.pathname === "/v1/apps/app-1/buildUploads") {
      return json({ data: uploads, links: { next: null } });
    }
    const files = url.pathname.match(/^\/v1\/buildUploads\/([^/]+)\/buildUploadFiles$/u);
    if (method === "GET" && files) return json({ data: uploadFiles[files[1]] ?? [], links: { next: null } });
    if (method === "GET" && url.pathname === "/v1/apps/app-1/preReleaseVersions") {
      return json({ data: versions, links: { next: null } });
    }
    if (method === "GET" && url.pathname === "/v1/preReleaseVersions/version-1/builds") {
      return json({ data: builds, links: { next: null } });
    }
    if (method === "GET" && url.pathname === "/v1/apps/app-1/betaGroups") {
      return json({ data: groups, links: { next: null } });
    }
    const group = url.pathname.match(/^\/v1\/betaGroups\/([^/]+)\/builds$/u);
    if (method === "GET" && group) return json({ data: groupBuilds[group[1]] ?? [], links: { next: null } });
    const detail = url.pathname.match(/^\/v1\/builds\/([^/]+)\/buildBetaDetail$/u);
    if (method === "GET" && detail) {
      return json({
        data: {
          type: "buildBetaDetails",
          id: `detail-${detail[1]}`,
          attributes: { internalBuildState: betaStates[detail[1]] ?? "IN_BETA_TESTING" },
        },
      });
    }
    const assignment = url.pathname.match(/^\/v1\/builds\/([^/]+)\/relationships\/betaGroups$/u);
    if (method === "POST" && assignment) {
      onAssignment({ buildId: assignment[1], body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    assert.fail(`unexpected App Store Connect request: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

async function observe(options) {
  const { fetchImpl } = createAppleFetch(options);
  return observeAppleStore({ bundleId: BUNDLE_ID, nativeVersion: NATIVE_VERSION, token: ACCESS_TOKEN, fetchImpl, now: NOW });
}

test("creates a short-lived ES256 App Store Connect JWT and validates identifiers", () => {
  const jwt = createAppStoreConnectJwt({
    keyId: "ABCD1234",
    issuerId: "11111111-2222-3333-4444-555555555555",
    privateKey: applePrivateKey,
    now: NOW,
  });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(decodeJwtPart(header), { alg: "ES256", kid: "ABCD1234", typ: "JWT" });
  const claims = decodeJwtPart(payload);
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.iss, "11111111-2222-3333-4444-555555555555");
  assert.ok(claims.exp - Math.floor(NOW.getTime() / 1000) <= 20 * 60);
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: appleKeys.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  const base = { keyId: "ABCD1234", issuerId: "11111111-2222-3333-4444-555555555555", privateKey: applePrivateKey, now: NOW };
  assert.throws(() => createAppStoreConnectJwt({ ...base, keyId: "bad" }), /key ID is invalid/u);
  assert.throws(() => createAppStoreConnectJwt({ ...base, issuerId: "nope" }), /issuer ID is invalid/u);
  assert.throws(() => createAppStoreConnectJwt({ ...base, privateKey: "not a key" }), /private key is invalid/u);
  assert.throws(() => createAppStoreConnectJwt({ ...base, now: new Date(Number.NaN) }), /JWT clock is invalid/u);
});

test("provider URLs are pinned to the App Store Connect v1 origin", () => {
  assert.equal(safeProviderUrl("/v1/apps").origin, APPLE_ORIGIN);
  assert.throws(() => safeProviderUrl("https://example.com/v1/apps"), /escaped/u);
  assert.throws(() => safeProviderUrl("/v2/apps"), /escaped/u);
  assert.throws(() => safeProviderUrl("/v1/apps", "https://example.com"), /not allowlisted/u);
});

test("observes the exact app, version, internal group and sorted builds", async () => {
  const observation = await observe({
    versions: [appleVersion("old", "0.9"), appleVersion("mac", NATIVE_VERSION, "MAC_OS"), appleVersion()],
    builds: [appleBuild("build-12", 12, "PROCESSING"), appleBuild("build-10", 10)],
    groups: [appleGroup("external", { internal: false, allBuilds: true }), appleGroup("group-1", { allBuilds: true }), appleGroup("group-2")],
    groupBuilds: { "group-1": [appleBuild("build-10", 10)] },
  });
  assert.equal(observation.appId, "app-1");
  assert.equal(observation.preReleaseVersionId, "version-1");
  assert.equal(observation.betaGroupSelection, "unique-all-builds");
  assert.deepEqual(observation.builds.map((build) => [build.buildNumber, build.distributed, build.internalBuildState]), [
    ["10", true, "IN_BETA_TESTING"],
    ["12", false, null],
  ]);
  assert.match(observation.stateSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(selectAppleBuildNumber(observation, "13").action, "publish");
  assert.deepEqual(selectAppleBuildNumber(observation, "12").action, "attention");
});

test("one-shot gate: clear only when the exact build is absent and every committed build is lower", async () => {
  const empty = await observe({});
  assert.deepEqual(deriveAppleCandidateState(empty, "81"), {
    buildNumber: "81",
    highestCommittedCode: null,
    publicationGate: "clear",
    candidate: { buildState: "absent", internalTesterState: "absent" },
  });
  assert.equal(assessAppleOneShot(empty, "81").ok, true);

  const existing = await observe({
    uploads: [appleBuildUpload("upload-81", 81)],
    uploadFiles: { "upload-81": [appleUploadFile("ipa-81")] },
    builds: [appleBuild("build-81", 81)],
    groupBuilds: { "group-1": [appleBuild("build-81", 81)] },
  });
  const state = deriveAppleCandidateState(existing, "81");
  assert.deepEqual(state.candidate, { buildState: "ready", internalTesterState: "available" });
  const strict = assessAppleOneShot(existing, "81");
  assert.equal(strict.ok, false);
  assert.ok(strict.errors.some((error) => /already exists/u.test(error)));
  const dryRun = assessAppleOneShot(existing, "81", { strict: false });
  assert.equal(dryRun.ok, true);
  assert.ok(dryRun.warnings.length >= 2);

  const higher = await observe({ builds: [appleBuild("build-90", 90)] });
  assert.equal(assessAppleOneShot(higher, "81").ok, false);

  const ambiguous = await observe({ groups: [appleGroup("a"), appleGroup("b")] });
  assert.equal(ambiguous.betaGroup, null);
  assert.equal(assessAppleOneShot(ambiguous, "81", { strict: false }).ok, false);

  const tampered = { ...empty, builds: [{ ...appleBuild("x", 1) }] };
  assert.throws(() => deriveAppleCandidateState(tampered, "81"), /digest does not match/u);

  const invalid = await observe({ builds: [appleBuild("build-81", 81, "INVALID")] });
  assert.equal(deriveAppleCandidateState(invalid, "81").candidate.buildState, "invalid");
  assert.equal(deriveAppleCandidateState(invalid, "81").publicationGate, "attention");
});

function clockedReconcile(overrides) {
  let clock = NOW.getTime();
  return {
    now: () => new Date(clock),
    sleep: async (milliseconds) => { clock += milliseconds; },
    token: ACCESS_TOKEN,
    bundleId: BUNDLE_ID,
    nativeVersion: NATIVE_VERSION,
    buildNumber: "20",
    requestedAppId: "app-1",
    requestedBetaGroupId: "group-1",
    timeoutSeconds: 60,
    intervalSeconds: 5,
    ...overrides,
  };
}

test("reconciles an exact upload, assigns a restricted internal group once, and proves availability", async () => {
  let distributed = false;
  const assigned = [];
  const fetchImpl = async (value, init) => createAppleFetch({
    uploads: [appleBuildUpload("upload-20", 20)],
    uploadFiles: { "upload-20": [appleUploadFile("ipa-20", { includeComposite: false, fileAlgorithm: "SHA_256", fileHash: IPA_SHA256_BASE64 })] },
    builds: [appleBuild("build-20", 20)],
    groups: [appleGroup("group-1")],
    groupBuilds: { "group-1": distributed ? [appleBuild("build-20", 20)] : [] },
    onAssignment: ({ buildId, body }) => { assigned.push({ buildId, body }); distributed = true; },
  }).fetchImpl(value, init);
  const result = await reconcileAppleBuild(clockedReconcile({
    fetchImpl,
    artifactSizeBytes: 1_024,
    artifactMd5: IPA_MD5,
    artifactSha256: IPA_SHA256,
  }));
  assert.equal(result.builds[0].distributed, true);
  assert.deepEqual(assigned, [{ buildId: "build-20", body: { data: [{ type: "betaGroups", id: "group-1" }] } }]);
});

test("reconcile fails closed on digest drift, fatal states and timeouts", async (t) => {
  const base = {
    uploads: [appleBuildUpload("upload-20", 20)],
    uploadFiles: { "upload-20": [appleUploadFile("ipa-20")] },
    builds: [appleBuild("build-20", 20)],
    groupBuilds: { "group-1": [appleBuild("build-20", 20)] },
  };
  const artifact = { artifactSizeBytes: 1_024, artifactMd5: IPA_MD5, artifactSha256: IPA_SHA256 };
  const cases = [
    ["size drift", { ...base }, { ...artifact, artifactSizeBytes: 2_048 }, /differs from the reserved IPA/u],
    ["md5 drift", { ...base }, { ...artifact, artifactMd5: "6".repeat(32) }, /differs from the reserved IPA/u],
    ["upload failed", { ...base, uploads: [appleBuildUpload("upload-20", 20, "FAILED")], builds: [] }, artifact, /timed out/u],
    ["invalid build", { ...base, builds: [appleBuild("build-20", 20, "INVALID")] }, artifact, /reached INVALID/u],
    ["external audience", { ...base, builds: [appleBuild("build-20", 20, "VALID", { audience: "APP_STORE_ELIGIBLE" })] }, artifact, /internal audience/u],
    ["missing compliance", { ...base, betaStates: { "build-20": "MISSING_EXPORT_COMPLIANCE" } }, artifact, /MISSING_EXPORT_COMPLIANCE/u],
    ["never processed", { ...base, builds: [appleBuild("build-20", 20, "PROCESSING")] }, artifact, /timed out/u],
  ];
  for (const [name, fetchOptions, digests, expected] of cases) {
    await t.test(name, async () => {
      const { fetchImpl } = createAppleFetch(fetchOptions);
      await assert.rejects(reconcileAppleBuild(clockedReconcile({ fetchImpl, ...digests })), expected);
    });
  }
});

test("reconcile-existing never uploads and reports App Store Connect's own digests", async () => {
  const { fetchImpl, calls } = createAppleFetch({
    uploads: [appleBuildUpload("upload-20", 20)],
    uploadFiles: { "upload-20": [appleUploadFile("ipa-20", { sizeBytes: 4_096 })] },
    builds: [appleBuild("build-20", 20)],
    groupBuilds: { "group-1": [appleBuild("build-20", 20)] },
  });
  const result = await reconcileExistingAppleBuild(clockedReconcile({ fetchImpl }));
  assert.deepEqual(result.uploadedIpa, { sizeBytes: 4_096, md5: IPA_MD5, sha256: null });
  assert.ok(calls.every((call) => call.method === "GET"));

  const opaque = createAppleFetch({
    uploads: [appleBuildUpload("upload-20", 20)],
    uploadFiles: { "upload-20": [appleUploadFile("ipa-20", { md5: "not-a-digest" })] },
    builds: [appleBuild("build-20", 20)],
    groupBuilds: { "group-1": [appleBuild("build-20", 20)] },
  });
  await assert.rejects(
    reconcileExistingAppleBuild(clockedReconcile({ fetchImpl: opaque.fetchImpl })),
    /no complete digest proof/u,
  );
});

test("downloads exactly one active App Store profile bound to the imported certificate", async () => {
  const calls = [];
  const fetchImpl = async (value, init = {}) => {
    const url = value instanceof URL ? value : new URL(value);
    calls.push({ url, method: init.method ?? "GET" });
    if (url.pathname === "/v1/bundleIds") {
      return json({ data: [{ type: "bundleIds", id: "bundle-1", attributes: { identifier: BUNDLE_ID, platform: "IOS" } }], links: { next: null } });
    }
    if (url.pathname === "/v1/bundleIds/bundle-1/profiles") {
      const profile = (id, attributes = {}) => ({
        type: "profiles",
        id,
        attributes: {
          name: `Instafy ${id}`,
          uuid: "11111111-2222-3333-4444-555555555555",
          profileState: "ACTIVE",
          profileType: "IOS_APP_STORE",
          platform: "IOS",
          expirationDate: "2027-09-02T12:00:00.000Z",
          profileContent: PROFILE_CONTENT,
          ...attributes,
        },
      });
      return json({
        data: [profile("development", { profileType: "IOS_APP_DEVELOPMENT" }), profile("invalid", { profileState: "INVALID" }), profile("exact")],
        links: { next: null },
      });
    }
    if (url.pathname === "/v1/certificates") {
      return json({
        data: [{
          type: "certificates",
          id: "certificate-1",
          attributes: {
            certificateType: "DISTRIBUTION",
            certificateContent: CERTIFICATE_BYTES.toString("base64"),
            expirationDate: "2027-09-02T12:00:00.000Z",
            activated: true,
          },
        }],
        links: {},
      });
    }
    assert.fail(`unexpected request ${url}`);
  };
  const selected = await downloadAppleAppStoreProfile({
    bundleId: BUNDLE_ID,
    certificateSha256: CERTIFICATE_SHA256.toUpperCase(),
    token: ACCESS_TOKEN,
    fetchImpl,
    now: NOW,
  });
  assert.equal(selected.profileId, "exact");
  assert.equal(selected.uuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(selected.certificateSha256, CERTIFICATE_SHA256);
  assert.equal(selected.certificateId, "certificate-1");
  assert.ok(calls.every((call) => call.method === "GET" && call.url.origin === APPLE_ORIGIN));
  await assert.rejects(
    downloadAppleAppStoreProfile({ bundleId: BUNDLE_ID, certificateSha256: CERTIFICATE_SHA256, profileId: "other", token: ACCESS_TOKEN, fetchImpl, now: NOW }),
    /exactly one active iOS App Store profile/u,
  );
  await assert.rejects(
    downloadAppleAppStoreProfile({ bundleId: BUNDLE_ID, certificateSha256: "0".repeat(64), token: ACCESS_TOKEN, fetchImpl, now: NOW }),
    /exactly one active distribution certificate/u,
  );
});

test("CLI errors never print provider bodies or credentials", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [new URL("./asc.mjs", import.meta.url).pathname, "observe", BUNDLE_ID, NATIVE_VERSION], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, APP_STORE_CONNECT_KEY_ID: "ABCD1234", APP_STORE_CONNECT_ISSUER_ID: "bad", APP_STORE_CONNECT_PRIVATE_KEY: "super-secret-value" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[ios-asc\] App Store Connect issuer ID is invalid\n$/u);
  assert.doesNotMatch(result.stderr, /super-secret-value/u);
});

// A fetch failure that never produced a response, shaped like undici's.
function noResponse(code = "UND_ERR_HEADERS_TIMEOUT") {
  return Object.assign(new TypeError("fetch failed: provider-detail-that-must-not-leak"), {
    cause: Object.assign(new Error("provider-detail-that-must-not-leak"), { code }),
  });
}

// Wraps the fake App Store Connect so the first `failures` requests matching
// `matches` fail with `failure()` (a thrown error or a Response).
function flakyAppleFetch(options, { failures, failure, matches = (url) => url.pathname === "/v1/apps" }) {
  const inner = createAppleFetch(options);
  const attempts = [];
  let remaining = failures;
  const fetchImpl = async (value, init = {}) => {
    const url = value instanceof URL ? value : new URL(value);
    attempts.push({ url: url.toString(), method: init.method ?? "GET", signal: init.signal });
    if (remaining > 0 && matches(url, init)) {
      remaining -= 1;
      const outcome = failure();
      if (outcome instanceof Response) return outcome;
      throw outcome;
    }
    return inner.fetchImpl(value, init);
  };
  return { fetchImpl, attempts, calls: inner.calls };
}

async function rejectsWithMessage(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /provider-detail/u);
    return true;
  });
}

function observeWith(fetchImpl, sleeps = []) {
  return observeAppleStore({
    bundleId: BUNDLE_ID,
    nativeVersion: NATIVE_VERSION,
    token: ACCESS_TOKEN,
    fetchImpl,
    now: NOW,
    retrySleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });
}

test("idempotent reads retry a request that got no response, each under a bounded timeout", async () => {
  const sleeps = [];
  const flaky = flakyAppleFetch({}, { failures: 2, failure: () => noResponse() });
  const observation = await observeWith(flaky.fetchImpl, sleeps);
  assert.equal(observation.appId, "app-1");
  assert.deepEqual(sleeps, [1_000, 3_000]);
  assert.equal(flaky.attempts.filter((attempt) => new URL(attempt.url).pathname === "/v1/apps").length, 3);
  for (const attempt of flaky.attempts) {
    assert.ok(attempt.signal instanceof AbortSignal);
    assert.equal(attempt.signal.aborted, false);
  }
});

test("a read that never gets a response fails with a prefixed, provider-free reason", async (t) => {
  const cases = [
    ["undici code", () => noResponse("ECONNRESET"), /^\[ios-asc\] App Store Connect apps request got no response \(ECONNRESET\) after 3 attempts$/u],
    ["request timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      /^\[ios-asc\] App Store Connect apps request got no response \(timed out after 60 s\) after 3 attempts$/u],
    ["opaque failure", () => Object.assign(new Error("provider-detail-that-must-not-leak"), { name: "provider detail" }),
      /^\[ios-asc\] App Store Connect apps request got no response \(unknown network failure\) after 3 attempts$/u],
  ];
  for (const [name, failure, expected] of cases) {
    await t.test(name, async () => {
      const flaky = flakyAppleFetch({}, { failures: 3, failure });
      await rejectsWithMessage(observeWith(flaky.fetchImpl), expected);
      assert.equal(flaky.attempts.length, 3);
    });
  }
});

test("reads retry HTTP 5xx and a body that breaks off, but not other statuses", async () => {
  const fiveHundreds = flakyAppleFetch({}, { failures: 2, failure: () => json({ errors: [] }, 503) });
  assert.equal((await observeWith(fiveHundreds.fetchImpl)).appId, "app-1");

  const exhausted = flakyAppleFetch({}, { failures: 3, failure: () => json({ errors: [] }, 503) });
  await rejectsWithMessage(observeWith(exhausted.fetchImpl), /^\[ios-asc\] App Store Connect apps request failed with HTTP 503 after 3 attempts$/u);

  const brokenBody = flakyAppleFetch({}, {
    failures: 1,
    failure: () => new Response(new ReadableStream({ start(controller) { controller.error(noResponse("UND_ERR_SOCKET")); } }), { status: 200 }),
  });
  assert.equal((await observeWith(brokenBody.fetchImpl)).appId, "app-1");

  const unauthorized = flakyAppleFetch({}, { failures: 1, failure: () => json({ errors: [] }, 401) });
  await rejectsWithMessage(observeWith(unauthorized.fetchImpl), /^\[ios-asc\] App Store Connect apps request failed with HTTP 401$/u);
  assert.equal(unauthorized.attempts.length, 1);

  const malformed = flakyAppleFetch({}, { failures: 1, failure: () => new Response("{", { status: 200 }) });
  await assert.rejects(observeWith(malformed.fetchImpl), /returned malformed JSON/u);
});

function distributionFixture({ distributed }) {
  return {
    uploads: [appleBuildUpload("upload-20", 20)],
    uploadFiles: { "upload-20": [appleUploadFile("ipa-20")] },
    builds: [appleBuild("build-20", 20)],
    groups: [appleGroup("group-1")],
    groupBuilds: { "group-1": distributed ? [appleBuild("build-20", 20)] : [] },
  };
}

test("the TestFlight group assignment is never retried after a missing response", async () => {
  const flaky = flakyAppleFetch(distributionFixture({ distributed: false }), {
    failures: 5,
    failure: () => noResponse("ECONNRESET"),
    matches: (_url, init) => init.method === "POST",
  });
  await rejectsWithMessage(
    reconcileAppleBuild(clockedReconcile({
      fetchImpl: flaky.fetchImpl,
      artifactSizeBytes: 1_024,
      artifactMd5: IPA_MD5,
      artifactSha256: IPA_SHA256,
      onTransientFailure: () => assert.fail("a mutation failure is not transient"),
    })),
    /^\[ios-asc\] TestFlight beta-group assignment POST request got no response \(ECONNRESET\); App Store Connect may or may not have applied it$/u,
  );
  assert.equal(flaky.attempts.filter((attempt) => attempt.method === "POST").length, 1);

  const gateway = flakyAppleFetch(distributionFixture({ distributed: false }), {
    failures: 5,
    failure: () => json({ errors: [] }, 504),
    matches: (_url, init) => init.method === "POST",
  });
  await rejectsWithMessage(
    reconcileAppleBuild(clockedReconcile({
      fetchImpl: gateway.fetchImpl,
      artifactSizeBytes: 1_024,
      artifactMd5: IPA_MD5,
      artifactSha256: IPA_SHA256,
      onTransientFailure: () => assert.fail("a mutation failure is not transient"),
    })),
    /^\[ios-asc\] TestFlight beta-group assignment POST request failed with HTTP 504; App Store Connect may or may not have applied it$/u,
  );
  assert.equal(gateway.attempts.filter((attempt) => attempt.method === "POST").length, 1);
});

test("the processing poll outlasts a read outage and reports it, then succeeds", async () => {
  const reported = [];
  // Six failures: two whole observations fail after their own three attempts.
  const flaky = flakyAppleFetch(distributionFixture({ distributed: true }), { failures: 6, failure: () => noResponse() });
  const result = await reconcileAppleBuild(clockedReconcile({
    fetchImpl: flaky.fetchImpl,
    artifactSizeBytes: 1_024,
    artifactMd5: IPA_MD5,
    artifactSha256: IPA_SHA256,
    onTransientFailure: (message) => reported.push(message),
  }));
  assert.equal(result.builds[0].distributed, true);
  assert.deepEqual(reported, Array(2).fill(
    "[ios-asc] App Store Connect apps request got no response (UND_ERR_HEADERS_TIMEOUT) after 3 attempts; polling again in 5 s",
  ));
});

test("the processing poll still ends at its deadline, naming the last read failure", async () => {
  const reported = [];
  const flaky = flakyAppleFetch(distributionFixture({ distributed: true }), { failures: Infinity, failure: () => json({ errors: [] }, 502) });
  await rejectsWithMessage(
    reconcileExistingAppleBuild(clockedReconcile({ fetchImpl: flaky.fetchImpl, onTransientFailure: (message) => reported.push(message) })),
    /^\[ios-asc\] TestFlight build processing or internal-group distribution timed out \(the last read failed: App Store Connect apps request failed with HTTP 502 after 3 attempts\)$/u,
  );
  // 60 s deadline, 5 s interval, and the retry sleeps share the same clock.
  assert.ok(reported.length >= 5 && reported.length <= 12);

  const fatal = flakyAppleFetch(distributionFixture({ distributed: true }), { failures: 1, failure: () => json({ errors: [] }, 403) });
  await assert.rejects(
    reconcileExistingAppleBuild(clockedReconcile({ fetchImpl: fatal.fetchImpl, onTransientFailure: () => assert.fail("HTTP 403 is not transient") })),
    /request failed with HTTP 403$/u,
  );
});

function clockedTargets(fetchImpl, overrides = {}) {
  let clock = NOW.getTime();
  return {
    bundleId: BUNDLE_ID,
    nativeVersion: NATIVE_VERSION,
    tokenFactory: () => ACCESS_TOKEN,
    fetchImpl,
    now: () => new Date(clock),
    sleep: async (milliseconds) => { clock += milliseconds; },
    timeoutSeconds: 600,
    intervalSeconds: 30,
    ...overrides,
  };
}

test("target resolution after the upload outlasts a read outage inside the poll's one budget", async () => {
  const reported = [];
  // The first observation fails after its own three attempts (1 s + 3 s of retry sleeps).
  const flaky = flakyAppleFetch({ groups: [appleGroup("group-1")] }, { failures: 3, failure: () => noResponse("ECONNRESET") });
  const targets = await resolveAppleTargets(clockedTargets(flaky.fetchImpl, { onTransientFailure: (message) => reported.push(message) }));
  assert.deepEqual(targets, { appId: "app-1", betaGroupId: "group-1", timeoutSeconds: 600 - 4 - 30 });
  assert.deepEqual(reported, [
    "[ios-asc] App Store Connect apps request got no response (ECONNRESET) after 3 attempts; polling again in 30 s",
  ]);

  const forbidden = flakyAppleFetch({}, { failures: 1, failure: () => json({ errors: [] }, 403) });
  await rejectsWithMessage(
    resolveAppleTargets(clockedTargets(forbidden.fetchImpl, { onTransientFailure: () => assert.fail("HTTP 403 is not transient") })),
    /^\[ios-asc\] App Store Connect apps request failed with HTTP 403$/u,
  );

  const down = flakyAppleFetch({}, { failures: Infinity, failure: () => json({ errors: [] }, 503) });
  await rejectsWithMessage(
    resolveAppleTargets(clockedTargets(down.fetchImpl, { timeoutSeconds: 120, onTransientFailure: () => {} })),
    /^\[ios-asc\] App Store Connect apps request failed with HTTP 503 after 3 attempts$/u,
  );
});

test("a NOT_FOUND answer whose body breaks off is read again", async () => {
  const notFoundBody = () => json({ errors: [{ status: "404", code: "NOT_FOUND", title: "Not found", detail: "none" }] }, 404);
  const brokenNotFound = () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"errors":'));
        controller.error(noResponse("UND_ERR_SOCKET"));
      },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
  const profileFetch = (profiles) => {
    const calls = [];
    const fetchImpl = async (value, init = {}) => {
      const url = value instanceof URL ? value : new URL(value);
      calls.push(url.pathname);
      if (url.pathname === "/v1/bundleIds") {
        return json({ data: [{ type: "bundleIds", id: "bundle-1", attributes: { identifier: BUNDLE_ID, platform: "IOS" } }], links: { next: null } });
      }
      if (url.pathname === "/v1/bundleIds/bundle-1/profiles") return profiles(calls.filter((path) => path === url.pathname).length);
      assert.fail(`unexpected request ${url}`);
    };
    return { fetchImpl, calls };
  };
  const download = (fetchImpl) => downloadAppleAppStoreProfile({
    bundleId: BUNDLE_ID,
    certificateSha256: CERTIFICATE_SHA256,
    token: ACCESS_TOKEN,
    fetchImpl,
    now: NOW,
    retrySleep: async () => {},
  });

  const recovers = profileFetch((attempt) => (attempt === 1 ? brokenNotFound() : notFoundBody()));
  await assert.rejects(download(recovers.fetchImpl), /exactly one active iOS App Store profile/u);
  assert.equal(recovers.calls.filter((path) => path.endsWith("/profiles")).length, 2);

  const never = profileFetch(() => brokenNotFound());
  await rejectsWithMessage(
    download(never.fetchImpl),
    /^\[ios-asc\] App Store Connect bundle profiles request got no complete response body \(UND_ERR_SOCKET\) after 3 attempts$/u,
  );
  assert.equal(never.calls.filter((path) => path.endsWith("/profiles")).length, 3);
});

test("the reconcile CLI binds the poll to the resolved targets and the shared budget", async (t) => {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    globalThis.fetch = savedFetch;
  });
  Object.assign(process.env, {
    APP_STORE_CONNECT_KEY_ID: "ABCD1234",
    APP_STORE_CONNECT_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
    APP_STORE_CONNECT_PRIVATE_KEY: applePrivateKey,
    APP_STORE_CONNECT_APP_ID: "app-1",
    APP_STORE_CONNECT_INTERNAL_BETA_GROUP_ID: "group-1",
    IOS_ASC_POLL_TIMEOUT_SECONDS: "60",
    IOS_ASC_POLL_INTERVAL_SECONDS: "5",
  });
  const fixture = createAppleFetch(distributionFixture({ distributed: true }));
  globalThis.fetch = fixture.fetchImpl;
  const observation = await cli(["reconcile", BUNDLE_ID, NATIVE_VERSION, "20", "1024", IPA_MD5, IPA_SHA256]);
  assert.equal(observation.appId, "app-1");
  assert.equal(observation.betaGroup.id, "group-1");
  assert.ok(fixture.calls.every((call) => call.method === "GET" && /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u.test(call.init.headers.authorization)));

  process.env.IOS_ASC_POLL_INTERVAL_SECONDS = "1";
  await rejectsWithMessage(
    cli(["reconcile", BUNDLE_ID, NATIVE_VERSION, "20", "1024", IPA_MD5, IPA_SHA256]),
    /^\[ios-asc\] Apple polling interval is invalid$/u,
  );
});
