// `instafy-bind check`: a page built for a request that named items (products to compare, stops, entries) must show
// every one of them, or the check fails loudly. A builder that loses an item to a lookup that timed out, or trims a
// list, otherwise ships a page that quietly leaves it out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSite, checkValues, htmlLines, htmlText, jsonStrings, names, parseExpect, uncitedRows } from "../src/check.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const cleanEnv = { PATH: process.env.PATH, HOME: os.tmpdir() };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: "utf8" });

function compareSite(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-"));
  execFileSync(process.execPath, [BIN, "init", dir, "--starter", "compare"], { env: cleanEnv });
  const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  data.title = "Three running shoes for flat feet";
  // each row says where it comes from (a search result's site), so these tests judge only which items are shown
  data.items = items.map((name, i) => ({ ref: `shoes:item-${i}`, name, facts: {}, found: "reviews.example.net" }));
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 2));
  return dir;
}

test("expected items are read from a list or a JSON array, without duplicates", () => {
  assert.deepEqual(parseExpect("Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31;Hoka Arahi 7\nbrooks adrenaline gts 24"),
    ["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31", "Hoka Arahi 7"]);
  assert.deepEqual(parseExpect('["Taipei", {"name": "Hualien"}]'), ["Taipei", "Hualien"]);
  assert.deepEqual(parseExpect(""), []);
});

test("an item counts as shown when the page's text or data names it as whole words", () => {
  assert.equal(names("ASICS Gel Kayano 31 · seen 17 Oct", "ASICS Gel-Kayano 31"), true);
  assert.equal(names("Hoka Arahi 75", "Hoka Arahi 7"), false, "a longer number is another product");
  assert.equal(names("京都駅から徒歩5分", "京都"), true);
  assert.equal(htmlText('<h1>Shoes</h1><script>const x = "Hoka Arahi 7"</script><!-- Brooks -->'), " Shoes ");
});

test("check fails and names every item the page leaves out", () => {
  const dir = compareSite(["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31"]);
  try {
    const out = run("check", dir, "--expect", "Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31, Hoka Arahi 7");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Hoka Arahi 7\./m);
    assert.match(out.stdout, /2 of 3 expected item\(s\) shown: Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31\./);
    const json = JSON.parse(run("check", dir, "--expect", "Hoka Arahi 7", "--json").stdout);
    assert.deepEqual([json.ok, json.missing], [false, ["Hoka Arahi 7"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check passes once every item is on the page, from --expect or data.json's own list", () => {
  const dir = compareSite(["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31", "Hoka Arahi 7"]);
  try {
    const ok = run("check", dir, "--expect", "Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31, Hoka Arahi 7");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /3 of 3 expected item\(s\) shown/);
    // the list kept with the data is checked on every run, and is never itself counted as shown
    const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
    data.expect = ["Hoka Arahi 7", "Saucony Guide 18"];
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
    const declared = run("check", dir);
    assert.equal(declared.status, 1, declared.stdout);
    assert.match(declared.stdout, /does not show: Saucony Guide 18\./);
    assert.deepEqual(checkSite(dir).missing, ["Saucony Guide 18"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("text that only says an item is unavailable does not count as showing it", () => {
  // a builder that says on the page what it could not add must still fail the check for that item
  assert.deepEqual(htmlLines("<h1>Trip</h1><p>Taipei, 3 nights</p><p class=note>Not found yet: Tokyo, Hakone</p><li>Could not place Kyoto<br>Osaka</li>"),
    ["Trip", "Taipei, 3 nights", "Osaka"]);
  assert.deepEqual(jsonStrings({ items: [{ name: "Brooks Ghost 16" }], missing: [{ name: "Tokyo" }], notes: ["Not found yet: Hoka Arahi 7"], expect: ["x"] }),
    ["Brooks Ghost 16"]);
  const dir = compareSite(["Brooks Ghost 16"]);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
    data.notes = ["Not found yet: Hoka Arahi 7"];
    data.missing = [{ name: "Saucony Guide 18" }];
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
    fs.writeFileSync(path.join(dir, "missing.html"), "<!doctype html><p>Missing: Nike Pegasus 41</p><p>Unavailable - ASICS Novablast 5</p>");
    const out = run("check", dir, "--expect", "Brooks Ghost 16, Hoka Arahi 7, Saucony Guide 18, Nike Pegasus 41, ASICS Novablast 5");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /does not show: Hoka Arahi 7, Saucony Guide 18, Nike Pegasus 41, ASICS Novablast 5\./);
    assert.match(out.stdout, /1 of 5 expected item\(s\) shown: Brooks Ghost 16\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a map's places count as shown: its layers are GeoJSON data files", () => {
  // a map site keeps its places in data/<layer>.geojson and what it could not place under "missing" in its config
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-map-"));
  try {
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Map</title><div id=map></div>");
    fs.writeFileSync(path.join(dir, "map.config.json"), JSON.stringify({ title: "Cafés in Lisbon", layers: [{ id: "cafes", data: "data/cafes.geojson" }],
      missing: [{ name: "Pastéis de Belém", layer: "cafes" }] }));
    const point = (id, name, coordinates) => ({ type: "Feature", geometry: { type: "Point", coordinates }, properties: { id, name, kind: "cafe" } });
    fs.writeFileSync(path.join(dir, "data", "cafes.geojson"), JSON.stringify({ type: "FeatureCollection",
      features: [point("a-brasileira", "A Brasileira", [-9.1427, 38.7107]), point("cafe-nicola", "Café Nicola", [-9.1393, 38.7139])] }));
    const out = run("check", dir, "--expect", "A Brasileira, Café Nicola, Pastéis de Belém");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Pastéis de Belém\./m);
    assert.match(out.stdout, /2 of 3 expected item\(s\) shown: A Brasileira, Café Nicola\./);
    assert.deepEqual(checkSite(dir, "A Brasileira").shown, [{ item: "A Brasileira", files: ["data/cafes.geojson"] }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check with nothing to check says how to give the list (exit 2)", () => {
  const dir = compareSite(["Brooks Adrenaline GTS 24"]);
  try {
    const out = run("check", dir);
    assert.equal(out.status, 2);
    assert.match(out.stdout, /nothing to check: pass --expect/);
    assert.equal(run("check", path.join(dir, "nope"), "--expect", "x").status, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the values of a page of options ----------

function optionsSite(starter, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-values-"));
  execFileSync(process.execPath, [BIN, "init", dir, "--starter", starter], { env: cleanEnv });
  const file = path.join(dir, "data.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify(mutate ? mutate(data, dir) ?? data : data, null, 2));
  return dir;
}

test("the starters pass their own value check, with a stated limit too", () => {
  for (const starter of ["compare", "ranked"]) {
    const dir = optionsSite(starter, (data) => ({ ...data, filter: { key: "price", max: 140, label: "Under $140", rest: "over $140" } }));
    try {
      const values = checkValues(dir);
      assert.equal(values.checked, true, starter);
      assert.deepEqual(values.problems, [], `${starter}: ${values.problems.join("\n")}`);
      // the example's third option has no price: the page lists it apart, and the reply must say so
      assert.equal(values.notes.length, 1, starter);
      assert.match(values.notes[0], /1 item\(s\) have no price the page can show: Option C\. The page lists them apart \("Price unknown"\), never as "Under \$140"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // a timeline or checklist is not a page of options: nothing of this is checked there
  const plan = optionsSite("timeline");
  try {
    assert.deepEqual(checkValues(plan), { checked: false, problems: [], notes: [] });
  } finally {
    fs.rmSync(plan, { recursive: true, force: true });
  }
});

test("check fails for a value that only says nothing and for a value without its page and day", () => {
  const dir = optionsSite("compare", (data) => {
    data.items[0].facts.weight = { v: "—", src: "Maker", url: "https://example.com/a", date: "2026-10-27" };
    data.items[1].facts.rating = { v: "n/a" };
    data.items[2].facts.warranty = { v: "2 years", src: "Maker", date: "2026-10-27" };
    data.items[2].facts.rating = { v: "4.4 of 5" };
    data.items[1].facts.weight = { v: "about 9.5 oz", est: true };
    return data;
  });
  try {
    const { problems } = checkValues(dir);
    assert.equal(problems.length, 4, problems.join("\n"));
    assert.match(problems[0], /^Option A · Weight: "—" says nothing\. Leave out "v" and say why in "note"/);
    assert.match(problems[1], /^Option B · Rating: "n\/a" says nothing/);
    // the page to add is one that gives the value: a count of what was found, with none found ("0 of 2 reviews
    // found"), cites no page and is a note instead, never the one page that was read
    assert.match(problems[2], /^Option C · Rating: "4\.4 of 5" has no "src", "url" \(the page\) or "date" \(the day\): add the page that gives this value and the day you read it \("checked 27 Oct on maker\.com"\)\. When no page gives it \(such as a count of what you found, with none found\), leave out "v" and say why in "note"\. Without a source the page shows it as not checked\.$/);
    assert.match(problems[3], /^Option C · Warranty: "2 years" has no "url" \(the page\): add the page that gives this value and the day you read it/);
    const out = run("check", dir, "--expect", "Option A, Option B, Option C");
    assert.equal(out.status, 1, "every item is shown, and the values still fail the check");
    assert.match(out.stdout, /^VALUES: 4 value\(s\) to fix in data\.json:$/m);
    assert.match(out.stdout, /3 of 3 expected item\(s\) shown/);
    const json = JSON.parse(run("check", dir, "--expect", "Option A", "--json").stdout);
    assert.equal(json.ok, false);
    assert.equal(json.values.problems.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check fails for a filter a page applies by itself, or that cannot filter; it notes the rows listed apart", () => {
  const dir = optionsSite("compare", (data) => ({ ...data, filter: { key: "price", max: 600, label: "€600 or less" } }));
  try {
    assert.deepEqual(checkValues(dir).problems, []);
    // the live test's page: its own filter let a row without a price through
    const app = path.join(dir, "app.js");
    fs.writeFileSync(app, fs.readFileSync(app, "utf8").replace("return site.byFilter(items, f, function (i) { return valueOf(i, col); });",
      "return { in: items.filter(function (i) { var n = site.num(valueOf(i, col)); return n == null || n <= f.max; }), unknown: [], out: [] };"));
    const own = checkValues(dir).problems;
    assert.equal(own.length, 1, own.join("\n"));
    assert.match(own[0], /data\.json has a filter, and app\.js applies it without site\.byFilter: a row whose value is unknown may be listed as "€600 or less"/);
    const out = run("check", dir, "--expect", "Option A");
    assert.equal(out.status, 1);
    assert.match(out.stdout, /^NOTE: 1 item\(s\) have no price the page can show: Option C\./m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const bad = optionsSite("compare", (data) => ({ ...data, filter: { key: "cost", max: "about 600", label: "Cheap" } }));
  try {
    assert.deepEqual(checkValues(bad).problems, [
      'the filter\'s key "cost" is not a column, so "Cheap" filters nothing.',
      'the filter "Cheap" has no number in "max" or "min".',
    ]);
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
  }
});

test("a price a check read counts for the filter; a check that found the shop blocked does not", () => {
  const dir = optionsSite("compare", (data, d) => {
    fs.mkdirSync(path.join(d, "data/records"), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(d, "data/records/read_offer.json"), JSON.stringify({ schema: "instafy.records@1", records: [
      { type: "offer", ref: "option:option-c", price: { amount: 120, currency: "USD" }, prov: { observed_at: at } },
      { type: "claim", ref: "option:option-a", attr: "price", value: null, status: "uncertain", note: "blocked", prov: { observed_at: at } },
    ] }));
    data.items[0].facts.price = { note: "the store blocks price checks" };
    return { ...data, filter: { key: "price", max: 140, label: "Under $140" } };
  });
  try {
    const { notes } = checkValues(dir);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^1 item\(s\) have no price the page can show: Option A\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on a ranked page, a row with no price at all is noted as listed apart too", () => {
  const dir = optionsSite("ranked", (data) => {
    delete data.items[1].price;
    delete data.items[1].store;
    return { ...data, filter: { key: "price", max: 140, label: "Under $140" } };
  });
  try {
    const { notes, problems } = checkValues(dir);
    assert.deepEqual(problems, []);
    assert.match(notes[0], /^2 item\(s\) have no price the page can show: Option B, Option C\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A comparison whose maker's site never answered listed "Latest eligible model 1/2/3", every cell unknown, although a
// search had named the models. A row is a candidate a page read names, or only a search result ("found", that result's
// site). The check reads that from the data's shape, never from the row's words, and the lists the same turn writes
// (`--expect`, data.json's "expect") never vouch for a row.
test("check fails a comparison row that says nowhere where it comes from", () => {
  const unread = { note: "no official product page could be read" };
  const row = (name, extra = {}) => ({ ref: `vacuum:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, why: "", facts: { price: unread, weight: unread, rating: unread, warranty: unread }, ...extra });
  const dir = optionsSite("compare", (data) => ({ ...data, items: [1, 2, 3].map((n) => row(`Latest eligible model ${n}`)) }));
  try {
    const { problems } = checkValues(dir);
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /^Latest eligible model 1: nothing says where this row comes from\. Cite the page you read that names it \(a value's "src" and "url", or "sources": \[\{"name", "url"\}\]\)\. When only a search result names it, put that result's site in "found"/);
    const out = run("check", dir, "--expect", "Brightvac");
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /^VALUES: 3 value\(s\) to fix in data\.json:$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const data = (items, extra = {}) => ({ columns: [{ key: "price", label: "Price", type: "price" }], items, ...extra });
  const page = { src: "Review One", url: "https://reviews.example.net/s8", date: "2026-10-29" };
  // the shape decides, not the words: the same placeholder name passes once a search result is named for it, and a
  // real-sounding model fails without anything behind it
  assert.deepEqual(uncitedRows(data([row("Latest eligible model 1", { found: "reviews.example.net" })])), []);
  assert.deepEqual(uncitedRows(data([row("Brightvac S9 Ultra")])).map((r) => r.item), ["Brightvac S9 Ultra"]);
  // a page read: a value's (a value or "Not listed") or a "sources" entry, each with its https page
  assert.deepEqual(uncitedRows(data([
    row("A", { facts: { price: { v: "€399", ...page } } }),
    row("B", { facts: { price: { ...page } } }),
    row("C", { sources: [{ name: "Review One", url: page.url }] }),
    row("D", { more: [{ label: "Mop", fact: { v: "none", ...page } }] }),
  ])), []);
  // an estimate, a value without its page, a source without an https page and a store link are no page read
  assert.deepEqual(uncitedRows(data([
    row("E", { facts: { price: { v: "about €400", est: true, url: page.url } } }),
    row("F", { facts: { price: { v: "€399", src: "Review One", date: "2026-10-29" } } }),
    row("G", { sources: [{ name: "Review One", url: "http://reviews.example.net/s8" }] }),
    row("H", { store: { name: "Shop", url: "https://shop.example.net/h", readable: true }, found: " " }),
  ])).map((r) => r.item), ["E", "F", "G", "H"]);
  // "found" names a site, as a search result gives it, not a word ("search") or an address
  assert.deepEqual(uncitedRows(data([
    row("I", { found: "search" }),
    row("J", { found: "https://reviews.example.net/s8" }),
    row("K", { found: "reviews.example.net" }),
  ])).map((r) => r.item), ["I", "J"]);
  // a list of names the turn writes itself is no source: the data's own "expect" does not let a row pass
  assert.deepEqual(uncitedRows(data([row("Brightvac S8 Pro")], { expect: ["Brightvac S8 Pro"] })).map((r) => r.item), ["Brightvac S8 Pro"]);
  // a ranked page (no columns) is not judged by this rule
  assert.deepEqual(uncitedRows({ items: [{ name: "Top pick", price: unread }] }), []);
});

// The rows a turn built when the maker's site never answered: each cell unknown, nothing read, and the turn listed the
// rows' own names (or the brand) as the request's items. Listing a row is not where it comes from, so the check fails.
test("check fails placeholder rows even when --expect or the data's own list names them", () => {
  const unread = { note: "Unknown: no official product page could be read" };
  const names = [1, 2, 3].map((n) => `Latest eligible Brightvac model ${n}`);
  const dir = optionsSite("compare", (data) => ({
    ...data,
    items: names.map((name, i) => ({ ref: `vacuum:model-${i + 1}`, name, why: "", facts: { price: unread, weight: unread, rating: unread, warranty: unread } })),
  }));
  try {
    for (const expect of [names.join(","), "Brightvac"]) {
      const out = run("check", dir, "--expect", expect);
      assert.equal(out.status, 1, `--expect ${expect}: ${out.stdout}`);
      assert.match(out.stdout, /^VALUES: 3 value\(s\) to fix in data\.json:$/m);
      assert.match(out.stdout, /Latest eligible Brightvac model 1: nothing says where this row comes from\./);
    }
    const file = path.join(dir, "data.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), expect: names }));
    const own = run("check", dir);
    assert.equal(own.status, 1, own.stdout);
    assert.match(own.stdout, /^VALUES: 3 value\(s\) to fix in data\.json:$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a filter without a label fails the check: the page would have nothing to call the limit", () => {
  const dir = optionsSite("compare", (data) => ({ ...data, filter: { key: "price", max: 140 } }));
  try {
    assert.deepEqual(checkValues(dir).problems, ['the filter has no "label" (what the person asked for: "€600 or less").']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
