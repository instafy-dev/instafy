import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import "./check-hosted-sdk-cleanup.test.mjs";

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
      if (action.startsWith("./")) {
        // A relative reusable workflow is loaded from this exact tested
        // checkout; it cannot carry an external ref. Keep the exemption
        // narrow and reject traversal, local action loading, or missing files.
        assert.match(action, /^\.\/\.github\/workflows\/[a-z0-9-]+\.ya?ml$/u);
        assert.ok(fs.statSync(path.join(repositoryRoot, action)).isFile());
        continue;
      }
      assert.match(
        action,
        /@[0-9a-f]{40}$/u,
        `${name} must pin ${action} to a full commit`,
      );
    }
  }
});

test("protected main publishes both exact image manifests only after CI", () => {
  const source = readWorkflow("continuous-image-publication.yml");

  assert.match(source, /\n  push:\n    branches:\n      - main\n/u);
  assert.match(source, /\n  schedule:\n    - cron: "17 \*\/6 \* \* \*"\n/u);
  assert.match(source, /\n  workflow_dispatch:\n/u);
  assert.match(source, /actions: write/u);
  assert.match(source, /contents: read/u);
  assert.match(source, /cancel-in-progress: false/u);
  assert.match(source, /timeout-minutes: 180/u);
  assert.match(source, /github\.repository == 'instafy-dev\/instafy'/u);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(source, /REQUESTED_COMMIT" != "\$GITHUB_SHA"/u);
  assert.match(source, /actions\/workflows\/build\.yml\/runs\?event=push&head_sha=/u);
  assert.match(source, /X-GitHub-Api-Version: 2026-03-10/u);
  assert.match(source, /\.workflow_run_id/u);
  assert.match(source, /\.event == "workflow_dispatch"/u);
  assert.match(source, /\.head_branch == "main"/u);
  assert.match(source, /\.head_sha == \$sha/u);
  assert.match(source, /production-service-release-manifest/u);
  assert.match(source, /runtime-agent-release-manifest/u);
  assert.match(source, /Check exact manifest freshness/u);
  assert.match(source, /14 \* 24 \* 60 \* 60/u);
  assert.match(source, /services_publish=\$services_publish/u);
  assert.match(source, /runtime_publish=\$runtime_publish/u);
  assert.match(source, /steps\.freshness\.outputs\.publish == 'true'/u);
  assert.match(source, /PUBLISH_SERVICES: \$\{\{ steps\.freshness\.outputs\.services_publish \}\}/u);
  assert.match(source, /PUBLISH_RUNTIME: \$\{\{ steps\.freshness\.outputs\.runtime_publish \}\}/u);
  const dispatchStart = source.indexOf(
    "      - name: Dispatch stale immutable image publishers\n",
  );
  const dispatchEnd = source.indexOf(
    "      - name: Require both exact image manifests\n",
  );
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
  const dispatch = source.slice(dispatchStart, dispatchEnd);
  assert.equal([...dispatch.matchAll(/publish-production-services\.yml/gu)].length, 1);
  assert.equal([...dispatch.matchAll(/publish-runtime-agent\.yml/gu)].length, 1);
  assert.match(
    dispatch,
    /if \[\[ "\$PUBLISH_SERVICES" == "true" \]\]; then\n\s+services="\$\([\s\S]*?publish-production-services\.yml/u,
  );
  assert.match(
    dispatch,
    /if \[\[ "\$PUBLISH_RUNTIME" == "true" \]\]; then\n\s+runtime="\$\([\s\S]*?publish-runtime-agent\.yml/u,
  );
  assert.match(source, /Report fresh immutable manifests/u);
  assert.match(source, /\\"update_channel_tags\\":false/u);
  assert.doesNotMatch(source, /\bsecrets\./u);
  assert.doesNotMatch(source, /^\s+pull_request_target:|^\s+workflow_run:/mu);
  assert.equal(
    [...source.matchAll(/publish-production-services\.yml/gu)].length,
    3,
  );
  assert.equal(
    [...source.matchAll(/publish-runtime-agent\.yml/gu)].length,
    3,
  );
  assertOrdered(
    source,
    "Authorize the exact current protected-main commit",
    "Wait for exact protected-main CI",
    "Recheck protected main before publication",
    "Check exact manifest freshness",
    "Dispatch stale immutable image publishers",
    "Require both exact image manifests",
  );
});

test("Changesets separates pull-request, version, pack, and npm publish authority", () => {
  const source = readWorkflow("npm-release.yml");
  const pullRequest = jobSection(source, "pull-request-policy", "select");
  const select = jobSection(source, "select", "version");
  const version = jobSection(source, "version", "pack");
  const pack = jobSection(source, "pack", "publish");
  const publish = jobSection(source, "publish");

  assert.doesNotMatch(source, /pull_request_target/u);
  const pullRequestTrigger = source.slice(
    source.indexOf("  pull_request:\n"),
    source.indexOf("  push:\n"),
  );
  assert.doesNotMatch(pullRequestTrigger, /paths:/u);
  const pushTrigger = source.slice(source.indexOf("  push:\n"), source.indexOf("  workflow_dispatch:\n"));
  assert.doesNotMatch(pushTrigger, /paths:/u);
  assert.match(source, /permissions: \{\}/u);
  assert.match(source, /cancel-in-progress: false/u);
  assert.match(source, /queue: max/u);
  assert.match(pullRequest, /permissions:\n      contents: read/u);
  assert.doesNotMatch(pullRequest, /\bsecrets\./u);
  assert.match(pullRequest, /check-changeset-pr\.mjs/u);
  assert.match(pullRequest, /changeset-release\/main/u);
  assert.match(pullRequest, /PULL_REQUEST_AUTHOR" == "instafy-bot"/u);

  assert.match(
    select,
    /changesets\/action\/select-mode@198f833dd7d863100ea6e28967bc9a9fdefadb0a/u,
  );
  assert.match(select, /current_sha[\s\S]*GITHUB_SHA/u);
  assert.doesNotMatch(select, /\bsecrets\./u);
  assert.doesNotMatch(select, /cache:/u);

  assert.match(
    version,
    /changesets\/action\/version@198f833dd7d863100ea6e28967bc9a9fdefadb0a/u,
  );
  assert.match(version, /github-token: \$\{\{ secrets\.INSTAFY_BOT_TOKEN \}\}/u);
  assert.match(version, /pr-draft: create/u);
  assert.match(version, /push-with-git-cli: false/u);
  assert.doesNotMatch(version, /id-token: write/u);
  assert.doesNotMatch(version, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.doesNotMatch(version, /cache:/u);

  assert.match(pack, /needs\.select\.outputs\.publish-plan-artifact-id/u);
  assert.match(pack, /pnpm --filter @instafy\/cli test:package/u);
  assert.match(pack, /npm pack --dry-run --ignore-scripts/u);
  assert.match(pack, /pnpm changeset pack/u);
  assert.match(pack, /verify-changeset-pack\.mjs/u);
  assert.match(pack, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  assert.equal(
    [
      ...source.matchAll(
        /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/gu,
      ),
    ].length,
    2,
    "both release artifact downloads must use the raw-artifact-aware v8 action",
  );
  assert.doesNotMatch(pack, /\bsecrets\.|id-token: write|npm publish/u);
  assert.doesNotMatch(pack, /cache:/u);

  assert.match(publish, /environment: npm-release/u);
  assert.match(publish, /id-token: write/u);
  assert.match(publish, /contents: read/u);
  assert.doesNotMatch(publish, /contents: write/u);
  assert.match(publish, /needs\.pack\.outputs\.artifact-id/u);
  assert.match(publish, /pnpm exec npm --version/u);
  assert.match(publish, /Seal publication to the canonical npm registry/u);
  assert.match(publish, /test ! -e packages\/instafy-cli\/\.npmrc/u);
  assert.match(publish, /pnpm config get '@instafy:registry'/u);
  assert.match(publish, /--registry before/u);
  assert.match(publish, /pnpm changeset publish/u);
  assert.match(publish, /--from-pack-dir/u);
  assert.match(publish, /--no-git-tag/u);
  assert.match(publish, /--registry after/u);
  assert.match(publish, /test -z "\$\{NPM_TOKEN:-\}"/u);
  assert.match(publish, /test -z "\$\{NODE_AUTH_TOKEN:-\}"/u);
  assert.doesNotMatch(publish, /\bsecrets\.NPM_TOKEN\b|pnpm .*build|test:package|cache:/u);
  assert.equal(
    [...source.matchAll(/\bsecrets\.INSTAFY_BOT_TOKEN\b/gu)].length,
    2,
    "the bot credential is limited to the version job preflight and action",
  );
  assert.doesNotMatch(source, /\bsecrets\.NPM_TOKEN\b/u);
  assertOrdered(
    publish,
    "Require the approved commit to remain current protected main",
    "Seal publication to the canonical npm registry",
    "Install the exact release toolchain without lifecycle scripts",
    "Download the exact tested pack by immutable artifact id",
    "Refuse registry collisions before publishing",
    "Publish the unchanged tarballs with npm trusted publishing",
    "Verify npm exposes the exact published bytes",
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
  assert.match(authorize, /actions: read/u);
  assert.match(authorize, /Refuse duplicate exact-SHA publication/u);
  assert.match(authorize, /GITHUB_RUN_ATTEMPT" != "1"/u);
  assert.match(authorize, /actions\/workflows\/\$\{RELEASE_WORKFLOW\}\/runs/u);
  assert.match(authorize, /\.conclusion == "success"/u);
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
