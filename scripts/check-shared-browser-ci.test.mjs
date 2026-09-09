import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/browser-e2e.yml"), "utf8");
const jobs = [
  { key: "shared-profile", label: "public-shared-browser-aggregate", name: "Shared Browser profile E2E", minutes: 5 },
  { key: "shared-profile-lifecycle", label: "public-shared-browser-profile", name: "Shared Browser profile lifecycle", minutes: 30, script: "browser-profile-e2e.mjs" },
  { key: "shared-studio", label: "public-shared-browser-studio", name: "Shared Browser Studio journey", minutes: 30, script: "shared-browser-studio-e2e.mjs" },
];
const section = key => workflow.split(`\n  ${key}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];
function context(event = "pull_request") {
  const ref = event === "pull_request" ? "refs/pull/11/merge" : "refs/heads/main";
  return { repository: "instafy-dev/instafy", repository_id: "1001", run_id: "2002", run_attempt: "3",
    ref, workflow_ref: `instafy-dev/instafy/.github/workflows/build.yml@${ref}`, event_name: event, ref_protected: event === "push",
    event: { repository: { private: true }, ...(event === "pull_request" ? { pull_request: {
      number: 11, base: { ref: "main", repo: { full_name: "instafy-dev/instafy" } },
      head: { repo: { full_name: "instafy-dev/instafy", fork: false } },
    } } : {}) } };
}
function select(job, github, toggle = "true") {
  const expression = section(job.key).match(/^    runs-on: >-\n((?:      .*\n)+)/mu)[1]
    .trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  assert.doesNotMatch(expression, /github\.job\b|matrix\.|inputs\./u);
  return JSON.parse(JSON.stringify(vm.runInNewContext(expression, { github,
    vars: { CI_SHARED_BROWSER_SELF_HOSTED: toggle, CI_BROWSER_SELF_HOSTED: "true", CI_BOOTSTRAP_SELF_HOSTED: "true",
      CI_EXPANDED_SELF_HOSTED: "true", CI_JAVASCRIPT_SELF_HOSTED: "true", CI_RUST_SELF_HOSTED: "true" },
    fromJSON: JSON.parse, format: (template, ...values) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === "{{" ? "{" : match === "}}" ? "}" : String(values[index])),
  }, { timeout: 1000 })));
}
test("Shared routing is independently default-off for exactly two30m children and the original5m required aggregate", () => {
  assert.equal((workflow.match(/vars\.CI_SHARED_BROWSER_SELF_HOSTED/g) ?? []).length, 3);
  for (const job of jobs) {
    assert.ok(section(job.key).includes(`    name: ${job.name}\n`));
    assert.ok(section(job.key).includes(`    timeout-minutes: ${job.minutes}\n`));
    for (const event of ["pull_request", "push"]) {
      for (const flag of ["", "false", "0", "unknown"]) assert.equal(select(job, context(event), flag), "ubuntu-24.04");
      const github = context(event), trust = event === "push" ? "main" : "pr";
      const selected = select(job, github);
      assert.deepEqual(selected, { group: `org/instafy-ci-${trust}`,
        labels: ["self-hosted", "Linux", "ARM64", `instafy-ci-bootstrap-1001-2002-3-${job.label}`, `instafy-ci-trust-${trust}`] });
      for (const key of ["repository_id", "run_id", "run_attempt"]) {
        assert.notEqual(select(job, { ...github, [key]: "9009" }).labels[3], selected.labels[3]);
      }
    }
  }
});
test("Shared callers, private visibility and exact PR/main event guards fail closed to hosted", () => {
  for (const job of jobs) {
    for (const event of ["workflow_dispatch", "workflow_call", "pull_request_target", "schedule", "workflow_run", "merge_group"])
      assert.equal(select(job, context(event)), "ubuntu-24.04");
    for (const event of ["pull_request", "push"]) for (const mutate of [
      g => { g.repository = "someone/instafy"; }, g => { g.event.repository.private = false; },
      g => { delete g.workflow_ref; }, g => { g.workflow_ref = `instafy-dev/instafy/.github/workflows/browser-e2e.yml@${g.ref}`; },
      g => { g.workflow_ref = `instafy-dev/instafy/.github/workflows/other.yml@${g.ref}`; },
      g => { g.workflow_ref = "instafy-dev/instafy/.github/workflows/build.yml@refs/heads/other"; },
    ]) { const g = context(event); mutate(g); assert.equal(select(job, g), "ubuntu-24.04"); }
    for (const mutate of [g => { g.event.pull_request.base.ref = "other"; },
      g => { g.event.pull_request.head.repo.fork = true; }, g => { g.event.pull_request.head.repo.full_name = "someone/instafy"; },
      g => { g.event.pull_request.base.repo.full_name = "someone/instafy"; }, g => { g.event.pull_request.number = 12; },
      g => { g.ref = "refs/heads/main"; g.workflow_ref = `instafy-dev/instafy/.github/workflows/build.yml@${g.ref}`; },
    ]) { const g = context(); mutate(g); assert.equal(select(job, g), "ubuntu-24.04"); }
    for (const mutate of [g => { g.ref_protected = false; }, g => { g.ref = "refs/heads/other"; }]) {
      const g = context("push"); mutate(g); assert.equal(select(job, g), "ubuntu-24.04");
    }
  }
});
test("each Shared child preserves a complete independent dependency, migrated auth and fixture lifecycle", () => {
  for (const job of jobs.filter(job => job.script)) {
    const source = section(job.key);
    for (const text of ["persist-credentials: false", "submodules: recursive", 'node-version: "22"', 'go-version: "1.26.x"',
      "rustup toolchain install stable --profile minimal", "rustup default stable", "pnpm install --frozen-lockfile",
      "playwright install --with-deps chromium", "node scripts/ensure-supabase-postgres-image.mjs", "pnpm supabase:up",
      "node --test scripts/browser-profile-e2e.test.mjs scripts/shared-browser-studio-e2e.test.mjs scripts/lib/sharedStudioProvider.test.mjs",
      "if-no-files-found: error", "retention-days: 7", 'CARGO_BUILD_JOBS: "2"', 'CARGO_INCREMENTAL: "0"', 'CARGO_PROFILE_DEV_DEBUG: "0"',
      "TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres"])
      assert.ok(source.includes(text), `${job.key}: ${text}`);
    assert.equal((source.match(/run: xvfb-run -a node scripts\/(?:browser-profile-e2e|shared-browser-studio-e2e)\.mjs/g) ?? []).length, 1);
    assert.ok(source.includes(`run: xvfb-run -a node scripts/${job.script}\n`));
    assert.match(source, /Stop the disposable authentication stack\n        if: always\(\)\n        run: pnpm supabase:down/u);
    assert.match(source, /Free space on the disposable hosted runner\n        if: runner.environment == 'github-hosted'/u);
    assert.ok(source.includes("INSTAFY_SHARED_BROWSER_COMPILER_PROXY: ${{ runner.environment == 'self-hosted' && '1' || '0' }}"));
    assert.doesNotMatch(source, /SUPABASE_DATABASE_ONLY|--ignore-scripts|--no-sandbox|--allow-unauthenticated|continue-on-error|--grep|--retries=|--pass-with-no-tests/u);
  }
  assert.doesNotMatch(workflow, /secrets:|secrets\.|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|HTTP_PROXY:|HTTPS_PROXY:/u);
});
test("Shared caches isolate operating system, architecture and child compiler targets without fallback keys", () => {
  for (const job of jobs.filter(job => job.script)) {
    const source = section(job.key);
    assert.ok(source.includes("key: shared-browser-image-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/test-supabase-migrations-empty-db.mjs') }}"));
    assert.ok(source.includes(`key: shared-browser-cargo-v1-\${{ runner.os }}-\${{ runner.arch }}-${job.label}-\${{ hashFiles('packages/*/Cargo.lock') }}`));
    assert.doesNotMatch(source, /restore-keys:|supabase-postgres-image-\$\{/u);
  }
});
function qualify(job, mutate = () => {}, badDaemon) {
  const source = section(job.key), programs = [...source.matchAll(/          node <<'NODE'\n([\s\S]*?)          NODE\n/gu)];
  assert.ok(programs.length >= 1);
  assert.match(source, /steps:\n      - name: Qualify isolated Shared Browser CI runner\n        if: runner.environment == 'self-hosted'/u);
  if (job.script) assert.ok(source.indexOf(programs[0][0]) < source.indexOf("uses: actions/checkout@"));
  const state = { platform: "linux", arch: "arm64", getuid: () => 503, versions: { node: "22.23.2" },
    env: { RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64", INSTAFY_CI_JOB_ISOLATION: "ephemeral" } };
  mutate(state); const calls = [];
  vm.runInNewContext(programs[0][1], { process: state, require(name) {
    if (name === "node:assert/strict") return assert;
    assert.equal(name, "node:child_process");
    return { execFileSync(command, args, options) {
      calls.push(command); assert.ok(options.timeout <= 5000);
      if (command === "docker") return JSON.stringify(badDaemon ?? { OSType: "linux", Architecture: "aarch64" });
      assert.equal(command, "/bin/bash"); assert.equal(args[1], 'command -v "$1" >/dev/null');
    } };
  } }, { timeout: 1000 });
  return calls;
}
test("Shared prerequisites prove nonroot Linux ARM64 Node22 and real Docker only for the two children", () => {
  for (const job of jobs) {
    assert.equal(qualify(job).includes("docker"), Boolean(job.script));
    for (const mutate of [s => { s.platform = "darwin"; }, s => { s.arch = "x64"; }, s => { s.getuid = () => 0; },
      s => { s.versions.node = "20.20.2"; }, s => { s.env.RUNNER_OS = "macOS"; }, s => { s.env.RUNNER_ARCH = "X64"; },
      s => { delete s.env.INSTAFY_CI_JOB_ISOLATION; }, s => { s.env.INSTAFY_ENV_DIR = "/inert-private"; }]) assert.throws(() => qualify(job, mutate));
    if (job.script) for (const daemon of [{}, { OSType: "windows", Architecture: "aarch64" }, { OSType: "linux", Architecture: "x86_64" }])
      assert.throws(() => qualify(job, () => {}, daemon));
  }
});
test("the required Shared aggregate waits for both exact children and accepts only full success", () => {
  const source = section("shared-profile");
  assert.ok(source.includes("needs:\n      - shared-profile-lifecycle\n      - shared-studio\n    if: ${{ always() }}"));
  assert.match(source, /    permissions: \{\}/u);
  assert.doesNotMatch(source, /actions\/checkout|actions\/setup|pnpm install|docker|apt-get|CARGO_|TEST_DATABASE_URL/u);
  const program = [...source.matchAll(/          node <<'NODE'\n([\s\S]*?)          NODE\n/gu)].at(-1)[1];
  const run = results => vm.runInNewContext(program, { require: name => { assert.equal(name, "node:assert/strict"); return assert; },
    process: { env: { SHARED_BROWSER_RESULTS: JSON.stringify(results) } } }, { timeout: 1000 });
  const success = { "shared-profile-lifecycle": { result: "success" }, "shared-studio": { result: "success" } };
  run(success);
  for (const key of Object.keys(success)) for (const result of ["failure", "cancelled", "skipped", "timed_out", "neutral", null, undefined])
    assert.throws(() => run({ ...success, [key]: { result } }));
  for (const value of [null, [], {}, { "shared-profile-lifecycle": { result: "success" } }, { ...success, other: { result: "success" } }])
    assert.throws(() => run(value));
});
