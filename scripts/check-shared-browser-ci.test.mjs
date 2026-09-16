import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/browser-e2e.yml"), "utf8");
const aggregateIf = "    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}";
const jobs = [
  { key: "shared-profile", label: "public-shared-browser-aggregate", name: "Shared Browser profile E2E", minutes: 5 },
  { key: "shared-profile-lifecycle", label: "public-shared-browser-profile", name: "Shared Browser profile lifecycle", minutes: 30, script: "browser-profile-e2e.mjs" },
  { key: "shared-studio", label: "public-shared-browser-studio", name: "Shared Browser Studio journey", minutes: 30, script: "shared-browser-studio-e2e.mjs" },
];
const section = key => workflow.split(`\n  ${key}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];
test("the Shared aggregate and both children run on hosted Ubuntu 24.04 with their exact names and budgets", () => {
  for (const job of jobs) {
    assert.ok(section(job.key).includes(`    name: ${job.name}\n`));
    assert.match(section(job.key), /^    runs-on: ubuntu-24\.04$/mu);
    assert.equal((section(job.key).match(/runs-on:/g) ?? []).length, 1);
    assert.ok(section(job.key).includes(`    timeout-minutes: ${job.minutes}\n`));
    assert.doesNotMatch(section(job.key), /runner\.environment|self-hosted|Qualify isolated|SEGMENT_DOWNLOAD_TIMEOUT_MINS/u);
  }
});
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
    assert.match(source, /Free space on the disposable hosted runner\n        run: \|/u);
    assert.ok(source.includes("INSTAFY_SHARED_BROWSER_COMPILER_PROXY: '0'\n"));
    assert.doesNotMatch(source, /SUPABASE_DATABASE_ONLY|--ignore-scripts|--no-sandbox|--allow-unauthenticated|continue-on-error|--grep|--retries=|--pass-with-no-tests/u);
  }
  assert.doesNotMatch(workflow, /secrets:|secrets\.|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|HTTP_PROXY:|HTTPS_PROXY:/u);
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
    assert.match(section(job.key), /install --yes --no-install-recommends x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld cmake libcap-dev protobuf-compiler/);
    assert.match(section(job.key), /for package in x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld cmake libcap-dev protobuf-compiler/);
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
  // The standalone migration lane really consumes this cache; keep it there.
  const build = fs.readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
  assert.match(build, /path: ~\/\.instafy-image-cache/u);
  assert.match(build, /run: node scripts\/ensure-supabase-postgres-image\.mjs/u);
  assert.match(build, /run: node scripts\/test-supabase-migrations-empty-db\.mjs/u);
});
test("Shared compiler caches isolate operating system, architecture and child targets without fallback keys", () => {
  for (const job of jobs.filter(job => job.script)) {
    const source = section(job.key);
    assert.ok(source.includes(`key: shared-browser-cargo-v1-\${{ runner.os }}-\${{ runner.arch }}-${job.label}-\${{ hashFiles('packages/*/Cargo.lock') }}`));
    assert.doesNotMatch(source, /restore-keys:|supabase-postgres-image-\$\{/u);
    // One unconditional save+restore cache per child; no restore-only mitigation remains.
    assert.match(source, /      - name: Restore architecture-specific compiler cache\n        uses: actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0\n/u);
    assert.equal((source.match(/uses: actions\/cache(?:\/\w+)?@/gu) ?? []).length, 1);
    assert.doesNotMatch(source, /actions\/cache\/(?:restore|save)@|save-always|lookup-only/u);
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
