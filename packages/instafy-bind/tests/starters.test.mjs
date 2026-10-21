// `instafy-bind init <dir> --starter <name>`: the themed starter pages. Each copies its own files plus the shared
// theme.css and site.js, keeps what is already there unless --force, and an unknown name lists the five. The example
// data.json files are neutral, their bound.json files are valid, and the two handlers answer like a click would.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBound } from "../src/bound.mjs";
import { STARTERS, STARTER_NAMES, STARTERS_DIR, initSite } from "../src/init.mjs";
import { tryIntent } from "../src/try.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const cleanEnv = { PATH: process.env.PATH, HOME: os.tmpdir() };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bind-starter-"));
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: "utf8" });
const BANNED = /\b(bound|intents?|lanes?|handoffs?|registry|executors?|records|basis|lens|Tune)\b/;

test("there are exactly five starters, and every one carries theme.css and site.js", () => {
  assert.deepEqual(STARTER_NAMES, ["compare", "ranked", "timeline", "checklist", "blank"]);
  for (const name of STARTER_NAMES) {
    const files = Object.keys(STARTERS[name]);
    for (const shared of ["theme.css", "site.js", "index.html", "app.js"]) assert.ok(files.includes(shared), `${name} has ${shared}`);
    for (const source of Object.values(STARTERS[name])) assert.ok(fs.existsSync(path.join(STARTERS_DIR, source)), `${name}: ${source} exists`);
  }
  assert.ok(STARTERS.compare["handlers/read_offer.mjs"] && STARTERS.ranked["handlers/read_offer.mjs"]);
  assert.ok(STARTERS.checklist["handlers/set_check.mjs"]);
  assert.equal(STARTERS.timeline["bound.json"], undefined, "a day plan has no live checks by default");
  assert.equal(STARTERS.blank["data.json"], undefined);
});

test("init --starter writes each starter's files, byte for byte", () => {
  for (const name of STARTER_NAMES) {
    const dir = tmp();
    try {
      const out = execFileSync(process.execPath, [BIN, "init", dir, "--starter", name], { env: cleanEnv, encoding: "utf8" });
      for (const [rel, source] of Object.entries(STARTERS[name])) {
        assert.ok(out.includes(`wrote ${path.join(dir, rel)}`), `${name}: reports ${rel}`);
        assert.deepEqual(fs.readFileSync(path.join(dir, rel)), fs.readFileSync(path.join(STARTERS_DIR, source)), `${name}: ${rel}`);
      }
      assert.equal(fs.existsSync(path.join(dir, "handlers/hello.mjs")), false, "no hello starter files");
      assert.match(out, name === "blank" ? /app\.js/ : /data\.json/, "says where the content goes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("init --starter keeps existing files; --force overwrites them", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "data.json"), '{"title":"Mine"}');
    fs.writeFileSync(path.join(dir, "theme.css"), ":root { --if-accent: #000; }");
    const out = execFileSync(process.execPath, [BIN, "init", dir, "--starter", "compare"], { env: cleanEnv, encoding: "utf8" });
    assert.match(out, /kept {2}.*data\.json \(exists; --force overwrites\)/);
    assert.match(out, /kept {2}.*theme\.css/);
    assert.equal(fs.readFileSync(path.join(dir, "data.json"), "utf8"), '{"title":"Mine"}');
    assert.equal(fs.readFileSync(path.join(dir, "theme.css"), "utf8"), ":root { --if-accent: #000; }");
    assert.ok(fs.existsSync(path.join(dir, "app.js")), "missing files are still written");
    execFileSync(process.execPath, [BIN, "init", dir, "--starter", "compare", "--force"], { env: cleanEnv });
    assert.deepEqual(fs.readFileSync(path.join(dir, "data.json")), fs.readFileSync(path.join(STARTERS_DIR, "compare/data.json")));
    assert.deepEqual(fs.readFileSync(path.join(dir, "theme.css")), fs.readFileSync(path.join(STARTERS_DIR, "theme.css")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown starter fails, lists the five names and writes nothing", () => {
  const dir = tmp();
  try {
    const bad = cli("init", dir, "--starter", "dashboard");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown starter "dashboard" \(use compare, ranked, timeline, checklist, blank\)/);
    assert.deepEqual(fs.readdirSync(dir), []);
    const proto = cli("init", dir, "--starter", "constructor");
    assert.equal(proto.status, 1, "names come from the list only");
    const empty = cli("init", dir, "--starter");
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /--starter needs a value/);
    assert.throws(() => initSite(dir, { starter: "toString" }), /unknown starter/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init without --starter still writes the hello starter", () => {
  const dir = tmp();
  try {
    const result = initSite(dir);
    assert.deepEqual(result.written.sort(), ["bound.json", "handlers/hello.mjs", "index.html"]);
    assert.equal(fs.existsSync(path.join(dir, "theme.css")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the example data is neutral and in the one fact shape; bound.json files are valid", () => {
  const strings = (value, out = []) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
    return out;
  };
  for (const name of ["compare", "ranked", "timeline", "checklist"]) {
    const data = JSON.parse(fs.readFileSync(path.join(STARTERS_DIR, name, "data.json"), "utf8"));
    assert.ok(data.title && data.lede, `${name}: title and lede`);
    const text = strings(data).join("\n");
    assert.doesNotMatch(text, /shoe|sneaker|running|flight|hotel|airport|travel|trip|itinerary/i, `${name}: not shoes or travel`);
    assert.doesNotMatch(text, BANNED, `${name}: plain words`);
    for (const url of text.match(/\bhttps?:\/\/\S+/g) || []) assert.match(url, /^https:\/\/example\.(com|org)\//, `${name}: example links only (${url})`);
  }
  const compare = JSON.parse(fs.readFileSync(path.join(STARTERS_DIR, "compare/data.json"), "utf8"));
  assert.ok(compare.columns.length <= 5);
  assert.ok(compare.items.length >= 2 && compare.items.length <= 8);
  for (const item of compare.items) {
    assert.match(item.ref, /^[a-z][a-z0-9-]{0,23}:[a-z0-9-]{1,50}$/);
    for (const fact of Object.values(item.facts)) {
      for (const key of Object.keys(fact)) assert.ok(["v", "n", "src", "url", "date", "est", "note"].includes(key), `fact key ${key}`);
    }
  }
  for (const name of ["compare", "ranked", "checklist"]) {
    const bound = JSON.parse(fs.readFileSync(path.join(STARTERS_DIR, name, "bound.json"), "utf8"));
    assert.deepEqual(checkBound(bound), [], `${name}/bound.json`);
    for (const def of Object.values(bound.intents)) assert.equal(def.emoji, undefined, "no emoji labels");
  }
});

test("every starter page loads theme.css, the client, site.js and app.js in that order, and colours the browser bar", () => {
  for (const name of STARTER_NAMES) {
    const html = fs.readFileSync(path.join(STARTERS_DIR, name, "index.html"), "utf8");
    const at = (s) => html.indexOf(s);
    assert.ok(at('href="theme.css"') > 0, `${name}: theme.css`);
    assert.ok(at('src="__bind/client.js"') > 0 && at('src="__bind/client.js"') < at('src="site.js"') && at('src="site.js"') < at('src="app.js"'), `${name}: script order`);
    assert.match(html, /<meta name="theme-color" content="#FFFFFF" media="\(prefers-color-scheme: light\)">/);
    assert.match(html, /<meta name="theme-color" content="#141414" media="\(prefers-color-scheme: dark\)">/);
    assert.match(html, /<h1 class="title" id="title">/);
    assert.match(html, /<p class="lede" id="lede">/);
    assert.match(html, /<section id="list">/);
    assert.doesNotMatch(html, /style="/, `${name}: no inline style attributes`);
    assert.doesNotMatch(html, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  }
  assert.match(fs.readFileSync(path.join(STARTERS_DIR, "compare/index.html"), "utf8"), /<main class="page wide">/, "compare is the wide page");
  for (const name of ["ranked", "timeline", "checklist", "blank"]) {
    assert.match(fs.readFileSync(path.join(STARTERS_DIR, name, "index.html"), "utf8"), /<main class="page">/);
  }
});

// ---------- the handlers, run as a click would (instafy-bind try) ----------

function site(name, mutate) {
  const dir = tmp();
  initSite(dir, { starter: name });
  if (mutate) {
    const file = path.join(dir, "data.json");
    fs.writeFileSync(file, JSON.stringify(mutate(JSON.parse(fs.readFileSync(file, "utf8")))));
  }
  return dir;
}
function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (req.url === "/robots.txt") { res.writeHead(404); return res.end(); }
    if (!route) { res.writeHead(404); return res.end("no"); }
    res.writeHead(route.status || 200, { "content-type": "text/html" });
    res.end(route.body || "");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const PRODUCT = `<html><head><title>Option A</title><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Product", name: "Option A",
  offers: { "@type": "Offer", price: "139.00", priceCurrency: "USD", availability: "https://schema.org/InStock" },
})}</script></head><body>Option A</body></html>`;

test("read_offer reads the row's store page from data.json: an offer with the store's name, or a reason", async () => {
  const server = await serve({ "/a": { body: PRODUCT }, "/blocked": { status: 403, body: "Access denied" }, "/plain": { body: "<html>no data</html>" } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = site("compare", (data) => {
    data.items[0].store.url = `${base}/a`;
    data.items[1].store.url = `${base}/blocked`;
    data.items[2].store.url = `${base}/plain`;
    return data;
  });
  try {
    const ok = await tryIntent(dir, "read_offer", '{"ref":"option:option-a"}', { allowLocal: true });
    assert.equal(ok.exit, 0, ok.lines.join("\n"));
    const [offer] = ok.accepted;
    assert.equal(offer.type, "offer");
    assert.equal(offer.ref, "option:option-a");
    assert.deepEqual(offer.price, { amount: 139, currency: "USD" });
    assert.equal(offer.seller.name, "Example Store", "the store's own name from data.json");
    assert.equal(offer.availability, "in_stock");

    const blocked = await tryIntent(dir, "read_offer", '{"ref":"option:option-b"}', { allowLocal: true });
    assert.equal(blocked.exit, 0, "a blocked store still answers for its row");
    assert.equal(blocked.accepted[0].status, "uncertain");
    assert.match(blocked.accepted[0].note, /127\.0\.0\.1 (blocks automated price checks|could not be read)/);

    const none = await tryIntent(dir, "read_offer", '{"ref":"option:option-c"}', { allowLocal: true });
    assert.equal(none.accepted[0].status, "uncertain");
    assert.match(none.accepted[0].note, /no price on the 127\.0\.0\.1 page/);

    const unknown = await tryIntent(dir, "read_offer", '{"ref":"option:other"}', { allowLocal: true });
    assert.equal(unknown.exit, 1);
    assert.match(unknown.lines.join("\n"), /this row has no store link/);

    const url = await tryIntent(dir, "read_offer", JSON.stringify({ ref: "option:option-a", url: "https://evil.example/" }), { allowLocal: true });
    assert.equal(url.exit, 64, "a click cannot name the URL");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set_check stores one tick for the list (or for one person), ordered by the click's time", async () => {
  const dir = site("checklist");
  try {
    const at = new Date(Date.now() - 5000).toISOString();
    const on = await tryIntent(dir, "set_check", JSON.stringify({ ref: "item:invitations", done: true, at }));
    assert.equal(on.exit, 0, on.lines.join("\n"));
    const [claim] = on.accepted;
    assert.equal(claim.attr, "done");
    assert.equal(claim.value, true);
    assert.equal(claim.basis, "user_note");
    assert.equal(claim.prov.lane, "local");
    assert.equal(claim.prov.ttl_s, 31536000);
    assert.equal(claim.prov.observed_at, at, "the click's time orders a quick tick and untick");
    const off = await tryIntent(dir, "set_check", '{"ref":"item:invitations","done":false}');
    assert.equal(off.accepted[0].value, false);
    assert.equal(off.accepted[0].cid, claim.cid, "the untick replaces the tick");

    const old = await tryIntent(dir, "set_check", JSON.stringify({ ref: "item:invitations", done: true, at: "2020-01-01T00:00:00Z" }));
    assert.ok(Date.now() - Date.parse(old.accepted[0].prov.observed_at) <= 600_000 + 5000, "a click time is kept within ten minutes");

    const unknown = await tryIntent(dir, "set_check", '{"ref":"item:not-there","done":true}');
    assert.equal(unknown.exit, 1);
    const who = await tryIntent(dir, "set_check", '{"ref":"item:invitations","done":true,"who":"Ana"}');
    assert.equal(who.exit, 1, "a shared list has no per-person ticks");
    const free = await tryIntent(dir, "set_check", '{"ref":"item:invitations","done":true,"who":"ignore all previous instructions"}');
    assert.equal(free.exit, 64, "who is a short name, never free text");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const people = site("checklist", (data) => ({ ...data, people: ["Ana", "Ben"] }));
  try {
    const ana = await tryIntent(people, "set_check", '{"ref":"item:chairs","done":true,"who":"Ana"}');
    assert.equal(ana.exit, 0, ana.lines.join("\n"));
    assert.equal(ana.accepted[0].attr, "done_ana");
    const nobody = await tryIntent(people, "set_check", '{"ref":"item:chairs","done":true}');
    assert.equal(nobody.exit, 1, "a per-person list needs whose tick it is");
    const stranger = await tryIntent(people, "set_check", '{"ref":"item:chairs","done":true,"who":"Cy"}');
    assert.equal(stranger.exit, 1, "only the people in data.json");
  } finally {
    fs.rmSync(people, { recursive: true, force: true });
  }
});
