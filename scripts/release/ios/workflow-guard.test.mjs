import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const workflowPath = path.join(repositoryRoot, ".github/workflows/ios-release.yml");
const laneDirectory = import.meta.dirname;
const source = fs.readFileSync(workflowPath, "utf8");

const ENVIRONMENT_JOBS = ["build", "publish", "reconcile_only"];
const WRITE_JOBS = ["publish", "reconcile_only"];
const PINS = new Map([
  ["actions/checkout", "d23441a48e516b6c34aea4fa41551a30e30af803"],
  ["pnpm/action-setup", "b906affcce14559ad1aafd4ab0e942779e9f58b1"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
]);

function jobs() {
  const start = source.indexOf("\njobs:\n");
  assert.notEqual(start, -1, "workflow has a jobs map");
  const body = source.slice(start + "\njobs:\n".length);
  const headers = [...body.matchAll(/^ {2}([a-z_][a-z0-9_-]*):\n/gmu)];
  return new Map(headers.map((match, index) => [
    match[1],
    body.slice(match.index, index + 1 < headers.length ? headers[index + 1].index : body.length),
  ]));
}

function header() {
  return source.slice(0, source.indexOf("\njobs:\n"));
}

function steps(job) {
  return job.split(/(?=^ {6}- name: )/mu).slice(1);
}

function assertOrdered(text, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `missing or out of order: ${needle}`);
    cursor = next;
  }
}

function laneFiles() {
  return fs.readdirSync(laneDirectory).map((name) => path.join(laneDirectory, name)).filter((file) => fs.statSync(file).isFile());
}

test("only bot tag pushes and main dispatch (tag, dry_run, reconcile_only) trigger the release", () => {
  const on = header().slice(header().indexOf("\non:\n"), header().indexOf("\npermissions:"));
  assert.match(on, /^\non:\n {2}push:\n {4}tags: \['ios-v\*'\]\n {2}workflow_dispatch:\n {4}inputs:\n/u);
  const inputs = [...on.matchAll(/^ {6}([a-z_]+): \{/gmu)].map((match) => match[1]);
  assert.deepEqual(inputs, ["tag", "dry_run", "reconcile_only"]);
  assert.match(on, /dry_run: \{[^}]*type: boolean, default: true \}/u);
  assert.match(on, /reconcile_only: \{[^}]*type: boolean, default: false \}/u);
  assert.doesNotMatch(on, /branches|paths/u);
  assert.doesNotMatch(source, /^\s*(?:pull_request|pull_request_target|workflow_run|schedule|workflow_call|repository_dispatch)\s*:/mu);
  assert.doesNotMatch(source, /pull_request_target/u);
});

test("least privilege: read-only default, secrets and environments only where needed", () => {
  assert.match(header(), /\npermissions:\n {2}contents: read\n/u);
  // Dry runs queue in their own group so they can never replace a pending publication.
  assert.match(header(), /\nconcurrency: \{ group: "ios-release-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run && 'dry-run' \|\| 'publish' \}\}", cancel-in-progress: false \}\n/u);
  assert.match(header(), /\ndefaults:\n {2}run:\n {4}shell: bash\n/u);
  assert.doesNotMatch(header(), /secrets\.|environment:/u);
  const all = jobs();
  assert.deepEqual([...all.keys()], ["authorize", ...ENVIRONMENT_JOBS]);
  for (const [name, job] of all) {
    const environments = [...job.matchAll(/^ {4}environment: (.+)$/gmu)].map((match) => match[1]);
    assert.doesNotMatch(job, /^ {5,}environment:/mu, `${name} nests environment`);
    assert.deepEqual(environments, ENVIRONMENT_JOBS.includes(name) ? ["ios-release"] : [], name);
    if (!ENVIRONMENT_JOBS.includes(name)) assert.doesNotMatch(job, /secrets\./u, `${name} must not reference secrets`);
    const permissions = job.match(/^ {4}permissions:\n((?: {6}.+\n)+)/mu);
    assert.ok(permissions, `${name} declares permissions`);
    assert.equal(permissions[1], WRITE_JOBS.includes(name) ? "      contents: write\n" : "      contents: read\n", name);
    if (name !== "authorize") assert.match(job, /^ {4}needs: (?:authorize|\[authorize, build\])$/mu, name);
  }
  assert.equal((source.match(/contents: write/gu) ?? []).length, WRITE_JOBS.length);
  for (const name of WRITE_JOBS) {
    assert.match(all.get(name), /if: needs\.authorize\.outputs\.mode == 'release'/u, `${name} never runs in a dry run`);
  }
  assert.doesNotMatch(source, /OTA_SIGNING_PRIVATE_KEY|OPEN_CORE_COMPAT_PUBLIC_READ_TOKEN|INSTAFY_BOT_TOKEN|GITHUB_TOKEN:/u);
  assert.doesNotMatch(all.get("build").match(/^ {4}env:\n((?: {6}.+\n)+)/mu)[1], /CAPACITOR_LIVE_UPDATE_PUBLIC_KEY:/u);
});

test("secrets only enter step environments and are never echoed", () => {
  for (const line of source.split("\n").filter((value) => value.includes("secrets."))) {
    assert.match(line, /^ {10}[A-Z0-9_]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}$/u, line);
  }
  const secretNames = [...new Set([...source.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(secretNames, [
    "APP_STORE_CONNECT_ISSUER_ID",
    "APP_STORE_CONNECT_KEY_ID",
    "APP_STORE_CONNECT_PRIVATE_KEY",
    "IOS_DEVELOPMENT_TEAM",
    "IOS_DIST_CERT_P12_BASE64",
    "IOS_DIST_CERT_PASSWORD",
  ]);
  for (const name of ["APP_STORE_CONNECT_PRIVATE_KEY", "IOS_DIST_CERT_P12_BASE64", "IOS_DIST_CERT_PASSWORD"]) {
    assert.doesNotMatch(source, new RegExp(`\\$\\{?${name}`, "u"), `${name} is consumed only by lane scripts`);
  }
  assert.doesNotMatch(source, /set -x|set -o xtrace|ACTIONS_STEP_DEBUG/u);
  const credentials = fs.readFileSync(path.join(laneDirectory, "signing-credentials.sh"), "utf8");
  for (const line of credentials.split("\n").filter((value) => /\$\{?(?:APP_STORE_CONNECT_PRIVATE_KEY|IOS_DIST_CERT_P12_BASE64|IOS_DIST_CERT_PASSWORD)\b/u.test(value))) {
    assert.match(line, /> "\$(?:key_path|certificate)"\)?$|-P "\$IOS_DIST_CERT_PASSWORD"|^\s*: "\$\{|^\s*case "\$APP_STORE_CONNECT_PRIVATE_KEY" in$/u, line);
  }
});

test("hosted runners only, pinned actions, exact tooling", () => {
  const runsOn = [...source.matchAll(/^ {4}runs-on: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(runsOn, ["ubuntu-24.04", "macos-15", "macos-15", "ubuntu-24.04"]);
  assert.equal((source.match(/runs-on:/gu) ?? []).length, 4);
  assert.doesNotMatch(source, /self-hosted|runner\.environment|^\s+group:/imu);
  for (const match of source.matchAll(/^\s+uses: ([^@\s]+)@([^\s#]+)/gmu)) {
    assert.ok(PINS.has(match[1]), `unexpected action ${match[1]}`);
    assert.equal(match[2], PINS.get(match[1]), `${match[1]} pin`);
  }
  for (const checkout of source.matchAll(/uses: actions\/checkout@[0-9a-f]{40} # v6\n {8}with:\n((?: {10}.+\n)+)/gu)) {
    assert.match(checkout[1], /ref: \$\{\{ (?:steps\.resolve|needs\.authorize)\.outputs\.source_sha \}\}/u);
    assert.match(checkout[1], /persist-credentials: false/u);
  }
  assert.match(source, /PNPM_VERSION: 10\.34\.5/u);
  assert.match(source, /test "\$\(pnpm --version\)" = "\$PNPM_VERSION"/u);
  assert.match(source, /pnpm install --frozen-lockfile/u);
  assert.match(source, /GITLEAKS_DARWIN_ARM64_SHA256: b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5/u);
  assert.match(source, /submodules: recursive/u);
  assert.match(source, /test "\$RUNNER_ARCH" = ARM64/u);
});

test("authorize proves actor, pusher, exact main, version and one-shot before any secret job", () => {
  const authorize = jobs().get("authorize");
  assert.match(authorize, /^ {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 10\n/mu);
  assertOrdered(authorize, [
    '[ "$GITHUB_REPOSITORY" = "instafy-dev/instafy" ]',
    '[ "$GITHUB_ACTOR" = "instafy-bot" ]',
    '[ "$GITHUB_TRIGGERING_ACTOR" = "instafy-bot" ]',
    '[ "$EVENT_PUSHER" = "instafy-bot" ]',
    '[ "$GITHUB_REF" = "refs/heads/main" ]',
    "git/ref/tags/$tag",
    "git/ref/heads/main",
    "compare/${source_sha}...${main_sha}",
    "identical|ahead",
    "uses: actions/checkout@",
    'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    "github-release-state.sh",
    "releases/tags/<tag> must be HTTP 404",
    "verify-release-tag.mjs authorize",
  ]);
  const state = fs.readFileSync(path.join(laneDirectory, "github-release-state.sh"), "utf8");
  assertOrdered(state, ["git/ref/tags/$tag", "git/tags/$object_sha", "git/ref/heads/main", "compare/${commit}...${main_sha}", "releases/tags/$tag"]);
  assert.doesNotMatch(source + state, /\.\.\.main\b/u, "compare against the resolved refs/heads/main commit only");
});

test("re-runs cannot bypass the bot gate: every secret job re-checks the triggering actor first", () => {
  const all = jobs();
  const verify = fs.readFileSync(path.join(laneDirectory, "verify-release-tag.mjs"), "utf8");
  assert.match(verify, /actor: env\.GITHUB_ACTOR,\n\s+triggeringActor: env\.GITHUB_TRIGGERING_ACTOR,/u);
  assert.match(verify, /return recheckRelease\(\{\n\s+tag,\n\s+triggeringActor: env\.GITHUB_TRIGGERING_ACTOR,/u);
  for (const name of ENVIRONMENT_JOBS) {
    const jobSteps = steps(all.get(name));
    const gate = jobSteps.findIndex((step) => step.includes('[ "$GITHUB_TRIGGERING_ACTOR" = "instafy-bot" ] || { echo "::error::Only instafy-bot may run or re-run'));
    assert.ok(gate >= 0, `${name} re-checks github.triggering_actor`);
    const firstSecret = jobSteps.findIndex((step) => step.includes("secrets."));
    const firstRun = jobSteps.findIndex((step) => /^ {8}run: /mu.test(step));
    assert.equal(gate, firstRun, `${name}: the trigger gate is the first run step`);
    assert.ok(firstSecret === -1 || gate <= firstSecret, `${name}: the trigger gate precedes every secret`);
    assert.match(jobSteps[gate], /^ {8}run: \|\n {10}set -euo pipefail\n {10}\[ "\$GITHUB_TRIGGERING_ACTOR" = "instafy-bot" \]/mu, name);
  }
});

test("trust anchor capture fails closed before any signing work", () => {
  const build = jobs().get("build");
  assert.doesNotMatch(build, /echo "[A-Z_]+=\$\(/u, "no exit-code-swallowing command substitution inside echo");
  assert.doesNotMatch(build, /test "\$\(node /u, "no command substitution inside test");
  assertOrdered(build, [
    'trust_key_sha256="$(node scripts/release/ios/verify-trust-anchor.mjs key)"',
    '[[ "$trust_key_sha256" =~ ^[0-9a-f]{64}$ ]]',
    'echo "TRUST_KEY_SHA256=$trust_key_sha256" >> "$GITHUB_ENV"',
    '[[ "$TRUST_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    'test "$RESOLVED_KEY_SHA256" = "$TRUST_KEY_SHA256"',
    'synced_key_sha256="$(node scripts/release/ios/verify-trust-anchor.mjs config',
    'test "$synced_key_sha256" = "$TRUST_KEY_SHA256"',
    "signing-credentials.sh keychain",
  ]);
  assert.match(jobs().get("reconcile_only"), /TRUST_KEY_SHA256="\$\(node scripts\/release\/ios\/verify-trust-anchor\.mjs key\)"\n\s+\[\[ "\$TRUST_KEY_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/u);
});

test("build signs and verifies but never publishes; publication is one upload then Release last", () => {
  const all = jobs();
  const build = all.get("build");
  assert.doesNotMatch(build, /altool|gh release|asc\.mjs reconcile|stage-asc-key|create-release\.sh|wrangler/u);
  assertOrdered(build, [
    "asc.mjs gate",
    "verify-trust-anchor.mjs key",
    "resolve-live-update-public-key.mjs",
    "cap:sync",
    "verify-trust-anchor.mjs config",
    "signing-credentials.sh keychain",
    "asc.mjs download-profile",
    "install-profile.mjs",
    "bind-signing.mjs",
    " archive\n",
    "export-ipa.sh",
    "verify-ipa.sh",
    "scan-ipa.sh",
    "inspect-native-ota.py",
    "asc.mjs gate",
    "actions/upload-artifact@",
    "signing-credentials.sh cleanup",
  ]);
  assert.match(build, /retention-days: \$\{\{ needs\.authorize\.outputs\.mode == 'release' && 30 \|\| 7 \}\}/u);
  assert.equal((source.match(/xcrun altool/gu) ?? []).length, 1, "exactly one altool invocation");
  const firstXcodebuild = source.indexOf("xcodebuild");
  assert.ok(source.indexOf('echo "DEVELOPER_DIR=$DEVELOPER_DIR" >> "$GITHUB_ENV"') < firstXcodebuild);
  assert.ok(source.indexOf("export DEVELOPER_DIR") < firstXcodebuild);
  assert.doesNotMatch(source, /xcode-select|sudo |-allowProvisioningUpdates|CODE_SIGN_IDENTITY=|PROVISIONING_PROFILE_SPECIFIER=|CODE_SIGN_STYLE=/u);
  assert.match(build, /xcodebuild -project "\$IOS_PROJECT" -scheme "\$IOS_SCHEME" -configuration Release \\\n\s+-destination 'generic\/platform=iOS' -archivePath "\$RUNNER_TEMP\/\$ARCHIVE"/u);

  const publish = all.get("publish");
  assertOrdered(publish, [
    "actions/download-artifact@",
    "shasum -a 256",
    "verify-release-tag.mjs recheck",
    "asc.mjs gate",
    "stage-asc-key",
    "xcrun altool --output-format xml --upload-app",
    "asc.mjs reconcile",
    "write-receipt.mjs",
    "create-release.sh",
    "signing-credentials.sh cleanup",
  ]);
  const reconcile = all.get("reconcile_only");
  assert.doesNotMatch(reconcile, /altool|upload-artifact|download-artifact|xcodebuild/u);
  assertOrdered(reconcile, ["verify-release-tag.mjs recheck", "asc.mjs reconcile-existing", "--digest-source app-store-connect", "create-release.sh"]);

  const release = fs.readFileSync(path.join(laneDirectory, "create-release.sh"), "utf8");
  assertOrdered(release, ["github-release-state.sh", "verify-release-tag.mjs recheck", 'receipt="$release_dir/release-receipt.json"', "gh release create \"$TAG\" --verify-tag --latest=false"]);
  assert.doesNotMatch(source, /gh release (?:create|upload|edit)/u, "Release creation lives only in create-release.sh");
  assert.match(source, /releases\/download\/%s\/release-receipt\.json/u);
});

test("every run step is strict and every job ends with a step summary", () => {
  for (const [name, job] of jobs()) {
    const jobSteps = steps(job);
    assert.match(jobSteps.at(-1), /^ {6}- name: Summary\n {8}if: always\(\)\n/u, `${name} ends with a summary`);
    assert.match(jobSteps.at(-1), /GITHUB_STEP_SUMMARY/u);
    for (const step of jobSteps) {
      if (/^ {8}run: \|\n/mu.test(step)) {
        assert.match(step, /^ {8}run: \|\n {10}set -euo pipefail\n/mu, step.split("\n")[0]);
      } else if (/^ {8}run: /mu.test(step)) {
        assert.match(step, /^ {8}run: (?:bash|node) scripts\/release\/ios\/[a-z-]+\.(?:sh|mjs)(?: "[^"\n]+")*$/mu, step.split("\n")[0]);
      }
    }
  }
  assert.ok(source.split("\n").length <= 560, "workflow stays lean");
});

test("lane shell stays bash 3.2 safe and syntactically valid", () => {
  const shellSources = [
    ...laneFiles().filter((file) => file.endsWith(".sh")).map((file) => [file, fs.readFileSync(file, "utf8")]),
    [workflowPath, source],
  ];
  for (const [file, text] of shellSources) {
    assert.doesNotMatch(text, /\bmapfile\b|\breadarray\b|\$\{[A-Za-z_]+(?:\^\^|,,)\}|declare -A|\blocal -n\b/u, file);
  }
  for (const [file] of shellSources.filter(([file]) => file.endsWith(".sh"))) {
    const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.match(fs.readFileSync(file, "utf8"), /^#!\/usr\/bin\/env bash\n(?:#.*\n)*set -euo pipefail\n/mu, file);
  }
});

test("identity scrub: no private identity, host or repository strings in the lane", () => {
  const forbidden = new RegExp(
    [["mar", "cus"], ["pous", "ette"], ["tiny", "cow"], ["192", "\\.168\\."], ["fri", "tz"], ["instafy-", "native"], ["instafy-", "internal"], ["Mar", "cuss"]]
      .map((parts) => parts.join(""))
      .join("|"),
    "iu",
  );
  const home = ["", "Users", ""].join("/");
  for (const file of [workflowPath, ...laneFiles()]) {
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, forbidden, path.relative(repositoryRoot, file));
    assert.equal(text.includes(home), false, `${path.relative(repositoryRoot, file)} contains an absolute home path`);
  }
});
