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
  const authorize = jobSection(source, "authorize", "publish-runtime-agent");
  const publish = jobSection(
    source,
    "publish-runtime-agent",
    "publish-release-manifest",
  );
  const manifest = jobSection(source, "publish-release-manifest");

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
  assert.match(publish, /environment: ghcr-release/u);
  assert.match(publish, /packages: write/u);
  assert.match(publish, /IMAGE_NAMESPACE: instafy-dev/u);
  assert.match(publish, /persist-credentials: false/u);
  assert.match(
    publish,
    /image: tonistiigi\/binfmt:qemu-v10\.0\.4@sha256:[0-9a-f]{64}/u,
  );
  assert.match(publish, /version: v0\.35\.0/u);
  assert.match(
    publish,
    /ref: \$\{\{ needs\.authorize\.outputs\.commit_sha \}\}/u,
  );
  assert.doesNotMatch(publish, /\$\{\{ github\.sha \}\}/u);
  assertOrdered(
    publish,
    "- name: Build amd64 audit image",
    "- name: Scan amd64 audit image",
    "- name: Build arm64 audit image",
    "- name: Scan arm64 audit image",
    "- name: Login to GHCR",
    "- name: Push only the two scanned images and assemble the release manifest",
  );
  assert.match(publish, /name: runtime-agent-release-ref-\$\{\{ matrix\.flavor \}\}/u);
  assert.match(manifest, /needs:[\s\S]*- publish-runtime-agent/u);
  assert.match(manifest, /name: runtime-agent-release-manifest/u);
  assert.match(manifest, /coreCommit: EXPECTED_CORE_COMMIT/u);
  assert.match(
    manifest,
    /ghcr\\\.io\\\/instafy-dev\\\/instafy-runtime-agent@sha256:/u,
  );
  assert.doesNotMatch(manifest, /packages: write/u);
  assert.doesNotMatch(manifest, /\bsecrets\./u);
  assertOrdered(
    manifest,
    "- name: Download immutable flavor references",
    "- name: Aggregate exact release manifest",
    "- name: Upload runtime-agent release manifest",
  );
});
