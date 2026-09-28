import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { POSTGRES_IMAGE } from "../test-supabase-migrations-empty-db.mjs";
import {
  IMAGE_MIRROR_BUDGET_MS, IMAGE_MIRROR_LOCK_URL, IMAGE_MIRROR_MODES, IMAGE_MIRROR_PULL_TIMEOUT_MS,
  cliImageRef, imagesForMode, loadSupabaseImageMirrorLock, mirrorImageFor, mirrorImageRef,
  prepareSupabaseImageMirror, resolveSupabaseImageMirror, sourceImageRef, validateSupabaseImageMirrorLock,
} from "./supabaseImageMirror.mjs";
import { ANCILLARY_IMAGES, SERIAL_PULL_CLI_VERSION, SERVICE_NAMES } from "./supabaseSerialPull.mjs";
import { AUTH_ONLY_EXCLUDED_CONTAINERS, BROWSER_TEST_EXCLUDED_CONTAINERS } from "./supabaseStartMode.mjs";

const lock = loadSupabaseImageMirrorLock();
const raw = () => JSON.parse(fs.readFileSync(IMAGE_MIRROR_LOCK_URL, "utf8"));
const names = (images) => images.map((image) => image.name);

// Supabase CLI v2.92.0 images for every service config.toml enables, from
// https://github.com/supabase/cli/blob/v2.92.0/pkg/config/templates/Dockerfile
// (Edge Runtime is excluded by every CI profile; Logflare, Vector and Supavisor
// are disabled in supabase/supabase/config.toml).
const CLI_2_92_0_IMAGES = {
  postgres: "supabase/postgres:17.6.1.106",
  gotrue: "supabase/gotrue:v2.188.1",
  realtime: "supabase/realtime:v2.82.0",
  "storage-api": "supabase/storage-api:v1.48.28",
  postgrest: "postgrest/postgrest:v14.8",
  kong: "library/kong:2.8.1",
  mailpit: "axllent/mailpit:v1.22.3",
  imgproxy: "darthsim/imgproxy:v3.8.0",
  studio: "supabase/studio:2026.04.08-sha-205cbe7",
  "postgres-meta": "supabase/postgres-meta:v0.96.4",
};

test("the lock pins exactly the images the locked Supabase CLI requests", () => {
  assert.equal(lock.supabaseCli, SERIAL_PULL_CLI_VERSION);
  const manifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.devDependencies.supabase, `^${lock.supabaseCli}`);
  const pnpmLock = fs.readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  const version = lock.supabaseCli.replaceAll(".", "\\.");
  assert.match(pnpmLock, new RegExp(`supabase:\\n\\s+specifier: \\^${version}\\n\\s+version: ${version}`));
  // A CLI bump fails here until the lock, its digests and the mirror are refreshed.
  assert.deepEqual(Object.fromEntries(lock.images.map((image) => [image.name, `${image.upstream.slice("docker.io/".length)}:${image.tag}`])),
    CLI_2_92_0_IMAGES);
  for (const image of lock.images) {
    const upstream = image.upstream.slice("docker.io/".length);
    assert.ok(SERVICE_NAMES.includes(upstream) || ANCILLARY_IMAGES.includes(`${upstream}:${image.tag}`), image.name);
  }
});

test("the Postgres entry is the digest the empty-database migration test pins", () => {
  const postgres = lock.images.find((image) => image.name === "postgres");
  assert.equal(POSTGRES_IMAGE, sourceImageRef(postgres));
  assert.equal(mirrorImageFor(POSTGRES_IMAGE), mirrorImageRef(postgres));
  assert.equal(mirrorImageRef(postgres), `ghcr.io/instafy-dev/supabase/postgres@${postgres.digest}`);
});

test("profile image sets follow the startup exclusions and the PG17 schema-initialization jobs", () => {
  const all = names(lock.images);
  assert.deepEqual(names(imagesForMode(lock, "full")), all);
  assert.deepEqual(names(imagesForMode(lock, "browser-test")), all.filter((name) => !BROWSER_TEST_EXCLUDED_CONTAINERS.includes(name)));
  // `db start` and Auth-only both run Realtime, Storage and Auth migrations as
  // one-shot containers before any persistent-service exclusion applies.
  assert.deepEqual(names(imagesForMode(lock, "auth-email")),
    all.filter((name) => !AUTH_ONLY_EXCLUDED_CONTAINERS.includes(name) || ["realtime", "storage-api"].includes(name)));
  assert.deepEqual(names(imagesForMode(lock, "database")), ["postgres", "gotrue", "realtime", "storage-api"]);
  assert.throws(() => imagesForMode(lock, "everything"), /start-mode-invalid/);
});

test("lock validation rejects anything but exact, unique, digest-pinned upstream images", () => {
  assert.deepEqual(validateSupabaseImageMirrorLock(raw()), lock);
  const mutations = [
    (l) => { l.mirror = "ghcr.io/someone-else/supabase"; },
    (l) => { l.source = "docker.io/supabase"; },
    (l) => { l.schemaVersion = 2; },
    (l) => { l.extra = true; },
    (l) => { l.images = []; },
    (l) => { l.images[0].digest = "sha256:short"; },
    (l) => { l.images[0].digest = l.images[1].digest; },
    (l) => { l.images[0].tag = "latest"; },
    (l) => { l.images[0].tag = "17 --flag"; },
    (l) => { l.images[1].name = "postgres"; },
    (l) => { l.images[0].name = "attacker"; },
    (l) => { l.images[0].upstream = "docker.io/supabase/gotrue"; },
    (l) => { l.images[0].upstream = "ghcr.io/supabase/postgres"; },
    (l) => { l.images[0].modes = ["database", "full"]; },
    (l) => { l.images[0].modes = []; },
    (l) => { l.images[0].unexpected = "inert"; },
  ];
  for (const mutate of mutations) {
    const candidate = raw();
    mutate(candidate);
    assert.throws(() => validateSupabaseImageMirrorLock(candidate), /supabase-image-mirror-lock-invalid/);
  }
  assert.throws(() => loadSupabaseImageMirrorLock(new URL("./does-not-exist.json", import.meta.url)), /lock-invalid: unreadable/);
});

test("the mirror is on under GitHub Actions or by explicit opt-in, and rejects ambiguous values", () => {
  assert.equal(resolveSupabaseImageMirror({}), false);
  assert.equal(resolveSupabaseImageMirror({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(resolveSupabaseImageMirror({ GITHUB_ACTIONS: "true", SUPABASE_IMAGE_MIRROR: "off" }), false);
  assert.equal(resolveSupabaseImageMirror({ SUPABASE_IMAGE_MIRROR: "ghcr" }), true);
  for (const value of ["1", "true", "GHCR", " ghcr", "ecr"]) {
    assert.throws(() => resolveSupabaseImageMirror({ SUPABASE_IMAGE_MIRROR: value }), /must be unset, ghcr, or off/);
  }
});

test("only digest-pinned ECR Public Supabase references map to the mirror", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(mirrorImageFor(`public.ecr.aws/supabase/storage-api@${digest}`), `ghcr.io/instafy-dev/supabase/storage-api@${digest}`);
  for (const reference of [`public.ecr.aws/supabase/postgres:17.6.1.106`, `docker.io/supabase/postgres@${digest}`,
    `public.ecr.aws/other/postgres@${digest}`, `public.ecr.aws/supabase/postgres@sha256:short`, undefined]) {
    assert.throws(() => mirrorImageFor(reference), /not a digest-pinned/);
  }
});

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

function harness({ env = { GITHUB_ACTIONS: "true", PATH: "/usr/bin" }, present = [], failures = {}, version = "2.92.0\n" } = {}) {
  const calls = [];
  const waits = [];
  const logs = [];
  const cached = new Set(present);
  let clock = 0;
  const execute = (binary, args, options) => {
    calls.push({ binary, args, options });
    if (binary === "pnpm") return ok(version);
    const target = args.at(-1);
    if (args[0] === "image") return cached.has(target) ? ok(`sha256:${"f".repeat(64)}\n`) : { status: 1, stdout: "", stderr: "No such image" };
    if (args[0] === "pull") {
      const queue = failures[target];
      const next = Array.isArray(queue) ? queue.shift() : queue;
      if (next) return typeof next === "function" ? next() : next;
      cached.add(target);
      return ok(`${target}\n`);
    }
    if (args[0] === "tag") {
      if (!cached.has(args[1])) return { status: 1, stderr: "No such image" };
      cached.add(args[2]);
      return ok();
    }
    throw new Error(`unexpected command ${binary} ${args.join(" ")}`);
  };
  const run = (options = {}) => prepareSupabaseImageMirror({
    repoRoot: "/inert", env, execute, now: () => clock, wait: (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    log: (line) => logs.push(line), ...options,
  });
  return { calls, waits, logs, cached, run, advance: (milliseconds) => { clock += milliseconds; } };
}

const pulls = (calls) => calls.filter(({ args }) => args[0] === "pull").map(({ args }) => args.at(-1));
const databaseImages = imagesForMode(lock, "database");

test("default local startup does no mirror work; explicit registry redirects are left to the CLI", () => {
  const local = harness({ env: { PATH: "/usr/bin" } });
  assert.deepEqual(local.run(), { enabled: false, images: 0, present: 0, mirrored: 0, fallback: 0, deferred: 0 });
  assert.equal(local.calls.length, 0);
  const redirected = harness({ env: { GITHUB_ACTIONS: "true", SUPABASE_INTERNAL_IMAGE_REGISTRY: "example.invalid" } });
  assert.equal(redirected.run().enabled, false);
  assert.equal(redirected.calls.length, 0);
  assert.match(redirected.logs[0], /SUPABASE_INTERNAL_IMAGE_REGISTRY is set/);
});

test("invalid switches and profiles fail before any command", () => {
  for (const options of [{ env: { SUPABASE_IMAGE_MIRROR: "yes" } }, { databaseOnly: true, authOnly: true }, { browserTest: "1" }]) {
    const h = harness();
    assert.throws(() => h.run(options), /must be unset, ghcr, or off|start-mode-invalid/);
    assert.equal(h.calls.length, 0);
  }
});

test("a CLI other than the locked version keeps today's CLI-driven pulls", () => {
  const h = harness({ version: "2.93.0\n" });
  assert.equal(h.run({ databaseOnly: true }).enabled, false);
  assert.deepEqual(h.calls.map(({ binary }) => binary), ["pnpm"]);
  assert.match(h.logs.at(-1), /not the image-mirror lock's 2\.92\.0/);
});

test("database startup pre-seeds its four CLI references from GHCR by the locked digest", () => {
  const h = harness();
  assert.deepEqual(h.run({ databaseOnly: true }),
    { enabled: true, images: 4, present: 0, mirrored: 4, fallback: 0, deferred: 0 });
  assert.deepEqual(pulls(h.calls), databaseImages.map(mirrorImageRef));
  assert.deepEqual(h.calls.filter(({ args }) => args[0] === "tag").map(({ args }) => args.slice(1)),
    databaseImages.map((image) => [mirrorImageRef(image), cliImageRef(image)]));
  assert.deepEqual(cliImageRef(databaseImages[0]), "public.ecr.aws/supabase/postgres:17.6.1.106");
  assert.ok(h.calls.every(({ options }) => options.timeout <= IMAGE_MIRROR_PULL_TIMEOUT_MS && options.killSignal === "SIGKILL"));
  assert.ok(pulls(h.calls).every((reference) => /@sha256:[0-9a-f]{64}$/.test(reference)));
  // A second start finds every reference locally and contacts no registry.
  h.calls.length = 0;
  assert.equal(h.run({ databaseOnly: true }).present, 4);
  assert.deepEqual(pulls(h.calls), []);
});

test("each profile prepares exactly its lock images", () => {
  for (const [options, mode] of [[{ authOnly: true }, "auth-email"], [{ browserTest: true }, "browser-test"], [{}, "full"]]) {
    const h = harness();
    assert.equal(h.run(options).mirrored, imagesForMode(lock, mode).length);
    assert.deepEqual(pulls(h.calls), imagesForMode(lock, mode).map(mirrorImageRef));
  }
});

test("a denied mirror falls straight back to the same digest on ECR Public", () => {
  const [postgres] = databaseImages;
  // The exact Docker 29 answer for an anonymous pull of an unpublished GHCR package.
  const h = harness({ failures: { [mirrorImageRef(postgres)]: { status: 1, stderr: "Error response from daemon: error from registry: denied\ndenied\n" } } });
  assert.deepEqual(h.run({ databaseOnly: true }),
    { enabled: true, images: 4, present: 0, mirrored: 3, fallback: 1, deferred: 0 });
  assert.deepEqual(pulls(h.calls).slice(0, 2), [mirrorImageRef(postgres), sourceImageRef(postgres)]);
  assert.deepEqual(h.waits, [], "a permanent registry answer is not retried");
  assert.ok(h.calls.some(({ args }) => args[0] === "tag" && args[1] === sourceImageRef(postgres) && args[2] === cliImageRef(postgres)));
  assert.ok(h.logs.includes("[supabase-stack] Docker preparation failed stage=mirror-pull image=postgres exit=1 signal=none-or-unknown error=none-or-unknown hints=registry-auth"));
  assert.ok(h.logs.includes("[supabase-stack] GHCR mirror unavailable for postgres; pulling the same digest from ECR Public."));
});

test("a transient mirror failure is retried once with bounded backoff", () => {
  const [postgres] = databaseImages;
  const h = harness({ failures: { [mirrorImageRef(postgres)]: [{ status: 1, stderr: "unexpected EOF" }] } });
  assert.equal(h.run({ databaseOnly: true }).mirrored, 4);
  assert.deepEqual(pulls(h.calls).slice(0, 2), [mirrorImageRef(postgres), mirrorImageRef(postgres)]);
  assert.deepEqual(h.waits, [5_000]);
});

test("when both registries fail the CLI's own pull remains the last resort, without raw output", () => {
  const [postgres] = databaseImages;
  const failure = { status: 1, stderr: "toomanyrequests: Data limit exceeded\nhttps://user:never-log@host.invalid/?token=never-log" };
  const h = harness({ failures: { [mirrorImageRef(postgres)]: [failure, failure], [sourceImageRef(postgres)]: [failure, failure] } });
  assert.deepEqual(h.run({ databaseOnly: true }),
    { enabled: true, images: 4, present: 0, mirrored: 3, fallback: 0, deferred: 1 });
  assert.equal(pulls(h.calls).filter((reference) => reference.includes("/postgres@")).length, 4);
  assert.deepEqual(h.waits, [5_000, 5_000]);
  assert.ok(!h.cached.has(cliImageRef(postgres)));
  assert.ok(h.logs.every((line) => !/never-log|host\.invalid/.test(line)));
  assert.ok(h.logs.includes("[supabase-stack] Leaving postgres to the Supabase CLI's own pull."));
  assert.equal(h.logs.filter((line) => line.includes("hints=rate-limit")).length, 4);
});

test("a spawn failure is reported with fixed metadata and does not stop preparation", () => {
  const [postgres] = databaseImages;
  const thrown = () => { throw Object.assign(new Error("never-log"), { code: "ENOENT" }); };
  const h = harness({ failures: { [mirrorImageRef(postgres)]: [thrown, thrown] } });
  assert.equal(h.run({ databaseOnly: true }).fallback, 1);
  assert.ok(h.logs.includes("[supabase-stack] Docker preparation failed stage=mirror-pull image=postgres exit=unknown signal=none-or-unknown error=ENOENT hints=unclassified"));
});

test("the total preparation budget is finite and leaves the remainder to the CLI", () => {
  const [postgres] = databaseImages;
  const h = harness();
  const slow = () => { h.advance(IMAGE_MIRROR_BUDGET_MS); return ok(); };
  const result = h.run({ databaseOnly: true, execute: (binary, args, options) => {
    if (args[0] === "pull" && args.at(-1) === mirrorImageRef(postgres)) {
      h.calls.push({ binary, args, options });
      return slow();
    }
    return h.calls.push({ binary, args, options }) && (binary === "pnpm" ? ok("2.92.0\n") : args[0] === "image" ? { status: 1 } : ok());
  } });
  assert.deepEqual(result, { enabled: true, images: 4, present: 0, mirrored: 1, fallback: 0, deferred: 3 });
  assert.match(h.logs.at(-2), /budget spent; leaving 3 image\(s\)/);
});

test("startup runs the mirror once, before the serial pull and outside the start retry", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../supabase-stack.mjs", import.meta.url)), "utf8");
  assert.equal((source.match(/prepareSupabaseImageMirror\(\{/g) ?? []).length, 1);
  assert.match(source, /prepareSupabaseImageMirror\(\{ repoRoot, databaseOnly, authOnly, browserTest \}\);\n  prepareSupabaseSerialPull\(\{ repoRoot, databaseOnly, authOnly, browserTest \}\);[\s\S]*?try \{\n    runSupabase\(startArgs\);/);
  const reuse = source.slice(source.indexOf("function ensureSupabase()"), source.indexOf("function stopSupabase()"));
  assert.doesNotMatch(reuse.slice(0, reuse.indexOf("return startSupabase();")), /prepareSupabaseImageMirror/);
  assert.deepEqual(IMAGE_MIRROR_MODES, ["database", "auth-email", "browser-test", "full"]);
});
