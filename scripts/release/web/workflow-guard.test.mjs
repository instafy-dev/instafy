// Structural guard for .github/workflows/web-release.yml. Dependency-free: it
// reads the YAML text with line-anchored patterns so it runs with plain
// `node --test` before any install (the authorize job runs it).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");
const WEB = ".github/workflows/web-release.yml";
const WEB_CONCURRENCY_GROUP = "web-release-${{ github.event_name == 'workflow_dispatch' && 'dry-run' || github.ref_name }}";

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
  return job.split(/^      - (?=name: )/mu).slice(1).map((text) => ({ name: /^name: (.*)$/mu.exec(text)[1], text }));
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

test("web release triggers only on bot tags or a main dry-run dispatch", () => {
  const source = read(WEB);
  assert.equal(
    topLevel(source, "on"),
    `  push:
    tags:
      - "web-v*"
  workflow_dispatch:
    inputs:
      tag:
        description: "Dry run only: web-v<first 12 hex of the main head>; builds, verifies and seals, publishes nothing"
        required: true
        type: string

`,
  );
  assert.match(source, /^permissions:\n  contents: read\n/mu);
  assert.match(source, /^defaults:\n  run:\n    shell: bash\n/mu);
  assert.ok(source.includes(`\nconcurrency:\n  group: ${WEB_CONCURRENCY_GROUP}\n  cancel-in-progress: false\n`));
  assert.doesNotMatch(source, /^\s*(pull_request|pull_request_target|workflow_run|schedule|workflow_call|repository_dispatch|release):/mu);
  assert.doesNotMatch(source, /inputs\.dry_run|INPUT_DRY_RUN/u, "a dispatch can never select release mode");
  assert.ok(source.split("\n").length <= 370, "workflow should stay within the 370-line target");
});

test("every run block is strict, expression-free and on a hosted runner with a pinned action set", () => {
  const source = read(WEB);
  assert.doesNotMatch(source, /self-hosted|runner\.environment/mu);
  for (const match of source.matchAll(/^\s+runs-on:\s*(.*)$/gmu)) {
    assert.equal(match[1], "ubuntu-24.04");
  }
  for (const match of source.matchAll(/^\s+(?:- )?uses:\s+([^\s#]+)/gmu)) {
    assert.match(match[1], /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/u, `${match[1]} must be pinned`);
  }
  for (const block of runBlocks(source)) {
    assert.match(block, /^\s*set -euo pipefail\n/u, "every run step starts with set -euo pipefail");
    assert.doesNotMatch(block, /\$\{\{/u, "expressions must reach shell through env, never inline");
    assert.doesNotMatch(block, /set -x|\bprintenv\b|\benv\s*$|echo\s+"?\$\{?(CLOUDFLARE_API_TOKEN|GH_TOKEN)/mu);
  }
  for (const match of source.matchAll(/^\s+group: (.*)$/gmu)) {
    assert.ok([WEB_CONCURRENCY_GROUP, "hosted-web-production"].includes(match[1]), match[1]);
  }
  for (const [name, job] of jobs(source)) {
    assert.match(steps(job).at(-1).text, /GITHUB_STEP_SUMMARY/u, `${name} must end with a step summary`);
    assert.match(job, /^    timeout-minutes: \d+$/mu, `${name} needs a timeout`);
  }
});

test("every job checks out github.sha once and nothing reads or writes a cache", () => {
  const source = read(WEB);
  for (const [name, job] of jobs(source)) {
    const checkouts = steps(job).filter((step) => /uses: actions\/checkout@/u.test(step.text));
    assert.equal(checkouts.length, 1, `${name}: exactly one checkout`);
    assert.deepEqual([...checkouts[0].text.matchAll(/^\s+ref: (.*)$/gmu)].map((m) => m[1]), ["${{ github.sha }}"]);
    assert.match(checkouts[0].text, /persist-credentials: false/u);
    if (name !== "authorize") {
      assert.match(job, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/u, `${name}: re-proves the source`);
    }
  }
  assert.doesNotMatch(source, /actions\/cache@|^\s+cache(?:-dependency-path)?:/mu);
});

test("secrets exist only in the web-release publish job, behind the bot and enablement checks", () => {
  const source = read(WEB);
  const all = jobs(source);
  assert.deepEqual([...all.keys()], ["authorize", "build", "publish"]);
  assert.doesNotMatch(source, /contents: write/u);
  for (const [name, job] of all) {
    const environments = [...job.matchAll(/^    environment:\s*(.*)$/gmu)].map((m) => m[1]);
    const secretNames = [...job.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((m) => m[1]);
    if (name === "publish") {
      assert.deepEqual(environments, ["web-release"]);
      assert.doesNotMatch(job, /pnpm install|npm ci|pnpm\/action-setup/u, "no dependency install next to secrets");
    } else {
      assert.deepEqual(environments, []);
      assert.deepEqual(secretNames, [], `${name} must not reference secrets`);
    }
  }
  assert.deepEqual(
    [...new Set([...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((m) => m[1]))].sort(),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_PAGES_API_TOKEN"],
  );
  const publish = all.get("publish");
  assert.match(publish, /^    if: \$\{\{ needs\.authorize\.outputs\.mode == 'release' \}\}$/mu);
  assert.match(publish, /^    concurrency:\n      group: hosted-web-production\n      cancel-in-progress: false$/mu);
  assert.match(publish, /^      TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}$/mu);
  const publishSteps = steps(publish);
  const firstRun = publishSteps.findIndex((step) => /\n        run: \|/u.test(step.text));
  const firstSecret = publishSteps.findIndex((step) => /secrets\./u.test(step.text));
  assert.ok(firstRun >= 0 && firstRun < firstSecret, "an actor check must run before secrets");
  assert.match(
    publishSteps[firstRun].text,
    /run: \|\n\s+set -euo pipefail\n\s+\[\[ "\$TRIGGERING_ACTOR" == "instafy-bot" \]\] \|\| \{.*\n\s+\[\[ "\$HOSTED_FRONTEND_PUBLISH_ENABLED" == "true" \]\] \|\| \{/u,
  );
  for (const step of publishSteps) {
    const usesSecret = /secrets\./u.test(step.text);
    assert.equal(
      usesSecret,
      ["Re-check the tag binding and decide the publication", "Publish to Cloudflare Pages", "Roll back a failed production publication"].includes(step.name),
      step.name,
    );
  }
});

test("authorize, build and publish keep the exact-source, verification and publication order", () => {
  const all = jobs(read(WEB));
  assertOrdered(all.get("authorize"), [
    '"$GITHUB_REPOSITORY" != "instafy-dev/instafy" || "$ACTOR" != "instafy-bot" || "$TRIGGERING_ACTOR" != "instafy-bot"',
    '"$EVENT_NAME" == "push" && "$PUSHER" != "instafy-bot"',
    "^web-v[0-9a-f]{12}(-r([2-9]|[1-9][0-9]))?$",
    'gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"',
    'compare/${GITHUB_SHA}...main" --jq .status',
    "persist-credentials: false",
    "node --test scripts/release/web/*.test.mjs packages/frontend/hosted/performance/client.test.mjs",
    "node scripts/release/web/verify-release-tag.mjs",
    "node scripts/release/web/release-id.mjs",
    "GITHUB_STEP_SUMMARY",
  ]);
  assertOrdered(all.get("build"), [
    "submodules: recursive",
    'test "$(pnpm --version)" = "10.34.5"',
    "node scripts/release/web/browser-safe-config.mjs",
    "pnpm install --frozen-lockfile",
    "node scripts/release/web/build-hosted-web.mjs",
    'node scripts/release/web/verify-hosted-web-artifact.mjs packages/frontend/dist "$SOURCE_SHA"',
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    "node scripts/release/web/gitleaks-release-artifact.mjs --root packages/frontend/dist",
    "--config scripts/public-boundary-gitleaks.toml",
    "--sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner",
    "gzip -n -9",
    "name: hosted-web-${{ needs.authorize.outputs.tag }}",
    "retention-days: ${{ needs.authorize.outputs.mode == 'release' && 90 || 7 }}",
  ]);
  assert.doesNotMatch(all.get("build"), /wrangler|api\.cloudflare\.com/u);
  assertOrdered(all.get("publish"), [
    "actions/download-artifact@",
    "sha256sum --check --strict hosted-frontend.tar.gz.sha256",
    '= "$ARTIFACT_SHA256"',
    "validate-hosted-web-archive.py",
    "--no-same-owner --no-same-permissions",
    "sha256sum --check --strict --quiet artifact-files.sha256",
    "verify-hosted-web-artifact.mjs",
    '= "$RELEASE_ID"',
    "wrangler@4.73.0",
    "node scripts/release/web/tag-state.mjs",
    "deployments?env=production&per_page=20",
    'compare/${previous_commit}...${SOURCE_SHA}',
    "node scripts/release/web/prove-production.mjs served",
    "node scripts/release/web/publication-decision.mjs",
    "if: ${{ steps.decide.outputs.action == 'deploy' }}",
    'echo "mutation_started=true" >> "$GITHUB_OUTPUT"',
    '--project-name "$PAGES_PROJECT" --branch main --commit-hash "$SOURCE_SHA"',
    "node scripts/release/web/prove-production.mjs prove",
    "if: ${{ failure() && steps.pages.outputs.mutation_started == 'true' }}",
    "/rollback",
    "GITHUB_STEP_SUMMARY",
  ]);
  const source = read(WEB);
  assert.equal((source.match(/pages deploy/gu) ?? []).length, 1);
  assert.equal((source.match(/CLOUDFLARE_PAGES_API_TOKEN/gu) ?? []).length, 4);
  assert.doesNotMatch(source, /vars\.(DOWNLOADS_BASE_URL|DESKTOP_DOWNLOADS_PREFIX|INSTAFY_STUDIO_PERFORMANCE_COLLECTOR_ENABLED|STUDIO_PERFORMANCE_APP_ORIGIN)/u);
});

test("lane files carry no private identity or infrastructure strings", () => {
  const files = [WEB, ...listFiles("scripts/release/web"), "packages/frontend/hosted/hostedFrontendFeatureManifest.ts", ...listFiles("packages/frontend/hosted/performance")];
  const forbidden = new RegExp(
    [["mar", "cus"], ["pous", "sette"], ["tiny", "cow"], ["192", "\\.168\\."], ["fri", "tz"], ["instafy-", "native"], ["instafy-", "internal"], ["cla", "ude"], ["happy", "hippo"], ["peer", "bit"]]
      .map((parts) => parts.join(""))
      .join("|"),
    "iu",
  );
  for (const file of files) {
    const match = forbidden.exec(read(file));
    assert.equal(match, null, `${file} contains a forbidden identity string: ${match?.[0]}`);
  }
});
