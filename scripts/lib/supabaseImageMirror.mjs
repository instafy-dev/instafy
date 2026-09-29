// GHCR mirror of the exact Supabase images CI uses.
//
// public.ecr.aws caps anonymous pulls by data volume per source IP, and
// GitHub-hosted runners share IPs, so reruns kept failing with
// "toomanyrequests: Data limit exceeded". supabase/image-mirror.lock.json pins
// every image by its upstream index digest; the protected-main workflow
// .github/workflows/mirror-supabase-images.yml copies those exact indexes to
// ghcr.io/instafy-dev/supabase/<name> without changing a byte, and CI pulls the
// same digest from there first. ECR Public remains the fallback.
//
// For the Supabase CLI this module does not redirect the registry. The pinned
// CLI resolves every image as public.ecr.aws/supabase/<basename>:<tag> and
// skips its own pull when that exact local reference already exists:
// https://github.com/supabase/cli/blob/v2.92.0/internal/utils/docker.go#L238-L246
// (and PullPolicyMissing in internal/utils/config.go GetServices). Pulling the
// locked digest and tagging it with that local name therefore removes the
// registry request. Docker verifies by-digest pulls, so the local tag can only
// name the locked bytes. When both registries fail, the CLI's own pull still
// runs exactly as before.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { reportDockerFailure } from "./supabaseSerialPull.mjs";
import {
  parseSupabaseAuthOnly, parseSupabaseBrowserTest, parseSupabaseDatabaseOnly,
} from "./supabaseStartMode.mjs";

export const IMAGE_MIRROR_LOCK_URL = new URL("../../supabase/image-mirror.lock.json", import.meta.url);
export const IMAGE_MIRROR_SOURCE = "public.ecr.aws/supabase";
export const IMAGE_MIRROR_REGISTRY = "ghcr.io/instafy-dev/supabase";
// Startup profiles nest: database-only within Auth-only within browser-test within full.
export const IMAGE_MIRROR_MODES = Object.freeze(["database", "auth-email", "browser-test", "full"]);
export const IMAGE_MIRROR_NAMES = Object.freeze([
  "postgres", "gotrue", "realtime", "storage-api", "postgrest",
  "kong", "mailpit", "imgproxy", "studio", "postgres-meta",
]);
export const IMAGE_MIRROR_PULL_ATTEMPTS = 2;
export const IMAGE_MIRROR_PULL_TIMEOUT_MS = 180_000;
export const IMAGE_MIRROR_BACKOFF_MS = 5_000;
export const IMAGE_MIRROR_BUDGET_MS = 10 * 60_000;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const UPSTREAM = /^docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/([a-z0-9]+(?:[._-][a-z0-9]+)*)$/u;
// Registry answers that another attempt at the same registry cannot change.
const PERMANENT_PULL_FAILURE = /denied|unauthorized|forbidden|authentication required|manifest unknown|not found/iu;
// Transport failures: the registry did not answer this runner at all. A stalled
// pull only ends at its own timeout, so retrying it, or asking the same
// registry for the next image, would spend the whole budget on one stall.
const UNREACHABLE_PULL_FAILURE = /i\/o timeout|context deadline exceeded|client\.timeout exceeded|tls handshake timeout|no such host|temporary failure in name resolution|connection refused|network is unreachable|no route to host|proxyconnect/iu;

/** A pull killed at its timeout, or one that never reached the registry. */
export function registryUnreachable(result) {
  return result?.error?.code === "ETIMEDOUT" || Boolean(result?.signal)
    || UNREACHABLE_PULL_FAILURE.test(String(result?.stderr ?? ""));
}

function invalidLock(reason) {
  return new Error(`supabase-image-mirror-lock-invalid: ${reason}`);
}

export function validateSupabaseImageMirrorLock(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) throw invalidLock("not an object");
  if (Object.keys(lock).sort().join(",") !== "images,mirror,schemaVersion,source,supabaseCli") {
    throw invalidLock("unexpected keys");
  }
  if (lock.schemaVersion !== 1) throw invalidLock("schemaVersion");
  if (typeof lock.supabaseCli !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(lock.supabaseCli)) {
    throw invalidLock("supabaseCli");
  }
  if (lock.source !== IMAGE_MIRROR_SOURCE) throw invalidLock("source");
  if (lock.mirror !== IMAGE_MIRROR_REGISTRY) throw invalidLock("mirror");
  if (!Array.isArray(lock.images) || lock.images.length === 0) throw invalidLock("images");
  const names = new Set();
  const digests = new Set();
  const images = lock.images.map((image, index) => {
    if (!image || typeof image !== "object" || Array.isArray(image)
      || Object.keys(image).sort().join(",") !== "digest,modes,name,tag,upstream") {
      throw invalidLock(`image ${index} keys`);
    }
    const { name, tag, digest, upstream, modes } = image;
    if (!IMAGE_MIRROR_NAMES.includes(name) || names.has(name)) throw invalidLock(`image ${index} name`);
    if (typeof tag !== "string" || !TAG.test(tag) || tag === "latest") throw invalidLock(`${name} tag`);
    if (typeof digest !== "string" || !DIGEST.test(digest) || digests.has(digest)) throw invalidLock(`${name} digest`);
    // Same basename rule as the CLI's GetRegistryImageUrl mapping.
    const upstreamMatch = typeof upstream === "string" ? UPSTREAM.exec(upstream) : null;
    if (!upstreamMatch || upstreamMatch[1] !== name) throw invalidLock(`${name} upstream`);
    const first = Array.isArray(modes) ? IMAGE_MIRROR_MODES.indexOf(modes[0]) : -1;
    if (first < 0 || JSON.stringify(modes) !== JSON.stringify(IMAGE_MIRROR_MODES.slice(first))) {
      throw invalidLock(`${name} modes`);
    }
    names.add(name);
    digests.add(digest);
    return Object.freeze({ name, tag, digest, upstream, modes: Object.freeze([...modes]) });
  });
  return Object.freeze({
    schemaVersion: 1, supabaseCli: lock.supabaseCli, source: lock.source, mirror: lock.mirror,
    images: Object.freeze(images),
  });
}

export function loadSupabaseImageMirrorLock(file = IMAGE_MIRROR_LOCK_URL) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw invalidLock("unreadable");
  }
  return validateSupabaseImageMirrorLock(parsed);
}

export const mirrorImageRef = (image) => `${IMAGE_MIRROR_REGISTRY}/${image.name}@${image.digest}`;
export const mirrorTagRef = (image) => `${IMAGE_MIRROR_REGISTRY}/${image.name}:${image.tag}`;
export const sourceImageRef = (image) => `${IMAGE_MIRROR_SOURCE}/${image.name}@${image.digest}`;
export const upstreamImageRef = (image) => `${image.upstream}@${image.digest}`;
// The exact local reference the pinned CLI inspects before it would pull.
export const cliImageRef = (image) => `${IMAGE_MIRROR_SOURCE}/${image.name}:${image.tag}`;

/** Map a digest-pinned ECR Public Supabase reference to the same digest on the GHCR mirror. */
export function mirrorImageFor(reference) {
  const match = /^public\.ecr\.aws\/supabase\/([a-z0-9]+(?:-[a-z0-9]+)*)@(sha256:[0-9a-f]{64})$/u
    .exec(typeof reference === "string" ? reference : "");
  if (!match) throw new Error(`not a digest-pinned ECR Public Supabase image reference: ${reference}`);
  return `${IMAGE_MIRROR_REGISTRY}/${match[1]}@${match[2]}`;
}

/**
 * SUPABASE_IMAGE_MIRROR=ghcr turns the mirror on and =off turns it off. Unset,
 * it is on only under GitHub Actions, so local developer startup is unchanged
 * unless a developer opts in.
 */
export function resolveSupabaseImageMirror(env = process.env) {
  const value = env.SUPABASE_IMAGE_MIRROR;
  if (value == null || value === "") return env.GITHUB_ACTIONS === "true";
  if (value === "ghcr") return true;
  if (value === "off") return false;
  throw new Error("SUPABASE_IMAGE_MIRROR must be unset, ghcr, or off");
}

export function supabaseImageMirrorMode({ databaseOnly, authOnly, browserTest }) {
  const flags = [databaseOnly, authOnly, browserTest];
  if (flags.some((value) => typeof value !== "boolean") || flags.filter(Boolean).length > 1) {
    throw new Error("supabase-image-mirror-start-mode-invalid");
  }
  return databaseOnly ? "database" : authOnly ? "auth-email" : browserTest ? "browser-test" : "full";
}

export function imagesForMode(lock, mode) {
  if (!IMAGE_MIRROR_MODES.includes(mode)) throw new Error("supabase-image-mirror-start-mode-invalid");
  return lock.images.filter((image) => image.modes.includes(mode));
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, milliseconds);
}

const succeeded = (result) => Boolean(result) && !result.error && !result.signal && result.status === 0;

/**
 * Before `supabase start`/`db start`, make every locked image the selected
 * profile will request present under the CLI's own local reference. Full mode
 * also starts Edge Runtime, which is not locked and stays a CLI pull. Serial
 * and bounded; never fatal for registry trouble (the CLI's pull is the last
 * resort), but invalid configuration fails before startup.
 */
export function prepareSupabaseImageMirror({
  repoRoot, env = process.env,
  databaseOnly = parseSupabaseDatabaseOnly(env.SUPABASE_DATABASE_ONLY),
  authOnly = parseSupabaseAuthOnly(env.SUPABASE_AUTH_ONLY),
  browserTest = parseSupabaseBrowserTest(env.SUPABASE_BROWSER_TEST),
  execute = spawnSync, now = () => performance.now(), wait = sleep, log = console.log,
  loadLock = loadSupabaseImageMirrorLock,
}) {
  const mode = supabaseImageMirrorMode({ databaseOnly, authOnly, browserTest });
  const summary = { enabled: false, images: 0, present: 0, mirrored: 0, fallback: 0, deferred: 0 };
  if (!resolveSupabaseImageMirror(env)) return summary;
  if (env.SUPABASE_INTERNAL_IMAGE_REGISTRY) {
    log("[supabase-stack] SUPABASE_INTERNAL_IMAGE_REGISTRY is set; leaving image pulls to the Supabase CLI.");
    return summary;
  }
  const lock = loadLock();
  const started = now();
  const remaining = () => IMAGE_MIRROR_BUDGET_MS - (now() - started);
  // Registry work stops at the shared deadline; a local-only `docker tag` of
  // an image already pulled still completes within its own small bound.
  const run = (binary, args, budget, { localOnly = false } = {}) => {
    const left = localOnly ? budget : remaining();
    if (!Number.isFinite(left) || left <= 0) return { deadline: true };
    try {
      return execute(binary, args, {
        cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout: Math.max(1, Math.floor(Math.min(budget, left))), killSignal: "SIGKILL", maxBuffer: 262_144,
      }) ?? {};
    } catch (thrown) {
      return { thrown };
    }
  };
  const report = (stage, ref, result) => reportDockerFailure(log, stage, ref, result.thrown ? undefined : result, result.thrown);

  // Another CLI version asks for other tags; pre-seeding the locked ones would
  // only download images nobody starts.
  const version = run("pnpm", ["exec", "supabase", "--version"], 30_000);
  if (!succeeded(version) || String(version.stdout ?? "").trim() !== lock.supabaseCli) {
    log(`[supabase-stack] Supabase CLI is not the image-mirror lock's ${lock.supabaseCli}; leaving image pulls to the Supabase CLI.`);
    return summary;
  }

  const images = imagesForMode(lock, mode);
  Object.assign(summary, { enabled: true, images: images.length });
  // A registry that timed out or was unreachable once is skipped for the rest
  // of this start, so a stalled GHCR costs one pull timeout, not the budget.
  const unreachable = new Set();
  for (const [index, image] of images.entries()) {
    const local = cliImageRef(image);
    if (remaining() <= 0) {
      summary.deferred += images.length - index;
      log(`[supabase-stack] Image mirror budget spent; leaving ${images.length - index} image(s) to the Supabase CLI.`);
      break;
    }
    if (succeeded(run("docker", ["image", "inspect", "--format", "{{.Id}}", local], 15_000))) {
      summary.present += 1;
      continue;
    }
    let pulled;
    let deadline = false;
    for (const [stage, ref] of [["mirror-pull", mirrorImageRef(image)], ["ecr-pull", sourceImageRef(image)]]) {
      if (unreachable.has(stage)) continue;
      if (stage === "ecr-pull") {
        log(`[supabase-stack] GHCR mirror unavailable for ${image.name}; pulling the same digest from ECR Public.`);
      }
      for (let attempt = 1; attempt <= IMAGE_MIRROR_PULL_ATTEMPTS; attempt += 1) {
        const result = run("docker", ["pull", "--quiet", ref], IMAGE_MIRROR_PULL_TIMEOUT_MS);
        if (succeeded(result)) {
          pulled = { stage, ref };
          break;
        }
        if (result.deadline) {
          deadline = true;
          break;
        }
        report(stage, local, result);
        if (registryUnreachable(result)) {
          unreachable.add(stage);
          log(`[supabase-stack] ${stage === "mirror-pull" ? "GHCR" : "ECR Public"} timed out or was unreachable; `
            + "skipping it for the remaining images.");
          break;
        }
        if (attempt === IMAGE_MIRROR_PULL_ATTEMPTS || PERMANENT_PULL_FAILURE.test(String(result.stderr ?? ""))) break;
        wait(Math.max(0, Math.min(IMAGE_MIRROR_BACKOFF_MS * attempt, remaining())));
      }
      if (pulled || deadline) break;
    }
    if (!pulled) {
      summary.deferred += 1;
      log(`[supabase-stack] Leaving ${image.name} to the Supabase CLI's own pull.`);
      continue;
    }
    const tagged = run("docker", ["tag", pulled.ref, local], 15_000, { localOnly: true });
    if (!succeeded(tagged)) {
      report("mirror-tag", local, tagged);
      summary.deferred += 1;
      continue;
    }
    if (pulled.stage === "mirror-pull") summary.mirrored += 1;
    else summary.fallback += 1;
  }
  log(`[supabase-stack] Image mirror preparation complete (${summary.images} images: ${summary.present} present, `
    + `${summary.mirrored} from GHCR, ${summary.fallback} from ECR Public, ${summary.deferred} left to the CLI).`);
  return summary;
}
