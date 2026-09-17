// Structural guard for .github/workflows/desktop-release.yml and its lane
// tooling. Plain text parsing on purpose: no YAML dependency is needed to pin
// triggers, runners, environments, secret placement and publication order.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const laneDir = import.meta.dirname;
const repositoryRoot = path.resolve(laneDir, "..", "..", "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "desktop-release.yml");
const source = fs.readFileSync(workflowPath, "utf8");
const publishScript = fs.readFileSync(path.join(laneDir, "publish-downloads.sh"), "utf8");
const verifyScript = fs.readFileSync(path.join(laneDir, "verify-release-tag.mjs"), "utf8");

const JOBS = ["authorize", "preflight", "build", "launch_smoke", "personal_browser_canary", "publish"];
const ENVIRONMENT_JOBS = ["preflight", "build", "personal_browser_canary", "publish"];
const RUNNERS = {
  authorize: "ubuntu-24.04",
  preflight: "ubuntu-24.04",
  build: "macos-15",
  launch_smoke: "macos-15",
  personal_browser_canary: "macos-15",
  publish: "ubuntu-24.04",
};
const SECRET_ENV_NAMES = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CODEX_MACHINE_AUTH",
  "SUPABASE_SERVICE_ROLE_KEY",
];
// Assembled from pieces so this guard does not itself contain the markers.
const IDENTITY_SCRUB = new RegExp(
  [
    ["mar", "cus"],
    ["pous", "sette"],
    ["tiny", "cow"],
    ["192\\.", "168\\."],
    ["fri", "tz"],
    ["instafy-", "native"],
    ["instafy-", "internal"],
    ["Mar", "cuss"],
  ]
    .map((parts) => parts.join(""))
    .join("|"),
  "iu",
);

function topLevelBlock(name) {
  const match = new RegExp(`^${name}:\\n((?:(?: .*)?\\n)*)`, "mu").exec(source);
  assert.ok(match, `missing top-level ${name}`);
  return match[1];
}

function jobs() {
  const body = topLevelBlock("jobs");
  const starts = [...body.matchAll(/^ {2}([a-z_]+):\n/gmu)];
  return Object.fromEntries(
    starts.map((match, index) => [match[1], body.slice(match.index, starts[index + 1]?.index ?? body.length)]),
  );
}

function assertOrdered(text, needles, label) {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `${label}: expected ${JSON.stringify(needle)} after the previous check`);
    cursor = next;
  }
}

test("triggers are exactly the tag push and a main dispatch with tag and dry_run", () => {
  assert.equal(
    topLevelBlock("on"),
    [
      "  push:",
      "    tags: ['desktop-app-v*']",
      "  workflow_dispatch:",
      "    inputs:",
      "      tag: { description: 'Release tag (existing, or the intended tag name for a dry run)', required: true, type: string }",
      "      dry_run: { description: 'Build, sign and verify but publish nothing', required: false, type: boolean, default: true }",
      "",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(source, /^\s*(?:pull_request|pull_request_target|workflow_run|schedule|repository_dispatch|workflow_call)\s*:/mu);
  assert.doesNotMatch(source, /pull_request_target/u);
});

test("top-level permissions, concurrency and shell defaults are minimal and fixed", () => {
  assert.equal(topLevelBlock("permissions"), "  contents: read\n\n");
  assert.equal(topLevelBlock("concurrency"), "  group: desktop-release\n  cancel-in-progress: false\n\n");
  assert.equal(topLevelBlock("defaults"), "  run:\n    shell: bash\n\n");
});

test("jobs run on literal hosted runners only", () => {
  const all = jobs();
  assert.deepEqual(Object.keys(all), JOBS);
  for (const [name, body] of Object.entries(all)) {
    const runsOn = [...body.matchAll(/^ {4}runs-on: (.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(runsOn, [RUNNERS[name]], `${name} runs-on`);
    assert.match(body, /^ {4}timeout-minutes: \d+$/mu, `${name} timeout`);
    assert.match(body, /^ {4}permissions:\n/mu, `${name} permissions`);
  }
  assert.doesNotMatch(source, /self-hosted|runner\.environment|^\s+group:\s*instafy|runs-on:\s*\$\{\{/mu);
  for (const name of ["build", "launch_smoke", "personal_browser_canary"]) {
    assert.match(all[name], /\[\[ "\$RUNNER_ARCH" == "ARM64" \]\]/u, `${name} must assert ARM64`);
  }
});

test("environments, secrets and write permission are confined to their jobs", () => {
  const all = jobs();
  for (const [name, body] of Object.entries(all)) {
    const environments = [...body.matchAll(/^\s+environment:\s*(.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(environments, ENVIRONMENT_JOBS.includes(name) ? ["desktop-release"] : [], `${name} environment`);
    if (!ENVIRONMENT_JOBS.includes(name)) {
      assert.doesNotMatch(body, /secrets\./u, `${name} must not reference secrets`);
    }
    const writes = body.match(/contents: write/gu) ?? [];
    assert.equal(writes.length, name === "publish" ? 1 : 0, `${name} contents: write`);
    assert.doesNotMatch(body, /(?:actions|id-token|packages|deployments|pull-requests|issues): write/u);
  }
  assert.match(all.publish, /^ {4}permissions:\n {6}contents: write\n/mu);
  for (const line of source.split("\n").filter((value) => value.includes("secrets."))) {
    assert.match(line, /^ {10}[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/u, `secret must be a step env mapping: ${line.trim()}`);
  }
  assert.doesNotMatch(source, /secrets\.(?:GITHUB_TOKEN|[A-Z_]*BOT_TOKEN|RELEASE_FREEZE)/u);
  assert.doesNotMatch(all.build.split("Build signed and notarized macOS release")[1].split("- name:")[0], /CSC_LINK/u);
});

test("secret values are never echoed, traced or placed in arguments of logging commands", () => {
  const names = SECRET_ENV_NAMES.join("|");
  const echoed = new RegExp(`\\b(?:echo|printf)\\b[^\\n]*\\$\\{?(?:${names})\\b`, "u");
  for (const line of source.split("\n").filter((value) => echoed.test(value))) {
    assert.match(line, /^\s+printf '%s' "\$(?:CSC_LINK|CODEX_MACHINE_AUTH)" (?:> "[^"]+"|\| base64 -d > "[^"]+")/u, `unsafe secret output: ${line.trim()}`);
  }
  assert.doesNotMatch(source, /set -x|ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG/u);
  const steps = source.split(/\n\s+- (?:name|uses|if):/u);
  for (const step of steps.filter((value) => /secrets\.(?:CSC_|CODEX_MACHINE_AUTH)/u.test(value) && /run: \|/u.test(value))) {
    assert.match(step, /set \+x/u, "steps that handle key material must disable tracing");
  }
});

test("every run block is strict bash and every action is pinned", () => {
  const runs = [...source.matchAll(/^(\s+)run: (.*)$/gmu)];
  assert.ok(runs.length > 0);
  for (const match of runs) {
    assert.equal(match[2], "|", "run steps must be block scalars");
    const next = source.slice(match.index + match[0].length + 1).split("\n")[0];
    assert.match(next, /^\s+set -euo pipefail$/u);
  }
  for (const match of source.matchAll(/^\s+(?:- )?uses: ([^\s#]+)/gmu)) {
    assert.match(match[1], /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/u, `${match[1]} must be pinned`);
  }
});

test("authorize checks actor, pusher, tag commit, main ancestry, version and one-shot probes in order", () => {
  const { authorize } = jobs();
  assert.doesNotMatch(authorize, /environment:|secrets\./u);
  assertOrdered(
    authorize,
    [
      "PUSHER_NAME: ${{ github.event.pusher.name }}",
      'verify-release-tag.mjs" request',
      "git/ref/tags/${TAG}",
      "compare/${COMPARE_BASE}...main",
      'verify-release-tag.mjs" resolve',
      "ref: '${{ steps.resolve.outputs.source_sha }}'",
      "HEAD_SHA=\"$(git -C source rev-parse HEAD)\"",
      'verify-release-tag.mjs" source',
      "scripts/create-desktop-release-metadata.test.mjs scripts/verify-desktop-publication.test.mjs",
      "packages/downloads-worker/test/index.test.mjs",
      "latest.json?run=",
      "stable-pointer-contract.json?run=",
      "releases/tags/${TAG}",
      'verify-release-tag.mjs" one-shot',
      "GITHUB_STEP_SUMMARY",
    ],
    "authorize",
  );
  assert.match(verifyScript, /RELEASE_BOT = "instafy-bot"/u);
  assert.match(verifyScript, /RELEASE_REPOSITORY = "instafy-dev\/instafy"/u);
  assert.match(verifyScript, /input\.pusher !== RELEASE_BOT/u);
  assert.match(verifyScript, /input\.ref !== "refs\/heads\/main"/u);
  assert.match(verifyScript, /\["identical", "ahead"\]\.includes\(input\.compareStatus\)/u);
  assert.match(verifyScript, /manifest\.version !== version/u);
  assert.match(verifyScript, /compareSemver\(live\.version, input\.version\)/u);
});

test("build signs from an isolated keychain, verifies, scans and uploads only the release set", () => {
  const { build } = jobs();
  assertOrdered(
    build,
    [
      "needs: [authorize, preflight]",
      "test \"$(pnpm --version)\" = \"10.34.5\"",
      "pnpm install --frozen-lockfile",
      "pnpm check:app-icons",
      "xcrun notarytool history",
      "security create-keychain -p \"$keychain_password\" \"$keychain\"",
      "security set-key-partition-list -S apple-tool:,apple:,codesign:",
      "echo \"CSC_KEYCHAIN=$keychain\" >> \"$GITHUB_ENV\"",
      "pnpm --filter @instafy/desktop-app dist",
      "if: always()",
      "security delete-keychain \"$keychain\"",
      "verify:packaged-runtime-agent",
      "verify:release-artifacts",
      "codesign --verify --deep --strict --verbose=2",
      "xcrun stapler validate",
      "hdiutil verify",
      'release-artifacts.mjs" release-set',
      "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
      'gitleaks-release-artifact.mjs" --root',
      "name: desktop-app-macos-arm64-${{ needs.authorize.outputs.tag }}",
      "retention-days: 7",
      "GITHUB_STEP_SUMMARY",
    ],
    "build",
  );
  assert.match(build, /timeout-minutes: 180/u);
  assert.match(build, /INSTAFY_REQUIRE_SIGNED_DESKTOP_ARTIFACTS: "1"/u);
  assert.match(build, /toolchain: 1\.97\.0/u);
});

test("canaries: launch smoke is secret-free and the Personal Browser canary is opt-in", () => {
  const all = jobs();
  assertOrdered(all.launch_smoke, ['release-artifacts.mjs" archive', "ditto -x -k", 'release-artifacts.mjs" extracted', "spctl --assess", "packaged-launch-smoke.mjs"], "launch_smoke");
  assert.match(all.personal_browser_canary, /^ {4}if: needs\.preflight\.outputs\.canary_mode == 'personal-browser'$/mu);
  assert.match(all.personal_browser_canary, /concurrency: \{ group: personal-browser-release-canary, cancel-in-progress: false \}/u);
  assertOrdered(
    all.personal_browser_canary,
    ['release-artifacts.mjs" archive', "spctl --assess", "minimumRemainingMs: 24 * 60 * 60 * 1000", "electron-shared-browser-recovery.prod.spec.ts", "electron-personal-browser-agent-turn.prod.spec.ts", "if: always()", "electron-shared-browser-recovery.prod.spec.ts", "name: personal-browser-recovery-journals"],
    "personal_browser_canary",
  );
  assert.match(all.preflight, /minimumRemainingMs: 24 \* 60 \* 60 \* 1000/u);
  assert.match(all.preflight, /mode=launch-smoke/u);
});

test("publish runs only for release mode after green build and canaries, in the fixed order", () => {
  const { publish } = jobs();
  assert.match(
    publish,
    /^ {4}if: always\(\) && needs\.authorize\.outputs\.mode == 'release' && needs\.build\.result == 'success' && needs\.launch_smoke\.result == 'success' && \(needs\.personal_browser_canary\.result == 'success' \|\| needs\.personal_browser_canary\.result == 'skipped'\)$/mu,
  );
  assertOrdered(
    publish,
    [
      "wrangler@4.73.0",
      "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_R2_API_TOKEN }}",
      "git show -s --format=%cI \"$SOURCE_SHA\"",
      'publish-downloads.sh"',
      'write-receipt.mjs"',
      'publish-downloads.sh" --recheck-only',
      'gh release create "$TAG" --verify-tag --latest=false',
      "release-receipt.json",
      "GITHUB_STEP_SUMMARY",
    ],
    "publish",
  );
  assert.equal(source.match(/gh release create/gu).length, 1);
  assert.doesNotMatch(source.replace(publish, ""), /wrangler r2|CLOUDFLARE|gh release/u);
  assertOrdered(
    publishScript,
    [
      "recheck_authority\n",
      "require_pointer_contract\n",
      'release-set --root "$ARTIFACT_DIR" --version "$VERSION" --no-symlinks',
      'r2_get "$POINTER_KEY" "$current_pointer"',
      "create-desktop-release-metadata.mjs",
      'upload_file "$file"',
      'upload_file "$ARTIFACT_DIR/latest-mac.yml"',
      'upload_file "$latest"',
      '"${DOWNLOADS_BUCKET}/${ROOT_LATEST_KEY}"',
      "verify_phase candidate",
      "  recheck_authority\n",
      '"${DOWNLOADS_BUCKET}/${POINTER_KEY}" --file "$pointer"',
      "verify_phase publication",
      "Restored the exact prior stable pointer",
    ],
    "publish-downloads.sh",
  );
  assert.match(publishScript, /--cache-control "public, max-age=31536000, immutable"/u);
  assert.match(publishScript, /Refusing to overwrite immutable \$\{key\} with different bytes/u);
  assert.match(publishScript, /specified key does not exist\|NoSuchKey\|R2 object \.\+ does not exist/u);
  assert.match(publishScript, /stable-pointer-contract\.json/u);
  assert.doesNotMatch(publishScript, /WINDOWS_EXE_NAME|LINUX_APPIMAGE_NAME/u);
});

test("no identity or private-infrastructure markers in the workflow or lane tooling", () => {
  const files = [workflowPath, ...fs.readdirSync(laneDir).map((name) => path.join(laneDir, name))];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, IDENTITY_SCRUB, path.relative(repositoryRoot, file));
    assert.doesNotMatch(text, new RegExp(["/U", "sers/"].join(""), "u"), path.relative(repositoryRoot, file));
  }
});
