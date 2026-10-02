import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Runs the real Bash of the runtime publishers' sealing steps against inert
// stubs: the amd64 production release (publish-runtime-agent.yml) and the
// best-effort arm64 lane (publish-runtime-agent-multiarch.yml). Every gh,
// docker, trivy and sleep call is answered from a fixture; nothing reaches
// GitHub or a registry.

const root = path.resolve(import.meta.dirname, "..");
const workflow = (name) => fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");
const production = workflow("publish-runtime-agent.yml");
const multiarch = workflow("publish-runtime-agent-multiarch.yml");
const sha = "a".repeat(40);
const repo = "instafy-dev/instafy";
const image = "ghcr.io/instafy-dev/instafy-runtime-agent";
const digest = (char) => `sha256:${char.repeat(64)}`;
const ref = (char) => `${image}@${digest(char)}`;
const refs = { baseAmd64: ref("1"), webdevAmd64: ref("2"), baseArm64: ref("3"), webdevArm64: ref("4") };

function stepText(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing step ${name}`);
  assert.equal(source.indexOf(`      - name: ${name}\n`, start + 1), -1, `repeated step ${name}`);
  const next = source.slice(start + 1).search(/\n(?:      - |  [\w-]+:\n)/u);
  return next < 0 ? source.slice(start) : source.slice(start, start + next + 2);
}
function script(source, name) {
  const text = stepText(source, name);
  const match = text.match(/^        run: \|\n((?:(?: {10}.*)?\n)+)/mu);
  assert.ok(match, `${name} has a run block`);
  return match[1].replace(/^ {10}/gmu, "");
}
// The step's literal env values; expression values must be supplied by the test.
function literalEnv(source, name) {
  const block = stepText(source, name).match(/^        env:\n((?: {10}[A-Z0-9_]+: .*\n)+)/mu)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/^ {10}([A-Z0-9_]+): (.*)$/gmu)]
    .filter(([, , value]) => !value.includes("${{")).map(([, key, value]) => [key, value.replace(/^"(.*)"$/u, "$1")]));
}

const stubs = {
  // gh api: exact endpoint fixtures; { file } answers with that file's bytes.
  gh: `const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args.find((value) => value.startsWith("repos/"));
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify({ tool: "gh", args }) + "\\n");
const fixture = JSON.parse(fs.readFileSync(process.env.STUB_FIXTURE, "utf8")).gh ?? {};
if (!Object.hasOwn(fixture, endpoint) || fixture[endpoint]?.error) process.exit(19);
const value = fixture[endpoint];
if (value?.file) process.stdout.write(fs.readFileSync(value.file));
else process.stdout.write(JSON.stringify(value));
`,
  // docker buildx imagetools inspect/create against fixture manifests.
  docker: `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify({ tool: "docker", args }) + "\\n");
const fixture = JSON.parse(fs.readFileSync(process.env.STUB_FIXTURE, "utf8")).docker ?? {};
if (args[0] !== "buildx" || args[1] !== "imagetools") process.exit(30);
if (args[2] === "inspect") {
  const entry = (fixture.refs ?? {})[args[3]];
  if (!entry) process.exit(31);
  if (args[4] === "--raw" && args.length === 5) { process.stdout.write(JSON.stringify(entry.raw)); process.exit(0); }
  if (args[4] === "--format" && args[5] === "{{json .Image}}" && args.length === 6) { process.stdout.write(JSON.stringify(entry.image)); process.exit(0); }
  process.exit(32);
}
if (args[2] === "create") {
  const tag = args[args.indexOf("--tag") + 1];
  const metadata = args.indexOf("--metadata-file");
  if (metadata >= 0) {
    const created = (fixture.created ?? {})[tag];
    if (!created) process.exit(33);
    fs.writeFileSync(args[metadata + 1], JSON.stringify({ "containerimage.descriptor": { digest: created } }));
  }
  process.exit(0);
}
process.exit(34);
`,
  // trivy records its arguments and the Docker config it would authenticate with.
  trivy: `const fs = require("node:fs");
const config = process.env.DOCKER_CONFIG;
const configFiles = config && fs.existsSync(config) ? fs.readdirSync(config) : null;
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify({ tool: "trivy", args: process.argv.slice(2), config, configFiles }) + "\\n");
process.exit(Number(process.env.STUB_TRIVY_STATUS ?? 0));
`,
  sleep: "",
};

function runStep(source, name, { env = {}, fixture = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-lane-step-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const [tool, body] of Object.entries(stubs)) {
      fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\n${body}`, { mode: 0o700 });
    }
    const temp = path.join(dir, "runner-temp");
    fs.mkdirSync(temp);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(temp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const resolve = (value) => (typeof value === "string" ? value.replaceAll("$RUNNER_TEMP", temp) : value);
    const fixturePath = path.join(dir, "fixture.json");
    fs.writeFileSync(fixturePath, JSON.stringify(JSON.parse(JSON.stringify(fixture), (_, value) => resolve(value))));
    for (const file of ["calls", "output", "summary"]) fs.writeFileSync(path.join(dir, file), "");
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script(source, name)], {
      cwd: root, encoding: "utf8", timeout: 20_000,
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin`,
        HOME: dir, GH_TOKEN: "inert-fixture", GITHUB_REPOSITORY: repo, RUNNER_TEMP: temp,
        GITHUB_OUTPUT: path.join(dir, "output"), GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
        STUB_CALLS: path.join(dir, "calls"), STUB_FIXTURE: fixturePath,
        ...literalEnv(source, name), ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, resolve(value)])),
      },
    });
    const read = (file) => fs.readFileSync(path.join(dir, file), "utf8");
    const written = {};
    for (const relative of fs.readdirSync(temp, { recursive: true })) {
      const target = path.join(temp, relative);
      if (fs.statSync(target).isFile()) written[relative] = fs.readFileSync(target, "utf8");
    }
    return { ...result, temp, written, summary: read("summary"),
      output: Object.fromEntries(read("output").split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2))),
      calls: read("calls").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const ok = (result) => assert.equal(result.status, 0, result.stderr + result.stdout);
const fails = (result, pattern, label) => {
  assert.notEqual(result.status, 0, label);
  if (pattern) assert.match(result.stdout + result.stderr, pattern, label);
};

// A stored (uncompressed) zip, as GitHub serves an uploaded artifact.
function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name), body = Buffer.from(data), crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const zipDigest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const bindStep = "Require exactly one sealed production runtime manifest";
const productionRunsPath = `repos/${repo}/actions/workflows/publish-runtime-agent.yml/runs`;
function productionRun(changes = {}) {
  return { id: 3, run_attempt: 1, repository: { full_name: repo }, path: ".github/workflows/publish-runtime-agent.yml",
    event: "workflow_dispatch", head_branch: "main", head_sha: sha, status: "completed", conclusion: "success", ...changes };
}
const sealedManifest = { schemaVersion: 1, coreCommit: sha, images: { base: refs.baseAmd64, webdev: refs.webdevAmd64 } };
function bind({ runs = [productionRun()], manifest = sealedManifest, entries, artifact = {}, digestOverride } = {}) {
  const bytes = zip(entries ?? { "runtime-agent-release-manifest.json": `${JSON.stringify(manifest, null, 2)}\n` });
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-lane-zip-")), "artifact.zip");
  fs.writeFileSync(archive, bytes);
  try {
    return runStep(multiarch, bindStep, {
      env: { RELEASE_COMMIT: sha },
      fixture: { gh: {
        [productionRunsPath]: { total_count: runs.length, workflow_runs: runs },
        [`repos/${repo}/actions/runs/3/artifacts`]: { total_count: 1, artifacts: [{ id: 77, name: "runtime-agent-release-manifest",
          expired: false, digest: digestOverride ?? zipDigest(bytes), ...artifact }] },
        [`repos/${repo}/actions/artifacts/77/zip`]: { file: archive },
      } },
    });
  } finally {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
}

test("the arm64 lane binds to exactly one sealed production manifest, verified by its upload digest", () => {
  const result = bind();
  ok(result);
  assert.deepEqual(result.output, { run_id: "3", artifact_digest: result.output.artifact_digest, base: refs.baseAmd64, webdev: refs.webdevAmd64 });
  assert.match(result.output.artifact_digest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.calls.map(({ args }) => args.find((value) => value.startsWith("repos/"))),
    [productionRunsPath, `repos/${repo}/actions/runs/3/artifacts`, `repos/${repo}/actions/artifacts/77/zip`]);
  // Listed by commit only, never through the stale event- or status-filtered index.
  assert.ok(result.calls[0].args.includes(`head_sha=${sha}`));
  assert.ok(!result.calls[0].args.some((value) => /^(?:event|status)=/u.test(value)));
  assert.match(result.summary, /Sealed production runtime release/u);
  // Later failed or foreign runs do not disturb the one sealed run.
  ok(bind({ runs: [productionRun({ id: 9, conclusion: "failure" }), productionRun(), productionRun({ id: 8, run_attempt: 2, conclusion: "failure" })] }));
});

test("the arm64 lane refuses to build without a sealed production release", () => {
  for (const [label, runs] of Object.entries({
    "no run": [],
    "failed run": [productionRun({ conclusion: "failure" })],
    "active run": [productionRun({ status: "in_progress", conclusion: null })],
    "second attempt": [productionRun({ run_attempt: 2 })],
    "other commit": [productionRun({ head_sha: "b".repeat(40) })],
    "other branch": [productionRun({ head_branch: "topic" })],
    "other event": [productionRun({ event: "push" })],
    "other workflow": [productionRun({ path: ".github/workflows/publish-runtime-agent-multiarch.yml" })],
    "other repository": [productionRun({ repository: { full_name: "someone/instafy" } })],
  })) fails(bind({ runs }), /production runtime manifest for a{40} is not sealed yet/u, label);
  fails(bind({ runs: [productionRun(), productionRun({ id: 4 })] }), /Expected exactly one sealed production runtime release/u);
  const truncated = runStep(multiarch, bindStep, { env: { RELEASE_COMMIT: sha },
    fixture: { gh: { [productionRunsPath]: { total_count: 101, workflow_runs: [] } } } });
  fails(truncated, /incomplete or unbounded/u);
  fails(runStep(multiarch, bindStep, { env: { RELEASE_COMMIT: "A".repeat(40) } }), /exact commit/u);
});

test("the production manifest artifact must be live, exact and byte-identical to its recorded digest", () => {
  for (const [label, artifact] of Object.entries({ expired: { expired: true }, "no digest": { digest: null },
    "bad digest": { digest: "sha256:abc" }, "other name": { name: "runtime-agent-multiarch-manifest" } })) {
    fails(bind({ artifact }), /lacks exactly one live runtime-agent-release-manifest artifact/u, label);
  }
  fails(bind({ digestOverride: digest("f") }), /does not match its recorded artifact digest/u);
  fails(bind({ entries: { "runtime-agent-release-manifest.json": JSON.stringify(sealedManifest), "extra.json": "{}" } }),
    /must hold exactly runtime-agent-release-manifest\.json/u);
  for (const [label, manifest] of Object.entries({
    "extra top-level key": { ...sealedManifest, platform: "linux/amd64" },
    "schema 2": { ...sealedManifest, schemaVersion: 2 },
    "other commit": { ...sealedManifest, coreCommit: "b".repeat(40) },
    "extra image": { ...sealedManifest, images: { ...sealedManifest.images, extra: refs.baseArm64 } },
    "mutable tag": { ...sealedManifest, images: { ...sealedManifest.images, base: `${image}:latest` } },
    "other repository": { ...sealedManifest, images: { ...sealedManifest.images, base: `ghcr.io/instafy-dev/other@${digest("1")}` } },
    "same image twice": { ...sealedManifest, images: { base: refs.baseAmd64, webdev: refs.baseAmd64 } },
  })) fails(bind({ manifest }), /not the exact v1 release shape/u, label);
});

function archRecord(flavor, architecture, immutableRef, changes = {}) {
  const prefix = flavor === "webdev" ? "webdev-" : "";
  return `${JSON.stringify({ schemaVersion: 1, coreCommit: sha, flavor, architecture, platform: `linux/${architecture}`,
    archTag: `${image}:${prefix}${sha}-linux-${architecture}`, immutableRef, ...changes }, null, 2)}\n`;
}
const amd64Records = { "refs/base-amd64.json": archRecord("base", "amd64", refs.baseAmd64),
  "refs/webdev-amd64.json": archRecord("webdev", "amd64", refs.webdevAmd64) };
const arm64Records = { "refs/base-arm64.json": archRecord("base", "arm64", refs.baseArm64),
  "refs/webdev-arm64.json": archRecord("webdev", "arm64", refs.webdevArm64) };

test("production seals exactly one amd64 record per flavor", () => {
  const validate = (files) => runStep(production, "Validate exactly one amd64 record per flavor", {
    env: { EXPECTED_CORE_COMMIT: sha, RELEASE_REF_DIR: "$RUNNER_TEMP/refs" }, files });
  ok(validate(amd64Records));
  for (const [label, files] of Object.entries({
    "an arm64 record too": { ...amd64Records, "refs/base-arm64.json": archRecord("base", "arm64", refs.baseArm64) },
    "missing webdev": { "refs/base-amd64.json": amd64Records["refs/base-amd64.json"] },
    "arm64 platform": { ...amd64Records, "refs/base-amd64.json": archRecord("base", "amd64", refs.baseAmd64, { platform: "linux/arm64" }) },
    "arm64 tag": { ...amd64Records, "refs/webdev-amd64.json": archRecord("webdev", "amd64", refs.webdevAmd64, { archTag: `${image}:webdev-${sha}-linux-arm64` }) },
    "extra key": { ...amd64Records, "refs/base-amd64.json": archRecord("base", "amd64", refs.baseAmd64, { index: refs.baseArm64 }) },
    "same image twice": { ...amd64Records, "refs/webdev-amd64.json": archRecord("webdev", "amd64", refs.baseAmd64) },
  })) fails(validate(files), undefined, label);
});

const ociManifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: {}, layers: [] };
const dockerManifest = { ...ociManifest, mediaType: "application/vnd.docker.distribution.manifest.v2+json" };
const config = (architecture) => ({ architecture, os: "linux", config: {}, rootfs: { type: "layers", diff_ids: [] } });
const index = (...children) => ({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: children.map(([platform, childDigest]) => {
    const [os, architecture] = platform.split("/");
    return { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: childDigest, size: 1, platform: { os, architecture } };
  }) });

test("production verifies that each sealed reference resolves only to its linux/amd64 image", () => {
  const verify = (base, webdev = { raw: ociManifest, image: config("amd64") }) =>
    runStep(production, "Verify each flavor resolves only to the scanned linux/amd64 image", {
      env: { EXPECTED_CORE_COMMIT: sha, RELEASE_REF_DIR: "$RUNNER_TEMP/refs", RELEASE_MANIFEST_DIR: "$RUNNER_TEMP/out" },
      files: amd64Records, fixture: { docker: { refs: { [refs.baseAmd64]: base, [refs.webdevAmd64]: webdev } } } });
  const sealed = verify({ raw: dockerManifest, image: config("amd64") });
  ok(sealed);
  for (const [flavor, immutableRef] of [["base", refs.baseAmd64], ["webdev", refs.webdevAmd64]]) {
    assert.deepEqual(JSON.parse(sealed.written[`out/${flavor}.json`]), { schemaVersion: 1, coreCommit: sha, flavor, immutableRef });
  }
  assert.ok(sealed.calls.every(({ args }) => args[2] === "inspect"), "nothing is created or tagged");
  assert.match(sealed.summary, /Platform: `linux\/amd64`/u);
  // A one-platform index (containerd image store) is accepted, attestations ignored.
  ok(verify({ raw: index(["linux/amd64", digest("9")], ["unknown/unknown", digest("8")]),
    image: { "linux/amd64": config("amd64") } }));
  for (const [label, base] of Object.entries({
    "arm64 image": { raw: ociManifest, image: config("arm64") },
    "two platforms": { raw: index(["linux/amd64", digest("9")], ["linux/arm64", digest("8")]),
      image: { "linux/amd64": config("amd64"), "linux/arm64": config("arm64") } },
    "arm64 index": { raw: index(["linux/arm64", digest("8")]), image: { "linux/arm64": config("arm64") } },
    // The manifest check stands on its own, whatever the configuration says.
    "two platforms behind an amd64 config": { raw: index(["linux/amd64", digest("9")], ["linux/arm64", digest("8")]),
      image: config("amd64") },
    "unknown media type": { raw: { ...ociManifest, mediaType: "application/vnd.oci.artifact.manifest.v1+json" }, image: config("amd64") },
    "windows image": { raw: ociManifest, image: { ...config("amd64"), os: "windows" } },
  })) fails(verify(base), /not a single linux\/amd64 image|configuration is not linux\/amd64/u, label);
  // An image GHCR never exposes fails after the bounded retries (sleep is stubbed).
  const missing = runStep(production, "Verify each flavor resolves only to the scanned linux/amd64 image", {
    env: { EXPECTED_CORE_COMMIT: sha, RELEASE_REF_DIR: "$RUNNER_TEMP/refs", RELEASE_MANIFEST_DIR: "$RUNNER_TEMP/out" },
    files: amd64Records, fixture: { docker: { refs: {} } } });
  fails(missing, /bounded visibility window/u);
  assert.equal(missing.calls.length, 6);
});

test("the multi-arch lane accepts only its own arm64 records, distinct from the sealed amd64 images", () => {
  const validate = (files, env = {}) => runStep(multiarch, "Validate exactly one arm64 record per flavor", {
    env: { EXPECTED_CORE_COMMIT: sha, RELEASE_REF_DIR: "$RUNNER_TEMP/refs", BASE_AMD64_IMAGE: refs.baseAmd64,
      WEBDEV_AMD64_IMAGE: refs.webdevAmd64, ...env }, files });
  ok(validate(arm64Records));
  for (const [label, files] of Object.entries({
    "an amd64 record too": { ...arm64Records, ...amd64Records },
    "missing base": { "refs/webdev-arm64.json": arm64Records["refs/webdev-arm64.json"] },
    "amd64 platform": { ...arm64Records, "refs/base-arm64.json": archRecord("base", "arm64", refs.baseArm64, { platform: "linux/amd64" }) },
    "reuses the amd64 image": { ...arm64Records, "refs/base-arm64.json": archRecord("base", "arm64", refs.baseAmd64) },
    "same arm64 image twice": { ...arm64Records, "refs/webdev-arm64.json": archRecord("webdev", "arm64", refs.baseArm64) },
  })) fails(validate(files), undefined, label);
  fails(validate(arm64Records, { BASE_AMD64_IMAGE: "" }), undefined, "unbound production image");
});

const assembleStep = "Assemble commit-SHA multiarch manifests from immutable digests";
function assemble({ channel = "false", children = {}, amd64Raw = ociManifest, arm64Raw = ociManifest } = {}) {
  const baseIndex = digest("b"), webdevIndex = digest("c");
  const amd64Child = amd64Raw.manifests ? amd64Raw.manifests[0].digest : null;
  const created = (flavor) => children[flavor] ?? index(
    ["linux/amd64", amd64Child ?? (flavor === "base" ? digest("1") : digest("2"))],
    ["linux/arm64", flavor === "base" ? digest("3") : digest("4")]);
  return runStep(multiarch, assembleStep, {
    env: { EXPECTED_CORE_COMMIT: sha, RELEASE_REF_DIR: "$RUNNER_TEMP/refs", MULTIARCH_DIR: "$RUNNER_TEMP/out",
      BASE_AMD64_IMAGE: refs.baseAmd64, WEBDEV_AMD64_IMAGE: refs.webdevAmd64, UPDATE_CHANNEL_TAGS: channel },
    files: arm64Records,
    fixture: { docker: {
      refs: { [refs.baseAmd64]: { raw: amd64Raw }, [refs.webdevAmd64]: { raw: amd64Raw },
        [refs.baseArm64]: { raw: arm64Raw }, [refs.webdevArm64]: { raw: arm64Raw },
        [`${image}@${baseIndex}`]: { raw: created("base") }, [`${image}@${webdevIndex}`]: { raw: created("webdev") } },
      created: { [`${image}:${sha}`]: baseIndex, [`${image}:webdev-${sha}`]: webdevIndex },
    } },
  });
}

test("each multi-arch index joins exactly the sealed amd64 image and this run's scanned arm64 image", () => {
  const result = assemble();
  ok(result);
  const creates = result.calls.filter(({ args }) => args[2] === "create").map(({ args }) => args.filter((value) => !value.endsWith("-manifest-metadata.json")));
  assert.deepEqual(creates, [
    ["buildx", "imagetools", "create", "--metadata-file", "--tag", `${image}:${sha}`, refs.baseAmd64, refs.baseArm64],
    ["buildx", "imagetools", "create", "--metadata-file", "--tag", `${image}:webdev-${sha}`, refs.webdevAmd64, refs.webdevArm64],
  ]);
  assert.deepEqual(JSON.parse(result.written["out/base.json"]), { schemaVersion: 1, coreCommit: sha, flavor: "base",
    index: `${image}@${digest("b")}`, amd64: refs.baseAmd64, arm64: refs.baseArm64 });
  assert.deepEqual(JSON.parse(result.written["out/webdev.json"]).index, `${image}@${digest("c")}`);
  assert.doesNotMatch(result.summary, /Channel tag moved/u);

  // Channel tags move only on an explicit request, to the verified index.
  const promoted = assemble({ channel: "true" });
  ok(promoted);
  assert.deepEqual(promoted.calls.filter(({ args }) => args[2] === "create" && !args.includes("--metadata-file")).map(({ args }) => args.slice(3)), [
    ["--tag", `${image}:latest`, `${image}@${digest("b")}`],
    ["--tag", `${image}:webdev`, `${image}@${digest("c")}`],
  ]);

  // A one-platform amd64 index is joined through its single child.
  ok(assemble({ amd64Raw: index(["linux/amd64", digest("9")]) }));
});

test("an index with any other child, platform or reused digest is refused before any channel tag moves", () => {
  for (const [label, base] of Object.entries({
    "foreign amd64 child": index(["linux/amd64", digest("e")], ["linux/arm64", digest("3")]),
    "foreign arm64 child": index(["linux/amd64", digest("1")], ["linux/arm64", digest("e")]),
    "missing arm64": index(["linux/amd64", digest("1")]),
    "extra platform": index(["linux/amd64", digest("1")], ["linux/arm64", digest("3")], ["linux/s390x", digest("e")]),
  })) {
    const result = assemble({ channel: "true", children: { base } });
    fails(result, /unexpected platforms|does not join exactly the sealed amd64 image/u, label);
    assert.ok(!result.calls.some(({ args }) => args.includes(`${image}:latest`)), label);
  }
  fails(assemble({ amd64Raw: index(["linux/amd64", digest("9")], ["linux/arm64", digest("8")]) }), undefined, "multi-platform amd64 source");
  fails(assemble({ arm64Raw: index(["linux/amd64", digest("9")]) }), undefined, "arm64 source that is amd64");
});

test("the multi-arch manifest records both halves and the exact production binding", () => {
  const record = (flavor, changes = {}) => `${JSON.stringify({ schemaVersion: 1, coreCommit: sha, flavor,
    index: flavor === "base" ? ref("b") : ref("c"), amd64: flavor === "base" ? refs.baseAmd64 : refs.webdevAmd64,
    arm64: flavor === "base" ? refs.baseArm64 : refs.webdevArm64, ...changes })}\n`;
  const aggregate = (files, env = {}) => runStep(multiarch, "Aggregate exact multi-arch manifest", {
    env: { EXPECTED_CORE_COMMIT: sha, MULTIARCH_DIR: "$RUNNER_TEMP/out", PRODUCTION_RUN_ID: "3",
      PRODUCTION_MANIFEST_DIGEST: digest("d"), BASE_AMD64_IMAGE: refs.baseAmd64, WEBDEV_AMD64_IMAGE: refs.webdevAmd64, ...env },
    files });
  const files = { "out/base.json": record("base"), "out/webdev.json": record("webdev") };
  const result = aggregate(files);
  ok(result);
  const manifest = result.written["out/runtime-agent-multiarch-manifest.json"];
  assert.equal(manifest, `${JSON.stringify({
    schemaVersion: 1, kind: "runtime-agent-multiarch", coreCommit: sha,
    productionRun: { runId: 3, manifestArtifactDigest: digest("d") },
    images: { base: { index: ref("b"), amd64: refs.baseAmd64, arm64: refs.baseArm64 },
      webdev: { index: ref("c"), amd64: refs.webdevAmd64, arm64: refs.webdevArm64 } },
  }, null, 2)}\n`);
  for (const [label, changed, env] of [
    ["amd64 is not the sealed production image", { "out/base.json": record("base", { amd64: ref("e") }) }],
    ["index reuses a child", { "out/base.json": record("base", { index: refs.baseArm64 }) }],
    ["flavors share an index", { "out/webdev.json": record("webdev", { index: ref("b") }) }],
    ["extra key", { "out/base.json": record("base", { platform: "linux/amd64" }) }],
    ["other commit", { "out/base.json": record("base", { coreCommit: "b".repeat(40) }) }],
    ["invalid run", {}, { PRODUCTION_RUN_ID: "0" }],
    ["invalid digest", {}, { PRODUCTION_MANIFEST_DIGEST: "sha256:abc" }],
  ]) fails(aggregate({ ...files, ...changed }, env), undefined, label);
});

test("the reused amd64 images are re-scanned anonymously with the production gate's pinned flags", () => {
  const rescanStep = "Re-scan the sealed amd64 images from the registry";
  const flags = (text) => text.slice(text.indexOf("trivy image \\\n")).split("\n").slice(1)
    .map((line) => line.trim().replace(/ \\$/u, "")).filter((line) => line.startsWith("--"));
  const gate = flags(script(production, "Scan audit image"));
  const rescan = flags(script(multiarch, rescanStep));
  assert.deepEqual(rescan.filter((flag) => !["--image-src remote", "--platform linux/amd64"].includes(flag)), gate);
  assert.deepEqual(rescan.slice(0, 2), ["--image-src remote", "--platform linux/amd64"]);
  for (const flag of ["--scanners vuln,secret", "--severity HIGH,CRITICAL", "--ignore-unfixed", "--exit-code 1"]) assert.ok(rescan.includes(flag), flag);
  // Same pinned Trivy as the production amd64 cells.
  const install = stepText(multiarch.slice(multiarch.indexOf("\n  assemble-multiarch:\n")), "Install pinned Trivy");
  assert.equal(script(multiarch.slice(multiarch.indexOf("\n  assemble-multiarch:\n")), "Install pinned Trivy"),
    script(production, "Install pinned Trivy"));
  assert.match(install, /TRIVY_VERSION: "0\.72\.0"\n {10}TRIVY_ASSET: Linux-64bit\n {10}TRIVY_SHA256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"\n/u);
  // Before any login in that job.
  const job = multiarch.slice(multiarch.indexOf("\n  assemble-multiarch:\n"));
  assert.ok(job.indexOf(`      - name: ${rescanStep}\n`) < job.indexOf("      - name: Login to GHCR\n"));

  const run = (env = {}) => runStep(multiarch, rescanStep, { env: { BASE_AMD64_IMAGE: refs.baseAmd64, WEBDEV_AMD64_IMAGE: refs.webdevAmd64, ...env } });
  const passed = run();
  ok(passed);
  assert.deepEqual(passed.calls.map(({ args }) => args.at(-1)), [refs.baseAmd64, refs.webdevAmd64]);
  for (const call of passed.calls) {
    assert.deepEqual(call.args.slice(0, 1), ["image"]);
    assert.ok(call.config.endsWith("/anonymous-docker-config"), "Trivy reads an empty Docker config");
    assert.deepEqual(call.configFiles, []);
  }
  fails(run({ STUB_TRIVY_STATUS: "1" }), undefined, "a finding fails the lane");
  const tag = run({ WEBDEV_AMD64_IMAGE: `${image}:webdev-${sha}-linux-amd64` });
  fails(tag, /not an exact production digest/u);
  fails(run({ BASE_AMD64_IMAGE: "" }), /not an exact production digest/u);
});

// Job and step structure, read from the workflow text.
function jobOf(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing job ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  [\w-]+:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 2);
}
const stepBlocks = (job) => job.split(/\n(?=      - name: )/u).slice(1);
const stepName = (step) => step.match(/^      - name: (.+)$/mu)[1];
const conditional = (job) => stepBlocks(job).filter((step) => /^        if:/mu.test(step)).map(stepName);

test("no build, scan or re-scan step in either runtime publisher can be skipped", () => {
  // Only the hosted-disk reclaim and the webdev-only smoke are conditional; a
  // condition on any scan would let an image be published unscanned.
  const cellConditions = ["Reclaim hosted-runner disk for the audited image", "Prove the webdev image starts the Shared Browser"];
  assert.deepEqual(conditional(jobOf(production, "build-scan-push")), cellConditions);
  assert.deepEqual(conditional(jobOf(multiarch, "build-scan-push-arm64")), cellConditions);
  for (const job of ["authorize", "release-approval", "assemble-release-manifest"]) {
    assert.deepEqual(conditional(jobOf(production, job)), [], job);
  }
  for (const job of ["authorize", "bind-production-manifest", "release-approval", "assemble-multiarch"]) {
    assert.deepEqual(conditional(jobOf(multiarch, job)), [], job);
  }
  assert.doesNotMatch(production + multiarch, /^    if:/mu, "no job-level condition");
  for (const [source, job, name] of [
    [production, "build-scan-push", "Scan audit image"],
    [multiarch, "build-scan-push-arm64", "Scan audit image"],
    [multiarch, "assemble-multiarch", "Re-scan the sealed amd64 images from the registry"],
  ]) {
    assert.equal(stepBlocks(jobOf(source, job)).filter((step) => stepName(step) === name).length, 1, `${job}: ${name}`);
  }
});

test("the sealed amd64 references flow unchanged from the binding into every assemble step", () => {
  assert.match(jobOf(multiarch, "bind-production-manifest"),
    /^    outputs:\n      production_run_id: \$\{\{ steps\.production\.outputs\.run_id \}\}\n      production_manifest_digest: \$\{\{ steps\.production\.outputs\.artifact_digest \}\}\n      base_amd64: \$\{\{ steps\.production\.outputs\.base \}\}\n      webdev_amd64: \$\{\{ steps\.production\.outputs\.webdev \}\}\n\n/mu);
  const readers = stepBlocks(jobOf(multiarch, "assemble-multiarch")).filter((step) => /AMD64_IMAGE/u.test(step));
  assert.deepEqual(readers.map(stepName), [
    "Re-scan the sealed amd64 images from the registry",
    "Validate exactly one arm64 record per flavor",
    "Assemble commit-SHA multiarch manifests from immutable digests",
    "Aggregate exact multi-arch manifest",
  ]);
  for (const step of readers) {
    assert.deepEqual([...step.matchAll(/^ {10}(\w*AMD64\w*): (.*)$/gmu)].map((match) => [match[1], match[2]]), [
      ["BASE_AMD64_IMAGE", "${{ needs.bind-production-manifest.outputs.base_amd64 }}"],
      ["WEBDEV_AMD64_IMAGE", "${{ needs.bind-production-manifest.outputs.webdev_amd64 }}"],
    ], stepName(step));
  }
  const aggregate = readers.at(-1);
  assert.match(aggregate, /^ {10}PRODUCTION_RUN_ID: \$\{\{ needs\.bind-production-manifest\.outputs\.production_run_id \}\}$/mu);
  assert.match(aggregate, /^ {10}PRODUCTION_MANIFEST_DIGEST: \$\{\{ needs\.bind-production-manifest\.outputs\.production_manifest_digest \}\}$/mu);
  // No other line anywhere reads the bound references.
  const uses = [...multiarch.matchAll(/^.*needs\.bind-production-manifest\.outputs\.(\w+).*$/gmu)].map((match) => match[1]);
  assert.deepEqual([...new Set(uses)].sort(), ["base_amd64", "production_manifest_digest", "production_run_id", "webdev_amd64"]);
  assert.equal(uses.length, 2 * readers.length + 2);
});

test("re-running failed jobs cannot push or assemble again without a fresh dispatch", () => {
  for (const [job, name] of [
    ["build-scan-push-arm64", "Refuse a re-run before publishing arm64 images"],
    ["assemble-multiarch", "Refuse a re-run before assembling the multi-arch indexes"],
  ]) {
    const first = stepBlocks(jobOf(multiarch, job))[0];
    assert.equal(stepName(first), name, job);
    assert.doesNotMatch(first, /^        (?:if|continue-on-error):/mu, job);
    ok(runStep(multiarch, name, { env: { GITHUB_RUN_ATTEMPT: "1" } }));
    for (const attempt of ["2", "", "1 "]) {
      fails(runStep(multiarch, name, { env: { GITHUB_RUN_ATTEMPT: attempt } }), /Release runs are immutable/u, `${job} attempt ${JSON.stringify(attempt)}`);
    }
  }
});
