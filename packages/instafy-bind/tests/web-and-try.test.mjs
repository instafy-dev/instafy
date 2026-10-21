// Polite web reads (`instafy web cite`, kit.fetch), `instafy bind try`, and failed clicks the page does not show.
// resume-shopping-big: every "Re-check price" button crashed (the handler joined a path with the `site` object), the
// builder never clicked one, and the page kept saying "No live price checked" with no error.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPolicy, cite, hasProductData, linkOnly, politeFetch, runWebCommand } from "../src/web.mjs";
import { tryIntent } from "../src/try.mjs";
import { cleanup, makeSite, simpleParams } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");

/** A fake fetch: { url: { status, body, headers } }; unknown URLs are 404. Records every request. */
function fakeFetch(pages) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, followRedirects: options.followRedirects });
    const page = pages[url] || { status: 404, body: "" };
    return {
      ok: page.status >= 200 && page.status < 300,
      status: page.status,
      url,
      headers: { "content-type": "text/html", ...(page.headers || {}) },
      text: async () => page.body,
    };
  };
  impl.calls = calls;
  return impl;
}

test("sites whose terms ban AI agents are refused before any request", async () => {
  assert.match(linkOnly("https://www.booking.com/hotel/x"), /Booking\.com/);
  assert.equal(linkOnly("https://en.wikivoyage.org/wiki/Porto"), null);
  const fetchImpl = fakeFetch({});
  const r = await cite("https://www.amazon.com/dp/B0", { fetchImpl });
  assert.equal(r.exit, 2);
  assert.match(r.result.refused, /Amazon/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("robots.txt is honoured for the page and for every redirect hop", async () => {
  const fetchImpl = fakeFetch({
    "https://shop.test/robots.txt": { status: 200, body: "User-agent: GPTBot\nDisallow: /product/\n" },
    "https://shop.test/product/a": { status: 200, body: "<title>A</title>" },
    "https://free.test/robots.txt": { status: 404, body: "" },
    "https://free.test/go": { status: 302, headers: { location: "https://shop.test/product/b" } },
  });
  assert.match((await checkPolicy("https://shop.test/product/a", { fetchImpl })).refused, /gptbot/);
  const hop = await politeFetch("https://free.test/go", { fetchImpl });
  assert.match(hop.refused, /redirected to https:\/\/shop\.test\/product\/b: robots\.txt disallows/);
  assert.ok(fetchImpl.calls.every((c) => c.url.endsWith("robots.txt") || c.followRedirects === false), "hops are followed by hand");
});

test("cite prints the source and the matching lines; a bot check is refused; probe reports product data", async () => {
  const product = `<title>Kayano 31</title><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"123.75"}}</script><p>Gel-Kayano 31 men's</p>`;
  const fetchImpl = fakeFetch({
    "https://guide.test/robots.txt": { status: 404, body: "" },
    "https://guide.test/porto": { status: 200, body: "<title>Porto</title><p>The train to Lisbon takes 3 hours.</p><p>Food</p>" },
    "https://guide.test/wall": { status: 200, body: "<title>Just a moment...</title>" },
    "https://guide.test/shoe": { status: 200, body: product },
  });
  const fixed = () => new Date("2026-10-16T10:00:00Z");
  const page = await cite("https://guide.test/porto", { grep: /lisbon/i, fetchImpl, now: fixed });
  assert.equal(page.exit, 0);
  assert.equal(page.result.retrieved_at, "2026-10-16");
  assert.equal(page.result.excerpt, "The train to Lisbon takes 3 hours.");
  const wall = await cite("https://guide.test/wall", { fetchImpl });
  assert.equal(wall.exit, 2);
  assert.match(wall.result.refused, /bot check/);
  const probe = await cite("https://guide.test/shoe", { probe: true, fetchImpl });
  assert.deepEqual([probe.exit, probe.result.readable, probe.result.product_data], [0, true, true]);
  assert.equal(probe.result.excerpt, undefined, "a probe prints no page text");
  assert.equal(hasProductData("<p>no data</p>"), false);
});

test("cite flags an empty search page even when the grep matches its title and filters", async () => {
  // Oct 16: a maker's "Guide 18" URL was a search page listing nothing; the grep hit the title and the filter
  // facets, and the agent cited it as the product's page.
  const fetchImpl = fakeFetch({
    "https://shoes.test/robots.txt": { status: 404, body: "" },
    "https://shoes.test/guide-18": { status: 200, body: "<title>Guide 18 | Shoes</title><p>Guide 18</p><p>Stability</p><p>We're sorry, no products were found for your search: guide 18</p>" },
    "https://shoes.test/guide-19": { status: 200, body: "<title>Guide 19</title><p>Guide 19 stability running shoe, $150</p>" },
  });
  const empty = await cite("https://shoes.test/guide-18", { grep: /guide 18|stability/i, fetchImpl });
  assert.equal(empty.exit, 0);
  assert.match(empty.result.notice, /empty search, listing or error page/);
  assert.equal(empty.result.lines, 3);
  const stdout = { text: "", write(t) { this.text += t; } };
  await runWebCommand(["cite", "https://shoes.test/guide-18", "--grep", "guide 18"], { stdout, stderr: stdout, fetchImpl });
  assert.match(stdout.text, /^notice: the page says "We're sorry, no products were found/m);
  assert.match(stdout.text, /matching line\(s\) of 3:/);
  const real = await cite("https://shoes.test/guide-19", { grep: /guide 19/i, fetchImpl });
  assert.equal(real.result.notice, undefined);
});

test("web command: usage errors exit 64, refusals 2, policy lists the refused sites", async () => {
  const out = [];
  const stdout = { write: (s) => out.push(s) };
  const stderr = { write: () => {} };
  assert.equal(await runWebCommand(["cite", "not a url"], { stdout, stderr }), 64);
  assert.equal(await runWebCommand(["cite", "https://www.agoda.com/x", "--json"], { stdout, stderr, fetchImpl: fakeFetch({}) }), 2);
  assert.match(out.at(-1), /"refused":"link-only site: Agoda/);
  assert.equal(await runWebCommand(["policy"], { stdout, stderr }), 0);
  assert.match(out.at(-1), /Booking\.com[\s\S]*RunRepeat/);
});

const site = (handler) => makeSite({
  "bound.json": { version: 1, intents: { check_price: { label: "Check price", params: simpleParams({ url: { type: "string", maxLength: 200 } }), handler: "handlers/check.mjs" } } },
  "data/items.json": [{ ref: "shoes:a", store: { url: "https://www.amazon.com/dp/B0" } }],
  "handlers/check.mjs": handler,
});

test("try reports a crashing handler with the crash line and exit 1", async () => {
  // The resume-shopping-big handler: `site` is an object, so path.join throws.
  const dir = site(`import path from "node:path";
const kit = await import(process.env.BIND_KIT);
const { site } = await kit.readInput();
path.join(site, "data/items.json");
`);
  try {
    const r = await tryIntent(dir, "check_price", JSON.stringify({ name: "a", ref: "shoes:a" }));
    assert.equal(r.exit, 1);
    assert.match(r.lines.join("\n"), /ERR_INVALID_ARG_TYPE|must be of type string/);
  } finally {
    cleanup(dir);
  }
});

test("try passes a handler that reads seed data with kit.readJson and records why a refused store has no price", async () => {
  const dir = site(`const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
const item = kit.readJson("data/items.json").find((i) => i.ref === intent.params.ref);
try { await kit.fetch(item.store.url); kit.done("read"); }
catch (err) {
  kit.records([kit.uncertain({ ref: item.ref, attr: "price", url: item.store.url, note: err.message })]);
  kit.done(err.code);
}
`);
  try {
    const r = await tryIntent(dir, "check_price", JSON.stringify({ name: "a", ref: "shoes:a" }));
    assert.equal(r.exit, 0, r.lines.join("\n"));
    assert.equal(r.accepted.length, 1);
    assert.match(r.accepted[0].note, /refuses automated reads: link-only site: Amazon/);
    assert.match(r.lines.join("\n"), /done  policy/);
    const tried = JSON.parse(fs.readFileSync(path.join(dir, ".bind", "tried.json"), "utf8"));
    assert.equal(tried.check_price.ok, true);
    // The doctor stays quiet about a tried handler and speaks up once it changes.
    const quiet = spawnSync(process.execPath, [BIN, "doctor", dir], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.doesNotMatch(quiet.stdout, /has not been tried/);
    fs.appendFileSync(path.join(dir, "handlers", "check.mjs"), "\n// edited\n");
    const loud = spawnSync(process.execPath, [BIN, "doctor", dir], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.match(loud.stdout, /check_price has not been tried since its handler changed/);
  } finally {
    cleanup(dir);
  }
});

test("try fails a handler that sends nothing, and kit.error accepts a message alone", async () => {
  const silent = site(`const kit = await import(process.env.BIND_KIT); await kit.readInput(); kit.done("nothing");`);
  const oneArg = site(`const kit = await import(process.env.BIND_KIT); await kit.readInput(); kit.error("Unknown shoe or store URL");`);
  try {
    const params = JSON.stringify({ name: "a", ref: "shoes:a" });
    const quiet = await tryIntent(silent, "check_price", params);
    assert.equal(quiet.exit, 1);
    assert.match(quiet.lines.join("\n"), /sent no records/);
    const failed = await tryIntent(oneArg, "check_price", params);
    assert.equal(failed.exit, 1);
    assert.deepEqual(failed.error, { code: "upstream", message: "Unknown shoe or store URL" });
  } finally {
    cleanup(silent);
    cleanup(oneArg);
  }
});

test("a failed click shows a toast when the page does not handle errors itself", () => {
  const SOURCE = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
  const shown = [];
  const element = () => ({ setAttribute() {}, remove() {}, set textContent(v) { shown.push(v); }, get textContent() { return shown.at(-1); } });
  const window = { addEventListener() {}, location: { href: "http://localhost:4180/", pathname: "/", search: "", hash: "" } };
  window.parent = window;
  const context = {
    window,
    document: { title: "Shoes", currentScript: null, createElement: element, getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} } },
    location: window.location, URL, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console,
    fetch: () => new Promise(() => {}), EventSource: undefined,
  };
  vm.runInNewContext(SOURCE, context);
  const bind = window.instafyBind;
  bind.ingest({ source: "instafy-host", v: 2, type: "hello", capabilities: { intents: ["check_price"] } });
  const id = bind.intent("check_price", { name: "a" }, { ref: "shoes:a" });
  bind.ingest({ source: "instafy-host", v: 2, type: "error", id, error: { code: "upstream", message: "handler exited with code 1: TypeError: boom" } });
  assert.match(shown.join("|"), /check price did not work: handler exited with code 1: TypeError: boom/);
  // A page that listens for errors shows them its own way.
  shown.length = 0;
  bind.on("error", () => {});
  const second = bind.intent("check_price", { name: "b" }, { ref: "shoes:b" });
  bind.ingest({ source: "instafy-host", v: 2, type: "error", id: second, error: { code: "upstream", message: "x" } });
  assert.deepEqual(shown, []);
});

test("the client says when a click stops being pending, after its results and its done", () => {
  // Oct 16: a page re-rendered on `records`, which fires while the intent is still pending, so its button stayed
  // "Checking…" after `done`. `pending` fires on every change, last after `done`.
  const SOURCE = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
  const window = { addEventListener() {}, dispatchEvent() {}, location: { href: "http://localhost:4180/", pathname: "/", search: "", hash: "" } };
  window.parent = window;
  const element = () => ({ setAttribute() {}, remove() {} });
  const context = {
    window,
    document: { title: "Shoes", currentScript: null, createElement: element, getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} } },
    location: window.location, URL, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console,
    fetch: () => new Promise(() => {}), EventSource: undefined,
  };
  vm.runInNewContext(SOURCE, context);
  const bind = window.instafyBind;
  bind.ingest({ source: "instafy-host", v: 2, type: "hello", capabilities: { intents: ["check_price"] } });
  const seen = [];
  bind.on("records", () => seen.push(["records", bind.isPending("shoes:a")]));
  bind.on("pending", (e) => seen.push(["pending", bind.isPending("shoes:a"), e.pending.length]));
  const id = bind.intent("check_price", { name: "a" }, { ref: "shoes:a" });
  bind.ingest({ source: "instafy-host", v: 2, type: "ack", id, status: "running", name: "check_price", ref: "shoes:a" });
  bind.ingest({ source: "instafy-host", v: 2, type: "results", id, at: "t1", records: [{ type: "claim", ref: "shoes:a", attr: "price", value: 150, prov: { source: "x", observed_at: "2026-10-16T10:00:00Z" } }] });
  bind.ingest({ source: "instafy-host", v: 2, type: "done", id, summary: "ok" });
  assert.deepEqual(seen[0], ["pending", true, 1], "pending on send");
  assert.ok(seen.some(([type, isPending]) => type === "records" && isPending), "records arrive while still pending");
  assert.deepEqual(seen.at(-1), ["pending", false, 0], "the last event clears the click");
});

test("kit.fetch checks robots.txt and the link-only list on every redirect hop, not only the first URL", () => {
  // In a child: the kit installs process-wide crash handlers, and the servers must run while the parent waits.
  const kitUrl = new URL("../src/handler-kit.mjs", import.meta.url).href;
  const script = `
import http from "node:http";
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const b = await listen((q, s) => q.url === "/robots.txt" ? s.end("User-agent: *\\nDisallow: /private\\n") : s.end("SECRET " + q.url));
const bp = b.address().port;
const a = await listen((q, s) => {
  if (q.url === "/robots.txt") return s.end("User-agent: *\\nAllow: /\\n");
  s.writeHead(302, { location: q.url === "/amazon" ? "https://www.amazon.com/dp/B0" : "http://127.0.0.1:" + bp + (q.url === "/ok" ? "/public" : "/private/x") });
  s.end();
});
const ap = a.address().port;
const kit = await import(${JSON.stringify(kitUrl)});
const out = {};
for (const path of ["/go", "/amazon", "/ok"]) {
  try { const r = await kit.fetch("http://127.0.0.1:" + ap + path); out[path] = { status: r.status, text: await r.text() }; }
  catch (e) { out[path] = { code: e.code, message: e.message }; }
}
console.log(JSON.stringify(out));
a.close(); b.close();
`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH, BIND_ALLOW_LOCAL: "1" }, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(out["/go"].code, "policy", `a redirect into a robots-disallowed path must be refused: ${JSON.stringify(out["/go"])}`);
  assert.match(out["/go"].message, /redirected to .*robots\.txt disallows \/private\/x/);
  assert.equal(out["/amazon"].code, "policy");
  assert.match(out["/amazon"].message, /link-only site: Amazon/);
  assert.deepEqual(out["/ok"], { status: 200, text: "SECRET /public" });
});

test("robots.txt rules match percent-encoded and doubled-slash spellings of the same path", async () => {
  const fetchImpl = fakeFetch({ "https://robots-norm.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private\n" } });
  for (const href of ["https://robots-norm.test/private/a", "https://robots-norm.test/%70rivate/a", "https://robots-norm.test//private/a", "https://robots-norm.test/%2570"]) {
    const r = await checkPolicy(href, { fetchImpl });
    if (href.endsWith("%2570")) assert.equal(r.refused, null, "an escaped % is not a p");
    else assert.match(r.refused || "", /robots\.txt disallows/, href);
  }
  assert.equal((await checkPolicy("https://robots-norm.test/public", { fetchImpl })).refused, null);
});
