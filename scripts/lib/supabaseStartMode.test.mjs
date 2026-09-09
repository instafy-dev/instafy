import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  AUTH_ONLY_EXCLUDED_CONTAINERS,
  BROWSER_TEST_EXCLUDED_CONTAINERS,
  buildSupabaseStartArgs,
  parseSupabaseAuthOnly,
  parseSupabaseBrowserTest,
  parseSupabaseDatabaseOnly,
  resolveSupabaseStartMode,
} from "./supabaseStartMode.mjs";

test("default Supabase startup remains the complete local stack", () => {
  assert.equal(parseSupabaseDatabaseOnly(undefined), false);
  assert.equal(parseSupabaseDatabaseOnly(""), false);
  assert.equal(parseSupabaseDatabaseOnly("0"), false);
  assert.deepEqual(buildSupabaseStartArgs(undefined), ["start"]);
  assert.deepEqual(buildSupabaseStartArgs("0", { ignoreHealthCheck: true }), [
    "start",
    "--ignore-health-check",
  ]);
});

test("database-only startup uses the CLI's dedicated Postgres command", () => {
  assert.equal(parseSupabaseDatabaseOnly("1"), true);
  assert.deepEqual(buildSupabaseStartArgs("1"), ["db", "start"]);
  assert.deepEqual(buildSupabaseStartArgs("1", { ignoreHealthCheck: true }), [
    "db",
    "start",
  ]);
});

test("database-only startup rejects ambiguous opt-in values", () => {
  for (const value of ["true", "yes", " 1 ", "false", 1]) {
    assert.throws(
      () => parseSupabaseDatabaseOnly(value),
      /SUPABASE_DATABASE_ONLY must be unset, 0, or 1/,
    );
  }
});

test("Auth-only startup is a typed, explicit five-service profile with fixed exclusions on retry", () => {
  for (const value of [undefined, "", "0"]) {
    assert.equal(parseSupabaseAuthOnly(value), false);
    assert.equal(resolveSupabaseStartMode(undefined, value), "full");
    assert.deepEqual(buildSupabaseStartArgs(undefined, { authOnly: value }), ["start"]);
  }
  assert.equal(parseSupabaseAuthOnly("1"), true);
  assert.equal(resolveSupabaseStartMode(undefined, "1"), "auth-email");
  assert.equal(resolveSupabaseStartMode("1", "0"), "database");
  assert.deepEqual(AUTH_ONLY_EXCLUDED_CONTAINERS, [
    "realtime", "storage-api", "imgproxy", "edge-runtime", "postgres-meta",
    "studio", "logflare", "vector", "supavisor",
  ]);
  assert.ok(Object.isFrozen(AUTH_ONLY_EXCLUDED_CONTAINERS));
  const args = ["start", "--exclude", AUTH_ONLY_EXCLUDED_CONTAINERS.join(",")];
  assert.deepEqual(buildSupabaseStartArgs(undefined, { authOnly: "1" }), args);
  assert.deepEqual(buildSupabaseStartArgs(undefined, { authOnly: "1", ignoreHealthCheck: true }), [...args, "--ignore-health-check"]);
  for (const value of ["true", "yes", " 1 ", "false", "TRUE", 1, true]) {
    assert.throws(() => buildSupabaseStartArgs(undefined, { authOnly: value }), /SUPABASE_AUTH_ONLY must/);
  }
  for (const ignoreHealthCheck of [false, true]) {
    assert.throws(() => buildSupabaseStartArgs("1", { authOnly: "1", ignoreHealthCheck }), /mutually exclusive/);
  }
});

test("browser-test startup excludes only Edge Runtime on both initial start and retry", () => {
  assert.deepEqual(BROWSER_TEST_EXCLUDED_CONTAINERS, ["edge-runtime"]);
  assert.ok(Object.isFrozen(BROWSER_TEST_EXCLUDED_CONTAINERS));
  for (const value of [undefined, "", "0"]) {
    assert.equal(parseSupabaseBrowserTest(value), false);
    assert.equal(resolveSupabaseStartMode(undefined, undefined, value), "full");
    assert.deepEqual(buildSupabaseStartArgs(undefined, { browserTest: value }), ["start"]);
    assert.deepEqual(buildSupabaseStartArgs("1", { browserTest: value }), ["db", "start"]);
    assert.deepEqual(buildSupabaseStartArgs(undefined, { authOnly: "1", browserTest: value }),
      ["start", "--exclude", AUTH_ONLY_EXCLUDED_CONTAINERS.join(",")]);
  }
  assert.equal(parseSupabaseBrowserTest("1"), true);
  assert.equal(resolveSupabaseStartMode(undefined, undefined, "1"), "browser-test");
  for (const ignoreHealthCheck of [false, true]) {
    assert.deepEqual(buildSupabaseStartArgs(undefined, { browserTest: "1", ignoreHealthCheck }),
      ["start", "--exclude", "edge-runtime", ...(ignoreHealthCheck ? ["--ignore-health-check"] : [])]);
    for (const [database, authOnly] of [["1", undefined], [undefined, "1"], ["1", "1"]]) {
      assert.throws(() => buildSupabaseStartArgs(database, { authOnly, browserTest: "1", ignoreHealthCheck }), /mutually exclusive/);
    }
  }
  for (const value of ["true", "yes", " 1 ", "false", "TRUE", 1, true]) {
    assert.throws(() => buildSupabaseStartArgs(undefined, { browserTest: value }), /SUPABASE_BROWSER_TEST must/);
  }
});

// Execute the real startup functions with inert external boundaries. Importing
// the CLI module itself would start a developer's stack, which tests must not do.
function stackFixture(env = {}, { failFirst = false, failRetry = false, failPreparation = false, existing = null } = {}) {
  const source = fs.readFileSync(new URL("../supabase-stack.mjs", import.meta.url), "utf8");
  const program = source.slice(source.indexOf("function startSupabase()"), source.indexOf("function stopSupabase()"));
  assert.match(program, /function ensureSupabase\(\)/);
  const calls = [];
  let starts = 0;
  const record = (name, ...args) => calls.push([name, ...args]);
  const context = vm.createContext({
    process: { env }, resolveSupabaseStartMode, buildSupabaseStartArgs,
    repoRoot: "/inert", supabaseProjectDir: "/inert/supabase", supabaseFlag: "/inert/flag",
    console: { log() {}, warn() {} },
    fs: { writeFileSync: () => record("flag") },
    syncSupabaseMigrationsDir: () => record("sync"),
    ensureTmpDir: () => record("tmp"),
    applySupabaseMigrations: () => record("migrate"),
    ensureSupabaseEmailTemplateMounts: () => record("templates"),
    readSupabaseEnv: () => { record("status"); return existing; },
    prepareSupabaseSerialPull: (options) => {
      record("prepare", JSON.parse(JSON.stringify(options)));
      if (failPreparation) throw Error("preparation-refused");
    },
    runSupabase: (args) => {
      record("cli", Array.from(args));
      if (args[0] !== "stop" && (++starts === 1 ? failFirst : failRetry)) throw Error("startup-failed");
    },
  });
  vm.runInContext(program, context, { timeout: 1000 });
  return { calls, run: (name = "startSupabase") => vm.runInContext(`${name}()`, context, { timeout: 1000 }) };
}

test("real startup and retry use the same profile while retaining templates, migrations and status", () => {
  for (const [env, databaseOnly, authOnly, browserTest] of [
    [{}, false, false, false], [{ SUPABASE_DATABASE_ONLY: "1" }, true, false, false],
    [{ SUPABASE_AUTH_ONLY: "1" }, false, true, false], [{ SUPABASE_BROWSER_TEST: "1" }, false, false, true],
  ]) for (const failFirst of [false, true]) {
    const h = stackFixture(env, { failFirst });
    assert.equal(h.run().started, true);
    const args = buildSupabaseStartArgs(env.SUPABASE_DATABASE_ONLY, { authOnly: env.SUPABASE_AUTH_ONLY, browserTest: env.SUPABASE_BROWSER_TEST });
    const retry = buildSupabaseStartArgs(env.SUPABASE_DATABASE_ONLY, { authOnly: env.SUPABASE_AUTH_ONLY, browserTest: env.SUPABASE_BROWSER_TEST, ignoreHealthCheck: !databaseOnly });
    assert.deepEqual(h.calls.filter(([name]) => name === "cli"),
      failFirst ? [["cli", args], ["cli", ["stop"]], ["cli", retry]] : [["cli", args]]);
    assert.deepEqual(h.calls.find(([name]) => name === "prepare"), ["prepare", { repoRoot: "/inert", databaseOnly, authOnly, browserTest }]);
    assert.deepEqual(h.calls.slice(-(databaseOnly ? 4 : 5)).map(([name]) => name),
      [...(databaseOnly ? [] : ["templates"]), "tmp", "flag", "migrate", "status"]);
  }
});

test("invalid or conflicting profiles fail before status, migration copies or any command", () => {
  for (const env of [{ SUPABASE_DATABASE_ONLY: "1", SUPABASE_AUTH_ONLY: "1" },
    { SUPABASE_BROWSER_TEST: "1", SUPABASE_DATABASE_ONLY: "1" },
    { SUPABASE_BROWSER_TEST: "1", SUPABASE_AUTH_ONLY: "1" }, { SUPABASE_BROWSER_TEST: "true" },
    { SUPABASE_AUTH_ONLY: "true" }, { SUPABASE_DATABASE_ONLY: "true", SUPABASE_AUTH_ONLY: "1" }]) {
    for (const entry of ["startSupabase", "ensureSupabase"]) {
      const h = stackFixture(env);
      assert.throws(() => h.run(entry), /mutually exclusive|must be unset/);
      assert.deepEqual(h.calls, []);
    }
  }
});

test("Auth preparation or repeated startup failure cannot fall back to a full stack", () => {
  const preparation = stackFixture({ SUPABASE_AUTH_ONLY: "1" }, { failPreparation: true });
  assert.throws(() => preparation.run(), /preparation-refused/);
  assert.deepEqual(preparation.calls.map(([name]) => name), ["sync", "prepare"]);
  const retry = stackFixture({ SUPABASE_AUTH_ONLY: "1" }, { failFirst: true, failRetry: true });
  assert.throws(() => retry.run(), /startup-failed/);
  assert.equal(retry.calls.filter(([name]) => name === "cli").length, 3);
  assert.ok(retry.calls.every(([name]) => !["templates", "flag", "migrate", "status"].includes(name)));
});

test("browser-test preparation and startup failures never re-enable Edge Runtime", () => {
  const preparation = stackFixture({ SUPABASE_BROWSER_TEST: "1" }, { failPreparation: true });
  assert.throws(() => preparation.run(), /preparation-refused/);
  assert.deepEqual(preparation.calls.map(([name]) => name), ["sync", "prepare"]);
  const retry = stackFixture({ SUPABASE_BROWSER_TEST: "1" }, { failFirst: true, failRetry: true });
  assert.throws(() => retry.run(), /startup-failed/);
  assert.deepEqual(retry.calls.filter(([name]) => name === "cli"), [
    ["cli", ["start", "--exclude", "edge-runtime"]], ["cli", ["stop"]],
    ["cli", ["start", "--exclude", "edge-runtime", "--ignore-health-check"]],
  ]);
  assert.ok(retry.calls.every(([name]) => !["templates", "flag", "migrate", "status"].includes(name)));
});

test("existing-stack reuse keeps template and migration checks for Auth and full mode", () => {
  for (const env of [{}, { SUPABASE_AUTH_ONLY: "1" }, { SUPABASE_DATABASE_ONLY: "1" }, { SUPABASE_BROWSER_TEST: "1" }]) {
    const h = stackFixture(env, { existing: { API_URL: "http://127.0.0.1:54321" } });
    assert.equal(h.run("ensureSupabase").started, false);
    assert.deepEqual(h.calls.map(([name]) => name),
      ["status", ...(env.SUPABASE_DATABASE_ONLY ? [] : ["templates"]), "migrate"]);
  }
});
