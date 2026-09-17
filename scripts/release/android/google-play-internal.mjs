#!/usr/bin/env node
// Dependency-free Google Play Developer API v3 client for the internal track.
//
// Contract (kept byte-for-byte with the previous release lane):
//   POST edits -> GET edits/{id}/bundles + GET edits/{id}/tracks/internal (404 = empty)
//   -> POST upload/.../edits/{id}/bundles?uploadType=media (raw AAB)
//   -> PUT edits/{id}/tracks/internal {track, releases:[{status:"completed", name, versionCodes}]}
//   -> POST edits/{id}:validate -> POST edits/{id}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW
// An edit is deleted on any failure before commit. A commit error is an
// ambiguity boundary resolved only by a fresh observation, never by a retry.
//
// Commands (stdout = canonical JSON, stderr = redacted diagnostics):
//   android-observe   <applicationId>
//   android-preflight <observation.json> <versionCode> [--dry-run]            (offline)
//   android-decide    <pre.json> <current.json> <versionCode> <versionName> <sha256>  (offline)
//   android-publish   <applicationId> <versionCode> <versionName> <aab> <sha256> <baselineStateSha256>
//   android-reconcile <applicationId> <versionCode> <versionName> <sha256>
// Credentials: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (raw service-account JSON).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const GOOGLE_API_ORIGIN = "https://androidpublisher.googleapis.com";
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const APPLICATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;
const INTEGER_VERSION = /^[1-9][0-9]*$/u;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;
const MAX_PROVIDER_VERSION_CODE = 2_100_000_000;
const MAX_ANDROID_BUNDLE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_OBSERVATION_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 2_000;
const RELEASE_STATUSES = ["draft", "inProgress", "halted", "completed"];

function fail(message) {
  throw new Error(`[google-play-internal] ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function boundedArray(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(`${label} is invalid or unbounded`);
  return value;
}

function providerVersionString(value, label) {
  exactString(value, INTEGER_VERSION, label);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > MAX_PROVIDER_VERSION_CODE) {
    fail(`${label} is invalid or exceeds the provider bound`);
  }
  return value;
}

function googleBundleVersionString(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROVIDER_VERSION_CODE) {
    fail(`${label} is invalid or exceeds the provider bound`);
  }
  return String(value);
}

function compareProviderVersions(left, right) {
  return Number(left) - Number(right);
}

export function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function canonicalSha256(value) {
  return crypto.createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function safeProviderUrl(value, origin, label, { upload = false } = {}) {
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    fail(`${label} URL is invalid`);
  }
  if (url.origin !== origin || origin !== GOOGLE_API_ORIGIN) fail(`${label} escaped its provider origin`);
  const prefix = upload ? "/upload/androidpublisher/v3/" : "/androidpublisher/v3/";
  if (!url.pathname.startsWith(prefix)) fail(`${label} escaped its provider API path`);
  return url;
}

export function createGoogleServiceAccountAssertion({ serviceAccount, now = new Date() }) {
  record(serviceAccount, "Google service account");
  exactString(serviceAccount.client_email, /^[^\s@]+@[^\s@]+$/u, "Google service-account email");
  if (
    serviceAccount.type !== "service_account" ||
    typeof serviceAccount.private_key !== "string" ||
    !serviceAccount.private_key.includes("BEGIN PRIVATE KEY")
  ) {
    fail("Google service-account key is invalid");
  }
  const tokenUri = serviceAccount.token_uri || `${GOOGLE_TOKEN_ORIGIN}/token`;
  let parsedTokenUri;
  try {
    parsedTokenUri = new URL(tokenUri);
  } catch {
    fail("Google service-account token endpoint is not allowlisted");
  }
  if (
    parsedTokenUri.origin !== GOOGLE_TOKEN_ORIGIN ||
    parsedTokenUri.pathname !== "/token" ||
    parsedTokenUri.username !== "" ||
    parsedTokenUri.password !== "" ||
    parsedTokenUri.search !== "" ||
    parsedTokenUri.hash !== ""
  ) {
    fail("Google service-account token endpoint is not allowlisted");
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) fail("JWT clock is invalid");
  const signingInput = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    })),
  ].join(".");
  let signature;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), serviceAccount.private_key);
  } catch {
    fail("Google service-account key could not sign an assertion");
  }
  return { assertion: `${signingInput}.${signature.toString("base64url")}`, tokenUri };
}

export async function resolveGoogleAccessToken({ serviceAccount, fetchImpl = fetch, now = new Date() }) {
  const { assertion, tokenUri } = createGoogleServiceAccountAssertion({ serviceAccount, now });
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    redirect: "error",
  });
  if (!response.ok) fail(`Google rejected the service-account assertion with HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("Google token endpoint returned malformed JSON");
  }
  if (typeof payload?.access_token !== "string" || payload.access_token.length < 20) {
    fail("Google token endpoint returned no access token");
  }
  return payload.access_token;
}

function googlePath(applicationId, suffix) {
  exactString(applicationId, APPLICATION_ID, "Android application ID");
  return `/androidpublisher/v3/applications/${encodeURIComponent(applicationId)}${suffix}`;
}

function googleUploadPath(applicationId, suffix) {
  exactString(applicationId, APPLICATION_ID, "Android application ID");
  return `/upload/androidpublisher/v3/applications/${encodeURIComponent(applicationId)}${suffix}`;
}

async function googleRequest(fetchImpl, accessToken, value, {
  method = "GET",
  body,
  contentType = body === undefined ? undefined : "application/json",
  allowNotFound = false,
  upload = false,
} = {}) {
  const url = safeProviderUrl(value, GOOGLE_API_ORIGIN, "Google Play request", { upload });
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    redirect: "error",
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`[google-play-internal] Google Play request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    fail("Google Play returned malformed JSON");
  }
}

async function openGoogleEdit({ applicationId, accessToken, fetchImpl }) {
  const payload = record(await googleRequest(
    fetchImpl,
    accessToken,
    googlePath(applicationId, "/edits"),
    { method: "POST", body: {} },
  ), "Google Play edit");
  return exactString(payload.id, OPAQUE_ID, "Google Play edit ID");
}

async function deleteGoogleEdit({ applicationId, editId, accessToken, fetchImpl }) {
  try {
    await googleRequest(
      fetchImpl,
      accessToken,
      googlePath(applicationId, `/edits/${encodeURIComponent(editId)}`),
      { method: "DELETE" },
    );
  } catch {
    // Cleanup never changes the publication verdict; edits expire server-side.
  }
}

export function normalizeGoogleEditState({ applicationId, bundlesPayload, trackPayload }) {
  const bundlesResponse = record(bundlesPayload, "Google Play bundles response");
  if (bundlesResponse.kind !== "androidpublisher#bundlesListResponse") {
    fail("Google Play bundles response kind is invalid");
  }
  const bundleResources = boundedArray(bundlesResponse.bundles, "Google Play bundles response items");
  let releaseResources = [];
  if (trackPayload !== null) {
    const trackResponse = record(trackPayload, "Google Play track response");
    if (trackResponse.track !== "internal") fail("Google Play track response is not the internal track");
    releaseResources = boundedArray(trackResponse.releases, "Google Play track response releases");
  }

  const bundles = bundleResources.map((value) => {
    record(value, "Google Play bundle");
    return {
      versionCode: googleBundleVersionString(value.versionCode, "Google Play bundle versionCode"),
      sha1: exactString(value.sha1, SHA1, "Google Play bundle SHA-1"),
      sha256: exactString(value.sha256, SHA256, "Google Play bundle SHA-256"),
    };
  }).sort((left, right) => compareProviderVersions(left.versionCode, right.versionCode));
  if (new Set(bundles.map((value) => value.versionCode)).size !== bundles.length) {
    fail("Google Play returned duplicate bundle versionCodes");
  }
  const releases = releaseResources.map((value) => {
    record(value, "Google Play track release");
    if (!RELEASE_STATUSES.includes(value.status)) fail("Google Play track release status is invalid");
    const rawVersionCodes = boundedArray(value.versionCodes, "Google Play track release versionCodes");
    if (rawVersionCodes.length === 0) fail("Google Play track release has no versionCodes");
    const versionCodes = rawVersionCodes.map((code) =>
      providerVersionString(code, "Google Play track versionCode"));
    if (new Set(versionCodes).size !== versionCodes.length) {
      fail("Google Play track release has duplicate versionCodes");
    }
    versionCodes.sort(compareProviderVersions);
    const name = value.name === undefined ? "" : value.name;
    if (typeof name !== "string" || name.length > 200) fail("Google Play track release name is invalid");
    return { name, status: value.status, versionCodes };
  }).sort((left, right) =>
    `${left.status}\0${left.versionCodes.join(",")}\0${left.name}`.localeCompare(
      `${right.status}\0${right.versionCodes.join(",")}\0${right.name}`,
    ));
  return {
    schemaVersion: 1,
    provider: "google-play",
    applicationId,
    track: "internal",
    bundles,
    releases,
  };
}

// Version-independent facts derived from the normalized state. They are not
// part of stateSha256, which covers only the provider state itself.
export function summarizeGoogleState(state) {
  const codes = new Set(state.bundles.map((bundle) => bundle.versionCode));
  const highest = state.bundles.reduce((maximum, bundle) => Math.max(maximum, Number(bundle.versionCode)), 0);
  const attention =
    state.releases.some((release) => release.status !== "completed") ||
    state.releases.some((release) => release.versionCodes.some((code) => !codes.has(code)));
  return {
    highestCommittedCode: highest === 0 ? null : highest,
    publicationGate: attention ? "attention" : "clear",
  };
}

async function readGoogleEditState({ applicationId, editId, accessToken, fetchImpl }) {
  const base = googlePath(applicationId, `/edits/${encodeURIComponent(editId)}`);
  const bundlesPayload = await googleRequest(fetchImpl, accessToken, `${base}/bundles`);
  const trackPayload = await googleRequest(fetchImpl, accessToken, `${base}/tracks/internal`, {
    allowNotFound: true,
  });
  return normalizeGoogleEditState({ applicationId, bundlesPayload, trackPayload });
}

export async function observeGoogleStore({
  applicationId,
  serviceAccount,
  accessToken,
  fetchImpl = fetch,
  now = new Date(),
}) {
  exactString(applicationId, APPLICATION_ID, "Android application ID");
  const token = accessToken || await resolveGoogleAccessToken({ serviceAccount, fetchImpl, now });
  let editId = null;
  try {
    editId = await openGoogleEdit({ applicationId, accessToken: token, fetchImpl });
    const state = await readGoogleEditState({ applicationId, editId, accessToken: token, fetchImpl });
    return {
      ...state,
      ...summarizeGoogleState(state),
      stateSha256: canonicalSha256(state),
      observedAt: now.toISOString(),
    };
  } finally {
    if (editId !== null) await deleteGoogleEdit({ applicationId, editId, accessToken: token, fetchImpl });
  }
}

// Re-validates an observation read back from disk (an artifact of this run)
// and proves its digest and derived summary still describe its state.
export function validateObservation(value) {
  record(value, "Google Play observation");
  const state = normalizeGoogleEditState({
    applicationId: exactString(value.applicationId, APPLICATION_ID, "observation applicationId"),
    bundlesPayload: {
      kind: "androidpublisher#bundlesListResponse",
      bundles: boundedArray(value.bundles, "observation bundles").map((bundle) => ({
        ...record(bundle, "observation bundle"),
        versionCode: Number(providerVersionString(bundle.versionCode, "observation bundle versionCode")),
      })),
    },
    trackPayload: { track: value.track, releases: value.releases },
  });
  if (value.schemaVersion !== 1 || value.provider !== "google-play" || value.track !== "internal") {
    fail("Google Play observation identity is not exact");
  }
  if (canonicalSha256(state) !== exactString(value.stateSha256, SHA256, "observation stateSha256")) {
    fail("Google Play observation digest does not match its state");
  }
  const summary = summarizeGoogleState(state);
  if (
    value.highestCommittedCode !== summary.highestCommittedCode ||
    value.publicationGate !== summary.publicationGate
  ) {
    fail("Google Play observation summary does not match its state");
  }
  if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) {
    fail("Google Play observation timestamp is invalid");
  }
  return { ...state, ...summary, stateSha256: value.stateSha256, observedAt: value.observedAt };
}

export function assessPreflight(observation, versionCode) {
  const value = validateObservation(observation);
  providerVersionString(versionCode, "Android versionCode");
  const problems = [];
  if (value.bundles.some((bundle) => bundle.versionCode === versionCode)) {
    problems.push(`versionCode ${versionCode} already exists on Google Play`);
  }
  if (value.highestCommittedCode !== null && value.highestCommittedCode >= Number(versionCode)) {
    problems.push(`versionCode ${versionCode} is not above the highest uploaded versionCode ${value.highestCommittedCode}`);
  }
  if (value.releases.some((release) => release.status !== "completed")) {
    problems.push("the internal track has draft, staged or halted releases");
  }
  if (value.publicationGate !== "clear") problems.push("the internal track publication gate needs attention");
  return { ok: problems.length === 0, problems, stateSha256: value.stateSha256 };
}

export function selectAndroidVersionCode(observation, committedVersionCode) {
  const verdict = assessPreflight(observation, committedVersionCode);
  return { action: verdict.ok ? "publish" : "attention", versionCode: committedVersionCode };
}

export function googleReleaseMatches(observation, versionCode, versionName, artifactSha256) {
  const bundle = observation.bundles.find((value) => value.versionCode === versionCode);
  return bundle?.sha256 === artifactSha256 &&
    observation.releases.length === 1 &&
    observation.releases[0].status === "completed" &&
    observation.releases[0].name === `${versionName} (${versionCode})` &&
    observation.releases[0].versionCodes.length === 1 &&
    observation.releases[0].versionCodes[0] === versionCode;
}

// Publish job decision, run immediately before the only mutable Play write:
// unchanged state since the build preflight -> publish; the exact release is
// already live with these bytes (re-run after an ambiguous commit) -> reconcile;
// anything else means Play state moved and the run fails closed.
export function decidePublication({ pre, current, versionCode, versionName, artifactSha256 }) {
  const baseline = validateObservation(pre);
  const now = validateObservation(current);
  providerVersionString(versionCode, "Android versionCode");
  exactString(versionName, VERSION_NAME, "Android versionName");
  exactString(artifactSha256, SHA256, "Android bundle SHA-256");
  if (now.applicationId !== baseline.applicationId) fail("observations name different applications");
  if (now.stateSha256 === baseline.stateSha256) {
    const verdict = assessPreflight(baseline, versionCode);
    if (!verdict.ok) fail(`Google Play preflight no longer holds: ${verdict.problems.join("; ")}`);
    return { action: "publish", baselineStateSha256: baseline.stateSha256 };
  }
  if (googleReleaseMatches(now, versionCode, versionName, artifactSha256)) {
    return { action: "reconcile", baselineStateSha256: baseline.stateSha256 };
  }
  fail("Google Play state moved after the build preflight");
}

export async function publishGoogleInternal({
  applicationId,
  versionCode,
  versionName,
  artifactBytes,
  artifactSha256,
  expectedStateSha256,
  serviceAccount,
  accessToken,
  fetchImpl = fetch,
  now = new Date(),
}) {
  exactString(applicationId, APPLICATION_ID, "Android application ID");
  providerVersionString(versionCode, "Android versionCode");
  exactString(versionName, VERSION_NAME, "Android versionName");
  exactString(artifactSha256, SHA256, "Android bundle SHA-256");
  exactString(expectedStateSha256, SHA256, "Google Play baseline digest");
  if (!Buffer.isBuffer(artifactBytes) || artifactBytes.length === 0) fail("Android bundle bytes are missing");
  const actualSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  if (actualSha256 !== artifactSha256) fail("Android bundle bytes differ from their reserved digest");

  const token = accessToken || await resolveGoogleAccessToken({ serviceAccount, fetchImpl, now });
  let editId = null;
  let commitAttempted = false;
  try {
    editId = await openGoogleEdit({ applicationId, accessToken: token, fetchImpl });
    const before = await readGoogleEditState({ applicationId, editId, accessToken: token, fetchImpl });
    if (canonicalSha256(before) !== expectedStateSha256) {
      fail("Google Play state changed after the reviewed build preflight");
    }
    if (before.releases.some((release) => release.status !== "completed")) {
      fail("Google Play internal track contains draft, staged, or halted state");
    }

    const existing = before.bundles.find((value) => value.versionCode === versionCode);
    if (existing !== undefined) {
      if (existing.sha256 !== artifactSha256) fail("Google Play versionCode exists with different bytes");
    } else {
      const uploadPath = `${googleUploadPath(
        applicationId,
        `/edits/${encodeURIComponent(editId)}/bundles`,
      )}?uploadType=media`;
      const uploaded = record(await googleRequest(fetchImpl, token, uploadPath, {
        method: "POST",
        contentType: "application/octet-stream",
        body: artifactBytes,
        upload: true,
      }), "Google Play uploaded bundle");
      const uploadedVersionCode = googleBundleVersionString(
        uploaded.versionCode,
        "Google Play uploaded bundle versionCode",
      );
      if (uploadedVersionCode !== versionCode || uploaded.sha256 !== artifactSha256) {
        fail("Google Play upload response differs from the reserved bundle");
      }
    }

    await googleRequest(
      fetchImpl,
      token,
      googlePath(applicationId, `/edits/${encodeURIComponent(editId)}/tracks/internal`),
      {
        method: "PUT",
        body: {
          track: "internal",
          releases: [{
            status: "completed",
            name: `${versionName} (${versionCode})`,
            versionCodes: [versionCode],
          }],
        },
      },
    );
    await googleRequest(
      fetchImpl,
      token,
      googlePath(applicationId, `/edits/${encodeURIComponent(editId)}:validate`),
      { method: "POST", body: {} },
    );
    commitAttempted = true;
    await googleRequest(
      fetchImpl,
      token,
      `${googlePath(applicationId, `/edits/${encodeURIComponent(editId)}:commit`)}?changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
      { method: "POST", body: {} },
    );
    editId = null;
  } catch (error) {
    if (!commitAttempted && editId !== null) {
      await deleteGoogleEdit({ applicationId, editId, accessToken: token, fetchImpl });
      editId = null;
    }
    if (!commitAttempted) throw error;
    // A commit response is an ambiguity boundary. Never repeat the upload or
    // edit here; authenticate fresh provider state below instead.
  }

  const after = await observeGoogleStore({ applicationId, accessToken: token, fetchImpl, now });
  if (!googleReleaseMatches(after, versionCode, versionName, artifactSha256)) {
    fail("Google Play commit is ambiguous or did not converge to the reserved internal release");
  }
  return after;
}

export async function reconcileGoogleInternal({
  applicationId,
  versionCode,
  versionName,
  artifactSha256,
  serviceAccount,
  accessToken,
  fetchImpl = fetch,
  now = new Date(),
}) {
  exactString(applicationId, APPLICATION_ID, "Android application ID");
  providerVersionString(versionCode, "Android versionCode");
  exactString(versionName, VERSION_NAME, "Android versionName");
  exactString(artifactSha256, SHA256, "Android bundle SHA-256");
  const observation = await observeGoogleStore({ applicationId, serviceAccount, accessToken, fetchImpl, now });
  if (!googleReleaseMatches(observation, versionCode, versionName, artifactSha256)) {
    fail("Google Play does not prove the reserved internal release");
  }
  if (observation.publicationGate !== "clear") fail("Google Play publication gate needs attention after release");
  return observation;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") fail(`${name} is required`);
  return value;
}

function parseServiceAccount() {
  const raw = requiredEnvironment("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
  try {
    return JSON.parse(raw);
  } catch {
    fail("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

function readBoundedRegularFile(filePath, maximumBytes, label) {
  if (typeof filePath !== "string" || filePath === "" || filePath.includes("\0")) fail(`${label} path is invalid`);
  let descriptor = null;
  try {
    const initial = fs.lstatSync(filePath);
    if (!initial.isFile() || initial.isSymbolicLink()) fail(`${label} file is invalid or unbounded`);
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > maximumBytes ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino
    ) {
      fail(`${label} file is invalid or unbounded`);
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== opened.size) fail(`${label} file changed while it was being read`);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[google-play-internal]")) throw error;
    fail(`${label} file could not be read securely`);
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor holds no secret; process teardown closes it.
      }
    }
  }
}

function readObservationFile(filePath) {
  const bytes = readBoundedRegularFile(filePath, MAX_OBSERVATION_BYTES, "Google Play observation");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("Google Play observation file is not JSON");
  }
}

export async function cli(argv) {
  const command = argv[0] ?? "";
  if (command === "android-observe" && argv.length === 2) {
    return observeGoogleStore({ applicationId: argv[1], serviceAccount: parseServiceAccount() });
  }
  if (command === "android-preflight" && (argv.length === 3 || (argv.length === 4 && argv[3] === "--dry-run"))) {
    const verdict = assessPreflight(readObservationFile(argv[1]), argv[2]);
    const dryRun = argv.length === 4;
    for (const problem of verdict.problems) {
      process.stdout.write(`::${dryRun ? "warning" : "error"}::Google Play preflight: ${problem}\n`);
    }
    if (!verdict.ok && !dryRun) fail("Google Play one-shot preflight refused this versionCode");
    return null;
  }
  if (command === "android-decide" && argv.length === 6) {
    return decidePublication({
      pre: readObservationFile(argv[1]),
      current: readObservationFile(argv[2]),
      versionCode: argv[3],
      versionName: argv[4],
      artifactSha256: argv[5],
    });
  }
  if (command === "android-publish" && argv.length === 7) {
    const artifactBytes = readBoundedRegularFile(argv[4], MAX_ANDROID_BUNDLE_BYTES, "Android bundle");
    return publishGoogleInternal({
      applicationId: argv[1],
      versionCode: argv[2],
      versionName: argv[3],
      artifactBytes,
      artifactSha256: argv[5],
      expectedStateSha256: argv[6],
      serviceAccount: parseServiceAccount(),
    });
  }
  if (command === "android-reconcile" && argv.length === 5) {
    return reconcileGoogleInternal({
      applicationId: argv[1],
      versionCode: argv[2],
      versionName: argv[3],
      artifactSha256: argv[4],
      serviceAccount: parseServiceAccount(),
    });
  }
  fail("usage: google-play-internal.mjs android-observe <application-id> | android-preflight <observation-json> <version-code> [--dry-run] | android-decide <pre-json> <current-json> <version-code> <version-name> <sha256> | android-publish <application-id> <version-code> <version-name> <aab-path> <sha256> <baseline-sha256> | android-reconcile <application-id> <version-code> <version-name> <sha256>");
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  cli(process.argv.slice(2)).then(
    (value) => {
      if (value !== null) process.stdout.write(canonicalBytes(value));
    },
    (error) => {
      const message = error instanceof Error && error.message.startsWith("[google-play-internal]")
        ? error.message
        : "[google-play-internal] command failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
