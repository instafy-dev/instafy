import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUILDKITD_MIRROR_CONFIG,
  DOCKER_HUB_MIRROR,
  discoverDockerHubImages,
  discoverRepositoryImages,
  dockerfileReferences,
  inspectMirror,
  mirrorDigestRef,
  mirrorTag,
  mirrorTagRef,
  parseImageReference,
  resolveBuildkitImage,
  sourceDigestRef,
  trackedDockerfiles,
  workflowReferences,
} from "./dockerHubImageMirror.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (char) => `sha256:${char.repeat(64)}`;
const quiet = () => {};

test("references normalize exactly like BuildKit's docker.io mirror mapping", () => {
  assert.deepEqual(parseImageReference(`rust:1.88@${digest("a")}`),
    { registry: "docker.io", dockerHub: true, path: "library/rust", tag: "1.88", digest: digest("a") });
  assert.deepEqual(parseImageReference(`docker.io/library/debian:trixie-slim@${digest("b")}`),
    { registry: "docker.io", dockerHub: true, path: "library/debian", tag: "trixie-slim", digest: digest("b") });
  assert.deepEqual(parseImageReference(`index.docker.io/moby/buildkit@${digest("c")}`),
    { registry: "docker.io", dockerHub: true, path: "moby/buildkit", tag: null, digest: digest("c") });
  assert.deepEqual(parseImageReference("docker/dockerfile:1.7"),
    { registry: "docker.io", dockerHub: true, path: "docker/dockerfile", tag: "1.7", digest: null });
  for (const [reference, registry] of [
    [`mcr.microsoft.com/playwright:v1.61.1-noble@${digest("d")}`, "mcr.microsoft.com"],
    [`ghcr.io/instafy-dev/supabase/postgres@${digest("e")}`, "ghcr.io"],
    [`public.ecr.aws/supabase/postgres:17@${digest("f")}`, "public.ecr.aws"],
    ["localhost/app:dev", "localhost"],
    ["registry.local:5000/team/app", "registry.local:5000"],
  ]) {
    const parsed = parseImageReference(reference);
    assert.equal(parsed.dockerHub, false, reference);
    assert.equal(parsed.registry, registry, reference);
  }
  for (const invalid of ["", "${RUST_IMAGE}", "Rust:1", "rust@sha256:abc", "rust:bad tag", "rust:-x"]) {
    assert.equal(parseImageReference(invalid), null, invalid);
  }
  const image = { path: "library/node", digest: digest("1"), mirrorTag: "24-bookworm-slim-111111111111" };
  assert.equal(mirrorDigestRef(image), `ghcr.io/instafy-dev/dockerhub/library/node@${digest("1")}`);
  assert.equal(mirrorTagRef(image), "ghcr.io/instafy-dev/dockerhub/library/node:24-bookworm-slim-111111111111");
  assert.equal(sourceDigestRef(image), `docker.io/library/node@${digest("1")}`);
  assert.equal(DOCKER_HUB_MIRROR, "ghcr.io/instafy-dev/dockerhub");
  assert.equal(BUILDKITD_MIRROR_CONFIG, '[registry."docker.io"]\nmirrors = ["ghcr.io/instafy-dev/dockerhub"]\n');
});

test("mirror tags are immutable per digest and always valid OCI tags", () => {
  const node = "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
  assert.equal(mirrorTag("24-bookworm-slim", node), "24-bookworm-slim-6f7b03f7c2c8");
  assert.equal(mirrorTag(null, node), "pinned-6f7b03f7c2c8");
  assert.equal(mirrorTag("not a tag", node), "pinned-6f7b03f7c2c8");
  const long = mirrorTag("x".repeat(128), node);
  assert.equal(long.length, 128);
  assert.ok(long.endsWith("-6f7b03f7c2c8"));
  for (const tag of ["24-bookworm-slim-6f7b03f7c2c8", "pinned-6f7b03f7c2c8", long, mirrorTag("_1.2", node)]) {
    assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u);
  }
  assert.notEqual(mirrorTag("1.88", digest("a")), mirrorTag("1.88", digest("b")));
  assert.throws(() => mirrorTag("1.88", "sha256:abc"), /not a sha256 digest/u);
});

test("Dockerfile parsing resolves ARG defaults and skips stages, scratch and other registries", () => {
  const source = [
    `# syntax=docker/dockerfile:1.7@${digest("1")}`,
    "ARG RUST_TOOLCHAIN=1.95.0",
    `ARG RUST_IMAGE=rust:\${RUST_TOOLCHAIN}-slim-bookworm@${digest("2")}`,
    `ARG RUNTIME_BASE="debian:trixie-slim@${digest("3")}"`,
    "ARG UNSET_IMAGE",
    "ARG PCRE2_MIN_VERSION=10.46-1~deb13u2",
    "FROM ${RUST_IMAGE} AS chef",
    "ARG CARGO_CHEF_VERSION=0.1.77",
    "FROM chef AS builder",
    `FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@${digest("4")} AS node-runtime`,
    `COPY --from=busybox:1.37@${digest("5")} /bin/busybox /busybox`,
    "COPY --from=builder /out /out",
    "COPY --from=0 /out /out",
    "FROM scratch AS export",
    `FROM mcr.microsoft.com/playwright:v1.61.1-noble@${digest("6")} AS webdev`,
    "FROM ${UNSET_IMAGE} AS broken",
    "FROM alpine:3.23 AS floating",
    "FROM \\",
    `  \${RUNTIME_BASE} AS runtime`,
  ].join("\n");
  const found = dockerfileReferences(source).map(({ kind, reference, resolved }) => [kind, reference, resolved]);
  assert.deepEqual(found, [
    ["syntax", `docker/dockerfile:1.7@${digest("1")}`, true],
    ["arg", `rust:1.95.0-slim-bookworm@${digest("2")}`, true],
    ["arg", `debian:trixie-slim@${digest("3")}`, true],
    ["from", `rust:1.95.0-slim-bookworm@${digest("2")}`, true],
    ["from", `node:24-bookworm-slim@${digest("4")}`, true],
    ["copy-from", `busybox:1.37@${digest("5")}`, true],
    ["from", `mcr.microsoft.com/playwright:v1.61.1-noble@${digest("6")}`, true],
    ["from", "${UNSET_IMAGE}", false],
    ["from", "alpine:3.23", true],
    ["from", `debian:trixie-slim@${digest("3")}`, true],
  ]);

  const { images, unpinned, skipped } = discoverDockerHubImages({ "a/Dockerfile": source });
  assert.deepEqual(images.map((image) => [image.path, image.digest, image.mirrorTag]), [
    ["docker/dockerfile", digest("1"), `1.7-${"1".repeat(12)}`],
    ["library/busybox", digest("5"), `1.37-${"5".repeat(12)}`],
    ["library/debian", digest("3"), `trixie-slim-${"3".repeat(12)}`],
    ["library/node", digest("4"), `24-bookworm-slim-${"4".repeat(12)}`],
    ["library/rust", digest("2"), `1.95.0-slim-bookworm-${"2".repeat(12)}`],
  ]);
  assert.deepEqual(unpinned, [
    { reference: "${UNSET_IMAGE}", source: "a/Dockerfile", reason: "unresolved build argument" },
    { reference: "alpine:3.23", source: "a/Dockerfile", reason: "no digest" },
  ]);
  assert.deepEqual(skipped, [{ reference: `mcr.microsoft.com/playwright:v1.61.1-noble@${digest("6")}`,
    registry: "mcr.microsoft.com", source: "a/Dockerfile" }]);
});

test("images are deduplicated by path and digest across files and spellings", () => {
  const { images } = discoverDockerHubImages({
    "b/Dockerfile": `FROM rust:1.88@${digest("a")}\nFROM docker.io/library/rust:1.88.0@${digest("a")}\n`,
    "a/Dockerfile": `FROM library/rust@${digest("a")}\nFROM rust:1.88@${digest("b")}\n`,
    ".github/workflows/x.yml": `driver-opts: image=moby/buildkit@${digest("c")}\nimage: moby/buildkit:v0.33.1@${digest("c")}\n`,
  });
  assert.deepEqual(images.map((image) => ({ ...image })), [
    { path: "library/rust", digest: digest("a"), tags: ["1.88", "1.88.0"], mirrorTag: `1.88-${"a".repeat(12)}`,
      sources: ["a/Dockerfile", "b/Dockerfile"] },
    { path: "library/rust", digest: digest("b"), tags: ["1.88"], mirrorTag: `1.88-${"b".repeat(12)}`, sources: ["a/Dockerfile"] },
    { path: "moby/buildkit", digest: digest("c"), tags: ["v0.33.1"], mirrorTag: `v0.33.1-${"c".repeat(12)}`,
      sources: [".github/workflows/x.yml"] },
  ]);
});

test("workflow discovery takes BuildKit pins only, and reports a tag without a digest", () => {
  const source = [
    "# moby/buildkit is pulled by dockerd",
    `BUILDKIT_IMAGE: \${{ a && 'moby/buildkit@${digest("1")}' || 'moby/buildkit@${digest("2")}' }}`,
    `image: ghcr.io/instafy-dev/dockerhub/moby/buildkit@${digest("3")}`,
    "driver-opts: image=moby/buildkit:buildx-stable-1",
    `image: docker.io/moby/buildkit@${digest("4")}`,
    `uses: docker://alpine@${digest("5")}`,
  ].join("\n");
  assert.deepEqual(workflowReferences(source).map((entry) => entry.reference), [
    `moby/buildkit@${digest("1")}`, `moby/buildkit@${digest("2")}`, "moby/buildkit:buildx-stable-1",
    `docker.io/moby/buildkit@${digest("4")}`,
  ]);
  const { images, unpinned } = discoverDockerHubImages({ ".github/workflows/x.yml": source });
  assert.deepEqual(images.map((image) => image.digest), [digest("1"), digest("2"), digest("4")]);
  assert.deepEqual(unpinned, [{ reference: "moby/buildkit:buildx-stable-1", source: ".github/workflows/x.yml", reason: "no digest" }]);
});

test("the codex submodule and non-Dockerfiles are never scanned", () => {
  assert.deepEqual(trackedDockerfiles([
    "codex", "codex/Dockerfile", "codex/sub/Dockerfile", "docker/runtime/Dockerfile", "a/Dockerfile.dev",
    "b/app.Dockerfile", "docs/Dockerfile.md.txt", "Dockerfile", "docker/README.md", "x/Dockerfiles/readme",
  ]), ["Dockerfile", "a/Dockerfile.dev", "b/app.Dockerfile", "docker/runtime/Dockerfile", "docs/Dockerfile.md.txt"]);
});

test("discovery over this repository finds every Docker Hub base and BuildKit pin", () => {
  const { images, unpinned, skipped } = discoverRepositoryImages(root);
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
  const dockerfiles = trackedDockerfiles(listed);
  assert.ok(dockerfiles.includes("docker/runtime/Dockerfile"));
  assert.ok(dockerfiles.every((file) => !file.startsWith("codex/")));
  // Every pinned FROM in every Dockerfile is either mirrored or a non-Docker-Hub registry.
  const keys = new Set(images.map((image) => `${image.path}@${image.digest}`));
  for (const file of dockerfiles) {
    for (const entry of dockerfileReferences(fs.readFileSync(path.join(root, file), "utf8"))) {
      const parsed = parseImageReference(entry.reference);
      assert.ok(parsed?.digest, `${file}: ${entry.reference} is pinned by digest`);
      if (parsed.dockerHub) assert.ok(keys.has(`${parsed.path}@${parsed.digest}`), `${file}: ${entry.reference}`);
      else assert.ok(skipped.some((item) => item.reference === entry.reference && item.source === file), entry.reference);
    }
  }
  assert.deepEqual(unpinned, []);
  assert.ok(images.every((image) => image.sources.every((source) => !source.startsWith("codex/"))));
  assert.equal(new Set(images.map((image) => `${image.path}@${image.digest}`)).size, images.length);
  assert.equal(new Set(images.map((image) => `${image.path}:${image.mirrorTag}`)).size, images.length);
  // The bases named in the change that introduced the mirror.
  const paths = new Set(images.map((image) => image.path));
  for (const expected of ["library/rust", "library/debian", "library/node", "library/golang", "library/alpine",
    "docker/dockerfile", "moby/buildkit"]) {
    assert.ok(paths.has(expected), expected);
  }
  const node = images.find((image) => image.digest === "sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d");
  assert.equal(node.path, "library/node");
  assert.equal(node.mirrorTag, "24-bookworm-slim-6f7b03f7c2c8");
  // ARG-built tags resolve: rust:${RUST_TOOLCHAIN}-slim-bookworm@...
  assert.ok(images.some((image) => image.path === "library/rust" && /^1\.\d+\.\d+-slim-bookworm-[0-9a-f]{12}$/u.test(image.mirrorTag)));
  // Both BuildKit pins: the self-hosted amd64 image and the hosted index.
  const buildkit = images.filter((image) => image.path === "moby/buildkit").map((image) => image.digest).sort();
  assert.deepEqual(buildkit, [
    "sha256:040d34121c27906c4ff9ac152a30d52bf2c5d328d3bb748916bb3d2743c02528",
    "sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea",
  ]);
  assert.deepEqual(skipped.map((item) => item.registry), ["mcr.microsoft.com"]);
});

// A registry fake keyed by reference. Values are manifest results as fetchManifest returns them.
function registry(entries = {}) {
  const reads = [];
  const read = async (reference, options) => {
    reads.push({ reference, options });
    const value = entries[reference];
    if (typeof value === "function") return value();
    return value ?? { ok: false, status: 404, stage: "manifest" };
  };
  return { read, reads };
}
const manifest = (value, children) => ({
  ok: true, status: 200, digest: value, mediaType: "application/vnd.oci.image.index.v1+json",
  bytes: Buffer.from(JSON.stringify(children ? { schemaVersion: 2, manifests: children.map((child) => ({ digest: child })) }
    : { schemaVersion: 2, config: {}, layers: [] })),
});
const buildkit = (value) => `${DOCKER_HUB_MIRROR}/moby/buildkit@${value}`;

test("inspectMirror requires the digest, the immutable tag and every child manifest", async () => {
  const image = { path: "library/rust", digest: digest("a"), mirrorTag: "1.88-aaaaaaaaaaaa" };
  const children = [digest("1"), digest("2")];
  const full = {
    [mirrorDigestRef(image)]: manifest(image.digest, children),
    [mirrorTagRef(image)]: manifest(image.digest, children),
    [`${DOCKER_HUB_MIRROR}/library/rust@${digest("1")}`]: manifest(digest("1")),
    [`${DOCKER_HUB_MIRROR}/library/rust@${digest("2")}`]: manifest(digest("2")),
  };
  assert.deepEqual((await inspectMirror(image, { read: registry(full).read })).gaps, []);
  const { [`${DOCKER_HUB_MIRROR}/library/rust@${digest("2")}`]: _child, ...missingChild } = full;
  assert.deepEqual((await inspectMirror(image, { read: registry(missingChild).read })).gaps, [`child manifest ${digest("2")}`]);
  const { [mirrorTagRef(image)]: _tag, ...missingTag } = full;
  assert.deepEqual((await inspectMirror(image, { read: registry(missingTag).read })).gaps, ["tag 1.88-aaaaaaaaaaaa"]);
  const wrong = { ...full, [mirrorDigestRef(image)]: manifest(digest("f"), children) };
  const result = await inspectMirror(image, { read: registry(wrong).read });
  assert.equal(result.complete, false);
  assert.deepEqual(result.gaps, ["manifest"]);
});

test("the BuildKit resolver uses GHCR only when it serves the digest and every child anonymously", async () => {
  const index = "sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
  const single = "sha256:040d34121c27906c4ff9ac152a30d52bf2c5d328d3bb748916bb3d2743c02528";
  const children = [digest("1"), digest("2")];
  const served = {
    [buildkit(index)]: manifest(index, children),
    [buildkit(digest("1"))]: manifest(digest("1")),
    [buildkit(digest("2"))]: manifest(digest("2")),
    [buildkit(single)]: manifest(single),
  };
  const fake = registry(served);
  assert.equal(await resolveBuildkitImage(`moby/buildkit@${index}`, { read: fake.read, log: quiet }), buildkit(index));
  assert.ok(fake.reads.every(({ reference, options }) => reference.startsWith(`${DOCKER_HUB_MIRROR}/`) && options.timeoutMs > 0));
  assert.equal(await resolveBuildkitImage(`moby/buildkit@${single}`, { read: registry(served).read, log: quiet }), buildkit(single));
  assert.equal(await resolveBuildkitImage(`docker.io/moby/buildkit@${single}`, { read: registry(served).read, log: quiet }), buildkit(single));

  const fallbacks = {
    absent: {},
    private: { [buildkit(index)]: { ok: false, status: 403, stage: "token" } },
    "rate limited": { [buildkit(index)]: { ok: false, status: 429, stage: "manifest" } },
    offline: { [buildkit(index)]: { ok: false, status: 0, stage: "network", code: "TimeoutError" } },
    "wrong bytes": { [buildkit(index)]: manifest(digest("f"), children) },
    "missing child": { ...served, [buildkit(digest("2"))]: undefined },
    unreadable: { [buildkit(index)]: { ...manifest(index), bytes: Buffer.from("not json") } },
    thrown: { [buildkit(index)]: () => { throw new Error("socket hang up"); } },
  };
  for (const [name, entries] of Object.entries(fallbacks)) {
    const logs = [];
    assert.equal(await resolveBuildkitImage(`moby/buildkit@${index}`, { read: registry(entries).read, log: (line) => logs.push(line) }),
      `moby/buildkit@${index}`, name);
    assert.match(logs.join("\n"), /using Docker Hub/u, name);
  }

  // A read that never answers falls back at the overall budget.
  const started = Date.now();
  const hung = registry({ [buildkit(index)]: () => new Promise(() => {}) });
  assert.equal(await resolveBuildkitImage(`moby/buildkit@${index}`, { read: hung.read, budgetMs: 50, log: quiet }), `moby/buildkit@${index}`);
  assert.ok(Date.now() - started < 5_000);

  for (const invalid of ["", "moby/buildkit:buildx-stable-1", `ghcr.io/instafy-dev/dockerhub/moby/buildkit@${index}`,
    `library/alpine@${index}`, "moby/buildkit@sha256:abc"]) {
    await assert.rejects(resolveBuildkitImage(invalid, { read: registry(served).read, log: quiet }), /BUILDKIT_IMAGE/u, invalid);
  }
});
