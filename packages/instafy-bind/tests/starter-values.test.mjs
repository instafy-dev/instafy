// The values on a page of options, as the compare and ranked starters draw them: a stated limit ("€600 or less")
// counts only a value the page shows, so a row whose price is unknown is listed apart ("Price unknown") and never
// under the limit; no cell is blank or a dash ("Unknown", "Not listed", with why); and every value cites the page it
// was read on and the day ("checked 27 Oct on maker.example"). Runs the starters' own site.js and app.js in a vm
// against a small DOM (no browser): what a row says, and in which part of the list it is.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { knownNumber } from "../src/check.mjs";

const STARTERS = new URL("../src/starters/", import.meta.url);
const SITE_JS = fs.readFileSync(new URL("site.js", STARTERS), "utf8");
const CLIENT_JS = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
const SITE = "https://site.example";
const STUDIO = "https://studio.example";
const APP = {
  compare: fs.readFileSync(new URL("compare/app.js", STARTERS), "utf8"),
  ranked: fs.readFileSync(new URL("ranked/app.js", STARTERS), "utf8"),
  blank: fs.readFileSync(new URL("blank/app.js", STARTERS), "utf8"),
};

// ---------- a small DOM: elements, text, ids, classes and attributes; selectors of one tag, class, id or attribute ----------

class Node {
  constructor() { this.childNodes = []; this.parentNode = null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...children) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const child of children) this.appendChild(child);
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value) {
    this.replaceChildren();
    if (value !== "") this.appendChild(new Text(String(value)));
  }
}
class Text extends Node {
  constructor(data) { super(); this.data = data; this.nodeType = 3; }
  get textContent() { return this.data; }
}
class Element extends Node {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.className = "";
    this.id = "";
    this.hidden = false;
    this.style = {};
    this.clientWidth = 0;
    const el = this;
    this.classList = {
      add: (...names) => { el.className = [...new Set([...el.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { el.className = el.className.split(/\s+/).filter((n) => n && !names.includes(n)).join(" "); },
      contains: (name) => el.className.split(/\s+/).includes(name),
    };
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) { return name === "id" ? this.id || null : name in this.attrs ? this.attrs[name] : null; }
  hasAttribute(name) { return this.getAttribute(name) != null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener() {}
  focus() {}
  animate() { return {}; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  getClientRects() { return []; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get nextElementSibling() { const s = this.parentNode ? this.parentNode.children : []; return s[s.indexOf(this) + 1] || null; }
  get previousElementSibling() { const s = this.parentNode ? this.parentNode.children : []; return s[s.indexOf(this) - 1] || null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) { return all(this).filter((el) => el !== this && matches(el, selector)); }
}
const all = (root) => [root, ...root.childNodes.filter((c) => c.nodeType === 1).flatMap(all)];
/** One compound selector ("main", "h1.title", ".is-selected", "#list", "[data-ref]") or a list of them ("a, button");
 *  anything else matches nothing. */
function matches(el, selector) {
  if (selector.includes(",")) return selector.split(",").some((one) => matches(el, one));
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)(#[\w-]+)?(\[[\w-]+\])?$/i.exec(selector.trim());
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const cls of m[2].split(".").filter(Boolean)) if (!el.classList.contains(cls)) return false;
  if (m[3] && el.id !== m[3].slice(1)) return false;
  if (m[4] && el.getAttribute(m[4].slice(1, -1)) == null) return false;
  return true;
}

/**
 * Runs a starter page with this data at this width; resolves with the page's document once it has drawn. `bind`:
 * the binder's client, made for the page's document; `failLoad`: the data does not load; `frames: false`: the page is
 * out of sight, so no animation frame ever comes; `host`: the binder's own client, in a frame whose host (Studio) sent
 * its layout as the frame loaded (`sent`: what the page told the host, with when and what the page showed then).
 * `dataAt` is when the data arrived: the page draws its first view right then.
 */
async function draw(starter, data, { width = 1280, search = "", bind = null, failLoad = false, frames = true, host = false } = {}) {
  const document = new Element("html");
  Object.assign(document, {
    documentElement: document,
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: (text) => new Text(String(text)),
    getElementById: (id) => all(document).find((el) => el.id === id) || null,
  });
  const body = document.appendChild(new Element("body"));
  document.body = body;
  const main = body.appendChild(new Element("main"));
  main.clientWidth = width;
  const head = main.appendChild(new Element("header"));
  for (const [tag, id, cls] of [["h1", "title", "title"], ["p", "lede", "lede"]]) {
    const el = head.appendChild(new Element(tag));
    el.id = id;
    el.className = cls;
  }
  for (const [tag, id] of [["div", "bar"], ["section", "list"], ["footer", "notes"]]) main.appendChild(new Element(tag)).id = id;
  const location = { search, pathname: "/", hash: "", href: `${SITE}/${search}`, origin: SITE };
  const listeners = {};
  const sent = [];
  const page = { document, sent, dataAt: null };
  const json = (body) => ({ ok: true, json: async () => body });
  const window = {
    document,
    location,
    history: { state: null, replaceState: (_s, _t, url) => { location.search = url.includes("?") ? "?" + url.split("?")[1] : ""; } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0", backgroundColor: "", getPropertyValue: () => "" }),
    ResizeObserver: class { observe() {} },
    // out of sight, a page gets no frames: the callback is kept and never run
    requestAnimationFrame: frames ? (fn) => setTimeout(fn, 0) : () => 0,
    fetch: async (url) => {
      if (String(url).endsWith("/__bind/health")) return json({ ok: true, host: "instafy-bind", intents: [], parentOrigins: [STUDIO] });
      if (!String(url).endsWith("data.json")) return { ok: false, status: 404, json: async () => null };
      if (failLoad) return { ok: false, status: 500, json: async () => null };
      return { ok: true, json: async () => { page.dataAt = Date.now(); return JSON.parse(JSON.stringify(data)); } };
    },
    URL, URLSearchParams, Intl, Date, Promise, TextEncoder, clearTimeout, console,
    // the client polls for records every 30 s: never in a test
    setTimeout: (fn, ms) => (ms >= 10000 ? 0 : setTimeout(fn, ms)),
    // with the binder's client, the page keeps "4 min ago" current: never in a test
    setInterval: () => 0, clearInterval: () => {},
  };
  window.window = window;
  if (host) window.parent = { postMessage: (msg) => sent.push({ at: Date.now(), type: msg.type, payload: msg.payload, shown: document.body.textContent }) };
  if (bind) window.instafyBind = bind(document);
  const context = vm.createContext(window);
  if (host) vm.runInContext(CLIENT_JS, context);
  vm.runInContext(SITE_JS, context);
  vm.runInContext(APP[starter], context);
  // the host's layout, sent as the frame loads (the client holds it until the binder says which hosts may frame it)
  const layout = { source: "instafy-host", v: 1, type: "layout", insets: { top: 0, right: 0, bottom: 0, left: 0 }, chrome: "host", title: "shown", caps: {}, theme: "dark" };
  if (host) for (const fn of listeners.message || []) fn({ data: layout, origin: STUDIO, source: window.parent });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return Object.assign(page, { site: window.site });
}
/** Waits up to `ms` for `done()`. */
async function until(done, ms) {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 5));
  return done();
}

/** The rows a page lists, by part: those within the limit and those listed apart ("Price unknown"). */
function rows(document) {
  const list = document.getElementById("list");
  const apart = list.querySelector("#group-unknown");
  const refs = (root) => root.querySelectorAll("[data-ref]").map((el) => el.getAttribute("data-ref"));
  const inApart = apart ? refs(apart) : [];
  return { within: refs(list).filter((ref) => !inApart.includes(ref)), apart: inApart, heading: apart ? apart.querySelector("h2").textContent : null };
}
const rowText = (document, ref) => document.getElementById("list").querySelectorAll("[data-ref]").find((el) => el.getAttribute("data-ref") === ref)?.textContent.replace(/\s+/g, " ") ?? null;

// Local test, Oct 31: after a comparison card's press Studio's "Opening …" went at the frame's load, and the pane
// was empty for 2 s while the page fetched its data. A starter page tells Studio, through the client, that it draws
// after it loads, and when its first view (or the notice saying why not) is on the page.
test("a starter page says it draws after it loads, and that it has drawn once its first view is on the page", async () => {
  const told = [];
  const client = (document) => ({
    on() {}, ready: new Promise(() => {}), isPending: () => false, records: () => [], expired: () => false,
    drawsLater: () => told.push("draws later"),
    drawn: () => told.push(`drawn: ${document.body.textContent}`),
  });
  await draw("blank", null, { bind: client });
  assert.equal(told.length, 2, told.join(" | "));
  assert.equal(told[0], "draws later");
  assert.match(told[1], /^drawn: .*Nothing here yet\./u);
  // data that does not load: drawn once the page says so
  told.length = 0;
  await draw("compare", null, { bind: client, failLoad: true });
  assert.equal(told.length, 2, told.join(" | "));
  assert.equal(told[0], "draws later");
  assert.match(told[1], /^drawn: .*This page couldn't load its data\./u);
  // told once: the frame came first, and the wait for a page out of sight that ends later says nothing more
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(told.length, 2, told.join(" | "));
});

// ---------- a shopping comparison under a stated limit: the live test's case, made up ----------

const DAY = "2026-10-27";
const item = (ref, name, facts, extra = {}) => ({ ref: `option:${ref}`, name, why: name, facts, ...extra });
const compareData = () => ({
  title: "Robot vacuums under €600",
  lede: "Only the Read Model is known to be under €600.",
  sort: [{ key: "price", label: "Price, low to high", dir: "asc" }],
  columns: [{ key: "price", label: "Price", type: "price" }, { key: "battery", label: "Battery", type: "text" }, { key: "suction", label: "Suction", type: "number" }],
  filter: { key: "price", max: 600, label: "€600 or less", rest: "over €600" },
  items: [
    item("read", "Read Model", {
      price: { v: "€549", src: "Shop One", url: "https://shop-one.example/read", date: DAY },
      battery: { v: "180 min", src: "Maker", url: "https://maker.example/read", date: DAY },
      suction: { v: "8,000 Pa", src: "Review Two", url: "https://review-two.example/read", date: DAY },
    }),
    item("over", "Over Model", { price: { v: "€699", src: "Shop One", url: "https://shop-one.example/over", date: DAY } }),
    // the maker's page was read and gives no price; its suction is a dash
    item("silent", "Silent Model", {
      price: { src: "Maker", url: "https://maker.example/silent", date: DAY },
      suction: { v: "—", src: "Maker", url: "https://maker.example/silent", date: DAY },
      battery: { v: "n/a", src: "Maker", url: "https://maker.example/silent", date: DAY },
    }),
    // the shop blocks automated reads: the note says so
    item("blocked", "Blocked Model", { price: { note: "shop-two.example blocks automated price checks" } }, { store: { name: "Shop Two", url: "https://shop-two.example/blocked", readable: false } }),
    // a price from memory: no page, so the page shows none and counts none
    item("remembered", "Remembered Model", { price: { v: "€399" } }),
  ],
});

// A comparison's card said "Opening …" for 15 s each time it opened in a Studio whose pane was out of sight: the page
// said it had drawn only on its next animation frame, and a page out of sight gets none. Its first view is on the page
// all the same, so it tells Studio on a 100 ms timer when no frame comes first, and once. (A browser may hold an unseen
// frame's timers for up to about a second; here timers run on time.)
test("a starter page out of sight, with no animation frames, tells its host it has drawn on a 100 ms timer", async () => {
  for (const frames of [false, true]) {
    const page = await draw("compare", compareData(), { host: true, frames, search: "?show=all" });
    assert.ok(await until(() => page.sent.some((m) => m.type === "ready"), 1000), `frames: ${frames}: no ready in 1 s`);
    const ack = page.sent.find((m) => m.type === "layout-ack");
    assert.ok(ack && ack.payload.supports.includes("ready"), `frames: ${frames}: the ack lists ready: ${JSON.stringify(ack)}`);
    const ready = page.sent.filter((m) => m.type === "ready");
    const after = ready[0].at - page.dataAt;
    // a timer's 100 ms, with room for a busy test machine
    assert.ok(after <= 250, `frames: ${frames}: ready ${after} ms after the first view`);
    assert.match(ready[0].shown, /Read Model.*Over Model/su, `frames: ${frames}: the rows were on the page when it said so`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(page.sent.filter((m) => m.type === "ready").length, 1, `frames: ${frames}: ready once`);
  }
});

test("compare: a stated limit lists only rows with a price the page shows; the rest are listed apart, never as within it", async () => {
  for (const width of [1280, 390]) {
    const { document } = await draw("compare", compareData(), { width });
    const parts = rows(document);
    assert.deepEqual(parts.within, ["option:read"], `${width}px: only the price read this turn is "€600 or less"`);
    assert.deepEqual(parts.apart, ["option:silent", "option:blocked", "option:remembered"], `${width}px: unknown prices are listed apart`);
    assert.equal(parts.heading, "Price unknown");
    assert.match(document.getElementById("group-unknown").textContent, /Not counted as €600 or less/);
    assert.match(document.getElementById("list").textContent, /1 more over €600 · Show/);
    assert.doesNotMatch(rowText(document, "option:remembered"), /399/, "a price without its page is not drawn");
  }
  // "All" is one list again, with every row
  const { document } = await draw("compare", compareData(), { search: "?show=all" });
  assert.deepEqual(rows(document), { within: ["option:read", "option:over", "option:silent", "option:blocked", "option:remembered"], apart: [], heading: null });
});

test("compare: when no row is known to fit, the page says so instead of an empty table", async () => {
  const data = compareData();
  data.items = data.items.filter((i) => !["option:read"].includes(i.ref));
  const { document } = await draw("compare", data);
  assert.deepEqual(rows(document).within, []);
  assert.match(document.getElementById("list").textContent, /None is known to be €600 or less\./);
  assert.equal(rows(document).apart.length, 3);
});

// The third 28 Oct drive: the maker's site never answered, so no value of the three models was read; the page dropped
// them all and read "No options yet". A candidate nothing could be read for stays a row: a table of unknowns, and on a
// phone a row that names what was not found, and why, once.
test("compare: candidates nothing could be read for are a table of unknowns, never \"No options yet\"", async () => {
  const data = compareData();
  data.items = ["Model One", "Model Two", "Model Three"].map((name, i) => item(`m${i + 1}`, name, { price: { note: "maker.example did not answer" } }));
  for (const width of [1280, 390]) {
    const { document } = await draw("compare", data, { width });
    const list = document.getElementById("list").textContent;
    assert.doesNotMatch(list, /No options yet/);
    assert.match(list, /None is known to be €600 or less\./);
    assert.deepEqual(rows(document).apart, ["option:m1", "option:m2", "option:m3"], `${width}px: every candidate is a row`);
    const row = rowText(document, "option:m2");
    if (width === 1280) {
      assert.match(row, /(Price u|U)nknown · maker\.example did not answer/, row);
      assert.equal((row.match(/[Uu]nknown/g) || []).length, 3, `price, battery and suction each say so: ${row}`);
    } else {
      assert.match(row, /Not found yet: Price \(maker\.example did not answer\), Battery, Suction$/, row);
      assert.doesNotMatch(row, /[Uu]nknown/, `no stack of unknowns: ${row}`);
    }
  }
});

// A comparison whose maker's site never answered: the models come only from a search result. Each row says it is not
// checked by its shape ("found": the result's site), so its page never presents a search's names as checked.
test("compare: a row only a search result names says \"Not checked\" and where it was named", async () => {
  const data = compareData();
  data.items = ["Model One", "Model Two"].map((name, i) => item(`m${i + 1}`, name, { price: { note: "maker.example did not answer" } }, { found: "reviews.example.net" }));
  data.items.push(item("read", "Read Model", { price: { v: "€549", src: "Shop One", url: "https://shop-one.example/read", date: DAY } }));
  for (const width of [1280, 390]) {
    const { document } = await draw("compare", data, { width, search: "?show=all&open=m1" });
    const named = rowText(document, "option:m1");
    assert.match(named, /Model One\s*Not checked/, `${width}px: ${named}`);
    assert.match(document.getElementById("list").textContent, /Named in a search result on reviews\.example\.net\./, `${width}px: its details name the result's site`);
    assert.doesNotMatch(rowText(document, "option:read"), /Not checked/, `${width}px: a row read on a page is not marked`);
  }
});

// The first build of a comparison whose maker's site never answered: no row, and an "unchecked" list the page did not
// show, while the reply said the page marks what is unknown. An empty page still says what was not checked.
test("compare: an empty page still lists what was not checked", async () => {
  const data = compareData();
  data.items = [];
  data.unchecked = ["The models: the maker's site did not answer"];
  const { document } = await draw("compare", data);
  assert.match(document.getElementById("list").textContent, /No options yet\./);
  const notes = document.getElementById("notes");
  assert.equal(notes.hidden, false);
  assert.match(notes.textContent, /Still to confirm\s*The models: the maker's site did not answer/);
});

test("compare: no cell is blank or a dash, and every value cites its page and day", async () => {
  const { document } = await draw("compare", compareData(), { search: "?show=all" });
  const read = rowText(document, "option:read");
  assert.match(read, /€549 · seen 27 Oct( 2026)? on shop-one\.example ↗/, read);
  assert.match(read, /180 min · checked 27 Oct( 2026)? on maker\.example ↗/, read);
  assert.match(read, /8,000 Pa · checked 27 Oct( 2026)? on review-two\.example ↗/, read);
  const silent = rowText(document, "option:silent");
  assert.doesNotMatch(silent, /—|n\/a/, `a dash is no value: ${silent}`);
  assert.equal((silent.match(/Not listed/g) || []).length, 3, `the maker's page was read and gives none of the three: ${silent}`);
  assert.match(silent, /checked 27 Oct( 2026)? on maker\.example ↗/);
  const blocked = rowText(document, "option:blocked");
  assert.match(blocked, /Unknown · shop-two\.example blocks automated price checks/, blocked);
  assert.match(blocked, /Open Shop Two ↗/);
  assert.match(blocked, /Unknown.*Unknown/, `the cells nobody filled say Unknown: ${blocked}`);
  // values read on different pages each keep their own citation: no line under the list cites one page for all
  assert.doesNotMatch(document.getElementById("list").textContent, /^Battery: |Suction: /m);
});

// A comparison of three laptops with 4 of 15 values found (each CPU, one battery). On a phone every row listed every
// column with its label and "Unknown" ("Unknown · Two independent reviews not checked"): a stack of unknowns, while the
// wide table held the same gaps tidily. A phone's row shows the values found, each with its source line, and names the
// rest once, in the columns' order; the table, the ids, the order, Details and "Still to confirm" are as they were.
const MAKER = (v, ref) => ({ v, src: "Maker", url: `https://maker.example/${ref}`, date: DAY });
const laptopsData = () => ({
  title: "Three laptops",
  lede: "The maker's site gives each CPU; battery, weight, price and reviews are not checked.",
  sort: [],
  columns: [{ key: "cpu", label: "CPU", type: "text" }, { key: "battery", label: "Battery", type: "text" }, { key: "weight", label: "Weight", type: "text" },
    { key: "price", label: "Price", type: "text" }, { key: "reviews", label: "Two independent reviews", type: "text" }],
  items: [
    item("pro", "Maker Laptop Pro", { cpu: MAKER("Chip Ultra Series 3", "pro"), battery: MAKER("Up to 20 hours (the maker's claim)", "pro/battery"),
      weight: { note: "Not checked" }, price: { note: "Not checked" }, reviews: { note: "Two independent reviews not checked" } }, { sources: [{ name: "Maker", url: "https://maker.example/pro" }] }),
    item("air", "Maker Laptop Air", { cpu: MAKER("Chip Series 3", "air"), battery: { note: "Not checked" }, weight: { note: "Not checked" },
      price: { note: "Not checked" }, reviews: { note: "Two independent reviews not checked" } }),
    item("max", "Maker Laptop Max", { cpu: MAKER("Other Chip AI 300 Series", "max"), battery: { note: "Not checked" }, weight: { note: "Not checked" },
      price: { note: "Not checked" }, reviews: { note: "Two independent reviews not checked" } }),
  ],
  unchecked: ["Battery, weight and price of the Air and the Max", "Two independent reviews for each model"],
});

test("compare on a phone: a row shows the values found with their sources and names the rest once", async () => {
  for (const width of [320, 375, 414]) {
    const { document } = await draw("compare", laptopsData(), { width });
    const list = document.getElementById("list");
    assert.equal(list.querySelectorAll("table").length, 0, `${width}px: a list, not a table`);
    const cards = list.querySelectorAll("li[data-ref]");
    assert.deepEqual(cards.map((li) => [li.id, li.getAttribute("data-ref")]), [["row-pro", "option:pro"], ["row-air", "option:air"], ["row-max", "option:max"]], `${width}px: ids and order`);
    const missing = cards.map((li) => li.querySelectorAll("p.not-found").map((p) => p.textContent));
    assert.deepEqual(missing, [
      ["Not found yet: Weight, Price, Two independent reviews"],
      ["Not found yet: Battery, Weight, Price, Two independent reviews"],
      ["Not found yet: Battery, Weight, Price, Two independent reviews"],
    ], `${width}px: one line per row names what was not found`);
    assert.doesNotMatch(list.textContent, /Unknown/, `${width}px: no stack of unknowns`);
    // the values found, each with its source line, under its column's label
    const found = (li) => (li.querySelector("dl.facts")?.children ?? []).map((d) => `${d.querySelector("dt").textContent}: ${d.querySelector("dd").textContent}`);
    assert.deepEqual(found(cards[0]).map((t) => t.replace(/ 2026 on/, " on")), [
      "CPU: Chip Ultra Series 3 · checked 27 Oct on maker.example ↗",
      "Battery: Up to 20 hours (the maker's claim) · checked 27 Oct on maker.example ↗",
    ], `${width}px: what was found, with its page and day`);
    assert.deepEqual(found(cards[2]).map((t) => t.replace(/ 2026 on/, " on")), ["CPU: Other Chip AI 300 Series · checked 27 Oct on maker.example ↗"]);
    assert.equal(cards[0].querySelectorAll("button").filter((b) => b.textContent === "Details").length, 1, `${width}px: Details stays`);
    assert.match(document.getElementById("notes").textContent, /Still to confirm\s*Battery, weight and price of the Air and the Max/);
  }
  // the wide table keeps a cell per column, and its gaps say "Unknown" as before
  const { document } = await draw("compare", laptopsData(), { width: 1280 });
  const cells = (ref) => document.querySelectorAll("tr[data-ref]").find((tr) => tr.getAttribute("data-ref") === ref).querySelectorAll("td").map((td) => td.textContent.replace(/ 2026 on/, " on"));
  assert.deepEqual(cells("option:pro").slice(1), [
    "Chip Ultra Series 3 · checked 27 Oct on maker.example ↗",
    "Up to 20 hours (the maker's claim) · checked 27 Oct on maker.example ↗",
    "Unknown", "Unknown", "Unknown · Two independent reviews not checked", "Details",
  ]);
  assert.deepEqual(cells("option:air").slice(2), ["Unknown", "Unknown", "Unknown", "Unknown · Two independent reviews not checked", ""]);
  assert.equal(document.querySelectorAll("p.not-found").length, 0, "no line of what was not found under the table");
});

test("compare on a phone: a missing value that can still be checked, opened or was looked for stays on its row", async () => {
  const data = laptopsData();
  data.columns[3] = { key: "price", label: "Price", type: "price" };
  data.sort = [{ key: "price", label: "Price, low to high", dir: "asc" }];
  data.items = [
    // one reason for two values: said once
    item("pro", "Maker Laptop Pro", { cpu: MAKER("Chip Ultra Series 3", "pro"), battery: { note: "maker.example did not answer" }, price: { v: "€1,349", src: "Shop", url: "https://shop.example/pro", date: DAY },
      weight: { note: "maker.example did not answer" } }),
    // a store that can be opened (no binder): "Price unknown · Open Shop ↗" stays on the right; notes that only say a
    // value is missing are not repeated
    item("air", "Maker Laptop Air", { cpu: MAKER("Chip Series 3", "air"), price: { note: "not read yet" }, battery: { note: "Battery not checked." }, weight: { note: "Unknown" } },
      { store: { name: "Shop", url: "https://shop.example/air", readable: true } }),
    // the maker's page was read and does not give the weight: "Not listed · checked … ↗" stays a fact
    item("max", "Maker Laptop Max", { cpu: MAKER("Other Chip AI 300 Series", "max"), weight: { src: "Maker", url: "https://maker.example/max/specs", date: DAY }, battery: { v: "85 Wh", url: "https://maker.example/max" } }),
  ];
  const { document } = await draw("compare", data, { width: 375 });
  const line = (ref) => rowText(document, ref).match(/Not found yet: .*$/)?.[0] ?? "";
  assert.equal(line("option:pro"), "Not found yet: Battery and Weight (maker.example did not answer), Two independent reviews");
  assert.equal(line("option:air"), "Not found yet: Battery, Weight, Two independent reviews");
  assert.match(rowText(document, "option:air"), /Price unknown · not read yet · Open Shop ↗/, "the store link stays on the right");
  const max = rowText(document, "option:max");
  assert.match(max, /WeightNot listed · checked 27 Oct( 2026)? on maker\.example ↗/, `a page read without it is cited: ${max}`);
  assert.match(max, /BatteryUnknown · where to check ↗/, `a value without its page keeps where to check: ${max}`);
  assert.match(max, /Not found yet: Price, Two independent reviews$/, max);
});

// A phone row folded a price into "Not found yet: Price" until the binder answered, then moved it to the right of the
// row with its store link: the row changed shape under the reader. A price whose store can be opened or checked stays
// on the row from the first view, and the link joins it there.
test("compare on a phone: a price whose store can be opened keeps its place while the binder answers", async () => {
  let answer;
  const ready = new Promise((resolve) => { answer = resolve; });
  const client = () => ({ on() {}, ready, isPending: () => false, records: () => [], expired: () => false });
  const page = await draw("compare", compareData(), { width: 375, search: "?show=all", bind: client });
  const right = () => rowText(page.document, "option:blocked");
  assert.match(right(), /Price unknown · shop-two\.example blocks automated price checks/, `on the right of the row: ${right()}`);
  assert.doesNotMatch(right(), /Not found yet:.*Price/, right());
  answer({ connected: true, names: [] });
  assert.ok(await until(() => /Open Shop Two ↗/.test(right()), 1000), `the store link joins it: ${right()}`);
  assert.match(right(), /Price unknown · shop-two\.example blocks automated price checks · Open Shop Two ↗/);
  assert.doesNotMatch(right(), /Not found yet:.*Price/, right());
});

// A check that could not read one row's store ("the store asks for a login") said why in the wide table, but a phone
// row whose store link is not https folded the price into "Not found yet: Price" and lost the reason.
test("compare on a phone: a store a check could not read keeps its reason on the row", async () => {
  const data = compareData();
  data.items = [data.items[0], item("login", "Login Model", {}, { store: { name: "Shop Three", url: "http://shop-three.example/login", readable: true } })];
  const blocked = { type: "claim", cid: "clm_login", ref: "option:login", attr: "price", value: null, status: "uncertain", basis: "live", confidence: "low",
    note: "the store asks for a login", prov: { source: "shop-three.example", lane: "local", observed_at: new Date().toISOString(), ttl_s: 3600 } };
  const client = () => ({ on() {}, ready: Promise.resolve({ connected: true, names: ["read_offer"] }), names: ["read_offer"], isPending: () => false,
    records: (ref) => (ref === "option:login" ? [blocked] : []), expired: () => false });
  for (const width of [375, 1280]) {
    const { document } = await draw("compare", data, { width, search: "?show=all", bind: client });
    const row = rowText(document, "option:login");
    assert.match(row, /(Price u|U)nknown · the store asks for a login/, `${width}px: ${row}`);
    assert.doesNotMatch(row, /Not found yet:.*Price/, `${width}px: ${row}`);
  }
});

// A column without a label (which `instafy bind check` accepts) made a phone row read "Not found yet: undefined".
test("compare on a phone: a column without a label is named by its key", async () => {
  const data = laptopsData();
  data.columns = [{ key: "cpu", label: "CPU", type: "text" }, { key: "colour", type: "text" }];
  const { document } = await draw("compare", data, { width: 375 });
  assert.match(rowText(document, "option:air"), /Not found yet: colour$/);
  assert.doesNotMatch(document.getElementById("list").textContent, /undefined/);
});

// Each redraw of a comparison (Details, Sort by, a live price, the binder's one-minute refresh) emptied the list and
// then read the page's width: measured with an empty list the page is as short as its header, so a phone reader
// scrolled down landed back at the top. The width is read while the list still holds its rows.
test("compare: a redraw reads the page's width while the list still holds its rows", async () => {
  const page = await draw("compare", laptopsData(), { width: 375 });
  const main = page.document.querySelector("main");
  const list = page.document.getElementById("list");
  const seen = [];
  Object.defineProperty(main, "clientWidth", { get: () => { seen.push(list.childNodes.length); return 375; } });
  page.site.render();
  assert.ok(seen.length > 0, "the redraw reads the width");
  assert.ok(seen.every((n) => n > 0), `the list held its rows each time the width was read: ${seen.join(", ")}`);
});

// A comparison sorted by a value no row had (every weight unknown): a phone showed "Weight unknown" on the right of
// every row, and the page's main criterion was a column of unknowns. A sort whose column no row has a value for is
// left out; one some rows have stays, with the rows without it listed last, and so does one in words.
test("compare: a sort by a column no row has a value for is left out", async () => {
  const laptop = (ref, battery, price) => item(ref, `Laptop ${ref.toUpperCase()}`, {
    cpu: { v: "8 cores", src: "Maker", url: `https://maker.example/${ref}`, date: DAY },
    weight: { note: "not on the maker's page" },
    ...(battery ? { battery: { v: battery, src: "Review", url: `https://review.example/${ref}`, date: DAY } } : {}),
    price: price ? { v: price, src: "Shop", url: `https://shop.example/${ref}`, date: DAY } : { note: "no price on the shop's page" },
  });
  const laptops = (items, sort) => ({
    title: "Laptops", lede: "", sort, items,
    columns: [{ key: "cpu", label: "CPU", type: "text" }, { key: "weight", label: "Weight", type: "text" },
      { key: "battery", label: "Battery", type: "text" }, { key: "price", label: "Price", type: "price" }],
  });
  const weight = { key: "weight", label: "Weight, light first", dir: "asc" };
  const battery = { key: "battery", label: "Battery, longest first", dir: "desc" };
  const price = { key: "price", label: "Price, low to high", dir: "asc" };
  const shownOnTheRight = (document) => document.querySelectorAll(".sortv").map((el) => el.querySelector(".v")?.textContent ?? el.textContent);

  // three laptops, no weight known: no row ends in "Weight unknown"; the row names the weight once, with why
  const three = laptops([laptop("a", "10 h", "€900"), laptop("b", "14 h", "€1,100"), laptop("c", "12 h", "€1,000")], [weight]);
  let { document } = await draw("compare", three, { width: 390 });
  assert.deepEqual(shownOnTheRight(document), [], "nothing on the right of the rows");
  assert.match(rowText(document, "option:a"), /Not found yet: Weight \(not on the maker's page\)$/);
  // a sort the rows have takes the right of each row instead
  ({ document } = await draw("compare", { ...three, sort: [weight, battery] }, { width: 390 }));
  assert.deepEqual(shownOnTheRight(document), ["10 h", "14 h", "12 h"]);

  // five laptops: "Sort by" offers only the sorts the rows have, and the first of those orders the rows
  const five = laptops([laptop("a", "10 h", "€900"), laptop("b", "14 h", "€1,100"), laptop("c", "12 h", "€1,000"),
    laptop("d", null, "€800"), laptop("e", "9 h", "€700")], [weight, battery, price]);
  ({ document } = await draw("compare", five));
  assert.deepEqual(document.getElementById("f-sort").querySelectorAll("option").map((o) => o.getAttribute("value")), ["battery", "price"]);
  assert.deepEqual(rows(document).within, ["option:b", "option:c", "option:a", "option:e", "option:d"], "longest battery first");
  assert.match(document.getElementById("list").textContent, /1 without a battery is listed last\./);
  // five laptops whose data asks for a sort, with one sort left: it still orders the rows, with no "Sort by" of one
  const byPrice = laptops([laptop("b", "14 h", "€1,100"), laptop("a", "10 h", "€900"), laptop("c", "12 h", null),
    laptop("d", null, "€800"), laptop("e", "9 h", "€700")], [price, weight]);
  ({ document } = await draw("compare", byPrice));
  assert.equal(document.getElementById("f-sort"), null, "no Sort by");
  assert.deepEqual(rows(document).within, ["option:e", "option:d", "option:a", "option:b", "option:c"], "cheapest first");
  assert.match(document.getElementById("list").textContent, /1 without a price is listed last\./);

  // a main criterion in words that the rows have stays on the right of each row
  const verdicts = {
    ...three,
    sort: [{ key: "verdict", label: "Verdict" }],
    columns: [...three.columns, { key: "verdict", label: "Verdict", type: "text" }],
    items: three.items.map((i, n) => ({ ...i, facts: { ...i.facts, verdict: { v: ["Best overall", "Best value", "Lightest"][n], src: "Review", url: `https://review.example/${n}`, date: DAY } } })),
  };
  ({ document } = await draw("compare", verdicts, { width: 390 }));
  assert.deepEqual(shownOnTheRight(document), ["Best overall", "Best value", "Lightest"]);

  // a sort written as one entry instead of a list orders nothing, and the page still draws
  ({ document } = await draw("compare", { ...three, sort: price }, { width: 390 }));
  assert.deepEqual(rows(document).within, ["option:a", "option:b", "option:c"]);
  assert.deepEqual(shownOnTheRight(document), []);

  // a price nobody has read but a store can check stays: the check's price lands where it is shown now
  const unread = laptops(["a", "b"].map((ref) => item(ref, `Laptop ${ref}`, { price: { note: "not read yet" } },
    { store: { name: "Shop", url: `https://shop.example/${ref}`, readable: true } })), [price]);
  ({ document } = await draw("compare", unread, { width: 390 }));
  assert.equal(document.querySelectorAll(".sortv").length, 2);
});

test("ranked: a stated limit lists apart the rows whose price is unknown", async () => {
  const data = {
    title: "Top three",
    lede: "Only Option A is known to be under $140.",
    filter: { key: "price", max: 140, label: "Under $140" },
    items: [
      { ref: "option:a", rank: 1, name: "Option A", price: { v: "$129", src: "Shop", url: "https://shop.example/a", date: DAY } },
      { ref: "option:b", rank: 2, name: "Option B", price: { note: "not sold online" } },
      { ref: "option:c", rank: 3, name: "Option C", price: { v: "TBD", src: "Shop", url: "https://shop.example/c", date: DAY } },
      { ref: "option:d", rank: 4, name: "Option D", price: { v: "$199", src: "Shop", url: "https://shop.example/d", date: DAY } },
    ],
  };
  const { document } = await draw("ranked", data);
  assert.deepEqual(rows(document), { within: ["option:a"], apart: ["option:b", "option:c"], heading: "Price unknown" });
  assert.match(rowText(document, "option:b"), /Price unknown · not sold online/);
  assert.doesNotMatch(rowText(document, "option:c"), /TBD/);
  assert.match(document.getElementById("list").textContent, /1 hidden · Show all/);
});

// A price as its shop writes it: German, French and Swiss shops group thousands with ".", a space or "'" and write
// cents after ",". "1.299,00 €" is over €600, never 1.299 € within it; "549,99 €" is within it, never 54,999 €.
const WRITTEN = [
  ["1.299,00 €", 1299], ["€1.099", 1099], ["1 199 €", 1199], ["1 249 €", 1249], ["1 049 €", 1049],
  ["CHF 1'299.–", 1299], ["€1,149.00", 1149], ["$1,299", 1299], ["1.299.000 Ft", 1299000], ["549,99 €", 549.99],
  ["€599.99", 599.99], ["8.000 Pa", 8000], ["6,000 Pa", 6000], ["4.6 of 5", 4.6], ["0.125 in", 0.125], ["10,5 cm", 10.5],
  ["12345.678", 12345.678], ["2 3-year plans", 2], ["180 min", 180], ["-5 °C", -5],
];

test("a price as its shop writes it is that amount: 1.299,00 € and 1 199 € are over €600, 549,99 € is within it", async () => {
  const priced = (ref, v) => item(ref, ref, { price: { v, src: "Shop", url: `https://shop.example/${ref}`, date: DAY } });
  const data = compareData();
  data.items = [priced("de", "1.299,00 €"), priced("dot", "€1.099"), priced("space", "1 199 €"), priced("narrow", "1 049 €"), priced("cents", "549,99 €"), priced("swiss", "CHF 1'299.–")];
  for (const width of [1280, 390]) {
    const { document } = await draw("compare", data, { width });
    assert.deepEqual(rows(document), { within: ["option:cents"], apart: [], heading: null }, `${width}px`);
    assert.match(document.getElementById("list").textContent, /5 more over €600 · Show/);
  }
  const ranked = { title: "Top two", lede: "", filter: { key: "price", max: 600, label: "€600 or less" }, items: [
    { ref: "option:a", rank: 1, name: "Option A", price: { v: "1.299 €", src: "Shop", url: "https://shop.example/a", date: DAY } },
    { ref: "option:b", rank: 2, name: "Option B", price: { v: "549,99 €", src: "Shop", url: "https://shop.example/b", date: DAY } },
  ] };
  assert.deepEqual(rows((await draw("ranked", ranked)).document), { within: ["option:b"], apart: [], heading: null });
  // the page and `instafy bind check` read every number the same way
  const { site } = await draw("compare", compareData());
  for (const [v, n] of WRITTEN) {
    assert.equal(site.num({ v }), n, `the page reads "${v}" as ${n}`);
    assert.equal(knownNumber({ v, src: "Shop", url: "https://shop.example/x", date: DAY }), n, `the check reads "${v}" as ${n}`);
  }
});

test("site.within: only a value the page shows is within a limit; everything unknown is 'unknown', never 'in'", async () => {
  const { site } = await draw("compare", compareData());
  const limit = { key: "price", max: 600 };
  const fact = (extra) => ({ src: "Shop", url: "https://shop.example/x", date: DAY, ...extra });
  const offer = (amount, at = new Date().toISOString()) => ({ type: "offer", ref: "option:x", price: { amount, currency: "EUR" }, prov: { observed_at: at, source: "shop.example" } });
  const claim = (status, value = null) => ({ type: "claim", ref: "option:x", attr: "price", status, value, prov: { observed_at: new Date().toISOString(), source: "shop.example" } });
  const cases = [
    ["a sourced price under the limit", fact({ v: "€549" }), "in"],
    ["a sourced price over it", fact({ v: "€699" }), "out"],
    ["exactly the limit", fact({ v: "€600" }), "in"],
    ["an estimate shown as one", { v: "about €500", est: true }, "in"],
    ["no fact at all", null, "unknown"],
    ["a page read without the price", fact({}), "unknown"],
    ["a note only", { note: "the shop blocks price checks" }, "unknown"],
    ["a dash", fact({ v: "—" }), "unknown"],
    ["n/a", fact({ v: "n/a" }), "unknown"],
    ["unknown", fact({ v: "Unknown" }), "unknown"],
    ["a price without its page", { v: "€399" }, "unknown"],
    ["text without a number", fact({ v: "ask in store" }), "unknown"],
    ["a live offer", offer(579), "in"],
    ["a check that could not read it", claim("uncertain"), "unknown"],
    ["a check that did not find it", claim("not_found"), "unknown"],
  ];
  for (const [what, value, expected] of cases) assert.equal(site.within(value, limit), expected, what);
  assert.equal(site.within(fact({ v: "€549" }), { key: "price", min: 550 }), "out", "a lower limit");
  assert.equal(site.within(fact({ v: "€549" }), null), "in", "no filter: every row is in");
  const parts = site.byFilter([{ id: 1, f: fact({ v: "€549" }) }, { id: 2, f: fact({}) }, { id: 3, f: fact({ v: "€700" }) }], limit, (r) => r.f);
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), { in: [{ id: 1, f: fact({ v: "€549" }) }], unknown: [{ id: 2, f: fact({}) }], out: [{ id: 3, f: fact({ v: "€700" }) }] });
  // the generic check reads a seed fact the way the page draws it
  for (const [what, value] of cases) if (!value || !value.prov) assert.equal(knownNumber(value), site.known(value), `check and page agree: ${what}`);
});

// A blank page wrote its cards as site.h("article", { className: "card" }, …) and its links as site.h("a", { href,
// target: "_blank", rel: "noopener" }, "Official site"). site.h read only class, id, text, attrs and on, so the cards
// were unstyled and the links plain text, while the reply said the page links to both sites.
test("site.h takes className and plain attributes, so a link is a link, and never sets what could run script", async () => {
  const { site } = await draw("blank", null);
  const errors = [];
  const listeners = [];
  const saved = { error: console.error, listen: Element.prototype.addEventListener };
  console.error = (...args) => errors.push(args.join(" "));
  Element.prototype.addEventListener = function (type, fn) { listeners.push([this.tagName, type, typeof fn]); };
  try {
    const card = site.h("article", { className: "card", "data-ref": "visit:hours" },
      site.h("a", { href: "https://shop.example/en/", target: "_blank", rel: "noopener" }, "Official site"));
    assert.equal(card.className, "card");
    assert.equal(card.getAttribute("data-ref"), "visit:hours");
    const link = card.children[0];
    assert.deepEqual([link.tagName, link.attrs.href, link.attrs.target, link.attrs.rel, link.textContent],
      ["A", "https://shop.example/en/", "_blank", "noopener", "Official site"]);
    // an address on the page itself, mail and phone; class and className together; a second argument that is a child
    assert.equal(site.h("a", { href: "#hours" }).attrs.href, "#hours");
    assert.equal(site.h("a", { href: "mailto:hello@shop.example" }).attrs.href, "mailto:hello@shop.example");
    assert.equal(site.h("a", { href: "tel:+15550100" }).attrs.href, "tel:+15550100");
    assert.equal(site.h("p", { "class": "cap", className: "trust" }).className, "cap trust");
    assert.equal(site.h("p", "Every day, 9:00–19:30").textContent, "Every day, 9:00–19:30");
    assert.deepEqual(errors, []);

    // what could run script is left out, through attrs too, and said in the console (`instafy preview check` lists it)
    const refused = [
      { href: "javascript:alert(1)" },
      { href: " JaVaScRiPt:alert(1)" },
      { attrs: { href: "javascript:alert(1)" } },
      { src: "data:text/html,<script>alert(1)</script>" },
      { onclick: "alert(1)" },
      { attrs: { onmouseover: "alert(1)" } },
      { srcdoc: "<script>alert(1)</script>" },
    ];
    for (const props of refused) {
      const el = site.h("a", props, "x");
      assert.deepEqual(Object.keys(el.attrs), [], JSON.stringify(props));
      assert.equal(el.textContent, "x");
    }
    assert.equal(errors.length, refused.length, errors.join("\n"));
    // an event takes a function: onClick works as on: {click} does
    site.h("button", { onClick: () => {}, on: { focus: () => {} } }, "Show");
    assert.deepEqual(listeners, [["BUTTON", "click", "function"], ["BUTTON", "focus", "function"]]);
  } finally {
    console.error = saved.error;
    Element.prototype.addEventListener = saved.listen;
  }
});

// site.h refused every address that was not http(s), mailto, tel or relative, through attrs too, which site.js 1.6.1
// had set: a QR code drawn from a canvas (data:image/…), a photo the person picked (blob:), a "text this plan" link
// (sms:) and an "Add to calendar" file the page made (blob: with download) lost their address.
test("site.h takes a picture or a file the page made itself and a text-message link, and still nothing that could run script", async () => {
  const { site } = await draw("blank", null);
  const errors = [];
  const saved = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const picture = "data:image/png;base64,iVBORw0KGgo=";
    const file = "blob:https://site.example/5f0c8f2e";
    assert.equal(site.h("img", { src: picture, alt: "QR code" }).attrs.src, picture);
    assert.equal(site.h("img", { attrs: { src: file } }).attrs.src, file);
    assert.equal(site.h("video", { src: file, poster: picture }).attrs.poster, picture);
    assert.equal(site.h("a", { href: "sms:+15550100?body=Plan" }, "Text it").attrs.href, "sms:+15550100?body=Plan");
    assert.equal(site.h("a", { href: file, download: "trip.ics" }, "Add to calendar").attrs.href, file);
    assert.equal(site.h("a", { attrs: { download: "trip.ics", href: file } }, "Add to calendar").attrs.href, file);
    assert.deepEqual(errors, []);
    // a page or a script by address is still left out: data: and blob: only as a picture, a video or a download
    const refused = [
      ["iframe", { src: picture }],
      ["iframe", { src: file }],
      ["object", { data: picture }],
      ["embed", { src: picture }],
      ["a", { href: "data:text/html,<script>alert(1)</script>", download: "page.html" }],
      ["a", { href: file }],
      ["img", { src: "data:text/html,<script>alert(1)</script>" }],
      ["img", { src: "javascript:alert(1)" }],
      ["a", { href: "vbscript:msgbox(1)" }],
    ];
    for (const [tag, props] of refused) {
      const el = site.h(tag, props);
      assert.equal(el.getAttribute(Object.keys(props)[0]), null, `${tag} ${JSON.stringify(props)}`);
    }
    assert.equal(errors.length, refused.length, errors.join("\n"));
  } finally {
    console.error = saved;
  }
});

// A blank page wrote site.start({ data: {}, render }): site.start took the object for the address of a data file, asked
// the site for "[object Object]", and the page showed "This page couldn't load its data" in place of what it drew.
test("site.start takes a page's data itself, as well as the address of its data file", async () => {
  APP.inline = `site.start({ data: { stops: ["Livraria Lello"] }, render: function (data) {
    document.getElementById("list").replaceChildren(site.h("h2", {}, data.stops[0]));
  } });`;
  APP.empty = `site.start({ data: {}, render: function () {
    site.head({ title: "Livraria Lello" });
    document.getElementById("list").replaceChildren(site.h("p", {}, "Every day, 9:00 AM–7:30 PM"));
  } });`;
  const errors = [];
  const saved = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const inline = await draw("inline", null);
    assert.equal(inline.document.getElementById("list").textContent, "Livraria Lello");
    const empty = await draw("empty", null);
    assert.equal(empty.document.getElementById("list").textContent, "Every day, 9:00 AM–7:30 PM");
    assert.doesNotMatch(empty.document.body.textContent, /couldn't load its data/);
    assert.deepEqual(errors, []);
  } finally {
    console.error = saved;
    delete APP.inline;
    delete APP.empty;
  }
});
