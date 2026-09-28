#!/usr/bin/env node
// Copies the exact Supabase images pinned in supabase/image-mirror.lock.json
// to ghcr.io/instafy-dev/supabase/<name>, preserving every index digest, and
// proves each copy is anonymously pullable. Run by
// .github/workflows/mirror-supabase-images.yml on protected main only.
//
//   node scripts/mirror-supabase-images.mjs plan --output <file>
//   node scripts/mirror-supabase-images.mjs copy --plan <file>
//   node scripts/mirror-supabase-images.mjs verify
//
// plan and verify make only anonymous registry reads. copy needs a prior
// `docker login ghcr.io`. It runs `docker buildx imagetools create` with one
// source and no annotations or platform filter, which republishes the source
// index bytes unchanged together with every child manifest (buildx v0.35.0
// util/imagetools/create.go), and it refuses any result whose digest differs
// from the lock. ECR Public is the source; Docker Hub serves the identical
// digests and is the fallback when ECR's anonymous data cap refuses a read.
// The digest makes the source irrelevant to what lands in GHCR.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  IMAGE_MIRROR_REGISTRY,
  cliImageRef,
  loadSupabaseImageMirrorLock,
  mirrorImageRef,
  mirrorTagRef,
  sourceImageRef,
  upstreamImageRef,
} from "./lib/supabaseImageMirror.mjs";

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
export const COPY_ATTEMPTS = 3;
export const COPY_BACKOFF_MS = 15_000;
export const COPY_TIMEOUT_MS = 15 * 60_000;
export const VISIBILITY_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 30_000;

export const sha256Digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function packageSettingsUrl(name) {
  return `https://github.com/orgs/instafy-dev/packages/container/supabase%2F${name}/settings`;
}

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

const retryableStatus = (status) => status === 0 || status === 429 || status >= 500;

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

/** Read a manifest by digest with bounded backoff on rate limits, 5xx and network errors. */
export async function readVerifiedManifest(
  reference,
  expectedDigest,
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
    if (last.ok) {
      return last.digest === expectedDigest
        ? last
        : { ok: false, status: last.status, stage: "digest-mismatch" };
    }
    if (!retryableStatus(last.status) || attempt === attempts) break;
    const wait = backoffMs * 2 ** (attempt - 1);
    log(`::warning::${reference.split("@")[0]} read failed (${last.stage} ${last.status}); retrying in ${wait / 1000}s.`);
    await sleep(wait);
  }
  return last;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Child manifest digests of an image index, [] for a single-platform manifest,
 * or null when the bytes are not a manifest this script can read.
 */
function childDigests(bytes) {
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

const mirrorDigestRef = (name, digest) => `${IMAGE_MIRROR_REGISTRY}/${name}@${digest}`;

/**
 * Anonymous read of everything CI can request from GHCR for one lock entry:
 * the index by digest, the upstream tag, and every child manifest. GHCR lists
 * each child of a multi-platform index as its own untagged package version,
 * so an index can outlive a child that CI's by-digest pull then misses.
 */
async function inspectMirror(image, read) {
  const index = await read(mirrorImageRef(image));
  if (!index.ok || index.digest !== image.digest) return { index, complete: false };
  const tag = await read(mirrorTagRef(image));
  const tagOk = tag.ok && tag.digest === image.digest;
  const children = childDigests(index.bytes);
  const missingChildren = [];
  for (const child of children ?? []) {
    const manifest = await read(mirrorDigestRef(image.name, child));
    if (!manifest.ok || manifest.digest !== child) missingChildren.push(child);
  }
  return {
    index, tagOk, missingChildren, unreadable: children === null,
    complete: tagOk && children !== null && missingChildren.length === 0,
  };
}

/** Decide which lock entries GHCR does not already serve anonymously, and a verified source for each. */
export async function planMirror(lock, { read = fetchManifest, sleep = delay, log = console.log } = {}) {
  const entries = [];
  const present = [];
  for (const image of lock.images) {
    const mirrored = await inspectMirror(image, read);
    if (mirrored.complete) {
      present.push(image.name);
      continue;
    }
    if (mirrored.index.ok && mirrored.index.digest === image.digest) {
      const gaps = [...(mirrored.tagOk ? [] : [`tag ${image.tag}`]),
        ...mirrored.missingChildren.map((child) => `child manifest ${child}`),
        ...(mirrored.unreadable ? ["a readable index"] : [])];
      log(`::warning::${image.name}: GHCR serves ${image.digest} but not its ${gaps.join(", ")}; copying it again.`);
    }
    const candidates = [sourceImageRef(image), upstreamImageRef(image)];
    let verified;
    for (const candidate of candidates) {
      const source = await readVerifiedManifest(candidate, image.digest, { read, sleep, log });
      if (source.ok) {
        verified = candidate;
        break;
      }
      log(`::warning::${candidate.split("@")[0]} did not serve ${image.name}@${image.digest} (${source.stage} ${source.status}).`);
    }
    if (!verified) {
      throw new Error(`no source served ${image.name}@${image.digest}; nothing was copied`);
    }
    entries.push({
      name: image.name,
      tag: image.tag,
      digest: image.digest,
      target: mirrorTagRef(image),
      sources: [verified, ...candidates.filter((candidate) => candidate !== verified)],
    });
  }
  return { schemaVersion: 1, present, entries };
}

/** A plan may name only lock entries, their fixed GHCR tag and their two fixed sources. */
export function validatePlan(plan, lock) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.entries) || !Array.isArray(plan.present)) {
    throw new Error("mirror plan is invalid");
  }
  const seen = new Set();
  for (const entry of plan.entries) {
    const image = lock.images.find((candidate) => candidate.name === entry?.name);
    const allowed = image ? [sourceImageRef(image), upstreamImageRef(image)] : [];
    if (!image || seen.has(image.name)
      || Object.keys(entry).sort().join(",") !== "digest,name,sources,tag,target"
      || entry.tag !== image.tag || entry.digest !== image.digest || entry.target !== mirrorTagRef(image)
      || !Array.isArray(entry.sources) || entry.sources.length !== 2
      || [...entry.sources].sort().join("\n") !== [...allowed].sort().join("\n")) {
      throw new Error(`mirror plan entry is not in the lock: ${entry?.name}`);
    }
    seen.add(image.name);
  }
  return plan;
}

function commandTail(result) {
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

/** The first thing GHCR lacks for a plan entry (index, tag or a child manifest), or null when it holds all of it. */
function ghcrGap(entry, { execute }) {
  const index = inspectRaw(mirrorDigestRef(entry.name, entry.digest), { execute });
  if (index?.digest !== entry.digest) return `index ${entry.digest}`;
  if (inspectRawDigest(entry.target, { execute }) !== entry.digest) return `tag ${entry.target}`;
  const children = childDigests(index.bytes);
  if (children === null) return "a readable index";
  const missing = children.find((child) => inspectRawDigest(mirrorDigestRef(entry.name, child), { execute }) !== child);
  return missing ? `child manifest ${missing}` : null;
}

/** Copy each planned image with the logged-in Docker client, then prove the digest. */
export async function copyMirror(plan, { execute = spawnSync, sleep = delay, log = console.log } = {}) {
  const copied = [];
  for (const entry of plan.entries) {
    const immutable = mirrorDigestRef(entry.name, entry.digest);
    // A package GHCR already holds completely (for example one that is not
    // public yet) is already correct; do not rewrite it, verify it below. A
    // missing tag or child manifest is re-pushed by the same idempotent copy.
    const gap = ghcrGap(entry, { execute });
    if (gap === null) {
      log(`${entry.name}: GHCR already holds ${entry.digest}, its tag and every child manifest; skipping the copy.`);
    } else {
      if (!gap.startsWith("index ")) log(`${entry.name}: GHCR holds ${entry.digest} but not its ${gap}; copying it again.`);
      let done = false;
      for (const source of entry.sources) {
        for (let attempt = 1; attempt <= COPY_ATTEMPTS && !done; attempt += 1) {
          log(`${entry.name}: copying ${source.split("@")[0]} (attempt ${attempt}/${COPY_ATTEMPTS})...`);
          const result = execute(
            "docker",
            ["buildx", "imagetools", "create", "--tag", entry.target, source],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: COPY_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
          );
          if (result && !result.error && result.status === 0) {
            done = true;
            break;
          }
          log(`::warning::${entry.name}: copy from ${source.split("@")[0]} failed.\n${commandTail(result)}`);
          if (attempt < COPY_ATTEMPTS) await sleep(COPY_BACKOFF_MS * 2 ** (attempt - 1));
        }
        if (done) break;
      }
      if (!done) throw new Error(`${entry.name}: every source failed; the image was not published`);
    }
    // GHCR can expose a new manifest a few seconds after the write returns.
    let index = null;
    for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
      index = inspectRaw(immutable, { execute });
      if (index?.digest === entry.digest || attempt === VISIBILITY_ATTEMPTS) break;
      await sleep(1_000 * 2 ** attempt);
    }
    if (index?.digest !== entry.digest) {
      throw new Error(`${entry.name}: GHCR does not serve ${entry.digest} (got ${index?.digest ?? "nothing"})`);
    }
    const tagDigest = inspectRawDigest(entry.target, { execute });
    if (tagDigest !== entry.digest) {
      throw new Error(`${entry.name}: ${entry.target} resolves to ${tagDigest ?? "nothing"}, not ${entry.digest}`);
    }
    for (const child of childDigests(index.bytes) ?? []) {
      if (inspectRawDigest(mirrorDigestRef(entry.name, child), { execute }) !== child) {
        throw new Error(`${entry.name}: GHCR does not serve child manifest ${child} of ${entry.digest}`);
      }
    }
    copied.push(entry.name);
    log(`${entry.name}: GHCR serves ${entry.digest}.`);
  }
  return copied;
}

/** Anonymous proof for every lock entry: index, tag and each child manifest. */
export async function verifyMirror(lock, { read = fetchManifest, log = console.log } = {}) {
  const problems = [];
  const rows = [];
  for (const image of lock.images) {
    const row = { name: image.name, tag: image.tag, digest: image.digest, ghcr: "ok", upstreamTag: "unchanged" };
    rows.push(row);
    const { index, tagOk, missingChildren, unreadable } = await inspectMirror(image, read);
    if (!index.ok) {
      if (index.status === 401 || index.status === 403) {
        // GHCR answers 403 for both a private and an absent package. After a
        // successful copy step it means the package still needs to be public.
        row.ghcr = "not public or missing";
        problems.push(`${image.name} is not anonymously pullable (HTTP ${index.status}). If the copy step succeeded, set the package visibility to Public: ${packageSettingsUrl(image.name)}`);
      } else {
        row.ghcr = index.status === 404 ? "missing" : `unreachable (${index.stage} ${index.status})`;
        problems.push(`${image.name}: GHCR did not serve ${image.digest} (${index.stage} ${index.status}).`);
      }
    } else if (index.digest !== image.digest) {
      row.ghcr = "digest mismatch";
      problems.push(`${image.name}: GHCR returned ${index.digest} for ${image.digest}.`);
    } else {
      if (!tagOk) {
        row.ghcr = "tag mismatch";
        problems.push(`${image.name}: ${mirrorTagRef(image)} does not resolve to ${image.digest}.`);
      }
      if (unreadable) {
        row.ghcr = "incomplete";
        problems.push(`${image.name}: GHCR served ${image.digest} but not as an image manifest.`);
      }
      for (const child of missingChildren) {
        row.ghcr = "incomplete";
        problems.push(`${image.name}: child manifest ${child} is not anonymously pullable from GHCR.`);
      }
    }
    // Informational: the mirror keeps the locked bytes even if upstream moves a tag.
    const upstream = await read(cliImageRef(image));
    if (!upstream.ok) {
      row.upstreamTag = "unchecked";
      log(`::warning::Could not check whether ${cliImageRef(image)} still resolves to the locked digest (${upstream.stage} ${upstream.status}).`);
    } else if (upstream.digest !== image.digest) {
      row.upstreamTag = "moved";
      log(`::warning::${cliImageRef(image)} now resolves to ${upstream.digest}; the lock and mirror keep ${image.digest}.`);
    }
  }
  return { problems, rows };
}

export function summaryMarkdown(rows) {
  return [
    "### Supabase image mirror",
    "",
    "| Image | Tag | Digest | GHCR (anonymous) | Upstream tag |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.name} | \`${row.tag}\` | \`${row.digest.slice(0, 19)}\` | ${row.ghcr} | ${row.upstreamTag} |`),
    "",
  ].join("\n");
}

function argument(args, flag) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} <file> is required`);
  return value;
}

function appendGithubFile(variable, text) {
  const file = process.env[variable];
  if (file) fs.appendFileSync(file, text);
}

async function main(args) {
  const lock = loadSupabaseImageMirrorLock();
  const [command, ...rest] = args;
  if (command === "plan") {
    const output = path.resolve(argument(rest, "--output"));
    const plan = await planMirror(lock);
    fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`GHCR already serves ${plan.present.length} of ${lock.images.length} locked images; ${plan.entries.length} to copy.`);
    appendGithubFile("GITHUB_OUTPUT", `missing=${plan.entries.length}\n`);
    return;
  }
  if (command === "copy") {
    const plan = validatePlan(JSON.parse(fs.readFileSync(argument(rest, "--plan"), "utf8")), lock);
    const copied = await copyMirror(plan);
    console.log(`Copied or confirmed ${copied.length} image(s) in GHCR.`);
    return;
  }
  if (command === "verify") {
    const { problems, rows } = await verifyMirror(lock);
    appendGithubFile("GITHUB_STEP_SUMMARY", summaryMarkdown(rows));
    for (const problem of problems) console.log(`::error::${problem}`);
    if (problems.length > 0) {
      throw new Error(`${problems.length} mirror problem(s); CI keeps falling back to ECR Public until they are fixed`);
    }
    console.log(`All ${lock.images.length} locked images are anonymously pullable from GHCR by digest.`);
    return;
  }
  throw new Error("usage: mirror-supabase-images.mjs plan --output <file> | copy --plan <file> | verify");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
