// Structural guard for .github/workflows/android-release.yml. Dependency-free
// (no YAML parser): the workflow is kept in a plain block style so that
// top-level keys and job sections can be sliced from the text exactly.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "android-release.yml");
const laneDirectory = import.meta.dirname;
const source = fs.readFileSync(workflowPath, "utf8");
const lines = source.split("\n");

function topLevel(key) {
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `missing top-level ${key}`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || lines[end].startsWith(" ") || lines[end].startsWith("#"))) end += 1;
  return lines.slice(start, end).join("\n").trimEnd();
}

function jobs() {
  const body = topLevel("jobs").split("\n").slice(1);
  const result = new Map();
  let current = null;
  for (const line of body) {
    const header = /^ {2}([a-z][a-z0-9_-]*):$/u.exec(line);
    if (header) {
      current = header[1];
      result.set(current, []);
    } else if (current) {
      result.get(current).push(line);
    }
  }
  return new Map([...result].map(([name, text]) => [name, text.join("\n")]));
}

function runBlocks(text) {
  const blocks = [];
  const all = text.split("\n");
  for (let index = 0; index < all.length; index += 1) {
    const match = /^(\s+)run: (.*)$/u.exec(all[index]);
    if (!match) continue;
    if (match[2] !== "|") {
      blocks.push(match[2]);
      continue;
    }
    const indent = match[1].length;
    const body = [];
    for (index += 1; index < all.length; index += 1) {
      const line = all[index];
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function assertOrdered(text, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `${label}: missing or out of order: ${needle}`);
    cursor = next;
  }
}

function laneFiles() {
  return fs.readdirSync(laneDirectory).map((name) => path.join(laneDirectory, name));
}

const JOBS = jobs();

test("triggers are exactly push of android-v* tags and workflow_dispatch(tag, dry_run)", () => {
  assert.equal(topLevel("on"), [
    "on:",
    "  push:",
    "    tags:",
    "      - 'android-v*'",
    "  workflow_dispatch:",
    "    inputs:",
    "      tag:",
    "        description: 'Release tag (existing, or the intended tag name for a dry run)'",
    "        required: true",
    "        type: string",
    "      dry_run:",
    "        description: 'Build, sign and verify but publish nothing'",
    "        required: false",
    "        type: boolean",
    "        default: true",
  ].join("\n"));
  for (const forbidden of ["pull_request", "pull_request_target", "workflow_run", "schedule:", "workflow_call", "repository_dispatch"]) {
    assert.equal(source.includes(forbidden), false, `forbidden trigger text: ${forbidden}`);
  }
});

test("top-level permissions, concurrency and shell defaults are fixed", () => {
  assert.equal(topLevel("permissions"), "permissions:\n  contents: read");
  assert.equal(topLevel("concurrency"), "concurrency:\n  group: android-release\n  cancel-in-progress: false");
  assert.equal(topLevel("defaults"), "defaults:\n  run:\n    shell: bash");
  assert.ok(lines.length <= 450, `workflow has ${lines.length} lines; target is 450`);
});

test("jobs run only on the literal hosted ubuntu-24.04 image", () => {
  assert.deepEqual([...JOBS.keys()], ["authorize", "build", "publish"]);
  const runsOn = [...source.matchAll(/^\s*runs-on:(.*)$/gmu)].map((match) => match[1].trim());
  assert.deepEqual(runsOn, ["ubuntu-24.04", "ubuntu-24.04", "ubuntu-24.04"]);
  assert.doesNotMatch(source, /self-hosted|runner\.environment|^\s+group:\s*org\/|macos|windows/imu);
  for (const [name, text] of JOBS) {
    assert.match(text, /^ {4}timeout-minutes: \d+$/mu, `${name} needs a timeout`);
  }
});

test("secrets, environments and write permission stay in the named jobs", () => {
  assert.doesNotMatch(JOBS.get("authorize"), /environment:|secrets\.|contents: write/u);
  assert.match(JOBS.get("build"), /^ {4}environment: android-release$/mu);
  assert.match(JOBS.get("publish"), /^ {4}environment: android-release$/mu);
  assert.equal([...source.matchAll(/environment:/gu)].length, 2);
  assert.doesNotMatch(JOBS.get("build"), /contents: write/u);
  assert.match(JOBS.get("publish"), /^ {4}permissions:\n {6}contents: write$/mu);
  assert.equal([...source.matchAll(/contents: write/gu)].length, 1);
  const outsideJobs = source.slice(0, source.indexOf("\njobs:\n"));
  assert.doesNotMatch(outsideJobs, /secrets\./u);
  // Secret names used, all mapped through step env (never interpolated in run).
  const secretNames = new Set([...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]));
  assert.deepEqual([...secretNames].sort(), [
    "ANDROID_UPLOAD_KEYSTORE_B64",
    "ANDROID_UPLOAD_KEYSTORE_PASSWORD",
    "ANDROID_UPLOAD_KEYSTORE_TYPE",
    "ANDROID_UPLOAD_KEY_ALIAS",
    "ANDROID_UPLOAD_KEY_PASSWORD",
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  ]);
  assert.doesNotMatch(source, /OTA_SIGNING_PRIVATE_KEY\s*:|secrets\.OTA_|INSTAFY_BOT_TOKEN|pull-requests:|id-token:/u);
});

test("run blocks never interpolate untrusted or secret expressions and never echo secrets", () => {
  for (const block of runBlocks(source)) {
    assert.doesNotMatch(block, /\$\{\{/u, `run block interpolates an expression:\n${block}`);
    assert.doesNotMatch(block, /set -x|set -o xtrace/u);
    if (block.includes("\n")) assert.match(block, /^\s*set -euo pipefail$/mu, `multi-line run lacks strict mode:\n${block}`);
    for (const line of block.split("\n")) {
      if (/\b(?:echo|printf)\b/u.test(line)) {
        assert.doesNotMatch(
          line.replace(`printf '%s' "$ANDROID_UPLOAD_KEYSTORE_B64" | base64 -d`, ""),
          /\$\{?(?:ANDROID_UPLOAD_[A-Z_]+|GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)\b/u,
          `a secret-bearing variable reaches a log line: ${line}`,
        );
      }
    }
  }
  const keystoreDecode = source.match(/printf '%s' "\$ANDROID_UPLOAD_KEYSTORE_B64" \| base64 -d > "\$keystore"/gu) ?? [];
  assert.equal(keystoreDecode.length, 1);
  assert.match(JOBS.get("build"), /- name: Remove signing material\n {8}if: always\(\)\n {8}run: rm -rf "\$RUNNER_TEMP\/instafy-android-signing"/u);
});

test("every action is pinned to a reviewed 40-hex commit", () => {
  const uses = [...source.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)].map((match) => match[1]);
  assert.ok(uses.length >= 7);
  const allowed = new Set([
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  ]);
  for (const action of uses) {
    assert.match(action, /@[0-9a-f]{40}$/u);
    assert.ok(allowed.has(action), `unexpected action pin ${action}`);
  }
  for (const checkout of source.matchAll(/uses: actions\/checkout@[0-9a-f]{40} # v6\n {8}with:\n((?: {10}.*\n)+)/gu)) {
    assert.match(checkout[1], /persist-credentials: false/u);
    assert.match(checkout[1], /ref: \$\{\{ (?:steps\.resolve|needs\.authorize)\.outputs\.source_sha \}\}/u);
  }
});

test("authorize proves actor, pusher, main containment, committed version and one-shot in order", () => {
  const authorize = JOBS.get("authorize");
  assertOrdered(authorize, [
    '[[ "$GITHUB_REPOSITORY" == "$RELEASE_REPOSITORY" ]]',
    '[[ "$GITHUB_ACTOR" == "$RELEASE_ACTOR" ]]',
    '[[ "$PUSHER_NAME" == "$RELEASE_ACTOR" ]]',
    '[[ "$GITHUB_REF" == "refs/heads/main" ]]',
    "^android-v([0-9A-Za-z][0-9A-Za-z._-]{0,63})-([1-9][0-9]{0,9})$",
    "git/ref/tags/$tag",
    "git/tags/",
    "compare/${source_sha}...main",
    "identical | ahead",
    "uses: actions/checkout@",
    'test "$HEAD_SHA" = "$SOURCE_SHA"',
    "node scripts/release/android/mobile-versions.mjs .",
    "node scripts/release/android/verify-release-tag.mjs",
    "if: steps.verify.outputs.mode == 'release'",
    "releases/tags/$TAG",
    "HTTP 404",
    "GITHUB_STEP_SUMMARY",
  ], "authorize");
  assert.match(source, /RELEASE_REPOSITORY: instafy-dev\/instafy\n/u);
  assert.match(source, /RELEASE_ACTOR: instafy-bot\n/u);
  assert.match(authorize, /submodules: false/u);
});

test("build observes Play before building, verifies the signed AAB and publishes nothing", () => {
  const build = JOBS.get("build");
  assert.match(build, /^ {4}needs: authorize$/mu);
  assert.match(build, /^ {4}timeout-minutes: 90$/mu);
  assert.match(build, /submodules: recursive/u);
  for (const constant of [
    "VITE_OTA_CHANNEL: internal",
    "CAPACITOR_LIVE_UPDATE_DEFAULT_CHANNEL: internal",
    "VITE_BUILD_GIT_SHA: ${{ needs.authorize.outputs.source_sha }}",
    "GRADLE_OPTS: -Dorg.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8",
  ]) {
    assert.ok(build.includes(constant), constant);
  }
  assertOrdered(build, [
    'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    "Missing android-release secret",
    'test "$(pnpm --version)" = "10.34.5"',
    "android-observe",
    "android-preflight",
    "--dry-run",
    "setup-android-toolchain.sh",
    "keytool -list",
    "node scripts/resolve-live-update-public-key.mjs",
    "browser-safe-supabase-key.mjs --write-env-file .env.supabase",
    "pnpm install --frozen-lockfile",
    "pnpm run test:android:config",
    "run cap:sync",
    "./gradlew --no-daemon :app:bundleRelease",
    "verify-aab.sh",
    "name: android-aab-${{ needs.authorize.outputs.tag }}",
    "rm -rf \"$RUNNER_TEMP/instafy-android-signing\"",
    "GITHUB_STEP_SUMMARY",
  ], "build");
  assert.doesNotMatch(build, /resolve-live-update-public-key\.mjs --require-private-key/u);
  assert.match(build, /CAPACITOR_LIVE_UPDATE_PUBLIC_KEY: \$\{\{ vars\.CAPACITOR_LIVE_UPDATE_PUBLIC_KEY \}\}/u);
  assert.match(build, /ANDROID_VERSION_CODE: \$\{\{ needs\.authorize\.outputs\.version_code \}\}/u);
  assert.match(build, /retention-days: \$\{\{ needs\.authorize\.outputs\.mode == 'release' && 30 \|\| 7 \}\}/u);
  assert.doesNotMatch(build, /android-publish|android-reconcile|gh release|write-receipt/u);
});

test("publish runs only for release mode and rechecks state immediately before each write", () => {
  const publish = JOBS.get("publish");
  assert.match(publish, /^ {4}needs:\n {6}- authorize\n {6}- build\n {4}if: needs\.authorize\.outputs\.mode == 'release'$/mu);
  assert.match(publish, /submodules: false/u);
  assertOrdered(publish, [
    "uses: actions/download-artifact@",
    "name: android-aab-${{ needs.authorize.outputs.tag }}",
    'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    "nativeArtifactSha256",
    "release-refs.sh recheck \"$TAG\" \"$SOURCE_SHA\"",
    "android-observe",
    "android-decide \"$out/pre.json\" \"$out/current.json\"",
    "android-publish",
    "jq -er .stateSha256 \"$out/pre.json\"",
    "android-reconcile",
    "write-receipt.mjs",
    "release-refs.sh recheck \"$TAG\" \"$SOURCE_SHA\"",
    'gh release create "$TAG" --repo "$RELEASE_REPOSITORY" --verify-tag --latest=false',
    '"$out/release-receipt.json" "$out/app-release.aab"',
    "GITHUB_STEP_SUMMARY",
  ], "publish");
  assert.equal([...source.matchAll(/android-publish/gu)].length, 1);
  assert.equal([...source.matchAll(/gh release create/gu)].length, 1);
  assert.match(publish, /release-receipt\.json/u);
});

test("helpers keep the Play contract and the recheck invariants", () => {
  const play = fs.readFileSync(path.join(laneDirectory, "google-play-internal.mjs"), "utf8");
  assert.match(play, /:commit`\)\}\?changesInReviewBehavior=ERROR_IF_IN_REVIEW/u);
  assert.match(play, /uploadType=media/u);
  assert.match(play, /status: "completed",\n\s+name: `\$\{versionName\} \(\$\{versionCode\}\)`/u);
  assert.match(play, /const GOOGLE_TOKEN_ORIGIN = "https:\/\/oauth2\.googleapis\.com";/u);
  const refs = fs.readFileSync(path.join(laneDirectory, "release-refs.sh"), "utf8");
  assertOrdered(refs, ["git/ref/tags/", "compare/${source_sha}...main", "identical | ahead", "releases/tags/"], "release-refs");
  const verify = fs.readFileSync(path.join(laneDirectory, "verify-aab.sh"), "utf8");
  assertOrdered(verify, [
    "sha256sum --check",
    "/manifest/@package",
    "/manifest/@android:versionCode",
    "/manifest/@android:versionName",
    "jar verified.",
    "inspect-aab.py",
    "sha256sum --check",
    "instafy-release.aab.zip",
    "public-boundary-gitleaks.toml",
  ], "verify-aab");
});

test("identity scrub: no private identities in the workflow or lane scripts", () => {
  // Character classes keep this guard from matching its own source text.
  const forbidden = /m[a]rcus|p[o]usette|t[i]nycow|192\.168\.|f[r]itz|instafy-n[a]tive|instafy-i[n]ternal|M[a]rcuss/iu;
  for (const file of [workflowPath, ...laneFiles()]) {
    const text = fs.readFileSync(file, "utf8");
    const match = forbidden.exec(text);
    assert.equal(match?.[0] ?? null, null, `${path.relative(repositoryRoot, file)} contains a private identity marker`);
    assert.doesNotMatch(text, /\/U[s]ers\/|gh[p]_[A-Za-z0-9]|github_[p]at_[A-Za-z0-9]/u, path.basename(file));
  }
});
