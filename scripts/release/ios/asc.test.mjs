import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  assessAppleOneShot,
  createAppStoreConnectJwt,
  deriveAppleCandidateState,
  downloadAppleAppStoreProfile,
  observeAppleStore,
  reconcileAppleBuild,
  reconcileExistingAppleBuild,
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
const CERTIFICATE_SHA1 = crypto.createHash("sha1").update(CERTIFICATE_BYTES).digest("hex");
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
    certificateSha1: CERTIFICATE_SHA1.toUpperCase(),
    token: ACCESS_TOKEN,
    fetchImpl,
    now: NOW,
  });
  assert.equal(selected.profileId, "exact");
  assert.equal(selected.uuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(selected.certificateSha1, CERTIFICATE_SHA1);
  assert.equal(selected.certificateId, "certificate-1");
  assert.ok(calls.every((call) => call.method === "GET" && call.url.origin === APPLE_ORIGIN));
  await assert.rejects(
    downloadAppleAppStoreProfile({ bundleId: BUNDLE_ID, certificateSha1: CERTIFICATE_SHA1, profileId: "other", token: ACCESS_TOKEN, fetchImpl, now: NOW }),
    /exactly one active iOS App Store profile/u,
  );
  await assert.rejects(
    downloadAppleAppStoreProfile({ bundleId: BUNDLE_ID, certificateSha1: "0".repeat(40), token: ACCESS_TOKEN, fetchImpl, now: NOW }),
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
