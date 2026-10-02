import assert from "node:assert/strict";
import vm from "node:vm";

// Test-only inverse of the main-only CI cache change; not runtime authority.
// That change edited Build, Browser verification and Controller DB in three
// ways: cache saves run only for refs/heads/main (hosted cargo caches and the
// migration-image cache; other refs restore only), cargo caches keep the index,
// downloaded crates and git databases instead of unpacked sources, and both
// Shared Browser children use one compiler key that only the Studio child saves.
// Whole-workflow baselines reviewed before the change are still checked through
// this inverse. Every rewritten line must occur exactly the expected number of
// times, so any other cache edit fails here instead of passing quietly.
const pin = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";
const restoreIf = "        if: runner.environment == 'self-hosted' || github.ref != 'refs/heads/main'\n";
const saveIf = "        if: runner.environment == 'github-hosted' && github.ref == 'refs/heads/main'\n";
const previousRestoreIf = "        if: runner.environment == 'self-hosted'\n";
const previousSaveIf = "        if: runner.environment == 'github-hosted'\n";
const cargoPaths = "            ~/.cargo/registry/index\n            ~/.cargo/registry/cache\n            ~/.cargo/git/db\n";
const previousCargoPaths = "            ~/.cargo/registry\n            ~/.cargo/git\n";
const sharedBrowserKey = "key: shared-browser-cargo-v2-${{ runner.os }}-${{ runner.arch }}-public-shared-browser-${{ hashFiles('packages/*/Cargo.lock') }}";
const previousSharedBrowserKey = (child) =>
  `key: shared-browser-cargo-v1-\${{ runner.os }}-\${{ runner.arch }}-public-shared-browser-${child}-\${{ hashFiles('packages/*/Cargo.lock') }}`;
const imageCacheInputs = [
  "        with:",
  "          path: ~/.instafy-image-cache",
  "          key: supabase-postgres-image-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/test-supabase-migrations-empty-db.mjs') }}",
  "",
].join("\n");

function replaceExactly(source, from, to, count, label) {
  assert.equal(source.split(from).length - 1, count, `${label} must occur exactly ${count} time(s)`);
  return source.replaceAll(from, to);
}

function inJob(source, key, rewrite) {
  const marker = `\n  ${key}:\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0 && source.indexOf(marker, start + 1) < 0, `missing or repeated job ${key}`);
  const next = source.slice(start + marker.length).search(/\n  [\w-]+:\n/u);
  const end = next < 0 ? source.length : start + marker.length + next;
  return source.slice(0, start) + rewrite(source.slice(start, end)) + source.slice(end);
}

const inverses = {
  "build.yml": (source) => {
    source = replaceExactly(source,
      `      - name: Restore cargo cache without saving\n${restoreIf}`,
      `      - name: Restore cargo cache without saving\n${previousRestoreIf}`, 10, "Rust restore-only condition");
    source = replaceExactly(source,
      `      - name: Restore cargo cache\n${saveIf}`,
      `      - name: Restore cargo cache\n${previousSaveIf}`, 10, "Rust main-only save condition");
    source = replaceExactly(source, cargoPaths, previousCargoPaths, 20, "Rust cargo cache paths");
    source = replaceExactly(source,
      "      - name: Restore Supabase Postgres image cache without saving\n"
        + "        if: github.ref != 'refs/heads/main'\n"
        + `        uses: actions/cache/restore@${pin}\n${imageCacheInputs}\n`,
      "", 1, "Supabase image restore-only step");
    return replaceExactly(source,
      "      - name: Restore Supabase Postgres image cache\n        if: github.ref == 'refs/heads/main'\n",
      "      - name: Restore Supabase Postgres image cache\n", 1, "Supabase image main-only save condition");
  },
  "browser-e2e.yml": (source) => {
    source = replaceExactly(source, cargoPaths, previousCargoPaths, 4, "Shared Browser cargo cache paths");
    source = inJob(source, "shared-profile-lifecycle", (job) => {
      job = replaceExactly(job, sharedBrowserKey, previousSharedBrowserKey("profile"), 2, "profile shared key");
      return replaceExactly(job,
        `      - name: Restore architecture-specific compiler cache\n${previousSaveIf}        uses: actions/cache/restore@${pin}\n`,
        `      - name: Restore architecture-specific compiler cache\n${previousSaveIf}        uses: actions/cache@${pin}\n`,
        1, "profile hosted restore-only step");
    });
    source = inJob(source, "shared-studio", (job) => {
      job = replaceExactly(job, sharedBrowserKey, previousSharedBrowserKey("studio"), 2, "studio shared key");
      job = replaceExactly(job,
        `      - name: Restore compiler cache without saving\n${restoreIf}`,
        `      - name: Restore compiler cache without saving\n${previousRestoreIf}`, 1, "studio restore-only condition");
      return replaceExactly(job,
        `      - name: Restore architecture-specific compiler cache\n${saveIf}`,
        `      - name: Restore architecture-specific compiler cache\n${previousSaveIf}`, 1, "studio main-only save condition");
    });
    assert.equal(source.split(sharedBrowserKey).length, 1, "the shared key belongs only to the two Shared children");
    return source;
  },
  "controller-db-tests.yml": (source) => {
    source = replaceExactly(source,
      `      - name: Restore compiler cache without saving\n${restoreIf}`,
      `      - name: Restore compiler cache without saving\n${previousRestoreIf}`, 1, "controller restore-only condition");
    source = replaceExactly(source,
      `      - name: Cache controller Cargo dependencies and build\n${saveIf}`,
      `      - name: Cache controller Cargo dependencies and build\n${previousSaveIf}`, 1, "controller main-only save condition");
    return replaceExactly(source, cargoPaths, previousCargoPaths, 2, "controller cargo cache paths");
  },
};

export const MAIN_ONLY_CACHE_FILES = Object.keys(inverses);

// The cache tests evaluate the literal step conditions rather than compare
// them with a copy of the expected text. Conditions may only compare
// runner.environment and github.ref; GitHub compares strings case-insensitively
// and binds && before ||, as JavaScript does.
export const CACHE_RUNNER_ENVIRONMENTS = ["self-hosted", "github-hosted"];
export const CACHE_REFS = ["refs/heads/main", "refs/pull/11/merge", "refs/heads/topic", "refs/heads/main-next",
  "refs/tags/v1.0.0", "refs/heads/gh-readonly-queue/main/pr-11-0123abcd"];

export function cacheStepRuns(step, environment, ref) {
  const expression = step.match(/^        if: (.+)$/mu)?.[1];
  assert.ok(expression, "every cache step must declare when it runs");
  const term = String.raw`(?:runner\.environment|github\.ref) [!=]= '[^']*'`;
  assert.match(expression, new RegExp(String.raw`^${term}(?: (?:&&|\|\|) ${term})*$`, "u"));
  const code = expression.replace(/(runner\.environment|github\.ref) ([!=])= ('[^']*')/gu,
    (_, operand, operator, value) => `${operator === "!" ? "!" : ""}equal(${operand}, ${value})`);
  return vm.runInNewContext(code, { runner: { environment }, github: { ref },
    equal: (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase() }, { timeout: 1000 });
}

// A restore-only step and its saving twin: exactly one runs on either runner
// type for every ref, and only a GitHub-hosted refs/heads/main run saves.
// Unknown runner environments never save.
export function assertMainOnlySave(restore, save, label) {
  for (const ref of CACHE_REFS) {
    for (const environment of CACHE_RUNNER_ENVIRONMENTS) {
      const saves = cacheStepRuns(save, environment, ref);
      assert.equal(saves, environment === "github-hosted" && ref === "refs/heads/main", `${label}: ${environment} ${ref}`);
      assert.equal(cacheStepRuns(restore, environment, ref), !saves, `${label}: ${environment} ${ref}`);
    }
    for (const environment of ["", "unknown", undefined]) assert.equal(cacheStepRuns(save, environment, ref), false, label);
  }
}

// No pull request context, on any runner, can reach an actions/cache step that
// saves, and no step saves through the separate save action or inputs. This
// covers actions/cache only; setup-node `cache: pnpm` is outside this check.
// pull_request_target and workflow_run run with a base-branch ref, so a ref
// condition cannot exclude them; these workflows must not use either event.
export function assertNoPullRequestCacheSave(workflow, label) {
  assert.doesNotMatch(workflow, /actions\/cache\/save@|save-always|lookup-only|pull_request_target|workflow_run/u, label);
  const steps = workflow.split(/(?=^      - )/mu).filter((step) => /^      (?:- | {2})uses: actions\/cache@/mu.test(step));
  assert.equal(steps.length, workflow.split("actions/cache@").length - 1, `${label}: every saving cache use is a step`);
  assert.ok(steps.length > 0, `${label}: no saving cache step found`);
  for (const step of steps) {
    for (const environment of [...CACHE_RUNNER_ENVIRONMENTS, "", "unknown", undefined]) {
      assert.equal(cacheStepRuns(step, environment, "refs/pull/11/merge"), false, `${label}: ${step.split("\n")[0]}`);
    }
  }
  return steps.length;
}

export function withoutMainOnlyCaches(file, source) {
  const inverse = inverses[file];
  if (!inverse) return source;
  source = inverse(source);
  for (const remaining of [restoreIf, saveIf, "~/.cargo/registry/index", "~/.cargo/git/db", "shared-browser-cargo-v2",
    "Postgres image cache without saving"]) assert.ok(!source.includes(remaining), `${file}: unreviewed ${remaining.trim()}`);
  return source;
}
