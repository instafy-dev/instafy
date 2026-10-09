import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import "./check-hosted-sdk-cleanup.test.mjs";
import "./check-image-coordinator.test.mjs";
import "./check-public-control-ci.test.mjs";
import "./check-merge-queue-ci.test.mjs";
import "./check-image-build-routing.test.mjs";
import "./check-image-scan-workflow.test.mjs";
import "./check-runtime-multiarch-workflow.test.mjs";

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

test("protected main reconciles exact image publication without occupying a waiting worker", () => {
  const source = readWorkflow("continuous-image-publication.yml");

  assert.match(source, /\n  push:\n    branches:\n      - main\n/u);
  assert.match(source, /\n  schedule:\n    - cron: "17 \*\/6 \* \* \*"\n/u);
  assert.match(source, /\n  workflow_dispatch:\n/u);
  assert.match(source, /actions: write/u);
  assert.match(source, /contents: read/u);
  assert.match(source, /cancel-in-progress: false/u);
  // Five minutes for the production steps plus the arm64 lane's own two-minute step bound.
  assert.match(source, /^    timeout-minutes: 7$/mu);
  assert.doesNotMatch(source, /\bsleep\b|\bdeadline\b|wait_for_run/u);
  assert.match(source, /steps\.ci\.outputs\.ready == 'true'/u);
  assert.match(source, /steps\.freshness\.outputs\.pending == 'false'/u);
  assert.match(source, /dispatched, not yet verified/u);
  assert.match(source, /github\.repository == 'instafy-dev\/instafy'/u);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(source, /REQUESTED_COMMIT" != "\$GITHUB_SHA"/u);
  // Build is read by head_sha or, for a Build completion, by its own run ID:
  // GitHub's event-filtered listings are intermittently served stale.
  assert.match(source, /actions\/workflows\/build\.yml\/runs\?head_sha=/u);
  assert.match(source, /actions\/runs\/\$\{build_run_id\}/u);
  assert.doesNotMatch(source, /event=push|event=workflow_dispatch/u);
  assert.match(source, /\n  workflow_run:\n    workflows: \[Public Build\]\n    types: \[completed\]\n    branches: \[main\]\n/u);
  assert.match(source, /X-GitHub-Api-Version: 2026-03-10/u);
  assert.match(source, /\.workflow_run_id/u);
  assert.match(source, /\.event == "workflow_dispatch"/u);
  assert.match(source, /\.head_branch == "main"/u);
  assert.match(source, /\.head_sha == \$sha/u);
  assert.match(source, /production-service-release-manifest/u);
  assert.match(source, /runtime-agent-release-manifest/u);
  assert.match(source, /Reconcile exact publishers and manifest freshness/u);
  assert.match(source, /14 \* 24 \* 60 \* 60/u);
  assert.match(source, /services_publish=\$services_publish/u);
  assert.match(source, /runtime_publish=\$runtime_publish/u);
  assert.match(source, /steps\.freshness\.outputs\.publish == 'true'/u);
  assert.match(source, /PUBLISH_SERVICES: \$\{\{ steps\.freshness\.outputs\.services_publish \}\}/u);
  assert.match(source, /PUBLISH_RUNTIME: \$\{\{ steps\.freshness\.outputs\.runtime_publish \}\}/u);
  const dispatchStart = source.indexOf(
    "      - name: Dispatch missing immutable image publishers without waiting\n",
  );
  const dispatchEnd = source.indexOf(
    "      - name: Report requested immutable image publication\n",
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
  // The amd64 production publisher no longer moves channel tags; only the
  // best-effort arm64 lane is dispatched with them explicitly off.
  assert.doesNotMatch(dispatch, /update_channel_tags/u);
  const lane = source.slice(source.indexOf(
    "      - name: Reconcile the best-effort arm64 lane without blocking production\n",
  ));
  assert.match(lane, /\{"ref":"main","inputs":\{"commit_sha":"\$\{RELEASE_COMMIT\}","update_channel_tags":false\}\}/u);
  assert.equal([...source.matchAll(/update_channel_tags/gu)].length, 1);
  assert.equal([...lane.matchAll(/publish-runtime-agent-multiarch\.yml/gu)].length, 1);
  assert.equal([...source.matchAll(/publish-runtime-agent-multiarch\.yml/gu)].length, 2, "the lane and the header");
  assert.match(lane, /^          retry_cap=4$/mu);
  assert.match(lane, /runtime-agent-multiarch-manifest/u);
  assert.doesNotMatch(source, /\bsecrets\./u);
  assert.doesNotMatch(source, /^\s+pull_request_target:/mu);
  // The one privileged trigger the owner allowed here (2026-09-26): completion
  // of this repository's own protected-main push Build, so publication starts
  // without a manual dispatch. It runs this file from main with actions: write,
  // so the job guard below must stay exact: never a fork, a pull request, or
  // another workflow, and nothing from the triggering run is checked out.
  assert.equal(source.match(/^\s+workflow_run:/gmu)?.length, 1);
  for (const clause of [
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.path == '.github/workflows/build.yml'",
    "github.event.workflow_run.repository.full_name == 'instafy-dev/instafy'",
    "github.event.workflow_run.head_repository.full_name == 'instafy-dev/instafy'",
  ]) assert.ok(source.includes(clause), clause);
  assert.doesNotMatch(source, /actions\/checkout|actions\/download-artifact|workflow_run\.(?:display_title|head_commit)/u);
  assert.equal(
    [...source.matchAll(/publish-production-services\.yml/gu)].length,
    2,
  );
  // The freshness read, the dispatch, and the arm64 lane's read-only check of
  // the production run it must bind to.
  assert.equal(
    [...source.matchAll(/publish-runtime-agent\.yml/gu)].length,
    3,
  );
  const laneStep = source.slice(source.indexOf(
    "      - name: Reconcile the best-effort arm64 lane without blocking production\n",
  ));
  assert.match(laneStep, /^          production_workflow=publish-runtime-agent\.yml$/mu);
  assert.deepEqual([...laneStep.matchAll(/^.*\$\{production_workflow\}.*$/gmu)].map((match) => match[0].trim()), [
    '"repos/${GITHUB_REPOSITORY}/actions/workflows/${production_workflow}/runs" \\',
    'bindable="$(jq -er --arg sha "$RELEASE_COMMIT" --arg path ".github/workflows/${production_workflow}" \'',
    'echo "::warning::The sealed ${production_workflow} release for ${RELEASE_COMMIT} is not exactly one successful first-attempt run, so the arm64 lane cannot bind to it; none was dispatched. Production publication is unaffected."',
  ]);
  assertOrdered(
    source,
    "Authorize the exact current protected-main commit",
    "Inspect exact protected-main CI without waiting",
    "Recheck protected main before publication",
    "Reconcile exact publishers and manifest freshness",
    "Dispatch missing immutable image publishers without waiting",
    "Report requested immutable image publication",
    "Report fresh immutable manifests",
    "Reconcile the best-effort arm64 lane without blocking production",
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
  assertOrdered(
    version,
    "Qualify isolated protected-main control runner",
    "Checkout the exact protected-main event commit",
    "Install the exact dependency graph without lifecycle scripts",
    "Require exact current protected main before bot authorization",
    "Require the dedicated instafy-bot credential",
    "Create or update the Changesets version pull request",
  );

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
  // The channel-tag input stays declared so existing dispatchers remain valid,
  // but this amd64-only release refuses it: channel tags must point at a
  // multi-arch index, which only publish-runtime-agent-multiarch.yml creates.
  assert.match(dispatchInputs, /\n      update_channel_tags:\n[\s\S]*type: boolean\n        default: false\n/u);
  assert.match(authorize, /UPDATE_CHANNEL_TAGS: \$\{\{ inputs\.update_channel_tags \}\}/u);
  assert.match(
    authorize,
    /if \[\[ "\$UPDATE_CHANNEL_TAGS" == "true" \]\]; then\n\s+echo "::error::[^"\n]*publish-runtime-agent-multiarch\.yml[^"\n]*"\n\s+exit 1\n/u,
  );
  assert.equal([...source.matchAll(/inputs\.update_channel_tags/gu)].length, 1);

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

  // Production is amd64 only: two native hosted cells (BUILD's daemon is
  // qualified separately), no emulation, and no arm64 cell, runner or scanner.
  assert.doesNotMatch(source, /setup-qemu/u);
  assert.doesNotMatch(source, /binfmt/u);
  assert.match(publish, /- release-approval/u);
  assert.match(publish, /\|\| matrix\.runner \}\}/u);
  assert.equal([...publish.matchAll(/^            runner: ubuntu-24\.04$/gmu)].length, 2);
  assert.equal([...publish.matchAll(/^            architecture: amd64$/gmu)].length, 2);
  assert.equal([...publish.matchAll(/^            trivy_asset: Linux-64bit$/gmu)].length, 2);
  assert.equal(
    [...publish.matchAll(/^            trivy_sha256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"$/gmu)].length,
    2,
  );
  assert.doesNotMatch(source, /ubuntu-24\.04-arm|linux\/arm64|Linux-ARM64|architecture: arm64|2ca2c023109c2db6b2b77366b6717291452d4531167377d95c79547f0c8e3467/u);
  assert.match(publish, /if \[\[ "\$ARCHITECTURE" != "amd64" \]\]; then/u);
  assert.match(publish, /ARCHITECTURE !== "amd64"/u);
  assert.match(publish, /-linux-amd64\$\/;/u);
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

  // The manifest names the scanned amd64 images themselves. This job only
  // reads the registry: no index, commit tag or channel tag is created here.
  assert.match(manifest, /needs:[\s\S]*- build-scan-push/u);
  assert.match(manifest, /permissions:\n      contents: read\n      packages: read\n/u);
  assert.doesNotMatch(manifest, /packages: write|environment:|imagetools create|channel_tag|UPDATE_CHANNEL_TAGS|:latest/u);
  assert.match(manifest, /- name: Validate exactly one amd64 record per flavor/u);
  assert.match(manifest, /const expected = flavors\.map\(\(flavor\) => `\$\{flavor\}-amd64\.json`\);/u);
  assert.match(manifest, /name: runtime-agent-release-manifest\n/u);
  assert.match(manifest, /retention-days: 90/u);
  assert.match(manifest, /coreCommit: EXPECTED_CORE_COMMIT/u);
  assert.match(
    manifest,
    /const manifest = \{\n\s+schemaVersion: 1,\n\s+coreCommit: EXPECTED_CORE_COMMIT,\n\s+images,\n\s+\};/u,
    "the sealed production manifest keeps the exact v1 shape its consumers read",
  );
  assert.match(
    manifest,
    /ghcr\\\.io\\\/instafy-dev\\\/instafy-runtime-agent@sha256:/u,
  );
  assert.match(manifest, /\] == \["linux\/amd64"\]/u);
  assert.match(manifest, /\.os == "linux" and \.architecture == "amd64"/u);
  assertOrdered(
    manifest,
    "- name: Download immutable architecture records",
    "- name: Validate exactly one amd64 record per flavor",
    "- name: Login to GHCR",
    "- name: Verify each flavor resolves only to the scanned linux/amd64 image",
    "- name: Aggregate exact release manifest",
    "- name: Upload runtime-agent release manifest",
  );
  assert.doesNotMatch(source, /release_tag=|\$\{image\}:\$\{tag_prefix\}\$\{EXPECTED_CORE_COMMIT\}"/u);
});

test("the arm64 lane is a separate, hosted, exact-commit publisher bound to the sealed production release", () => {
  const source = readWorkflow("publish-runtime-agent-multiarch.yml");
  const production = readWorkflow("publish-runtime-agent.yml");
  const authorize = jobSection(source, "authorize", "bind-production-manifest");
  const bind = jobSection(source, "bind-production-manifest", "release-approval");
  const approval = jobSection(source, "release-approval", "build-scan-push-arm64");
  const publish = jobSection(source, "build-scan-push-arm64", "assemble-multiarch");
  const assemble = jobSection(source, "assemble-multiarch");

  // Manual or coordinator dispatch only; no new privileged trigger.
  const trigger = source.slice(source.indexOf("\non:\n") + 1, source.indexOf("\npermissions:\n"));
  assert.match(trigger, /^on:\n  workflow_dispatch:\n    inputs:\n      commit_sha:\n/u);
  assert.match(trigger, /\n      update_channel_tags:\n[\s\S]*type: boolean\n        default: false\n$/u);
  assert.doesNotMatch(trigger, /workflow_run|pull_request|push:|schedule:|repository_dispatch|workflow_call/u);
  assert.match(source, /\npermissions:\n  contents: read\n\nconcurrency:\n  group: publish-runtime-agent-multiarch-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/u);
  assert.deepEqual([...source.matchAll(/^  ([\w-]+):\n    name:/gmu)].map((match) => match[1]),
    ["authorize", "bind-production-manifest", "release-approval", "build-scan-push-arm64", "assemble-multiarch"]);

  // GitHub-hosted runners only, the workflow token only.
  assert.deepEqual([...source.matchAll(/^    runs-on: (.+)$/gmu)].map((match) => match[1]),
    ["ubuntu-latest", "ubuntu-latest", "ubuntu-latest", "${{ matrix.runner }}", "ubuntu-latest"]);
  assert.doesNotMatch(source, /self-hosted|vars\.|instafy-trusted-build|instafy-ci-|driver-opts|setup-qemu|binfmt|continue-on-error/u);
  assert.deepEqual([...source.matchAll(/\bsecrets\.(\w+)/gu)].map((match) => match[1]), ["GITHUB_TOKEN", "GITHUB_TOKEN"]);
  assert.deepEqual([...source.matchAll(/^    permissions:\n((?:      .+\n)+)|^    permissions: \{\}$/gmu)].map((match) => (match[1] ?? "{}").trim().split(/\n\s*/u)), [
    ["actions: read", "contents: read"], ["actions: read", "contents: read"], ["{}"],
    ["contents: read", "packages: write"], ["contents: read", "packages: write"],
  ]);

  // The same exact-current-main binding and its own once-per-commit seal.
  assert.equal(
    authorize.slice(authorize.indexOf("      - name: Bind release to current protected main\n")),
    jobSection(production, "authorize", "release-approval")
      .slice(jobSection(production, "authorize", "release-approval").indexOf("      - name: Bind release to current protected main\n"))
      .replace("          UPDATE_CHANNEL_TAGS: ${{ inputs.update_channel_tags }}\n", "")
      .replace(/          if \[\[ "\$UPDATE_CHANNEL_TAGS" == "true" \]\]; then\n.*\n.*\n          fi\n/u, "")
      .replace("RELEASE_WORKFLOW: publish-runtime-agent.yml", "RELEASE_WORKFLOW: publish-runtime-agent-multiarch.yml"),
  );

  // Bound to exactly one sealed first-attempt production run and its manifest,
  // before the approval and before anything is built.
  assert.match(bind, /^    needs: authorize$/mu);
  assert.match(bind, /PRODUCTION_WORKFLOW: publish-runtime-agent\.yml\n/u);
  assert.match(bind, /PRODUCTION_ARTIFACT: runtime-agent-release-manifest\n/u);
  assert.match(bind, /\.run_attempt == 1/u);
  assert.doesNotMatch(bind, /event=|status=success/u);
  assert.match(approval, /^    needs:\n      - authorize\n      - bind-production-manifest\n/mu);
  assert.equal([...source.matchAll(/environment: ghcr-release/gu)].length, 1);
  assert.match(approval, /environment: ghcr-release/u);
  assert.match(publish, /^    needs:\n      - authorize\n      - release-approval\n/mu);

  // Native arm64 cells only: build, scan and smoke before login, then push.
  assert.equal([...publish.matchAll(/^            runner: ubuntu-24\.04-arm$/gmu)].length, 2);
  assert.equal([...publish.matchAll(/^            architecture: arm64$/gmu)].length, 2);
  assert.equal([...publish.matchAll(/^            trivy_asset: Linux-ARM64$/gmu)].length, 2);
  assert.equal(
    [...publish.matchAll(/^            trivy_sha256: "2ca2c023109c2db6b2b77366b6717291452d4531167377d95c79547f0c8e3467"$/gmu)].length,
    2,
  );
  assert.doesNotMatch(publish, /architecture: amd64|platform: linux\/amd64/u);
  assertOrdered(
    publish,
    "- name: Build audit image",
    "- name: Scan audit image",
    "- name: Prove the webdev image starts the Shared Browser",
    "- name: Login to GHCR",
    "- name: Push scanned image and record its digest",
    "- name: Upload immutable architecture record",
    "- name: Export the scanned build's layer cache",
  );
  assert.match(publish, /if \[\[ "\$ARCHITECTURE" != "arm64" \]\]; then/u);
  assert.match(publish, /-linux-arm64\$\/;/u);

  // The assemble re-scans the reused amd64 digests anonymously, then joins
  // exactly those and this run's arm64 digests into the commit indexes.
  assert.match(assemble, /^    needs:\n      - authorize\n      - bind-production-manifest\n      - build-scan-push-arm64\n/mu);
  assertOrdered(
    assemble,
    "- name: Install pinned Trivy",
    "- name: Re-scan the sealed amd64 images from the registry",
    "- name: Download immutable architecture records",
    "- name: Validate exactly one arm64 record per flavor",
    "- name: Login to GHCR",
    "- name: Assemble commit-SHA multiarch manifests from immutable digests",
    "- name: Aggregate exact multi-arch manifest",
    "- name: Upload runtime-agent multi-arch manifest",
  );
  assert.match(assemble, /\["linux\/amd64","linux\/arm64"\]/u);
  assert.match(assemble, /does not join exactly the sealed amd64 image and this run's arm64 image/u);
  assertOrdered(assemble, 'if [[ "$UPDATE_CHANNEL_TAGS" == "true" ]]', '--tag "$channel_tag"');
  assert.match(assemble, /UPDATE_CHANNEL_TAGS: \$\{\{ inputs\.update_channel_tags \}\}/u);

  // Its artifact can never be mistaken for the production manifest.
  const uploads = [...source.matchAll(/uses: actions\/upload-artifact@\S+ # v4\.6\.2\n        with:\n          name: (.+)\n/gu)]
    .map((match) => match[1]);
  assert.deepEqual(uploads, [
    "runtime-agent-arch-ref-${{ matrix.flavor }}-${{ matrix.architecture }}",
    "runtime-agent-multiarch-manifest",
  ]);
  assert.match(assemble, /name: runtime-agent-multiarch-manifest\n[\s\S]*retention-days: 90/u);
  assert.match(assemble, /kind: "runtime-agent-multiarch"/u);
});
