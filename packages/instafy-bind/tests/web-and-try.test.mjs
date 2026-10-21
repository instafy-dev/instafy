// Polite page reads (kit.fetch), `instafy bind try`, and failed clicks the page does not show.
// resume-shopping-big: every "Re-check price" button crashed (the handler joined a path with the `site` object), the
// builder never clicked one, and the page kept saying "No live price checked" with no error.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPolicy } from "../src/web.mjs";
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

test("robots.txt is honoured for the named AI agents too", async () => {
  const fetchImpl = fakeFetch({ "https://shop.test/robots.txt": { status: 200, body: "User-agent: GPTBot\nDisallow: /product/\n" } });
  assert.match((await checkPolicy("https://shop.test/product/a", { fetchImpl })).refused, /gptbot/);
  assert.equal((await checkPolicy("https://shop.test/about", { fetchImpl })).refused, null);
});

const site = (handler) => makeSite({
  "bound.json": { version: 1, intents: { check_price: { label: "Check price", params: simpleParams({ url: { type: "string", maxLength: 200 } }), handler: "handlers/check.mjs" } } },
  "data/items.json": [{ ref: "shoes:a", store: { url: "https://shop.localhost/p" } }],
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

test("try passes a handler that reads seed data with kit.readJson and records why a refused page has no price", async () => {
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
    assert.match(r.accepted[0].note, /blocked: shop\.localhost is a local host name/);
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

test("kit.fetch checks robots.txt on every redirect hop, not only the first URL", () => {
  // In a child: the kit installs process-wide crash handlers, and the servers must run while the parent waits.
  const kitUrl = new URL("../src/handler-kit.mjs", import.meta.url).href;
  const script = `
import http from "node:http";
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
const b = await listen((q, s) => q.url === "/robots.txt" ? s.end("User-agent: *\\nDisallow: /private\\n") : s.end("SECRET " + q.url));
const bp = b.address().port;
const a = await listen((q, s) => {
  if (q.url === "/robots.txt") return s.end("User-agent: *\\nAllow: /\\n");
  s.writeHead(302, { location: "http://127.0.0.1:" + bp + (q.url === "/ok" ? "/public" : "/private/x") });
  s.end();
});
const ap = a.address().port;
const kit = await import(${JSON.stringify(kitUrl)});
const out = {};
for (const path of ["/go", "/ok"]) {
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
