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
import { UNAVAILABLE_KEYS, checkSite, checkValues, htmlLines, htmlText, jsonStrings, names, parseExpect, servedPath, uncitedRows } from "../src/check.mjs";
import { readScript } from "../src/script-text.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const cleanEnv = { PATH: process.env.PATH, HOME: os.tmpdir() };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: "utf8" });

/** A blank starter page in a new folder, with this app.js (null: the starter's own). */
function blankSite(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-blank-"));
  execFileSync(process.execPath, [BIN, "init", dir, "--starter", "blank"], { env: cleanEnv });
  if (app != null) fs.writeFileSync(path.join(dir, "app.js"), app);
  return dir;
}

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

// A blank starter page keeps its words in app.js. The check read only the HTML and data files, so it reported every
// item such a page showed as missing ("MISSING: the request named 7 item(s)…", "Add each one to the page (its data
// file)"), and a turn that chained the check before the card's command never posted the card.
test("a blank page's words count: the text its app.js passes to site.h and site.head", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-blank-"));
  try {
    execFileSync(process.execPath, [BIN, "init", dir, "--starter", "blank"], { env: cleanEnv });
    fs.writeFileSync(path.join(dir, "app.js"), `(function () {
  "use strict";
  var h = site.h;
  site.start({ data: null, render: function () {
    site.head({ title: "Corner Bookshop", lede: "A short visit guide" });
    var hours = site.h("article", { className: "card" }, [
      site.h("h2", {}, "Opening hours"),
      h("p", { text: \`Every day, 9:00 AM–7:30 PM\` }),
      // a comment is not on the page: site.h("p", {}, "Rooftop garden")
      site.h("a", { href: "https://bookshop.example/en/", className: "Harbour view" }, "Official site"),
    ]);
    var route = h("article", "From Central Station by tram", site.link("https://transit.example/", "Tram timetable"),
      h("p", {}, "Not found yet: Night bus"));
    document.getElementById("list").replaceChildren(hours, route);
  } });
})();
`);
    const all = "Corner Bookshop, Opening hours, Every day, 9:00 AM–7:30 PM, From Central Station by tram, Tram timetable, Official site";
    const ok = run("check", dir, "--expect", all);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /7 of 7 expected item\(s\) shown/);
    assert.deepEqual(checkSite(dir, "Opening hours").shown, [{ item: "Opening hours", files: ["app.js"] }]);
    // a comment, an attribute and a line that says an item is not there are not the page's words
    const out = run("check", dir, "--expect", `${all}, Rooftop garden, Harbour view, Night bus`);
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^MISSING: the request named 3 item\(s\) the site does not show: Rooftop garden, Harbour view, Night bus\.$/m);
    assert.match(out.stdout, /^Add each one to the page, or say plainly in the reply which are missing and why\.$/m);
    assert.doesNotMatch(out.stdout, /its data file/);
    assert.equal(JSON.parse(run("check", dir, "--expect", "Night bus", "--json").stdout).unread.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page to share gave its two sources as lines written by hand, `site.h("p", { class: "trust" }, "Source: …")`, as
// the blank starter's ".trust for any fact" invited: nothing on the page linked the bookshop's or the planner's page.
// A source line links the page its fact was read on: site.trust(fact) draws one that does, and the check fails a line
// drawn by hand that links none, naming it, unless it says nothing on it was checked.
test("check fails a source line written by hand that links no page, and names it", () => {
  const unlinked = `(function () {
  site.start({ data: null, render: function () {
    site.head({ title: "Livraria Lello", lede: "Opening hours and a metro route." });
    document.getElementById("list").replaceChildren(
      site.h("section", { class: "card" }, [
        site.h("h2", {}, "Opening hours"),
        site.h("p", {}, "Daily, 9:00 AM–7:30 PM"),
        site.h("p", { class: "trust" }, "Source: Livraria Lello · checked November 8, 2026")
      ]),
      site.h("section", { class: "card" }, [
        site.h("h2", {}, "Metro"),
        site.h("p", { className: "trust is-old", text: "Source: Metro do Porto journey planner · " + when })
      ])
    );
  } });
})();
`;
  const dir = blankSite(unlinked);
  try {
    const out = run("check", dir, "--expect", "Livraria Lello, Opening hours");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^UNLINKED: 2 source line\(s\) link no page: "Source: Livraria Lello · checked November 8, 2026" \(app\.js\), "Source: Metro do Porto journey planner ·" \(app\.js\)\.$/m);
    assert.match(out.stdout, /^Draw each fact with site\.trust\(\{"v", "src", "url", "date"\}\), which links the page it was read on/m);
    assert.match(out.stdout, /2 of 2 expected item\(s\) shown/);
    const json = JSON.parse(run("check", dir, "--expect", "Livraria Lello", "--json").stdout);
    assert.equal(json.ok, false);
    assert.deepEqual(json.unlinked.map((u) => u.line), ["Source: Livraria Lello · checked November 8, 2026", "Source: Metro do Porto journey planner ·"]);
    // with nothing named to check, the lines are still named
    assert.equal(run("check", dir).status, 1);

    // drawn by site.trust, or linked by hand (an "a" with an href, site.link, site.cite), each line links its page
    fs.writeFileSync(path.join(dir, "app.js"), `(function () {
  var h = site.h;
  site.start({ data: null, render: function () {
    site.head({ title: "Livraria Lello" });
    document.getElementById("list").replaceChildren(
      h("p", {}, "Opening hours"),
      site.trust({ v: "Daily, 9:00 AM–7:30 PM", src: "Livraria Lello", url: "https://bookshop.example/en/", date: "2026-11-08" }),
      h("p", { class: "trust" }, ["Source: ", h("a", { href: "https://bookshop.example/en/" }, "Livraria Lello"), " · checked 8 Nov"]),
      h("p", { class: "trust" }, "Planner: ", site.link("https://transit.example/planner", "Metro do Porto"), " · 8 Nov"),
      h("p", { class: "trust" }, "Route ", site.cite({ src: "Metro", url: "https://transit.example/planner", date: "2026-11-08" })),
      h("p", { class: "trust" }, "Walk from Aliados, not checked"),
      h("span", { class: "trust" }, h("span", { class: "v", text: value + ", not checked" })),
      h("p", { class: "trust" }, "From what Octo knows; nothing checked.")
    );
  } });
})();
`);
    const linked = run("check", dir, "--expect", "Livraria Lello, Opening hours");
    assert.equal(linked.status, 0, linked.stdout + linked.stderr);
    assert.doesNotMatch(linked.stdout, /UNLINKED/);
    assert.deepEqual(checkSite(dir).unlinked, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a page's own HTML is read the same way
  const html = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-html-"));
  try {
    const page = (body) => fs.writeFileSync(path.join(html, "index.html"), `<!doctype html><title>Visit</title><main>${body}</main>`);
    page('<h1>Visit</h1><p class="lede">Open daily.</p><p class="cap trust">Hours: <span>checked 8 Nov</span></p><!-- <p class="trust">old</p> -->');
    assert.deepEqual(checkSite(html).unlinked, [{ file: "index.html", line: "Hours: checked 8 Nov" }]);
    page('<h1>Visit</h1><p class="trust">Hours: <a class="x" href="https://bookshop.example/">bookshop.example</a></p><div class="trust">Tip, not checked</div>');
    assert.deepEqual(checkSite(html).unlinked, []);
    // a class that only contains the word, or a link with no address, is no source line or link
    page('<p class="trusted">Partners</p><p class="trust">Hours: <a data-href="https://bookshop.example/">bookshop</a></p>');
    assert.deepEqual(checkSite(html).unlinked.map((u) => u.line), ["Hours: bookshop"]);
  } finally {
    fs.rmSync(html, { recursive: true, force: true });
  }

  // every starter's own page passes (the compare starter's "…, not checked" line says so)
  for (const starter of ["compare", "ranked", "timeline", "checklist", "blank"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-starter-"));
    try {
      execFileSync(process.execPath, [BIN, "init", dir, "--starter", starter], { env: cleanEnv });
      assert.deepEqual(checkSite(dir).unlinked, [], starter);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("site.js helpers' text is read from the source, through any name the script gives them, never by running it", () => {
  const read = readScript(`
    const { h: el, head } = window.site;
    var re = /"[^"]*"/g, half = total / 2 / 1;
    head({ title: \`Trip to \${city}\`, lede: 'It\\'s \\u00e9t\\u00e9', map: "https://map.example" });
    el("p", { "aria-label": "Label", onClick: function () { go("Nowhere"); }, text: ok ? "Open" : "Closed" });
    site.notes(["Still to confirm: the ferry"], [{ name: "Harbour office", url: "https://harbour.example" }]);
    function h(x) { return x; } h("Not a helper"); other.h("Not one either");
    /* site.h("p", {}, "In a comment") */`);
  // one line per element, as the page draws it
  assert.deepEqual(read.lines, ["Trip to", "It's été", "Open Closed", "Still to confirm: the ferry", "Harbour office"]);
  assert.deepEqual([read.data, read.other, read.loads], [[], ["Not a helper", "Not one either"], false]);
});

test("a script's lists and objects are read as a data file's are; its other strings are only words the page may show", () => {
  const read = readScript(`
    var stops = [{ name: "Livraria Lello", id: "lello", href: "https://lello.example", note: "Not found yet: the café" }, "Torre dos Clérigos"];
    var missing = ["Palácio da Bolsa"];
    const page = { title: "Porto in a day", notFound: ["Casa da Música"], attrs: { title: "Tooltip" }, "Label key": 1, open: ok ? "Daily" : "Closed" };
    var heading = "Opening hours";
    if (kind === "museum") list.innerHTML = "<h2>" + heading + "</h2>";
    x["index key"];`, { lists: UNAVAILABLE_KEYS });
  assert.deepEqual(read.data, ["Livraria Lello", "Not found yet: the café", "Torre dos Clérigos", "Porto in a day", "Daily", "Closed"]);
  assert.deepEqual(read.other, ["Label key", "Opening hours", "museum", "<h2>", "</h2>", "index key"]);
  assert.equal(read.loads, false);
  // text fetched from another site while the page runs is text the check cannot read; the site's own files it reads
  assert.equal(readScript('fetch("https://hours.example/today").then((r) => r.text());').loads, true);
  assert.equal(readScript("const live = new EventSource(`https://hours.example/${day}`);").loads, true);
  assert.equal(readScript('fetch("data/stops.json"); site.load("data.json"); other.fetch("https://x.example")').loads, false);
});

// A blank page that draws its items from a list in app.js. The check read only what a script passed to site.h as text,
// so on a page with any such text (its title), every item drawn from the list was reported missing.
test("a page that draws its items from a list or an object in its script shows them", () => {
  const dir = blankSite(`(function () {
  "use strict";
  var stops = [
    { name: "Livraria Lello", note: "Bookshop", href: "https://lello.example" },
    { name: "Torre dos Clérigos", note: "Tower" },
  ];
  var hours = { weekdays: "Monday to Friday", weekend: "Saturday and Sunday" };
  site.start({ data: null, render: function () {
    site.head({ title: "Porto in a day" });
    document.getElementById("list").replaceChildren.apply(document.getElementById("list"), stops.map(function (s) {
      return site.h("article", { className: "card" }, site.h("h2", {}, s.name), site.h("p", {}, s.note + ": " + hours.weekdays));
    }));
  } });
})();
`);
  try {
    const out = run("check", dir, "--expect", "Porto in a day, Livraria Lello, Torre dos Clérigos, Monday to Friday, Saturday and Sunday");
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /5 of 5 expected item\(s\) shown/);
    // an item no file of the site names is missing, as before
    const lost = run("check", dir, "--expect", "Livraria Lello, Palácio da Bolsa");
    assert.equal(lost.status, 1, lost.stdout);
    assert.match(lost.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Palácio da Bolsa\.$/m);
    assert.doesNotMatch(lost.stdout, /UNREAD/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page whose words are in its HTML and that runs a small script of its own (a footer's year, the plain starter's
// records) said it could not tell about an item no file of the site names, where the check had said MISSING.
test("an item no file of the site names is missing, whatever scripts the page runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-static-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Porto</title>
<h2>Livraria Lello</h2><h2>Torre dos Clérigos</h2>
<footer>© <span id="year"></span></footer>
<script>document.getElementById("year").textContent = new Date().getFullYear();</script>
`);
    const out = run("check", dir, "--expect", "Livraria Lello, Torre dos Clérigos, Palácio da Bolsa");
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Palácio da Bolsa\.$/m);
    assert.doesNotMatch(out.stdout, /UNREAD/);
    fs.rmSync(dir, { recursive: true, force: true });
    execFileSync(process.execPath, [BIN, "init", dir], { env: cleanEnv });
    const plain = run("check", dir, "--expect", "Bound site starter, Say hello, Opening hours");
    assert.equal(plain.status, 1, plain.stdout);
    assert.match(plain.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Opening hours\.$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A line that says an item is not there, split across site.h's children ("Not found yet: ", <strong>name</strong>), joined
// with "+", or a notice with the item as its link, counted the item as shown, where the same line in HTML did not; and
// a br ends a line, as in HTML.
test("a line that says an item is not there is one line, however the script writes it", () => {
  const dir = blankSite(`site.head({ title: "Porto in a day" });
document.getElementById("list").replaceChildren(
  site.h("h2", {}, "Livraria Lello"),
  site.h("p", { className: "cap" }, "Not found yet: ", site.h("strong", {}, "Palácio da Bolsa")),
  site.h("p", {}, "Not found yet: " + "Torre dos Clérigos"),
  site.notice("warn", "Couldn't find ", site.link("https://music.example/", "Casa da Música")),
  site.h("ul", {}, site.h("li", {}, "Not found yet: Ponte Luís I"), site.h("li", {}, "Ribeira")),
  site.h("p", {}, "Sé Cathedral", site.h("br"), "Not found yet: Serralves"));
`);
  try {
    const out = run("check", dir, "--expect", "Livraria Lello, Ribeira, Sé Cathedral, Palácio da Bolsa, Torre dos Clérigos, Casa da Música, Ponte Luís I, Serralves");
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /^MISSING: the request named 5 item\(s\) the site does not show: Palácio da Bolsa, Torre dos Clérigos, Casa da Música, Ponte Luís I, Serralves\.$/m);
    assert.match(out.stdout, /3 of 8 expected item\(s\) shown: Livraria Lello, Ribeira, Sé Cathedral\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page's script can be a module (<script type="module" src="app.mjs">): its items were reported missing.
test("a page's module script is read too", () => {
  const dir = blankSite(null);
  try {
    const html = path.join(dir, "index.html");
    fs.writeFileSync(html, fs.readFileSync(html, "utf8").replace('<script src="app.js"></script>', '<script type="module" src="app.mjs"></script>'));
    fs.rmSync(path.join(dir, "app.js"));
    fs.writeFileSync(path.join(dir, "app.mjs"), 'site.head({ title: "Porto in a day" });\ndocument.getElementById("list").replaceChildren(site.h("h2", {}, "Livraria Lello"));\n');
    const out = run("check", dir, "--expect", "Porto in a day, Livraria Lello");
    assert.equal(out.status, 0, out.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page made before site.js 1.7.0 keeps its own copy, which draws nothing for a second argument to site.h that is not
// its props (site.h("p", "Every day")); the check counted that text as shown.
test("with a site.js older than 1.7.0, a second argument to site.h that is not its props shows nothing", () => {
  const dir = blankSite(`site.head({ title: "Livraria Lello" });
document.getElementById("list").replaceChildren(site.h("article", { "class": "card" }, site.h("h2", "Opening hours"), site.h("p", "Every day, 9:00 AM–7:30 PM")));
`);
  try {
    assert.equal(run("check", dir, "--expect", "Livraria Lello, Opening hours, Every day").status, 0);
    const siteJs = path.join(dir, "site.js");
    fs.writeFileSync(siteJs, fs.readFileSync(siteJs, "utf8").replace(/version: "[\d.]+"/, 'version: "1.6.1"'));
    const old = run("check", dir, "--expect", "Livraria Lello, Opening hours, Every day");
    assert.equal(old.status, 1, old.stdout);
    assert.match(old.stdout, /^MISSING: the request named 2 item\(s\) the site does not show: Opening hours, Every day\.$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page written in JSX, TypeScript or a framework's components keeps its words where the check reads no text: every
// item such a page showed was reported missing.
test("an item whose words are in page code the check does not read as a script is one it cannot tell about", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-jsx-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><title>Porto</title><div id="root"></div><script type="module" src="/src/main.jsx"></script>\n');
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "App.jsx"), "export default function App() {\n  return <main><h2>Livraria Lello</h2></main>;\n}\n");
    const out = run("check", dir, "--expect", "Porto, Livraria Lello, Palácio da Bolsa", "--json");
    assert.equal(out.status, 1, out.stdout);
    const json = JSON.parse(out.stdout);
    assert.deepEqual([json.shown.map((s) => s.item), json.unknown, json.missing, json.unread], [["Porto"], ["Livraria Lello"], ["Palácio da Bolsa"], ["src/App.jsx"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The check says an item is missing only when it could have seen it.
test("an item whose words a script holds where the check cannot place them, or that it fetches from another site, is never reported missing (exit 2)", () => {
  const dir = blankSite(`var heading = "Opening hours";
var card = document.createElement("article");
card.innerHTML = "<h2>" + heading + "</h2>";
document.getElementById("list").appendChild(card);
`);
  try {
    const out = run("check", dir, "--expect", "New page, Opening hours");
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /MISSING/);
    assert.match(out.stdout, /^UNREAD: app\.js may draw .*, so the check cannot tell whether the page shows: Opening hours\.$/m);
    assert.match(out.stdout, /1 of 2 expected item\(s\) shown: New page\./);
    const json = JSON.parse(run("check", dir, "--expect", "Opening hours", "--json").stdout);
    assert.deepEqual([json.ok, json.missing, json.unknown, json.unread], [false, [], ["Opening hours"], ["app.js"]]);
    // every item it can see: a pass
    assert.equal(run("check", dir, "--expect", "New page").status, 0);
    // an item no file names is missing
    const lost = run("check", dir, "--expect", "Opening hours, Closing day");
    assert.equal(lost.status, 1, lost.stdout);
    assert.match(lost.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Closing day\.$/m);
    // unless a script fetches text from another site while the page runs
    fs.appendFileSync(path.join(dir, "app.js"), 'fetch("https://hours.example/today").then((r) => r.text()).then((t) => { card.textContent = t; });\n');
    const fetched = JSON.parse(run("check", dir, "--expect", "Opening hours, Closing day", "--json").stdout);
    assert.deepEqual([fetched.missing, fetched.unknown, fetched.unread], [[], ["Opening hours", "Closing day"], ["app.js"]]);
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
    assert.match(problems[0], /^Latest eligible model 1: nothing says where this row comes from\. Cite the page you read that names it \(a value's "src" and "url", or "sources": \[\{"url"\}\]\)\. When only a search result names it, put that result's site in "found"/);
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
  // a page read: a value's (a value or "Not found") or a "sources" entry, each with its https page
  assert.deepEqual(uncitedRows(data([
    row("A", { facts: { price: { v: "€399", ...page } } }),
    row("B", { facts: { price: { ...page } } }),
    row("C", { sources: [{ name: "Review One", url: page.url }] }),
    row("D", { more: [{ label: "Mop", fact: { v: "none", ...page } }] }),
    // a source is its page: the starter names it by its site, so it needs no name of its own
    row("E", { sources: [{ url: page.url }] }),
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

// A new chat asked for "a simple comparison page of two laptops from what you already know, without browsing", and every row of the page said "checked 1 Mar 2025 on maker.example" with nothing read: the starter had no
// honest form for what Octo knows, and the check asked each value for the page it was read on. A page asked for that
// way says so ("from": "memory"): its rows and values pass without pages, and any address or day on it fails.
test("a page from what Octo knows passes without pages, and fails with any page or day on it", () => {
  const remembered = () => ({
    title: "Maker Laptop 13 vs 16",
    lede: "The 16 is the bigger one, with room for a graphics card.",
    from: "memory",
    columns: [{ key: "display", label: "Display", type: "text" }, { key: "weight", label: "Weight", type: "text" }, { key: "price", label: "Price", type: "price" }],
    items: [
      { ref: "laptop:13", name: "Maker Laptop 13", why: "Small and light", facts: { display: { v: "13.5 in" }, weight: { v: "about 1.3 kg" }, price: { v: "from about $1,000" } } },
      { ref: "laptop:16", name: "Maker Laptop 16", why: "Room for a graphics card", facts: { display: { v: "16 in" }, weight: { v: "about 2.1 kg" }, price: { note: "not known" } } },
    ],
    unchecked: ["Today's prices and configurations"],
  });
  const expect = "Maker Laptop 13, Maker Laptop 16";
  const dir = optionsSite("compare", remembered);
  const file = path.join(dir, "data.json");
  try {
    assert.deepEqual(checkValues(dir).problems, []);
    const out = run("check", dir, "--expect", expect);
    assert.equal(out.status, 0, out.stdout);
    assert.deepEqual(uncitedRows(remembered()), []);
    // the same rows on a page that doesn't say so: each value lacks its page, and no row says where it comes from
    const { from, ...unsaid } = remembered();
    fs.writeFileSync(file, JSON.stringify(unsaid));
    assert.equal(checkValues(dir).problems.length, 7, checkValues(dir).problems.join("\n"));
    // an address or a day on it claims a check that never happened: the row's values and sources, and the page's own
    const data = remembered();
    data.items[0].facts.display = { v: "13.5 in", src: "Maker", url: "https://maker.example/products/laptop13", date: "2025-03-01" };
    data.items[1].sources = [{ name: "Maker", url: "https://maker.example/products/laptop16" }];
    data.checked = { asof: "2025-03-01" };
    fs.writeFileSync(file, JSON.stringify(data));
    const { problems } = checkValues(dir);
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /^Maker Laptop 13: this page is from what Octo knows \("from": "memory"\), so nothing on it was read: leave out its "src", "url" and "date"\. Each value is only its "v" \(or a "note"\), and reads "<value>, not checked"\./);
    assert.match(problems[1], /^Maker Laptop 16: .* leave out its "url"\./);
    assert.match(problems[2], /^the page: .* leave out its "asof"\./);
    const failed = run("check", dir, "--expect", expect);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stdout, /^VALUES: 3 value\(s\) to fix in data\.json:$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page from what Octo knows: its columns are its own, so a "Released" column keyed "date" is a value, not the day a
// page was read. A value's source claims a page nobody read; a store made the page offer a price check, which on such a
// page has no store link to read, or puts a checked price under "nothing checked"; and under a filter no value counted
// as known, so every row was listed apart from the limit. Each fails. Only the compare starter draws such a page: a
// ranked page marked so fails once, and is not asked for pages.
test("a page from what Octo knows keeps its own columns, and fails a source, a store, a filter, or a starter that can't draw it", () => {
  const remembered = () => ({
    title: "Maker Laptop 13 vs 16",
    lede: "The 16 is the bigger one.",
    from: "memory",
    columns: [{ key: "date", label: "Released", type: "text" }, { key: "url", label: "Website", type: "text" }, { key: "store", label: "Sold at", type: "text" }, { key: "price", label: "Price", type: "price" }],
    items: [
      { ref: "laptop:13", name: "Maker Laptop 13", facts: { date: { v: "2021" }, url: { v: "maker.example" }, store: { v: "The maker's own shop" }, price: { v: "from about $1,000" } } },
      { ref: "laptop:16", name: "Maker Laptop 16", facts: { date: { v: "2024" }, url: { v: "maker.example" }, store: { v: "The maker's own shop" }, price: { v: "from about $1,400" } } },
    ],
  });
  const expect = "Maker Laptop 13, Maker Laptop 16";
  const dir = optionsSite("compare", remembered);
  const file = path.join(dir, "data.json");
  try {
    assert.deepEqual(checkValues(dir).problems, []);
    const out = run("check", dir, "--expect", expect);
    assert.equal(out.status, 0, out.stdout);
    const data = remembered();
    data.items[0].facts.price = { v: "from about $1,000", src: "Maker" };
    data.items[1].store = { name: "Maker", readable: true };
    data.filter = { key: "price", max: 1500, label: "Under $1,500" };
    fs.writeFileSync(file, JSON.stringify(data));
    const { problems, notes } = checkValues(dir);
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.match(problems[0], /^Maker Laptop 13: this page is from what Octo knows .* leave out its "src"\./);
    assert.match(problems[1], /^Maker Laptop 16: this page is from what Octo knows .* leave out its "store"\./);
    assert.match(problems[2], /^the filter "Under \$1,500": nothing on a page from what Octo knows was checked, so no value on it counts as within the limit\. Leave out "filter"/);
    assert.deepEqual(notes, [], "no note asks the lede to call the remembered prices unknown");
    assert.equal(run("check", dir, "--expect", expect).status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ranked = optionsSite("ranked", (data) => ({
    ...data,
    from: "memory",
    items: data.items.map(({ ref, rank, name, why }) => ({ ref, rank, name, why, price: { v: "about $100" }, specs: [{ v: "about 9 oz" }] })),
  }));
  try {
    const { problems } = checkValues(ranked);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^the page: only the compare starter \("columns" and "items"\) draws a page from what Octo knows \("from": "memory"\)\./);
  } finally {
    fs.rmSync(ranked, { recursive: true, force: true });
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

// A page is served from its own folder, as its card serves it. A new chat's page loaded another chat's page's files
// ("../framework-laptops/site.js"): served on its own it could not load them, and it changed whenever that page did.
// The check fails a page that loads a file from outside its folder (an element's src, srcset or a <link>'s href, a
// style's url() or @import, a path a script names) and names the command that gives it its own. A link to another
// page is no load, and addresses of other sites and paths that stay inside are the page's own.
test("check fails a page that loads a file from outside its folder, and names the command that gives it its own", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-outside-"));
  try {
    const dir = path.join(parent, "page");
    fs.mkdirSync(path.join(dir, "js"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Trip</title>
<link rel="stylesheet" href="theme.css"><link rel="icon" href="/icon.png">
<h1>Porto in a day</h1>
<a href="../other/index.html">the other plan</a>
<img src="https://cdn.example/a.png" srcset="img/a.png 1x, ../other/b.png 2x" alt="">
<script src="__bind/client.js"></script><script src="../other/site.js"></script><script src="js/app.js"></script>
<script>fetch("../other/data.json").then(() => {});</script>
<!-- <script src="../old/app.js"></script> -->`);
    fs.writeFileSync(path.join(dir, "theme.css"), "@import '../other/theme.css'; body { background: url(img/bg.png) } .x { background: url(data:image/png;base64,AAAA) }");
    // a script reads a path from the page, or imports it from its own folder: this one stays inside either way
    fs.writeFileSync(path.join(dir, "js", "app.js"), 'fetch("../data.json"); import("./util.js");');
    assert.deepEqual(checkSite(dir, ["Porto in a day"]).outside, [
      { file: "index.html", loads: ["../other/data.json", "../other/b.png", "../other/site.js"] },
      { file: "theme.css", loads: ["../other/theme.css"] },
    ]);
    const out = run("check", dir, "--expect", "Porto in a day");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    const lines = out.stdout.trim().split("\n");
    assert.equal(lines[0], `OUTSIDE: index.html loads ../other/data.json, ../other/b.png and ../other/site.js; theme.css loads ../other/theme.css, from outside ${dir}. A page is served from its own folder, so there it can't load them, and it would change whenever that other folder does.`);
    assert.equal(lines[1], `Give it its own files: \`instafy bind init ${dir} --starter blank\` adds the starter's files it lacks and keeps yours. Copy ../other/data.json and ../other/b.png into its folder too. Load each from the page's own folder (data.json, not ../other/data.json), then check again.`);
    assert.match(out.stdout, /^1 of 1 expected item\(s\) shown: Porto in a day\.$/m);
    // with nothing else to check, it still fails
    assert.equal(run("check", dir).status, 1);
    assert.deepEqual(JSON.parse(run("check", dir, "--expect", "Porto in a day", "--json").stdout).init, `instafy bind init ${dir} --starter blank`);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a path climbs out of a site's folder only above its top, and a page's <base href> moves where it starts", () => {
  const out = { out: true };
  const at = (file, rooted = false) => ({ path: file, rooted });
  for (const [ref, from, base, served] of [
    ["../other/site.js", "", null, out], ["./../other/site.js", "", null, out], ["a/../../x.js", "", null, out], ["..\\other\\x.js", "", null, out],
    ["%2e%2e/other/x.js", "", null, out], ["../../x.js", "sub", null, out], ["../theme.css", "sub", null, at("theme.css")],
    ["a/../x.js", "", null, at("x.js")], ["theme.css?v=2", "", null, at("theme.css")], ["/theme.css", "sub", null, at("theme.css", true)],
    ["/sites/other/site.js", "", null, at("sites/other/site.js", true)], ["//cdn.example/x.js", "", null, null],
    ["https://cdn.example/x.js", "", null, null], ["data:image/png;base64,AAAA", "", null, null], ["#top", "", null, null], ["", "", null, null],
    // relative paths start from the page's <base href>
    ["site.js", "", "../other/", out], ["site.js", "", "../other/index.html", out], ["site.js", "", "/sites/other/", at("sites/other/site.js", true)],
    ["site.js", "", "js/", at("js/site.js")], ["site.js", "", "page.html", at("site.js")], ["site.js", "", "https://cdn.example/lib/", null],
    ["/theme.css", "", "../other/", at("theme.css", true)],
  ]) assert.deepEqual(servedPath(ref, from, base), served, `${ref} from "${from}" under ${base}`);
});

// A page is served from its own folder at "/". A path from that root that names no file of the folder but one of a
// folder above it ("/sites/framework-laptops/site.js", or "/framework-laptops/site.js" as a folder of sites serves it),
// a <base href> that moves the page's paths into another folder, and a link in the folder to another folder's file
// (the binder never serves one) each load another page's files: served on its own, the page gets 404s for them. The
// check fails each with the init line. A path from the root to a file of its own folder, a missing icon, an address of
// another site, a data: URL, the binder's own files and a link that points at a page still pass.
test("check fails a page that loads another page's files by a path from the root, through its <base href> or a link", () => {
  const space = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-root-"));
  try {
    const sites = path.join(space, "sites");
    const first = path.join(sites, "framework-laptops");
    execFileSync(process.execPath, [BIN, "init", first, "--starter", "compare"], { env: cleanEnv });
    const page = (name, html, files = {}) => {
      const dir = path.join(sites, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Two laptops</title>${html}<h1>Framework Laptop 13</h1>`);
      for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
      return dir;
    };
    const fails = (dir, loads, init) => {
      const name = path.relative(sites, dir);
      const out = run("check", dir, "--expect", "Framework Laptop 13");
      assert.equal(out.status, 1, `${name}: ${out.stdout}${out.stderr}`);
      assert.deepEqual(checkSite(dir, ["Framework Laptop 13"]).outside, loads, name);
      assert.match(out.stdout, new RegExp(`^Give it its own files: .*\`instafy bind init ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --starter ${init}\``, "m"), `${name}: ${out.stdout}`);
      return out.stdout;
    };
    const root = page("root-path", '<link rel="stylesheet" href="/sites/framework-laptops/theme.css"><script src="/sites/framework-laptops/site.js"></script><script src="/sites/framework-laptops/app.js"></script>');
    const said = fails(root, [{ file: "index.html", loads: ["/sites/framework-laptops/theme.css", "/sites/framework-laptops/site.js", "/sites/framework-laptops/app.js"] }], "compare");
    assert.match(said, /Load each from the page's own folder \(theme\.css, not \/sites\/framework-laptops\/theme\.css\), then check again\.$/m);
    fails(page("gallery-path", '<script src="/framework-laptops/app.js"></script>'), [{ file: "index.html", loads: ["/framework-laptops/app.js"] }], "compare");
    fails(page("base-out", '<base href="../framework-laptops/"><link rel="stylesheet" href="theme.css"><script src="app.js"></script>'), [{ file: "index.html", loads: ["theme.css", "app.js"] }], "compare");
    fails(page("base-root", '<base href="/sites/framework-laptops/"><script src="app.js"></script>'), [{ file: "index.html", loads: ["app.js"] }], "compare");
    // a script's path from the root, and an import map's path
    fails(page("script-root", '<script src="app.js"></script>', { "app.js": 'fetch("/sites/framework-laptops/data.json"); site.post("/api/save");' }), [{ file: "app.js", loads: ["/sites/framework-laptops/data.json"] }], "blank");
    fails(page("import-map", '<script type="importmap">{"imports": {"app": "../framework-laptops/app.js"}}</script>'), [{ file: "index.html", loads: ["../framework-laptops/app.js"] }], "compare");
    // links to the other page's files: theme.css and site.js, and a folder of pictures
    const linked = page("linked", '<link rel="stylesheet" href="theme.css"><script src="site.js"></script><img src="img/a.png" alt="">');
    fs.symlinkSync(path.join(first, "theme.css"), path.join(linked, "theme.css"));
    fs.symlinkSync("../framework-laptops/site.js", path.join(linked, "site.js"));
    fs.mkdirSync(path.join(first, "pictures"));
    fs.symlinkSync("../framework-laptops/pictures", path.join(linked, "img"));
    const links = fails(linked, [{ file: "img", link: "../framework-laptops/pictures" }, { file: "site.js", link: "../framework-laptops/site.js" }, { file: "theme.css", link: "../framework-laptops/theme.css" }], "blank");
    assert.match(links, /^OUTSIDE: img is a link to \.\.\/framework-laptops\/pictures; site\.js is a link to \.\.\/framework-laptops\/site\.js; theme\.css is a link to \.\.\/framework-laptops\/theme\.css, from outside /m);
    assert.match(links, /^Give it its own files: delete the links first \(img, site\.js and theme\.css; that leaves the files they point to alone\), then `instafy bind init .* --starter blank` adds the starter's files it lacks and keeps yours\. Copy \.\.\/framework-laptops\/pictures into its folder too\. Then check again\.$/m);

    // the page's own files from the root, a missing icon, other sites, data: and the binder's own files pass
    const own = page("own", `<link rel="stylesheet" href="/theme.css"><link rel="icon" href="/favicon.ico"><link rel="canonical" href="../framework-laptops/">
<script src="/__bind/client.js"></script><script src="https://cdn.jsdelivr.net/npm/x@1.0.0/x.js"></script><img src="data:image/png;base64,AAAA" alt="">
<a href="/sites/framework-laptops/">the other comparison</a><script src="/js/app.js"></script><img src="/my%20photo.png" alt="">
<script type="application/ld+json">{"url": "../framework-laptops/index.html"}</script>`, { "theme.css": "body { background: url(/img/bg.png) }", "data.json": "{}", "my photo.png": "" });
    fs.mkdirSync(path.join(own, "js"));
    fs.writeFileSync(path.join(own, "js", "app.js"), 'fetch("/data.json"); fetch("../data.json");');
    assert.deepEqual(checkSite(own, ["Framework Laptop 13"]).outside, []);
    assert.equal(run("check", own, "--expect", "Framework Laptop 13").status, 0);
  } finally {
    fs.rmSync(space, { recursive: true, force: true });
  }
});
