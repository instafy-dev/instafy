import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import {
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseDbUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "./lib/localSupabaseEnv.mjs";
import { localSupabasePorts } from "./lib/localSupabasePorts.mjs";
import { ensureServiceRuntimeUserId, resolveDevSupabaseApiUrl } from "./lib/runtimeEnvHelpers.mjs";
import { getProxyConfig, providerBindAddr, providerSeedEnv } from "./run-e2e-dev.mjs";

// A second local stack runs beside the default one on its own ports: its own Supabase project
// (a local edit of supabase/supabase/config.toml), PROXY_PORT=18789 and PROVIDER_PORT=19090.
// The default stack holds 54321/54322, 8789 and 9090, and none of them may stand in for these.

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "run-e2e-dev.mjs");
const read = (relativePath) => fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

const OWN_DB_URL = "postgresql://postgres:postgres@127.0.0.1:55622/postgres";
const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SECOND_STACK_CONFIG = [
  'project_id = "itest"',
  "",
  "[api]",
  "enabled = true",
  "port = 55621",
  "",
  "[api.tls]",
  "enabled = false",
  "",
  "[db]",
  "port = 55622",
  "",
  "[db.pooler]",
  "port = 55629",
  "",
].join("\n");
const DEFAULT_PORTS = {
  apiPort: 54321,
  dbPort: 54322,
  apiUrl: "http://127.0.0.1:54321",
  dbUrl: DEFAULT_DB_URL,
};

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(projectDir, body) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "config.toml"), body);
  return projectDir;
}

function copyIntoTree(tree, files) {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(tree, file));
  }
}

// A checkout that runs a second stack keeps its config.toml edited locally (docs/Local-Dev.md);
// the committed file names the default stack, which is what these cases check.
function committedConfig(t) {
  const config = read("supabase/supabase/config.toml");
  if (!/^project_id = "supabase"$/m.test(config)) {
    t.skip("supabase/supabase/config.toml is edited locally; the committed file is checked in CI");
    return null;
  }
  return config;
}

// Children get an environment built from scratch, so a developer's INSTAFY_ENV_DIR, DATABASE_URL
// or PROXY_* never reaches them, and an empty PATH keeps docker and pnpm out of their reach.
function runNode(t, args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { PATH: "", HOME: tempDir(t, "dev-stack-ports-home-"), ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function importLauncher(t, body, env) {
  const script = `const launcher = await import(${JSON.stringify(pathToFileURL(LAUNCHER).href)});\n${body}`;
  return runNode(t, ["--input-type=module", "-e", script], env);
}

// A function cut from a script's source, from its declaration to the text that follows it, which
// tests run in a sandbox: importing the script itself would run it.
function sourceOf(file, from, to) {
  const source = read(file);
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `${file}: ${from}`);
  return source.slice(start, end);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the host proxy is this stack's PROXY_PORT, never another stack's 8789", () => {
  const defaultProxy = { baseUrl: "http://127.0.0.1:8789", host: "127.0.0.1", port: 8789, addr: "127.0.0.1:8789" };
  const secondProxy = { baseUrl: "http://127.0.0.1:18789", host: "127.0.0.1", port: 18789, addr: "127.0.0.1:18789" };
  // `up` reads PROXY_BASE_URL=http://proxy:8789, the in-network address, from docker/.env.local.
  for (const env of [{}, { PROXY_PORT: "" }, { PROXY_BASE_URL: "http://proxy:8789" }]) {
    assert.deepEqual(getProxyConfig(env), defaultProxy, JSON.stringify(env));
  }
  for (const env of [
    { PROXY_PORT: "18789" },
    { PROXY_PORT: "18789", PROXY_BASE_URL: "http://proxy:8789" },
    { PROXY_PORT: "18789", PROXY_BASE_URL: "http://127.0.0.1:18789" },
  ]) {
    assert.deepEqual(getProxyConfig(env), secondProxy, JSON.stringify(env));
  }
  // A PROXY_BASE_URL alone still names the port.
  assert.equal(getProxyConfig({ PROXY_BASE_URL: "http://127.0.0.1:28789" }).port, 28789);
  // One that disagrees with PROXY_PORT, such as the default stack's, is refused instead of reused.
  for (const url of ["http://127.0.0.1:8789", "http://host.docker.internal:28789"]) {
    assert.throws(
      () => getProxyConfig({ PROXY_PORT: "18789", PROXY_BASE_URL: url }),
      /does not use PROXY_PORT 18789/,
      url,
    );
  }
  assert.throws(() => getProxyConfig({ PROXY_BASE_URL: "::not a url::" }), /PROXY_BASE_URL=.* is not a URL/);
  // docker compose publishes PROXY_PORT as written, so a padded value is refused too.
  for (const value of ["abc", "0", "65536", "18789x", "-1", " 18789", "18789 "]) {
    assert.throws(() => getProxyConfig({ PROXY_PORT: value }), /PROXY_PORT=.* is not a port/, value);
  }
});

test("a provider this stack starts listens on its PROVIDER_PORT", () => {
  assert.deepEqual(providerBindAddr({}, 9090), { addr: "0.0.0.0:9090", error: null });
  assert.deepEqual(providerBindAddr({}, 19090), { addr: "0.0.0.0:19090", error: null });
  assert.deepEqual(providerBindAddr({ BIND_ADDR: "" }, 19090), { addr: "0.0.0.0:19090", error: null });
  for (const bind of ["0.0.0.0:19090", "127.0.0.1:19090", "[::]:19090"]) {
    assert.deepEqual(providerBindAddr({ BIND_ADDR: bind }, 19090), { addr: bind, error: null });
  }
  // A BIND_ADDR without its PROVIDER_PORT, and binds the launcher's 127.0.0.1 probe cannot reach.
  for (const [bind, port] of [
    ["0.0.0.0:19090", 9090],
    ["0.0.0.0:9090", 19090],
    ["0.0.0.0", 19090],
    ["localhost:19090", 19090],
    ["[::1]:19090", 19090],
    ["127.0.0.2:19090", 19090],
    [" 0.0.0.0:19090", 19090],
  ]) {
    const result = providerBindAddr({ BIND_ADDR: bind }, port);
    assert.equal(result.addr, null, bind);
    assert.match(result.error, /^BIND_ADDR=.* PROVIDER_PORT \d+/, bind);
  }
});

test("the provider's environment follows its stack's ports", (t) => {
  const providerPorts = (env) => {
    const result = importLauncher(
      t,
      "const env = launcher.providerEnv();\n" +
        "console.log(JSON.stringify([env.PROVIDER_PORT, env.BIND_ADDR, env.PROXY_BASE_URL, env.PROXY_PORT]));",
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  assert.deepEqual(providerPorts({}), ["9090", "0.0.0.0:9090", "http://host.docker.internal:8789", "0"]);
  const second = ["19090", "0.0.0.0:19090", "http://host.docker.internal:18789", "18789"];
  for (const env of [
    { PROVIDER_PORT: "19090", PROXY_PORT: "18789" },
    { PROVIDER_PORT: "19090", PROXY_PORT: "18789", PROXY_BASE_URL: "http://proxy:8789" },
    // The hand overrides an isolated stack needed before.
    { PROVIDER_PORT: "19090", BIND_ADDR: "0.0.0.0:19090", PROXY_PORT: "18789", PROXY_BASE_URL: "http://127.0.0.1:18789" },
  ]) {
    assert.deepEqual(providerPorts(env), second, JSON.stringify(env));
  }
  const stray = importLauncher(t, "launcher.providerEnv();", { PROVIDER_PORT: "19090", BIND_ADDR: "0.0.0.0:9090" });
  assert.notEqual(stray.status, 0);
  assert.match(stray.stderr, /BIND_ADDR=0\.0\.0\.0:9090 is not .* PROVIDER_PORT 19090/);
});

test("importing the launcher never throws, whatever its port settings", (t) => {
  // `down` and `status` import it with whatever the shell holds.
  const result = importLauncher(t, 'console.log("imported");', {
    PROVIDER_PORT: "abc",
    BIND_ADDR: "0.0.0.0:1",
    PROXY_PORT: "abc",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /imported/);
});

test("`up` and `controller:start` refuse a bad port before they prune, start or write anything", (t) => {
  for (const [env, message] of [
    [{ PROXY_PORT: "abc" }, /^\[runtime-dev\] PROXY_PORT=abc is not a port/m],
    [{ PROVIDER_PORT: "abc" }, /^\[runtime-dev\] PROVIDER_PORT=abc is not a port/m],
    [
      { PROXY_PORT: "18789", PROXY_BASE_URL: "http://127.0.0.1:8789" },
      /^\[runtime-dev\] PROXY_BASE_URL=http:\/\/127\.0\.0\.1:8789 does not use PROXY_PORT 18789/m,
    ],
  ]) {
    const result = runNode(t, [LAUNCHER, "up"], env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /Pruning stale|GIT_CANONICAL not set/);
  }
  const controller = runNode(t, [LAUNCHER, "controller:start"], { PROXY_PORT: "abc" });
  assert.equal(controller.status, 1);
  assert.match(controller.stderr, /^\[runtime-dev\] PROXY_PORT=abc is not a port/m);
  assert.doesNotMatch(controller.stdout, /GIT_CANONICAL not set/);
});

test("a stray BIND_ADDR stops only a provider the launcher spawns, never one it reuses", () => {
  const source = read("scripts/run-e2e-dev.mjs");
  const start = source.indexOf("async function startProviderService(");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\nasync function ", start + 1));
  const at = (needle, from = 0) => {
    const index = body.indexOf(needle, from);
    assert.notEqual(index, -1, needle);
    return index;
  };
  assert.equal(body.split("if (bind.error)").length - 1, 2);
  const positions = [
    at("const bind = providerBindAddr(process.env)"),
    at("if (bind.error)"),
    at("clearProviderPortForPrebuiltLaunch("),
    at("findProviderPidByPort("),
    at("if (bind.error)", at("if (bind.error)") + 1),
    at("providerEnv("),
    at("spawn(", at("providerEnv(")),
  ];
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("this checkout's Supabase ports come from its config.toml", (t) => {
  const dir = tempDir(t, "dev-stack-ports-config-");
  const config = (name, body) => writeConfig(path.join(dir, name), body);
  assert.deepEqual(localSupabasePorts(config("second", SECOND_STACK_CONFIG)), {
    apiPort: 55621,
    dbPort: 55622,
    apiUrl: "http://127.0.0.1:55621",
    dbUrl: OWN_DB_URL,
  });
  // No [api] or [db] port: the CLI's own.
  assert.deepEqual(localSupabasePorts(config("none", 'project_id = "x"\n[studio]\nport = 1\n')), DEFAULT_PORTS);
  assert.equal(localSupabasePorts(config("comments", "[api] # the API\nport = 55621 # note\n")).apiPort, 55621);
  assert.deepEqual(
    localSupabasePorts(config("others", "[db.pooler]\nport = 1\n[api.tls]\nport = 2\n[[x]]\nport = 3\n")),
    DEFAULT_PORTS,
  );
  for (const [name, value] of [["text", '"abc"'], ["zero", "0"], ["large", "70000"]]) {
    assert.throws(() => localSupabasePorts(config(name, `[db]\nport = ${value}\n`)), /\[db\] port = .* is not a port/);
  }
});

test("the committed config.toml gives the default stack's ports", (t) => {
  if (!committedConfig(t)) return;
  assert.deepEqual(localSupabasePorts(), DEFAULT_PORTS);
});

test("the launcher's Supabase API is this checkout's unless one is named", (t) => {
  const own = writeConfig(tempDir(t, "dev-stack-ports-api-"), SECOND_STACK_CONFIG);
  const status = { SUPABASE_PROJECT_URL: "http://c.test", SUPABASE_URL: "http://d.test" };
  assert.equal(resolveDevSupabaseApiUrl(status, { SUPABASE_PROJECT_URL: "http://a.test/", SUPABASE_URL: "http://b.test" }, own), "http://a.test");
  assert.equal(resolveDevSupabaseApiUrl(status, { SUPABASE_URL: "http://b.test/" }, own), "http://b.test");
  assert.equal(resolveDevSupabaseApiUrl(status, {}, own), "http://c.test");
  assert.equal(resolveDevSupabaseApiUrl({ SUPABASE_URL: "http://d.test/" }, {}, own), "http://d.test");
  assert.equal(resolveDevSupabaseApiUrl({}, { SUPABASE_PROJECT_URL: "  " }, own), "http://127.0.0.1:55621");
  // Neither Studio's variable nor the status's API_URL (its host follows DOCKER_HOST) steers it.
  assert.equal(
    resolveDevSupabaseApiUrl(
      { API_URL: "http://10.0.0.5:54321" },
      { VITE_SUPABASE_URL: "http://e.test", API_URL: "http://f.test" },
      own,
    ),
    "http://127.0.0.1:55621",
  );
  assert.equal(resolveDevSupabaseApiUrl({}, {}), localSupabasePorts().apiUrl);
});

test("no launcher fallback names the default stack's Supabase", () => {
  const launcher = read("scripts/run-e2e-dev.mjs");
  for (const file of [
    "scripts/run-e2e-dev.mjs",
    "scripts/lib/runtimeEnvHelpers.mjs",
    "packages/frontend/scripts/dev.mjs",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /DEFAULT_SUPABASE_PROJECT_URL/, file);
    assert.doesNotMatch(source, /54321/, file);
  }
  assert.doesNotMatch(launcher, /54322/);
  assert.doesNotMatch(read("scripts/providers-seed.mjs"), /supabase_db_supabase/);
  const start = launcher.indexOf("async function startControllerIfNeeded(");
  assert.notEqual(start, -1);
  const controller = launcher.slice(start, launcher.indexOf("\nasync function ", start + 1));
  assert.match(controller, /const supabaseProjectUrl = resolveSupabaseBaseUrl\(supabaseEnv\);/);
  assert.match(controller, /\|\|\s*localSupabasePorts\(\)\.dbUrl;/);
  assert.match(controller, /ensureDefaultProviderSeed\(dbUrl\);/);
  assert.doesNotMatch(controller, /process\.env\.SUPABASE_URL \|\|/);
  // Both registry runs reach this checkout's Supabase, with its service-role key.
  const registryRuns = controller.split('"scripts/runtime-projects.mjs"').slice(1);
  assert.equal(registryRuns.length, 2);
  for (const after of registryRuns) {
    assert.match(after.slice(0, 250), /SUPABASE_PROJECT_URL: resolveSupabaseBaseUrl\(supabaseEnv\)/);
  }
});

test("the service runtime user is looked up on this checkout's Supabase", async (t) => {
  const names = [
    "SUPABASE_PROJECT_URL",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SERVICE_ROLE_KEY",
    "SERVICE_RUNTIME_USER_EMAIL",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  for (const name of names) delete process.env[name];
  const id = "00000000-0000-4000-8000-0000000000aa";
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ users: [{ id, email: "service-runtime@instafy.dev" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await ensureServiceRuntimeUserId({ SERVICE_ROLE_KEY: "svc-a" });
  assert.equal(result?.id, id);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, `${localSupabasePorts().apiUrl}/auth/v1/admin/users`);
  }
});

test("the provider seed writes to the controller's database, through this checkout's container", (t) => {
  // The controller's database outranks a TEST_DATABASE_URL the launcher inherited.
  assert.equal(
    resolveLocalSupabaseDbUrl({
      env: providerSeedEnv(OWN_DB_URL, { TEST_DATABASE_URL: DEFAULT_DB_URL, DATABASE_URL: DEFAULT_DB_URL }),
      statusEnv: { DB_URL: DEFAULT_DB_URL },
    }),
    OWN_DB_URL,
  );
  // The launcher runs the seed with exactly that environment, whatever its own shell holds.
  const runs = [];
  const launcherEnv = { PATH: "/bin", TEST_DATABASE_URL: DEFAULT_DB_URL, DATABASE_URL: DEFAULT_DB_URL };
  const context = vm.createContext({
    process: { env: {} },
    console: { log() {}, warn() {} },
    run: (command, args, options) => runs.push({ command, args: Array.from(args), options }),
    providerSeedEnv: (dbUrl, env = launcherEnv) => providerSeedEnv(dbUrl, env),
  });
  vm.runInContext(
    `${sourceOf("scripts/run-e2e-dev.mjs", "function ensureDefaultProviderSeed(", "\nfunction ")}\n` +
      `ensureDefaultProviderSeed(${JSON.stringify(OWN_DB_URL)});`,
    context,
    { timeout: 1000 },
  );
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].command, runs[0].args], ["node", ["scripts/providers-seed.mjs", "default"]]);
  assert.equal(runs[0].options?.env?.DATABASE_URL, OWN_DB_URL);
  assert.equal(Object.hasOwn(runs[0].options.env, "TEST_DATABASE_URL"), false);

  // A copy of the seed in a checkout whose Supabase is the second stack's, on a PATH with a fake
  // pnpm (the status) and docker, and no psql.
  const tree = tempDir(t, "dev-stack-ports-seed-");
  copyIntoTree(tree, [
    "scripts/providers-seed.mjs",
    "scripts/lib/localSupabaseEnv.mjs",
    "scripts/lib/localSupabasePorts.mjs",
    "scripts/lib/supabaseEmailTemplateMounts.mjs",
  ]);
  writeConfig(path.join(tree, "supabase", "supabase"), SECOND_STACK_CONFIG);
  const bin = path.join(tree, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho 'DB_URL="${OWN_DB_URL}"'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "docker"), '#!/bin/sh\necho "$@" >> "$DOCKER_LOG"\n', { mode: 0o755 });
  const dockerLog = path.join(tree, "docker.log");
  const seed = (env) => {
    fs.rmSync(dockerLog, { force: true });
    const result = runNode(t, [path.join(tree, "scripts", "providers-seed.mjs"), "default"], {
      ...env,
      PATH: bin,
      DOCKER_LOG: dockerLog,
    });
    return { ...result, docker: fs.existsSync(dockerLog) ? fs.readFileSync(dockerLog, "utf8") : "" };
  };

  const own = seed({});
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.docker, /^exec -i supabase_db_itest psql /m);

  const other = seed({ DATABASE_URL: DEFAULT_DB_URL });
  assert.equal(other.status, 1);
  assert.match(other.stderr, /psql is not installed, and the database URL is not this checkout's/);
  assert.doesNotMatch(other.stderr, /postgres:postgres/);
  assert.equal(other.docker, "");

  const named = seed({ DATABASE_URL: DEFAULT_DB_URL, SUPABASE_DB_CONTAINER: "custom_db" });
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.docker, /^exec -i custom_db psql /m);

  const launched = seed(providerSeedEnv(OWN_DB_URL, { TEST_DATABASE_URL: DEFAULT_DB_URL }));
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.docker, /^exec -i supabase_db_itest psql /m);
});

test("`pnpm supabase:up` reports this checkout's stack, never a hosted project the shell names", () => {
  const printEnvHints = sourceOf("scripts/supabase-stack.mjs", "function printEnvHints(", "\ntry {");
  // A shell that has sourced a hosted project's env file, which the shared resolvers read first.
  const hosted = {
    SUPABASE_PROJECT_URL: "https://hosted.example",
    SUPABASE_URL: "https://hosted.example",
    VITE_SUPABASE_URL: "https://hosted.example",
    SUPABASE_SERVICE_ROLE_KEY: "svc-hosted",
    SERVICE_ROLE_KEY: "svc-hosted",
    DATABASE_URL: "postgresql://hosted.example/postgres",
    TEST_DATABASE_URL: "postgresql://hosted.example/postgres",
  };
  const fromShell = (resolve) => (options = {}) => resolve({ env: hosted, ...options });
  const hints = (status) => {
    const lines = [];
    const context = vm.createContext({
      console: { log: (line = "") => lines.push(String(line)) },
      resolveLocalSupabaseDbUrl: fromShell(resolveLocalSupabaseDbUrl),
      resolveLocalSupabaseApiUrl: fromShell(resolveLocalSupabaseApiUrl),
      resolveLocalSupabaseServiceRoleKey: fromShell(resolveLocalSupabaseServiceRoleKey),
      localSupabasePorts: () => ({ apiUrl: "http://127.0.0.1:55631" }),
    });
    vm.runInContext(`${printEnvHints}\nprintEnvHints(${JSON.stringify(status)});`, context, { timeout: 1000 });
    return lines.join("\n");
  };
  const line = (label, value) => new RegExp(`^ +${label}: +${escapeRegExp(value)}$`, "m");

  const own = hints({ API_URL: "http://127.0.0.1:55621", DB_URL: OWN_DB_URL, ANON_KEY: "anon-b", SERVICE_ROLE_KEY: "svc-a" });
  assert.match(own, line("DATABASE_URL", OWN_DB_URL));
  assert.match(own, line("ANON_KEY", "anon-b"));
  assert.match(own, line("SERVICE_ROLE_KEY", "svc-a"));
  assert.match(own, line("SUPABASE_PROJECT_URL", "http://127.0.0.1:55621"));
  assert.doesNotMatch(own, /hosted/);
  // A status without its API URL gets this checkout's config port, still not the shell's project.
  const partial = hints({ DB_URL: OWN_DB_URL });
  assert.match(partial, line("SUPABASE_PROJECT_URL", "http://127.0.0.1:55631"));
  assert.doesNotMatch(partial, /hosted/);
});

// Runs a copy of the frontend dev launcher in a checkout whose docker/.env.local is what
// `pnpm stack:up` writes (the stack's anon key and no URL), and returns the environment Vite gets.
function studioEnv(t, config) {
  const roleKey = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
  const tree = tempDir(t, "dev-stack-ports-studio-");
  copyIntoTree(tree, [
    "packages/frontend/scripts/dev.mjs",
    "scripts/lib/localSupabasePorts.mjs",
    "scripts/lib/privateEnvPaths.mjs",
  ]);
  writeConfig(path.join(tree, "supabase", "supabase"), config);
  fs.mkdirSync(path.join(tree, "docker"));
  fs.writeFileSync(path.join(tree, "docker", ".env.local"), `SUPABASE_ANON_KEY=anon-b\n${roleKey}=svc-a\n`);
  const bin = path.join(tree, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\n/usr/bin/env > "$DEV_ENV_DUMP"\n', { mode: 0o755 });
  const dump = path.join(tree, "vite.env");
  const result = runNode(t, [path.join(tree, "packages", "frontend", "scripts", "dev.mjs")], {
    PATH: bin,
    DEV_ENV_DUMP: dump,
    [roleKey]: "svc-b",
    [["VITE", roleKey].join("_")]: "svc-b",
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    fs
      .readFileSync(dump, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

test("`pnpm dev` points Studio at this checkout's Supabase when docker/.env.local names no URL", (t) => {
  const env = studioEnv(t, SECOND_STACK_CONFIG);
  assert.equal(env.VITE_SUPABASE_URL, "http://127.0.0.1:55621");
  assert.equal(env.VITE_SUPABASE_ANON_KEY, "anon-b");
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase().includes("SERVICE_ROLE")), []);
});

test("`pnpm dev` keeps the default stack's Supabase on the committed config.toml", (t) => {
  const committed = committedConfig(t);
  if (!committed) return;
  assert.equal(studioEnv(t, committed).VITE_SUPABASE_URL, "http://127.0.0.1:54321");
});
