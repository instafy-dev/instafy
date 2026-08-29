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

function stepSection(source, name, nextName) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing step: ${name}`);
  if (!nextName) {
    return source.slice(start);
  }
  const end = source.indexOf(`      - name: ${nextName}\n`, start + marker.length);
  assert.notEqual(end, -1, `missing step after ${name}: ${nextName}`);
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

test("trusted boundary is restricted to main PR target events", () => {
  const source = readWorkflow("public-boundary.yml");

  assert.match(source, /^name: Trusted Public Boundary$/mu);
  assert.match(
    source,
    /^  pull_request_target:\n    branches:\n      - main\n    types:\n      - opened\n      - synchronize\n      - reopened\n      - ready_for_review\n      - edited\n\nconcurrency:$/mu,
  );
  assert.doesNotMatch(source, /^  pull_request:$/mu);
  assert.doesNotMatch(source, /^  push:$/mu);
  assert.doesNotMatch(source, /^  workflow_dispatch:$/mu);
});

test("trusted boundary token carries the pulls scope the wait step needs", () => {
  const source = readWorkflow("public-boundary.yml");
  // The wait step polls GET /pulls with the workflow token. On an installation
  // token that REQUIRES the explicit pull-requests scope: contents alone 403s,
  // which once burned the whole poll budget and failed every pull request.
  // Job-level permissions override workflow-level, so pin the scope at both.
  const workflowPermissions = source.slice(0, source.indexOf("jobs:"));
  assert.match(workflowPermissions, /pull-requests: read/u);
  const jobPermissions = source.slice(source.indexOf("jobs:"), source.indexOf("steps:"));
  assert.match(jobPermissions, /pull-requests: read/u);
});

test("trusted boundary wait step fails open when the pulls API is inaccessible", () => {
  const source = readWorkflow("public-boundary.yml");
  const wait = stepSection(
    source,
    "Wait for the event-bound merge candidate to be minted",
    "Checkout trusted base controls",
  );
  // The wait is availability-only; the parent verification below is the
  // enforced property. An inaccessible pulls API (permissions regression, API
  // outage) must skip the wait with a warning — never fail the check for
  // every pull request.
  assert.match(wait, /if ! api_body=/u);
  assert.match(wait, /::warning::pulls API not accessible/u);
  const failOpen = wait.slice(wait.indexOf("::warning::pulls API not accessible"));
  assert.match(failOpen.slice(0, failOpen.indexOf("candidate_oid=")), /exit 0/u);
});

test("trusted boundary waits for a fresh merge candidate before any checkout", () => {
  const source = readWorkflow("public-boundary.yml");
  const wait = stepSection(
    source,
    "Wait for the event-bound merge candidate to be minted",
    "Checkout trusted base controls",
  );

  // The wait step exists because refs/pull/N/merge is minted asynchronously:
  // a checkout taken before the re-mint binds the previous head and turns the
  // parent verification into a false failure (issue #99). It must run before
  // both checkouts, read only the pulls API with the workflow token, and bind
  // the candidate's head parent to this event's head.
  assertOrdered(
    source,
    "Wait for the event-bound merge candidate to be minted",
    "Checkout trusted base controls",
    "Checkout server-generated merge candidate as data",
    "Verify the event-bound merge object and parents",
  );
  assert.match(
    wait,
    /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/u,
  );
  assert.match(
    wait,
    /EXPECTED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(wait, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(wait, /\[\[ "\$PR_NUMBER" =~ \^\[0-9\]\+\$ \]\]/u);
  assert.match(wait, /\[\[ "\$EXPECTED_HEAD_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u);
  assert.match(wait, /pulls\/\$\{PR_NUMBER\}/u);
  assert.match(wait, /git\/commits\/\$\{candidate_oid\}/u);
  // The head parent is parents[1]: parents[0] is the base tip. Polling the
  // wrong parent would wait on a condition that never becomes true.
  assert.match(wait, /\.parents\[1\]\.sha/u);
  assert.match(wait, /"\$head_parent" == "\$EXPECTED_HEAD_SHA"/u);
  // The loop must be bounded and end in an explicit, actionable error.
  assert.match(wait, /seq 1 \d+/u);
  assert.match(wait, /::error::No merge candidate bound to head/u);
  // The wait must never check anything out or add a pinned action: the
  // two-checkout inventory asserted below stays exhaustive.
  assert.doesNotMatch(wait, /uses:/u);
  assert.doesNotMatch(wait, /checkout@/u);
});

test("trusted boundary checkouts are separate, pinned, and non-persistent", () => {
  const source = readWorkflow("public-boundary.yml");
  const trustedCheckout = stepSection(
    source,
    "Checkout trusted base controls",
    "Checkout server-generated merge candidate as data",
  );
  const candidateCheckout = stepSection(
    source,
    "Checkout server-generated merge candidate as data",
    "Verify the event-bound merge object and parents",
  );

  assert.doesNotMatch(source, /\bsecrets\./u);
  assert.doesNotMatch(source, /^\s+[A-Za-z_-]+:\s+write\s*$/mu);
  assert.doesNotMatch(source, /actions\/cache|setup-node|setup-go|action-setup/iu);
  assert.doesNotMatch(source, /\bpersist-credentials:\s*true\b/iu);
  assert.doesNotMatch(source, /\bsubmodules:\s*(?:true|recursive)\b/iu);
  assert.doesNotMatch(source, /\blfs:\s*true\b/iu);

  const actions = [
    ...source.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu),
  ].map((match) => match[1]);
  assert.deepEqual(actions, [
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  ]);

  assert.match(
    trustedCheckout,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(trustedCheckout, /path: trusted/u);
  assert.match(trustedCheckout, /persist-credentials: false/u);
  assert.match(trustedCheckout, /submodules: false/u);
  assert.match(trustedCheckout, /lfs: false/u);
  assert.doesNotMatch(trustedCheckout, /allow-unsafe-pr-checkout/u);

  assert.match(candidateCheckout, /repository: \$\{\{ github\.repository \}\}/u);
  assert.match(
    candidateCheckout,
    /ref: refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge/u,
  );
  assert.match(candidateCheckout, /path: candidate/u);
  assert.match(candidateCheckout, /persist-credentials: false/u);
  assert.match(candidateCheckout, /submodules: false/u);
  assert.match(candidateCheckout, /lfs: false/u);
  assert.match(candidateCheckout, /allow-unsafe-pr-checkout: true/u);
  assert.doesNotMatch(source, /pull_request\.head\.repo|github\.head_ref/iu);
});

test("trusted boundary binds the server merge ref to both event parents", () => {
  const source = readWorkflow("public-boundary.yml");
  const verification = stepSection(
    source,
    "Verify the event-bound merge object and parents",
    "Install pinned Gitleaks",
  );

  assert.match(
    verification,
    /EXPECTED_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(
    verification,
    /EXPECTED_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u,
  );
  assert.match(
    verification,
    /EXPECTED_MERGE_SHA: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/u,
  );
  // Rejections must be diagnosable: the bare assertion lines stay, and the
  // ERR trap names the failing command in the run annotations (issue #99).
  assert.match(
    verification,
    /trap 'echo "::error::merge object verification failed on: \$\{BASH_COMMAND\}"' ERR/u,
  );
  assert.match(
    verification,
    /\[\[ "\$actual_merge_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u,
  );
  assert.match(
    verification,
    /rev-parse --verify "HEAD\^\{commit\}"/u,
  );
  assert.match(
    verification,
    /cat-file commit "\$actual_merge_sha" \|[\s\S]*sed -n '\/\^\$\/q; s\/\^parent \/\/p'/u,
  );
  assert.match(
    verification,
    /test "\$\{#parent_shas\[@\]\}" -eq 2/u,
  );
  // The head parent stays an exact binding: it is what proves the candidate
  // holds this pull request's code.
  assert.match(
    verification,
    /test "\$\{parent_shas\[1\]\}" = "\$EXPECTED_HEAD_SHA"/u,
  );
  // The base parent must be bound to base-branch history, not to the frozen
  // payload base.sha — that equality made a pull request permanently
  // unmergeable once the base branch advanced. Containment must be resolved
  // against the branch, and only identical/ahead may pass.
  assert.doesNotMatch(
    verification,
    /test "\$\{parent_shas\[0\]\}" = "\$EXPECTED_BASE_SHA"/u,
  );
  assert.match(
    verification,
    /compare\/\$\{parent_shas\[0\]\}\.\.\.\$\{BASE_REF\}/u,
  );
  assert.match(verification, /identical\|ahead\)/u);
  assert.doesNotMatch(verification, /identical\|ahead\|behind\)/u);
  assert.match(
    verification,
    /is not part of \$\{BASE_REF\} history/u,
  );
  assert.doesNotMatch(verification, /show -s --format='%H %P'/u);
  // The parents binding is the load-bearing check. A strict equality against
  // the payload's merge OID must NOT come back: GitHub re-mints the merge ref
  // lazily (same parents, new timestamp => new OID), so that equality fails on
  // timing alone and turns the required gate into a coin flip.
  assert.doesNotMatch(
    verification,
    /test "\$actual_merge_sha" = "\$EXPECTED_MERGE_SHA"/u,
  );
  assert.match(
    verification,
    /if \[\[ -n "\$EXPECTED_MERGE_SHA" \]\]; then[\s\S]*\[\[ "\$EXPECTED_MERGE_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\][\s\S]*fi/u,
  );
});

test("candidate code is never installed, imported, sourced, cached, or executed", () => {
  const source = readWorkflow("public-boundary.yml");

  assert.match(
    source,
    /node --test[\s\S]*"\$TRUSTED_ROOT\/scripts\/check-public-boundary\.test\.mjs"[\s\S]*"\$TRUSTED_ROOT\/scripts\/check-public-boundary-workflow\.test\.mjs"/u,
  );
  assert.match(
    source,
    /node "\$TRUSTED_ROOT\/scripts\/check-public-boundary\.mjs"/u,
  );
  assert.match(
    source,
    /--policy "\$TRUSTED_ROOT\/scripts\/public-boundary-policy\.json"/u,
  );
  assert.doesNotMatch(source, /node "\$CANDIDATE_ROOT/u);
  assert.doesNotMatch(
    source,
    /\b(?:npm|pnpm|yarn|bun|deno|cargo|gradle|make|docker)\b/iu,
  );
  assert.doesNotMatch(source, /\b(?:source|eval)\b/iu);
  assert.doesNotMatch(source, /working-directory:/iu);
  assert.doesNotMatch(source, /\b(?:bash|sh|python|ruby)\s+["']?\$CANDIDATE_ROOT/iu);
});

test("pinned Gitleaks scans paths and a path-independent tracked-file stream", () => {
  const source = readWorkflow("public-boundary.yml");
  const pathAwareScan = stepSection(
    source,
    "Scan candidate tree with path-aware Gitleaks rules",
    "Scan every tracked file without path allowlists",
  );
  const pathIndependentScan = stepSection(
    source,
    "Scan every tracked file without path allowlists",
  );
  const encodedMarkerProbe = stepSection(
    source,
    "Prove encoded private marker detection",
    "Scan candidate tree with path-aware Gitleaks rules",
  );

  assert.match(source, /GITLEAKS_VERSION: "8\.30\.1"/u);
  assert.match(
    source,
    /GITLEAKS_LINUX_X64_SHA256: "[0-9a-f]{64}"/u,
  );
  assert.match(source, /sha256sum --check --status/u);
  assert.match(encodedMarkerProbe, /printf '%s' 'inter''nal\.instafy\.dev'/u);
  assert.match(encodedMarkerProbe, /\| base64 \| tr -d '\\n'/u);
  assert.match(encodedMarkerProbe, /"\$RUNNER_TEMP\/gitleaks" stdin/u);
  assert.match(encodedMarkerProbe, /exit 1/u);
  assert.match(
    source,
    /--config "\$TRUSTED_ROOT\/scripts\/public-boundary-gitleaks\.toml"/u,
  );
  assert.match(source, /"\$RUNNER_TEMP\/gitleaks" dir/u);
  assert.match(source, /"\$RUNNER_TEMP\/gitleaks" stdin/u);
  assert.match(
    source,
    /git -C "\$CANDIDATE_ROOT" ls-files --cached -z > "\$candidate_inventory"/u,
  );
  assert.match(source, /test -s "\$candidate_inventory"/u);
  assert.doesNotMatch(pathIndependentScan, /\bcontinue\b/u);
  assert.match(
    pathIndependentScan,
    /--config scripts\/public-boundary-gitleaks-stream\.toml/u,
  );
  assert.match(
    source,
    /\[\[ -f "\$candidate_file" && ! -L "\$candidate_file" \]\]/u,
  );
  assert.match(source, /cat -- "\$candidate_file"/u);

  for (const flag of [
    "--config",
    "--gitleaks-ignore-path",
    "--ignore-gitleaks-allow",
    "--max-archive-depth=1",
    "--max-decode-depth=3",
    "--max-target-megabytes=0",
    "--redact=100",
    "--timeout=110",
  ]) {
    assert.ok(
      pathAwareScan.includes(flag),
      `path-aware scan is missing ${flag}`,
    );
    assert.ok(
      pathIndependentScan.includes(flag),
      `path-independent scan is missing ${flag}`,
    );
  }

  assertOrdered(
    source,
    "Run trusted public boundary regression tests",
    "Enforce trusted public boundary policy",
    "Prove encoded private marker detection",
    "Scan candidate tree with path-aware Gitleaks rules",
    "Scan every tracked file without path allowlists",
  );
});

test("Gitleaks marker rules decode private values without path-broad secret allowances", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "public-boundary-gitleaks.toml"),
    "utf8",
  );
  const streamSource = fs.readFileSync(
    path.join(
      repositoryRoot,
      "scripts",
      "public-boundary-gitleaks-stream.toml",
    ),
    "utf8",
  );

  for (const ruleId of [
    "instafy-absolute-personal-path",
    "instafy-private-network",
    "instafy-private-host",
    "instafy-github-token-prefix",
    "instafy-private-package",
    "instafy-browser-service-role",
    "instafy-private-product",
  ]) {
    assert.match(source, new RegExp(`^id = "${ruleId}"$`, "mu"));
  }
  assert.doesNotMatch(source, /^\[\[allowlists\]\]$/mu);
  assert.equal([...source.matchAll(/^\s+paths =/gmu)].length, 1);
  assert.match(
    source,
    /paths = \['''\(\?:\^\|\/\)packages\/provider-contract/u,
  );
  assert.match(
    streamSource,
    /^path = "scripts\/public-boundary-gitleaks\.toml"$/mu,
  );
  assert.match(
    streamSource,
    /^disabledRules = \["instafy-private-product"\]$/mu,
  );
});

test("CODEOWNERS binds every public-boundary control to the security maintainer", () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, ".github", "CODEOWNERS"),
    "utf8",
  );
  for (const protectedPath of [
    "/.github/",
    "/scripts/check-public-boundary.mjs",
    "/scripts/check-public-boundary.test.mjs",
    "/scripts/check-public-boundary-workflow.test.mjs",
    "/scripts/public-boundary-gitleaks.toml",
    "/scripts/public-boundary-gitleaks-stream.toml",
    "/scripts/public-boundary-policy.json",
    "/.gitattributes",
    "/.gitmodules",
    "/codex",
  ]) {
    assert.match(
      source,
      new RegExp(
        `^${protectedPath.replaceAll(".", String.raw`\.`)} @instafy-bot$`,
        "mu",
      ),
    );
  }
});

test("Public Build delegates PR gating but verifies controls before scanning main", () => {
  const source = readWorkflow("build.yml");
  const secretScan = jobSection(source, "secret-scan", "javascript");
  const javascript = jobSection(source, "javascript", "go");

  assert.match(secretScan, /name: Secret scan/u);
  assert.match(
    secretScan,
    /github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/u,
  );
  assert.match(secretScan, /github\.ref == 'refs\/heads\/main'/u);
  assert.doesNotMatch(secretScan, /PULL_REQUEST_BASE_SHA|pull_request\.base/u);
  assertOrdered(
    secretScan,
    "Test public boundary controls",
    "scripts/check-public-boundary.test.mjs",
    "scripts/check-public-boundary-workflow.test.mjs",
    "Enforce public repository boundary",
    "Scan the complete current tree",
    "Scan tracked bytes without path allowlists",
    "Scan introduced commits",
  );
  assert.match(
    secretScan,
    /--config "\$GITHUB_WORKSPACE\/scripts\/public-boundary-gitleaks-stream\.toml"/u,
  );
  assert.match(
    javascript,
    /node --test \\\n\s+scripts\/check-public-boundary-workflow\.test\.mjs/u,
  );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.match(
    manifest.scripts["test:public-boundary"],
    /check-public-boundary-workflow\.test\.mjs/u,
  );
});
