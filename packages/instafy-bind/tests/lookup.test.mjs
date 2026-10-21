// The lookup chain (src/lookup.mjs): declared providers, a breaker shared through a file, one status contract.
// Every provider here is a fake: a declared "fake" one or a counting protocol; nothing reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Health, LookupUnavailableError, STATUS, Tally, chainHealth, classify, loadProviders, lookup, runChain,
} from "../src/lookup.mjs";
import { pageFetch } from "../src/page-fetch.mjs";
import { cite, runWebCommand } from "../src/web.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lookup-test-")), "health.json");
const sink = () => ({ text: "", write(t) { this.text += t; } });

/** A protocol that answers from a table and counts every call: { calls, protocol }. */
function counting(table) {
  const calls = [];
  return {
    calls,
    protocol: {
      async lookup(request, p) {
        calls.push(p.id);
        const v = table[p.id];
        if (v instanceof Error) throw v;
        return typeof v === "function" ? v(request) : v;
      },
    },
  };
}
const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });

const DECLARED = {
  providers: {
    primary: { protocol: "test", label: "Primary search", cooldown_s: 600 },
    exact: { protocol: "test", label: "Exact titles", complete: false },
    backup: { protocol: "test", label: "Backup search" },
  },
  chains: { geocode: ["primary", "exact", "backup"] },
};

test("a provider that is down is skipped for the next one, and the breaker keeps it skipped", async () => {
  const registry = loadProviders(DECLARED, { overrides: [] });
  const health = new Health({ file: tmpState() });
  const { calls, protocol } = counting({ primary: refused(), exact: [], backup: [{ name: "Taichung Station" }] });
  const first = await runChain("geocode", { q: "Taichung" }, { registry, health, protocols: { test: protocol } });
  assert.equal(first.status, STATUS.OK);
  assert.equal(first.provider, "backup");
  assert.deepEqual(calls, ["primary", "exact", "backup"], "an exact-title miss (complete: false) proves nothing: ask on");
  assert.deepEqual(first.attempts.map((a) => a.outcome), ["unavailable", "not_found", "ok"]);

  calls.length = 0;
  const second = await runChain("geocode", { q: "Tainan" }, { registry, health, protocols: { test: protocol } });
  assert.deepEqual(calls, ["exact", "backup"], "the open breaker skips the provider that was down without calling it");
  assert.equal(second.attempts[0].outcome, "skipped_open");
  assert.ok(second.attempts[0].retry_after_s > 590);
});

test("a complete provider's empty answer is not_found and ends the chain; only unavailable is unavailable", async () => {
  const registry = loadProviders(DECLARED, { overrides: [] });
  const health = new Health({ file: tmpState() });
  const found = counting({ primary: [], exact: [{}], backup: [{}] });
  const r = await runChain("geocode", {}, { registry, health, protocols: { test: found.protocol } });
  assert.equal(r.status, STATUS.NOT_FOUND);
  assert.deepEqual(found.calls, ["primary"]);

  const down = counting({ primary: refused(), exact: [], backup: Object.assign(new Error("Backup search: HTTP 503"), { status: 503 }) });
  const d = await runChain("geocode", {}, { registry, health: new Health({ file: tmpState() }), protocols: { test: down.protocol } });
  assert.equal(d.status, STATUS.UNAVAILABLE, "a partial source's miss plus two outages is not 'not found'");
  await assert.rejects(
    lookup("geocode", {}, { registry, health: new Health({ file: tmpState() }), protocols: { test: down.protocol }, label: "Place search" }),
    (e) => e instanceof LookupUnavailableError && e.exitCode === 4 && e.code === "unavailable" && /^Place search unavailable/.test(e.message),
  );
});

test("the breaker is shared through its file by every process, and a newer turn gets one fresh try", async () => {
  const file = tmpState();
  const lookupUrl = new URL("../src/lookup.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { Health, loadProviders, runChain } = await import(${JSON.stringify(lookupUrl)});
    const registry = loadProviders({ providers: { photonish: { protocol: "fake", label: "Search" } }, chains: { geocode: ["photonish"] } }, { overrides: [] });
    const r = await runChain("geocode", {}, { registry, health: new Health({ file: ${JSON.stringify(file)} }) });
    process.stdout.write(r.status);
  `], { encoding: "utf8", env: { ...process.env, INSTAFY_TURN_STARTED_AT: "" } });
  assert.equal(child.stdout, "unavailable", child.stderr);

  const registry = loadProviders({ providers: { photonish: { protocol: "test", label: "Search" } }, chains: { geocode: ["photonish"] } }, { overrides: [] });
  const ok = counting({ photonish: [{ name: "x" }] });
  const sameTurn = await runChain("geocode", {}, { registry, health: new Health({ file, turnStartedAt: Date.now() - 60_000 }), protocols: { test: ok.protocol } });
  assert.equal(sameTurn.status, STATUS.UNAVAILABLE, "another process's outage is known here: not asked again this turn");
  assert.deepEqual(ok.calls, []);
  assert.equal(chainHealth("geocode", { registry, health: new Health({ file, turnStartedAt: null }) }).available, false);

  const nextTurn = await runChain("geocode", {}, { registry, health: new Health({ file, turnStartedAt: Date.now() + 1 }), protocols: { test: ok.protocol } });
  assert.equal(nextTurn.status, STATUS.OK, "a person's retry (a turn that started after the failure) asks again");
  assert.equal(chainHealth("geocode", { registry, health: new Health({ file, turnStartedAt: null }) }).available, true, "and the answer closes the breaker");
});

test("commands writing the health file at the same moment keep every entry", async () => {
  const file = tmpState();
  const lookupUrl = new URL("../src/lookup.mjs", import.meta.url).href;
  const writer = (n) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { Health } = await import(${JSON.stringify(lookupUrl)});
      const h = new Health({ file: ${JSON.stringify(file)} });
      for (let i = 0; i < 25; i++) h.fail({ id: "p${n}-" + i, cooldown_s: 600, fail_threshold: 1 }, "down");
    `], { stdio: "ignore" });
    child.on("close", resolve);
  });
  await Promise.all(Array.from({ length: 8 }, (_, n) => writer(n)));
  const entries = Object.keys(new Health({ file }).read().entries);
  assert.equal(entries.length, 8 * 25, `${entries.length} of 200 entries kept`);
  assert.ok(!fs.existsSync(`${file}.lock`), "the lock is released");
});

test("providers and chains are data: INSTAFY_LOOKUP_PROVIDERS replaces a chain with a declared fake outage", async () => {
  const env = { INSTAFY_LOOKUP_PROVIDERS: JSON.stringify({ providers: { drill: { protocol: "fake", behaviour: "unavailable", label: "Drill" } }, chains: { geocode: ["drill", "backup"] } }) };
  const registry = loadProviders(DECLARED, { env });
  assert.deepEqual(registry.chains.geocode, ["drill", "backup"]);
  const { calls, protocol } = counting({ backup: [{ name: "found" }] });
  const r = await runChain("geocode", {}, { registry, health: new Health({ file: tmpState() }), protocols: { test: protocol } });
  assert.deepEqual([r.status, r.provider, calls], [STATUS.OK, "backup", ["backup"]]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-file-"));
  fs.writeFileSync(path.join(dir, "p.json"), JSON.stringify({ providers: { backup: { base: "https://self-hosted.test" } } }));
  const fromFile = loadProviders({ ...DECLARED, providers: { ...DECLARED.providers, backup: { ...DECLARED.providers.backup, base_env: "BACKUP_URL" } } }, { env: { INSTAFY_LOOKUP_PROVIDERS: path.join(dir, "p.json") } });
  assert.equal(fromFile.providers.backup.base, "https://self-hosted.test");
  assert.equal(fromFile.providers.backup.protocol, "test", "an override merges into the declared provider");
  assert.throws(() => loadProviders({ providers: {}, chains: { geocode: ["nope"] } }, { overrides: [] }), /names "nope", which is not declared/);
  assert.throws(() => loadProviders({ providers: { x: {} } }, { overrides: [] }), /declares no protocol/);
});

test("a fake provider that never answers is cut at its timeout and counted as unavailable", async () => {
  const registry = loadProviders({ providers: { hang: { protocol: "fake", behaviour: "slow", timeout_ms: 1, label: "Hang" } }, chains: { route: ["hang"] } }, { overrides: [] });
  const t0 = Date.now();
  const r = await runChain("route", {}, { registry, health: new Health({ file: tmpState() }) });
  assert.equal(r.status, STATUS.UNAVAILABLE);
  assert.match(r.attempts[0].detail, /no answer in/);
  assert.ok(Date.now() - t0 < 9000);
});

test("errors are classified once: outage vs not found vs a request no provider can fix", () => {
  assert.equal(classify(refused()), "unavailable");
  assert.equal(classify(Object.assign(new Error("x"), { status: 503 })), "unavailable");
  assert.equal(classify(Object.assign(new Error("x"), { httpStatus: 429 })), "unavailable");
  assert.equal(classify(new Error("Photon: timed out after 20s")), "unavailable");
  assert.equal(classify(Object.assign(new Error("x"), { httpStatus: 404 })), "not_found");
  assert.equal(classify(Object.assign(new Error("Photon: HTTP 404"), { status: 404 })), "unavailable", "an API endpoint that is not there cannot answer");
  assert.equal(classify(Object.assign(new Error("Overpass rejected the query (HTTP 400)"), { status: 400 })), "fatal");
  assert.equal(classify(Object.assign(new Error("robots.txt disallows"), { code: "policy" })), "fatal");
  assert.equal(classify(Object.assign(new Error("out of time"), { deadline: true, name: "SkipError" })), "deadline");
});

test("many lookups tally into one honest status", () => {
  assert.equal(new Tally().add("ok").add("ok").status, "ok");
  assert.equal(new Tally().add("ok").add("unavailable", { label: "Photon" }).status, "partial");
  assert.equal(new Tally().add("unavailable").add("unavailable").status, "unavailable");
  assert.equal(new Tally().add("not_found").status, "not_found");
  assert.deepEqual(new Tally().add("ok").add("unavailable", { label: "Photon" }).toJSON().unavailable_services, ["Photon"]);
});

test("a page read through the chain: a site that is down is unavailable (exit 4), never a missing page", async () => {
  const env = { ...process.env, INSTAFY_LOOKUP_STATE: tmpState() };
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.statusCode = req.url === "/gone" ? 404 : 503; res.end("<html>busy</html>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const gone = await pageFetch(`${base}/gone`, { allowLocal: true }, { env });
    assert.equal(gone.status, 404, "a missing page is an answer");
    await assert.rejects(pageFetch(`${base}/busy`, { allowLocal: true }, { env }), (e) => e.code === "unavailable" && e.exitCode === 4);
    const before = hits;
    await assert.rejects(pageFetch(`${base}/other`, { allowLocal: true }, { env }), (e) => e.code === "unavailable" && /retry in/.test(e.message));
    assert.equal(hits, before, "the same host is not asked again while its breaker is open");
  } finally {
    server.close();
  }
});

test("instafy web cite exits 4 (unavailable) for a site that refuses connections, 1 for a missing page", async () => {
  const down = async () => { throw Object.assign(new Error("could not read shop.test: connect ECONNREFUSED"), { code: "upstream" }); };
  const r = await cite("https://shop.test/p", { fetchImpl: down });
  assert.equal(r.exit, 4);
  assert.equal(r.result.status, "unavailable");
  const out = sink();
  assert.equal(await runWebCommand(["cite", "https://shop.test/p"], { stdout: out, stderr: sink(), fetchImpl: down }), 4);
  assert.match(out.text, /^unavailable: shop\.test did not answer/);

  const missing = async (url) => ({ ok: false, status: 404, url, headers: {}, text: async () => "" });
  const m = await cite("https://shop.test/p", { fetchImpl: missing });
  assert.deepEqual([m.exit, m.result.status], [1, "not_found"]);
});

test("a handler's kit.fetch on a declared outage throws code unavailable, and the starter row says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-kit-"));
  fs.writeFileSync(path.join(dir, "h.mjs"), `
    const kit = await import(process.env.BIND_KIT);
    try { await kit.fetch("https://shop.example/p"); kit.done("read"); }
    catch (e) { process.stdout.write(JSON.stringify({ code: e.code, exit: e.exitCode }) + "\\n"); }
  `);
  const env = {
    ...process.env, BIND_KIT: new URL("../src/handler-kit.mjs", import.meta.url).href, INSTAFY_LOOKUP_STATE: tmpState(),
    INSTAFY_LOOKUP_PROVIDERS: JSON.stringify({ providers: { drill: { protocol: "fake", label: "Drill" } }, chains: { page: ["drill"] } }),
  };
  const r = spawnSync(process.execPath, [path.join(dir, "h.mjs")], { input: "{}", encoding: "utf8", env });
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { code: "unavailable", exit: 4 }, r.stderr);
  const starter = fs.readFileSync(path.join(HERE, "../src/starters/handlers/read_offer.mjs"), "utf8");
  assert.match(starter, /error\.code === "unavailable"/);
});

test("handlers share the binder's lookup health and declared providers, and each click is a fresh try", async () => {
  const { handlerEnv } = await import("../src/executors/script.mjs");
  const env = handlerEnv({ siteDir: "/s", intentId: "int_a_1234", allowLocal: false, env: { PATH: "/bin", INSTAFY_LOOKUP_STATE: "/x/health.json", INSTAFY_LOOKUP_PROVIDERS: "{\"chains\":{}}" } });
  assert.equal(env.INSTAFY_LOOKUP_STATE, "/x/health.json");
  assert.equal(env.INSTAFY_LOOKUP_PROVIDERS, "{\"chains\":{}}");
  assert.ok(Math.abs(Date.parse(env.INSTAFY_TURN_STARTED_AT) - Date.now()) < 5000);
  const plain = handlerEnv({ siteDir: "/s", intentId: "int_a_1234", allowLocal: false, env: { PATH: "/bin" } });
  assert.match(plain.INSTAFY_LOOKUP_STATE, /instafy[/\\]lookup-health\.json$/);
  assert.doesNotMatch(plain.INSTAFY_LOOKUP_STATE, /instafy-bind[/\\]home/, "not the handler's private HOME: the binder's own file");
});


test("a provider's max_concurrent bounds how many of its lookups run at once, across processes; the rest wait their turn", async () => {
  const stateFile = tmpState();
  const env = { INSTAFY_LOOKUP_STATE: stateFile };
  let live = 0;
  let peak = 0;
  const protocol = {
    async lookup() {
      live += 1; peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 60));
      live -= 1;
      return [{ id: 1 }];
    },
  };
  const declared = (max) => loadProviders({ providers: { search: { protocol: "slow", label: "Search", base: "https://search.example", ...(max ? { max_concurrent: max } : {}) },
    reverse: { protocol: "slow", label: "Reverse", base: "https://search.example", max_concurrent: 2 } },
  chains: { geocode: ["search"], reverse: ["reverse"] } }, { env, overrides: [] });
  const health = new Health({ env, file: stateFile });
  const ask = (registry, capability = "geocode") => runChain(capability, {}, { registry, health, protocols: { slow: protocol } });
  // no limit declared: all at once
  await Promise.all(Array.from({ length: 6 }, () => ask(declared(0))));
  assert.equal(peak, 6);
  // two slots: never more than two at a time, every lookup still answered
  peak = 0;
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => ask(declared(2), i % 2 ? "reverse" : "geocode")));
  assert.ok(answers.every((a) => a.status === STATUS.OK));
  assert.equal(peak, 2, "search and reverse search share the host's slots");
  // the slots are files every process sees: one held by a live process keeps the next lookup waiting
  const slots = path.join(path.dirname(stateFile), "slots");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  for (const i of [0, 1]) fs.writeFileSync(path.join(slots, `search.example.${i}.lock`), String(holder.pid));
  const t0 = Date.now();
  const waiting = ask(declared(2));
  setTimeout(() => { fs.unlinkSync(path.join(slots, "search.example.0.lock")); }, 400);
  assert.equal((await waiting).status, STATUS.OK);
  assert.ok(Date.now() - t0 >= 380, "it waited for the other process's slot");
  holder.kill();
  // a slot left by a process that is gone is taken over at once
  fs.writeFileSync(path.join(slots, "search.example.1.lock"), "999999");
  const t1 = Date.now();
  assert.equal((await ask(declared(1))).status, STATUS.OK);
  assert.ok(Date.now() - t1 < 1000);
});
