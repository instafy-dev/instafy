import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// The Supabase CLI (--workdir supabase) applies migrations only from supabase/supabase/migrations,
// an ignored copy of supabase/migrations. Every path that applies migrations refreshes the copy
// first and stops when it cannot, so no run builds or migrates a database from an old copy.
// The real functions run in a sandbox with inert boundaries: importing either script would start
// a stack.

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

// supabase-stack.mjs marks its refusal so that it exits with its own code (see below).
const COPIES = [
  { file: "scripts/supabase-stack.mjs", from: "function syncSupabaseMigrationsDir()", to: "function readSupabaseEnv()", code: "INSTAFY_MIGRATIONS_COPY" },
  { file: "scripts/run-e2e-dev.mjs", from: "function syncSupabaseMigrationsDir()", to: "function ensureOriginSigningKeys()" },
];

function refusal(copy, pattern) {
  return (error) => {
    assert.match(error.message, pattern);
    assert.equal(error.code, copy.code);
    return true;
  };
}

// A sealed run of a script: a fake pnpm in `bin` is all there is on PATH, so no real Supabase CLI,
// docker or stack is ever reached. The fake logs each call, one per line, to PNPM_LOG.
function sealedRun(script, args, { bin, cwd, env = {} }) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { PATH: bin, HOME: cwd, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function fakePnpm(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-fake-pnpm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho "$*" >> "$PNPM_LOG"\n${body}`, { mode: 0o755 });
  const log = path.join(dir, "pnpm.log");
  return {
    dir,
    bin,
    log,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []),
    reset: () => fs.rmSync(log, { force: true }),
  };
}

function slice(file, from, to) {
  const source = read(file);
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${file}: ${from}`);
  return source.slice(start, end);
}

function permissionDenied(name) {
  return () => {
    throw Object.assign(new Error(`EACCES: permission denied, ${name}`), { code: "EACCES" });
  };
}

function mirror(t, copy, { tracked = { "20260101000000_a.sql": "select 2;\n", "20260102000000_b.sql": "select 3;\n" }, stale = { "20260101000000_a.sql": "select 1;\n", "20251231000000_renamed.sql": "select 0;\n" }, failing = null, cliFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-mirror-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trackedDir = path.join(root, "supabase", "migrations");
  const projectDir = path.join(root, "supabase", "supabase");
  const copyDir = path.join(projectDir, "migrations");
  for (const [dir, files] of [[trackedDir, tracked], [copyDir, stale]]) {
    if (!files) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  }
  const calls = [];
  const context = vm.createContext({
    fs: failing ? { ...fs, [failing]: permissionDenied(failing) } : fs,
    console: { log() {}, warn() {} },
    fileExists: (filePath) => fs.existsSync(filePath),
    supabaseMigrationsDir: trackedDir,
    supabaseProjectDir: projectDir,
    supabaseProjectMigrationsDir: copyDir,
    runSupabase: (args) => {
      calls.push(Array.from(args));
      if (cliFails) throw new Error("pnpm exec supabase --workdir supabase migration up --local failed with exit code 1");
    },
  });
  vm.runInContext(slice(copy.file, copy.from, copy.to), context, { timeout: 1000 });
  return {
    calls,
    copyDir,
    copied: () => (fs.existsSync(copyDir) ? fs.readdirSync(copyDir).sort() : null),
    migrate: () => vm.runInContext("applySupabaseMigrations()", context, { timeout: 1000 }),
  };
}

test("each copy refresh replaces the CLI's copy with exactly the tracked migrations, then migrates", (t) => {
  for (const copy of COPIES) {
    const h = mirror(t, copy);
    h.migrate();
    // A migration renamed since the copy was made leaves nothing behind.
    assert.deepEqual(h.copied(), ["20260101000000_a.sql", "20260102000000_b.sql"], copy.file);
    assert.equal(fs.readFileSync(path.join(h.copyDir, "20260101000000_a.sql"), "utf8"), "select 2;\n", copy.file);
    assert.deepEqual(h.calls, [["migration", "up", "--local"]], copy.file);
  }
});

test("a new worktree, which has no copy yet, gets one before the CLI runs", (t) => {
  for (const copy of COPIES) {
    const h = mirror(t, copy, { stale: null });
    assert.equal(h.copied(), null);
    h.migrate();
    assert.deepEqual(h.copied(), ["20260101000000_a.sql", "20260102000000_b.sql"], copy.file);
    assert.deepEqual(h.calls, [["migration", "up", "--local"]], copy.file);
  }
});

test("a copy that cannot be refreshed stops the run before the CLI runs", (t) => {
  for (const copy of COPIES) {
    for (const failing of ["mkdirSync", "rmSync", "cpSync"]) {
      const h = mirror(t, copy, { failing });
      assert.throws(
        () => h.migrate(),
        refusal(copy, /Unable to (?:copy|mirror) .*EACCES.*not running the Supabase CLI on a stale copy/),
        `${copy.file} ${failing}`,
      );
      assert.deepEqual(h.calls, [], `${copy.file} ${failing}`);
    }
  }
});

test("a checkout without supabase/migrations never runs the CLI on whatever copy is there", (t) => {
  for (const copy of COPIES) {
    const h = mirror(t, copy, { tracked: null });
    assert.throws(() => h.migrate(), refusal(copy, /supabase[/\\]migrations is missing; not running the Supabase CLI/), copy.file);
    assert.deepEqual(h.calls, [], copy.file);
    assert.deepEqual(h.copied(), ["20251231000000_renamed.sql", "20260101000000_a.sql"], copy.file);
  }
});

test("a migration the CLI refuses still stops the run, and is never forced with --include-all", (t) => {
  for (const copy of COPIES) {
    const h = mirror(t, copy, { cliFails: true });
    assert.throws(() => h.migrate(), /migration up --local failed with exit code 1/, copy.file);
    assert.deepEqual(h.calls, [["migration", "up", "--local"]], copy.file);
  }
});

test("`pnpm stack:up` refreshes the copy before it starts or migrates Supabase", async () => {
  const program = slice("scripts/run-e2e-dev.mjs", "async function ensureSupabase()", "function configureSupabaseSecrets(");
  const fixture = ({ running, syncFails = false }) => {
    const calls = [];
    const context = vm.createContext({
      console: { log() {}, warn() {} },
      supabaseFlag: "/inert/flag",
      supabaseProjectDir: "/inert/supabase",
      fs: { writeFileSync: () => calls.push("flag") },
      syncSupabaseMigrationsDir: () => {
        calls.push("sync");
        if (syncFails) throw new Error("Unable to mirror Supabase migrations");
      },
      runCaptureSupabase: () => {
        calls.push("status");
        if (!running) throw new Error("not running");
        return "";
      },
      runSupabase: (args) => calls.push(["cli", Array.from(args)]),
      waitForSupabaseEnv: async () => {
        calls.push("wait");
        return "API_URL=x";
      },
      ensureSupabaseEmailTemplateMounts: () => calls.push("templates"),
      applySupabaseMigrations: () => calls.push("migrate"),
      ensureTmpDir: () => calls.push("tmp"),
    });
    vm.runInContext(program, context, { timeout: 1000 });
    return { calls, run: () => vm.runInContext("ensureSupabase()", context, { timeout: 1000 }) };
  };

  const stopped = fixture({ running: false });
  await stopped.run();
  assert.deepEqual(stopped.calls, ["sync", "status", ["cli", ["start"]], "wait", "templates", "migrate", "tmp", "flag"]);

  const running = fixture({ running: true });
  await running.run();
  assert.deepEqual(running.calls, ["sync", "status", "templates", "migrate"]);

  const failing = fixture({ running: false, syncFails: true });
  await assert.rejects(async () => failing.run(), /Unable to mirror Supabase migrations/);
  assert.deepEqual(failing.calls, ["sync"]);
});

test("`pnpm supabase:reset` rebuilds only the running local database, from a refreshed copy", () => {
  const program = slice("scripts/supabase-stack.mjs", "function resetSupabase()", "function printEnvHints(");
  const fixture = ({ running, syncFails = false }) => {
    const calls = [];
    const context = vm.createContext({
      console: { log() {}, warn() {} },
      readSupabaseEnv: () => {
        calls.push("status");
        return running ? { API_URL: "x" } : null;
      },
      syncSupabaseMigrationsDir: () => {
        calls.push("sync");
        if (syncFails) throw new Error("Unable to copy migrations");
      },
      runSupabase: (args) => calls.push(["cli", Array.from(args)]),
    });
    vm.runInContext(program, context, { timeout: 1000 });
    return { calls, run: () => vm.runInContext("resetSupabase()", context, { timeout: 1000 }) };
  };

  const stopped = fixture({ running: false });
  assert.throws(() => stopped.run(), /local Supabase is not running; start it with 'pnpm supabase:up'/);
  assert.deepEqual(stopped.calls, ["status"]);

  const running = fixture({ running: true });
  running.run();
  assert.deepEqual(running.calls, ["status", "sync", ["cli", ["db", "reset", "--local", "--yes"]]]);

  const failing = fixture({ running: true, syncFails: true });
  assert.throws(() => failing.run(), /Unable to copy migrations/);
  assert.deepEqual(failing.calls, ["status", "sync"]);

  assert.equal(JSON.parse(read("package.json")).scripts["supabase:reset"], "node scripts/supabase-stack.mjs reset");
  assert.match(read("scripts/supabase-stack.mjs"), /if \(action === "reset"\) \{\s+resetSupabase\(\);\s+process\.exit\(0\);\s+\}/);
});

test("a copy `pnpm supabase:*` cannot refresh exits with code 3, before the CLI runs", (t) => {
  // A checkout without supabase/migrations, so the copy cannot be refreshed.
  const fake = fakePnpm(
    t,
    'case "$*" in\n  *" status "*) [ "$STACK_RUNNING" = 1 ] || exit 1; echo \'API_URL="http://127.0.0.1:55621"\' ;;\nesac\n',
  );
  for (const file of [
    "scripts/supabase-stack.mjs",
    "scripts/lib/localSupabaseEnv.mjs",
    "scripts/lib/localSupabasePorts.mjs",
    "scripts/lib/supabaseEmailTemplateMounts.mjs",
    "scripts/lib/supabaseImageMirror.mjs",
    "scripts/lib/supabaseSerialPull.mjs",
    "scripts/lib/supabaseStartMode.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(fake.dir, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(fake.dir, file));
  }
  for (const [action, running] of [["reset", "1"], ["migrate", "1"], ["up", "0"]]) {
    fake.reset();
    const result = sealedRun(path.join(fake.dir, "scripts", "supabase-stack.mjs"), [action], {
      bin: fake.bin,
      cwd: fake.dir,
      env: { PNPM_LOG: fake.log, STACK_RUNNING: running },
    });
    assert.equal(result.status, 3, `${action}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /supabase[/\\]migrations is missing; not running the Supabase CLI/, action);
    // Only status reads: no start, migration or reset.
    assert.ok(fake.calls().length > 0, action);
    for (const call of fake.calls()) assert.match(call, / status --output env$/, action);
  }
});

test("`pnpm test:e2e:supabase` leaves the stack alone when the copy cannot be refreshed", (t) => {
  const fake = fakePnpm(t, 'case "$1" in\n  supabase:reset) exit "$RESET_CODE" ;;\nesac\n');
  const run = (resetCode) => {
    fake.reset();
    return sealedRun(path.join(REPO_ROOT, "scripts", "test-e2e-supabase.mjs"), [], {
      bin: fake.bin,
      cwd: REPO_ROOT,
      env: { PNPM_LOG: fake.log, RESET_CODE: String(resetCode) },
    });
  };
  const refused = run(3);
  assert.equal(refused.status, 3, refused.stderr);
  assert.deepEqual(fake.calls(), ["supabase:reset"]);
  // Any other failed reset still recycles the stack once, as before.
  const failed = run(1);
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(fake.calls(), ["supabase:reset", "supabase:down", "supabase:up", "supabase:reset"]);
});

test("only the two wrappers that refresh the copy run the CLI's migrations", () => {
  const scripts = fs
    .readdirSync(path.join(REPO_ROOT, "scripts"), { recursive: true })
    .map((file) => path.join("scripts", String(file)).split(path.sep).join("/"))
    .filter((file) => /\.m?js$/.test(file) && !/\.test\.m?js$/.test(file))
    .sort();
  const running = (pattern) => scripts.filter((file) => pattern.test(read(file)));
  assert.deepEqual(running(/["']db["'],\s*["']reset["']/), ["scripts/supabase-stack.mjs"]);
  assert.deepEqual(running(/["']migration["'],\s*["']up["']/), ["scripts/run-e2e-dev.mjs", "scripts/supabase-stack.mjs"]);
  // The Playwright reset goes through the wrapper, on both of its attempts.
  const e2e = read("scripts/test-e2e-supabase.mjs");
  assert.match(e2e, /const resetArgs = \["supabase:reset"\];/);
  assert.equal(e2e.split('runCommand("pnpm", resetArgs)').length - 1, 2);
});

test("the setup guides start and reset Supabase through the wrappers", () => {
  for (const file of ["AGENTS.md", "README.md", "DEV_SETUP.md", "docs/Local-Dev.md"]) {
    assert.doesNotMatch(read(file), /--workdir supabase (?:start|db (?:start|reset))\b/, file);
  }
});
