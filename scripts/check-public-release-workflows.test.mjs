import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workflowRoot = path.join(repositoryRoot, ".github", "workflows");

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowRoot, name), "utf8");
}

function jobSection(source, name, nextName) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing job: ${name}`);
  if (!nextName) {
    return source.slice(start);
  }
  const end = source.indexOf(`  ${nextName}:\n`, start + marker.length);
  assert.notEqual(end, -1, `missing job after ${name}: ${nextName}`);
  return source.slice(start, end);
}

function assertOrdered(source, ...needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `workflow order is missing: ${needle}`);
    cursor = next;
  }
}

test("every external public workflow action is pinned to an exact commit", () => {
  const workflows = fs
    .readdirSync(workflowRoot)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

  for (const name of workflows) {
    const source = readWorkflow(name);
    for (const match of source.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)) {
      const action = match[1];
      assert.match(
        action,
        /@[0-9a-f]{40}$/u,
        `${name} must pin ${action} to a full commit`,
      );
    }
  }
});

test("npm publication is bound to exact protected main and a release environment", () => {
  const source = readWorkflow("publish-provider-contract.yml");
  const authorize = jobSection(source, "authorize", "validate");
  const validate = jobSection(source, "validate", "publish-provider-contract");
  const publish = jobSection(source, "publish-provider-contract");

  assert.match(source, /\n      commit_sha:\n/u);
  assert.match(source, /commit_sha:[\s\S]*required: true/u);
  assert.doesNotMatch(source, /\n      ref:\n/u);
  assert.match(authorize, /GITHUB_REF" != "refs\/heads\/main"/u);
  assert.match(authorize, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(authorize, /REQUESTED_COMMIT" != "\$GITHUB_SHA"/u);
  assert.match(validate, /npm pack --dry-run --ignore-scripts/u);
  assert.match(validate, /persist-credentials: false/u);
  assert.doesNotMatch(validate, /\bsecrets\./u);
  assert.match(publish, /environment: npm-release/u);
  assert.match(publish, /persist-credentials: false/u);
  assert.match(publish, /npm publish --ignore-scripts/u);
  assert.match(
    publish,
    /ref: \$\{\{ needs\.authorize\.outputs\.commit_sha \}\}/u,
  );
  assert.equal(
    [...source.matchAll(/\bsecrets\.NPM_TOKEN\b/gu)].length,
    1,
    "NPM_TOKEN must appear only in the protected publish job",
  );
  assertOrdered(
    publish,
    "environment: npm-release",
    "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
    "npm publish",
  );
});

test("runtime images publish only exact protected main from a fixed namespace", () => {
  const source = readWorkflow("publish-runtime-agent.yml");
  const authorize = jobSection(source, "authorize", "release-approval");
  const approval = jobSection(source, "release-approval", "build-scan-push");
  const publish = jobSection(
    source,
    "build-scan-push",
    "assemble-release-manifest",
  );
  const manifest = jobSection(source, "assemble-release-manifest");

  assert.match(source, /\n      commit_sha:\n/u);
  assert.match(source, /commit_sha:[\s\S]*required: true/u);
  const dispatchInputs = source.slice(
    source.indexOf("    inputs:\n"),
    source.indexOf("\npermissions:\n"),
  );
  assert.doesNotMatch(dispatchInputs, /\n      image_namespace:\n/u);
  assert.match(authorize, /GITHUB_REPOSITORY" != "instafy-dev\/instafy"/u);
  assert.match(authorize, /GITHUB_REF" != "refs\/heads\/main"/u);
  assert.match(authorize, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(authorize, /REQUESTED_COMMIT" != "\$GITHUB_SHA"/u);
  assert.doesNotMatch(authorize, /packages: write/u);

  // Exactly one protected-environment approval gates the whole release.
  assert.equal(
    [...source.matchAll(/environment: ghcr-release/gu)].length,
    1,
    "the ghcr-release environment must gate exactly one job",
  );
  assert.match(approval, /needs: authorize/u);
  assert.match(approval, /environment: ghcr-release/u);
  assert.match(approval, /permissions: \{\}/u);
  assert.doesNotMatch(approval, /packages: write/u);

  // Every flavor×architecture cell builds natively — no QEMU emulation.
  assert.doesNotMatch(source, /setup-qemu/u);
  assert.doesNotMatch(source, /binfmt/u);
  assert.match(publish, /- release-approval/u);
  assert.match(publish, /runs-on: \$\{\{ matrix\.runner \}\}/u);
  assert.match(publish, /runner: ubuntu-24\.04\n/u);
  assert.match(publish, /runner: ubuntu-24\.04-arm\n/u);
  assert.match(publish, /trivy_asset: Linux-64bit/u);
  assert.match(publish, /trivy_asset: Linux-ARM64/u);
  assert.match(
    publish,
    /trivy_sha256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"/u,
  );
  assert.match(
    publish,
    /trivy_sha256: "2ca2c023109c2db6b2b77366b6717291452d4531167377d95c79547f0c8e3467"/u,
  );
  assert.doesNotMatch(publish, /environment:/u);
  assert.match(publish, /packages: write/u);
  assert.match(publish, /IMAGE_NAMESPACE: instafy-dev/u);
  assert.match(publish, /persist-credentials: false/u);
  assert.match(publish, /version: v0\.35\.0/u);
  assert.match(
    publish,
    /ref: \$\{\{ needs\.authorize\.outputs\.commit_sha \}\}/u,
  );
  assert.doesNotMatch(publish, /\$\{\{ github\.sha \}\}/u);
  assertOrdered(
    publish,
    "- name: Build audit image",
    "- name: Scan audit image",
    "- name: Login to GHCR",
    "- name: Push scanned image and record its digest",
  );
  assert.match(
    publish,
    /name: runtime-agent-arch-ref-\$\{\{ matrix\.flavor \}\}-\$\{\{ matrix\.architecture \}\}/u,
  );

  // The downstream job assembles multiarch manifests from immutable digests,
  // so it is a publishing job: registry write via the workflow token only.
  assert.match(manifest, /needs:[\s\S]*- build-scan-push/u);
  assert.match(manifest, /packages: write/u);
  assert.doesNotMatch(manifest, /environment:/u);
  assert.match(manifest, /- name: Validate exactly two architectures per flavor/u);
  assert.match(manifest, /name: runtime-agent-release-manifest/u);
  assert.match(manifest, /coreCommit: EXPECTED_CORE_COMMIT/u);
  assert.match(
    manifest,
    /ghcr\\\.io\\\/instafy-dev\\\/instafy-runtime-agent@sha256:/u,
  );
  assert.match(manifest, /\["linux\/amd64","linux\/arm64"\]/u);
  assertOrdered(
    manifest,
    "- name: Download immutable architecture records",
    "- name: Validate exactly two architectures per flavor",
    "- name: Login to GHCR",
    "- name: Assemble commit-SHA multiarch manifests from immutable digests",
    "- name: Aggregate exact release manifest",
    "- name: Upload runtime-agent release manifest",
  );
  // Channel tags move only on explicit request.
  assertOrdered(
    manifest,
    'if [[ "$UPDATE_CHANNEL_TAGS" == "true" ]]',
    '--tag "$channel_tag"',
  );
});
