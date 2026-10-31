// Follow mode in the bind client: framed by Studio, a page shares its view while
// Studio says "present" (path, query without the host's markers, hash, the row at the top of the window, scroll), a
// follower applies it (replaceState + popstate, then the same row at the top), the person's own gestures are
// "interact", taps carry the element they hit, a presenter never applies (no echo), and the viewer's position stays
// out of views. Runs the real client in a vm against a small fake DOM: a sortable, filterable table whose rows have ids.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
const SITE = "https://p-site.example";
const STUDIO = "https://studio.example";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOES = Array.from({ length: 48 }, (_, i) => ({ id: `shoe-${i + 1}`, price: 80 + ((i * 37) % 120), sizes: i % 3 ? [41, 42, 43] : [44, 45] }));

/**
 * A page running the client in a frame: a header (200 px), then a table of rows (rowH px each) built from the URL query
 * (?sort=price, ?size=42), re-rendered on popstate as a single-page app would.
 */
function page({ search = "?instafy_host=studio", innerHeight = 800, rowH = 40, config = {}, sticky = false, wide = false, htmlAttrs = null, parentOrigins = [STUDIO] } = {}) {
  const docListeners = {}, winListeners = {};
  const sent = [];
  const replaced = [];
  const parent = { postMessage(msg, origin) { sent.push({ msg: JSON.parse(JSON.stringify(msg)), origin }); } };
  const location = {
    href: `${SITE}/${search}`, origin: SITE, pathname: "/", search, hash: "",
    replace(url) { replaced.push(url); },
  };
  const appended = [];
  let rows = [];
  const win = {
    scrollY: 0, innerHeight, innerWidth: 390,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    dispatchEvent(e) { for (const fn of winListeners[e.type] || []) fn(e); return true; },
    scrollTo(o) { win.scrollY = Math.max(0, Math.min(o.top, doc.documentElement.scrollHeight - innerHeight)); },
    location,
    navigator: {},
    instafyBindConfig: { builtins: false, ...config },
  };
  win.parent = parent;
  win.getComputedStyle = (n) => ({ position: n.position || "static", overflowX: n.overflowX || "visible" });
  win.pageYOffset = 0;
  function render() {
    const q = new URLSearchParams(location.search);
    let list = SHOES.slice();
    if (q.get("size")) list = list.filter((s) => s.sizes.includes(Number(q.get("size"))));
    if (q.get("sort") === "price") list.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
    rows = list.map((s, i) => ({ id: s.id, top: 200 + i * rowH }));
  }
  // a table that scrolls sideways (wide) holds the rows; a sticky toolbar (sticky) holds a filter with an id
  const wrap = { scrollWidth: 900, clientWidth: 390, scrollLeft: 0, overflowX: "auto" };
  const el = (id, top, height, parentElement) => ({
    id, parentElement,
    getBoundingClientRect: () => ({ top: top - win.scrollY, bottom: top + height - win.scrollY, left: 0, right: 390, width: 390, height }),
    closest(sel) { return sel === "[id]" ? this : null; },
  });
  const row = (id, top) => el(id, top, rowH, wide ? wrap : undefined);
  // stuck to the window's top once the page scrolls past it (Octo's .controls{position:sticky;top:0} with #city-filter)
  const filter = () => ({ ...el("city-filter", 0, rowH), position: "sticky", getBoundingClientRect: () => ({ top: Math.max(0, 150 - win.scrollY), bottom: Math.max(0, 150 - win.scrollY) + rowH, left: 0, right: 390, width: 390, height: rowH }) });
  const doc = {
    currentScript: null,
    title: "Shoes",
    documentElement: {
      get scrollHeight() { return 200 + rows.length * rowH + 1000; },
      // <html> attributes, only when a test asks for them (the client must cope with a root that has none)
      ...(htmlAttrs ? {
        attrs: htmlAttrs,
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        hasAttribute(k) { return k in this.attrs; },
        removeAttribute(k) { delete this.attrs[k]; },
      } : {}),
    },
    body: { scrollHeight: 0, appendChild: (n) => appended.push(n) },
    head: { appendChild() {} },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    querySelectorAll: () => [...(sticky ? [filter()] : []), el("top", 0, 200), ...rows.map((r) => row(r.id, r.top))],
    getElementById(id) { if (id === "top") return el("top", 0, 200); if (sticky && id === "city-filter") return filter(); const r = rows.find((x) => x.id === id); return r ? row(r.id, r.top) : null; },
    createElement(tag) {
      const node = { tag, children: [], style: {}, textContent: "", className: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); }, remove() { node.removed = true; } };
      return node;
    },
  };
  const history = {
    state: null,
    replaceState(state, _t, url) { const u = new URL(url, location.href); location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; location.href = u.href; history.state = state; },
  };
  class PopStateEvent { constructor(type, o) { this.type = type; this.state = o && o.state; } }
  class HashChangeEvent { constructor(type) { this.type = type; } }
  win.addEventListener("popstate", render);
  // the page's clock, which a test may move forward (P.advance)
  const clock = { skew: 0 };
  class PageDate extends Date { static now() { return Date.now() + clock.skew; } }
  const context = {
    Date: PageDate,
    window: win, document: doc, location, history, navigator: win.navigator, URL, URLSearchParams, TextEncoder, PopStateEvent, HashChangeEvent,
    setTimeout: (fn, ms) => (ms >= 10000 ? { fake: true } : setTimeout(fn, ms)),
    clearTimeout: (t) => { if (!t || !t.fake) clearTimeout(t); },
    // the view poll never keeps the test process alive
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval: (t) => clearInterval(t),
    console,
    fetch: (url) => Promise.resolve(String(url).endsWith("/health") ? { ok: true, json: async () => ({ ok: true, host: "instafy-bind", intents: [], parentOrigins }) } : { ok: false, json: async () => null }),
    EventSource: undefined,
  };
  render();
  vm.runInNewContext(SOURCE, context);
  const intervals = [];
  const P = {
    win, doc, location, sent, replaced, appended, wrap, bind: win.instafyBind,
    advance(ms) { clock.skew += ms; },
    deliver(data, origin = STUDIO) { for (const fn of winListeners.message || []) fn({ data, origin, source: parent }); },
    layout() { P.deliver({ source: "instafy-host", v: 1, type: "layout", insets: { top: 36, right: 0, bottom: 68, left: 0 }, chrome: "host", title: "shown", caps: { geolocation: true, location: "host" }, theme: "light" }); },
    present(on = true, location = false) { P.deliver({ source: "instafy-host", v: 1, type: "present", on, share: { location } }); },
    apply(payload, o = {}) { P.deliver({ source: "instafy-host", v: 1, type: "apply-view", seq: o.seq ?? 1, payload, from: { id: "u1", name: "Kim" }, smooth: o.smooth ?? true }); },
    /** the page itself changes its query (a sort button): replaceState, as the cheat sheet's recipe does */
    setQuery(q) { history.replaceState(null, "", "/" + q + location.hash); render(); },
    scrollToRow(id, frac = 0) { const r = rows.find((x) => x.id === id); win.scrollY = r.top + frac * rowH; for (const fn of winListeners.scroll || []) fn({ type: "scroll" }); },
    topRow() { const r = rows.find((x) => x.top + rowH > win.scrollY); return r && { id: r.id, frac: Math.round(((win.scrollY - r.top) / rowH) * 100) / 100 }; },
    gesture(type, extra = {}) { for (const fn of docListeners[type] || []) fn({ type, isTrusted: true, ...extra }); },
    views: () => sent.filter((s) => s.msg.type === "view"),
    of: (type) => sent.filter((s) => s.msg.type === type),
    stop() { P.present(false); for (const t of intervals) clearInterval(t); },
  };
  return P;
}
async function ready(p) { await p.bind.ready; await wait(5); }

test("a page framed by an origin the binder does not list has no host: its layout, present and apply-view are ignored", async () => {
  // the preview label leaks in Origin headers, so any page could frame the preview URL; it must not become the host
  const p = page({ parentOrigins: [] });
  await ready(p);
  p.layout();
  assert.equal(p.bind.hostLayout, null);
  p.present(true, true);
  assert.equal(p.bind.view.presenting, false, "an unlisted parent cannot start presenting");
  assert.deepEqual(p.sent, [], "nothing is posted to it: no ack, no view");
  const before = p.location.search;
  p.apply({ k: "page", path: "/", q: "?sort=evil" }, { smooth: false });
  assert.equal(p.location.search, before, "an unlisted parent cannot drive the page");
  p.stop();
});

test("the layout gets an ack that offers view and tap (and no insets: Studio keeps padding the frame)", async () => {
  const p = page();
  await ready(p);
  p.layout();
  const acks = p.of("layout-ack");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].origin, STUDIO);
  assert.deepEqual(acks[0].msg, { source: "instafy-bind", v: 1, type: "layout-ack", payload: { v: 1, supports: ["view", "tap"] } });
  // view: false turns follow mode off for the page
  const off = page({ config: { view: false } });
  await ready(off);
  off.layout(); off.present();
  assert.equal(off.of("layout-ack").length, 0);
  assert.equal(off.views().length, 0);
});

// Local test, Oct 31: after a comparison card's press, Studio's "Opening …" went at the frame's load and the pane was
// empty for 2 s while the page fetched its data. A page that draws after it loads says so, and says when it has drawn.
test("a page that draws its first view after it loads lists ready in its ack, and says ready once, when it has drawn", async () => {
  const p = page();
  await ready(p);
  p.bind.drawsLater();
  p.layout();
  assert.deepEqual(p.of("layout-ack")[0].msg.payload, { v: 1, supports: ["view", "tap", "ready"] });
  assert.equal(p.of("ready").length, 0, "nothing is said before it has drawn");
  p.bind.drawn();
  p.bind.drawn();
  p.layout(); // Studio's theme changed: another layout, another ack, no second ready
  assert.deepEqual(p.of("ready").map((s) => [s.msg, s.origin]), [[{ source: "instafy-bind", v: 1, type: "ready", payload: {} }, STUDIO]]);
  p.stop();
  // drawn before the host's layout came: ready right after the ack
  const early = page({ config: { view: false } });
  await ready(early);
  early.bind.drawsLater();
  early.bind.drawn();
  assert.equal(early.sent.length, 0, "no host yet: nothing is posted");
  early.layout();
  assert.deepEqual(early.sent.map((s) => s.msg.type), ["layout-ack", "ready"]);
  assert.deepEqual(early.of("layout-ack")[0].msg.payload, { v: 1, supports: ["ready"] });
  early.stop();
});

test("auto view round trip: the presenter sorts, filters and scrolls to row 30; the follower shows the same query and row", async () => {
  const a = page({ search: "?instafy_host=studio" });
  const b = page({ search: "?instafy_host=studio", innerHeight: 600, rowH: 56 }); // a phone: other window, taller rows
  await ready(a); await ready(b);
  a.layout(); b.layout();
  a.scrollToRow("shoe-3");
  await wait(150);
  assert.equal(a.views().length, 0, "nothing goes out before present");
  a.present();
  assert.equal(a.views().length, 1, "the first view at once");
  a.setQuery("?instafy_host=studio&sort=price&size=42");
  const rowsNow = a.doc.querySelectorAll().slice(1).map((r) => r.id);
  const row30 = rowsNow[29];
  a.scrollToRow(row30, 0.5);
  await wait(150);
  const v = a.views().at(-1).msg;
  assert.equal(v.source, "instafy-bind"); assert.equal(v.type, "view"); assert.ok(v.seq >= 2);
  assert.equal(a.views().at(-1).origin, STUDIO, "only to the host that sent the layout");
  assert.equal(v.payload.k, "page");
  assert.equal(v.payload.path, "/");
  assert.equal(v.payload.q, "?sort=price&size=42", "the host's own marker is left out");
  assert.equal(v.payload.a, row30);
  assert.equal(v.payload.o, 0.5);
  assert.ok(v.payload.sy > 0 && v.payload.sy < 1);
  // Studio relays it to the follower
  b.apply(v.payload, { seq: v.seq });
  assert.equal(b.location.search, "?sort=price&size=42&instafy_host=studio", "the presenter's query, the follower's own marker kept");
  await wait(80);
  assert.deepEqual(b.topRow(), { id: row30, frac: 0.5 }, "the same row at the top, as far into it");
  // no echo: the follower sent no view and no interact; the presenter never applies
  assert.equal(b.views().length, 0);
  assert.equal(b.of("interact").length, 0);
  const before = a.location.search;
  a.apply({ k: "page", path: "/", q: "?sort=name" });
  assert.equal(a.location.search, before, "a presenting page ignores apply-view");
  // a hash-only page (no ids) follows by scroll share
  b.apply({ k: "page", path: "/", q: "?sort=price&size=42", h: "#compare", sy: 0.25 });
  await wait(80);
  assert.equal(b.location.hash, "#compare");
  assert.ok(Math.abs(b.win.scrollY - 0.25 * (b.doc.documentElement.scrollHeight - 600)) < 2);
  // another page of a multi-page site: the follower goes there
  b.apply({ k: "page", path: "/sizes.html", q: "" });
  assert.deepEqual(b.replaced, ["/sizes.html?instafy_host=studio"]);
  a.stop(); b.stop();
});

test("a presenter can't send a follower off the site: //, backslashes, tabs and newlines in the path keep it where it is", async () => {
  const b = page();
  await ready(b);
  b.layout();
  for (const path of ["/\\evil.example/login", "/\t/evil.example/login", "/\n/evil.example/x", "//evil.example/x", "/\\/evil.example", "https://evil.example/x"]) {
    // what a browser would make of it, for the record: several of these resolve to evil.example
    b.apply({ k: "page", path, q: "" }, { smooth: false });
    assert.deepEqual(b.replaced, [], `no navigation for ${JSON.stringify(path)}`);
    assert.equal(b.location.pathname, "/");
    assert.equal(b.location.origin, SITE);
  }
  assert.equal(new URL("/\\evil.example/login", SITE + "/").origin, "https://evil.example", "the attack the check stops");
  // a plain other page of the same site still works
  b.apply({ k: "page", path: "/sizes.html", q: "?a=1" }, { smooth: false });
  assert.deepEqual(b.replaced, ["/sizes.html?a=1&instafy_host=studio"]);
  b.stop();
});

test("a sticky toolbar with an id is never the anchor; at the top of the page the follower goes to the top", async () => {
  const a = page({ sticky: true }), b = page({ sticky: true, innerHeight: 600, rowH: 56 });
  await ready(a); await ready(b);
  a.layout(); b.layout();
  a.present();
  // the presenter is at the very top: the follower (scrolled down) goes to the top, not to the toolbar
  b.win.scrollY = 900;
  b.apply(a.views().at(-1).msg.payload, { smooth: false });
  await wait(80);
  assert.equal(a.views().at(-1).msg.payload.a, undefined, "no anchor at the top");
  assert.equal(b.win.scrollY, 0);
  // the presenter in the rows, with the toolbar stuck at the top of the window
  const ids = a.doc.querySelectorAll().filter((r) => /^shoe-/.test(r.id)).map((r) => r.id);
  a.scrollToRow(ids[12], 0.25);
  await wait(150);
  const v = a.views().at(-1).msg.payload;
  assert.equal(v.a, ids[12], "a row, not the stuck #city-filter");
  b.apply(v, { smooth: false });
  await wait(80);
  assert.deepEqual(b.topRow(), { id: ids[12], frac: 0.25 });
  a.stop(); b.stop();
});

test("a wide table scrolled sideways: the follower shows the same columns", async () => {
  const a = page({ wide: true }), b = page({ wide: true });
  await ready(a); await ready(b);
  a.layout(); b.layout(); a.present();
  a.wrap.scrollLeft = 255;
  a.scrollToRow("shoe-9", 0.5);
  await wait(150);
  const v = a.views().at(-1).msg.payload;
  assert.equal(v.a, "shoe-9");
  assert.equal(v.sx, 0.5);
  b.apply(v, { smooth: false });
  await wait(80);
  assert.equal(b.wrap.scrollLeft, 255);
  a.stop(); b.stop();
});

test("≤ 10 views a second while the presenter scrolls; the latest wins with a trailing send; stop ends it", async () => {
  const a = page();
  await ready(a);
  a.layout(); a.present();
  const n0 = a.views().length;
  const ids = a.doc.querySelectorAll().slice(1).map((r) => r.id);
  for (let i = 0; i < 30; i++) { a.scrollToRow(ids[i]); await wait(10); }
  await wait(150);
  const burst = a.views().slice(n0);
  assert.ok(burst.length >= 2 && burst.length <= 6, `${burst.length} views for 30 scroll events in ~0.3 s`);
  assert.equal(burst.at(-1).msg.payload.a, ids[29], "the trailing view is where the scroll stopped");
  const n1 = a.views().length;
  a.present(false);
  a.scrollToRow(ids[5]); await wait(150);
  assert.equal(a.views().length, n1);
  a.stop();
});

test("taps carry the element they hit; the follower draws a ring with the presenter's name; taps are not echoed", async () => {
  const a = page(), b = page();
  await ready(a); await ready(b);
  a.layout(); b.layout(); a.present();
  const row = a.doc.getElementById("shoe-7");
  a.gesture("click", { clientX: 195, clientY: row.getBoundingClientRect().top + 10, target: row });
  const tap = a.of("tap").at(-1).msg;
  assert.equal(tap.payload.at.id, "shoe-7");
  assert.equal(tap.payload.x, 0.5);
  assert.equal(tap.payload.at.fy, 0.25);
  a.gesture("click", { clientX: 10, clientY: 10, target: row });
  assert.equal(a.of("tap").length, 1, "≤ 5 taps a second");
  // a synthetic click is not the presenter
  await wait(220);
  a.gesture("click", { clientX: 10, clientY: 10, target: row, isTrusted: false });
  assert.equal(a.of("tap").length, 1);
  // a site marks the viewer's own position: never a tap there
  const me = { closest: (sel) => (sel === "[data-instafy-private]" ? {} : null) };
  a.gesture("click", { clientX: 10, clientY: 10, target: me });
  assert.equal(a.of("tap").length, 1);
  b.deliver({ source: "instafy-host", v: 1, type: "apply-tap", payload: tap.payload, from: { id: "u1", name: "Kim" } });
  const ring = b.appended.find((n) => n.className === "instafy-bind-ripple");
  assert.ok(ring, "a ring");
  assert.equal(ring.children.at(-1).textContent, "Kim");
  assert.equal(b.of("tap").length, 0);
  a.stop(); b.stop();
});

test("interact: only the follower's own gestures, at most every 300 ms; a smooth view in flight waits 400 ms after a touch", async () => {
  const b = page();
  await ready(b);
  b.layout();
  b.gesture("keydown", { key: "ArrowDown" });
  assert.equal(b.of("interact").length, 0, "not following: nothing to stop");
  await wait(420);
  b.apply({ k: "page", path: "/", q: "?sort=price" });
  assert.equal(b.location.search, "?sort=price&instafy_host=studio");
  b.gesture("wheel");
  assert.equal(b.of("interact").length, 1);
  assert.equal(b.of("interact")[0].origin, STUDIO);
  b.gesture("pointerdown");
  assert.equal(b.of("interact").length, 1, "throttled");
  b.gesture("keydown", { key: "\\", metaKey: true });
  b.gesture("keydown", { key: "Shift" });
  b.gesture("pointerdown", { isTrusted: false });
  // a smooth view right after the touch does not yank the page; a jump (Follow again) does
  b.apply({ k: "page", path: "/", q: "?sort=name" });
  assert.equal(b.location.search, "?sort=price&instafy_host=studio");
  b.apply({ k: "page", path: "/", q: "?sort=name" }, { smooth: false });
  assert.equal(b.location.search, "?sort=name&instafy_host=studio");
  await wait(320);
  b.gesture("touchstart");
  assert.equal(b.of("interact").length, 2);
  b.stop();
});

test("the viewer's own position stays out of views unless the presenter shares it", async () => {
  const a = page();
  await ready(a);
  a.layout();
  const pos = a.bind.location();
  await wait(5);
  const req = a.sent.find((s) => s.msg.type === "location-request");
  a.deliver({ source: "instafy-host", v: 1, type: "location", payload: { id: req.msg.payload.id, coords: { latitude: 59.32931, longitude: 18.06858, accuracy: 10 } } });
  await pos;
  a.setQuery("?instafy_host=studio&near=59.3293,18.0686&sort=distance");
  a.present();
  const v = a.views().at(-1).msg.payload;
  assert.equal(v.q, undefined, "the query with the position stays home");
  assert.deepEqual(v.withheld, ["location"]);
  assert.ok(!JSON.stringify(v).includes("59.329"));
  a.present(false);
  a.present(true, true);
  assert.equal(a.views().at(-1).msg.payload.q, "?near=59.3293,18.0686&sort=distance", "Share my location too");
  // a rounded copy (or any other form) of the position stays home too: once the page has one, its address does
  a.present(false);
  a.setQuery("?instafy_host=studio&near=59.33,18.07&sort=distance");
  a.present(true);
  assert.equal(a.views().at(-1).msg.payload.q, undefined, "?near=59.33,18.07 is the viewer, rounded");
  assert.deepEqual(a.views().at(-1).msg.payload.withheld, ["location"]);
  // ...and so does the page's own state
  a.present(false);
  a.bind.follow({ get: () => ({ cell: "u181" }) });
  a.present(true);
  assert.equal("s" in a.views().at(-1).msg.payload, false, "custom state may hold a geohash");
  // a page that says its view never holds the position shares its address again
  a.present(false);
  a.bind.follow({ get: () => ({ tab: "list" }), locationFree: true });
  a.setQuery("?instafy_host=studio&sort=distance");
  a.present(true);
  assert.equal(a.views().at(-1).msg.payload.q, "?sort=distance");
  assert.deepEqual(a.views().at(-1).msg.payload.s, { tab: "list" });
  a.bind.follow({});
  // an hour later the page still carries the position in its URL: it still stays home
  a.present(false);
  a.setQuery("?instafy_host=studio&near=59.3293,18.0686&sort=distance");
  a.advance(60 * 60 * 1000);
  a.present(true);
  const later = a.views().at(-1).msg.payload;
  assert.equal(later.q, undefined, "the guard lasts as long as the page, not ten minutes");
  assert.deepEqual(later.withheld, ["location"]);
  a.stop();
});

test("instafyBind.follow({get, apply}): a page's own state rides along; oversize parts are dropped; ≤ 2 KB", async () => {
  const a = page(), b = page();
  await ready(a); await ready(b);
  a.layout(); b.layout();
  let tab = "sizes";
  a.bind.follow({ get: () => ({ tab, open: ["shoe-2"] }) });
  const got = [];
  b.bind.follow({ apply: (s, meta) => got.push([s, meta.from && meta.from.name]) });
  a.present();
  const v = a.views().at(-1).msg.payload;
  assert.deepEqual(v.s, { tab: "sizes", open: ["shoe-2"] });
  b.apply(v);
  assert.deepEqual(got, [[{ tab: "sizes", open: ["shoe-2"] }, "Kim"]]);
  tab = "prices";
  a.bind.view.changed();
  await wait(150);
  assert.equal(a.views().at(-1).msg.payload.s.tab, "prices");
  // a huge hash goes first, the page keeps the rest
  a.setQuery("?instafy_host=studio#" + "x".repeat(3000));
  a.bind.view.changed();
  await wait(150);
  const big = a.views().at(-1).msg.payload;
  assert.equal(big.h, undefined); assert.equal(big.trimmed, true); assert.equal(big.s.tab, "prices");
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).length <= 2048);
  // the follower ignores malformed views
  const before = b.location.search;
  b.apply({ k: "map", s: "t=1" });
  b.apply({ k: "page", s: "x".repeat(3000) });
  assert.equal(b.location.search, before);
  assert.equal(got.length, 1);
  assert.equal(a.bind.view.presenting, true);
  assert.equal(b.bind.view.following, true);
  a.stop(); b.stop();
});

test("Octo is taught the recipe: the cheat sheet has the table and follow()", () => {
  const SKILLS = new URL("../../runtime-agent/assets/instafy/.agents/skills/", import.meta.url);
  const sheet = fs.readFileSync(new URL("instafy-bound-sites/references/cheatsheet.md", SKILLS), "utf8");
  const recipe = sheet.slice(sheet.indexOf("## Follow mode"), sheet.indexOf("## Commands"));
  assert.match(recipe, /history\.replaceState\(history\.state, "", location\.pathname/);
  assert.match(recipe, /addEventListener\("popstate", render\)/);
  assert.match(recipe, /<tr id="row-<slug>">/);
  assert.match(recipe, /instafyBind\.follow\(\{ get: \(\) =>/);
  assert.match(recipe, /data-instafy-private/);
  // the example it points at exists and follows the recipe
  const example = fs.readFileSync(new URL("../examples/follow-table/index.html", import.meta.url), "utf8");
  assert.match(example, /history\.replaceState\(history\.state, "", location\.pathname/);
  assert.match(example, /addEventListener\("popstate", render\)/);
  assert.match(example, /tr\.id = "row-"/);
});

test("Studio's look reaches <html>: the layout's theme sets data-theme, a shown title sets data-host-title", async () => {
  const p = page({ htmlAttrs: {} });
  await ready(p);
  const html = p.doc.documentElement.attrs;
  p.deliver({ source: "instafy-host", v: 1, type: "layout", title: "shown", theme: "dark", caps: {} });
  assert.equal(html["data-theme"], "dark");
  assert.equal(html["data-host-title"], "shown");
  p.deliver({ source: "instafy-host", v: 1, type: "layout", title: "hidden", theme: "light", caps: {} });
  assert.equal(html["data-theme"], "light", "Studio switched to light");
  assert.equal("data-host-title" in html, false, "Studio no longer shows the title, so the page shows its own");
  p.deliver({ source: "instafy-host", v: 1, type: "layout", theme: "sepia", caps: {} });
  assert.equal(html["data-theme"], "light", "an unknown theme changes nothing");
  // a layout from a frame that is not the page's host is ignored
  p.deliver({ source: "instafy-host", v: 1, type: "layout", theme: "dark", caps: {} }, "https://evil.example");
  assert.equal(html["data-theme"], "light");
  p.stop();
});

test("a page that fixed its theme (<html data-theme-fixed>) keeps it whatever Studio says", async () => {
  const p = page({ htmlAttrs: { "data-theme": "dark", "data-theme-fixed": "" } });
  await ready(p);
  p.deliver({ source: "instafy-host", v: 1, type: "layout", title: "shown", theme: "light", caps: {} });
  assert.equal(p.doc.documentElement.attrs["data-theme"], "dark");
  assert.equal(p.doc.documentElement.attrs["data-host-title"], "shown", "the title still follows Studio");
  p.stop();
});
