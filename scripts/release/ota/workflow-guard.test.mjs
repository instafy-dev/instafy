// Structural guard for .github/workflows/mobile-ota-release.yml and
// .github/workflows/downloads-worker-deploy.yml. Deliberately dependency-free:
// it reads the YAML text with line-anchored patterns so it runs with plain
// `node --test` before any install.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");
const OTA = ".github/workflows/mobile-ota-release.yml";
const WORKER = ".github/workflows/downloads-worker-deploy.yml";

function topLevel(source, key) {
  const match = new RegExp(`^${key}:\\n((?:(?: .*)?\\n)*?)(?=^\\S)`, "mu").exec(`${source}\nEOF:\n`);
  assert.ok(match, `missing top-level ${key}`);
  return match[1];
}

function jobs(source) {
  const body = topLevel(source, "jobs");
  const result = new Map();
  const names = [...body.matchAll(/^  ([a-z][a-z0-9-]*):\n/gmu)];
  names.forEach((match, index) => {
    const end = index + 1 < names.length ? names[index + 1].index : body.length;
    result.set(match[1], body.slice(match.index, end));
  });
  return result;
}

function steps(job) {
  const parts = job.split(/^      - (?=name: )/mu).slice(1);
  return parts.map((text) => ({ name: /^name: (.*)$/mu.exec(text)[1], text }));
}

function runBlocks(source) {
  return [...source.matchAll(/^(\s+)run: \|\n((?:\1  .*\n|\s*\n)*)/gmu)].map((match) => match[2]);
}

function assertOrdered(text, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `missing or out of order: ${needle}`);
    cursor = next;
  }
}

function listFiles(relativeDir) {
  const dir = path.join(repositoryRoot, relativeDir);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(path.join(relativeDir, entry.name)) : [path.join(relativeDir, entry.name)],
  );
}

// Dry runs (every dispatch) never cancel a pending release; each release tag queues only behind itself.
const OTA_CONCURRENCY_GROUP = "mobile-ota-release-${{ github.event_name == 'workflow_dispatch' && 'dry-run' || github.ref_name }}";

function commonWorkflowRules(source, name) {
  assert.match(source, /^permissions:\n  contents: read\n/mu, `${name}: top-level permissions`);
  assert.match(source, /^defaults:\n  run:\n    shell: bash\n/mu, `${name}: bash default`);
  assert.doesNotMatch(source, /^\s*(pull_request|pull_request_target|workflow_run|schedule|workflow_call|repository_dispatch|release):/mu);
  assert.doesNotMatch(source, /self-hosted|runner\.environment/mu);
  for (const match of source.matchAll(/^\s+group: (.*)$/gmu)) {
    assert.ok(!match[1].includes("${{") || match[1] === OTA_CONCURRENCY_GROUP, `${name}: dynamic group ${match[1]}`);
  }
  // Signed bytes and the private train's artifact_url are pinned; no variable may redirect them.
  assert.doesNotMatch(source, /vars\.(DOWNLOADS_BASE_URL|DOWNLOADS_BUCKET|MOBILE_OTA_DOWNLOADS_PREFIX|DESKTOP_DOWNLOADS_PREFIX)/u);
  assert.doesNotMatch(source, /command -v \S+ >\/dev\/null &&/u, `${name}: && lists do not fail under set -e`);
  for (const match of source.matchAll(/^\s+runs-on:\s*(.*)$/gmu)) {
    assert.equal(match[1], "ubuntu-24.04", `${name}: runs-on must be a hosted literal`);
  }
  for (const match of source.matchAll(/^\s+(?:- )?uses:\s+([^\s#]+)/gmu)) {
    assert.match(match[1], /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/u, `${name}: ${match[1]} must be pinned`);
  }
  for (const block of runBlocks(source)) {
    assert.match(block, /^\s*set -euo pipefail\n/u, `${name}: every run step starts with set -euo pipefail`);
    assert.doesNotMatch(block, /\$\{\{/u, `${name}: expressions must reach shell through env, never inline`);
    assert.doesNotMatch(block, /set -x|\bprintenv\b|\benv\s*$|echo\s+"?\$\{?(OTA_SIGNING_PRIVATE_KEY|CLOUDFLARE_API_TOKEN|GH_TOKEN)/mu);
  }
  for (const [jobName, job] of jobs(source)) {
    const jobSteps = steps(job);
    assert.match(jobSteps.at(-1).text, /GITHUB_STEP_SUMMARY/u, `${name}/${jobName} must end with a step summary`);
    assert.match(job, /^    timeout-minutes: \d+$/mu, `${name}/${jobName} needs a timeout`);
  }
  assert.doesNotMatch(source, /ota\/releases|\/activate\b|CONTROLLER_INTERNAL_TOKEN|SERVICE_ROLE|INSTAFY_BOT_TOKEN/u);
}

test("OTA release triggers only on bot tags or a main dry-run dispatch", () => {
  const source = read(OTA);
  commonWorkflowRules(source, OTA);
  assert.equal(
    topLevel(source, "on"),
    `  push:
    tags:
      - "ota-v*"
  workflow_dispatch:
    inputs:
      tag:
        description: "Dry run only: ota-v<first 12 hex of the main head>; builds, signs and verifies, publishes nothing"
        required: true
        type: string

`,
  );
  assert.doesNotMatch(source, /inputs\.dry_run|INPUT_DRY_RUN/u, "a dispatch can never select release mode");
  assert.ok(source.includes(`\nconcurrency:\n  group: ${OTA_CONCURRENCY_GROUP}\n  cancel-in-progress: false\n`));
  assert.match(source, /^  DOWNLOADS_BASE_URL: https:\/\/downloads\.instafy\.dev\n  MOBILE_OTA_DOWNLOADS_PREFIX: mobile$/mu);
  assert.match(source, /^  OTA_CHANNEL: internal$/mu);
  assert.ok(source.split("\n").length <= 455, "workflow should stay within the 455-line target");
});

test("every OTA job checks out github.sha and nothing writes a cache", () => {
  // Checking out a ref derived from step outputs or inputs in a main/tag context is a cache-poisoning
  // shape; the exact-source binding is instead enforced by authorize (tag peels to github.sha) and by
  // every job's `git rev-parse HEAD` == SOURCE_SHA check.
  const source = read(OTA);
  const all = jobs(source);
  for (const [name, job] of all) {
    const checkouts = steps(job).filter((step) => /uses: actions\/checkout@/u.test(step.text));
    assert.equal(checkouts.length, 1, `${name}: exactly one checkout`);
    const refs = [...checkouts[0].text.matchAll(/^\s+ref: (.*)$/gmu)].map((m) => m[1]);
    assert.deepEqual(refs, ["${{ github.sha }}"], `${name}: checkout must be github.sha`);
    if (name !== "authorize") {
      assert.match(job, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/u, `${name}: re-proves the source`);
    }
  }
  assert.doesNotMatch(source, /^\s+ref: \$\{\{ (?:needs|steps|inputs)\./mu);
  assert.doesNotMatch(source, /actions\/cache@|^\s+cache(?:-dependency-path)?:/mu, "no cache reads or writes");
  const worker = read(WORKER);
  assert.doesNotMatch(worker, /actions\/cache@|^\s+cache(?:-dependency-path)?:/mu, "no cache reads or writes");
});

test("OTA jobs isolate secrets in the ota-release environment", () => {
  const source = read(OTA);
  const all = jobs(source);
  assert.deepEqual([...all.keys()], ["authorize", "web", "sign", "publish"]);
  assert.ok(!/secrets\./u.test(topLevel(source, "env")));
  for (const [name, job] of all) {
    const environments = [...job.matchAll(/^    environment:\s*(.*)$/gmu)].map((m) => m[1]);
    const secretNames = [...job.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((m) => m[1]);
    if (name === "sign" || name === "publish") {
      assert.deepEqual(environments, ["ota-release"], name);
    } else {
      assert.deepEqual(environments, [], name);
      assert.deepEqual(secretNames, [], `${name} must not reference secrets`);
    }
    assert.equal(/contents: write/u.test(job), name === "publish", `${name}: contents: write only in publish`);
    if (environments.length > 0) {
      assert.doesNotMatch(job, /pnpm install|npm ci|pnpm\/action-setup/u, `${name}: no dependency install next to secrets`);
    }
  }
  assert.equal((source.match(/contents: write/gu) ?? []).length, 1);
  assert.deepEqual(
    [...new Set([...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((m) => m[1]))].sort(),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_R2_API_TOKEN", "OTA_SIGNING_PRIVATE_KEY"],
  );
  const sign = all.get("sign");
  for (const step of steps(sign)) {
    const usesKey = /secrets\.OTA_SIGNING_PRIVATE_KEY/u.test(step.text);
    assert.equal(usesKey, ["Resolve the native trust anchor from the signing key", "Build and sign the OTA bundle"].includes(step.name), step.name);
  }
  assert.match(all.get("publish"), /^    if: \$\{\{ needs\.authorize\.outputs\.mode == 'release' \}\}$/mu);
});

test("sign and publish re-check the triggering actor before any secret, since re-run failed jobs skips authorize", () => {
  const all = jobs(read(OTA));
  const check = '[[ "$TRIGGERING_ACTOR" == "instafy-bot" ]] || {';
  for (const name of ["sign", "publish"]) {
    const job = all.get(name);
    assert.match(job, /^    env:\n(?:      .*\n)*?      TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}$/mu, `${name}: job-level TRIGGERING_ACTOR`);
    const jobSteps = steps(job);
    const firstRun = jobSteps.findIndex((step) => /\n        run: \|/u.test(step.text));
    const firstSecret = jobSteps.findIndex((step) => /secrets\./u.test(step.text));
    assert.ok(firstRun >= 0 && firstRun < firstSecret, `${name}: an actor check must run before secrets`);
    assert.match(jobSteps[firstRun].text, /run: \|\n\s+set -euo pipefail\n\s+\[\[ "\$TRIGGERING_ACTOR" == "instafy-bot" \]\] \|\| \{/u, `${name}: actor check is the first command`);
    assert.ok(job.includes(check));
  }
});

test("OTA runbook matches the workflow's environment and re-run guarantees", () => {
  const runbook = read("docs/OTA-Rollout.md");
  // Step 3's dry run is a main dispatch and sign uses ota-release, so the environment needs both policies.
  assert.match(runbook, /`ota-release` environment with deployment policies tag `ota-v\*` and branch `main`/u);
  assert.doesNotMatch(runbook, /environment with tag policy `ota-v\*`,/u);
  // Re-run failed jobs skips authorize; the doc may only promise what sign and publish re-check.
  assert.match(runbook, /sign and publish check\s+it again/u);
});

test("authorize binds actor, pusher, main containment, version and one-shot probes in order", () => {
  const authorize = jobs(read(OTA)).get("authorize");
  assertOrdered(authorize, [
    '"$GITHUB_REPOSITORY" != "instafy-dev/instafy" || "$ACTOR" != "instafy-bot" || "$TRIGGERING_ACTOR" != "instafy-bot"',
    '"$EVENT_NAME" == "push" && "$PUSHER" != "instafy-bot"',
    "^ota-v[0-9a-f]{12}$",
    'gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"',
    "git/tags/${tag_sha}",
    'compare/${GITHUB_SHA}...main" --jq .status',
    "persist-credentials: false",
    "node scripts/release/ota/verify-release-tag.mjs",
    "node scripts/release/ota/read-committed-mobile-versions.mjs .",
    'if [[ "$MODE" == "release" ]]; then',
    "releases/tags/${TAG}",
    "curl --silent --head",
    "GITHUB_STEP_SUMMARY",
  ]);
  assert.match(authorize, /PUSHER: \$\{\{ github\.event\.pusher\.name \}\}/u);
  assert.equal(authorize.match(/TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/gu)?.length, 2);
});

test("web, sign and publish keep the exact-source, signing and publication order", () => {
  const all = jobs(read(OTA));
  assertOrdered(all.get("web"), [
    "submodules: recursive",
    'test "$(pnpm --version)" = "10.34.5"',
    "node scripts/release/ota/browser-safe-config.mjs",
    "pnpm install --frozen-lockfile",
    "pnpm --filter @instafy/frontend build",
    "prove-web-layer.sh packages/frontend/dist",
    "actions/upload-artifact@",
  ]);
  assert.match(all.get("web"), /VITE_OTA_CHANNEL: internal/u);
  assert.match(all.get("web"), /VITE_BUILD_GIT_SHA: \$\{\{ needs\.authorize\.outputs\.source_sha \}\}/u);
  assertOrdered(all.get("sign"), [
    "prove-web-layer.sh packages/frontend/dist",
    "node scripts/resolve-live-update-public-key.mjs --require-private-key",
    'node scripts/build-ota-bundle.mjs --dist packages/frontend/dist --out "$RUNNER_TEMP/ota"',
    '--git-sha "$SOURCE_SHA" --bundle-version "$TAG"',
    "verify-public-bytes.mjs anchor",
    '"$ARCHIVE_FILE_NAME" == "${TAG}.zip"',
    "verify-public-bytes.mjs local",
    "validate-ota-web-archive.py",
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    "--config scripts/public-boundary-gitleaks.toml",
    "node scripts/render-ota-release-payload.mjs",
    "--status live --rollout-percentage 100",
    '--out "$RUNNER_TEMP/ota/${platform}-internal-${TAG}.release.json"',
    "name: mobile-ota-${{ needs.authorize.outputs.tag }}",
  ]);
  assert.doesNotMatch(all.get("sign"), /--notes/u);
  assert.doesNotMatch(all.get("sign"), /r2 object|put-immutable|gh release|wrangler/u);
  const publish = all.get("publish");
  assertOrdered(publish, [
    "actions/download-artifact@",
    "verify-public-bytes.mjs anchor",
    "verify-public-bytes.mjs local",
    "node scripts/release/ota/tag-state.mjs",
    "wrangler@4.73.0",
    'put-immutable.sh "$RUNNER_TEMP/ota/${TAG}.zip" "${MOBILE_OTA_DOWNLOADS_PREFIX}/${TAG}.zip" application/zip',
    'put-immutable.sh "$RUNNER_TEMP/ota/${TAG}.manifest.json" "${MOBILE_OTA_DOWNLOADS_PREFIX}/${TAG}.manifest.json" application/json',
    "verify-public-bytes.mjs public",
    "node scripts/release/ota/write-receipt.mjs",
    '--out "$RUNNER_TEMP/release-receipt.json"',
    "node scripts/release/ota/tag-state.mjs",
    'gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --latest=false',
    '"$RUNNER_TEMP/release-receipt.json"',
  ]);
  const source = read(OTA);
  for (const mutation of ["put-immutable.sh", "gh release create"]) {
    for (const [name, job] of all) {
      assert.equal(job.includes(mutation), name === "publish", `${mutation} only in publish`);
    }
  }
  assert.equal((source.match(/CLOUDFLARE_R2_API_TOKEN/gu) ?? []).length, 2);
});

test("downloads worker deploy is a bot dispatch of exact main with a dry run", () => {
  const source = read(WORKER);
  commonWorkflowRules(source, WORKER);
  assert.equal(
    topLevel(source, "on"),
    `  workflow_dispatch:
    inputs:
      commit_sha:
        description: "Exact commit to deploy; must equal the current protected main head"
        required: true
        type: string
      dry_run:
        description: "Test and bundle the Worker but deploy nothing"
        required: false
        type: boolean
        default: true

`,
  );
  const all = jobs(source);
  assert.deepEqual([...all.keys()], ["deploy"]);
  const deploy = all.get("deploy");
  assert.match(deploy, /^    environment: downloads-worker$/mu);
  assert.match(source, /^concurrency:\n  group: downloads-worker-deploy\n  cancel-in-progress: false\n/mu);
  assert.doesNotMatch(source, /contents: write|r2 object|put-immutable/u);
  assertOrdered(deploy, [
    '"$GITHUB_REPOSITORY" != "instafy-dev/instafy" || "$GITHUB_REF" != "refs/heads/main"',
    '"$ACTOR" != "instafy-bot" || "$TRIGGERING_ACTOR" != "instafy-bot"',
    '! "$REQUESTED_COMMIT" =~ ^[0-9a-f]{40}$ || "$REQUESTED_COMMIT" != "$GITHUB_SHA"',
    "ref: ${{ github.sha }}",
    "node --experimental-strip-types --test packages/downloads-worker/test/index.test.mjs",
    "node scripts/release/downloads-worker/verify-wrangler-contract.mjs",
    "wrangler@4.73.0",
    'if [[ "$DRY_RUN" == "true" ]]; then',
    '"$WRANGLER" deploy --dry-run',
    "else",
    '"$WRANGLER" deploy 2>&1',
    "if: ${{ inputs.dry_run == false }}",
    "node scripts/release/downloads-worker/verify-live-feed.mjs",
    "GITHUB_STEP_SUMMARY",
  ]);
  assert.deepEqual(
    [...new Set([...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((m) => m[1]))].sort(),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKERS_API_TOKEN"],
  );
});

test("lane files carry no private identity or infrastructure strings", () => {
  const files = [OTA, WORKER, ...listFiles("scripts/release/ota"), ...listFiles("scripts/release/downloads-worker")];
  const forbidden = new RegExp(
    [["mar", "cus"], ["pous", "sette"], ["tiny", "cow"], ["192", "\\.168\\."], ["fri", "tz"], ["instafy-", "native"], ["instafy-", "internal"], ["Mar", "cuss"]]
      .map((parts) => parts.join(""))
      .join("|"),
    "iu",
  );
  for (const file of files) {
    const match = forbidden.exec(read(file));
    assert.equal(match, null, `${file} contains a forbidden identity string: ${match?.[0]}`);
  }
});
