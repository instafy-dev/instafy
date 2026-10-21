// Browser check of the bind client: two pages on one binder, an intent from one, records in both,
// a command pushed to both, and the static fallback without a binder.
// Not part of `npm test` (it needs Chrome and Playwright):
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node tests/browser.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createBinder } from "../src/server.mjs";
import { initSite } from "../src/init.mjs";
import { serveStatic } from "../src/static.mjs";

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) {
  console.error("Set PLAYWRIGHT_MODULE to a playwright package folder to run this check.");
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)(modulePath);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-e2e-"));
initSite(dir);
const binder = createBinder({ root: dir, port: 0, env: {}, log: () => {} });
await binder.listen();
const share = binder.shareUrl(binder.sites[0]);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let staticServer, hostServer, followServer, askServer, askBinder;
try {
  const context = await browser.newContext();
  const [a, b] = [await context.newPage(), await context.newPage()];
  const errors = [];
  for (const page of [a, b]) page.on("pageerror", (e) => errors.push(e.message));
  await a.goto(share);
  await b.goto(share);
  for (const page of [a, b]) {
    const info = await page.evaluate(() => window.instafyBind.ready.then((r) => ({ connected: r.connected, names: r.names, byIndex: r.intents.hello?.label })));
    assert.equal(info.connected, true);
    assert.deepEqual(info.names, ["hello"], "Ask Octo is hidden where no host takes asks");
    assert.equal(info.byIndex, "Say hello");
  }
  // b collects events
  await b.evaluate(() => {
    window.seen = [];
    instafyBind.on("*", (type, payload) => window.seen.push({ type, id: payload && payload.id }));
  });
  await a.fill("#name", "Kim");
  await a.click("button");
  await a.waitForFunction(() => document.querySelectorAll("#records li").length === 1);
  await b.waitForFunction(() => document.querySelectorAll("#records li").length === 1, null, { timeout: 5000 });
  assert.match(await b.textContent("#records li"), /Hello, Kim!/);
  assert.match(await a.textContent("#status"), /Greeted Kim/);
  const seen = await b.evaluate(() => window.seen.map((e) => e.type));
  for (const type of ["ack", "progress", "results", "records", "done"]) assert.ok(seen.includes(type), `b saw ${type}: ${seen.join(",")}`);
  assert.deepEqual(await a.evaluate(() => instafyBind.pending()), []);
  assert.equal(await a.evaluate(() => instafyBind.records("greetings:kim").length), 1);

  // a rejected intent (bad params) comes back as ack rejected
  const rejected = await a.evaluate(() => new Promise((resolve) => {
    const off = instafyBind.on("ack", (m) => { if (m.status === "rejected") { off(); resolve(m.reason); } });
    instafyBind.intent("hello", { name: 5 });
  }));
  assert.match(rejected, /name must be string/);

  // command from the binder's admin side reaches both pages; toast renders as text
  await fetch(`${binder.url}/__bind/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${binder.adminToken}` },
    body: JSON.stringify({ name: "toast", args: { text: "<b>Checked</b>" } }),
  });
  for (const page of [a, b]) {
    await page.waitForFunction(() => [...document.querySelectorAll("[role=status]")].some((el) => el.textContent === "<b>Checked</b>"));
  }

  // the token left the address bar and is not readable by page scripts
  assert.ok(!a.url().includes("k="), a.url());
  assert.equal(await a.evaluate(() => instafyBind.token), undefined);
  assert.equal(await a.evaluate(() => instafyBind.hasToken), true);

  // without the token (a fresh browser, so no session cookie) the page connects but cannot send
  const stranger = await browser.newContext();
  const c = await stranger.newPage();
  await c.goto(share.replace(/#k=.*/, ""));
  const noToken = await c.evaluate(() => window.instafyBind.ready.then(() => new Promise((resolve) => {
    instafyBind.on("ack", (m) => { if (m.status === "rejected") resolve(m.reason); });
    instafyBind.intent("hello", { name: "x" });
  })));
  assert.equal(noToken, "token");
  await stranger.close();

  // static hosting (no binder): saved records still load from data/records
  staticServer = http.createServer((req, res) => serveStatic(req, res, dir, new URL(req.url, "http://x").pathname));
  staticServer.on("request", () => {});
  await new Promise((resolve) => staticServer.listen(0, "127.0.0.1", resolve));
  // the static server cannot serve __bind/client.js, so inline it
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace('<script src="__bind/client.js"></script>', () => `<script>${fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8")}</script>`);
  fs.writeFileSync(path.join(dir, "static.html"), html);
  const d = await context.newPage();
  d.on("pageerror", (e) => console.log("static pageerror:", e.message));
  d.on("console", (m) => process.env.E2E_DEBUG && console.log("static page:", m.text()));
  d.on("requestfinished", async (r) => process.env.E2E_DEBUG && console.log("static req:", r.url(), (await r.response())?.status()));
  await d.goto(`http://127.0.0.1:${staticServer.address().port}/static.html`);
  await d.waitForFunction(() => document.querySelectorAll("#records li").length === 1, null, { timeout: 5000 });
  // (static hosting serves bound.json and data/ itself; only the binder gates them behind the token)
  const offline = await d.evaluate(() => instafyBind.ready.then((r) => r.connected));
  assert.equal(offline, false);

  // framed by a host on another origin (Studio frames with no referrer and without geolocation in `allow`):
  // instafyBind.location() asks the host, which answers at the site's origin, and never the browser.
  const site = `http://127.0.0.1:${staticServer.address().port}`;
  hostServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><iframe id="f" referrerpolicy="no-referrer" allow="fullscreen" src="${site}/static.html?instafy_host=studio"></iframe>
<script>
const f = document.getElementById("f"), SITE = ${JSON.stringify(site)};
window.got = [];
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow || e.origin !== SITE || !e.data || e.data.source !== "instafy-bind") return;
  got.push(e.data);
  if (e.data.type === "location-request") f.contentWindow.postMessage({ source: "instafy-host", v: 1, type: "location",
    payload: { id: e.data.payload.id, coords: { latitude: 59.33, longitude: 18.07, accuracy: 20 }, timestamp: Date.now() } }, SITE);
});
f.addEventListener("load", () => f.contentWindow.postMessage({ source: "instafy-host", v: 1, type: "layout",
  insets: { top: 0, right: 0, bottom: 0, left: 0 }, chrome: "host", title: "shown", caps: { geolocation: true, location: "host" }, theme: "light" }, SITE));
</script>`);
  });
  await new Promise((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
  const h = await context.newPage();
  h.on("pageerror", (e) => errors.push(e.message));
  await h.goto(`http://localhost:${hostServer.address().port}/`);
  const frame = h.frames().find((fr) => fr.url().startsWith(site));
  await frame.waitForFunction(() => window.instafyBind && window.instafyBind.hostLayout);
  const located = await frame.evaluate(() => instafyBind.location().then((p) => ({ via: p.via, lat: p.coords.latitude })));
  assert.deepEqual(located, { via: "host", lat: 59.33 });
  const asked = await h.evaluate(() => window.got.map((m) => m.type));
  assert.deepEqual(asked, ["layout-ack", "location-request"], "the layout is acked (follow mode), then the location asked");

  // Ask Octo in a host that takes asks (Studio's layout caps.ask): the click goes to the host as an ask, at the host's
  // origin, and never to the binder; the host's ask-status ends it. (A tokenless preview binder, which loopback
  // pages may frame, stands in for the preview card.)
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-e2e-ask-"));
  initSite(askDir);
  askBinder = createBinder({ root: askDir, port: 0, preview: true, env: {}, log: () => {}, previewStateFile: path.join(askDir, "no-state.json") });
  await askBinder.listen();
  const askSite = askBinder.url;
  askServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><iframe id="f" referrerpolicy="no-referrer" src="${askSite}/?instafy_host=studio"></iframe>
<script>
const f = document.getElementById("f"), SITE = ${JSON.stringify(askSite)};
window.asks = [];
addEventListener("message", (e) => {
  if (e.source !== f.contentWindow || e.origin !== SITE || !e.data || e.data.source !== "instafy-bind" || e.data.type !== "ask") return;
  asks.push(e.data.payload);
  const reply = (state, reason) => f.contentWindow.postMessage({ source: "instafy-host", v: 1, type: "ask-status", payload: { id: e.data.payload.id, state, reason } }, SITE);
  reply("sent");
  setTimeout(() => reply("done", "Octo answered in the chat"), 50);
});
f.addEventListener("load", () => f.contentWindow.postMessage({ source: "instafy-host", v: 1, type: "layout", caps: { ask: true }, theme: "light" }, SITE));
</script>`);
  });
  await new Promise((resolve) => askServer.listen(0, "127.0.0.1", resolve));
  const k = await context.newPage();
  k.on("pageerror", (e) => errors.push(e.message));
  await k.goto(`http://localhost:${askServer.address().port}/`);
  const askFrame = k.frames().find((fr) => fr.url().startsWith(askSite));
  await askFrame.waitForFunction(() => window.instafyBind && window.instafyBind.names.includes("ask_octo"), null, { timeout: 5000 });
  const asked2 = await askFrame.evaluate(() => new Promise((resolve) => {
    const seen = [];
    instafyBind.on("*", (type, m) => { if (m && m.id && type !== "intent" && type !== "pending") seen.push(type + ":" + (m.status || m.summary || "")); });
    const id = instafyBind.intent("ask_octo", { name: "Kim", ref: "greetings:kim" }, { ref: "greetings:kim" });
    instafyBind.on("done", (m) => { if (m.id === id) resolve(seen); });
  }));
  assert.deepEqual(asked2, ["ack:sent", "done:Octo answered in the chat"]);
  const askPayloads = await k.evaluate(() => window.asks);
  assert.equal(askPayloads.length, 1);
  assert.deepEqual({ intent: askPayloads[0].intent, label: askPayloads[0].label, params: askPayloads[0].params },
    { intent: "ask_octo", label: "Ask Octo", params: { name: "Kim", ref: "greetings:kim" } });
  assert.deepEqual(askBinder.sites[0].jobs.list(), [], "the binder never ran the ask");
  fs.rmSync(askDir, { recursive: true, force: true });

  // follow mode: a phone presents the sample table, a desktop follows (the parent relays like Studio)
  const client = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
  fs.writeFileSync(path.join(dir, "follow.html"), fs.readFileSync(new URL("../examples/follow-table/index.html", import.meta.url), "utf8")
    .replace('<script src="__bind/client.js"></script>', () => `<script>${client}</script>`));
  followServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><style>iframe{border:0;position:absolute;top:0}#a{left:0;width:390px;height:700px}#b{left:400px;width:900px;height:600px}</style>
<iframe id="a" src="${site}/follow.html?instafy_host=studio"></iframe><iframe id="b" src="${site}/follow.html?instafy_host=studio"></iframe>
<script>
const SITE = ${JSON.stringify(site)}, A = document.getElementById("a"), B = document.getElementById("b");
Object.assign(window, { views: [], taps: [], interacts: [], acks: {}, echo: [], relay: true });
const to = (f, m) => f.contentWindow.postMessage(Object.assign({ source: "instafy-host", v: 1 }, m), SITE);
for (const f of [A, B]) f.addEventListener("load", () => to(f, { type: "layout", insets: { top: 0, right: 0, bottom: 0, left: 0 }, chrome: "host", title: "shown", caps: { geolocation: true, location: "host" }, theme: "light" }));
addEventListener("message", (e) => {
  if (e.origin !== SITE || !e.data || e.data.source !== "instafy-bind") return;
  const who = e.source === A.contentWindow ? "a" : e.source === B.contentWindow ? "b" : null, d = e.data;
  if (d.type === "layout-ack") acks[who] = d.payload;
  if (who === "a" && d.type === "view") { views.push(d); if (relay) to(B, { type: "apply-view", seq: d.seq, payload: d.payload, from: { id: "u1", name: "Kim" }, smooth: false }); }
  if (who === "a" && d.type === "tap") { taps.push(d); if (relay) to(B, { type: "apply-tap", payload: d.payload, from: { id: "u1", name: "Kim" } }); }
  if (who === "b" && d.type === "interact") { interacts.push(d); relay = false; }
  if (who === "b" && (d.type === "view" || d.type === "tap")) echo.push(d.type);
});
window.present = (on) => to(A, { type: "present", on, share: { location: false } });
</script>`);
  });
  await new Promise((resolve) => followServer.listen(0, "127.0.0.1", resolve));
  const fp = await context.newPage();
  fp.on("pageerror", (e) => errors.push(e.message));
  await fp.setViewportSize({ width: 1320, height: 720 });
  await fp.goto(`http://localhost:${followServer.address().port}/`);
  const fa = await (await fp.waitForSelector("#a")).contentFrame(), fb = await (await fp.waitForSelector("#b")).contentFrame();
  await fp.waitForFunction(() => window.acks.a && window.acks.b);
  assert.deepEqual(await fp.evaluate(() => window.acks.a.supports), ["view", "tap"]);
  await fp.evaluate(() => window.present(true));
  await fp.waitForFunction(() => window.views.length > 0);
  await fa.click("#sort-price");
  await fa.selectOption("#size", "42");
  const row30 = await fa.evaluate(() => document.querySelectorAll("#rows tr")[29].id);
  await fa.evaluate((id) => { const el = document.getElementById(id); window.scrollTo(0, el.getBoundingClientRect().top + scrollY); }, row30);
  await fb.waitForFunction(() => new URLSearchParams(location.search).get("sort") === "price" && new URLSearchParams(location.search).get("size") === "42", null, { timeout: 5000 });
  assert.match(await fb.evaluate(() => location.search), /instafy_host=studio/, "the follower keeps its own host marker");
  assert.match(await fb.textContent("#count"), /in size 42, by price/);
  // the same row at the top of the follower's window
  await fb.waitForFunction((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.abs(r.top) < 4; }, row30, { timeout: 5000 });
  // back at the top: the follower goes to the top too (the sticky header's buttons, which have ids, are never the anchor)
  await fa.evaluate(() => window.scrollTo(0, 0));
  await fb.waitForFunction(() => window.scrollY < 2, null, { timeout: 5000 });
  assert.equal((await fp.evaluate(() => window.views)).at(-1).payload.a, undefined, "no anchor at the top of the page");
  await fa.evaluate((id) => { const el = document.getElementById(id); window.scrollTo(0, el.getBoundingClientRect().top + scrollY); }, row30);
  await fb.waitForFunction((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.abs(r.top) < 4; }, row30, { timeout: 5000 });
  // a tap on the presenter's row: a ring with the presenter's name on the follower
  await fb.waitForFunction(() => !document.querySelector(".instafy-bind-ripple"), null, { timeout: 3000 }); // the sort button's ring is gone
  const row33 = await fa.evaluate(() => document.querySelectorAll("#rows tr")[32].id);
  await fa.click(`#${row33} td`);
  await fb.waitForSelector(".instafy-bind-ripple span", { state: "attached", timeout: 3000 });
  assert.equal(await fb.textContent(".instafy-bind-ripple span"), "Kim");
  assert.equal((await fp.evaluate(() => window.taps)).at(-1).payload.at.id, row33);
  // the follower never echoed, and applying was not reported as its own interaction
  assert.deepEqual(await fp.evaluate(() => [window.echo, window.interacts.length]), [[], 0]);
  // the follower scrolls with its own wheel: interact, and the presenter's next sort does not reach it
  const bb = await fp.locator("#b").boundingBox();
  await fp.mouse.move(bb.x + 300, bb.y + 300);
  await fp.mouse.wheel(0, 400);
  await fp.waitForFunction(() => window.interacts.length === 1, null, { timeout: 3000 });
  await fa.click("#sort-name");
  await fp.waitForTimeout(400);
  assert.equal(await fb.evaluate(() => new URLSearchParams(location.search).get("sort")), "price");
  assert.deepEqual(errors, []);
  console.log("browser e2e: ok");
} finally {
  await browser.close();
  staticServer?.close();
  hostServer?.close();
  followServer?.close();
  askServer?.close();
  await askBinder?.close();
  await binder.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
