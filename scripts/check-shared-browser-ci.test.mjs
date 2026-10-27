import { withoutManualCiRouting } from "./lib/manualCiRoutingTestBaseline.mjs";
import { assertMainOnlySave, assertNoPullRequestCacheSave, cacheStepRuns, CACHE_REFS, withoutMainOnlyCaches } from "./lib/mainOnlyCacheTestBaseline.mjs";
import { HOSTED_CHROMIUM_STEP, PATH_RESOLVED_CMAKE, withoutSharedPrerequisiteTimeout } from "./lib/sharedBrowserPrerequisitesTestBaseline.mjs";
import { withoutBrowserUiJobBudget } from "./lib/browserUiBudgetTestBaseline.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const workflow = withoutManualCiRouting("browser-e2e.yml", fs.readFileSync(path.join(root, ".github/workflows/browser-e2e.yml"), "utf8"));
const aggregateIf = "    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}";
// Only historical byte-reconstruction proofs use the former aggregate guard.
// They start from the bytes before main-only saves, the shared compiler key and
// trimmed cargo paths; the current policy is asserted directly below. Each proof
// rebuilds it, so a cache-policy regression fails that proof, not the module.
// The separately checked prerequisite budgets are also reversed exactly.
const previousAggregateWorkflow = () => withoutSharedPrerequisiteTimeout("browser-e2e.yml", withoutMainOnlyCaches("browser-e2e.yml", withoutBrowserUiJobBudget("browser-e2e.yml", workflow))).replace(aggregateIf, "    if: ${{ always() }}");
const jobs = [
  { key: "shared-profile", label: "public-shared-browser-aggregate", name: "Shared Browser profile E2E", minutes: 5 },
  { key: "shared-profile-lifecycle", label: "public-shared-browser-profile", name: "Shared Browser profile lifecycle", minutes: 30, script: "browser-profile-e2e.mjs" },
  { key: "shared-studio", label: "public-shared-browser-studio", name: "Shared Browser Studio journey", minutes: 30, script: "shared-browser-studio-e2e.mjs" },
];
const section = (key, text = workflow) => text.split(`\n  ${key}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];
const chromiumStep = "      - name: Install locked Chromium and operating-system dependencies\n";
const selfHostedIf = "        if: runner.environment == 'self-hosted'\n";
const withDeps = "        run: pnpm --filter @instafy/frontend exec playwright install --with-deps chromium\n";
const bindStep = "      - name: Bind the launcher to the locked test Chromium\n";
const fixtureGuards = "scripts/lib/sharedStudioProvider.test.mjs scripts/check-shared-browser-ci.test.mjs";
const hostedGuard = "scripts/ensure-hosted-chromium-host.test.mjs";
const compilerSegmentTimeout = '        env:\n          SEGMENT_DOWNLOAD_TIMEOUT_MINS: "2"\n';
const withoutCompilerSegmentTimeout = text => text.replaceAll(compilerSegmentTimeout, "");
// Reconstruct only the removed standalone migration-image preparation for
// the existing whole-workflow scope proofs, excluding the separately proven
// segment-timeout opt-ins. Do not loosen their baselines.
function withStandaloneMigrationImagePreparation(text) {
  text = withoutCompilerSegmentTimeout(text);
  const cache = [
    "      - name: Restore Supabase Postgres image cache",
    "        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
    "        with:",
    "          path: ~/.instafy-image-cache",
    "          key: shared-browser-image-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/test-supabase-migrations-empty-db.mjs') }}",
    "",
  ].join("\n");
  const compilerStep = "      - name: Restore compiler cache without saving\n";
  const startup = '          SUPABASE_BROWSER_TEST: "1"\n        run: |\n';
  assert.equal(text.split(compilerStep).length - 1, 2);
  assert.equal(text.split(startup).length - 1, 2);
  return text.replaceAll(compilerStep, cache + compilerStep)
    .replaceAll(startup, startup + "          node scripts/ensure-supabase-postgres-image.mjs\n");
}
function cacheStep(key, name, workflowText = workflow) {
  const text = section(key, workflowText), marker = `      - name: ${name}\n`, start = text.indexOf(marker);
  assert.ok(start >= 0);
  const end = text.indexOf('\n      - name: ', start + marker.length);
  return text.slice(start, end < 0 ? text.length : end);
}
function withoutRestoreOnlyCaches(text) {
  for (const job of jobs.filter(job => job.script)) {
    const restore = withoutCompilerSegmentTimeout(cacheStep(job.key, 'Restore compiler cache without saving', text));
    const hosted = cacheStep(job.key, 'Restore architecture-specific compiler cache', text);
    text = text.replace(restore + '\n', '').replace(hosted,
      hosted.replace("        if: runner.environment == 'github-hosted'\n", ''));
  }
  return text;
}
function withoutCargoLinkerDefault(source) {
  const helper = [
    "// Linux fixture Cargo builds default to LLD through the existing compiler",
    "// driver. Preserve every explicit RUSTFLAGS value, including an empty opt-out.",
    "export function fixtureCargoEnvironment(env, platform = process.platform) {",
    "  const compiler = fixtureCompilerEnvironment(env);",
    '  if (platform === "linux" && compiler.RUSTFLAGS === undefined) compiler.RUSTFLAGS = "-C link-arg=-fuse-ld=lld";',
    "  return compiler;",
    "}", "", "",
  ].join("\n");
  return source.replace(helper, "")
    .replace("fixtureCompilerEnvironment, fixtureCargoEnvironment,", "fixtureCompilerEnvironment,")
    .replace("  const cargoEnv = fixtureCargoEnvironment(process.env);\n", "")
    .replaceAll(/(await run\("cargo",[^\n]+\{ env: )cargoEnv/g, "$1compilerEnv");
}
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
      "playwright install --with-deps chromium", "pnpm supabase:up",
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
test("only both Shared prerequisite steps allow ten minutes while network limits and verification remain exact", () => {
  const name = "Install fixture display, database and compiler prerequisites";
  const marker = `      - name: ${name}\n`;
  assert.equal(workflow.split(marker).length - 1, 2);
  const expected = [
    marker.trimEnd(),
    "        timeout-minutes: 10",
    "        shell: bash",
    "        run: |",
    "          set -euo pipefail",
    "          sudo -n apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update",
    "          sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install --yes --no-install-recommends x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler",
    "          for package in x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler; do",
    '            [[ "$(dpkg-query --show --showformat=\'${Status}\' "$package")" == \'install ok installed\' ]]',
    "          done",
    "          # Hosted images put a newer CMake first on PATH; only hosts without one fetch Ubuntu's.",
    "          if ! command -v cmake >/dev/null; then",
    "            sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install --yes --no-install-recommends cmake",
    '            [[ "$(dpkg-query --show --showformat=\'${Status}\' cmake)" == \'install ok installed\' ]]',
    "          fi",
    "          command -v cmake",
    "          cmake_version=\"$(cmake --version | sed -n '1s/^cmake version //p')\"",
    "          IFS=. read -r cmake_major cmake_minor _ <<<\"$cmake_version\"",
    "          # Only plain numbers reach (( )), which would evaluate any other text as an expression.",
    "          [[ \"$cmake_major\" =~ ^[0-9]+$ && \"$cmake_minor\" =~ ^[0-9]+$ ]] && (( cmake_major > 3 || (cmake_major == 3 && cmake_minor >= 28) )) \\",
    "            || { echo \"::error::CMake '${cmake_version}' at $(command -v cmake) is older than 3.28 or unparsable.\"; exit 1; }",
    "          ld.lld --version",
    "          pkg-config --exists libcap openssl",
  ].join("\n");
  for (const job of jobs.filter(job => job.script)) {
    assert.equal(section(job.key).split(marker).length - 1, 1, job.key);
    assert.equal(cacheStep(job.key, name), expected, job.key);
    assert.match(section(job.key), /^    timeout-minutes: 30$/mu);
  }
  assert.match(section("shared-profile"), /^    timeout-minutes: 5$/mu);
  assert.doesNotMatch(section("shared-profile"), /Install fixture display, database and compiler prerequisites/u);
  const previous = withoutSharedPrerequisiteTimeout("browser-e2e.yml", workflow);
  assert.equal(previous.split(`${marker}        timeout-minutes: 5\n`).length - 1, 2);
  // Composite round trip: re-applying the budget, the PATH-resolved CMake and
  // the hosted Chromium split in turn restores every current byte.
  assert.equal(previous.replaceAll(`${marker}        timeout-minutes: 5\n`, `${marker}        timeout-minutes: 10\n`)
    .replaceAll(PATH_RESOLVED_CMAKE[1], PATH_RESOLVED_CMAKE[0])
    .replaceAll(`${chromiumStep}${withDeps}${bindStep}`, `${chromiumStep}${selfHostedIf}${withDeps}${HOSTED_CHROMIUM_STEP}${bindStep}`)
    .replaceAll(`${fixtureGuards}\n`, `${fixtureGuards} ${hostedGuard}\n`), workflow);
  const install = "            sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install --yes --no-install-recommends cmake\n";
  for (const changed of [
    workflow.replace(`${marker}        timeout-minutes: 10\n`, `${marker}        timeout-minutes: 11\n`),
    workflow.replace(marker, ""),
    workflow + `${marker}        timeout-minutes: 10\n`,
    workflow.replace("pkg-config libssl-dev clang lld libcap-dev", "pkg-config libssl-dev clang lld cmake libcap-dev"),
    workflow.replace("cmake_minor >= 28", "cmake_minor >= 0"),
    workflow.replace(install, ""),
    workflow.replace(install, install.replace(" install --yes", " install --no-upgrade --yes")),
    workflow.replace("          ld.lld --version\n", ""),
    workflow + PATH_RESOLVED_CMAKE[0],
  ]) assert.throws(() => withoutSharedPrerequisiteTimeout("browser-e2e.yml", changed));
});
test("hosted Shared children install the locked Chromium without Playwright's apt pass; self-hosted guests keep --with-deps", () => {
  const names = ["Install locked Chromium and operating-system dependencies", "Install locked Chromium on the provisioned hosted image",
    "Bind the launcher to the locked test Chromium", "Install fixture display, database and compiler prerequisites"];
  const browserUi = cacheStep("browser-ui", names[0]);
  for (const job of jobs.filter(job => job.script)) {
    const source = section(job.key), at = names.map(name => source.indexOf(`      - name: ${name}\n`));
    for (const name of names) assert.equal(source.split(`      - name: ${name}\n`).length - 1, 1, `${job.key}: ${name}`);
    assert.ok(at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])), `${job.key}: install order`);
    const [self, hosted, bind] = names.slice(0, 3).map(name => cacheStep(job.key, name));
    // The self-hosted command is the unchanged Browser UI step plus only its guard.
    assert.equal(self, browserUi.replace(`\n${withDeps.trimEnd()}`, `\n${selfHostedIf}${withDeps.trimEnd()}`));
    assert.equal(`${hosted}\n`, HOSTED_CHROMIUM_STEP);
    assert.ok(source.includes(`${self}\n${hosted}\n${bindStep}`), job.key);
    assert.doesNotMatch(hosted, /--with-deps|install-deps|apt-get|sudo|continue-on-error/u);
    // Exactly one twin runs on either runner type and neither on an empty or
    // unknown one, where the binding's executable check then fails closed.
    for (const ref of CACHE_REFS) for (const environment of ["self-hosted", "github-hosted", "", "unknown", undefined]) {
      assert.deepEqual([self, hosted].map(step => cacheStepRuns(step, environment, ref)),
        [environment === "self-hosted", environment === "github-hosted"], `${job.key}: ${environment} ${ref}`);
    }
    assert.match(bind, /\n          test -x "\$chromium_path"\n/u);
    assert.ok(source.includes(`run: node --test scripts/browser-profile-e2e.test.mjs scripts/shared-browser-studio-e2e.test.mjs ${fixtureGuards} ${hostedGuard}\n`), job.key);
  }
  for (const key of ["personal", "browser-ui"]) assert.doesNotMatch(section(key), /ensure-hosted-chromium-host|provisioned hosted image/u, key);
  assert.equal(workflow.split("--with-deps").length - 1, 4);
  assert.equal(workflow.split(`${withDeps.trimEnd().split("run: ")[1]}\n`).length - 1, 4);
  assert.equal(workflow.split("          pnpm --filter @instafy/frontend exec playwright install chromium\n").length - 1, 2);
  assert.ok(fs.statSync(path.join(root, "scripts/ensure-hosted-chromium-host.mjs")).isFile());
  assert.ok(fs.statSync(path.join(root, "scripts/ensure-hosted-chromium-host.test.mjs")).isFile());
  const pair = `${chromiumStep}${selfHostedIf}${withDeps}${HOSTED_CHROMIUM_STEP}`;
  for (const changed of [
    workflow.replace(HOSTED_CHROMIUM_STEP, HOSTED_CHROMIUM_STEP.replace("playwright install chromium", "playwright install --with-deps chromium")),
    workflow.replace(HOSTED_CHROMIUM_STEP, HOSTED_CHROMIUM_STEP.replace("        timeout-minutes: 10\n", "")),
    workflow.replace(HOSTED_CHROMIUM_STEP, HOSTED_CHROMIUM_STEP.replace(" install\n", " verify\n")),
    workflow.replace(`${chromiumStep}${selfHostedIf}`, chromiumStep),
    workflow.replace(HOSTED_CHROMIUM_STEP, HOSTED_CHROMIUM_STEP.replace("        if: runner.environment == 'github-hosted'\n", "")),
    workflow.replace(HOSTED_CHROMIUM_STEP, ""),
    workflow.replace(pair, `${pair}${HOSTED_CHROMIUM_STEP}`),
    workflow + HOSTED_CHROMIUM_STEP,
    workflow.replace(`${fixtureGuards} ${hostedGuard}\n`, `${fixtureGuards}\n`),
    workflow.replace(`${chromiumStep}${withDeps}`, `${chromiumStep}${selfHostedIf}${withDeps}`),
  ]) assert.throws(() => withoutSharedPrerequisiteTimeout("browser-e2e.yml", changed));
});
// Actions' `shell: bash` resolves bash from PATH. The step relies on errexit
// for failed [[ ]] tests, which bash 4.1+ provides; fail, never skip. The stubs
// are written once and each run only links them, because a newly written
// executable can take half a second to start the first time on macOS. A run
// that is killed or times out throws; it never counts as the step failing.
function prerequisiteRunner(tools, body) {
  const probe = spawnSync("bash", ["-c", 'command -v bash; echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: "utf8" });
  const [bash, version = ""] = (probe.stdout ?? "").trim().split("\n"), [major, minor] = version.split(" ").map(Number);
  assert.ok(probe.status === 0 && (major > 4 || (major === 4 && minor >= 1)), `bash 4.1 or newer must be on PATH to run this test; found ${bash || "none"} ${version.replace(" ", ".")}`);
  const bin = path.join(tools, "bin"), stub = (file, text) => fs.writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  fs.mkdirSync(bin);
  for (const tool of ["env", "sed"]) {
    const real = ["/usr/bin", "/bin"].map(dir => path.join(dir, tool)).find(candidate => fs.existsSync(candidate));
    fs.symlinkSync(real, path.join(bin, tool));
  }
  stub(path.join(bin, "sudo"), '[ "$1" = -n ] || exit 97\nshift\nexec "$@"');
  stub(path.join(bin, "apt-get"), `printf 'DEBIAN_FRONTEND=%s apt-get %s\\n' "\${DEBIAN_FRONTEND:-}" "$*" >> "$STUB_RUN/calls.log"\n`
    + 'case " $* " in *" install "*" cmake ") [ -z "$STUB_CMAKE_NOT_LANDED" ] || exit 0; exec /bin/ln -s "$STUB_TOOLS/cmake" "$STUB_RUN/bin/cmake";; *" install "*) exit "$STUB_APT_STATUS";; esac');
  stub(path.join(bin, "dpkg-query"), 'case "$3" in cmake) printf \'dpkg-query %s\\n\' "$3" >> "$STUB_RUN/calls.log"; [ -e "$STUB_RUN/bin/cmake" ] || { printf \'unknown ok not-installed\'; exit 0; };; esac\n'
    + 'case " $STUB_MISSING " in *" $3 "*) printf \'deinstall ok config-files\'; exit 0;; esac\nprintf \'install ok installed\'');
  stub(path.join(bin, "pkg-config"), `printf 'pkg-config %s\\n' "$*" >> "$STUB_RUN/calls.log"`);
  // Linked into a run's PATH only when that host has them.
  stub(path.join(tools, "cmake"), "printf 'cmake version %s\\n\\nCMake suite maintained and supported by Kitware (kitware.com/cmake).\\n' \"$STUB_CMAKE_VERSION\"");
  stub(path.join(tools, "ld.lld"), "printf 'Ubuntu LLD 18.1.3 (compatible with GNU linkers)\\n'");
  let runs = 0;
  return ({ cmake, cmakeLands = true, lld = true, missing = [], aptStatus = 0 }) => {
    const run = path.join(tools, `run-${++runs}`), runBin = path.join(run, "bin"), log = path.join(run, "calls.log");
    fs.mkdirSync(runBin, { recursive: true });
    if (cmake !== undefined) fs.symlinkSync(path.join(tools, "cmake"), path.join(runBin, "cmake"));
    if (lld) fs.symlinkSync(path.join(tools, "ld.lld"), path.join(runBin, "ld.lld"));
    // Without a host CMake, the one apt links in is Ubuntu 24.04's.
    const result = spawnSync(bash, ["-c", body], { cwd: run, encoding: "utf8", timeout: 60_000, env: { PATH: `${runBin}:${bin}`, STUB_TOOLS: tools,
      STUB_RUN: run, STUB_CMAKE_VERSION: cmake ?? "3.28.3", STUB_CMAKE_NOT_LANDED: cmakeLands ? "" : "1", STUB_MISSING: missing.join(" "), STUB_APT_STATUS: String(aptStatus) } });
    assert.ok(result.error === undefined && result.signal === null, `the step body did not finish: ${result.error?.message ?? result.signal}`);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, run, cmake: path.join(runBin, "cmake"),
      calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };
}
test("the prerequisite step fetches Ubuntu's CMake only where none is on PATH and verifies the resolved CMake and LLD", () => {
  const options = "-o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30";
  const packages = "x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler";
  const update = `DEBIAN_FRONTEND= apt-get ${options} update`, install = `DEBIAN_FRONTEND=noninteractive apt-get ${options} install --yes --no-install-recommends`;
  const lld = "Ubuntu LLD 18.1.3 (compatible with GNU linkers)\n";
  // Both children run the same pinned bytes, so one set of runs covers both.
  const [body, ...others] = jobs.filter(job => job.script).map(job => cacheStep(job.key, "Install fixture display, database and compiler prerequisites")
    .split("        run: |\n")[1].replace(/^ {10}/gmu, ""));
  for (const other of others) assert.equal(other, body);
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), "shared-prerequisites-"));
  try {
    const run = prerequisiteRunner(tools, body);
    // Hosted image: CMake 3.31.6 already precedes Ubuntu's on PATH, so only the shared list installs.
    const hosted = run({ cmake: "3.31.6" });
    assert.equal(hosted.status, 0, hosted.stderr);
    assert.deepEqual(hosted.calls, [update, `${install} ${packages}`, "pkg-config --exists libcap openssl"]);
    assert.equal(hosted.stdout, `${hosted.cmake}\n${lld}`);
    // A guest without CMake installs exactly Ubuntu's package with the same options, then checks it.
    const guest = run({});
    assert.equal(guest.status, 0, guest.stderr);
    assert.deepEqual(guest.calls, [update, `${install} ${packages}`, `${install} cmake`, "dpkg-query cmake", "pkg-config --exists libcap openssl"]);
    assert.equal(guest.stdout, `${guest.cmake}\n${lld}`);
    for (const cmake of ["3.28.0", "4.1.2"]) assert.equal(run({ cmake }).status, 0, cmake);
    // An older or unparsable CMake fails with an error naming it, before LLD or
    // pkg-config, and a version written as an arithmetic expression is never evaluated.
    for (const cmake of ["3.27.9", "2.8.12", "garbage", "x.y", "", "BASH_VERSINFO[0].99", "BASH_VERSINFO[$(:>evaluated)0].99"]) {
      const rejected = run({ cmake });
      assert.equal(rejected.status, 1, cmake);
      assert.equal(rejected.stdout, `${rejected.cmake}\n::error::CMake '${cmake}' at ${rejected.cmake} is older than 3.28 or unparsable.\n`);
      assert.deepEqual(rejected.calls, [update, `${install} ${packages}`], cmake);
      assert.equal(fs.existsSync(path.join(rejected.run, "evaluated")), false, cmake);
    }
    // A CMake install that does not land, a failed install and an unverified
    // package stop the step before it resolves CMake; a missing LLD driver stops it before pkg-config.
    for (const [failure, status, calls] of [[{ cmakeLands: false }, 1, [update, `${install} ${packages}`, `${install} cmake`, "dpkg-query cmake"]],
      [{ cmake: "3.31.6", aptStatus: 100 }, 100, [update, `${install} ${packages}`]],
      [{ cmake: "3.31.6", missing: ["libcap-dev"] }, 1, [update, `${install} ${packages}`]]]) {
      const stopped = run(failure);
      assert.deepEqual([stopped.status, stopped.stdout, stopped.calls], [status, "", calls], JSON.stringify(failure));
    }
    const noLld = run({ cmake: "3.31.6", lld: false });
    assert.deepEqual([noLld.status, noLld.stdout, noLld.calls], [127, `${noLld.cmake}\n`, [update, `${install} ${packages}`]]);
    assert.match(noLld.stderr, /ld\.lld: command not found/u);
  } finally { fs.rmSync(tools, { recursive: true, force: true }); }
});
function withoutPersonalElectronPreparation(source) {
  const step = "      - name: Install the locked Electron binary\n        timeout-minutes: 5\n        env:\n          NODE_USE_ENV_PROXY: \"1\"\n        run: pnpm --filter @instafy/desktop-app exec install-electron\n";
  assert.equal(source.split(step).length - 1, 1);
  return source.replace(step, "");
}
test("only the two Shared startup steps select the browser-test profile; all previous workflow bytes remain", () => {
  const originalStartup = "      - name: Start disposable migrated Supabase and local authentication\n";
  const selectedStartup = `${originalStartup}        env:\n          SUPABASE_BROWSER_TEST: "1"\n`;
  assert.equal(workflow.split(selectedStartup).length - 1, 2);
  assert.equal((workflow.match(/SUPABASE_BROWSER_TEST/g) ?? []).length, 2);
  for (const job of jobs) {
    if (job.script) assert.ok(section(job.key).includes(`${selectedStartup}        run: |\n          pnpm supabase:up\n`));
    else assert.doesNotMatch(section(job.key), /SUPABASE_BROWSER_TEST/u);
  }
  // Normalize only the explicit profile opt-ins. All commands, permissions,
  // selectors, timeouts, assertions, cleanup and aggregate bytes stay intact.
  const original = withoutPersonalElectronPreparation(withoutRestoreOnlyCaches(withStandaloneMigrationImagePreparation(previousAggregateWorkflow()))).replaceAll(selectedStartup, originalStartup);
  assert.equal(createHash("sha256").update(original).digest("hex"),
    "39492b8b3c32d931444180ac4e7e52d77b6aa8eed9937b55d6d5bad7ee8aa0ec");
});
test("the Cargo default changes only four compiler environments and its exact helper, not fixture behavior", () => {
  const reviewed = {
    "scripts/browser-profile-e2e.mjs": "134b841a2fbc0a59b64bd05a3ef6b9a4421c0eff7c8dce431d3923743974fd51",
    "scripts/shared-browser-studio-e2e.mjs": "be9b5ed601a895f6ae275f2ab5697d042cf5d7e97508cb38819f0709bb1f172e",
  };
  for (const [relative, hash] of Object.entries(reviewed)) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.equal((source.match(/env: cargoEnv/g) ?? []).length, 2);
    assert.equal((source.match(/const cargoEnv = fixtureCargoEnvironment\(process\.env\);/g) ?? []).length, 1);
    const original = withoutCargoLinkerDefault(source);
    assert.doesNotMatch(original, /fixtureCargoEnvironment|cargoEnv/);
    assert.equal(createHash("sha256").update(original).digest("hex"), hash, relative);
  }
  for (const job of jobs.filter(job => job.script)) {
    assert.match(section(job.key), /install --yes --no-install-recommends x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler\n/);
    assert.match(section(job.key), /for package in x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler; do\n/);
    // The fixtures link with -fuse-ld=lld, so the step proves the driver exists.
    assert.match(section(job.key), /\n          ld\.lld --version\n/);
  }
});
test("the reviewed fixtures need no Edge Functions and retain their exact assertions and global stack configuration", () => {
  const reviewed = {
    "scripts/browser-profile-e2e.mjs": "4670ec7470180cc3c4e35834ecc202275fd57582c51740608ca3e06430b575c6",
    "scripts/shared-browser-studio-e2e.mjs": "ceb744e4423e6c26b83659b59085626ebfcc5755834eb6daa7b1c5339deb072a",
    "supabase/supabase/config.toml": "662c532ac3c7ad8674b2a716ca4d55d2e67f7593b143a7b38c9073737b4647f4",
  };
  for (const [relative, hash] of Object.entries(reviewed)) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    // Remove only the exact Cargo default and opt-in compiler diagnostics to
    // retain the original proof for assertions, commands, services and cleanup.
    const original = withoutCargoLinkerDefault(source)
      .replace(/\/\/ Opt-in for the secret-free fixture compiler calls only,[\s\S]*?(?=export function fixtureChildEnvironment)/u, "")
      .replace("onOutput, onFailure }", "onOutput }")
      .replace("    if (status !== 0) onFailure?.(output);\n", "")
      .replaceAll(/, onFailure: output => reportCargoCompilerErrors\(output, "packages\/runtime-(?:agent|controller)"\)/g, "")
      .replace("preflightFixtureDisplay, reportCargoCompilerErrors, runOwnedProcess", "preflightFixtureDisplay, runOwnedProcess");
    assert.equal(createHash("sha256").update(original).digest("hex"), hash, `re-review browser service dependencies when changing ${relative}`);
    assert.doesNotMatch(source, /functions\.invoke|\/functions\/v1|^\[functions\./mu);
  }
  for (const relative of ["supabase/functions", "supabase/supabase/functions"]) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, "new Edge Functions require reviewing this browser-test profile");
  }
  const config = fs.readFileSync(path.join(root, "supabase/supabase/config.toml"), "utf8");
  for (const service of ["auth", "realtime", "storage", "edge_runtime"]) {
    assert.match(config, new RegExp(`^\\[${service}\\]\\nenabled = true$`, "m"));
  }
});
test("Shared startup omits only standalone migration-image preparation, retaining the full CLI stack", () => {
  assert.doesNotMatch(workflow, /instafy-image-cache|shared-browser-image-v1|ensure-supabase-postgres-image/u);
  for (const job of jobs.filter(job => job.script)) {
    assert.ok(section(job.key).includes('SUPABASE_BROWSER_TEST: "1"\n        run: |\n          pnpm supabase:up\n'));
  }
  assert.equal(createHash("sha256").update(withStandaloneMigrationImagePreparation(previousAggregateWorkflow())).digest("hex"),
    "48e8ed7ce8e931e7679290199102717cc65de943dcdc3eacf63b61eacacef2f1");
  // The standalone migration lane really consumes this cache; keep it there.
  const build = fs.readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
  assert.match(build, /path: ~\/\.instafy-image-cache/u);
  assert.match(build, /run: node scripts\/ensure-supabase-postgres-image\.mjs/u);
  assert.match(build, /run: node scripts\/test-supabase-migrations-empty-db\.mjs/u);
});
test("both Shared children use one compiler cache isolated by operating system, architecture and lockfiles without fallback keys", () => {
  const key = "key: shared-browser-cargo-v2-${{ runner.os }}-${{ runner.arch }}-public-shared-browser-${{ hashFiles('packages/*/Cargo.lock') }}";
  const inputs = "        with:\n          path: |\n            ~/.cargo/registry/index\n            ~/.cargo/registry/cache\n"
    + "            ~/.cargo/git/db\n            .cargo-target\n          " + key;
  for (const job of jobs.filter(job => job.script)) {
    const source = section(job.key);
    for (const name of ["Restore compiler cache without saving", "Restore architecture-specific compiler cache"]) {
      // Identical inputs give the same cache version, so the profile child
      // restores exactly what the Studio child saved from main.
      assert.equal(cacheStep(job.key, name).split("        with:\n")[1].trimEnd(), inputs.split("        with:\n")[1]);
    }
    assert.doesNotMatch(source, /restore-keys:|supabase-postgres-image-\$\{|registry\/src|git\/checkouts/u);
  }
  assert.equal(workflow.split(key).length - 1, 4);
});
test("only the Shared restore-only compiler steps bound segment waits without changing required work", () => {
  assert.equal(workflow.split(compilerSegmentTimeout).length - 1, 2);
  assert.equal((workflow.match(/SEGMENT_DOWNLOAD_TIMEOUT_MINS/g) ?? []).length, 2);
  for (const job of jobs.filter(job => job.script)) {
    const restore = cacheStep(job.key, "Restore compiler cache without saving");
    const hosted = cacheStep(job.key, "Restore architecture-specific compiler cache");
    // Every self-hosted run uses this step; Studio's also serves hosted non-main refs.
    for (const ref of CACHE_REFS) assert.equal(cacheStepRuns(restore, "self-hosted", ref), true);
    assert.ok(restore.includes(compilerSegmentTimeout));
    assert.doesNotMatch(hosted, /SEGMENT_DOWNLOAD_TIMEOUT_MINS/u);
    assert.doesNotMatch(restore, /timeout-minutes:|continue-on-error|fail-on-cache-miss|lookup-only/u);
    assert.doesNotMatch(section(job.key), /cache-hit|continue-on-error/u);
  }
  // Exact merged baseline: both complete fixtures, migrations, cleanup, hosted
  // restores, job budgets and aggregate remain byte-for-byte intact; only the
  // reversed main-only cache change differs.
  assert.equal(createHash("sha256").update(withoutCompilerSegmentTimeout(previousAggregateWorkflow())).digest("hex"),
    "5c97291dd95421be8b8311413589a975c3fdc0c8dc831a3416f82c8b3bb441ff");
});
test('only the hosted Studio main run saves the Shared compiler cache; every other run restores only', () => {
  const restoreOnly = /^        uses: actions\/cache\/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0$/mu;
  for (const job of jobs.filter(job => job.script)) {
    const restore = cacheStep(job.key, 'Restore compiler cache without saving');
    const hosted = cacheStep(job.key, 'Restore architecture-specific compiler cache');
    assert.match(restore, restoreOnly);
    assert.equal(restore.split('        with:\n')[1].trimEnd(), hosted.split('        with:\n')[1].trimEnd());
    if (job.key === 'shared-studio') {
      assert.match(hosted, /^        uses: actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0$/mu);
      assertMainOnlySave(restore, hosted, job.key);
    } else {
      // The profile child never saves: one restore-only step per runner type.
      assert.match(hosted, restoreOnly);
      for (const ref of CACHE_REFS) for (const environment of ['self-hosted', 'github-hosted', '', 'unknown']) {
        assert.equal(cacheStepRuns(restore, environment, ref), environment === 'self-hosted');
        assert.equal(cacheStepRuns(hosted, environment, ref), environment === 'github-hosted');
      }
    }
    assert.equal((section(job.key).match(/uses: actions\/cache(?:\/\w+)?@/gu) ?? []).length, 2);
    assert.doesNotMatch(section(job.key), /actions\/cache\/save@|continue-on-error|save-always|lookup-only/u);
  }
  assert.equal((workflow.match(/uses: actions\/cache\/restore@/gu) ?? []).length, 3);
  assert.equal(assertNoPullRequestCacheSave(workflow, 'browser-e2e.yml'), 1);
  // Complete browser-e2e.yml at combined source 2ef4dde, including image caches,
  // every fixture/assertion, strict aggregate and the ordinary browser lanes.
  assert.equal(createHash('sha256').update(withoutPersonalElectronPreparation(withoutRestoreOnlyCaches(withStandaloneMigrationImagePreparation(previousAggregateWorkflow())))).digest('hex'),
    '1e3cc8932d4cc78e1eb64ce389bd2b959362bb22bbaa92d155cf6743c5fd19c8');
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
  assert.ok(source.includes("needs:\n      - shared-profile-lifecycle\n      - shared-studio\n" + aggregateIf));
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
