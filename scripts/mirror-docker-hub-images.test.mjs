import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COPY_ATTEMPTS,
  mirrorImages,
  packageSettingsUrl,
  planMirror,
  summaryMarkdown,
  verifyMirror,
} from "./mirror-docker-hub-images.mjs";
import {
  DOCKER_HUB_MIRROR,
  discoverRepositoryImages,
  mirrorDigestRef,
  mirrorTagRef,
  sourceDigestRef,
} from "./lib/dockerHubImageMirror.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/mirror-docker-hub-images.yml";
const workflow = fs.readFileSync(path.join(root, workflowPath), "utf8");
const quiet = () => {};
const noSleep = async () => {};
const digest = (char) => `sha256:${char.repeat(64)}`;

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing step ${name}`);
  const end = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

// GitHub's paths filter, for the globs this workflow uses: ** spans
// directories (including none), * stays within one path segment.
function filtered(file) {
  const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\n  schedule:"));
  return [...triggers.matchAll(/^ {6}- "([^"]+)"$/gmu)].map((match) => match[1]).some((pattern) => {
    const source = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*\*\//gu, "\u0000").replace(/\*/gu, "[^/]*").replace(/\u0000/gu, "(?:.*/)?");
    return new RegExp(`^${source}$`, "u").test(file);
  });
}

test("the mirror workflow runs only from protected main and never for pull requests", () => {
  const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  assert.deepEqual([...triggers.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]), ["push", "schedule", "workflow_dispatch"]);
  assert.doesNotMatch(workflow, /pull_request|workflow_run|repository_dispatch|workflow_call/u);
  assert.match(triggers, /\n {2}push:\n {4}branches:\n {6}- main\n {4}paths:\n/u);
  assert.match(workflow, /\npermissions: \{\}\n/u);
  assert.match(workflow, /\nconcurrency:\n {2}group: mirror-docker-hub-images\n {2}cancel-in-progress: false\n/u);
  const guard = workflow.slice(workflow.indexOf("    if: >-\n"), workflow.indexOf("    runs-on:"));
  for (const condition of ["github.repository == 'instafy-dev/instafy'", "github.repository_id == '1309636737'",
    "github.ref == 'refs/heads/main'", "github.ref_protected == true"]) {
    assert.ok(guard.includes(condition), condition);
  }
  assert.match(step("Bind to protected main"), /GITHUB_REF_PROTECTED" != "true"/u);
  assert.match(workflow, /\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 60\n {4}permissions:\n {6}contents: read\n {6}packages: write\n {4}steps:\n/u);
  assert.doesNotMatch(workflow, /self-hosted|environment:|id-token|contents: write|actions: write/u);
});

test("everything that decides what is mirrored retriggers the mirror on main", () => {
  const { images } = discoverRepositoryImages(root);
  const sources = new Set(images.flatMap((image) => image.sources));
  assert.ok(sources.size > 0);
  for (const source of sources) assert.ok(filtered(source), source);
  for (const file of [workflowPath, "scripts/mirror-docker-hub-images.mjs", "scripts/lib/dockerHubImageMirror.mjs",
    "scripts/lib/registryManifests.mjs", "Dockerfile", "docker/new/Dockerfile", "docker/x/Dockerfile.dev", "a/b.Dockerfile"]) {
    assert.ok(filtered(file), file);
  }
  assert.ok(!filtered("packages/frontend/src/App.tsx"));
  assert.ok(!filtered(".github/workflows/build.yml"));
  // Every workflow that pins a BuildKit image is a trigger, so a new pin is mirrored on merge.
  for (const file of fs.readdirSync(path.join(root, ".github/workflows"))) {
    const relative = `.github/workflows/${file}`;
    if (/moby\/buildkit@sha256:/u.test(fs.readFileSync(path.join(root, relative), "utf8"))) assert.ok(filtered(relative), relative);
  }
  // No stale literal entry.
  const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\n  schedule:"));
  for (const [, pattern] of triggers.matchAll(/^ {6}- "([^"*]+)"$/gmu)) assert.ok(fs.existsSync(path.join(root, pattern)), pattern);
});

test("the workflow holds only GITHUB_TOKEN, only between the plan and the logout, and has no image list of its own", () => {
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]), ["GITHUB_TOKEN"]);
  assert.match(step("Checkout exact protected-main commit"), /persist-credentials: false\n {10}ref: \$\{\{ github\.sha \}\}/u);
  // The same action pins as the Supabase mirror, and the docker driver: no BuildKit image to pull.
  const supabase = fs.readFileSync(path.join(root, ".github/workflows/mirror-supabase-images.yml"), "utf8");
  const pins = (source) => [...source.matchAll(/^\s+uses: (\S+)/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(pins(workflow), pins(supabase));
  assert.match(step("Set up Docker Buildx"), /\n {8}with:\n {10}version: v0\.35\.0\n {10}driver: docker\n/u);
  assert.match(step("Login to GHCR"), /if: steps\.plan\.outputs\.missing != '0'\n {8}uses: docker\/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3\n {8}with:\n {10}registry: ghcr\.io\n {10}username: \$\{\{ github\.actor \}\}\n {10}password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(step("Copy exact digests to GHCR"), /if: steps\.plan\.outputs\.missing != '0'/u);
  assert.match(step("Log out of GHCR"), /if: always\(\)\n {8}run: docker logout ghcr\.io/u);
  const order = ["Bind to protected main", "Checkout exact protected-main commit", "Set up Node.js", "Set up Docker Buildx",
    "Plan the copy from the repository", "Login to GHCR", "Copy exact digests to GHCR", "Log out of GHCR",
    "Verify anonymous pulls by digest"];
  const positions = order.map((name) => workflow.indexOf(`      - name: ${name}\n`));
  assert.ok(positions.every((position) => position > 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.doesNotMatch(workflow, /sha256:|docker\.io\/|@sha|imagetools/u);
  assert.deepEqual([...workflow.matchAll(/^ {8}run: (node .*)$/gmu)].map((match) => match[1]), [
    "node scripts/mirror-docker-hub-images.mjs plan",
    "node scripts/mirror-docker-hub-images.mjs mirror",
    "node scripts/mirror-docker-hub-images.mjs verify",
  ]);
});

// A registry fake keyed by reference. Values are manifest results as fetchManifest returns them.
function registry(entries = {}) {
  const reads = [];
  const read = async (reference) => {
    reads.push(reference);
    const value = entries[reference];
    const next = Array.isArray(value) ? value.shift() : value;
    return next ?? { ok: false, status: 404, stage: "manifest" };
  };
  return { read, reads, entries };
}
const served = (value, children) => ({
  ok: true, status: 200, digest: value, mediaType: "application/vnd.oci.image.index.v1+json",
  bytes: Buffer.from(JSON.stringify(children ? { schemaVersion: 2, manifests: children.map((child) => ({ digest: child })) }
    : { schemaVersion: 2, config: {}, layers: [] })),
});
const rust = { path: "library/rust", digest: digest("a"), tags: ["1.88"], mirrorTag: "1.88-aaaaaaaaaaaa", sources: ["a/Dockerfile"] };
const buildkit = { path: "moby/buildkit", digest: digest("b"), tags: [], mirrorTag: "pinned-bbbbbbbbbbbb", sources: [".github/workflows/x.yml"] };
const rustChildren = [digest("1"), digest("2")];
const complete = (image, children) => ({
  [mirrorDigestRef(image)]: served(image.digest, children),
  [mirrorTagRef(image)]: served(image.digest, children),
  ...Object.fromEntries((children ?? []).map((child) => [`${DOCKER_HUB_MIRROR}/${image.path}@${child}`, served(child)])),
});

test("planning copies only what GHCR does not fully serve anonymously", async () => {
  const entries = { ...complete(rust, rustChildren), ...complete(buildkit) };
  delete entries[`${DOCKER_HUB_MIRROR}/library/rust@${digest("2")}`];
  const logs = [];
  const plan = await planMirror([rust, buildkit], { read: registry(entries).read, sleep: noSleep, log: (line) => logs.push(line) });
  assert.deepEqual(plan.present, [buildkit]);
  assert.deepEqual(plan.missing, [rust]);
  assert.match(logs.join("\n"), /library\/rust: GHCR serves .* but not its child manifest sha256:2{64}; copying it again/u);
  // Plan reads only the mirror, never Docker Hub.
  const fake = registry({});
  assert.deepEqual((await planMirror([rust, buildkit], { read: fake.read, sleep: noSleep, log: quiet })).missing, [rust, buildkit]);
  assert.ok(fake.reads.every((reference) => reference.startsWith(`${DOCKER_HUB_MIRROR}/`)));
});

test("planning retries a GHCR outage with backoff, then stops retrying", async () => {
  const outage = { ok: false, status: 503, stage: "manifest" };
  const fake = registry({ [mirrorDigestRef(rust)]: outage, [mirrorDigestRef(buildkit)]: outage });
  const waits = [];
  const plan = await planMirror([rust, buildkit], { read: fake.read, sleep: async (ms) => waits.push(ms), log: quiet });
  assert.deepEqual(plan.missing, [rust, buildkit]);
  assert.deepEqual(fake.reads, [...Array(4).fill(mirrorDigestRef(rust)), mirrorDigestRef(buildkit)]);
  assert.equal(waits.length, 3);
});

function executor(onCreate) {
  const calls = [];
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    return onCreate(args, calls.length);
  };
  return { execute, calls };
}

test("mirroring copies by digest without re-wrapping a single manifest, then proves the copy anonymously", async () => {
  const fake = registry(complete(buildkit));
  const target = registry({});
  // GHCR serves rust only after the copy, and its tag only on a later read.
  const { execute, calls } = executor((args) => {
    Object.assign(target.entries, complete(rust, rustChildren));
    target.entries[mirrorTagRef(rust)] = [{ ok: false, status: 404, stage: "manifest" }, served(rust.digest, rustChildren)];
    return { status: 0, stdout: "", stderr: "" };
  });
  const read = async (reference) => (reference.includes("moby/buildkit") ? fake.read(reference) : target.read(reference));
  const results = await mirrorImages([rust, buildkit], { execute, read, sleep: noSleep, log: quiet });
  assert.deepEqual(results.map((result) => [result.image.path, result.state]), [["library/rust", "mirrored"], ["moby/buildkit", "present"]]);
  assert.deepEqual(calls.map((call) => [call.binary, ...call.args]), [
    ["docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag",
      `${DOCKER_HUB_MIRROR}/library/rust:1.88-aaaaaaaaaaaa`, `docker.io/library/rust@${digest("a")}`],
  ]);
  assert.equal(sourceDigestRef(rust), `docker.io/library/rust@${digest("a")}`);
  assert.ok(calls[0].options.timeout > 0);
});

test("a Docker Hub rate limit is retried with backoff; a copy that never lands fails that image only", async () => {
  const waits = [];
  const target = registry({});
  const { execute, calls } = executor((args, count) => {
    if (args.at(-1).includes("moby/buildkit")) {
      // GHCR accepted the write but serves a different digest: never accepted.
      target.entries[mirrorDigestRef(buildkit)] = served(digest("f"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (count < COPY_ATTEMPTS) return { status: 1, stderr: "429 Too Many Requests" };
    Object.assign(target.entries, complete(rust, rustChildren));
    return { status: 0, stdout: "", stderr: "" };
  });
  const logs = [];
  const results = await mirrorImages([rust, buildkit], { execute, read: target.read, sleep: async (ms) => waits.push(ms), log: (line) => logs.push(line) });
  assert.deepEqual(results.map((result) => result.state), ["mirrored", "not anonymously served"]);
  assert.equal(calls.length, COPY_ATTEMPTS + 1);
  assert.ok(waits.slice(0, COPY_ATTEMPTS - 1).every((ms) => ms >= 30_000));
  assert.match(logs.join("\n"), /429 Too Many Requests/u);
  assert.match(logs.join("\n"), /::error::moby\/buildkit: after the copy GHCR does not serve its manifest anonymously/u);

  const failing = executor(() => ({ status: 1, stderr: "toomanyrequests" }));
  const failed = await mirrorImages([rust], { execute: failing.execute, read: registry({}).read, sleep: noSleep, log: quiet });
  assert.deepEqual(failed.map((result) => result.state), ["copy failed"]);
  assert.equal(failing.calls.length, COPY_ATTEMPTS);
});

test("verification reports private, missing and incomplete packages with an actionable fix", async () => {
  const debian = { ...rust, path: "library/debian", digest: digest("c"), mirrorTag: "trixie-slim-cccccccccccc" };
  const entries = {
    ...complete(rust, rustChildren),
    [mirrorDigestRef(buildkit)]: { ok: false, status: 403, stage: "token" },
    ...complete(debian),
  };
  delete entries[mirrorTagRef(debian)];
  const { problems, rows } = await verifyMirror([rust, buildkit, debian], { read: registry(entries).read, sleep: noSleep, log: quiet });
  assert.deepEqual(rows.map((row) => row.state), ["ok", "not public or missing", "incomplete"]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /set the package visibility to Public: https:\/\/github\.com\/orgs\/instafy-dev\/packages\/container\/dockerhub%2Fmoby%2Fbuildkit\/settings/u);
  assert.match(problems[1], /library\/debian@sha256:c{64}: GHCR does not serve its tag trixie-slim-cccccccccccc anonymously/u);
  assert.equal(packageSettingsUrl("library/rust"), "https://github.com/orgs/instafy-dev/packages/container/dockerhub%2Flibrary%2Frust/settings");
});

test("the job summary lists every image with its state, unpinned references and skipped registries", () => {
  const markdown = summaryMarkdown("Docker Hub image mirror plan", [{ image: rust, state: "present" }, { image: buildkit, state: "to copy" }], {
    unpinned: [{ reference: "alpine:3.23", source: "x/Dockerfile", reason: "no digest" }],
    skipped: [{ reference: `mcr.microsoft.com/playwright@${digest("d")}`, registry: "mcr.microsoft.com", source: "y/Dockerfile" }],
  });
  assert.match(markdown, /^### Docker Hub image mirror plan$/mu);
  assert.match(markdown, /^\| library\/rust \| `1\.88-aaaaaaaaaaaa` \| `sha256:aaaaaaaaaaaa` \| a\/Dockerfile \| present \|$/mu);
  assert.match(markdown, /^\| moby\/buildkit \| `pinned-bbbbbbbbbbbb` \| `sha256:bbbbbbbbbbbb` \| \.github\/workflows\/x\.yml \| to copy \|$/mu);
  assert.match(markdown, /^- `alpine:3\.23` in x\/Dockerfile \(no digest\)$/mu);
  assert.match(markdown, /^- `mcr\.microsoft\.com\/playwright@sha256:d{64}` in y\/Dockerfile$/mu);
});
