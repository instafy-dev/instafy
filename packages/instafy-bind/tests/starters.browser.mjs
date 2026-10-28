// Browser check of the five starter pages, served by the binder in preview mode (as Studio shows them).
// Not part of `npm test` (it needs Chrome and Playwright):
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright [SHOTS=/dir] node tests/starters.browser.mjs
// For each starter, phone (390x844) and laptop (1280x800), light and dark: no sideways scroll, no console errors, at
// most one primary button, ids and data-ref on every row, plain words only. Then: query state round trips, the
// "select" command, 44 px touch targets, the five trust-line states, the missing-data notice, a page with no binder,
// and checklist ticks shared between two pages.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createBinder } from "../src/server.mjs";
import { initSite, STARTER_NAMES } from "../src/init.mjs";

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) {
  console.error("Set PLAYWRIGHT_MODULE to a playwright package folder to run this check.");
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)(modulePath);
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const BANNED = /\b(bound|intents?|lanes?|handoffs?|registry|executors?|records|basis|lens|Tune)\b/;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bind-starters-"));
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true });
const servers = [];
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

function makeSite(name, starter, mutate) {
  const dir = path.join(root, name);
  initSite(dir, { starter });
  if (mutate) {
    const file = path.join(dir, "data.json");
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const next = mutate(data, dir);
    if (next) fs.writeFileSync(file, JSON.stringify(next, null, 2));
  }
  return dir;
}
async function serve(dir, options = {}) {
  const binder = createBinder({ root: dir, port: 0, preview: true, env: {}, log: () => {}, ...options });
  await binder.listen();
  servers.push(binder);
  return binder;
}
function staticServer(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { servers.push({ close: () => new Promise((r) => server.close(r)) }); resolve(`http://127.0.0.1:${server.address().port}`); }));
}
async function open(url, { width = 390, height = 844, scheme = "light", touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon\.ico/.test(m.location().url || "")) page.errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => (document.querySelector("#list") && !document.querySelector("#list .skel-rows")) || document.querySelector(".notice.is-error"));
  await page.waitForTimeout(250);
  return page;
}
async function command(binder, name, args) {
  const response = await fetch(`${binder.url}/__bind/command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${binder.adminToken}` },
    body: JSON.stringify({ name, args }),
  });
  ok(response.ok, `command ${name} accepted`);
}
const text = (page) => page.evaluate(() => document.body.innerText);
/** Caption lines (as drawn) that start or end with the " · " separator: each visible character's box, grouped by line. */
const dotLines = (page) => page.evaluate(() => {
  const out = [];
  for (const t of document.querySelectorAll(".trust")) {
    if (!t.getClientRects().length) continue;
    const chars = [];
    const walk = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (let i = 0; i < n.data.length; i++) {
        if (/\s/.test(n.data[i])) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
        const box = r.getBoundingClientRect();
        if (box.width || box.height) chars.push({ c: n.data[i], top: Math.round(box.top), left: box.left });
      }
    }
    const byLine = new Map();
    for (const ch of chars) { const k = [...byLine.keys()].find((y) => Math.abs(y - ch.top) <= 3) ?? ch.top; (byLine.get(k) || byLine.set(k, []).get(k)).push(ch); }
    for (const line of byLine.values()) {
      line.sort((a, b) => a.left - b.left);
      const s = line.map((x) => x.c).join("");
      if (/^·|·$/.test(s)) out.push(`${t.innerText.replace(/\s+/g, " ")} [line: ${s}]`);
    }
  }
  return out;
});

// local store pages for the live price checks (the binder runs with allowLocal for this test only)
const store = http.createServer(async (req, res) => {
  if (req.url === "/robots.txt") { res.writeHead(404); return res.end(); }
  if (req.url.startsWith("/slow")) await new Promise((r) => setTimeout(r, 2500));
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "A", offers: { "@type": "Offer", price: "139.00", priceCurrency: "USD" } })}</script></head><body>A</body></html>`);
});
await new Promise((r) => store.listen(0, "127.0.0.1", r));
const STORE = `http://127.0.0.1:${store.address().port}`;

try {
  // ---------- 1. every starter, two sizes, two schemes ----------
  for (const starter of STARTER_NAMES) {
    const binder = await serve(makeSite(`example-${starter}`, starter));
    for (const [width, height, size] of [[390, 844, "phone"], [1280, 800, "laptop"]]) {
      for (const scheme of ["light", "dark"]) {
        const page = await open(`${binder.url}/`, { width, height, scheme });
        const where = `${starter} ${size} ${scheme}`;
        await page.waitForTimeout(starter === "checklist" ? 400 : 0);
        const facts = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          primaries: document.querySelectorAll(".btn.primary").length,
          rows: [...document.querySelectorAll("[data-ref]")].map((el) => ({ id: el.id, ref: el.getAttribute("data-ref") })),
          bg: getComputedStyle(document.body).backgroundColor,
          title: document.querySelector("h1.title").textContent,
        }));
        eq(facts.overflow, 0, `${where}: no sideways scroll`);
        ok(facts.primaries <= 1, `${where}: at most one primary button`);
        if (starter !== "blank") ok(facts.rows.length >= 3, `${where}: rows`);
        for (const row of facts.rows) ok(/^(row|day|stop|item)-[a-z0-9-]+$/.test(row.id) && row.ref, `${where}: ${row.ref} has an id`);
        eq(facts.bg, scheme === "dark" ? "rgb(20, 20, 20)" : "rgb(251, 250, 247)", `${where}: the page background follows the scheme`);
        const body = await text(page);
        ok(!BANNED.test(body), `${where}: plain words (${(body.match(BANNED) || [])[0]})`);
        ok(!/(?!\u2197)\p{Extended_Pictographic}/u.test(body), `${where}: no emoji (the ↗ after a link is text)`);
        eq(page.errors, [], `${where}: no console errors`);
        // a trust line never says just "Not checked" or "Unknown" without saying what, except under a column or fact label
        const bare = await page.evaluate(() => [...document.querySelectorAll(".trust")].filter((t) => !t.closest("td, dd") && /^(Not checked|Unknown)( · (Open .+ ↗|Check price|Try again))?$/.test(t.innerText.trim())).map((t) => t.innerText));
        eq(bare, [], `${where}: every "not checked" says what`);
        eq(await dotLines(page), [], `${where}: no caption line starts or ends with a dot`);
        if (starter === "ranked" && size === "phone") {
          const heights = await page.evaluate(() => ["row-option-a", "row-option-b"].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height)));
          ok(heights.every((px) => px <= 112), `${where}: a ranked row is compact (${heights.join(", ")} px)`);
          ok(await page.locator("#row-option-a .name-line .more-btn").count() === 1, `${where}: Details sits on the name line`);
        }
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${starter}-${size}-${scheme}.png`), fullPage: true });
        await page.context().close();
      }
    }
    // Studio's dark theme wins over a light OS, and a fixed page keeps its own
    const page = await open(`${binder.url}/`, { scheme: "light" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    eq(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(20, 20, 20)", `${starter}: data-theme=dark`);
    eq(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), "#141414", `${starter}: the browser bar follows`);
    await page.context().close();
  }

  // ---------- 2. compare: query state, select, trust states, the row's one action ----------
  const compareDir = makeSite("compare-live", "compare", (data, dir) => {
    data.filter = { key: "price", max: 140, label: "Under $140", rest: "over $140" };
    data.sort.push({ key: "warranty", label: "Warranty", dir: "asc" });
    data.items[0].store = { name: "Example Store", url: `${STORE}/slow-a`, readable: true };        // checks live (slowly)
    data.items[1].store = { name: "Example Store", url: `${STORE}/slow-b`, readable: true };        // has an old record (checks slowly)
    data.items.push({ ref: "option:option-d", name: "Option D", why: "Not checked yet", facts: {}, store: { name: "Shop D", url: "https://example.com/d", readable: true } });
    data.items.push({ ref: "option:option-e", name: "Option E", why: "Its store link is broken", facts: { price: { v: "$150", src: "Example Store", url: "https://example.com/e", date: "2026-10-17" } }, store: { name: "Shop E", url: "not a web address", readable: true } });
    const old = new Date(Date.now() - 3 * 86400_000).toISOString();
    fs.mkdirSync(path.join(dir, "data/records"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data/records/read_offer.json"), JSON.stringify({ schema: "instafy.records@1", records: [
      { type: "offer", oid: "off_b", ref: "option:option-b", seller: { name: "Example Store" }, price: { amount: 160, currency: "USD" }, basis: "live",
        prov: { source: "example.com", lane: "local", url: "https://example.com/option-b", observed_at: old, ttl_s: 3600 } },
      { type: "claim", cid: "clm_d", ref: "option:option-d", attr: "price", value: null, status: "uncertain", basis: "live", confidence: "low", note: "the store asks for a login",
        prov: { source: "example.com", lane: "local", observed_at: new Date().toISOString(), ttl_s: 3600 } },
    ] }));
    return data;
  });
  const compare = await serve(compareDir, { allowLocal: true });
  {
    const page = await open(`${compare.url}/?sort=weight&open=option-a&show=all`, { width: 1280, height: 800 });
    eq(await page.inputValue("#f-sort"), "weight", "?sort round-trips (5 options: the Sort by select shows)");
    ok(await page.locator("#row-option-a + tr.more-row .more").count() === 1, "?open shows that row's details");
    await page.selectOption("#f-sort", "rating");
    ok(/sort=rating/.test(page.url()), "a new sort goes into the query");
    await page.selectOption("#f-sort", "price");
    // the trust-line states, worded the same everywhere: "value · source ↗ · age"
    // a cell's caption parts sit on their own lines (no dots drawn); read them back as one trust line
    const cellText = async (id, col) => (await page.locator(`#${id} td`).nth(col).innerText()).split("\n").map((t) => t.trim().replace(/^· /, "")).filter(Boolean).join(" · ");
    ok(/^\$160 · at Example Store ↗ · checked \d+ \w+ · may have changed$/.test(await cellText("row-option-b", 1)), `old: ${await cellText("row-option-b", 1)}`);
    ok(await page.locator("#row-option-b .trust.is-old").count() === 1, "old values are muted");
    eq(await cellText("row-option-d", 1), "Unknown · the store asks for a login · Open Shop D ↗", "a store that could not be read: one row, so the reason stays on it, and the link names the store");
    ok(/^about 9\.5 oz · Estimate · how ↗$/.test(await cellText("row-option-b", 2)), `estimate: ${await cellText("row-option-b", 2)}`);
    eq(await cellText("row-option-e", 1), "$150 · seen 17 Oct on example.com ↗", "a price from another page: seen, on that page's host");
    eq(await page.locator(".btn.primary").innerText(), "Check all prices");
    // with "Check all prices" a row has no button of its own
    eq(await page.locator("tbody button", { hasText: /Check price/ }).count(), 0, "no per-row Check price next to Check all prices");
    // live check: the value stays and says "Checking…", rows keep their order until every check is done
    const order = () => page.evaluate(() => [...document.querySelectorAll("tbody tr[data-ref]")].map((r) => r.id));
    const before = await order();
    await page.locator(".btn.primary").click();
    await page.waitForFunction(() => /Checking…/.test(document.querySelector("#row-option-a td:nth-child(2)").innerText), null, { timeout: 10000 });
    // the value keeps its caption and adds "Checking…"; an old price stays muted and still says it may have changed
    eq(await cellText("row-option-a", 1), "$145 · at Example Store ↗ · seen 17 Oct · Checking…", "pending keeps the value and its caption");
    ok(/^\$160 · at Example Store ↗ · checked \d+ \w+ · may have changed · Checking…$/.test(await cellText("row-option-b", 1)), `pending keeps an old price muted: ${await cellText("row-option-b", 1)}`);
    eq(await page.locator("#row-option-b .trust.is-old").count(), 1, "an old price stays muted while it is checked");
    eq(await page.locator(".btn.primary").innerText(), "Checking…", "the primary button says Checking…");
    await page.waitForFunction(() => /checked just now/.test(document.querySelector("#row-option-b td:nth-child(2)").innerText), null, { timeout: 15000 });
    eq(await order(), before, "rows do not move while a check is still running");
    await page.waitForFunction(() => /checked just now/.test(document.querySelector("#row-option-a td:nth-child(2)").innerText), null, { timeout: 15000 });
    // (the local store is http, so it is not linked; an https store ends in " ↗")
    eq(await cellText("row-option-a", 1), "$139 · at Example Store · checked just now", "live");
    // couldn't check: the row says why and offers "Try again"; no generic toast
    await page.waitForFunction(() => /Couldn't check/.test(document.querySelector("#row-option-e td:nth-child(2)").innerText), null, { timeout: 15000 });
    ok(/Couldn't check · the store link is not a web address · Try again/.test(await cellText("row-option-e", 1)), `couldn't check: ${await cellText("row-option-e", 1)}`);
    ok(await page.locator("#row-option-e .trust .err svg.icon").count() === 1, "the one danger icon");
    eq(await page.locator(".instafy-bind-toast").count(), 0, "no generic toast");
    // only a failed row is left: it has its own "Try again", so the page has no second way to retry
    eq(await page.locator(".btn.primary").count(), 0, "no Check all prices when only failed rows are left");
    eq(await page.locator("#row-option-e .link-btn", { hasText: "Try again" }).count(), 1, "the failed row keeps its Try again");
    // the select command scrolls to the row, marks it and opens its details
    await page.evaluate(() => window.scrollTo(0, 0));
    await command(compare, "select", { ref: "option:option-d" });
    await page.waitForFunction(() => document.querySelector("#row-option-d.is-selected"));
    ok(/open=option-d/.test(page.url()), "select opens the row (in the query)");
    eq(await page.locator("#row-option-d svg.icon.sel").count(), 0, "the selected row is tinted, with no check mark (it would read as recommended)");
    await command(compare, "highlight", { refs: ["option:option-a"], ms: 4000 });
    await page.waitForFunction(() => document.querySelector("#row-option-a").getAnimations().length === 1);
    ok(true, "highlight fades the row");
    await page.locator("#f-sort").focus();
    // (the second press asked the failed row again at once: the binder's cooldown answers 429, which the row says)
    eq(page.errors, [], "compare: no console errors");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "compare-states-laptop.png"), fullPage: true });
    await page.context().close();

    // phone: one list, the same ids, the sorted value once (on the right), the filter and the hidden line
    const phone = await open(`${compare.url}/`, { width: 390, height: 844 });
    ok(await phone.locator("ol.list.cards > li#row-option-b").count() === 1, "phone shows one list with the same ids");
    const dts = await phone.locator("#row-option-b dt").allInnerTexts();
    ok(!dts.includes("Price"), `the sorted column is not repeated in the facts (${dts.join(", ")})`);
    ok(await phone.locator("#row-option-b .sortv .trust .v").count() === 1, "the sorted value sits on the right with its caption");
    ok(await phone.locator('.seg input[value="fit"]:checked').count() === 1, "the stated constraint is on");
    ok(/\d more over \$140 · Show/.test(await text(phone)), "hidden rows leave one line");
    await phone.locator(".link-btn", { hasText: "Show" }).click();
    ok(/show=all/.test(phone.url()), "Show all goes into the query");
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, "compare-states-phone.png"), fullPage: true });
    await phone.context().close();
    // reduced motion: no fade, but the row chat pointed at is still marked
    const still = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const sp = await still.newPage();
    await sp.goto(`${compare.url}/?show=all`);
    await sp.waitForSelector("#row-option-a");
    await command(compare, "highlight", { refs: ["option:option-a"], ms: 3000 });
    await sp.waitForFunction(() => document.querySelector("#row-option-a.is-highlighted"), null, { timeout: 5000 });
    ok(true, "highlight without motion marks the row");
    await still.close();
  }

  // ---------- 2b. stores that block checks: the reason once, each row "Open store ↗", no primary button ----------
  {
    const dir = makeSite("compare-blocked", "compare", (data, d) => {
      data.items[0].store = { name: "Example Store", url: "https://example.com/option-a", readable: true };
      data.items[1].store = { name: "Example Store", url: "https://example.com/option-b", readable: true };
      const now = new Date().toISOString();
      fs.mkdirSync(path.join(d, "data/records"), { recursive: true });
      fs.writeFileSync(path.join(d, "data/records/read_offer.json"), JSON.stringify({ schema: "instafy.records@1", records: ["option:option-a", "option:option-b"].map((ref, i) => (
        { type: "claim", cid: "clm_" + i, ref, attr: "price", value: null, status: "uncertain", basis: "live", confidence: "low", note: "example.com blocks automated price checks",
          prov: { source: "example.com", lane: "local", observed_at: now, ttl_s: 3600 } })) }));
      return data;
    });
    const binder = await serve(dir);
    for (const [width, label] of [[1280, "table"], [390, "phone"]]) {
      const page = await open(`${binder.url}/`, { width, height: 800 });
      eq(await page.locator(".btn.primary").count(), 0, `${label}: no "Check all prices" once the stores are blocked`);
      eq(await page.locator(".notice", { hasText: "Example.com blocks automated price checks. Open a store to see today's price." }).count(), 1, `${label}: the reason is said once`);
      for (const id of ["row-option-a", "row-option-b"]) {
        const row = (await page.locator(`#${id}`).innerText()).replace(/\n/g, " ");
        ok(!/blocks/.test(row), `${label}: ${id} does not repeat the reason`);
        ok(/Open Example Store ↗/.test(row), `${label}: ${id} links its store, by name`);
        ok(/\$1\d\d/.test(row), `${label}: ${id} keeps its seeded price`);
        ok(!/Check price/.test(row), `${label}: ${id} does not invite another check`);
      }
      await page.context().close();
    }
  }

  // ---------- 2c. Studio's pane (955 px): no cell is taller than a value and two caption lines ----------
  {
    const binder = await serve(makeSite("compare-studio", "compare"));
    const page = await open(`${binder.url}/`, { width: 955, height: 808 });
    // a value's caption stays within two lines; a cell without a value ("Unknown · why") may use a third line instead
    const tall = await page.evaluate(() => [...document.querySelectorAll(".trust")].filter((t) => {
      const meta = t.querySelector(".meta");
      if (!meta) return false;
      return t.querySelector(".v") ? meta.getBoundingClientRect().height > 34 : meta.getBoundingClientRect().height > 50;
    }).map((t) => t.innerText));
    eq(tall, [], "no cell is taller than a value and two caption lines in Studio's pane");
    eq(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no sideways scroll in Studio's pane");
    await page.context().close();
  }

  // ---------- 2c'. long values and badges (a shopping team run): every column inside the card at 1440 and in Studio's
  // pane, and on a phone the sorted price stays inside its row ("$108.", "Check pr" were cut off) ----------
  {
    const long = "J-Frame guidance for overpronation and flexible arches, with a firmer medial post";
    const binder = await serve(makeSite("compare-long", "compare", (data) => {
      data.columns.push({ key: "approach", label: "Stability approach", type: "text" }, { key: "drop", label: "Heel drop", type: "text" });
      for (const item of data.items) {
        item.badge = "Previous generation (Arahi 8 current)";
        item.facts.approach = { v: long, src: "Runner's World", url: "https://example.com/review", date: "2026-10-19" };
        item.facts.weight = { v: "9.9 oz men's / 8.1 oz women's", src: "Running Shoes Guru", url: "https://example.com/specs", date: "2026-10-19" };
        item.facts.drop = { v: "12 mm", src: "Running Shoes Guru", url: "https://example.com/specs", date: "2026-10-19" };
      }
      return data;
    }));
    for (const [width, label] of [[1440, "laptop"], [955, "Studio's pane"]]) {
      const page = await open(`${binder.url}/`, { width, height: 900 });
      const fit = await page.evaluate(() => { const w = document.querySelector(".table-wrap"); return { hidden: w.scrollWidth - w.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
      eq(fit, { hidden: 0, page: 0 }, `${label}: every column fits the card, nothing scrolls sideways`);
      await page.context().close();
    }
    const phone = await open(`${binder.url}/`, { width: 390, height: 844 });
    const clipped = await phone.evaluate(() => [...document.querySelectorAll(".list.cards > li")].filter((li) => {
      const box = li.getBoundingClientRect();
      return [...li.querySelectorAll(".sortv, .badge")].some((el) => el.getBoundingClientRect().right > box.right + 0.5);
    }).map((li) => li.id));
    eq(clipped, [], "phone: the price and the badge stay inside every row");
    await phone.context().close();
  }

  // ---------- 2d. compare without "Sort by": the authored order holds through a check; fresh prices end the button ----------
  {
    const dir = makeSite("compare-order", "compare", (data) => {
      data.items[0].facts.price = { v: "$200", src: "Example Store", url: "https://example.com/option-a", date: "2026-10-17" };
      data.items[0].store = { name: "Example Store", url: `${STORE}/a`, readable: true };
      data.items[1].store = { name: "Example Store", url: `${STORE}/b`, readable: true };
      data.items[2].store = undefined;
      data.items[2].facts.price = { note: "not sold online" };
      return data;
    });
    const binder = await serve(dir, { allowLocal: true });
    const page = await open(`${binder.url}/`, { width: 1280, height: 800 });
    const order = () => page.evaluate(() => [...document.querySelectorAll("tbody tr[data-ref]")].map((r) => r.id));
    const authored = ["row-option-a", "row-option-b", "row-option-c"];
    eq(await page.locator("#f-sort").count(), 0, "3 options: no Sort by");
    eq(await order(), authored, "without Sort by the rows keep the order of data.json ($200 before $129)");
    ok(!/listed last/.test(await text(page)), "no line about the order nobody chose");
    await page.locator(".btn.primary", { hasText: "Check all prices" }).click();
    await page.waitForFunction(() => ["row-option-a", "row-option-b"].every((id) => /checked just now/.test(document.querySelector(`#${id} td:nth-child(2)`).innerText)), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    eq(await order(), authored, "the rows do not move when the prices come back");
    eq(await page.locator(".btn.primary").count(), 0, "every price is fresh: no Check all prices until one may have changed");
    await page.context().close();
    // ?open on a row with no details marks the row, so the link still shows something
    const shown = await open(`${binder.url}/?open=option-c`, { width: 1280, height: 800 });
    ok(await shown.locator("#row-option-c.is-selected").count() === 1, "?open on a row without details selects it");
    await shown.context().close();
  }

  // ---------- 2e. compare with Sort by: a price that may have changed never sorts first ----------
  {
    const dir = makeSite("compare-stale", "compare", (data, d) => {
      data.items.push({ ref: "option:option-d", name: "Option D", why: "Fresh", facts: { price: { v: "$150", src: "Shop", url: "https://example.com/d", date: "2026-10-17" } } });
      data.items.push({ ref: "option:option-e", name: "Option E", why: "Fresh", facts: { price: { v: "$170", src: "Shop", url: "https://example.com/e", date: "2026-10-17" } } });
      // option-b's $99 is an old live check: cheapest, but it may have changed
      fs.mkdirSync(path.join(d, "data/records"), { recursive: true });
      fs.writeFileSync(path.join(d, "data/records/read_offer.json"), JSON.stringify({ schema: "instafy.records@1", records: [
        { type: "offer", oid: "off_b", ref: "option:option-b", seller: { name: "Example Store" }, price: { amount: 99, currency: "USD" }, basis: "live",
          prov: { source: "example.com", lane: "local", url: "https://example.com/option-b", observed_at: new Date(Date.now() - 5 * 86400_000).toISOString(), ttl_s: 3600 } }] }));
      return data;
    });
    const binder = await serve(dir);
    const page = await open(`${binder.url}/`, { width: 1280, height: 800 });
    eq(await page.inputValue("#f-sort"), "price", "5 options: Sort by shows");
    eq(await page.evaluate(() => [...document.querySelectorAll("tbody tr[data-ref]")].map((r) => r.id)),
      ["row-option-a", "row-option-d", "row-option-e", "row-option-b", "row-option-c"], "fresh prices first, then the old $99, then the one without a price");
    ok(/1 without a price is listed last/.test(await text(page)), "with Sort by, the missing one is explained");
    await page.context().close();
  }

  // ---------- 2f. ranked: one source for every price is named once; an old list price says so; Details stays put ----------
  {
    const dir = makeSite("ranked-shared", "ranked", (data) => {
      data.items.forEach((item, i) => {
        item.price = { v: `$${100 + i * 10}`, src: "Review Site", url: "https://reviews.example.net/best", date: "2026-10-17", asof: "2026-08-05", list: true };
        item.sources = [{ name: "Review Site review", url: `https://reviews.example.net/item-${i}` }];
      });
      data.items[0].name = "A rather long product name that wraps";
      data.items[0].badge = "Review Site's top pick for most families";
      return data;
    });
    const binder = await serve(dir);
    const page = await open(`${binder.url}/`);
    const body = await text(page);
    ok(/List prices on Review Site ↗ · seen 5 Aug( \d{4})? · may have changed/.test(body), `one line names the list prices' source, its date and that they may have changed: ${body.match(/.*Prices.*/i)?.[0]}`);
    // a review site's list price never reads as the store's price now: each row says "list price" next to its store link
    for (const id of ["row-option-a", "row-option-b"]) ok(/^\$1\d0 · list price( · |$)/.test((await page.locator(`#${id} .trust`).innerText()).replace(/\s+/g, " ").trim()), `${id} says list price: ${await page.locator(`#${id} .trust`).innerText()}`);
    eq((body.match(/seen 5 Aug/g) || []).length, 1, "the date is said once, not on every row");
    eq(await page.locator("#row-option-a .trust.is-old").count(), 1, "an old list price is muted like an old live price");
    ok(!/as of/.test(body), "one date word: seen");
    eq((body.match(/Review Site/g) || []).length, 2, `the source is named in the shared line and the badge, not again under Sources: ${(body.match(/Review Site[^\n]*/g) || []).join(" | ")}`);
    ok(/Still to confirm/.test(body) && !/^Not checked$/m.test(body), "the footer asks to confirm, it does not say 'Not checked'");
    const geo = await page.evaluate(() => {
      const r = document.querySelector("#row-option-a");
      return { name: r.querySelector(".name").getBoundingClientRect().top, details: r.querySelector(".more-btn")?.getBoundingClientRect(), badge: r.querySelector(".badge").getBoundingClientRect().top };
    });
    ok(geo.details && Math.abs(geo.details.top + geo.details.height / 2 - (geo.name + 10)) < 12, `Details stays on the name's first line (${JSON.stringify(geo)})`);
    await page.context().close();
  }

  // ---------- 2g. review v4: one line per row source, one failed state, the list-price line, empty pages ----------
  {
    // a row whose own values all come from one other page: the cells show the values, one line cites the page
    const rows = await staticServer(makeSite("compare-row-source", "compare", (d) => {
      const lab = { src: "Lab Test", url: "https://lab.example.net/option-c", date: "2026-10-15" };
      d.items[2].facts.weight = { ...lab, v: "9.9 oz" };
      d.items[2].facts.rating = { ...lab, v: "4.1 of 5" };
      d.items[2].facts.warranty = { ...lab, v: "1 year" };
      return d;
    }));
    const page = await open(`${rows}/`, { width: 1280, height: 800 });
    eq((await page.locator("#row-option-c td").nth(2).innerText()).trim(), "9.9 oz", "the row's own source is not repeated in its cells");
    eq(await page.locator("#row-option-c .trust a", { hasText: "lab.example.net" }).count(), 0, "no per-cell links to the row's source");
    ok(/Option C \(Weight, Rating and Warranty\): checked 15 Oct on lab\.example\.net ↗/.test(await text(page)), `one line cites the row's page: ${(await text(page)).match(/Option C \(.*/)?.[0]}`);
    // values from different pages each cite their own page, even from one source: no line names a page for them all
    ok(/2 years\s+checked 17 Oct on example\.com ↗/.test(await page.locator("#row-option-a").innerText()), "Option A's warranty cites its own page");
    ok(!/^Warranty: /m.test(await text(page)), "no line under the list cites one page for values read on different pages");
    ok(!/Sources:.*Lab Test/.test(await text(page)), "a source the line under the list names is not named again under Sources");
    // the footer does not repeat what the page says, and the Details button names its row for screen readers
    eq(await page.locator("#row-option-a .more-btn").getAttribute("aria-label"), "Details for Option A", "Details names its row");
    await page.context().close();

    // a check that fails on a row with no value says so once: no "not checked" above "Couldn't check"
    const failDir = makeSite("compare-fail", "compare", (d) => {
      d.items = d.items.slice(0, 2);
      d.items[0].facts.price = { note: "not checked yet" };
      d.items[0].store = { name: "Shop", url: "not a web address", readable: true };
      d.items[1].store = { name: "Shop", url: "https://example.com/b", readable: false };
      return d;
    });
    const fb = await serve(failDir, { allowLocal: true });
    const fp = await open(`${fb.url}/`, { width: 390, height: 844 });
    await fp.locator("#row-option-a .link-btn", { hasText: "Check price" }).click();
    await fp.waitForFunction(() => /Couldn't check/.test(document.querySelector("#row-option-a").innerText), null, { timeout: 15000 });
    const failed = (await fp.locator("#row-option-a .sortv").innerText()).replace(/\s+/g, " ").trim();
    ok(/^Couldn't check · .+ Try again$/.test(failed.replace(/ · Try again$/, " Try again")) && !/not checked/i.test(failed), `one failed state: ${failed}`);
    eq(await dotLines(fp), [], "the failed state has no stray dot");
    await fp.context().close();

    // every store refuses checks and one line names the list prices: that line says where today's price is, no box
    const blocked = await staticServer(makeSite("ranked-list-blocked", "ranked", (d) => ({ ...d, items: d.items.map((item, i) => ({ ...item,
      price: { v: `$${100 + i * 10}`, src: "Review Site", url: "https://reviews.example.net/best", date: "2026-10-17", asof: "2026-08-05", list: true },
      store: { name: "Shop", url: `https://example.com/${i}`, readable: false } })) })));
    const bp = await open(`${blocked}/`);
    eq(await bp.locator(".notice").count(), 0, "no notice about checks nobody was offered");
    ok(/List prices on Review Site ↗ · seen 5 Aug( \d{4})? · may have changed\. Open a store for today's price\./.test(await text(bp)), `the list-price line says where today's price is: ${(await text(bp)).match(/List prices.*/)?.[0]}`);
    await bp.context().close();

    // an empty page: no "Ask in chat" on a shared link (no chat there), only in Studio; no footer to confirm
    const empty = await staticServer(makeSite("compare-empty", "compare", (d) => ({ ...d, items: [] })));
    const ep = await open(`${empty}/`);
    const shown = async () => (await ep.locator(".empty").innerText()).trim();
    eq(await shown(), "No options yet.", "a shared link says just that");
    ok(await ep.locator("#notes").isHidden(), "an empty page has nothing to confirm");
    await ep.evaluate(() => document.documentElement.setAttribute("data-host-title", "shown"));
    eq(await shown(), "No options yet. Ask in chat to add some.", "in Studio it says where to ask");
    await ep.context().close();

    // a timeline day's own note (a warning, a plan B) shows on the page as on the map
    const noted = await staticServer(makeSite("timeline-note", "timeline", (d) => { d.days[0].note = "Plan B: a slow café day."; return d; }));
    const tp = await open(`${noted}/`);
    ok(/Plan B: a slow café day\./.test(await tp.locator("#day-1").innerText()), "the day's note is on the page");
    await tp.context().close();

    // a checklist fact without a link reads like a note inside the row (one rhythm); one with a link sits under it
    const facts = await staticServer(makeSite("checklist-facts", "checklist", (d) => {
      d.groups[0].items[0].fact = { v: "Sockets are type G", src: "Wikipedia", url: "https://en.wikipedia.org/wiki/AC_power_plugs_and_sockets", date: "2026-10-17" };
      return d;
    }));
    const cp = await open(`${facts}/`, { width: 1280, height: 800 });
    await cp.waitForFunction(() => !document.querySelector("input[type=checkbox]:disabled"));
    eq(await cp.locator("#item-parking label .item-fact").count(), 1, "a fact without a link is in the row, like a note");
    const gaps = await cp.evaluate(() => {
      const gap = (item) => { const t = item.querySelector(".label-text").getBoundingClientRect(); const f = item.querySelector(".item-fact .trust").getBoundingClientRect(); return Math.round(f.top - t.bottom); };
      const linked = document.querySelector(".item:has(> .item-fact)");
      return { plain: gap(document.querySelector("#item-parking")), linked: gap(linked) };
    });
    ok(gaps.plain <= 4 && gaps.linked <= 4, `with a mouse every fact sits right under its row's title: ${JSON.stringify(gaps)}`);
    await cp.context().close();
  }

  // ---------- 2h. a stated limit counts only values the page shows: rows without one are listed apart ----------
  {
    // the live test: "under €600", every official page without a price; one shop page with one
    const dir = makeSite("compare-limit", "compare", (d, siteDir) => {
      d.filter = { key: "price", max: 600, label: "€600 or less", rest: "over €600" };
      d.items = [
        { ref: "option:read", name: "Read Model", why: "Its price was read", facts: { price: { v: "€549", src: "Shop One", url: "https://shop-one.example/read", date: "2026-10-27" }, weight: { v: "3.1 kg", src: "Maker", url: "https://maker.example/read", date: "2026-10-27" } } },
        { ref: "option:over", name: "Over Model", why: "Over the limit", facts: { price: { v: "€699", src: "Shop One", url: "https://shop-one.example/over", date: "2026-10-27" } } },
        { ref: "option:none", name: "Silent Model", why: "No price on its page", facts: { price: { src: "Maker", url: "https://maker.example/silent", date: "2026-10-27" }, weight: { v: "—", src: "Maker", url: "https://maker.example/silent", date: "2026-10-27" } } },
        { ref: "option:blocked", name: "Blocked Model", why: "Its shop blocks checks", facts: { price: { note: "shop-two.example blocks automated price checks" } }, store: { name: "Shop Two", url: "https://shop-two.example/blocked", readable: false } },
        { ref: "option:nosrc", name: "Unsourced Model", why: "A remembered price", facts: { price: { v: "€399" } } },
      ];
      d.sort = d.sort.slice(0, 1);
      return d;
    });
    const binder = await serve(dir);
    for (const [width, label] of [[1280, "table"], [390, "phone"]]) {
      const page = await open(`${binder.url}/`, { width, height: 900 });
      const rows = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((r) => r.id), sel);
      const within = await rows("#list [data-ref]:not(#group-unknown [data-ref])");
      const apart = await rows("#group-unknown [data-ref]");
      eq(within, ["row-read"], `${label}: only the row with a price read this turn is listed as €600 or less`);
      eq(apart, ["row-none", "row-blocked", "row-nosrc"], `${label}: the rows whose price is unknown are listed apart`);
      eq((await page.locator("#group-unknown h2").innerText()).trim(), "Price unknown", `${label}: the group says what is unknown`);
      ok(/Not counted as €600 or less/.test(await page.locator("#group-unknown").innerText()), `${label}: and that they are not counted as within the limit`);
      ok(/1 more over €600 · Show/.test(await text(page)), `${label}: the row over the limit leaves one line`);
      const none = (await page.locator("#row-none").innerText()).replace(/\s+/g, " ");
      ok(/Not listed/.test(none) && /checked 27 Oct( 2026)? on maker\.example ↗/.test(none), `${label}: a page without the price says so and cites it: ${none}`);
      ok(!/—/.test(none), `${label}: a dash is never drawn as a value: ${none}`);
      const blocked = (await page.locator("#row-blocked").innerText()).replace(/\s+/g, " ");
      ok(/(Price unknown|Unknown) · shop-two\.example blocks automated price checks/.test(blocked), `${label}: a blocked shop says why: ${blocked}`);
      ok(!/€399/.test(await page.locator("#row-nosrc").innerText()), `${label}: a price without its page is not shown, nor counted`);
      eq(page.errors, [], `${label}: no console errors`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `compare-limit-${label}.png`), fullPage: true });
      await page.locator('.seg input[value="all"]').check({ force: true });
      eq(await page.locator("#group-unknown").count(), 0, `${label}: "All" is one list`);
      eq((await rows("#list [data-ref]")).length, 5, `${label}: every row under All`);
      await page.context().close();
    }
    // every row unknown: the page says none is known to fit, and lists them apart
    const allUnknown = await staticServer(makeSite("ranked-limit", "ranked", (d) => ({ ...d, filter: { key: "price", max: 140, label: "Under $140" },
      items: d.items.map((i) => ({ ...i, price: { note: "not sold online" } })) })));
    const rp = await open(`${allUnknown}/`);
    ok(/None is known to be under \$140\./.test(await text(rp)), "ranked: no row is called within the limit");
    eq(await rp.locator("#group-unknown [data-ref]").count(), 3, "ranked: every row is listed apart");
    ok(/Price unknown · not sold online/.test((await rp.locator("#group-unknown").innerText()).replace(/\s+/g, " ")), "ranked: each says why");
    if (SHOTS) await rp.screenshot({ path: path.join(SHOTS, "ranked-limit-phone.png"), fullPage: true });
    eq(rp.errors.filter((e) => !/404|Failed to load resource/.test(e)), [], "ranked limit: no script errors (no binder here)");
    await rp.context().close();
  }

  // ---------- 3. touch targets (coarse pointer) on every starter ----------
  for (const starter of STARTER_NAMES) {
    const binder = await serve(makeSite(`touch-${starter}`, starter, starter === "checklist" ? (d) => ({ ...d, people: ["Ana", "Ben"] }) : null));
    const page = await open(`${binder.url}/`, { touch: true });
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "touch emulation gives a coarse pointer");
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("a, button, select, input, summary")) {
        const target = el.matches("input[type=checkbox]") ? el.closest("label") : el;
        const r = target.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName} "${(el.textContent || el.value || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    eq(small, [], `${starter}: every touch target is at least 44 px`);
    if (starter === "checklist") {
      await page.locator(".bar button", { hasText: "I'm Ana" }).click();
      await page.waitForSelector("#item-book-room");
      const hit = await page.evaluate(() => {
        const t = document.querySelector("#item-book-room .label-text").getBoundingClientRect();
        const el = document.elementFromPoint(t.left + t.width / 2, t.bottom - 1);
        return el.closest("label.check") ? "label" : el.tagName;
      });
      eq(hit, "label", "checklist: tapping the item text ticks it (the fact's link is outside the row)");
      // no point of a checkbox row opens a link: a fact's grown link target stays below the row's own target
      const links = await page.evaluate(() => {
        const out = [];
        for (const label of document.querySelectorAll("label.check")) {
          const r = label.getBoundingClientRect();
          for (let y = r.top + 1; y < r.bottom; y += 3) for (let x = r.left + 2; x < r.right; x += 20) {
            const el = document.elementFromPoint(x, y);
            if (el && el.closest("a, button")) out.push(`${label.textContent.trim().slice(0, 20)} @${Math.round(y - r.top)}`);
          }
        }
        return [...new Set(out)];
      });
      eq(links, [], "checklist: a tap anywhere on a checkbox row ticks it, never opens a link");
    }
    await page.context().close();
  }

  // ---------- 4. ranked, timeline, checklist query state ----------
  {
    const ranked = await serve(makeSite("ranked-q", "ranked", (d) => ({ ...d, filter: { key: "price", max: 140, label: "Under $140" } })));
    const page = await open(`${ranked.url}/?open=option-b`);
    ok(await page.locator("#row-option-b .more").count() === 1, "ranked ?open");
    ok(/1 hidden · Show all/.test(await text(page)), "ranked hidden line");
    ok(await page.locator("#row-option-a").count() === 0 && (await page.locator(".rank").first().innerText()) === "2", "ranks never renumber");
    await page.locator("#row-option-c .btn.quiet", { hasText: "Details" }).click();
    ok(/open=option-c/.test(page.url()), "Details goes into the query");
    ok(/Our pick/.test(await text(await open(`${ranked.url}/?show=all`))), "the badge the data names shows");
    const nobadge = await serve(makeSite("ranked-nobadge", "ranked", (d) => ({ ...d, items: d.items.map((i) => ({ ...i, badge: undefined })) })));
    eq(await (await open(`${nobadge.url}/`)).locator(".badge").count(), 0, "no badge is added by itself");
    await page.context().close();

    const days = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, date: `2026-11-0${i + 1}`, place: `Place ${i + 1}`,
      stops: [{ ref: `stop:s${i + 1}a`, name: `First stop ${i + 1}` }, { ref: `stop:s${i + 1}b`, name: `Second stop ${i + 1}` }],
      legs: [{ from: `stop:s${i + 1}a`, to: `stop:s${i + 1}b`, mode: "walk", duration: { v: "10 min", est: true } }] }));
    days[3].stops[0].facts = [{ note: "opening hours", url: "https://example.com/hours" }];
    const timeline = await serve(makeSite("timeline-q", "timeline", (d) => ({ ...d, days })));
    const tl = await open(`${timeline.url}/?day=3`);
    eq(await tl.evaluate(() => [...document.querySelectorAll("section.day")].map((s) => s.id)), days.map((d) => `day-${d.n}`), "every day is listed");
    eq(await tl.evaluate(() => [...document.querySelectorAll("details.fold")].map((d) => d.open)), [false, false, true, false, false, false, false], "?day opens that day");
    ok(/(^|\n)10 min walk · Estimate/.test(await text(tl)) && !/About 10 min/.test(await text(tl)), "leg wording: the estimate is said once");
    ok(await tl.locator(".list.days > section.day").count() === 7, "the days are rows of one list");
    eq(await tl.locator("#day-4 summary .cap").innerText(), "2 stops · 1 not checked", "a folded day says it has something not checked");
    await tl.locator("#day-4 summary").click();
    ok(/Not checked · opening hours · where to check ↗/.test(await tl.locator("#stop-s4a").innerText()), "not checked, with where to check");
    await tl.locator("#day-5 summary").click();
    await tl.waitForFunction(() => /day=5/.test(location.search)); // the toggle event comes a moment later
    ok(await tl.evaluate(() => document.querySelector("#day-3 details").open), "opening a day keeps the open ones open");
    await command(timeline, "select", { ref: "stop:s6b" });
    await tl.waitForFunction(() => document.querySelector("#stop-s6b.is-selected") && document.querySelector("#day-6 details").open);
    ok(true, "select opens the stop's day");
    await tl.context().close();

    const checklist = await serve(makeSite("checklist-q", "checklist", (d) => ({ ...d, people: ["Ana", "Ben"] })));
    {
      const fresh = await open(`${checklist.url}/`);
      eq(await fresh.locator("input[type=checkbox]").count(), 0, "a per-person list shows no boxes until you say whose it is");
      ok(/Whose list is this\?/.test(await text(fresh)), "and asks whose list it is");
      eq(await fresh.locator(".bar button.btn").allInnerTexts(), ["I'm Ana", "I'm Ben"], "with one plain button per person, not an empty switch");
      eq(await fresh.locator(".seg").count(), 0, "no segmented control with nothing chosen");
      ok(await fresh.locator("#notes").isHidden(), "the notes wait for the list");
      await fresh.locator(".bar button", { hasText: "I'm Ben" }).click();
      await fresh.waitForSelector("#item-chairs");
      ok(/Ben: 0 of 7 done/.test(await text(fresh)), "the progress line names whose list it is");
      await fresh.goto(`${checklist.url}/`);
      await fresh.waitForFunction(() => /who=Ben/.test(location.search));
      ok(true, "this browser remembers the pick");
      await fresh.context().close();
    }
    const cl = await open(`${checklist.url}/?who=Ben`);
    await cl.waitForFunction(() => !document.querySelector("input[type=checkbox]:disabled"));
    ok(await cl.locator('.seg input[value="Ben"]:checked').count() === 1, "?who round-trips");
    await cl.locator("#item-chairs label").click();
    await cl.waitForFunction(() => /1 of 7 done/.test(document.body.innerText));
    await cl.locator('.seg label', { hasText: "Ana" }).click();
    ok(/who=Ana|^[^?]*$/.test(cl.url()) && /0 of 7 done/.test(await text(cl)), "each person has their own ticks");
    await cl.context().close();
  }

  // ---------- 5. checklist ticks reach a second page ----------
  {
    const sharedDir = makeSite("checklist-shared", "checklist");
    const shared = await serve(sharedDir);
    const a = await open(`${shared.url}/`);
    const b = await open(`${shared.url}/`);
    for (const p of [a, b]) await p.waitForFunction(() => !document.querySelector("input[type=checkbox]:disabled"));
    ok(!/on this device only/.test(await text(a)), "a binder shares ticks");
    // on a checklist "checked" is the tick: an unconfirmed fact says "To confirm", never "Not checked"
    eq((await a.locator("#item-parking .item-fact").innerText()).trim(), "To confirm · parking near the venue", "a fact to confirm under a tick box");
    ok(!/Not checked/.test(await text(a)), "no 'Not checked' on a checklist");
    await a.locator("#item-projector label").click();
    ok(await a.locator("#item-projector input").isChecked(), "the tick shows at once");
    await b.waitForFunction(() => document.querySelector("#item-projector input").checked, null, { timeout: 10000 });
    ok(/1 of 7 done/.test(await text(b)), "the other page counts it");
    await a.locator("#item-projector label").click();
    await b.waitForFunction(() => !document.querySelector("#item-projector input").checked, null, { timeout: 10000 });
    // a tick that does not save goes back, and the row says so with a way to try again
    const file = path.join(sharedDir, "data.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...data, groups: data.groups.map((g) => ({ ...g, items: g.items.filter((i) => i.ref !== "item:chairs") })) }));
    await a.locator("#item-chairs label").click();
    await a.waitForFunction(() => /Couldn't save · Try again/.test(document.querySelector("#item-chairs").innerText), null, { timeout: 10000 });
    ok(!(await a.locator("#item-chairs input").isChecked()), "the failed tick goes back");
    eq(await a.locator(".instafy-bind-toast").count(), 0, "no generic toast");
    fs.writeFileSync(file, JSON.stringify(data));
    await a.locator("#item-chairs .link-btn", { hasText: "Try again" }).click();
    await b.waitForFunction(() => document.querySelector("#item-chairs input").checked, null, { timeout: 10000 });
    ok(!/Couldn't save/.test(await text(a)), "Try again saves it");
    eq([...a.errors, ...b.errors], [], "checklist: no console errors");
    if (SHOTS) await b.screenshot({ path: path.join(SHOTS, "checklist-shared.png"), fullPage: true });
    await a.context().close();
    await b.context().close();
  }

  // ---------- 6. missing data, and no binder at all ----------
  {
    const broken = makeSite("broken", "ranked");
    fs.rmSync(path.join(broken, "data.json"));
    const binder = await serve(broken);
    const page = await open(`${binder.url}/`);
    ok(await page.locator(".notice.is-error", { hasText: "This page couldn't load its data. Reload to try again." }).count() === 1, "missing data shows the error notice");
    ok(await page.locator(".notice.is-error button", { hasText: "Reload" }).count() === 1, "with a Reload button");
    ok(await page.locator(".notice.is-error button.btn:not(.quiet)").count() === 1, "Reload looks like a button, not plain text");
    eq(await page.locator("h1.title").innerText(), "Top picks", "the error page keeps its title");
    await page.context().close();

    // every store blocks checks: the notice says so in plain words, once
    const allBlocked = await staticServer(makeSite("ranked-all-blocked", "ranked", (d) => ({ ...d, items: d.items.map((i) => ({ ...i, store: { ...(i.store || { name: "Shop", url: "https://example.com/x" }), readable: false } })) })));
    const ab = await open(`${allBlocked}/`);
    eq(await ab.locator(".notice").innerText(), "These stores don't allow price checks from this page. Open a store to see today's price.", "plain words, no 'automated'");
    await ab.context().close();

    const plain = await staticServer(makeSite("no-binder", "compare"));
    const off = await open(`${plain}/`, { width: 1280, height: 800 });
    const body = await text(off);
    ok(/\$145/.test(body) && /seen 17 Oct/.test(body) && /checked 17 Oct on example\.com/.test(body), "seeded values show without a binder, each citing its page");
    eq(await off.locator(".btn.primary").count(), 0, "no Check all prices without a binder");
    eq(await off.locator("button", { hasText: /Check/ }).count(), 0, "no check buttons without a binder");
    ok(await off.locator(".trust a", { hasText: /^Open .+ ↗$/ }).count() >= 1, "each row links its store instead");
    // looked for and not there is "Not listed" with where and when it was looked for; never a blank cell
    const b = await off.locator("#row-option-b").innerText();
    ok(/Not listed · checked 17 Oct( 2026)? on example\.com ↗/.test(b.replace(/\s+/g, " ").replace(/listed checked/, "listed · checked")) && !/Not checked|Unknown/.test(b), `a value the source does not give: Not listed (${b.replace(/\s+/g, " ")})`);
    ok(await off.locator("#row-option-b td:nth-child(5) .trust a", { hasText: /^example\.com ↗$/ }).count() === 1, "it links the page that was read");
    // one link pattern at two weights: a cited source is quiet (caption colour), an action ("Open Store ↗") is in the
    // link colour; both are underlined
    const looks = await off.evaluate(() => {
      const look = (a) => { const c = getComputedStyle(a); return c.color + "|" + c.textDecorationLine; };
      const probe = (v) => { const d = document.createElement("span"); d.style.color = `var(${v})`; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
      return { cites: [...new Set([...document.querySelectorAll(".trust a:not(.act), .notes a")].map(look))], acts: [...new Set([...document.querySelectorAll(".trust a.act")].map(look))], muted: probe("--if-muted"), link: probe("--if-link") };
    });
    eq(looks.cites, [`${looks.muted}|underline`], "every cited source looks the same: the caption colour, underlined");
    eq(looks.acts, [`${looks.link}|underline`], "every action link is the link colour, underlined");
    eq(off.errors.filter((e) => !/404|Failed to load resource/.test(e)), [], "no script errors without a binder");
    await off.context().close();

    // a caption too long for its cell breaks before a " · ", never inside "Not listed" ("Not" / "listed · …"):
    // a short part keeps its dot with it, so the break must come before the dot
    const longSrc = await staticServer(makeSite("long-source", "compare", (d) => ({ ...d, items: d.items.map((i) => i.ref !== "option:option-b" ? i : { ...i, facts: { ...i.facts, warranty: { ...i.facts.warranty, src: "Maker's product spec sheet" } } }) })));
    const ls = await open(`${longSrc}/`, { width: 1024, height: 800 });
    const lines = await ls.evaluate(() => {
      const part = [...document.querySelectorAll("#row-option-b .trust .part")].find((p) => p.textContent === "Not listed");
      return part ? part.getClientRects().length : -1;
    });
    eq(lines, 1, "\"Not listed\" stays on one line when its source wraps");
    eq(await dotLines(ls), [], "a wrapped caption starts its new line without a dot, and no line ends in one");
    await ls.context().close();
    const lsPhone = await open(`${longSrc}/`, { width: 390, height: 844 });
    eq(await dotLines(lsPhone), [], "phone: no caption line starts or ends with a dot");
    await lsPhone.context().close();

    const local = await staticServer(makeSite("no-binder-list", "checklist"));
    const lp = await open(`${local}/`);
    await lp.waitForFunction(() => !document.querySelector("input[type=checkbox]:disabled"));
    ok(/Ticks are saved on this device only\./.test(await text(lp)), "without a binder ticks stay on this device, and the page says so");
    await lp.locator("#item-photos label").click();
    await lp.reload();
    await lp.waitForFunction(() => document.querySelector("#item-photos input") && !document.querySelector("input[type=checkbox]:disabled"));
    ok(await lp.locator("#item-photos input").isChecked(), "a device tick survives a reload");
    await lp.context().close();
  }
  console.log(`starters browser check: ${checks} checks passed${SHOTS ? `; screenshots in ${SHOTS}` : ""}`);
} finally {
  await browser.close();
  for (const s of servers) await s.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
