import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Contract for the Origin Git Compatibility workflow: the origin server's
// whole test suite, including its static git-usage checks, runs against the
// git 2.34.1 that Ubuntu 22.04 ships, on a GitHub-hosted runner, with no
// secrets and no write access.

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = ".github/workflows/origin-git-compat.yml";
const source = fs.readFileSync(path.join(root, workflowPath), "utf8");
const triggerPaths = [
  workflowPath,
  "scripts/check-origin-git-compat-ci.test.mjs",
  "packages/origin-http-server/**",
  "packages/git-service/**",
];

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing step ${name}`);
  const end = source.indexOf("\n      - name: ", start + marker.length);
  return source.slice(start, end < 0 ? source.length : end);
}

test("the workflow runs on pull requests and main that touch the origin or its policy", () => {
  assert.match(source, /^name: Origin Git Compatibility$/mu);
  assert.match(source, /^on:\n  pull_request:\n    paths:\n/mu);
  assert.match(source, /\n  push:\n    branches:\n      - main\n    paths:\n/u);
  assert.match(source, /^  workflow_dispatch:$/mu);
  for (const file of triggerPaths) {
    assert.equal(source.split(`      - "${file}"\n`).length - 1, 2, file);
  }
  for (const file of triggerPaths.filter((entry) => !entry.endsWith("**"))) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  for (const dir of ["packages/origin-http-server", "packages/git-service"]) {
    assert.ok(fs.existsSync(path.join(root, dir, "Cargo.toml")), dir);
  }
});

test("one bounded, read-only job on a hosted runner inside a pinned Ubuntu 22.04", () => {
  assert.match(source, /^permissions:\n  contents: read\n/mu);
  assert.equal((source.match(/^  [\w-]+:\n    name:/gmu) ?? []).length, 1);
  assert.match(source, /^  origin-git-2-34:\n    name: Origin server on git 2\.34\.1\n    runs-on: ubuntu-latest\n    timeout-minutes: 45\n/mu);
  assert.match(
    source,
    /^    container:\n      image: ubuntu:22\.04@sha256:[0-9a-f]{64}\n/mu,
  );
  assert.match(source, /cancel-in-progress: true/u);
  assert.doesNotMatch(
    source,
    /secrets\.|environment:|continue-on-error|self-hosted|vars\.|write-all|: write\b|pull_request_target|--force/u,
  );
});

test("the job proves it runs git 2.34.1 before and while testing", () => {
  const install = step("Install Ubuntu's git and build tools");
  assert.match(install, /--no-install-recommends \\\n\s+ca-certificates curl git gcc libc6-dev make pkg-config libssl-dev\n/u);
  const versionCheck = 'test "$(git --version)" = "git version 2.34.1"';
  assert.ok(install.includes(versionCheck));
  const run = step("Test the origin server against git 2.34.1");
  assert.ok(run.includes(versionCheck));
  assert.ok(run.indexOf(versionCheck) < run.indexOf("cargo test"));
  assert.ok(source.indexOf("Install Ubuntu's git and build tools") < source.indexOf("Checkout repository"));
});

test("checkout is exact and keeps no credentials; the Rust installer is pinned and verified", () => {
  const checkout = step("Checkout repository");
  assert.match(
    checkout,
    /uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6\n        with:\n          ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false\n/u,
  );
  assert.match(source, /RUSTUP_INIT_VERSION: "\d+\.\d+\.\d+"\n/u);
  assert.match(source, /RUSTUP_INIT_SHA256: "[0-9a-f]{64}"\n/u);
  const rustup = step("Install the pinned Rust installer");
  assert.match(rustup, /https:\/\/static\.rust-lang\.org\/rustup\/archive\/\$\{RUSTUP_INIT_VERSION\}\/x86_64-unknown-linux-gnu\/rustup-init/u);
  const verify = rustup.indexOf('sha256sum -c -');
  assert.ok(verify > 0);
  assert.ok(verify < rustup.indexOf('chmod +x'));
  assert.ok(verify < rustup.indexOf('"$RUNNER_TEMP/rustup-init" -y'));
  assert.doesNotMatch(rustup, /\| *(?:ba)?sh\b/u);
});

// The one test skipped on git 2.34: the import baseline commit
// (commit_apply_locally) predates publish-by-merge and loops on git 2.34's
// status in a checkout whose git dir is `.instafy/.git`. Nothing else may be
// filtered out.
const knownGit234Skip = "git::tests::commit_apply_locally_commits_only_applied_and_deleted_paths";

test("the whole origin suite runs, with only the one known legacy test skipped", () => {
  const run = step("Test the origin server against git 2.34.1");
  const commands = run
    .split("        run: |\n")[1]
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  assert.deepEqual(commands, [
    "set -euo pipefail",
    'test "$(git --version)" = "git version 2.34.1"',
    'ulimit -n "$(ulimit -Hn)"',
    `cargo test --locked --manifest-path packages/origin-http-server/Cargo.toml -- --skip ${knownGit234Skip} --exact`,
  ]);
  const git = fs.readFileSync(path.join(root, "packages/origin-http-server/src/git.rs"), "utf8");
  assert.match(git, new RegExp(`\\n    fn ${knownGit234Skip.split("::").at(-1)}\\(\\)`, "u"));
  // The static checks this job exists for live in that suite.
  const tests = fs.readFileSync(path.join(root, "packages/origin-http-server/src/publish_tests.rs"), "utf8");
  for (const name of [
    "publish_modules_spawn_git_only_through_server_git_command",
    "publish_modules_use_only_git_2_34_and_never_force",
  ]) {
    assert.match(tests, new RegExp(`\\nfn ${name}\\(\\)`, "u"), name);
  }
});
