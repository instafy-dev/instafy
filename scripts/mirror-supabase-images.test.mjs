import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COPY_ATTEMPTS,
  copyMirror,
  fetchManifest,
  packageSettingsUrl,
  planMirror,
  readVerifiedManifest,
  sha256Digest,
  summaryMarkdown,
  validatePlan,
  verifyMirror,
} from "./mirror-supabase-images.mjs";
import {
  IMAGE_MIRROR_LOCK_URL,
  cliImageRef,
  loadSupabaseImageMirrorLock,
  mirrorImageRef,
  mirrorTagRef,
  sourceImageRef,
  upstreamImageRef,
} from "./lib/supabaseImageMirror.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/mirror-supabase-images.yml";
const workflow = fs.readFileSync(path.join(root, workflowPath), "utf8");
const lock = loadSupabaseImageMirrorLock();
const quiet = () => {};
const noSleep = async () => {};

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing step ${name}`);
  const end = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

test("the mirror workflow runs only from protected main and never for pull requests", () => {
  const triggers = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  assert.deepEqual([...triggers.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]), ["push", "schedule", "workflow_dispatch"]);
  assert.doesNotMatch(workflow, /pull_request|workflow_run|repository_dispatch|workflow_call/u);
  assert.match(triggers, /\n {2}push:\n {4}branches:\n {6}- main\n {4}paths:\n/u);
  // Everything that decides what is mirrored retriggers the mirror on main.
  for (const file of ["supabase/image-mirror.lock.json", workflowPath, "scripts/mirror-supabase-images.mjs", "scripts/lib/supabaseImageMirror.mjs"]) {
    assert.ok(triggers.includes(`      - "${file}"\n`), file);
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.equal(fileURLToPath(IMAGE_MIRROR_LOCK_URL), path.join(root, "supabase/image-mirror.lock.json"));
  assert.match(workflow, /\npermissions: \{\}\n/u);
  assert.match(workflow, /\nconcurrency:\n {2}group: mirror-supabase-images\n {2}cancel-in-progress: false\n/u);
  const guard = workflow.slice(workflow.indexOf("    if: >-\n"), workflow.indexOf("    runs-on:"));
  for (const condition of ["github.repository == 'instafy-dev/instafy'", "github.repository_id == '1309636737'",
    "github.ref == 'refs/heads/main'", "github.ref_protected == true"]) {
    assert.ok(guard.includes(condition), condition);
  }
  assert.match(step("Bind to protected main"), /GITHUB_REF_PROTECTED" != "true"/u);
  assert.match(workflow, /\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 45\n {4}permissions:\n {6}contents: read\n {6}packages: write\n {4}steps:\n/u);
  assert.doesNotMatch(workflow, /self-hosted|environment:|id-token|contents: write|actions: write/u);
});

test("the workflow holds only GITHUB_TOKEN, only between the plan and the logout", () => {
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((match) => match[1]), ["GITHUB_TOKEN"]);
  assert.match(step("Checkout exact protected-main commit"), /persist-credentials: false\n {10}ref: \$\{\{ github\.sha \}\}/u);
  assert.match(step("Set up Docker Buildx"), /docker\/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3\n {8}with:\n {10}version: v0\.35\.0\n {10}driver: docker/u);
  assert.match(step("Login to GHCR"), /if: steps\.plan\.outputs\.missing != '0'\n {8}uses: docker\/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3\n {8}with:\n {10}registry: ghcr\.io\n {10}username: \$\{\{ github\.actor \}\}\n {10}password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(step("Copy exact digests to GHCR"), /if: steps\.plan\.outputs\.missing != '0'/u);
  assert.match(step("Log out of GHCR"), /if: always\(\)\n {8}run: docker logout ghcr\.io/u);
  const order = ["Bind to protected main", "Checkout exact protected-main commit", "Plan the copy from the lock", "Login to GHCR",
    "Copy exact digests to GHCR", "Log out of GHCR", "Verify anonymous pulls by digest"];
  const positions = order.map((name) => workflow.indexOf(`      - name: ${name}\n`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every((position) => position > 0));
});

test("the workflow mirrors exactly the lock: no image list of its own, only the three script commands", () => {
  assert.doesNotMatch(workflow, /sha256:|public\.ecr\.aws|docker\.io|@sha|imagetools/u);
  assert.deepEqual([...workflow.matchAll(/^ {8}run: (node .*)$/gmu)].map((match) => match[1]), [
    'node scripts/mirror-supabase-images.mjs plan --output "$RUNNER_TEMP/supabase-image-mirror-plan.json"',
    'node scripts/mirror-supabase-images.mjs copy --plan "$RUNNER_TEMP/supabase-image-mirror-plan.json"',
    "node scripts/mirror-supabase-images.mjs verify",
  ]);
  const script = fs.readFileSync(path.join(root, "scripts/mirror-supabase-images.mjs"), "utf8");
  assert.equal((script.match(/loadSupabaseImageMirrorLock\(\)/gu) ?? []).length, 1);
});

// A registry fake keyed by reference. Values are manifest results as fetchManifest returns them.
function registry(entries = {}) {
  const reads = [];
  const read = async (reference) => {
    reads.push(reference);
    const value = entries[reference];
    const next = Array.isArray(value) ? value.shift() : value;
    return next ?? { ok: false, status: 404, stage: "manifest" };
  };
  return { read, reads };
}
const served = (digest, manifests = []) => ({
  ok: true, status: 200, digest, mediaType: "application/vnd.oci.image.index.v1+json",
  bytes: Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: manifests.map((child) => ({ digest: child })) })),
});

test("planning an empty mirror copies every lock image, in lock order, from a verified ECR source", async () => {
  const entries = Object.fromEntries(lock.images.map((image) => [sourceImageRef(image), served(image.digest)]));
  const plan = await planMirror(lock, { read: registry(entries).read, sleep: noSleep, log: quiet });
  assert.deepEqual(plan.present, []);
  assert.deepEqual(plan.entries, lock.images.map((image) => ({
    name: image.name, tag: image.tag, digest: image.digest, target: mirrorTagRef(image),
    sources: [sourceImageRef(image), upstreamImageRef(image)],
  })));
  assert.deepEqual(validatePlan(plan, lock), plan);
});

test("planning skips digests GHCR already serves anonymously", async () => {
  const entries = Object.fromEntries(lock.images.flatMap((image) => [
    [mirrorImageRef(image), served(image.digest)], [mirrorTagRef(image), served(image.digest)],
    [sourceImageRef(image), served(image.digest)],
  ]));
  const [postgres] = lock.images;
  delete entries[mirrorImageRef(postgres)];
  const { read, reads } = registry(entries);
  const plan = await planMirror(lock, { read, sleep: noSleep, log: quiet });
  assert.deepEqual(plan.present, lock.images.slice(1).map((image) => image.name));
  assert.deepEqual(plan.entries.map((entry) => entry.name), ["postgres"]);
  assert.ok(!reads.some((reference) => reference.startsWith("public.ecr.aws/") && !reference.includes("/postgres@")));
});

test("planning re-copies an image whose tag or child manifest GHCR no longer serves", async () => {
  const [postgres, gotrue, realtime] = lock.images;
  const children = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
  const child = (image, digest) => [`ghcr.io/instafy-dev/supabase/${image.name}@${digest}`,
    { ok: true, status: 200, digest, mediaType: "application/vnd.oci.image.manifest.v1+json", bytes: Buffer.from("{}") }];
  const entries = {};
  for (const image of [postgres, gotrue, realtime]) {
    Object.assign(entries, {
      [mirrorImageRef(image)]: served(image.digest, children), [mirrorTagRef(image)]: served(image.digest),
      [sourceImageRef(image)]: served(image.digest),
    }, Object.fromEntries(children.map((digest) => child(image, digest))));
  }
  // An untagged-version cleanup removed one postgres child; a tag was deleted by hand from gotrue.
  delete entries[`ghcr.io/instafy-dev/supabase/postgres@${children[1]}`];
  delete entries[mirrorTagRef(gotrue)];
  const logs = [];
  const plan = await planMirror({ ...lock, images: [postgres, gotrue, realtime] },
    { read: registry(entries).read, sleep: noSleep, log: (line) => logs.push(line) });
  assert.deepEqual(plan.present, ["realtime"]);
  assert.deepEqual(plan.entries.map((entry) => entry.name), ["postgres", "gotrue"]);
  assert.deepEqual(plan.entries[0].sources, [sourceImageRef(postgres), upstreamImageRef(postgres)]);
  assert.deepEqual(logs, [
    `::warning::postgres: GHCR serves ${postgres.digest} but not its child manifest ${children[1]}; copying it again.`,
    `::warning::gotrue: GHCR serves ${gotrue.digest} but not its tag ${gotrue.tag}; copying it again.`,
  ]);
});

test("ECR reads back off on rate limits, then Docker Hub serves the same digest", async () => {
  const [postgres] = lock.images;
  const limited = { ok: false, status: 429, stage: "manifest" };
  const waits = [];
  const { read } = registry({
    [sourceImageRef(postgres)]: [limited, limited, limited, limited],
    [upstreamImageRef(postgres)]: served(postgres.digest),
  });
  const plan = await planMirror({ ...lock, images: [postgres] }, { read, sleep: async (ms) => waits.push(ms), log: quiet });
  assert.deepEqual(waits, [10_000, 20_000, 40_000]);
  assert.deepEqual(plan.entries[0].sources, [upstreamImageRef(postgres), sourceImageRef(postgres)]);
});

test("a source serving other bytes is never accepted, and no source means no copy", async () => {
  const [postgres] = lock.images;
  const wrong = served(`sha256:${"0".repeat(64)}`);
  const verified = await readVerifiedManifest(sourceImageRef(postgres), postgres.digest, { read: registry({ [sourceImageRef(postgres)]: wrong }).read, sleep: noSleep, log: quiet });
  assert.deepEqual(verified, { ok: false, status: 200, stage: "digest-mismatch" });
  await assert.rejects(
    planMirror({ ...lock, images: [postgres] }, { read: registry({ [sourceImageRef(postgres)]: wrong, [upstreamImageRef(postgres)]: wrong }).read, sleep: noSleep, log: quiet }),
    /no source served postgres@sha256:[0-9a-f]{64}; nothing was copied/u,
  );
});

test("a plan cannot name anything the lock does not", () => {
  const [postgres, gotrue] = lock.images;
  const entry = { name: "postgres", tag: postgres.tag, digest: postgres.digest, target: mirrorTagRef(postgres), sources: [sourceImageRef(postgres), upstreamImageRef(postgres)] };
  const plan = (entries) => ({ schemaVersion: 1, present: [], entries });
  assert.doesNotThrow(() => validatePlan(plan([entry]), lock));
  for (const bad of [
    { ...entry, digest: gotrue.digest }, { ...entry, tag: "latest" }, { ...entry, target: "ghcr.io/instafy-dev/other:1" },
    { ...entry, sources: ["docker.io/attacker/postgres@" + postgres.digest, upstreamImageRef(postgres)] },
    { ...entry, sources: [sourceImageRef(postgres)] }, { ...entry, name: "attacker" }, { ...entry, extra: 1 },
  ]) {
    assert.throws(() => validatePlan(plan([bad]), lock), /not in the lock/u);
  }
  assert.throws(() => validatePlan(plan([entry, entry]), lock), /not in the lock/u);
  assert.throws(() => validatePlan({ entries: [] }, lock), /plan is invalid/u);
});

// Registry bytes for synthetic entries: a digest maps to bytes that hash to it.
const manifestBytes = new Map();
function stored(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const digest = sha256Digest(bytes);
  manifestBytes.set(digest, bytes);
  return digest;
}
function entryFor(image, { platforms = 0 } = {}) {
  const children = Array.from({ length: platforms }, (_, platform) => stored({ schemaVersion: 2, name: image.name, platform }));
  const digest = stored(platforms ? { schemaVersion: 2, manifests: children.map((child) => ({ digest: child })) }
    : { schemaVersion: 2, name: image.name });
  return { name: image.name, tag: image.tag, digest, target: mirrorTagRef(image),
    sources: [sourceImageRef({ ...image, digest }), upstreamImageRef({ ...image, digest })], children };
}
const plannedEntry = ({ children, ...entry }) => entry;

function docker({ ghcr = {}, createFailures = 0, dropChild = null } = {}) {
  const calls = [];
  let failures = createFailures;
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[2] === "create") {
      if (failures > 0) {
        failures -= 1;
        return { status: 1, stderr: "toomanyrequests: Data limit exceeded" };
      }
      const [, , , , target, source] = args;
      const digest = source.split("@")[1];
      const repository = target.split(":")[0];
      // Like buildx: every child manifest, then the index, then the tag.
      for (const { digest: child } of JSON.parse(manifestBytes.get(digest)).manifests ?? []) {
        if (child !== dropChild) ghcr[`${repository}@${child}`] = child;
      }
      ghcr[target] = digest;
      ghcr[`${repository}@${digest}`] = digest;
      return { status: 0, stderr: "" };
    }
    if (args[2] === "inspect") {
      const digest = ghcr[args.at(-1)];
      return digest ? { status: 0, stdout: manifestBytes.get(digest) } : { status: 1, stdout: Buffer.alloc(0) };
    }
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  return { calls, execute, ghcr };
}

test("copy republishes one source with no annotations or platform filter, then proves the digest and tag", async () => {
  const [postgres] = lock.images;
  const entry = plannedEntry(entryFor(postgres));
  const fake = docker();
  assert.deepEqual(await copyMirror({ entries: [entry] }, { execute: fake.execute, sleep: noSleep, log: quiet }), ["postgres"]);
  const creates = fake.calls.filter(({ args }) => args[2] === "create");
  assert.deepEqual(creates.map(({ args }) => args), [["buildx", "imagetools", "create", "--tag", entry.target, entry.sources[0]]]);
  assert.ok(creates.every(({ options }) => options.timeout === 15 * 60_000));
  const inspected = fake.calls.filter(({ args }) => args[2] === "inspect").map(({ args }) => args.slice(3));
  assert.deepEqual(inspected, [
    ["--raw", `ghcr.io/instafy-dev/supabase/postgres@${entry.digest}`],
    ["--raw", `ghcr.io/instafy-dev/supabase/postgres@${entry.digest}`],
    ["--raw", entry.target],
  ]);
});

test("copy retries with backoff, falls back to the second source, and skips digests already in GHCR", async () => {
  const [postgres] = lock.images;
  const entry = plannedEntry(entryFor(postgres));
  const waits = [];
  const flaky = docker({ createFailures: COPY_ATTEMPTS });
  await copyMirror({ entries: [entry] }, { execute: flaky.execute, sleep: async (ms) => waits.push(ms), log: quiet });
  const creates = flaky.calls.filter(({ args }) => args[2] === "create").map(({ args }) => args.at(-1));
  assert.deepEqual(creates, [...Array(COPY_ATTEMPTS).fill(entry.sources[0]), entry.sources[1]]);
  assert.deepEqual(waits, [15_000, 30_000]);

  const existing = docker({ ghcr: { [`ghcr.io/instafy-dev/supabase/postgres@${entry.digest}`]: entry.digest, [entry.target]: entry.digest } });
  await copyMirror({ entries: [entry] }, { execute: existing.execute, sleep: noSleep, log: quiet });
  assert.equal(existing.calls.filter(({ args }) => args[2] === "create").length, 0);
});

test("copy re-pushes a missing tag or child manifest, and skips only a complete image", async () => {
  const [postgres] = lock.images;
  const { children, ...entry } = entryFor(postgres, { platforms: 2 });
  const repository = "ghcr.io/instafy-dev/supabase/postgres";
  const holding = (...digests) => Object.fromEntries(digests.map((digest) => [`${repository}@${digest}`, digest]));
  const creates = (fake) => fake.calls.filter(({ args }) => args[2] === "create").length;

  const complete = docker({ ghcr: { ...holding(entry.digest, ...children), [entry.target]: entry.digest } });
  const logs = [];
  await copyMirror({ entries: [entry] }, { execute: complete.execute, sleep: noSleep, log: (line) => logs.push(line) });
  assert.equal(creates(complete), 0);
  assert.ok(logs.includes(`postgres: GHCR already holds ${entry.digest}, its tag and every child manifest; skipping the copy.`));
  assert.ok(children.every((child) => complete.calls.some(({ args }) => args[2] === "inspect" && args.at(-1) === `${repository}@${child}`)));

  const childless = docker({ ghcr: { ...holding(entry.digest, children[0]), [entry.target]: entry.digest } });
  logs.length = 0;
  assert.deepEqual(await copyMirror({ entries: [entry] }, { execute: childless.execute, sleep: noSleep, log: (line) => logs.push(line) }), ["postgres"]);
  assert.equal(creates(childless), 1);
  assert.equal(childless.ghcr[`${repository}@${children[1]}`], children[1]);
  assert.ok(logs.includes(`postgres: GHCR holds ${entry.digest} but not its child manifest ${children[1]}; copying it again.`));

  const untagged = docker({ ghcr: holding(entry.digest, ...children) });
  logs.length = 0;
  await copyMirror({ entries: [entry] }, { execute: untagged.execute, sleep: noSleep, log: (line) => logs.push(line) });
  assert.equal(creates(untagged), 1);
  assert.equal(untagged.ghcr[entry.target], entry.digest);
  assert.ok(logs.includes(`postgres: GHCR holds ${entry.digest} but not its tag ${entry.target}; copying it again.`));

  await assert.rejects(copyMirror({ entries: [entry] }, { execute: docker({ dropChild: children[1] }).execute, sleep: noSleep, log: quiet }),
    new RegExp(`postgres: GHCR does not serve child manifest ${children[1]} of ${entry.digest}`, "u"));
});

test("copy fails loudly when every source fails or GHCR serves other bytes", async () => {
  const [postgres] = lock.images;
  const entry = plannedEntry(entryFor(postgres));
  await assert.rejects(copyMirror({ entries: [entry] }, { execute: docker({ createFailures: 2 * COPY_ATTEMPTS }).execute, sleep: noSleep, log: quiet }),
    /postgres: every source failed/u);
  const moved = docker();
  const execute = (command, args, options) => {
    const result = moved.execute(command, args, options);
    if (args[2] === "inspect" && args.at(-1) === entry.target) return { status: 0, stdout: Buffer.from("other bytes") };
    return result;
  };
  await assert.rejects(copyMirror({ entries: [entry] }, { execute, sleep: noSleep, log: quiet }), /resolves to sha256:[0-9a-f]{64}, not/u);
});

test("verification proves every lock entry anonymously and names the package setting to fix", async () => {
  const children = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
  const entries = {};
  for (const image of lock.images) {
    entries[mirrorImageRef(image)] = served(image.digest, children);
    entries[mirrorTagRef(image)] = served(image.digest);
    for (const child of children) entries[`ghcr.io/instafy-dev/supabase/${image.name}@${child}`] = { ok: true, status: 200, digest: child, mediaType: "application/vnd.oci.image.manifest.v1+json", bytes: Buffer.from("{}") };
    entries[cliImageRef(image)] = served(image.digest);
  }
  const clean = await verifyMirror(lock, { read: registry(entries).read, sleep: noSleep, log: quiet });
  assert.deepEqual(clean.problems, []);
  assert.deepEqual(clean.rows.map((row) => row.name), lock.images.map((image) => image.name));

  const [postgres, gotrue, realtime] = lock.images;
  entries[mirrorImageRef(postgres)] = { ok: false, status: 403, stage: "token" };
  delete entries[`ghcr.io/instafy-dev/supabase/gotrue@${children[1]}`];
  entries[cliImageRef(realtime)] = served(`sha256:${"9".repeat(64)}`);
  const warnings = [];
  const broken = await verifyMirror(lock, { read: registry(entries).read, sleep: noSleep, log: (line) => warnings.push(line) });
  assert.deepEqual(broken.problems, [
    `postgres is not anonymously pullable (HTTP 403). If the copy step succeeded, set the package visibility to Public: ${packageSettingsUrl("postgres")}`,
    `gotrue: child manifest ${children[1]} is not anonymously pullable from GHCR.`,
  ]);
  assert.equal(packageSettingsUrl("postgres"), "https://github.com/orgs/instafy-dev/packages/container/supabase%2Fpostgres/settings");
  assert.deepEqual(warnings, [`::warning::${cliImageRef(realtime)} now resolves to sha256:${"9".repeat(64)}; the lock and mirror keep ${realtime.digest}.`]);
  const summary = summaryMarkdown(broken.rows);
  assert.match(summary, /\| postgres \| `17\.6\.1\.106` \| `sha256:21ab97114931` \| not public or missing \| unchanged \|/u);
  assert.match(summary, /\| realtime \| `v2\.82\.0` \| `sha256:e3a9a49c92d1` \| ok \| moved \|/u);
  assert.equal(gotrue.name, "gotrue");
});

test("verification retries a transient GHCR answer, and stops retrying once GHCR is down", async () => {
  const children = [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`];
  const healthy = () => {
    const entries = {};
    for (const image of lock.images) {
      entries[mirrorImageRef(image)] = served(image.digest, children);
      entries[mirrorTagRef(image)] = served(image.digest);
      for (const child of children) entries[`ghcr.io/instafy-dev/supabase/${image.name}@${child}`] = { ok: true, status: 200, digest: child, mediaType: "application/vnd.oci.image.manifest.v1+json", bytes: Buffer.from("{}") };
      entries[cliImageRef(image)] = served(image.digest);
    }
    return entries;
  };
  const [postgres, gotrue] = lock.images;
  const entries = healthy();
  const unavailable = { ok: false, status: 503, stage: "manifest" };
  entries[mirrorImageRef(postgres)] = [unavailable, served(postgres.digest, children)];
  entries[mirrorTagRef(gotrue)] = [{ ok: false, status: 429, stage: "token" }, { ok: false, status: 0, stage: "network" }, served(gotrue.digest)];
  const waits = [];
  const recovered = await verifyMirror(lock, { read: registry(entries).read, sleep: async (ms) => waits.push(ms), log: quiet });
  assert.deepEqual(recovered.problems, []);
  assert.deepEqual(waits, [10_000, 10_000, 20_000]);

  // 404 is an answer: reported at once, never retried.
  const missing = healthy();
  delete missing[`ghcr.io/instafy-dev/supabase/${gotrue.name}@${children[0]}`];
  const missingWaits = [];
  const fake = registry(missing);
  const partial = await verifyMirror(lock, { read: fake.read, sleep: async (ms) => missingWaits.push(ms), log: quiet });
  assert.deepEqual(partial.problems, [`gotrue: child manifest ${children[0]} is not anonymously pullable from GHCR.`]);
  assert.deepEqual(missingWaits, []);
  assert.equal(fake.reads.filter((reference) => reference.endsWith(`gotrue@${children[0]}`)).length, 1);

  // A GHCR outage spends one backoff, then every remaining read is one attempt.
  const outage = registry(Object.fromEntries(lock.images.map((image) => [cliImageRef(image), served(image.digest)])));
  const down = async (reference) => (reference.startsWith("ghcr.io/") ? (outage.reads.push(reference), unavailable) : outage.read(reference));
  const outageWaits = [];
  const failed = await verifyMirror(lock, { read: down, sleep: async (ms) => outageWaits.push(ms), log: quiet });
  assert.deepEqual(outageWaits, [10_000, 20_000, 40_000]);
  assert.equal(outage.reads.filter((reference) => reference.startsWith("ghcr.io/")).length, 4 + lock.images.length - 1);
  assert.deepEqual(failed.rows.map((row) => row.ghcr), lock.images.map(() => "unreachable (manifest 503)"));
  assert.equal(failed.problems.length, lock.images.length);
});

function response(status, { body = "", headers = {} } = {}) {
  return new Response(status === 200 ? body : null, { status, headers });
}

test("anonymous manifest reads follow only the registry's own token realm and hash the exact bytes", async () => {
  const bytes = JSON.stringify({ schemaVersion: 2, manifests: [] });
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), authorization: init.headers?.Authorization ?? null });
    if (String(url).startsWith("https://ghcr.io/token")) return response(200, { body: JSON.stringify({ token: "anonymous-token" }) });
    if (!init.headers?.Authorization) {
      return response(401, { headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:instafy-dev/supabase/postgres:pull"' } });
    }
    return response(200, { body: bytes, headers: { "content-type": "application/vnd.oci.image.index.v1+json" } });
  };
  const result = await fetchManifest(`ghcr.io/instafy-dev/supabase/postgres@${digest}`, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.digest, digest);
  assert.equal(result.mediaType, "application/vnd.oci.image.index.v1+json");
  assert.deepEqual(requests.map((request) => request.url), [
    `https://ghcr.io/v2/instafy-dev/supabase/postgres/manifests/${digest}`,
    "https://ghcr.io/token?service=ghcr.io&scope=repository%3Ainstafy-dev%2Fsupabase%2Fpostgres%3Apull",
    `https://ghcr.io/v2/instafy-dev/supabase/postgres/manifests/${digest}`,
  ]);
  assert.equal(requests[2].authorization, "Bearer anonymous-token");
  assert.ok(!JSON.stringify(result).includes("anonymous-token"));

  const foreign = async () => response(401, { headers: { "www-authenticate": 'Bearer realm="https://attacker.invalid/token",service="x"' } });
  assert.deepEqual(await fetchManifest(`ghcr.io/instafy-dev/supabase/postgres@${digest}`, { fetchImpl: foreign }), { ok: false, status: 401, stage: "challenge" });
  const privatePackage = async (url) => String(url).startsWith("https://ghcr.io/token")
    ? response(403)
    : response(401, { headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } });
  assert.deepEqual(await fetchManifest(`ghcr.io/instafy-dev/supabase/postgres@${digest}`, { fetchImpl: privatePackage }), { ok: false, status: 403, stage: "token" });
  const offline = async () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await fetchManifest("public.ecr.aws/supabase/postgres:17.6.1.106", { fetchImpl: offline }), { ok: false, status: 0, stage: "network", code: "TypeError" });
  await assert.rejects(fetchManifest("registry.invalid/supabase/postgres:1"), /unsupported image reference/u);
});
