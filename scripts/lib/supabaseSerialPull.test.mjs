import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTH_ONLY_EXCLUDED_CONTAINERS, BROWSER_TEST_EXCLUDED_CONTAINERS } from "./supabaseStartMode.mjs";
import {
  SERIAL_PULL_CLI_VERSION, SERIAL_PULL_BUDGET_MS, parseSupabaseSerialPull,
  serialPullImages, serialPullEnvironment, prepareSupabaseSerialPull,
} from "./supabaseSerialPull.mjs";

const names = ["supabase/postgres", "supabase/gotrue", "postgrest/postgrest", "supabase/realtime",
  "supabase/storage-api", "supabase/edge-runtime", "supabase/studio", "supabase/postgres-meta",
  "supabase/logflare", "supabase/supavisor"];
const tags = ["17.6.1.106", "v2.188.1", "v14.8", "v2.82.0", "v1.48.28", "v1.73.3",
  "2026.04.08-sha-205cbe7", "v0.96.4", "1.37.1", "2.7.4"];
const inventory = () => names.map((name, index) => ({ name, local: tags[index], remote: "" }));
const ok = (stdout = "", stderr = "") => ({ status: 0, stdout, stderr });
const imageId = `sha256:${"a".repeat(64)}`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "supabase-serial-test-")));
  fs.mkdirSync(path.join(root, "supabase", "supabase"), { recursive: true });
  fs.writeFileSync(path.join(root, "supabase", "supabase", "config.toml"), "project_id = 'test'\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function harness(t, overrides = {}) {
  const repoRoot = fixture(t);
  const calls = [];
  const cached = new Set();
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    if (binary === "pnpm") return args.includes("--version") ? ok("2.92.0\n") : ok(JSON.stringify(inventory()), "Using workdir supabase\n");
    if (args[0] === "pull") { cached.add(args.at(-1)); return ok(); }
    return cached.has(args.at(-1)) ? ok(`${imageId}\n`) : { status: 1, stdout: "", stderr: "No such image" };
  };
  const run = (options = {}) => prepareSupabaseSerialPull({
    repoRoot, env: { PATH: "/usr/bin:/bin", SUPABASE_SERIAL_PULL: "true" },
    execute, log: () => {}, ...overrides, ...options,
  });
  return { repoRoot, calls, cached, execute, run };
}

test("serial pull is explicit and default startup performs no new work", () => {
  for (const value of [undefined, "", "false"]) {
    assert.equal(parseSupabaseSerialPull(value), false);
    assert.deepEqual(prepareSupabaseSerialPull({ env: { SUPABASE_SERIAL_PULL: value } }), { enabled: false, images: 0, pulled: 0 });
  }
  assert.equal(parseSupabaseSerialPull("true"), true);
  for (const value of ["1", "0", "TRUE", " true", true]) assert.throws(() => parseSupabaseSerialPull(value));
});

test("pinned CLI inventory covers all fourteen exact mapped images, irrespective of JSON ordering", () => {
  assert.equal(SERIAL_PULL_CLI_VERSION, "2.92.0");
  assert.deepEqual(serialPullImages(JSON.stringify(inventory().reverse())), [
    ...names.map((name, index) => `public.ecr.aws/supabase/${name.split("/")[1]}:${tags[index]}`),
    "public.ecr.aws/supabase/kong:2.8.1", "public.ecr.aws/supabase/mailpit:v1.22.3",
    "public.ecr.aws/supabase/imgproxy:v3.8.0", "public.ecr.aws/supabase/vector:0.53.0-alpine",
  ]);
  const locked = fs.readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.match(locked, /supabase:\n\s+specifier: \^2\.92\.0\n\s+version: 2\.92\.0/);
});

test("database-only selection retains the CLI-resolved Postgres version", () => {
  const rows = inventory(); rows[0].local = "15.8.1.085";
  assert.deepEqual(serialPullImages(JSON.stringify(rows), { databaseOnly: true }), ["public.ecr.aws/supabase/postgres:15.8.1.085"]);
});

test("Auth-only selection validates the complete pinned inventory before selecting five service and two schema images", () => {
  const rows = inventory(); rows[0].local = "15.8.1.085";
  const full = serialPullImages(JSON.stringify(rows));
  const selected = serialPullImages(JSON.stringify(rows), { authOnly: true });
  assert.deepEqual(selected, [
    "public.ecr.aws/supabase/postgres:15.8.1.085", "public.ecr.aws/supabase/gotrue:v2.188.1",
    "public.ecr.aws/supabase/postgrest:v14.8", "public.ecr.aws/supabase/realtime:v2.82.0",
    "public.ecr.aws/supabase/storage-api:v1.48.28", "public.ecr.aws/supabase/kong:2.8.1",
    "public.ecr.aws/supabase/mailpit:v1.22.3",
  ]);
  assert.deepEqual(full.filter((image) => !selected.includes(image)).map((image) => image.split("/").at(-1).split(":")[0]).sort(),
    AUTH_ONLY_EXCLUDED_CONTAINERS.filter(name => !["realtime", "storage-api"].includes(name)).sort());
  // A malformed excluded service is still an inventory error, never hidden by filtering.
  for (const mutate of [r => r.pop(), r => { r[5].local = "latest"; }, r => { r[5].name = r[6].name; },
    r => { r[5].remote = "v1"; }, r => { r[5].unexpected = "inert"; }]) {
    const invalid = inventory(); mutate(invalid);
    assert.throws(() => serialPullImages(JSON.stringify(invalid), { authOnly: true }), /inventory-invalid/);
  }
});

test("pinned PG17 configuration preserves Realtime and Storage schema initialization despite service exclusions", () => {
  // v2.92.0 initSchema15 uses Config.Enabled, not --exclude, for these sequential
  // DockerRunJob migrations. They need cached images even without persistent services.
  const config = fs.readFileSync(new URL("../../supabase/supabase/config.toml", import.meta.url), "utf8");
  assert.match(config, /^major_version = 17$/m);
  for (const name of ["realtime", "storage", "auth"]) {
    assert.match(config, new RegExp(`^\\[${name}\\]\\nenabled = true$`, "m"));
  }
  for (const name of ["realtime", "storage-api"]) assert.ok(AUTH_ONLY_EXCLUDED_CONTAINERS.includes(name));
  assert.equal(serialPullImages(JSON.stringify(inventory()), { authOnly: true }).length, 7);
});

test("Auth-only preparation pulls exactly seven images with the same finite budgets and cleanup", (t) => {
  const h = harness(t);
  assert.deepEqual(h.run({ env: { PATH: "/usr/bin:/bin", SUPABASE_SERIAL_PULL: "true", SUPABASE_AUTH_ONLY: "1" } }),
    { enabled: true, images: 7, pulled: 7 });
  assert.equal(h.calls.length, 23);
  assert.deepEqual(h.calls.filter(({ args }) => args[0] === "pull").map(({ args }) => args.at(-1)),
    serialPullImages(JSON.stringify(inventory()), { authOnly: true }));
  assert.ok(h.calls.every(({ options }) => options.timeout <= 180_000 && options.killSignal === "SIGKILL"));
  assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  assert.ok(h.calls.every(({ options }) => options.env.SUPABASE_AUTH_ONLY === undefined));
  h.calls.length = 0;
  assert.deepEqual(h.run({ authOnly: true }), { enabled: true, images: 7, pulled: 0 });
  assert.equal(h.calls.length, 9);
});

test("browser-test selection validates every service before excluding only the Edge Runtime image", () => {
  const full = serialPullImages(JSON.stringify(inventory()));
  const selected = serialPullImages(JSON.stringify(inventory().reverse()), { browserTest: true });
  assert.equal(selected.length, 13);
  assert.deepEqual(full.filter((image) => !selected.includes(image)), ["public.ecr.aws/supabase/edge-runtime:v1.73.3"]);
  assert.deepEqual(selected, full.filter((image) => !image.includes("/edge-runtime:")));
  assert.deepEqual(BROWSER_TEST_EXCLUDED_CONTAINERS, ["edge-runtime"]);
  for (const mutate of [r => r.pop(), r => { r[5].local = "latest"; }, r => { r[5].name = r[6].name; },
    r => { r[5].remote = "v1"; }, r => { r[5].unexpected = "inert"; }]) {
    const invalid = inventory(); mutate(invalid);
    assert.throws(() => serialPullImages(JSON.stringify(invalid), { browserTest: true }), /inventory-invalid/);
  }
});

test("browser-test preparation pulls thirteen images sequentially with unchanged budgets and private cleanup", (t) => {
  const h = harness(t);
  assert.deepEqual(h.run({ env: { PATH: "/usr/bin:/bin", SUPABASE_SERIAL_PULL: "true", SUPABASE_BROWSER_TEST: "1" } }),
    { enabled: true, images: 13, pulled: 13 });
  const images = serialPullImages(JSON.stringify(inventory()), { browserTest: true });
  assert.equal(h.calls.length, 41);
  for (let index = 0; index < images.length; index += 1) {
    const group = h.calls.slice(2 + index * 3, 5 + index * 3);
    assert.deepEqual(group.map(({ args }) => args[0]), ["image", "pull", "image"]);
    assert.ok(group.every(({ args }) => args.at(-1) === images[index]));
  }
  assert.ok(h.calls.every(({ options }) => options.timeout <= 180_000 && options.killSignal === "SIGKILL"));
  assert.ok(h.calls.every(({ options }) => options.env.SUPABASE_BROWSER_TEST === undefined));
  assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  h.calls.length = 0;
  assert.deepEqual(h.run({ browserTest: true }), { enabled: true, images: 13, pulled: 0 });
  assert.equal(h.calls.length, 15);
});

test("serial image profiles reject ambiguous booleans and conflicting flags before commands", (t) => {
  for (const options of [{ databaseOnly: true, authOnly: true }, { authOnly: "1" }, { databaseOnly: "1" },
    { browserTest: "1" }, { browserTest: true, databaseOnly: true }, { browserTest: true, authOnly: true }]) {
    const h = harness(t);
    assert.throws(() => serialPullImages(JSON.stringify(inventory()), options), /start-mode-invalid/);
    assert.throws(() => h.run(options), /start-mode-invalid/);
    assert.equal(h.calls.length, 0);
  }
  for (const flags of [{ SUPABASE_AUTH_ONLY: "true" }, { SUPABASE_DATABASE_ONLY: "1", SUPABASE_AUTH_ONLY: "1" },
    { SUPABASE_BROWSER_TEST: "true" }, { SUPABASE_BROWSER_TEST: "1", SUPABASE_AUTH_ONLY: "1" },
    { SUPABASE_BROWSER_TEST: "1", SUPABASE_DATABASE_ONLY: "1" }]) {
    const h = harness(t);
    assert.throws(() => h.run({ env: { SUPABASE_SERIAL_PULL: "true", ...flags } }), /must be unset|start-mode-invalid/);
    assert.equal(h.calls.length, 0);
  }
});

test("incomplete, duplicate, remote, unversioned, credential-bearing and unexpected inventory is rejected", () => {
  const variants = [null, {}, [], inventory().slice(1), [...inventory(), inventory()[0]], [inventory()[0], ...inventory().slice(0, 9)]];
  for (const patch of [{ name: "attacker/image" }, { name: "user:pass@host/image" }, { local: "latest" },
    { local: "x --flag" }, { local: "../tag" }, { local: 2 }, { remote: "v1" }, { extra: "anything" }]) {
    const rows = inventory(); rows[0] = { ...rows[0], ...patch }; variants.push(rows);
  }
  for (const value of variants) assert.throws(() => serialPullImages(JSON.stringify(value)), /inventory-invalid/);
  assert.throws(() => serialPullImages("not json"), /inventory-invalid/);
});

test("all image pulls are strictly sequential and followed by exact-ref local inspection", (t) => {
  const h = harness(t);
  assert.deepEqual(h.run(), { enabled: true, images: 14, pulled: 14 });
  assert.equal(h.calls.length, 44);
  const images = serialPullImages(JSON.stringify(inventory()));
  for (let index = 0; index < 14; index += 1) {
    const group = h.calls.slice(2 + index * 3, 5 + index * 3);
    assert.deepEqual(group.map(({ args }) => args[0]), ["image", "pull", "image"]);
    assert.ok(group.every(({ args }) => args.at(-1) === images[index]));
  }
  const temporaryHome = h.calls[0].options.env.HOME;
  assert.equal(fs.existsSync(temporaryHome), false);
  assert.ok(h.calls.every(({ options }) => options.timeout <= 180_000 && options.timeout > 0 && options.killSignal === "SIGKILL"));
});

test("cached images never pull; database-only startup inspects exactly one image", (t) => {
  const h = harness(t);
  for (const image of serialPullImages(JSON.stringify(inventory()))) h.cached.add(image);
  assert.deepEqual(h.run(), { enabled: true, images: 14, pulled: 0 });
  h.calls.length = 0;
  assert.deepEqual(h.run({ databaseOnly: true }), { enabled: true, images: 1, pulled: 0 });
  assert.equal(h.calls.length, 3);
});

test("child environments exclude ambient credentials, homes, Docker auth, TLS overrides and Node injection", () => {
  const env = serialPullEnvironment({ PATH: "/tools", HOME: "/inert-private", GH_TOKEN: "inert", SUPABASE_ACCESS_TOKEN: "inert",
    NODE_OPTIONS: "--require=bad", NODE_TLS_REJECT_UNAUTHORIZED: "0", DOCKER_AUTH_CONFIG: "inert",
    HTTPS_PROXY: "http://proxy.invalid:3128", NO_PROXY: "*" }, "/inert-empty-home");
  assert.deepEqual(env, { PATH: "/tools", HOME: "/inert-empty-home", DOCKER_CONFIG: "/inert-empty-home",
    XDG_CONFIG_HOME: "/inert-empty-home", CI: "true", LANG: "C", TZ: "UTC",
    SUPABASE_ACCESS_TOKEN: "disabled-for-local-image-inventory",
    HTTPS_PROXY: "http://proxy.invalid:3128", https_proxy: "http://proxy.invalid:3128" });
});

test("proxy values require matching credential-free HTTP(S) origins", () => {
  for (const value of ["http://user:pass@proxy.invalid", "http://proxy.invalid/path", "http://proxy.invalid/?query", "http://proxy.invalid/#hash", "socks5://proxy.invalid", " http://proxy.invalid"]) {
    assert.throws(() => serialPullEnvironment({ HTTP_PROXY: value }, "/empty"), /proxy-invalid/);
  }
  assert.throws(() => serialPullEnvironment({ HTTP_PROXY: "http://a.invalid", http_proxy: "http://b.invalid" }, "/empty"), /proxy-invalid/);
});

test("unsafe configuration, linked projects and arbitrary overrides fail before any command", (t) => {
  for (const relative of [".env", "supabase/.env.local", "supabase/supabase/.env.development", "supabase/supabase/.temp/project-ref"]) {
    const h = harness(t); const target = path.join(h.repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "never-read");
    assert.throws(() => h.run(), /requires-(clean-local-config|unlinked-project)/);
    assert.equal(h.calls.length, 0);
  }
  for (const key of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_INTERNAL_IMAGE_REGISTRY", "SUPABASE_ENV", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_AUTH_CONFIG"]) {
    const h = harness(t);
    assert.throws(() => h.run({ env: { SUPABASE_SERIAL_PULL: "true", [key]: "inert" } }), /unsupported-override/);
    assert.equal(h.calls.length, 0);
  }
});

test("symlinked config, project path, .temp and linked-state paths are never followed", (t) => {
  for (const relative of ["supabase/supabase/config.toml", "supabase/supabase/.temp", "supabase/supabase/.temp/project-ref", "supabase"]) {
    const h = harness(t); const target = path.join(h.repoRoot, relative);
    if (fs.existsSync(target)) fs.renameSync(target, `${target}.saved`);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync("/nonexistent-serial-fixture", target);
    assert.throws(() => h.run(), /path-invalid|requires-unlinked-project/);
    assert.equal(h.calls.length, 0);
  }
});

test("CLI version and config-load failures cannot silently use default inventory", (t) => {
  const h = harness(t);
  for (const response of [ok("2.93.0\n"), ok("2.92.0\n", "failed to parse config: inert\n")]) {
    assert.throws(() => h.run({ execute: () => response }), /cli-version-mismatch|cli-diagnostic/);
  }
  assert.throws(() => h.run({ execute: (binary, args) => args.includes("--version") ? ok("2.92.0") : ok(JSON.stringify(inventory()), "failed to load config\n") }), /cli-diagnostic/);
  assert.throws(() => h.run({ execute: () => { throw new Error("inert-secret-must-not-escape"); } }), /^Error: supabase-serial-version-failed$/);
});

test("pull, timeout, output overflow and malformed readback fail without advancing or leaking output", (t) => {
  for (const result of [{ status: 1, stderr: "inert-secret-must-not-escape" }, { status: null, signal: "SIGKILL" }, { error: new Error("inert-secret-must-not-escape") }]) {
    const h = harness(t);
    assert.throws(() => h.run({ execute: (binary, args, options) => args[0] === "pull" ? result : h.execute(binary, args, options) }), /^Error: supabase-serial-pull-failed$/);
    assert.equal(h.calls.filter(({ binary }) => binary === "docker").length, 1);
    assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  }
  const h = harness(t);
  assert.throws(() => h.run({ execute: (binary, args, options) => binary === "docker" ? ok("bad-id") : h.execute(binary, args, options) }), /image-readback-invalid/);
});

test("total preparation budget is finite and cannot reset between images", (t) => {
  let clock = 0; const h = harness(t);
  assert.throws(() => h.run({ now: () => clock, execute: (binary, args, options) => {
    const result = h.execute(binary, args, options); clock += SERIAL_PULL_BUDGET_MS / 3; return result;
  } }), /deadline/);
  assert.equal(h.calls.length, 3);
});

test("Docker failures retain fixed symptom hints without logging raw output", (t) => {
  for (const [stderr, hint] of [
    ["toomanyrequests: too many requests", "rate-limit"],
    ["unauthorized: authentication required", "registry-auth"],
    ["manifest unknown", "manifest-missing"],
    ["no matching manifest for linux/arm64", "platform-missing"],
    ["proxyconnect tcp: Forbidden", "proxy-denied"],
    ["x509: certificate signed by unknown authority", "tls,tls-certificate"],
    ["x509: certificate has expired or is not yet valid", "tls,tls-certificate"],
    ["certificate verify failed", "tls,tls-certificate"],
    ["net/http: TLS handshake timeout", "tls,tls-handshake-timeout"],
    ["remote error: tls: handshake failure", "tls,tls-handshake-rejected"],
    ["TLS handshake error", "tls"],
    ["lookup registry: no such host", "dns"],
    ["context deadline exceeded", "network-timeout"],
    ["read: connection reset by peer", "network-reset"],
    ["write: no space left on device", "disk-full"],
    ["Cannot connect to the Docker daemon", "daemon-unavailable"],
  ]) {
    const h = harness(t); const logs = []; let pulls = 0;
    assert.throws(() => h.run({ authOnly: true, log: (line) => logs.push(line), execute: (binary, args, options) => {
      if (args[0] !== "pull") return h.execute(binary, args, options);
      pulls += 1;
      return { status: 1, stdout: "never-log-stdout", stderr: `${stderr}\nhttps://user:secret@host.invalid/path?token=never-log\n/private/never-log` };
    } }), /^Error: supabase-serial-pull-failed$/);
    assert.equal(pulls, 1);
    assert.deepEqual(logs, ["[supabase-stack] Serial image preparation 1/7",
      `[supabase-stack] Docker preparation failed stage=pull image=postgres exit=1 signal=none-or-unknown error=none-or-unknown hints=${hint}`]);
    assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  }
});

test("Docker failure metadata is bounded, unknown output stays private, and no failure advances", (t) => {
  for (const [result, suffix] of [
    [{ status: 1, stderr: "unrecognized never-log" }, "exit=1 signal=none-or-unknown error=none-or-unknown hints=unclassified"],
    [{ status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT", message: "never-log" } }, "exit=unknown signal=SIGKILL error=ETIMEDOUT hints=unclassified"],
    [{ error: { code: "ENOBUFS" } }, "exit=unknown signal=none-or-unknown error=ENOBUFS hints=unclassified"],
    [{ status: "never-log", signal: "never-log", error: { code: "never-log" } }, "exit=unknown signal=none-or-unknown error=none-or-unknown hints=unclassified"],
    [{ status: 256, stderr: "no such host" + "é".repeat(16_384) }, "exit=unknown signal=none-or-unknown error=none-or-unknown hints=unclassified"],
    [undefined, "exit=unknown signal=none-or-unknown error=none-or-unknown hints=unclassified"],
  ]) {
    const h = harness(t); const logs = [];
    assert.throws(() => h.run({ log: (line) => logs.push(line), execute: (binary, args, options) => args[0] === "pull" ? result : h.execute(binary, args, options) }), /^Error: supabase-serial-pull-failed$/);
    assert.equal(logs.at(-1), `[supabase-stack] Docker preparation failed stage=pull image=postgres ${suffix}`);
    assert.equal(h.calls.length, 3);
    assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  }
});

test("TLS details stay fixed and bounded without authorizing a retry or weakening verification", (t) => {
  for (const oversized of [false, true]) {
    const h = harness(t); const logs = []; let pulls = 0;
    const diagnostic = "net/http: TLS handshake timeout; x509: certificate verify failed\n"
      + "https://user:never-log@registry.invalid/path?token=never-log\n/private/never-log";
    assert.throws(() => h.run({ log: (line) => logs.push(line), execute: (binary, args, options) => {
      if (args[0] !== "pull") return h.execute(binary, args, options);
      pulls += 1;
      assert.deepEqual(args.slice(0, 2), ["pull", "--quiet"]);
      assert.equal(options.env.DOCKER_TLS_VERIFY, undefined);
      return { status: 1, stderr: diagnostic + (oversized ? "x".repeat(32_768) : "") };
    } }), /^Error: supabase-serial-pull-failed$/);
    assert.equal(pulls, 1);
    assert.equal(logs.at(-1), "[supabase-stack] Docker preparation failed stage=pull image=postgres "
      + "exit=1 signal=none-or-unknown error=none-or-unknown hints="
      + (oversized ? "unclassified" : "tls,tls-certificate,tls-handshake-timeout"));
    assert.ok(logs.every((line) => !/never-log|registry\.invalid|\/private\//.test(line)));
    assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  }
});

test("thrown Docker spawn errors and readback failures preserve stage and exact failure", (t) => {
  const h = harness(t); const logs = [];
  assert.throws(() => h.run({ log: (line) => logs.push(line), execute: (binary, args, options) => {
    if (binary === "docker") throw Object.assign(new Error("never-log"), { code: "ENOENT" });
    return h.execute(binary, args, options);
  } }), /^Error: supabase-serial-inspect-failed$/);
  assert.equal(logs.at(-1), "[supabase-stack] Docker preparation failed stage=inspect image=postgres exit=unknown signal=none-or-unknown error=ENOENT hints=unclassified");
  assert.equal(h.calls.length, 2);
  const readback = harness(t);
  assert.throws(() => readback.run({ log: (line) => logs.push(line), execute: (binary, args, options) => {
    if (binary === "docker" && args[0] === "image" && readback.cached.size) return { status: 1, stderr: "never-log" };
    return readback.execute(binary, args, options);
  } }), /^Error: supabase-serial-readback-failed$/);
  assert.match(logs.at(-1), /stage=readback image=postgres exit=1 /);
});

test("successful or cache-missing Docker commands do not emit failure diagnostics", (t) => {
  const h = harness(t); const logs = [];
  h.run({ databaseOnly: true, log: (line) => logs.push(line) });
  h.run({ databaseOnly: true, log: (line) => logs.push(line) });
  assert.ok(logs.every((line) => !line.includes("Docker preparation failed")));
});

test("a seventh-image failure identifies Mailpit without retries or masking cleanup", (t) => {
  for (const throwingLogger of [false, true]) {
    const h = harness(t); const logs = [];
    assert.throws(() => h.run({ authOnly: true, log: (line) => {
      logs.push(line);
      if (throwingLogger && line.includes("Docker preparation failed")) throw new Error("never-log");
    }, execute: (binary, args, options) => {
      if (args[0] === "pull" && args.at(-1).includes("/mailpit:")) return { status: 1, stderr: "unexpected EOF" };
      return h.execute(binary, args, options);
    } }), /^Error: supabase-serial-pull-failed$/);
    assert.equal(h.cached.size, 6);
    assert.equal(logs.length, 8);
    assert.equal(logs.at(-1), "[supabase-stack] Docker preparation failed stage=pull image=mailpit exit=1 signal=none-or-unknown error=none-or-unknown hints=network-reset");
    assert.equal(fs.existsSync(h.calls[0].options.env.HOME), false);
  }
});

test("startup integration preserves commands and keeps preparation outside the retry catch", () => {
  const source = fs.readFileSync(new URL("../supabase-stack.mjs", import.meta.url), "utf8");
  assert.match(source, /prepareSupabaseSerialPull\(\{ repoRoot, databaseOnly, authOnly, browserTest \}\);[\s\S]*?try \{\n    runSupabase\(startArgs\);/);
  assert.equal((source.match(/prepareSupabaseSerialPull\(\{/g) ?? []).length, 1);
  assert.match(source, /function ensureSupabase\(\)[\s\S]*?if \(existingEnv\)[\s\S]*?return \{ env: existingEnv, started: false \};/);
});

test("auth-email and both Shared Browser jobs reach the stack entry point; DB retains its separate mode", () => {
  const workflow = (name) => fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
  assert.match(workflow("auth-email.yml"), /run: pnpm supabase:up/);
  assert.equal((workflow("browser-e2e.yml").match(/          pnpm supabase:up\n/g) ?? []).length, 2);
  assert.match(workflow("controller-db-tests.yml"), /SUPABASE_DATABASE_ONLY: "1"\n        run: pnpm supabase:up/);
  // Contracts intentionally uses a different, single digest-pinned image path.
  const contracts = workflow("build.yml");
  assert.match(contracts, /run: node scripts\/ensure-supabase-postgres-image\.mjs/);
  assert.match(contracts, /run: node scripts\/test-supabase-migrations-empty-db\.mjs/);
});
