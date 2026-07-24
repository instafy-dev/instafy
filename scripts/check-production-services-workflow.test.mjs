import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
});
