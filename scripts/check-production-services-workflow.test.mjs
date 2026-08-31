import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { extractDockerPushDigest } from "./lib/dockerPushDigest.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "publish-production-services.yml",
);

function readWorkflow() {
  return fs.readFileSync(workflowPath, "utf8");
}

function readRuntimeWorkflow() {
  return fs.readFileSync(
    path.join(
      repositoryRoot,
      ".github",
      "workflows",
      "publish-runtime-agent.yml",
    ),
    "utf8",
  );
}

function assertOrdered(source, ...needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `workflow order is missing: ${needle}`);
    cursor = next;
  }
}

test("production services are exact-main, fixed-namespace, amd64 releases", () => {
  const source = readWorkflow();
  assert.match(source, /GITHUB_REPOSITORY" != "instafy-dev\/instafy"/u);
  assert.match(source, /GITHUB_REF" != "refs\/heads\/main"/u);
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(source, /REQUESTED_COMMIT" != "\$GITHUB_SHA"/u);
  assert.match(source, /environment: ghcr-release/u);
  assert.match(source, /packages: write/u);
  assert.match(source, /version: v0\.35\.0/u);
  assert.doesNotMatch(source, /image_namespace/u);
  assert.doesNotMatch(source, /platform linux\/arm64/u);
  assert.match(source, /--platform linux\/amd64/u);
});

test("one protected approval covers the whole exact-SHA service release", () => {
  const source = readWorkflow();

  // The protected environment gate exists exactly once, on a dedicated
  // non-matrix approval job, so one approval covers every matrix row instead
  // of expiring between scheduled batches.
  assert.equal(
    [...source.matchAll(/environment: ghcr-release/gu)].length,
    1,
    "the ghcr-release environment must gate exactly one job",
  );
  assertOrdered(
    source,
    "  release-approval:",
    "needs: authorize",
    "environment: ghcr-release",
    "permissions: {}",
    "- name: Record the approved release commit",
    "  publish:",
  );
  const publishStart = source.indexOf("  publish:\n");
  const publishSection = source.slice(
    publishStart,
    source.indexOf("  manifest:\n", publishStart),
  );
  assert.doesNotMatch(
    publishSection,
    /environment:/u,
    "matrix publishing jobs must not each re-enter the protected environment",
  );
  assert.match(publishSection, /- release-approval/u);
  assert.match(publishSection, /- authorize/u);
  assert.match(publishSection, /packages: write/u);
  assert.match(publishSection, /persist-credentials: false/u);

  const authorizeSection = source.slice(
    source.indexOf("  authorize:\n"),
    source.indexOf("  release-approval:\n"),
  );
  assert.doesNotMatch(authorizeSection, /packages: write/u);
  assert.doesNotMatch(authorizeSection, /environment:/u);

  // Trivy pinning must be enforced in the services workflow too.
  assert.match(
    source,
    /TRIVY_LINUX_X64_SHA256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"/u,
  );
  assert.match(source, /TRIVY_VERSION: "0\.72\.0"/u);
  assertOrdered(
    source,
    "- name: Install pinned Trivy",
    "curl --proto '=https' --tlsv1.2",
    "sha256sum --check --status",
    "tar -xzf",
    'test "$(trivy --version',
  );
});

test("image publication bounds every BuildKit matrix cell", () => {
  const serviceSource = readWorkflow();
  const runtimeSource = readRuntimeWorkflow();
  const serviceStart = serviceSource.indexOf("  publish:\n");
  const runtimeStart = runtimeSource.indexOf("  build-scan-push:\n");
  assert.notEqual(serviceStart, -1);
  assert.notEqual(runtimeStart, -1);

  const serviceSection = serviceSource.slice(
    serviceStart,
    serviceSource.indexOf("  manifest:\n", serviceStart),
  );
  const runtimeSection = runtimeSource.slice(
    runtimeStart,
    runtimeSource.indexOf("  assemble-release-manifest:\n", runtimeStart),
  );

  for (const [name, section] of [
    ["production service", serviceSection],
    ["runtime agent", runtimeSection],
  ]) {
    assert.match(section, /timeout-minutes: 30/u, `${name} build timeout`);
    assert.equal(
      [...section.matchAll(/timeout-minutes:/gu)].length,
      1,
      `${name} build matrix must have exactly one job-level timeout`,
    );
  }
});

test("every service is scanned before registry login and publication", () => {
  const source = readWorkflow();
  assertOrdered(
    source,
    "- name: Build amd64 release candidate",
    "- name: Scan amd64 release candidate",
    "- name: Login to GHCR after the gate passes",
    "- name: Push the scanned image and record its digest",
    "- name: Upload immutable image record",
    "manifest:",
    "- name: Validate and seal the manifest",
  );
  assert.match(source, /--scanners vuln,secret/u);
  assert.match(source, /--severity HIGH,CRITICAL/u);
  assert.match(source, /--exit-code 1/u);
  assert.match(source, /production-service-release-manifest\.sha256/u);
  assert.match(
    source,
    /name: Upload sealed release manifest[\s\S]*?retention-days: 90/u,
  );
});

test("both image workflows parse the tagged digest line emitted by docker push", () => {
  const realisticPushOutput = [
    "The push refers to repository [ghcr.io/instafy-dev/instafy-runtime-agent]",
    "5f70bf18a086: Layer already exists",
    "f1d2d2f924e9: Pushed",
    `0123456789abcdef0123456789abcdef01234567-linux-amd64: digest: sha256:${"a".repeat(64)} size: 2417`,
    "",
  ].join("\n");

  assert.equal(
    extractDockerPushDigest(realisticPushOutput),
    `sha256:${"a".repeat(64)}`,
  );
  assert.throws(
    () =>
      extractDockerPushDigest(
        `${realisticPushOutput}${realisticPushOutput}`,
      ),
    /exactly one Docker push digest line/u,
  );
  assert.throws(
    () => extractDockerPushDigest("latest: digest: sha256:not-a-digest size: 1\n"),
    /exactly one Docker push digest line/u,
  );

  for (const source of [readWorkflow(), readRuntimeWorkflow()]) {
    assert.match(
      source,
      /node scripts\/lib\/dockerPushDigest\.mjs "\$(?:push_log|log)"/u,
    );
    assert.doesNotMatch(source, /s\/\^digest:/u);
  }
});

test("the sealed manifest requires the complete hosted image set", () => {
  const source = readWorkflow();
  for (const key of [
    "controller",
    "proxy",
    "providerService",
    "tunnelBroker",
    "gitEdge",
    "gitShard",
    "originGateway",
  ]) {
    assert.match(source, new RegExp(`key: ${key}\\n`, "u"), key);
  }
  assert.match(
    source,
    /expected_keys='\["controller","gitEdge","gitShard","originGateway","providerService","proxy","tunnelBroker"\]'/u,
  );
  const repositoryByKey = {
    controller: "instafy-runtime-controller",
    gitEdge: "instafy-git-edge",
    gitShard: "instafy-git-shard",
    originGateway: "instafy-origin-gateway",
    providerService: "instafy-runtime-provider-service",
    proxy: "instafy-openai-proxy-server",
    tunnelBroker: "instafy-tunnel-broker",
  };
  for (const [key, repository] of Object.entries(repositoryByKey)) {
    assert.match(
      source,
      new RegExp(`"${key}":"${repository}"`, "u"),
      `${key} must be bound to ${repository}`,
    );
  }
  assert.match(source, /\.releaseTag ==/u);
  assert.match(source, /startswith/u);
  assert.match(source, /malformed, swapped/u);
  // The repository lookup must be bound to a variable BEFORE any pipe: inside
  // `.ref | startswith(...)`, `.` is the ref string, so an inline
  // `$repositories[.key]` there indexes a string and aborts the seal step
  // (first observed live in run 30747167299 after all seven images published).
  assert.match(source, /\(\$repositories\[\.key\]\) as \$repo \|/u);
  assert.doesNotMatch(
    source,
    /startswith\([\s\S]{0,80}\$repositories\[\.key\]/u,
    "repository lookup must not be re-evaluated inside the ref pipe",
  );
});
