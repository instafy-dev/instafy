// GHCR mirror of the Docker Hub images that image builds pull.
//
// Docker Hub limits anonymous pulls per source IP. The self-hosted publishers
// share one egress IP and hosted runners share IP pools, so publication and the
// nightly image scan kept failing with "429 Too Many Requests" on digest-pinned
// base images, and setup-buildx timed out pulling the BuildKit image itself.
//
// There is no lock file: the repository is the source of truth. Every
// digest-pinned Docker Hub reference in a tracked Dockerfile (FROM lines, the
// syntax directive, ARG defaults and COPY --from images) and every BuildKit
// image pin in a workflow is copied unchanged, by digest, to
// ghcr.io/instafy-dev/dockerhub/<path>. That is exactly the mapping BuildKit
// applies to a `[registry."docker.io"] mirrors = ["ghcr.io/instafy-dev/dockerhub"]`
// entry: docker.io/library/rust becomes ghcr.io/instafy-dev/dockerhub/library/rust.
// BuildKit tries the mirror first and falls back to Docker Hub on any miss, and
// a digest pin makes both sources serve identical bytes, so a missing mirror
// entry only costs the Docker Hub pull it replaces.
//
// dockerd pulls the BuildKit image for a docker-container builder without that
// mirror; resolveBuildkitImage picks the GHCR copy when it is served anonymously.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { childDigests, fetchManifest } from "./registryManifests.mjs";

export const DOCKER_HUB_MIRROR = "ghcr.io/instafy-dev/dockerhub";
export const DOCKER_HUB_SOURCE = "docker.io";
// The buildkitd-config-inline every docker-container builder of an image build
// carries (scripts/check-docker-hub-mirror-workflows.test.mjs enforces it).
export const BUILDKITD_MIRROR_CONFIG = `[registry."docker.io"]\nmirrors = ["${DOCKER_HUB_MIRROR}"]\n`;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * Classify an image reference the way the Docker reference grammar does. The
 * first component is a registry host only when it contains "." or ":" or is
 * "localhost"; otherwise the image is on Docker Hub, and a single-component
 * name lives under library/.
 *
 * Returns null for a string that is not an image reference.
 */
export function parseImageReference(reference) {
  if (typeof reference !== "string" || reference.length === 0 || /\s|\$/u.test(reference)) return null;
  let rest = reference;
  let digest = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return null;
  }
  let tag = null;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return null;
  }
  const components = rest.split("/");
  let registry = DOCKER_HUB_SOURCE;
  if (components.length > 1 && (/[.:]/u.test(components[0]) || components[0] === "localhost")) {
    registry = components.shift();
  }
  if (components.length === 0 || !components.every((component) => COMPONENT.test(component))) return null;
  const dockerHub = DOCKER_HUB_HOSTS.has(registry);
  if (dockerHub && components.length === 1) components.unshift("library");
  return {
    registry: dockerHub ? DOCKER_HUB_SOURCE : registry,
    dockerHub,
    path: components.join("/"),
    tag,
    digest,
  };
}

/**
 * The immutable GHCR tag for one mirrored digest: the upstream tag when known,
 * else "pinned", plus the first 12 hex characters of the digest. Always a
 * valid OCI tag of at most 128 characters.
 */
export function mirrorTag(tag, digest) {
  if (!DIGEST.test(digest ?? "")) throw new Error(`not a sha256 digest: ${digest}`);
  const suffix = `-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
  const base = typeof tag === "string" && TAG.test(tag) ? tag.slice(0, 128 - suffix.length) : "pinned";
  return `${base}${suffix}`;
}

export const mirrorDigestRef = (image) => `${DOCKER_HUB_MIRROR}/${image.path}@${image.digest}`;
export const mirrorTagRef = (image) => `${DOCKER_HUB_MIRROR}/${image.path}:${image.mirrorTag}`;
export const sourceDigestRef = (image) => `${DOCKER_HUB_SOURCE}/${image.path}@${image.digest}`;
// Docker publishes the official (library/) images to ECR Public under the
// same digests, without Docker Hub's anonymous pull limit.
export const ECR_LIBRARY_SOURCE = "public.ecr.aws/docker";

/**
 * Where to copy one image from, in order. Official images are read from ECR
 * Public first; Docker Hub is the fallback and the only source for everything
 * else. The digest makes the source irrelevant to what lands in GHCR.
 */
export function copySources(image) {
  const dockerHub = sourceDigestRef(image);
  return image.path.startsWith("library/") ? [`${ECR_LIBRARY_SOURCE}/${image.path}@${image.digest}`, dockerHub] : [dockerHub];
}

// --- Discovery ---------------------------------------------------------------

/** Tracked Dockerfiles outside the codex submodule, repository-relative and sorted. */
export function trackedDockerfiles(files) {
  return files.filter((file) => {
    if (file === "codex" || file.startsWith("codex/")) return false;
    const base = path.posix.basename(file);
    return base === "Dockerfile" || base.startsWith("Dockerfile.") || base.endsWith(".Dockerfile");
  }).sort();
}

/** Workflow files whose BuildKit image pins are mirrored. */
export function workflowFiles(files) {
  return files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file)).sort();
}

function substitute(value, defaults) {
  let unresolved = false;
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (match, braced, bare) => {
    const name = braced ?? bare;
    if (defaults.has(name)) return defaults.get(name);
    unresolved = true;
    return match;
  });
  return unresolved ? null : resolved;
}

function unquote(value) {
  return /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
}

/**
 * Image references one Dockerfile pulls. FROM may use only global ARGs (those
 * before the first FROM); an ARG default inside a stage is resolved against the
 * global ARGs and the stage's earlier ARGs, which is enough for the
 * `ARG RUST_IMAGE=rust:${RUST_TOOLCHAIN}-...@sha256:...` pattern used here.
 */
export function dockerfileReferences(source) {
  const references = [];
  const lines = source.replace(/\\\r?\n/gu, " ").split(/\r?\n/u);
  const globals = new Map();
  let scope = globals;
  let seenInstruction = false;
  const stages = new Set();
  const add = (raw, kind, defaults) => {
    const resolved = substitute(raw, defaults);
    references.push({ raw, kind, reference: resolved ?? raw, resolved: resolved !== null });
  };
  for (const line of lines) {
    const syntax = !seenInstruction && /^#\s*syntax\s*=\s*(\S+)\s*$/iu.exec(line);
    if (syntax) {
      add(syntax[1], "syntax", new Map());
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    seenInstruction = true;
    const [instruction] = trimmed.split(/\s+/u, 1);
    const upper = instruction.toUpperCase();
    if (upper === "ARG") {
      for (const declaration of trimmed.slice(instruction.length).trim().split(/\s+/u)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/u.exec(declaration);
        if (!match) continue;
        if (match[2] === undefined) {
          // A stage's bare ARG re-imports the global default.
          if (scope !== globals && globals.has(match[1])) scope.set(match[1], globals.get(match[1]));
          continue;
        }
        const value = unquote(match[2]);
        const resolved = substitute(value, scope) ?? value;
        scope.set(match[1], resolved);
        if (value.includes("@sha256:")) add(value, "arg", scope === globals ? globals : new Map([...globals, ...scope]));
      }
      continue;
    }
    if (upper === "FROM") {
      const parts = trimmed.split(/\s+/u).slice(1).filter((part) => !part.startsWith("--"));
      const [image, as, name] = parts;
      if (image && image.toLowerCase() !== "scratch" && !stages.has(image.toLowerCase())) add(image, "from", globals);
      if (as?.toUpperCase() === "AS" && name) stages.add(name.toLowerCase());
      scope = new Map(globals);
      continue;
    }
    if (upper === "COPY" || upper === "ADD" || upper === "RUN") {
      for (const match of trimmed.matchAll(/--(?:from|mount=[^\s]*?from)=([^\s,]+)/gu)) {
        const value = match[1];
        if (/^\d+$/u.test(value) || stages.has(value.toLowerCase())) continue;
        add(value, "copy-from", scope);
      }
    }
  }
  return references;
}

/** Digest-pinned BuildKit image references in one workflow file. */
export function workflowReferences(source) {
  // A tag or a digest is required, so prose that merely names moby/buildkit
  // is not a reference; a tag without a digest is reported as unpinned.
  return [...source.matchAll(/(?<![\w./-])((?:docker\.io\/)?moby\/buildkit(?::[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[0-9a-f]{64}|@sha256:[0-9a-f]{64}|:[A-Za-z0-9_][A-Za-z0-9_.-]*))(?![\w.:@/-])/gu)]
    .map((match) => ({ raw: match[1], kind: "buildkit", reference: match[1], resolved: true }));
}

/**
 * Every Docker Hub image the repository's image builds pull, grouped by
 * (path, digest). `files` maps repository-relative paths to file contents.
 *
 * Returns { images, unpinned, skipped }: images to mirror in a stable order;
 * Docker Hub references with no digest (reported, never mirrored); and
 * references to other registries (left alone).
 */
export function discoverDockerHubImages(files) {
  const byKey = new Map();
  const unpinned = [];
  const skipped = [];
  for (const [file, source] of Object.entries(files)) {
    const references = file.startsWith(".github/workflows/") ? workflowReferences(source) : dockerfileReferences(source);
    for (const entry of references) {
      const parsed = entry.resolved ? parseImageReference(entry.reference) : null;
      if (!parsed) {
        unpinned.push({ reference: entry.raw, source: file, reason: entry.resolved ? "not an image reference" : "unresolved build argument" });
        continue;
      }
      if (!parsed.dockerHub) {
        skipped.push({ reference: entry.reference, registry: parsed.registry, source: file });
        continue;
      }
      if (!parsed.digest) {
        unpinned.push({ reference: entry.reference, source: file, reason: "no digest" });
        continue;
      }
      const key = `${parsed.path}@${parsed.digest}`;
      const image = byKey.get(key) ?? { path: parsed.path, digest: parsed.digest, tags: new Set(), sources: new Set() };
      if (parsed.tag) image.tags.add(parsed.tag);
      image.sources.add(file);
      byKey.set(key, image);
    }
  }
  const images = [...byKey.values()]
    .map((image) => {
      const tags = [...image.tags].sort();
      return Object.freeze({
        path: image.path,
        digest: image.digest,
        tags: Object.freeze(tags),
        mirrorTag: mirrorTag(tags[0] ?? null, image.digest),
        sources: Object.freeze([...image.sources].sort()),
      });
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.mirrorTag.localeCompare(b.mirrorTag));
  const dedupe = (list) => [...new Map(list.map((item) => [`${item.source}\n${item.reference}`, item])).values()];
  return { images, unpinned: dedupe(unpinned), skipped: dedupe(skipped) };
}

/** Read the tracked Dockerfiles and workflows of a checkout and discover their Docker Hub images. */
export function discoverRepositoryImages(root, { execute = spawnSync } = {}) {
  const listed = execute("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!listed || listed.error || listed.status !== 0) throw new Error("git ls-files failed; run from a git checkout");
  const tracked = listed.stdout.split("\0").filter(Boolean);
  const files = {};
  for (const file of [...trackedDockerfiles(tracked), ...workflowFiles(tracked)]) {
    files[file] = fs.readFileSync(path.join(root, file), "utf8");
  }
  return discoverDockerHubImages(files);
}

// --- Mirror state --------------------------------------------------------------

/**
 * Anonymous read of what GHCR serves for one image: the manifest by digest,
 * the immutable tag and, for an index, every child manifest. GHCR lists each
 * child of an index as its own untagged package version, so an index can
 * outlive a child that a by-digest pull then misses.
 */
export async function inspectMirror(image, { read = fetchManifest } = {}) {
  const manifest = await read(mirrorDigestRef(image));
  if (!manifest.ok || manifest.digest !== image.digest) return { manifest, complete: false, gaps: ["manifest"] };
  const gaps = [];
  const tag = await read(mirrorTagRef(image));
  if (!tag.ok || tag.digest !== image.digest) gaps.push(`tag ${image.mirrorTag}`);
  const children = childDigests(manifest.bytes);
  if (children === null) gaps.push("a readable manifest");
  for (const child of children ?? []) {
    const result = await read(`${DOCKER_HUB_MIRROR}/${image.path}@${child}`);
    if (!result.ok || result.digest !== child) gaps.push(`child manifest ${child}`);
  }
  return { manifest, complete: gaps.length === 0, gaps };
}

// --- BuildKit image ----------------------------------------------------------------

/**
 * The image a docker-container builder should run: the GHCR copy of the
 * pinned BuildKit digest when GHCR serves it (and, for an index, every child)
 * anonymously, else the same digest from Docker Hub. Any error or timeout
 * selects Docker Hub; only an invalid input throws.
 */
export async function resolveBuildkitImage(
  reference,
  { read = fetchManifest, requestTimeoutMs = 15_000, budgetMs = 60_000, log = console.log } = {},
) {
  const parsed = parseImageReference(reference);
  if (!parsed?.dockerHub || parsed.path !== "moby/buildkit" || !parsed.digest) {
    throw new Error(`BUILDKIT_IMAGE must be a digest-pinned moby/buildkit reference, got: ${reference}`);
  }
  const fallback = `moby/buildkit@${parsed.digest}`;
  const mirrored = `${DOCKER_HUB_MIRROR}/moby/buildkit@${parsed.digest}`;
  const check = async () => {
    const manifest = await read(mirrored, { timeoutMs: requestTimeoutMs });
    if (!manifest.ok) return `${manifest.stage} ${manifest.status}`;
    if (manifest.digest !== parsed.digest) return "digest mismatch";
    const children = childDigests(manifest.bytes);
    if (children === null) return "unreadable manifest";
    for (const child of children) {
      const result = await read(`${DOCKER_HUB_MIRROR}/moby/buildkit@${child}`, { timeoutMs: requestTimeoutMs });
      if (!result.ok || result.digest !== child) return `child manifest ${child} missing`;
    }
    return null;
  };
  let timer;
  try {
    const gap = await Promise.race([
      check(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(`no answer within ${budgetMs / 1000}s`), budgetMs);
      }),
    ]);
    if (gap === null) {
      log(`Using the GHCR mirror ${mirrored}.`);
      return mirrored;
    }
    log(`GHCR does not serve ${mirrored} anonymously (${gap}); using Docker Hub.`);
  } catch (error) {
    log(`Could not check the GHCR mirror (${error instanceof Error ? error.message : String(error)}); using Docker Hub.`);
  } finally {
    clearTimeout(timer);
  }
  return fallback;
}
