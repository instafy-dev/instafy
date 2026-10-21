// instafyBind.location(): inside Studio only Studio calls the browser's geolocation (one prompt for Instafy, and
// Studio shows which site got the position). A host whose layout says caps.location === "host" answers
// location-request messages; anywhere else the page asks navigator.geolocation itself.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
const SITE = "https://p-site.example";
const STUDIO = "https://studio.example";

/** A page running the client in a frame (or on its own), with a fake parent and a fake navigator.geolocation. */
function load({ embedded = true, search = "?instafy_host=studio", ancestor = undefined, parentOrigins = [] } = {}) {
  const listeners = {};
  const sent = [];
  const geoCalls = [];
  const geo = {
    next: null, // ({ ok, coords } | { code }) the next getCurrentPosition answer
    watches: new Map(),
    lastWatch: 0,
    getCurrentPosition(ok, fail, options) {
      geoCalls.push({ fn: "getCurrentPosition", options: { ...options } });
      const a = geo.next || { code: 2 };
      queueMicrotask(() => (a.code ? fail({ code: a.code }) : ok({ coords: a.coords, timestamp: 1000 })));
    },
    watchPosition(ok, fail, options) {
      geoCalls.push({ fn: "watchPosition", options: { ...options } });
      const id = ++geo.lastWatch;
      geo.watches.set(id, { ok, fail });
      return id;
    },
    clearWatch(id) { geoCalls.push({ fn: "clearWatch", id }); geo.watches.delete(id); },
  };
  const parent = { postMessage(msg, origin) { sent.push({ msg: JSON.parse(JSON.stringify(msg)), origin }); } };
  const location = {
    href: `${SITE}/${search}`, origin: SITE, search, hash: "", pathname: "/",
    ...(ancestor ? { ancestorOrigins: [ancestor] } : {}),
  };
  const window = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    location,
    navigator: { geolocation: geo },
  };
  window.parent = embedded ? parent : window;
  const health = { ok: true, host: "instafy-bind", intents: [], parentOrigins };
  const context = {
    window,
    document: { currentScript: null, title: "Cafés near me", createElement: () => ({ setAttribute() {}, remove() {} }), body: { appendChild() {} } },
    location,
    navigator: window.navigator,
    URL,
    // long timers (polling, the 90 s host guard) never fire here, so the test process can exit
    setTimeout: (fn, ms) => (ms >= 10000 ? { fake: true } : setTimeout(fn, ms)),
    clearTimeout: (t) => { if (!t || !t.fake) clearTimeout(t); },
    setInterval: () => 0,
    clearInterval() {},
    console,
    fetch: (url) => Promise.resolve(String(url).endsWith("/health")
      ? { ok: true, json: async () => health }
      : { ok: false, json: async () => null }),
    EventSource: undefined,
  };
  vm.runInNewContext(SOURCE, context);
  const page = {
    bind: window.instafyBind,
    sent,
    geoCalls,
    geo,
    /** a message event as the browser delivers it to the page */
    deliver(data, { origin = STUDIO, source = parent } = {}) {
      for (const fn of listeners.message || []) fn({ data, origin, source });
    },
    layout(caps = { geolocation: true, location: "host" }, opts) {
      page.deliver({ source: "instafy-host", v: 1, type: "layout", insets: { top: 0, right: 0, bottom: 0, left: 0 }, chrome: "host", title: "shown", caps, theme: "light" }, opts);
    },
    reply(type, payload, opts) { page.deliver({ source: "instafy-host", v: 1, type, payload }, opts); },
    requests: () => sent.filter((s) => s.msg.type === "location-request"),
    fire(type) { for (const fn of listeners[type] || []) fn({}); },
  };
  return page;
}

const COORDS = { latitude: 25.033, longitude: 121.565, accuracy: 30 };
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** parentOrigins arrive with the binder's health answer; host messages wait for them */
async function hosted(opts) {
  const page = load(opts);
  await tick(5);
  page.layout();
  return page;
}

test("in a host that offers location, location() asks the host at its origin and never the browser", async () => {
  const page = await hosted();
  const result = page.bind.location({ highAccuracy: true });
  await tick();
  const [req] = page.requests();
  assert.equal(req.origin, STUDIO, "posted to the host's origin, never *");
  assert.equal(req.msg.source, "instafy-bind");
  assert.equal(req.msg.v, 1);
  assert.match(req.msg.payload.id, /^loc_[a-z0-9]{6}$/);
  assert.equal(req.msg.payload.highAccuracy, true);
  assert.equal(req.msg.payload.watch, undefined);
  page.reply("location", { id: req.msg.payload.id, coords: { ...COORDS, altitude: 12 }, timestamp: 1700000000000 });
  const pos = plain(await result);
  assert.deepEqual(pos, { coords: { ...COORDS, altitude: 12, heading: null, speed: null }, timestamp: 1700000000000, via: "host" });
  assert.deepEqual(page.geoCalls, [], "navigator.geolocation is never called inside the host");
  assert.equal(plain(page.bind.hostLayout).caps.location, "host");
});

test("host answers are accepted only from the parent frame at the host's origin, for a known id", async () => {
  const page = await hosted();
  const result = page.bind.location();
  await tick();
  const id = page.requests()[0].msg.payload.id;
  page.reply("location", { id, coords: { latitude: 1, longitude: 1, accuracy: 1 } }, { origin: "https://evil.example" });
  page.reply("location", { id, coords: { latitude: 2, longitude: 2, accuracy: 1 } }, { source: {} });
  page.reply("location", { id: "loc_other", coords: { latitude: 3, longitude: 3, accuracy: 1 } });
  page.reply("location", { id, coords: { latitude: 95, longitude: 3, accuracy: 1 } }); // not a position: dropped
  // a second "host" cannot take the frame over with its own layout
  page.layout({ location: null }, { origin: "https://evil.example" });
  assert.equal(plain(page.bind.hostLayout).caps.location, "host");
  page.reply("location", { id, coords: COORDS });
  assert.deepEqual(plain(await result).coords, { ...COORDS, altitude: null, heading: null, speed: null });
});

test("a layout from an origin other than the one the browser names as the parent is ignored", async () => {
  const page = load({ ancestor: "https://studio.example" });
  await tick(5);
  page.layout(undefined, { origin: "https://other.example" });
  assert.equal(page.bind.hostLayout, null);
  page.layout();
  assert.equal(plain(page.bind.hostLayout).caps.location, "host");
  // a frame that hides its referrer reports "null": the direct parent is then trusted at its own origin
  const hidden = load({ ancestor: "null" });
  await tick(5);
  hidden.layout();
  assert.equal(plain(hidden.bind.hostLayout).caps.location, "host");
});

test("when bound.json lists parentOrigins, only those may host the page", async () => {
  const page = load({ parentOrigins: ["https://instafy.dev"] });
  await tick(5);
  page.layout();
  assert.equal(page.bind.hostLayout, null);
  page.layout(undefined, { origin: "https://instafy.dev" });
  assert.equal(plain(page.bind.hostLayout).caps.location, "host");
});

test("host errors reject with the code and a message fit to show", async () => {
  const page = await hosted();
  for (const code of ["denied", "unavailable", "timeout", "stopped", "hidden"]) {
    const result = page.bind.location();
    await tick();
    page.reply("location-error", { id: page.requests().at(-1).msg.payload.id, code });
    await assert.rejects(result, (err) => err.code === code && err.name === "LocationError" && err.message.length > 10);
  }
  const stopped = page.bind.location();
  await tick();
  page.reply("location-error", { id: page.requests().at(-1).msg.payload.id, code: "stopped" });
  await assert.rejects(stopped, { message: "Location is off for this site · turn it on in Studio's menu for this preview." });
  // Studio's "denied" means Instafy itself is blocked: the page points at Studio, not at browser settings it can't fix.
  const denied = page.bind.location();
  await tick();
  page.reply("location-error", { id: page.requests().at(-1).msg.payload.id, code: "denied" });
  await assert.rejects(denied, { code: "denied", message: "Location is blocked for Instafy. Studio shows how to turn it on." });
});

test("a host that never answers: the request times out and is withdrawn", async () => {
  const page = await hosted();
  const result = page.bind.location({ timeout: 30 });
  await assert.rejects(result, { code: "timeout" });
  const id = page.requests()[0].msg.payload.id;
  assert.deepEqual(page.sent.at(-1), { msg: { source: "instafy-bind", v: 1, type: "location-stop", payload: { id } }, origin: STUDIO });
});

test("framed by Studio, a call before the first layout waits for it instead of asking the browser", async () => {
  const page = load();
  await tick(5);
  const result = page.bind.location();
  await tick(20);
  assert.equal(page.requests().length, 0);
  page.layout();
  await tick();
  assert.equal(page.requests().length, 1);
  page.reply("location", { id: page.requests()[0].msg.payload.id, coords: COORDS });
  assert.equal((await result).via, "host");
  assert.deepEqual(page.geoCalls, []);
});

test("watch through the host: callbacks, async iteration, stop", async () => {
  const page = await hosted();
  const seen = [];
  const errors = [];
  const watch = page.bind.location({ watch: true, onPosition: (p) => seen.push(p.coords.latitude), onError: (e) => errors.push(e.code) });
  await tick();
  const [req] = page.requests();
  assert.equal(req.msg.payload.watch, true);
  assert.equal(watch.via, "host");
  const id = req.msg.payload.id;
  const iter = watch[Symbol.asyncIterator]();
  page.reply("location", { id, coords: { ...COORDS, latitude: 10 } });
  assert.equal((await iter.next()).value.coords.latitude, 10);
  page.reply("location", { id, coords: { ...COORDS, latitude: 11 } });
  page.reply("location", { id, coords: { ...COORDS, latitude: 12 } });
  assert.equal((await iter.next()).value.coords.latitude, 12, "a slow reader gets the latest position");
  assert.deepEqual(seen, [10, 11, 12]);
  assert.deepEqual(errors, []);
  const pending = iter.next();
  watch.stop();
  assert.deepEqual(plain(await pending), { done: true });
  assert.equal(watch.active, false);
  assert.deepEqual(page.sent.at(-1), { msg: { source: "instafy-bind", v: 1, type: "location-stop", payload: { id } }, origin: STUDIO });
  page.reply("location", { id, coords: COORDS });
  assert.deepEqual(seen, [10, 11, 12], "nothing after stop");
});

test("a watch ends when the host stops it or answers any error, as Studio's broker ends it", async () => {
  const page = await hosted();
  const a = page.bind.location({ watch: true });
  await tick();
  page.reply("location-stop", { id: page.requests()[0].msg.payload.id });
  assert.deepEqual(plain(await a.next()), { done: true });
  for (const code of ["stopped", "hidden", "timeout"]) {
    const errors = [];
    const b = page.bind.location({ watch: true, onError: (e) => errors.push(e.code) });
    await tick();
    const id = page.requests().at(-1).msg.payload.id;
    page.reply("location-error", { id, code });
    await assert.rejects(b.next(), { code });
    assert.deepEqual(plain(await b.next()), { done: true });
    assert.equal(b.active, false);
    assert.deepEqual(errors, [code]);
    const before = page.sent.length;
    b.stop();
    page.reply("location", { id, coords: COORDS });
    assert.equal(page.sent.length, before, "nothing to withdraw: the host already ended it");
  }
});

test("leaving the page withdraws running host watches", async () => {
  const page = await hosted();
  page.bind.location({ watch: true });
  await tick();
  const id = page.requests()[0].msg.payload.id;
  page.fire("pagehide");
  assert.deepEqual(page.sent.at(-1).msg, { source: "instafy-bind", v: 1, type: "location-stop", payload: { id } });
});

test("a host without location in its caps: the page asks navigator.geolocation", async () => {
  const page = load();
  await tick(5);
  page.layout({ geolocation: true });
  page.geo.next = { coords: COORDS };
  const pos = await page.bind.location({ highAccuracy: true, timeout: 5000 });
  assert.equal(pos.via, "browser");
  assert.equal(pos.coords.latitude, COORDS.latitude);
  assert.deepEqual(page.geoCalls, [{ fn: "getCurrentPosition", options: { enableHighAccuracy: true, timeout: 5000 } }]);
  assert.equal(page.requests().length, 0);
});

test("standalone: navigator.geolocation, with errors mapped to the same codes", async () => {
  const page = load({ embedded: false, search: "" });
  await tick(5);
  page.geo.next = { code: 1 };
  await assert.rejects(page.bind.location(), { code: "denied" });
  page.geo.next = { code: 3 };
  await assert.rejects(page.bind.location(), { code: "timeout" });
  const seen = [];
  const watch = page.bind.location({ watch: true }, (p) => seen.push(p.coords.longitude));
  await tick();
  assert.equal(watch.via, "browser");
  const [w] = page.geo.watches.values();
  w.ok({ coords: { ...COORDS, longitude: 120 }, timestamp: 5 });
  assert.deepEqual(seen, [120]);
  watch.stop();
  assert.deepEqual(page.geoCalls.at(-1), { fn: "clearWatch", id: 1 });
  // a browser error ends the watch too, and clears the browser's watch
  const failing = page.bind.location({ watch: true });
  await tick();
  page.geo.watches.get(2).fail({ code: 1 });
  await assert.rejects(failing.next(), { code: "denied" });
  assert.deepEqual(page.geoCalls.at(-1), { fn: "clearWatch", id: 2 });
  assert.equal(page.sent.length, 0, "a top-level page posts nothing");
});

test("standalone: a watch that found the person outlives a passing 'unavailable'", async () => {
  const page = load({ embedded: false, search: "" });
  await tick(5);
  page.geo.next = { code: 1 };
  await assert.rejects(page.bind.location(), { message: /browser's settings/ });
  const seen = [];
  const errors = [];
  const watch = page.bind.location({ watch: true }, (p) => seen.push(p.coords.longitude), (e) => errors.push(e.code));
  await tick();
  const [w] = page.geo.watches.values();
  w.ok({ coords: { ...COORDS, longitude: 120 }, timestamp: 5 });
  w.fail({ code: 2 });
  w.fail({ code: 3 });
  w.ok({ coords: { ...COORDS, longitude: 121 }, timestamp: 6 });
  assert.deepEqual(seen, [120, 121]);
  assert.deepEqual(errors, []);
  assert.equal(watch.active, true);
  w.fail({ code: 1 });
  assert.deepEqual(errors, ["denied"]);
  assert.equal(watch.active, false);
  // before any position, "unavailable" is the answer
  const fresh = page.bind.location({ watch: true });
  await tick();
  [...page.geo.watches.values()].at(-1).fail({ code: 2 });
  await assert.rejects(fresh.next(), { code: "unavailable" });
});
