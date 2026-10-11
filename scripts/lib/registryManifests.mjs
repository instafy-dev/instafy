// Anonymous registry manifest reads and logged-in raw inspection, shared by
// the GHCR mirrors of the Supabase CI images (scripts/mirror-supabase-images.mjs)
// and of the Docker Hub base images (scripts/mirror-docker-hub-images.mjs), and
// by the BuildKit image resolver (scripts/resolve-buildkit-image.mjs).
//
// Every read here is anonymous: no credential is sent or returned, and the
// short-lived anonymous pull token never leaves fetchManifest.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
// Anonymous token realms are fixed per registry; a challenge naming any other
// realm is refused rather than followed.
const REGISTRIES = Object.freeze({
  "ghcr.io": { api: "https://ghcr.io", realm: "https://ghcr.io/token" },
  "public.ecr.aws": { api: "https://public.ecr.aws", realm: "https://public.ecr.aws/token/" },
  "docker.io": { api: "https://registry-1.docker.io", realm: "https://auth.docker.io/token" },
});
export const SOURCE_READ_ATTEMPTS = 4;
export const SOURCE_READ_BACKOFF_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const sha256Digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function parseImageRef(reference) {
  const match =
    /^(ghcr\.io|public\.ecr\.aws|docker\.io)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?:@(sha256:[0-9a-f]{64})|:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))$/u
      .exec(typeof reference === "string" ? reference : "");
  if (!match) throw new Error(`unsupported image reference: ${reference}`);
  return { host: match[1], repository: match[2], reference: match[3] ?? match[4] };
}

function bearerChallenge(header) {
  if (typeof header !== "string" || !/^Bearer\s/iu.test(header)) return null;
  const parameters = {};
  for (const [, key, value] of header.matchAll(/([A-Za-z]+)="([^"]*)"/gu)) {
    parameters[key.toLowerCase()] = value;
  }
  return parameters;
}

export const retryableStatus = (status) => status === 0 || status === 429 || status >= 500;

/**
 * Anonymous manifest read. Never sends or returns credentials; the short-lived
 * anonymous pull token stays inside this function.
 */
export async function fetchManifest(reference, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { host, repository, reference: target } = parseImageRef(reference);
  const registry = REGISTRIES[host];
  const url = `${registry.api}/v2/${repository}/manifests/${target}`;
  const request = (headers) => fetchImpl(url, {
    headers: { Accept: MANIFEST_ACCEPT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    let response = await request({});
    if (response.status === 401) {
      const challenge = bearerChallenge(response.headers.get("www-authenticate"));
      if (!challenge || challenge.realm !== registry.realm) {
        return { ok: false, status: 401, stage: "challenge" };
      }
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
      if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
      const tokenResponse = await fetchImpl(tokenUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!tokenResponse.ok) return { ok: false, status: tokenResponse.status, stage: "token" };
      const body = await tokenResponse.json();
      const token = body?.token ?? body?.access_token;
      if (typeof token !== "string" || token.length === 0) {
        return { ok: false, status: tokenResponse.status, stage: "token" };
      }
      response = await request({ Authorization: `Bearer ${token}` });
    }
    if (!response.ok) return { ok: false, status: response.status, stage: "manifest" };
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      status: response.status,
      bytes,
      digest: sha256Digest(bytes),
      mediaType: String(response.headers.get("content-type") ?? "").split(";")[0].trim(),
    };
  } catch (error) {
    return { ok: false, status: 0, stage: "network", code: String(error?.name ?? "Error") };
  }
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Read a manifest with bounded backoff on rate limits, 5xx and network errors.
 * 401, 403 and 404 are answers, not outages, and are returned at once.
 */
export async function readManifestWithBackoff(
  reference,
  {
    read = fetchManifest,
    attempts = SOURCE_READ_ATTEMPTS,
    backoffMs = SOURCE_READ_BACKOFF_MS,
    sleep = delay,
    log = console.log,
  } = {},
) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await read(reference);
    if (last.ok || !retryableStatus(last.status) || attempt === attempts) break;
    const wait = backoffMs * 2 ** (attempt - 1);
    log(`::warning::${reference.split("@")[0]} read failed (${last.stage} ${last.status}); retrying in ${wait / 1000}s.`);
    await sleep(wait);
  }
  return last;
}

/** Read a manifest by digest with bounded backoff, accepting only the expected bytes. */
export async function readVerifiedManifest(reference, expectedDigest, options = {}) {
  const last = await readManifestWithBackoff(reference, options);
  if (!last.ok) return last;
  return last.digest === expectedDigest ? last : { ok: false, status: last.status, stage: "digest-mismatch" };
}

/**
 * Child manifest digests of an image index, [] for a single-platform manifest,
 * or null when the bytes are not a manifest these scripts can read.
 */
export function childDigests(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.manifests)) return [];
  const digests = parsed.manifests.map((entry) => entry?.digest);
  return digests.every((digest) => typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest)) ? digests : null;
}

export function commandTail(result) {
  return String(result?.stderr ?? "").trim().split("\n").slice(-10).join("\n").slice(-2_000);
}

/** Raw manifest bytes and their digest as the logged-in Docker client sees them, or null. */
export function inspectRaw(reference, { execute = spawnSync } = {}) {
  const result = execute("docker", ["buildx", "imagetools", "inspect", "--raw", reference], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!result || result.error || result.status !== 0) return null;
  return { bytes: result.stdout, digest: sha256Digest(result.stdout) };
}

export const inspectRawDigest = (reference, options) => inspectRaw(reference, options)?.digest ?? null;
