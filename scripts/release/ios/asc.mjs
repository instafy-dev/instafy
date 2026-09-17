#!/usr/bin/env node
// App Store Connect helpers for the public iOS TestFlight internal release lane.
// Read-only observation, exact App Store profile download and upload
// reconciliation. Every provider URL is pinned to api.appstoreconnect.apple.com
// and no token or private key is ever printed.

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APPLE_API_ORIGIN = "https://api.appstoreconnect.apple.com";
// Split so repository secret scanners never see a bare PEM header literal.
const PKCS8_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const SHA256 = /^[0-9a-f]{64}$/u;
const MD5 = /^[0-9a-f]{32}$/u;
const APPLE_JWT = /^(?=.{20,4096}$)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const BUNDLE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;
const APPLE_PROVIDER_BUNDLE_ID =
  /^(?=.{1,200}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?|\*)$/u;
const NATIVE_VERSION = /^[0-9]+(?:\.[0-9]+){1,3}$/u;
const INTEGER_VERSION = /^[1-9][0-9]*$/u;
const MAX_PROVIDER_VERSION_CODE = 2_100_000_000;
const MAX_APPLE_CERTIFICATE_BYTES = 1024 * 1024;
const MAX_APPLE_PROFILE_BYTES = 10 * 1024 * 1024;
const MAX_APPLE_ERROR_BYTES = 64 * 1024;
const MAX_APPLE_ERRORS = 20;
const MAX_PAGES = 20;
const MAX_ITEMS = 2_000;
// App Store Connect documents HTTP 500 as a potentially temporary outage.
// Retry only idempotent reads; a provider mutation remains an ambiguity boundary.
const APPLE_TRANSIENT_READ_ATTEMPTS = 3;
const APPLE_TRANSIENT_READ_STATUSES = new Set([500, 502, 503, 504]);
const APPLE_TRANSIENT_READ_DELAYS_MS = [1_000, 3_000];
const APPLE_RELATIONSHIP_NOT_FOUND = Symbol("apple-relationship-not-found");
const APPLE_RELATIONSHIP_PATHS = new Map([
  ["bundle-profile", /^\/v1\/bundleIds\/[^/]{1,600}\/profiles$/u],
]);
const APPLE_BUNDLE_PLATFORMS = new Set(["IOS", "MAC_OS", "UNIVERSAL"]);
const APPLE_PROFILE_STATES = new Set(["ACTIVE", "INVALID"]);
const APPLE_PROFILE_TYPES = new Set([
  "IOS_APP_DEVELOPMENT",
  "IOS_APP_STORE",
  "IOS_APP_ADHOC",
  "IOS_APP_INHOUSE",
  "MAC_APP_DEVELOPMENT",
  "MAC_APP_STORE",
  "MAC_APP_DIRECT",
  "TVOS_APP_DEVELOPMENT",
  "TVOS_APP_STORE",
  "TVOS_APP_ADHOC",
  "TVOS_APP_INHOUSE",
  "MAC_CATALYST_APP_DEVELOPMENT",
  "MAC_CATALYST_APP_STORE",
  "MAC_CATALYST_APP_DIRECT",
]);
function fail(message) {
  throw new Error(`[ios-asc] ${message}`);
}

class AppStoreConnectHttpError extends Error {
  constructor(requestLabel, status, attempts = 1) {
    super(
      `[ios-asc] ${requestLabel} request failed with HTTP ${status}` +
        (attempts > 1 ? ` after ${attempts} attempts` : ""),
    );
    this.name = "AppStoreConnectHttpError";
    this.requestLabel = requestLabel;
    this.status = status;
    this.attempts = attempts;
  }
}

function sleepMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appleReconcileTokenSource({ token, tokenFactory }) {
  // Static tokens keep deterministic callers simple. The production CLI uses
  // the factory branch so the private key stays only in memory and each
  // potentially long-lived observation receives a newly minted JWT.
  if (tokenFactory === null) {
    if (typeof token !== "string" || token.length < 20) {
      fail("App Store Connect JWT is missing");
    }
    return async () => token;
  }
  if (token !== undefined || typeof tokenFactory !== "function") {
    fail("App Store Connect reconciliation token source is invalid");
  }
  return async () => {
    try {
      const freshToken = await tokenFactory();
      if (typeof freshToken !== "string" || !APPLE_JWT.test(freshToken)) {
        throw new Error("invalid App Store Connect JWT");
      }
      return freshToken;
    } catch {
      fail("App Store Connect JWT refresh failed");
    }
  };
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function failInvalidDigest(value, label) {
  const type = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
  if (type !== "string") fail(`${label} is invalid (type=${type})`);
  const hex = /^[0-9a-fA-F]+$/u.test(value);
  const base64 = /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
  const base64url = /^[A-Za-z0-9_-]+={0,2}$/u.test(value);
  const padding = /=+$/u.test(value);
  fail(
    `${label} is invalid (type=string length=${value.length} ` +
      `hex=${hex} base64=${base64} base64url=${base64url} padding=${padding})`,
  );
}

function canonicalDigestOrNull(value, {
  byteLength,
  hexPattern,
  encodedLength,
  padding,
  label,
}) {
  if (typeof value !== "string") failInvalidDigest(value, label);
  const hex = value.toLowerCase();
  if (hexPattern.test(hex)) return hex;

  const standard = new RegExp(`^[A-Za-z0-9+/]{${encodedLength}}(?:${padding})?$`, "u")
    .test(value);
  const urlSafe = new RegExp(`^[A-Za-z0-9_-]{${encodedLength}}(?:${padding})?$`, "u")
    .test(value);
  if (!standard && !urlSafe) return null;
  const unpadded = value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = `${unpadded}${padding}`;
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length !== byteLength || bytes.toString("base64") !== padded) return null;
  return bytes.toString("hex");
}

function canonicalMd5OrNull(value, label) {
  // Apple documents the composite algorithm as MD5 but does not document the
  // hash string encoding. Accept only encodings that round-trip to the exact
  // 16 digest bytes. Provider-opaque strings remain unproven instead of
  // preventing observation of unrelated historical uploads; exact candidate
  // publication still requires a non-null digest match downstream.
  return canonicalDigestOrNull(value, {
    byteLength: 16,
    hexPattern: MD5,
    encodedLength: 22,
    padding: "==",
    label,
  });
}

function canonicalSha256OrNull(value, label) {
  return canonicalDigestOrNull(value, {
    byteLength: 32,
    hexPattern: SHA256,
    encodedLength: 43,
    padding: "=",
    label,
  });
}

function appleChecksumProofSummary(counts) {
  return "[ios-asc] App Store Connect checksum proof shapes " +
    `files=${counts.files} compositePresent=${counts.compositePresent} ` +
    `compositeKnown=${counts.compositeKnown} compositeOpaque=${counts.compositeOpaque} ` +
    `filePresent=${counts.filePresent} fileMd5Known=${counts.fileMd5Known} ` +
    `fileMd5Opaque=${counts.fileMd5Opaque} fileSha256Known=${counts.fileSha256Known} ` +
    `fileSha256Opaque=${counts.fileSha256Opaque}`;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is invalid`);
  return value;
}

function boundedArray(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    fail(`${label} is invalid or unbounded`);
  }
  return value;
}

function providerVersionString(value, label) {
  exactString(value, INTEGER_VERSION, label);
  const numeric = Number(value);
  if (
    !Number.isSafeInteger(numeric) ||
    numeric <= 0 ||
    numeric > MAX_PROVIDER_VERSION_CODE
  ) {
    fail(`${label} is invalid or exceeds the provider bound`);
  }
  return value;
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

export function createAppStoreConnectJwt({ keyId, issuerId, privateKey, now = new Date() }) {
  exactString(keyId, /^[A-Za-z0-9]{4,32}$/u, "App Store Connect key ID");
  exactString(issuerId, /^[0-9a-fA-F-]{36}$/u, "App Store Connect issuer ID");
  if (
    typeof privateKey !== "string" ||
    !privateKey.trim().startsWith(PKCS8_HEADER)
  ) {
    fail("App Store Connect private key is invalid");
  }
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) fail("JWT clock is invalid");
  const signingInput = [
    base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })),
    base64url(JSON.stringify({
      iss: issuerId,
      iat: issuedAt - 5,
      exp: issuedAt + 15 * 60,
      aud: "appstoreconnect-v1",
    })),
  ].join(".");
  let signature;
  try {
    signature = crypto.sign("sha256", Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
  } catch {
    fail("App Store Connect private key could not sign a JWT");
  }
  if (signature.length !== 64) fail("App Store Connect JWT signature is invalid");
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function safeProviderUrl(value, origin = APPLE_API_ORIGIN, label = "App Store Connect request") {
  // App Store Connect is the only provider this lane talks to.
  if (origin !== APPLE_API_ORIGIN) fail(`${label} origin is not allowlisted`);
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    fail(`${label} URL is invalid`);
  }
  if (
    url.origin !== APPLE_API_ORIGIN ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.startsWith("/v1/")
  ) {
    fail(`${label} escaped its provider origin`);
  }
  return url;
}

async function validateAppleNotFoundResponse(response, label) {
  const invalid = () => fail(`${label} response is invalid or unbounded`);
  const mediaType = response.headers.get("content-type");
  if (
    typeof mediaType !== "string" ||
    !/^application\/json(?:\s*;[^\r\n]*)?$/iu.test(mediaType)
  ) {
    await response.body?.cancel().catch(() => {});
    invalid();
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/u.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      Number(declared) > MAX_APPLE_ERROR_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    invalid();
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    invalid();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      length += value.byteLength;
      if (length > MAX_APPLE_ERROR_BYTES) {
        await reader.cancel().catch(() => {});
        invalid();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) invalid();
  let payload;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)),
    );
  } catch {
    invalid();
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.errors) ||
    payload.errors.length === 0 ||
    payload.errors.length > MAX_APPLE_ERRORS
  ) {
    invalid();
  }
  for (const value of payload.errors) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.status !== "404" ||
      typeof value.code !== "string" ||
      !/^NOT_FOUND(?:\.[A-Z0-9_]+)*$/u.test(value.code) ||
      typeof value.title !== "string" ||
      typeof value.detail !== "string"
    ) {
      invalid();
    }
  }
  return APPLE_RELATIONSHIP_NOT_FOUND;
}

async function validateAppleRelationshipNotFound(response, phase) {
  if (!APPLE_RELATIONSHIP_PATHS.has(phase)) {
    fail("App Store Connect relationship NOT_FOUND phase is invalid");
  }
  return validateAppleNotFoundResponse(
    response,
    `App Store Connect ${phase} relationship NOT_FOUND`,
  );
}

async function appleRequest(fetchImpl, token, value, {
  method = "GET",
  body,
  allowNotFound = false,
  requestLabel = "App Store Connect",
  relationshipNotFoundPhase = null,
  retrySleep = sleepMilliseconds,
} = {}) {
  const url = safeProviderUrl(value, APPLE_API_ORIGIN, "App Store Connect request");
  if (typeof retrySleep !== "function") {
    fail("App Store Connect retry sleep is invalid");
  }
  let response;
  let attempts = 0;
  while (attempts < APPLE_TRANSIENT_READ_ATTEMPTS) {
    attempts += 1;
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (
      method !== "GET" ||
      !APPLE_TRANSIENT_READ_STATUSES.has(response.status) ||
      attempts === APPLE_TRANSIENT_READ_ATTEMPTS
    ) {
      break;
    }
    await response.body?.cancel().catch(() => {});
    await retrySleep(APPLE_TRANSIENT_READ_DELAYS_MS[attempts - 1]);
  }
  if (response.status === 404 && relationshipNotFoundPhase !== null) {
    const pathPattern = APPLE_RELATIONSHIP_PATHS.get(relationshipNotFoundPhase);
    if (
      method !== "GET" ||
      body !== undefined ||
      pathPattern === undefined ||
      !pathPattern.test(url.pathname)
    ) {
      fail("App Store Connect relationship NOT_FOUND request scope is invalid");
    }
    return validateAppleRelationshipNotFound(response, relationshipNotFoundPhase);
  }
  if (allowNotFound && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppStoreConnectHttpError(requestLabel, response.status, attempts);
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    fail("App Store Connect returned malformed JSON");
  }
}

async function appleCollection(
  fetchImpl,
  token,
  initialUrl,
  label,
  {
    initialRelationshipNotFoundPhase = null,
    retrySleep = sleepMilliseconds,
  } = {},
) {
  const items = [];
  let next = initialUrl;
  const seen = new Set();
  let relationshipPath = null;
  if (initialRelationshipNotFoundPhase !== null) {
    const pathPattern = APPLE_RELATIONSHIP_PATHS.get(
      initialRelationshipNotFoundPhase,
    );
    relationshipPath = safeProviderUrl(
      initialUrl,
      APPLE_API_ORIGIN,
      "App Store Connect relationship collection",
    ).pathname;
    if (pathPattern === undefined || !pathPattern.test(relationshipPath)) {
      fail("App Store Connect relationship NOT_FOUND request scope is invalid");
    }
  }
  for (let page = 0; page < MAX_PAGES && next; page += 1) {
    const safeUrl = safeProviderUrl(next, APPLE_API_ORIGIN, label);
    if (
      relationshipPath !== null &&
      safeUrl.pathname !== relationshipPath
    ) {
      fail(
        `App Store Connect ${initialRelationshipNotFoundPhase} ` +
          "relationship pagination path changed",
      );
    }
    const url = safeUrl.toString();
    if (seen.has(url)) fail(`${label} pagination looped`);
    seen.add(url);
    const response = await appleRequest(fetchImpl, token, url, {
      requestLabel: label,
      relationshipNotFoundPhase: page === 0
        ? initialRelationshipNotFoundPhase
        : null,
      retrySleep,
    });
    if (response === APPLE_RELATIONSHIP_NOT_FOUND) return null;
    const payload = record(response, label);
    if (!Array.isArray(payload.data)) fail(`${label} has no data array`);
    const links = record(payload.links, `${label} links`);
    items.push(...payload.data);
    if (items.length > MAX_ITEMS) fail(`${label} exceeded its item bound`);
    next = links.next ?? null;
    if (next !== null && typeof next !== "string") fail(`${label} has an invalid next link`);
  }
  if (next) fail(`${label} exceeded its page bound`);
  return items;
}

function strictBase64Bytes(value, maximumBytes, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is not canonical base64`);
  }
  if (value.length > Math.ceil(maximumBytes / 3) * 4) {
    fail(`${label} is invalid or unbounded`);
  }
  const paddingIndex = value.indexOf("=");
  const paddingLength = paddingIndex === -1 ? 0 : value.length - paddingIndex;
  if (
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(value) ||
    paddingLength > 2 ||
    (paddingIndex !== -1 &&
      (paddingIndex < value.length - 2 ||
        value.slice(paddingIndex) !== "=".repeat(paddingLength)))
  ) {
    fail(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maximumBytes ||
    bytes.toString("base64") !== value
  ) {
    fail(`${label} is invalid or unbounded`);
  }
  return bytes;
}

function futureProviderDate(value, nowMilliseconds, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed > nowMilliseconds;
}

function appleDistributionCertificatesUrl() {
  const url = new URL("/v1/certificates", APPLE_API_ORIGIN);
  url.searchParams.set(
    "filter[certificateType]",
    "DISTRIBUTION,IOS_DISTRIBUTION",
  );
  url.searchParams.set(
    "fields[certificates]",
    "certificateType,certificateContent,expirationDate,activated",
  );
  url.searchParams.set("limit", "200");
  return url;
}

async function readAppleDistributionCertificate({
  fetchImpl,
  token,
  certificateSha256,
  nowMilliseconds,
}) {
  const response = await appleRequest(
    fetchImpl,
    token,
    appleDistributionCertificatesUrl(),
    { requestLabel: "App Store Connect distribution certificates" },
  );
  const payload = record(response, "App Store Connect distribution certificates");
  if (!Array.isArray(payload.data)) {
    fail("App Store Connect distribution certificates has no data array");
  }
  if (payload.data.length > 200) {
    fail("App Store Connect distribution certificates exceeded its item bound");
  }
  const links = record(
    payload.links,
    "App Store Connect distribution certificates links",
  );
  if (links.next !== undefined && links.next !== null) {
    fail("App Store Connect distribution certificates pagination is not bounded");
  }
  const values = payload.data;
  const matches = [];
  const seenCertificateIds = new Set();
  for (const value of values) {
    const certificate = record(
      value,
      "App Store Connect distribution certificate",
    );
    if (certificate.type !== "certificates") {
      fail("App Store Connect distribution certificate type is invalid");
    }
    const certificateId = exactString(
      certificate.id,
      OPAQUE_ID,
      "App Store Connect distribution certificate ID",
    );
    if (seenCertificateIds.has(certificateId)) {
      fail("App Store Connect returned a duplicate distribution certificate ID");
    }
    seenCertificateIds.add(certificateId);
    const attributes = record(
      certificate.attributes,
      "App Store Connect distribution certificate attributes",
    );
    if (
      !["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(
        attributes.certificateType,
      )
    ) {
      fail("App Store Connect distribution certificate type attribute is invalid");
    }
    const hasActivationState = Object.hasOwn(attributes, "activated");
    if (hasActivationState && typeof attributes.activated !== "boolean") {
      fail("App Store Connect distribution certificate activation state is invalid");
    }
    const certificateIsNotExplicitlyInactive =
      !hasActivationState || attributes.activated === true;
    const certificateBytes = strictBase64Bytes(
      attributes.certificateContent,
      MAX_APPLE_CERTIFICATE_BYTES,
      "App Store Connect distribution certificate content",
    );
    const certificateUnexpired = futureProviderDate(
      attributes.expirationDate,
      nowMilliseconds,
      "App Store Connect distribution certificate expiration",
    );
    // SHA-256 of the DER certificate: the same fingerprint the keychain step
    // exports and the signed profile's DeveloperCertificates are matched on.
    const providerCertificateSha256 = crypto
      .createHash("sha256")
      .update(certificateBytes)
      .digest("hex");
    if (
      certificateIsNotExplicitlyInactive &&
      certificateUnexpired &&
      providerCertificateSha256 === certificateSha256
    ) {
      matches.push(certificateId);
    }
  }
  if (matches.length !== 1) {
    fail(
      "App Store Connect did not expose exactly one active distribution " +
        "certificate for the imported SHA-256 fingerprint",
    );
  }
  return matches[0];
}

function validateAppleBundleProfileLinkage(profile, bundleResourceId) {
  if (!Object.hasOwn(profile, "relationships")) return;
  const relationships = record(
    profile.relationships,
    "App Store Connect bundle profile relationships",
  );
  if (!Object.hasOwn(relationships, "bundleId")) return;
  const relationship = record(
    relationships.bundleId,
    "App Store Connect bundle profile bundle relationship",
  );
  if (!Object.hasOwn(relationship, "data")) return;
  const linkage = record(
    relationship.data,
    "App Store Connect bundle profile bundle linkage",
  );
  if (
    Object.keys(linkage).some((key) => key !== "id" && key !== "type") ||
    linkage.type !== "bundleIds" ||
    exactString(
      linkage.id,
      OPAQUE_ID,
      "App Store Connect bundle profile bundle linkage ID",
    ) !== bundleResourceId
  ) {
    fail("App Store Connect bundle profile bundle linkage is not exact");
  }
}

export async function downloadAppleAppStoreProfile({
  bundleId,
  certificateSha256,
  profileId = "",
  token,
  fetchImpl = fetch,
  now = new Date(),
  relationshipDiagnostic = null,
}) {
  exactString(bundleId, BUNDLE_ID, "iOS bundle ID");
  if (profileId !== "") {
    exactString(profileId, OPAQUE_ID, "requested App Store Connect profile ID");
  }
  if (typeof certificateSha256 !== "string") {
    fail("Apple Distribution certificate SHA-256 is invalid");
  }
  certificateSha256 = exactString(
    certificateSha256.toLowerCase(),
    SHA256,
    "Apple Distribution certificate SHA-256",
  );
  if (typeof token !== "string" || token.length < 20) {
    fail("App Store Connect JWT is missing");
  }
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) fail("profile selection clock is invalid");
  if (
    relationshipDiagnostic !== null &&
    typeof relationshipDiagnostic !== "function"
  ) {
    fail("App Store Connect relationship diagnostic is invalid");
  }
  const relationshipNotFoundCounts = {
    bundleProfile: 0,
  };

  const bundleIdsUrl = new URL("/v1/bundleIds", APPLE_API_ORIGIN);
  bundleIdsUrl.searchParams.set("filter[identifier]", bundleId);
  bundleIdsUrl.searchParams.set("fields[bundleIds]", "identifier,platform");
  bundleIdsUrl.searchParams.set("limit", "200");
  const bundleIds = await appleCollection(
    fetchImpl,
    token,
    bundleIdsUrl,
    "App Store Connect bundle IDs",
  );
  if (bundleIds.length === 0) {
    fail("App Store Connect did not resolve the requested bundle identifier");
  }
  const eligibleBundleResources = [];
  const seenBundleResourceIds = new Set();
  let exactIdentifierFound = false;
  for (const value of bundleIds) {
    const bundle = record(value, "App Store Connect bundle ID");
    if (bundle.type !== "bundleIds") {
      fail("App Store Connect bundle ID type is invalid");
    }
    const attributes = record(
      bundle.attributes,
      "App Store Connect bundle ID attributes",
    );
    const providerIdentifier = exactString(
      attributes.identifier,
      APPLE_PROVIDER_BUNDLE_ID,
      "App Store Connect bundle ID identifier",
    );
    const bundleResourceId = exactString(
      bundle.id,
      OPAQUE_ID,
      "App Store Connect bundle resource ID",
    );
    if (seenBundleResourceIds.has(bundleResourceId)) {
      fail("App Store Connect returned a duplicate bundle resource ID");
    }
    seenBundleResourceIds.add(bundleResourceId);
    if (!APPLE_BUNDLE_PLATFORMS.has(attributes.platform)) {
      fail("App Store Connect bundle ID platform is invalid");
    }
    if (providerIdentifier !== bundleId) {
      continue;
    }
    exactIdentifierFound = true;
    if (attributes.platform === "MAC_OS") {
      continue;
    }
    eligibleBundleResources.push({
      id: bundleResourceId,
      platform: attributes.platform,
    });
  }
  if (!exactIdentifierFound) {
    fail("App Store Connect bundle ID did not match the exact requested identifier");
  }
  if (eligibleBundleResources.length === 0) {
    fail("App Store Connect bundle ID platform is not valid for an iOS app");
  }

  const matches = [];
  const seenProfileIds = new Set();
  for (const { id: bundleResourceId } of eligibleBundleResources) {
    const profilesUrl = new URL(
      `/v1/bundleIds/${encodeURIComponent(bundleResourceId)}/profiles`,
      APPLE_API_ORIGIN,
    );
    profilesUrl.searchParams.set(
      "fields[profiles]",
      "name,platform,profileType,profileState,profileContent,uuid," +
        "expirationDate",
    );
    profilesUrl.searchParams.set("limit", "200");
    const profiles = await appleCollection(
      fetchImpl,
      token,
      profilesUrl,
      "App Store Connect bundle profiles",
      { initialRelationshipNotFoundPhase: "bundle-profile" },
    );
    if (profiles === null) {
      relationshipNotFoundCounts.bundleProfile += 1;
      continue;
    }
    for (const value of profiles) {
      const profile = record(value, "App Store Connect profile");
      if (profile.type !== "profiles") {
        fail("App Store Connect profile type is invalid");
      }
      const profileId = exactString(
        profile.id,
        OPAQUE_ID,
        "App Store Connect profile ID",
      );
      if (seenProfileIds.has(profileId)) {
        fail("App Store Connect returned a duplicate profile resource ID");
      }
      seenProfileIds.add(profileId);
      validateAppleBundleProfileLinkage(profile, bundleResourceId);
      const attributes = record(
        profile.attributes,
        "App Store Connect profile attributes",
      );
      if (!APPLE_BUNDLE_PLATFORMS.has(attributes.platform)) {
        fail("App Store Connect profile platform is invalid");
      }
      if (!APPLE_PROFILE_TYPES.has(attributes.profileType)) {
        fail("App Store Connect profile type attribute is invalid");
      }
      if (!APPLE_PROFILE_STATES.has(attributes.profileState)) {
        fail("App Store Connect profile state is invalid");
      }
      const profileUnexpired = futureProviderDate(
        attributes.expirationDate,
        nowMilliseconds,
        "App Store Connect profile expiration",
      );
      if (
        attributes.profileType === "IOS_APP_STORE" &&
        attributes.platform !== "IOS"
      ) {
        fail("App Store Connect iOS App Store profile platform is invalid");
      }
      if (
        attributes.platform !== "IOS" ||
        attributes.profileType !== "IOS_APP_STORE" ||
        attributes.profileState !== "ACTIVE" ||
        !profileUnexpired
      ) {
        continue;
      }
      const name = exactString(
        attributes.name,
        /^[^\u0000-\u001f\u007f]{1,200}$/u,
        "App Store Connect profile name",
      );
      const uuid = exactString(
        attributes.uuid,
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u,
        "App Store Connect profile UUID",
      ).toUpperCase();
      const profileContent = attributes.profileContent;
      strictBase64Bytes(
        profileContent,
        MAX_APPLE_PROFILE_BYTES,
        "App Store Connect profile content",
      );
      matches.push({
        schemaVersion: 1,
        provider: "app-store-connect",
        bundleId,
        profileId,
        name,
        uuid,
        profileType: "IOS_APP_STORE",
        expirationDate: attributes.expirationDate,
        profileContent,
      });
    }
  }
  if (
    relationshipDiagnostic !== null &&
    relationshipNotFoundCounts.bundleProfile > 0
  ) {
    relationshipDiagnostic(
      "[ios-asc] apple-profile-resolution " +
      `bundle-profile-not-found=${relationshipNotFoundCounts.bundleProfile}`,
    );
  }
  // An optional protected selector only narrows the fully validated,
  // exact-bundle candidates. It never enables an account-wide profile lookup
  // or a fallback when the requested profile is missing or ineligible.
  const selectedProfiles = profileId === ""
    ? matches
    : matches.filter((profile) => profile.profileId === profileId);
  if (selectedProfiles.length !== 1) {
    fail(
      "App Store Connect did not expose exactly one active iOS App Store profile " +
        (profileId === "" ? "" : "matching the requested resource ID ") +
        "through the exact bundle-scoped collection",
    );
  }
  const certificateId = await readAppleDistributionCertificate({
    fetchImpl,
    token,
    certificateSha256,
    nowMilliseconds,
  });
  // This API lookup proves the imported certificate is active account state.
  // The caller's mandatory CMS verification binds that exact certificate to
  // this profile before the profile is installed or any archive is created.
  return {
    ...selectedProfiles[0],
    certificateId,
    certificateSha256,
  };
}

function appleState(observation) {
  return {
    schemaVersion: observation.schemaVersion,
    provider: observation.provider,
    bundleId: observation.bundleId,
    appId: observation.appId,
    nativeVersion: observation.nativeVersion,
    preReleaseVersionId: observation.preReleaseVersionId,
    buildUploads: observation.buildUploads,
    betaGroupSelection: observation.betaGroupSelection,
    betaGroup: observation.betaGroup,
    builds: observation.builds,
  };
}

export async function observeAppleStore({
  bundleId,
  nativeVersion,
  requestedAppId = "",
  requestedBetaGroupId = "",
  token,
  fetchImpl = fetch,
  now = new Date(),
  checksumDiagnostic = null,
  retrySleep = sleepMilliseconds,
}) {
  exactString(bundleId, BUNDLE_ID, "iOS bundle ID");
  exactString(nativeVersion, NATIVE_VERSION, "iOS native version");
  if (requestedAppId !== "") {
    exactString(requestedAppId, OPAQUE_ID, "App Store Connect app ID");
  }
  if (requestedBetaGroupId !== "") {
    exactString(requestedBetaGroupId, OPAQUE_ID, "TestFlight beta group ID");
  }
  if (typeof token !== "string" || token.length < 20) fail("App Store Connect JWT is missing");
  if (checksumDiagnostic !== null && typeof checksumDiagnostic !== "function") {
    fail("App Store Connect checksum diagnostic is invalid");
  }
  if (typeof retrySleep !== "function") {
    fail("App Store Connect retry sleep is invalid");
  }

  const appsUrl = new URL("/v1/apps", APPLE_API_ORIGIN);
  appsUrl.searchParams.set("filter[bundleId]", bundleId);
  appsUrl.searchParams.set("fields[apps]", "bundleId");
  appsUrl.searchParams.set("limit", "2");
  const apps = await appleCollection(
    fetchImpl,
    token,
    appsUrl,
    "App Store Connect apps",
    { retrySleep },
  );
  if (apps.length !== 1) fail("App Store Connect did not resolve exactly one app");
  const app = record(apps[0], "App Store Connect app");
  const appId = exactString(app.id, OPAQUE_ID, "App Store Connect app ID");
  if (app.type !== "apps" || app.attributes?.bundleId !== bundleId) {
    fail("App Store Connect app does not match the requested bundle ID");
  }
  if (requestedAppId !== "" && appId !== requestedAppId) {
    fail("App Store Connect app does not match the configured app ID");
  }

  const uploadsUrl = new URL(
    `/v1/apps/${encodeURIComponent(appId)}/buildUploads`,
    APPLE_API_ORIGIN,
  );
  uploadsUrl.searchParams.set("filter[cfBundleShortVersionString]", nativeVersion);
  uploadsUrl.searchParams.set("filter[platform]", "IOS");
  uploadsUrl.searchParams.set(
    "fields[buildUploads]",
    "cfBundleShortVersionString,cfBundleVersion,state,platform,uploadedDate,buildUploadFiles",
  );
  uploadsUrl.searchParams.set("limit", "200");
  const uploadResources = await appleCollection(
    fetchImpl,
    token,
    uploadsUrl,
    "App Store Connect build uploads",
    { retrySleep },
  );
  const buildUploads = [];
  const uploadIds = new Set();
  const checksumProofCounts = {
    files: 0,
    compositePresent: 0,
    compositeKnown: 0,
    compositeOpaque: 0,
    filePresent: 0,
    fileMd5Known: 0,
    fileMd5Opaque: 0,
    fileSha256Known: 0,
    fileSha256Opaque: 0,
  };
  for (const value of uploadResources) {
    record(value, "App Store Connect build upload");
    const attributes = record(
      value.attributes,
      "App Store Connect build upload attributes",
    );
    if (
      value.type !== "buildUploads" ||
      attributes.cfBundleShortVersionString !== nativeVersion ||
      attributes.platform !== "IOS"
    ) {
      fail("App Store Connect build upload does not match the requested iOS version");
    }
    const uploadId = exactString(
      value.id,
      OPAQUE_ID,
      "App Store Connect build upload ID",
    );
    if (uploadIds.has(uploadId)) {
      fail("App Store Connect returned duplicate build-upload IDs");
    }
    uploadIds.add(uploadId);
    const buildNumber = providerVersionString(
      attributes.cfBundleVersion,
      "App Store Connect build-upload number",
    );
    const uploadState = record(
      attributes.state,
      "App Store Connect build upload state",
    ).state;
    if (!["AWAITING_UPLOAD", "PROCESSING", "FAILED", "COMPLETE"].includes(uploadState)) {
      fail("App Store Connect build upload state is invalid");
    }
    // Apple permits a failed build upload's number to be reused. A terminal
    // failed attempt therefore neither reserves the committed version nor
    // competes with a later live/complete attempt using the same number.
    if (uploadState === "FAILED") continue;
    const filesUrl = new URL(
      `/v1/buildUploads/${encodeURIComponent(uploadId)}/buildUploadFiles`,
      APPLE_API_ORIGIN,
    );
    filesUrl.searchParams.set(
      "fields[buildUploadFiles]",
      "assetDeliveryState,fileName,fileSize,sourceFileChecksums,uti",
    );
    filesUrl.searchParams.set("limit", "200");
    const files = (await appleCollection(
      fetchImpl,
      token,
      filesUrl,
      "App Store Connect build-upload files",
      { retrySleep },
    )).map((file) => {
      record(file, "App Store Connect build-upload file");
      if (file.type !== "buildUploadFiles") {
        fail("App Store Connect build-upload file type is invalid");
      }
      const fileAttributes = record(
        file.attributes,
        "App Store Connect build-upload file attributes",
      );
      const sizeBytes = positiveInteger(
        fileAttributes.fileSize,
        "App Store Connect build-upload file size",
      );
      const deliveryState = fileAttributes.assetDeliveryState?.state ?? null;
      if (
        deliveryState !== null &&
        !["AWAITING_UPLOAD", "UPLOAD_COMPLETE", "COMPLETE", "FAILED"].includes(deliveryState)
      ) {
        fail("App Store Connect build-upload file state is invalid");
      }
      const composite = fileAttributes.sourceFileChecksums?.composite ?? null;
      let compositeMd5 = null;
      if (composite !== null) {
        checksumProofCounts.compositePresent += 1;
        if (composite.algorithm !== "MD5") {
          fail("App Store Connect build-upload checksum algorithm is invalid");
        }
        compositeMd5 = canonicalMd5OrNull(
          composite.hash,
          "App Store Connect build-upload MD5",
        );
        checksumProofCounts[compositeMd5 === null ? "compositeOpaque" : "compositeKnown"] += 1;
      }
      const fileChecksum = fileAttributes.sourceFileChecksums?.file ?? null;
      let fileMd5 = null;
      let fileSha256 = null;
      if (fileChecksum !== null) {
        // Apple documents this member as either MD5 or SHA_256, but does not
        // constrain the hash string encoding. Only exact digest-byte
        // encodings become proof; provider-opaque strings remain null.
        checksumProofCounts.filePresent += 1;
        if (fileChecksum.algorithm === "MD5") {
          fileMd5 = canonicalMd5OrNull(
            fileChecksum.hash,
            "App Store Connect build-upload file MD5",
          );
          checksumProofCounts[fileMd5 === null ? "fileMd5Opaque" : "fileMd5Known"] += 1;
        } else if (fileChecksum.algorithm === "SHA_256") {
          fileSha256 = canonicalSha256OrNull(
            fileChecksum.hash,
            "App Store Connect build-upload file SHA-256",
          );
          checksumProofCounts[
            fileSha256 === null ? "fileSha256Opaque" : "fileSha256Known"
          ] += 1;
        } else {
          fail("App Store Connect build-upload file checksum algorithm is invalid");
        }
      }
      checksumProofCounts.files += 1;
      return {
        id: exactString(file.id, OPAQUE_ID, "App Store Connect build-upload file ID"),
        fileName: typeof fileAttributes.fileName === "string"
          ? fileAttributes.fileName.slice(0, 500)
          : "",
        sizeBytes,
        uti: typeof fileAttributes.uti === "string" ? fileAttributes.uti : "",
        deliveryState,
        compositeMd5,
        fileMd5,
        fileSha256,
      };
    });
    buildUploads.push({
      id: uploadId,
      buildNumber,
      state: uploadState,
      files,
    });
  }
  buildUploads.sort((left, right) =>
    compareProviderVersions(left.buildNumber, right.buildNumber));
  if (checksumDiagnostic !== null) {
    checksumDiagnostic(appleChecksumProofSummary(checksumProofCounts));
  }

  const versionsUrl = new URL(`/v1/apps/${encodeURIComponent(appId)}/preReleaseVersions`, APPLE_API_ORIGIN);
  versionsUrl.searchParams.set("fields[preReleaseVersions]", "version,platform");
  versionsUrl.searchParams.set("limit", "200");
  const versions = (await appleCollection(
    fetchImpl,
    token,
    versionsUrl,
    "App Store Connect prerelease versions",
    { retrySleep },
  )).filter((value) =>
    value?.type === "preReleaseVersions" &&
    value?.attributes?.version === nativeVersion &&
    value?.attributes?.platform === "IOS");
  if (versions.length > 1) fail("App Store Connect returned duplicate iOS prerelease versions");
  const preReleaseVersionId = versions.length === 0
    ? null
    : exactString(versions[0].id, OPAQUE_ID, "App Store Connect prerelease version ID");

  let buildResources = [];
  if (preReleaseVersionId !== null) {
    const buildsUrl = new URL(
      `/v1/preReleaseVersions/${encodeURIComponent(preReleaseVersionId)}/builds`,
      APPLE_API_ORIGIN,
    );
    buildsUrl.searchParams.set(
      "fields[builds]",
      "version,processingState,buildAudienceType,expired,uploadedDate,usesNonExemptEncryption",
    );
    buildsUrl.searchParams.set("limit", "200");
    buildResources = await appleCollection(
      fetchImpl,
      token,
      buildsUrl,
      "App Store Connect builds",
      { retrySleep },
    );
  }

  const groupsUrl = new URL(`/v1/apps/${encodeURIComponent(appId)}/betaGroups`, APPLE_API_ORIGIN);
  groupsUrl.searchParams.set(
    "fields[betaGroups]",
    "name,isInternalGroup,hasAccessToAllBuilds",
  );
  groupsUrl.searchParams.set("limit", "200");
  const internalGroups = (await appleCollection(
    fetchImpl,
    token,
    groupsUrl,
    "App Store Connect beta groups",
    { retrySleep },
  )).filter((value) => value?.type === "betaGroups" && value?.attributes?.isInternalGroup === true);

  let selectedGroup = null;
  let betaGroupSelection = "attention";
  if (requestedBetaGroupId !== "") {
    selectedGroup = internalGroups.find((value) => value.id === requestedBetaGroupId) ?? null;
    if (selectedGroup === null) fail("The configured TestFlight beta group is not an internal group for this app");
    betaGroupSelection = "configured";
  } else {
    const allBuildGroups = internalGroups.filter(
      (value) => value?.attributes?.hasAccessToAllBuilds === true,
    );
    if (allBuildGroups.length === 1) {
      selectedGroup = allBuildGroups[0];
      betaGroupSelection = "unique-all-builds";
    } else if (internalGroups.length === 1) {
      selectedGroup = internalGroups[0];
      betaGroupSelection = "unique-internal";
    }
  }

  const distributedBuildIds = new Set();
  let betaGroup = null;
  if (selectedGroup !== null) {
    const groupId = exactString(selectedGroup.id, OPAQUE_ID, "TestFlight beta group ID");
    const groupBuildsUrl = new URL(
      `/v1/betaGroups/${encodeURIComponent(groupId)}/builds`,
      APPLE_API_ORIGIN,
    );
    groupBuildsUrl.searchParams.set("fields[builds]", "version,processingState");
    groupBuildsUrl.searchParams.set("limit", "200");
    for (const value of await appleCollection(
      fetchImpl,
      token,
      groupBuildsUrl,
      "TestFlight beta-group builds",
      { retrySleep },
    )) {
      record(value, "TestFlight group build");
      if (value.type !== "builds") fail("TestFlight group build type is invalid");
      distributedBuildIds.add(exactString(value.id, OPAQUE_ID, "TestFlight group build ID"));
    }
    betaGroup = {
      id: groupId,
      hasAccessToAllBuilds: selectedGroup.attributes?.hasAccessToAllBuilds === true,
    };
  }

  const builds = [];
  for (const value of buildResources) {
    record(value, "App Store Connect build");
    if (value.type !== "builds") fail("App Store Connect build type is invalid");
    const attributes = record(value.attributes, "App Store Connect build attributes");
    const buildNumber = providerVersionString(
      attributes.version,
      "App Store Connect build number",
    );
    const processingState = attributes.processingState;
    if (!["PROCESSING", "FAILED", "INVALID", "VALID"].includes(processingState)) {
      fail("App Store Connect build processing state is invalid");
    }
    const buildId = exactString(value.id, OPAQUE_ID, "App Store Connect build ID");
    const buildAudienceType = attributes.buildAudienceType ?? null;
    if (
      buildAudienceType !== null &&
      !["INTERNAL_ONLY", "APP_STORE_ELIGIBLE"].includes(buildAudienceType)
    ) {
      fail("App Store Connect build audience is invalid");
    }
    let internalBuildState = null;
    if (processingState === "VALID") {
      const betaDetail = await appleRequest(
        fetchImpl,
        token,
        `/v1/builds/${encodeURIComponent(buildId)}/buildBetaDetail?fields%5BbuildBetaDetails%5D=internalBuildState`,
        {
          allowNotFound: true,
          requestLabel: "App Store Connect build beta detail",
          retrySleep,
        },
      );
      if (betaDetail !== null) {
        const detail = record(betaDetail.data, "App Store Connect build beta detail");
        if (detail.type !== "buildBetaDetails") {
          fail("App Store Connect build beta detail type is invalid");
        }
        internalBuildState = detail.attributes?.internalBuildState ?? null;
        if (![
          "PROCESSING",
          "PROCESSING_EXCEPTION",
          "MISSING_EXPORT_COMPLIANCE",
          "READY_FOR_BETA_TESTING",
          "IN_BETA_TESTING",
          "EXPIRED",
          "IN_EXPORT_COMPLIANCE_REVIEW",
        ].includes(internalBuildState)) {
          fail("App Store Connect internal beta state is invalid");
        }
      }
    }
    builds.push({
      id: buildId,
      buildNumber,
      processingState,
      buildAudienceType,
      internalBuildState,
      expired: attributes.expired === true,
      distributed: distributedBuildIds.has(value.id),
    });
  }
  builds.sort((left, right) => compareProviderVersions(left.buildNumber, right.buildNumber));
  if (new Set(builds.map((value) => value.buildNumber)).size !== builds.length) {
    fail("App Store Connect returned duplicate build numbers");
  }

  const observedAt = now.toISOString();
  if (observedAt !== new Date(observedAt).toISOString()) fail("Apple observation clock is invalid");
  const observation = {
    schemaVersion: 1,
    provider: "app-store-connect",
    bundleId,
    appId,
    nativeVersion,
    preReleaseVersionId,
    buildUploads,
    betaGroupSelection,
    betaGroup,
    builds,
    observedAt,
  };
  return { ...observation, stateSha256: canonicalSha256(appleState(observation)) };
}

export function selectAppleBuildNumber(observation, committedBuildNumber) {
  record(observation, "App Store Connect observation");
  providerVersionString(committedBuildNumber, "committed iOS build number");
  const items = [
    ...boundedArray(observation.builds, "App Store Connect builds"),
    ...boundedArray(observation.buildUploads, "App Store Connect build uploads"),
  ];
  const maximum = items.reduce(
    (value, item) => Math.max(
      value,
      Number(providerVersionString(
        record(item, "App Store Connect build version").buildNumber,
        "App Store Connect build number",
      )),
    ),
    0,
  );
  const committed = Number(committedBuildNumber);
  if (committed <= maximum) {
    return { action: "attention", maximumBuildNumber: String(maximum), buildNumber: committedBuildNumber };
  }
  if (observation.betaGroup === null) {
    return { action: "attention", maximumBuildNumber: String(maximum), buildNumber: committedBuildNumber };
  }
  return { action: "publish", maximumBuildNumber: String(maximum), buildNumber: committedBuildNumber };
}


const FATAL_INTERNAL_BETA_STATES = new Set([
  "PROCESSING_EXCEPTION",
  "MISSING_EXPORT_COMPLIANCE",
  "EXPIRED",
  "IN_EXPORT_COMPLIANCE_REVIEW",
]);

function validateReconcileTiming(timeoutSeconds, intervalSeconds) {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 7_200) {
    fail("Apple processing timeout is invalid");
  }
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 120) {
    fail("Apple polling interval is invalid");
  }
}

// Shared polling predicate. `expected` is the locally built IPA's digests, or
// null when reconciling an upload that an earlier run already delivered (the
// digests are then taken from App Store Connect's own buildUploadFiles proof).
async function reconcileLoop({
  bundleId,
  nativeVersion,
  buildNumber,
  expected,
  requestedAppId,
  requestedBetaGroupId,
  token,
  tokenFactory,
  fetchImpl,
  now,
  sleep,
  timeoutSeconds,
  intervalSeconds,
}) {
  providerVersionString(buildNumber, "iOS build number");
  exactString(requestedAppId, OPAQUE_ID, "App Store Connect app ID");
  exactString(requestedBetaGroupId, OPAQUE_ID, "TestFlight beta group ID");
  validateReconcileTiming(timeoutSeconds, intervalSeconds);
  const nextToken = appleReconcileTokenSource({ token, tokenFactory });
  const deadline = now().getTime() + timeoutSeconds * 1000;
  let assigned = false;
  while (now().getTime() < deadline) {
    let artifactProof = null;
    const observationToken = await nextToken();
    const observation = await observeAppleStore({
      bundleId,
      nativeVersion,
      requestedAppId,
      requestedBetaGroupId,
      token: observationToken,
      fetchImpl,
      now: now(),
      retrySleep: sleep,
    });
    if (observation.betaGroup === null) fail("No deterministic internal TestFlight beta group is configured");
    const uploadMatches = observation.buildUploads.filter(
      (value) => value.buildNumber === buildNumber,
    );
    if (uploadMatches.length > 1) fail("App Store Connect returned duplicate exact build uploads");
    if (uploadMatches.length === 1) {
      const upload = uploadMatches[0];
      if (upload.state === "FAILED") fail("TestFlight build upload processing reached FAILED");
      if (upload.state === "COMPLETE") {
        const ipaFiles = upload.files.filter((value) => value.uti === "com.apple.ipa");
        if (ipaFiles.length !== 1) fail("TestFlight build upload has no unique IPA file proof");
        const ipaFile = ipaFiles[0];
        const knownDigests = [
          ipaFile.compositeMd5,
          ipaFile.fileMd5,
          ipaFile.fileSha256,
        ].filter((value) => value !== null);
        if (ipaFile.deliveryState !== "COMPLETE" || knownDigests.length === 0) {
          fail("TestFlight build-upload file has no complete digest proof");
        }
        if (
          ipaFile.compositeMd5 !== null &&
          ipaFile.fileMd5 !== null &&
          ipaFile.compositeMd5 !== ipaFile.fileMd5
        ) {
          fail("TestFlight build-upload MD5 proofs disagree");
        }
        if (
          expected !== null &&
          (
            ipaFile.sizeBytes !== expected.sizeBytes ||
            (ipaFile.compositeMd5 !== null && ipaFile.compositeMd5 !== expected.md5) ||
            (ipaFile.fileMd5 !== null && ipaFile.fileMd5 !== expected.md5) ||
            (ipaFile.fileSha256 !== null && ipaFile.fileSha256 !== expected.sha256)
          )
        ) {
          fail("TestFlight build-upload file differs from the reserved IPA");
        }
        artifactProof = {
          buildUploadId: upload.id,
          fileName: ipaFile.fileName,
          sizeBytes: ipaFile.sizeBytes,
          md5: ipaFile.compositeMd5 ?? ipaFile.fileMd5,
          sha256: ipaFile.fileSha256,
        };
      }
    }
    const matches = observation.builds.filter((value) => value.buildNumber === buildNumber);
    if (matches.length > 1) fail("App Store Connect returned duplicate exact builds");
    if (matches.length === 1) {
      const build = matches[0];
      if (build.expired) fail("TestFlight build is expired");
      if (build.processingState === "FAILED" || build.processingState === "INVALID") {
        fail(`TestFlight build processing reached ${build.processingState}`);
      }
      if (build.processingState === "VALID") {
        if (build.buildAudienceType !== "INTERNAL_ONLY") {
          fail("TestFlight build is not restricted to the internal audience");
        }
        if (FATAL_INTERNAL_BETA_STATES.has(build.internalBuildState)) {
          fail(`TestFlight internal beta state reached ${build.internalBuildState}`);
        }
        if (
          build.distributed &&
          build.internalBuildState === "IN_BETA_TESTING" &&
          artifactProof !== null
        ) {
          return { observation, build, artifactProof };
        }
        if (artifactProof !== null && !assigned && !observation.betaGroup.hasAccessToAllBuilds) {
          const mutationToken = await nextToken();
          await appleRequest(
            fetchImpl,
            mutationToken,
            `/v1/builds/${encodeURIComponent(build.id)}/relationships/betaGroups`,
            {
              method: "POST",
              body: { data: [{ type: "betaGroups", id: observation.betaGroup.id }] },
            },
          );
          assigned = true;
        }
      }
    }
    await sleep(intervalSeconds * 1000);
  }
  fail("TestFlight build processing or internal-group distribution timed out");
}

export async function reconcileAppleBuild({
  bundleId,
  nativeVersion,
  buildNumber,
  artifactSizeBytes,
  artifactMd5,
  artifactSha256,
  requestedAppId,
  requestedBetaGroupId = "",
  token,
  tokenFactory = null,
  fetchImpl = fetch,
  now = () => new Date(),
  sleep = sleepMilliseconds,
  timeoutSeconds = 5_400,
  intervalSeconds = 30,
}) {
  positiveInteger(artifactSizeBytes, "iOS artifact size");
  exactString(artifactMd5, MD5, "iOS artifact MD5");
  exactString(artifactSha256, SHA256, "iOS artifact SHA-256");
  const result = await reconcileLoop({
    bundleId,
    nativeVersion,
    buildNumber,
    expected: { sizeBytes: artifactSizeBytes, md5: artifactMd5, sha256: artifactSha256 },
    requestedAppId,
    requestedBetaGroupId,
    token,
    tokenFactory,
    fetchImpl,
    now,
    sleep,
    timeoutSeconds,
    intervalSeconds,
  });
  return result.observation;
}

// For a run that died after altool accepted the IPA: never uploads, proves the
// same predicate and reports the digests App Store Connect holds.
export async function reconcileExistingAppleBuild({
  bundleId,
  nativeVersion,
  buildNumber,
  requestedAppId,
  requestedBetaGroupId = "",
  token,
  tokenFactory = null,
  fetchImpl = fetch,
  now = () => new Date(),
  sleep = sleepMilliseconds,
  timeoutSeconds = 5_400,
  intervalSeconds = 30,
}) {
  const { observation, artifactProof } = await reconcileLoop({
    bundleId,
    nativeVersion,
    buildNumber,
    expected: null,
    requestedAppId,
    requestedBetaGroupId,
    token,
    tokenFactory,
    fetchImpl,
    now,
    sleep,
    timeoutSeconds,
    intervalSeconds,
  });
  return {
    ...observation,
    uploadedIpa: {
      sizeBytes: artifactProof.sizeBytes,
      md5: artifactProof.md5,
      sha256: artifactProof.sha256,
    },
  };
}

// Publication gate / candidate state derived from a rich observation for one
// committed build number (port of the workflow adapter's provider-observation).
export function deriveAppleCandidateState(observation, buildNumber) {
  record(observation, "App Store Connect observation");
  providerVersionString(buildNumber, "committed iOS build number");
  const uploads = boundedArray(observation.buildUploads, "App Store Connect build uploads");
  const builds = boundedArray(observation.builds, "App Store Connect builds");
  const state = appleState(observation);
  if (canonicalSha256(state) !== observation.stateSha256) {
    fail("App Store Connect observation digest does not match its state");
  }
  const code = Number(buildNumber);
  const highest = [...uploads, ...builds].reduce(
    (maximum, item) => Math.max(
      maximum,
      Number(providerVersionString(item.buildNumber, "App Store Connect build number")),
    ),
    0,
  );
  const exactUploads = uploads.filter((upload) => Number(upload.buildNumber) === code);
  const exactUpload = exactUploads.length === 1 ? exactUploads[0] : null;
  const exactBuilds = builds.filter((build) => Number(build.buildNumber) === code);
  const exactBuild = exactBuilds[0] ?? null;
  let buildState = "absent";
  let internalTesterState = "absent";
  let publicationGate = observation.betaGroup === null ? "attention" : "clear";
  if (exactUploads.length > 0 || exactBuild !== null) buildState = "processing";

  const ipaFiles = exactUpload?.files.filter((file) => file.uti === "com.apple.ipa") ?? [];
  const invalidUpload = exactUpload?.state === "FAILED" || (
    exactUpload?.state === "COMPLETE" &&
    (
      ipaFiles.length !== 1 ||
      ipaFiles[0].deliveryState !== "COMPLETE" ||
      (
        ipaFiles[0].compositeMd5 === null &&
        ipaFiles[0].fileMd5 === null &&
        ipaFiles[0].fileSha256 === null
      )
    )
  );
  const invalidBuild = exactBuild !== null && (
    ["FAILED", "INVALID"].includes(exactBuild.processingState) ||
    exactBuild.expired ||
    (exactBuild.processingState === "VALID" && exactBuild.buildAudienceType !== "INTERNAL_ONLY") ||
    FATAL_INTERNAL_BETA_STATES.has(exactBuild.internalBuildState)
  );
  if (exactUploads.length > 1 || exactBuilds.length > 1 || invalidUpload || invalidBuild) {
    buildState = "invalid";
    publicationGate = "attention";
  } else if (
    exactUpload?.state === "COMPLETE" &&
    exactBuild?.processingState === "VALID" &&
    exactBuild.buildAudienceType === "INTERNAL_ONLY"
  ) {
    buildState = "ready";
    if (exactBuild.distributed && exactBuild.internalBuildState === "IN_BETA_TESTING") {
      internalTesterState = "available";
    }
  }
  return {
    buildNumber: String(code),
    highestCommittedCode: highest === 0 ? null : highest,
    publicationGate,
    candidate: { buildState, internalTesterState },
  };
}

// One-shot gate: the exact build must not exist and every committed build
// number must be strictly lower. `strict=false` (dry runs) downgrades the
// absence checks to warnings but still requires a resolvable internal group.
export function assessAppleOneShot(observation, buildNumber, { strict = true } = {}) {
  const assessment = deriveAppleCandidateState(observation, buildNumber);
  const problems = [];
  if (assessment.publicationGate !== "clear") problems.push("publicationGate is not clear");
  if (assessment.candidate.buildState !== "absent") {
    problems.push(`build ${buildNumber} already exists (${assessment.candidate.buildState})`);
  }
  if (assessment.candidate.internalTesterState !== "absent") {
    problems.push(`build ${buildNumber} is already available to internal testers`);
  }
  if (
    assessment.highestCommittedCode !== null &&
    assessment.highestCommittedCode >= Number(buildNumber)
  ) {
    problems.push(
      `highest committed build ${assessment.highestCommittedCode} is not below ${buildNumber}`,
    );
  }
  const fatal = strict
    ? problems
    : problems.filter((problem) => problem === "publicationGate is not clear");
  return {
    ...assessment,
    ok: fatal.length === 0,
    errors: fatal,
    warnings: problems.filter((problem) => !fatal.includes(problem)),
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") fail(`${name} is required`);
  return value;
}

function appleCredentials() {
  return {
    keyId: requiredEnvironment("APP_STORE_CONNECT_KEY_ID"),
    issuerId: requiredEnvironment("APP_STORE_CONNECT_ISSUER_ID"),
    privateKey: requiredEnvironment("APP_STORE_CONNECT_PRIVATE_KEY").replace(/\\n/gu, "\n"),
  };
}

function pollSettings() {
  return {
    timeoutSeconds: Number(process.env.IOS_ASC_POLL_TIMEOUT_SECONDS ?? "6900"),
    intervalSeconds: Number(process.env.IOS_ASC_POLL_INTERVAL_SECONDS ?? "30"),
  };
}

// Resolve the app and deterministic internal group once (honouring the
// optional pins) so the poll is bound to exact resource ids.
async function resolveAppleTargets(bundleId, nativeVersion, credentials) {
  const observation = await observeAppleStore({
    bundleId,
    nativeVersion,
    requestedAppId: process.env.APP_STORE_CONNECT_APP_ID ?? "",
    requestedBetaGroupId: process.env.APP_STORE_CONNECT_INTERNAL_BETA_GROUP_ID ?? "",
    token: createAppStoreConnectJwt(credentials),
  });
  if (observation.betaGroup === null) {
    fail("No deterministic internal TestFlight beta group; set APP_STORE_CONNECT_INTERNAL_BETA_GROUP_ID");
  }
  return { appId: observation.appId, betaGroupId: observation.betaGroup.id };
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`${label} could not be read`);
  }
}

const USAGE =
  "usage: asc.mjs observe <bundleId> <marketing> | " +
  "gate <bundleId> <marketing> <build> <out.json> [--dry-run] | " +
  "assess <observation.json> <build> [--dry-run] | " +
  "download-profile <bundleId> <certSha256> [profileId] | " +
  "reconcile <bundleId> <marketing> <build> <ipaSize> <ipaMd5> <ipaSha256> | " +
  "reconcile-existing <bundleId> <marketing> <build>";

export async function cli(argv) {
  const command = argv[0] ?? "";
  if (["download-profile", "reconcile", "reconcile-existing"].includes(command)) {
    return cliStore(argv);
  }
  if (command === "observe" && argv.length === 3) {
    return observeAppleStore({
      bundleId: argv[1],
      nativeVersion: argv[2],
      requestedAppId: process.env.APP_STORE_CONNECT_APP_ID ?? "",
      requestedBetaGroupId: process.env.APP_STORE_CONNECT_INTERNAL_BETA_GROUP_ID ?? "",
      token: createAppStoreConnectJwt(appleCredentials()),
      checksumDiagnostic: (message) => process.stderr.write(`${message}\n`),
    });
  }
  if (command === "gate" && (argv.length === 5 || (argv.length === 6 && argv[5] === "--dry-run"))) {
    // observe + assess in one call; the observation is kept as evidence.
    const observation = await observeAppleStore({
      bundleId: argv[1],
      nativeVersion: argv[2],
      requestedAppId: process.env.APP_STORE_CONNECT_APP_ID ?? "",
      requestedBetaGroupId: process.env.APP_STORE_CONNECT_INTERNAL_BETA_GROUP_ID ?? "",
      token: createAppStoreConnectJwt(appleCredentials()),
    });
    fs.writeFileSync(argv[4], canonicalBytes(observation), { flag: "wx", mode: 0o600 });
    return reportAssessment(assessAppleOneShot(observation, argv[3], { strict: argv.length === 5 }));
  }
  if (command === "assess" && (argv.length === 3 || (argv.length === 4 && argv[3] === "--dry-run"))) {
    return reportAssessment(assessAppleOneShot(readJsonFile(argv[1], "observation"), argv[2], {
      strict: argv.length === 3,
    }));
  }
  fail(USAGE);
}

function reportAssessment(result) {
  for (const warning of result.warnings) {
    process.stderr.write(`::warning::App Store Connect: ${warning}\n`);
  }
  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`::error::App Store Connect: ${error}\n`);
    }
    fail("App Store Connect one-shot precondition failed");
  }
  return result;
}

async function cliStore(argv) {
  const command = argv[0] ?? "";
  if (command === "download-profile" && (argv.length === 3 || argv.length === 4)) {
    return downloadAppleAppStoreProfile({
      bundleId: argv[1],
      certificateSha256: argv[2],
      profileId: argv[3] ?? "",
      token: createAppStoreConnectJwt(appleCredentials()),
      relationshipDiagnostic: (message) => process.stderr.write(`${message}\n`),
    });
  }
  if (command === "reconcile" && argv.length === 7) {
    // Keep the key only in memory and mint per request; a 15-minute JWT must
    // not bound the up-to-115-minute processing poll.
    const credentials = appleCredentials();
    const targets = await resolveAppleTargets(argv[1], argv[2], credentials);
    return reconcileAppleBuild({
      bundleId: argv[1],
      nativeVersion: argv[2],
      buildNumber: argv[3],
      artifactSizeBytes: Number(argv[4]),
      artifactMd5: argv[5],
      artifactSha256: argv[6],
      requestedAppId: targets.appId,
      requestedBetaGroupId: targets.betaGroupId,
      tokenFactory: () => createAppStoreConnectJwt(credentials),
      ...pollSettings(),
    });
  }
  if (command === "reconcile-existing" && argv.length === 4) {
    const credentials = appleCredentials();
    const targets = await resolveAppleTargets(argv[1], argv[2], credentials);
    return reconcileExistingAppleBuild({
      bundleId: argv[1],
      nativeVersion: argv[2],
      buildNumber: argv[3],
      requestedAppId: targets.appId,
      requestedBetaGroupId: targets.betaGroupId,
      tokenFactory: () => createAppStoreConnectJwt(credentials),
      ...pollSettings(),
    });
  }
  fail(USAGE);
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  cli(process.argv.slice(2)).then(
    (value) => process.stdout.write(canonicalBytes(value)),
    (error) => {
      // Provider bodies, tokens and keys never reach the log: only our own
      // prefixed messages are printed.
      const message = error instanceof Error && error.message.startsWith("[ios-asc]")
        ? error.message
        : "[ios-asc] command failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
