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
import { TYPED_READ, UNAVAILABLE_KEYS, cardWaits, checkSite, checkValues, htmlLines, htmlText, jsonStrings, names, parseExpect, servedPath, shownLine, typedReads, typedWords, uncheckedRepeats, uncitedRows, unsaidReaders, unsortedNumbers } from "../src/check.mjs";
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
    assert.match(out.stdout, /^Draw each fact with site\.trust\(\{"v", "src", "url", "date", "viewer"\}\), which links the page it was read on/m);
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
      h("p", { class: "trust" }, ["Source: ", h("a", { href: "https://bookshop.example/en/" }, "Livraria Lello"), " · open daily"]),
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

// The check fails a source line only when it can tell: a line linked through a name the script gives site.trust,
// site.cite or a link of its own, or through anything the check cannot read, may well link its page, and a line that
// only says a value is unknown ("Unknown", "To confirm", as site.js says it) names no source. A fact drawn by
// site.trust with a source and no page draws a source line that links nothing, as a line written by hand would.
test("check names a source line only when it can tell it links no page", () => {
  const page = (body) => `(function () {
  var h = site.h;
  site.start({ data: null, render: function () {
    site.head({ title: "Livraria Lello" });
    document.getElementById("list").replaceChildren(${body});
  } });
})();
`;
  const unlinked = (app) => {
    const dir = blankSite(app);
    try {
      return checkSite(dir).unlinked.map((u) => u.line);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const fact = '{ v: "Daily 9:00-19:30", src: "Livraria Lello", url: "https://bookshop.example/en/", date: "2026-11-08" }';
  // site.trust and site.cite through a name of the script's own
  assert.deepEqual(unlinked(`(function () {
  const { h, trust } = site;
  var cite = site.cite, t = window.site.trust;
  site.start({ data: null, render: function () {
    document.getElementById("list").replaceChildren(
      h("p", { "class": "trust" }, "Opening hours: ", trust(${fact})),
      h("p", { "class": "trust" }, "Hours: ", cite(${fact})),
      h("p", { "class": "trust" }, "Also: ", t(${fact})));
  } });
})();
`), []);
  // a link the check cannot see: a function of the page's own, a name that holds one
  assert.deepEqual(unlinked(`(function () {
  var h = site.h;
  function from(f) { return site.link(f.url, site.host(f.url)); }
  var hours = ${fact};
  var a = site.link("https://transit.example/planner", "transit.example");
  site.start({ data: null, render: function () {
    document.getElementById("list").replaceChildren(
      h("p", { "class": "trust" }, "Checked 8 Nov on ", from(hours)),
      h("p", { "class": "trust" }, "Planner: ", a),
      h("p", { "class": "trust" }, ["Route: ", hours.v ? from(hours) : null]));
  } });
})();
`), []);
  // a value nobody found, in site.js's own words, names no source
  assert.deepEqual(unlinked(page(`h("span", { "class": "trust", text: "To confirm" }), h("span", { "class": "trust" }, "Unknown"),
      h("span", { "class": "trust" }, "Price unknown · the shop blocks price checks"), h("span", { "class": "trust" }, "Opening hours to confirm")`)), []);
  // text is text, however it is put together: a sum or a template names no page
  assert.deepEqual(unlinked(page(`h("p", { "class": "trust" }, "Source: " + hours.src + " · checked " + hours.date),
      h("p", { "class": "trust" }, \`Source: \${hours.src}\`), h("p", { "class": "trust" }, "Hours unknown on Livraria Lello · checked 8 Nov")`)),
    ["Source: · checked", "Source:", "Hours unknown on Livraria Lello · checked 8 Nov"]);
  // a fact with its source and no page draws a source line that links nothing; one with its page, an estimate, a value
  // from what Octo knows, and a file's or a script's "src" do not
  assert.deepEqual(unlinked(`(function () {
  var hours = { v: "Daily 9:00-19:30", src: "Livraria Lello", date: "2026-11-08" };
  var media = { v: 2, src: "photo.jpg" }, player = { v: "1.0", src: "https://cdn.example/player.js" };
  var facts = { walk: { "v": "about 10 min", "src": "Octo's estimate", "est": true }, memory: { v: "Open daily" }, linked: ${fact},
    stop: { v: "Lapa", src: "Metro do Porto", url: "metroporto.pt/planner", date: "2026-11-08" } };
  site.start({ data: null, render: function () {
    document.getElementById("list").replaceChildren(site.h("p", null, site.trust(hours)), site.trust(facts.walk), site.trust(facts.memory),
      site.trust(facts.linked), site.trust(facts.stop));
  } });
})();
`), ["Daily 9:00-19:30 · Livraria Lello", "Lapa · Metro do Porto"]);
});

// A page to share captioned a journey planner whose form was never sent "<planner> · checked 20 Nov 2026; no connection
// result", typed as a link's words, and the hours' page "checked 20 Nov 2026 on <site>" the same way: each line links a
// page, so the check passed them. "checked <date>" and "seen <date>" are the words site.trust and site.cite write, from
// how a fact's page was read ("viewer"): the check names each line that types them, linked or not, and the page fails.
test("check fails a typed \"checked <date>\" or \"seen <date>\", linked or not, and passes what site.trust and site.cite draw", () => {
  const typed = `(function () {
  "use strict";
  var museum = "https://museum.example/visit";
  var planner = "https://transit.example/planner";
  site.start({ data: null, render: function () {
    site.head({ title: "A visit to the museum", lede: "Opening hours and how to get there." });
    document.getElementById("list").replaceChildren(
      site.h("section", { "class": "card" },
        site.h("h2", { text: "Opening hours" }),
        site.h("p", { text: "Monday–Sunday · 09:00–17:00" }),
        site.h("p", { "class": "trust" }, site.link(museum, "checked 20 Nov 2026 on museum.example"))),
      site.h("section", { "class": "card" },
        site.h("h2", { text: "From the main station" }),
        site.h("p", { "class": "trust" }, site.link(planner, "Journey planner · checked 20 Nov 2026; no connection result")),
        site.h("p", { "class": "cap" }, site.link(museum, "museum"), " · seen ", "20 Nov"))
    );
  } });
})();
`;
  const lines = ["checked 20 Nov 2026 on museum.example", "Journey planner · checked 20 Nov 2026; no connection result", "museum · seen 20 Nov"];
  const dir = blankSite(typed);
  try {
    const out = run("check", dir, "--expect", "Opening hours");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.ok(out.stdout.startsWith(`TYPED: 3 line(s) say "checked <date>" or "seen <date>" in typed words. Delete those words from each:
- app.js: delete "checked 20 Nov 2026 on museum.example", the whole line.
- app.js: delete "checked 20 Nov 2026", from "Journey planner · checked 20 Nov 2026; no connection result".
- app.js: delete "seen 20 Nov", from "museum · seen 20 Nov".
Only site.trust(fact) and site.cite(fact) write those words, from a fact that says how its page was read (`), out.stdout);
    // each line links its page: it is the typed words that fail it
    assert.doesNotMatch(out.stdout, /UNLINKED/);
    assert.match(out.stdout, /1 of 1 expected item\(s\) shown/);
    const json = JSON.parse(run("check", dir, "--expect", "Opening hours", "--json").stdout);
    assert.deepEqual([json.ok, json.unlinked, json.typed], [false, [], lines.map((line) => ({ file: "app.js", line, words: typedWords(line) }))]);
    // with nothing named to check, the lines are still named
    const bare = run("check", dir);
    assert.equal(bare.status, 1, bare.stdout);
    assert.match(bare.stdout, /^TYPED: 3 line\(s\)/m);

    // the same page with each fact drawn by site.trust or site.cite, the planner linked by its name alone, and a line
    // that says a thing was not checked
    fs.writeFileSync(path.join(dir, "app.js"), `(function () {
  "use strict";
  var museum = "https://museum.example/visit";
  var planner = "https://transit.example/planner";
  var hours = { v: "Monday–Sunday · 09:00–17:00", src: "Museum", url: "https://museum.example/visit", date: "2026-11-20", viewer: "shared browser" };
  site.start({ data: null, render: function () {
    site.head({ title: "A visit to the museum", lede: "Opening hours and how to get there." });
    document.getElementById("list").replaceChildren(
      site.h("section", { "class": "card" },
        site.h("h2", { text: "Opening hours" }),
        site.h("p", null, site.trust(hours))),
      site.h("section", { "class": "card" },
        site.h("h2", { text: "From the main station" }),
        site.h("p", { "class": "trust" }, "Getting there: ", site.cite({ src: "Museum", url: museum, date: "2026-11-20", viewer: "shared browser" })),
        site.h("p", { "class": "trust" }, site.link(planner, "Journey planner")),
        site.h("p", { "class": "trust" }, "A route from the main station: not checked 20 Nov, the planner's form was not sent"),
        site.h("p", { "class": "cap" }, "Read " + when + ", checked " + site.date(hours.date)))
    );
  } });
})();
`);
    const drawn = run("check", dir, "--expect", "Opening hours");
    assert.equal(drawn.status, 0, drawn.stdout + drawn.stderr);
    assert.doesNotMatch(drawn.stdout, /TYPED|UNLINKED/);
    assert.deepEqual(checkSite(dir).typed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a line drawn by hand that links nothing and types the words is named for both
  const both = blankSite(`(function () {
  site.start({ data: null, render: function () {
    document.getElementById("list").replaceChildren(site.h("p", { class: "trust" }, "Source: Livraria Lello · checked November 8, 2026"));
  } });
})();
`);
  try {
    const result = checkSite(both);
    assert.deepEqual([result.unlinked, result.typed], [[{ file: "app.js", line: "Source: Livraria Lello · checked November 8, 2026" }],
      [{ file: "app.js", line: "Source: Livraria Lello · checked November 8, 2026", words: ["checked November 8, 2026"] }]]);
  } finally {
    fs.rmSync(both, { recursive: true, force: true });
  }
});

// The words are read wherever the build types them: a page's own HTML, its scripts (a string the check cannot place
// too) and data.json. A file a command writes (a check's records, a map's layers) may quote a page's own words, and a
// caption a starter draws is never in its files: every starter's own page passes.
test("typed \"checked <date>\" is read from a page's HTML, its scripts and data.json, never from a file a command writes", () => {
  for (const said of ["checked 20 Nov 2026", "Checked on November 8, 2026", "seen 5 Aug", "Seen Sept. 4", "checked 3rd March", "checked 2026-11-20",
    "checked 20.11.2026", "Not found · checked 16 Oct on maker.example", "€549 at Shop · seen 17 Oct"]) assert.match(said, TYPED_READ, said);
  for (const unsaid of ["Walk from Aliados, not checked", "not checked 20 Nov", "Price not checked · the shop blocks price checks", "unchecked 5 May",
    "checked 4 min ago", "I checked 3 hotels", "seen 12 times", "checked ", "Planner: Metro do Porto · 8 Nov", "Check in 20 Nov"]) assert.doesNotMatch(unsaid, TYPED_READ, unsaid);
  assert.deepEqual(typedReads(["Hours:\n  checked 8 Nov", "Hours: checked 8 Nov", "Open daily", `Prices seen 5 Aug ${"x".repeat(200)}`]),
    ["Hours: checked 8 Nov", `Prices seen 5 Aug ${"x".repeat(141)}…`]);

  const html = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-typed-"));
  try {
    fs.writeFileSync(path.join(html, "index.html"), `<!doctype html><title>Visit</title><main><h1>Visit</h1>
<p class="note">Prices seen 5 Aug on <a href="https://shop.example/">shop.example</a></p><p>Not found yet: Night bus · checked 8 Nov</p>
<!-- checked 1 Jan --><script>var caption = "Hours checked 8 Nov 2026"; document.querySelector("h1").title = caption;</script></main>`);
    assert.deepEqual(checkSite(html).typed, ["Prices seen 5 Aug on shop.example", "Not found yet: Night bus · checked 8 Nov", "Hours checked 8 Nov 2026"]
      .map((line) => ({ file: "index.html", line, words: typedWords(line) })));
    assert.equal(run("check", html).status, 1);
  } finally {
    fs.rmSync(html, { recursive: true, force: true });
  }

  const dir = compareSite(["Brooks Ghost 16", "Hoka Arahi 7"]);
  try {
    assert.deepEqual(checkSite(dir).typed, []);
    // what a check's handler wrote, and a map's layer, are not the build's words
    fs.mkdirSync(path.join(dir, "data", "records"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "records", "shoes.json"), JSON.stringify({ records: [{ ref: "shoes:item-0", type: "claim", attr: "price", quote: "Last checked 12 Nov 2026" }] }));
    fs.writeFileSync(path.join(dir, "data", "places.geojson"), JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Shop", note: "seen 5 Aug" } }] }));
    assert.deepEqual(checkSite(dir).typed, []);
    const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
    data.unchecked = ["Review searches: checked 19 Nov on reviews.example.net (no exact match)"];
    data.expect = ["Brooks Ghost 16, seen 5 Aug"];
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
    assert.deepEqual(checkSite(dir).typed, [{ file: "data.json", line: "Review searches: checked 19 Nov on reviews.example.net (no exact match)", words: ["checked 19 Nov on reviews.example.net"] }]);
    const out = run("check", dir, "--expect", "Brooks Ghost 16");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^TYPED: 1 line\(s\) say "checked <date>" or "seen <date>" in typed words\. Delete those words from each:\n- data\.json: delete "checked 19 Nov on reviews\.example\.net", from "Review searches: checked 19 Nov on reviews\.example\.net \(no exact match\)"\.$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  for (const starter of ["compare", "ranked", "timeline", "checklist", "blank"]) {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-starter-"));
    try {
      execFileSync(process.execPath, [BIN, "init", own, "--starter", starter], { env: cleanEnv });
      assert.deepEqual(checkSite(own).typed, [], starter);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  }
});

// A page drew each fact with site.trust or site.cite, as the check asks, and still failed it: an inline fact's "date"
// sits after its value in the script, so a value that ends "… must be checked" read as a typed "checked 2026-11-20", and
// the advice ("draw the fact with site.trust") was what the page already did. A fact's own fields are no words of the
// line around them: each is read on its own, so a fact whose value itself types the caption is still named.
test("a fact site.trust or site.cite draws is never a typed \"checked <date>\", whatever its value ends with", () => {
  const app = (children) => `(function () {
  "use strict";
  var museum = "https://museum.example/visit";
  var cite = site.cite;
  site.start({ data: null, render: function () {
    site.head({ title: "A visit to the museum", lede: "Opening hours and what to bring." });
    document.getElementById("list").replaceChildren(
      site.h("h2", { text: "Opening hours" }),
${children}
    );
  } });
})();
`;
  const drawn = app(`      site.h("p", null, site.trust({ v: "Backpacks and large bags must be checked", src: "Museum", url: museum, date: "2026-11-20", viewer: "shared browser" })),
      site.h("p", null, window.site.trust({ v: "The comet over the tower, last seen", src: "Museum", url: museum, asof: "2026-11-20", viewer: "shared browser" }, { label: "Sighting" })),
      site.h("p", { "class": "trust" }, "Bags are checked ", cite({ src: "Museum", url: museum, date: "2026-11-20", viewer: "shared browser" }), " at the door")`);
  const dir = blankSite(drawn);
  try {
    const out = run("check", dir, "--expect", "Opening hours,Backpacks and large bags must be checked");
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /TYPED|UNLINKED/);
    assert.match(out.stdout, /2 of 2 expected item\(s\) shown/);
    assert.deepEqual(checkSite(dir).typed, []);
    // the fact's value is still a line of the page, with its date, for the items the check looks for
    assert.ok(readScript(drawn).lines.includes("Backpacks and large bags must be checked 2026-11-20 shared browser"));
    assert.deepEqual(readScript(drawn, { apart: true }).lines.slice(3), ["Backpacks and large bags must be checked", "2026-11-20", "shared browser",
      "The comet over the tower, last seen", "2026-11-20", "shared browser", "Sighting", "Bags are checked", "2026-11-20", "shared browser", "at the door"]);

    // words typed around a fact, and a fact whose own value types them, are still named
    fs.writeFileSync(path.join(dir, "app.js"), app(`      site.h("p", null, site.trust({ v: "Open daily · checked 20 Nov 2026", src: "Museum", url: museum, date: "2026-11-20", viewer: "shared browser" })),
      site.h("p", { "class": "trust" }, cite({ src: "Museum", url: museum, date: "2026-11-20" }), " · seen ", "20 Nov")`));
    assert.deepEqual(checkSite(dir).typed, ["Open daily · checked 20 Nov 2026", "· seen 20 Nov"].map((line) => ({ file: "app.js", line, words: typedWords(line) })));
    assert.equal(run("check", dir, "--expect", "Opening hours").status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The check named sentences written for a visitor ("The special exhibition can be seen 3 Oct 2026 to 15 Jan 2027.")
// and lines that say the opposite in other words ("The planner was never checked 20 Nov."), and told the build to
// draw a source caption for them. It passed the same caption typed with a colon or a weekday ("Last checked: 20 Nov
// 2026"). And the line it quoted from a long paragraph was the paragraph's start, without the words it had found.
test("the typed words are a caption's: not a sentence for a visitor or one that says the opposite; a colon or a weekday changes nothing; the line named holds them", () => {
  for (const said of ["Last checked: 20 Nov 2026", "Checked: 2026-11-20", "checked Thu 20 Nov", "seen on Thursday, 20 November", "checked on the 20th of November",
    "checked 20-Nov-2026", "Prices were checked 20 Nov", "Museum · checked 20 Nov 2026 – no result", "Journey planner · checked 20 Nov 2026; no connection result",
    "Hours double-checked 20 Nov", "not found · seen 5 Aug"]) assert.match(said, TYPED_READ, said);
  for (const unsaid of ["The special exhibition can be seen 3 Oct 2026 to 15 Jan 2027.", "The parade can be seen on 12 June from the bridge.",
    "The comet is best seen 12 Aug after midnight.", "First seen 3 Sep 2026 at the trade fair", "Bags are checked 24 Dec to 6 Jan at the door.", "Coats are checked 24 Dec – 6 Jan", "Tickets are checked 2026-12-24 until 2027-01-06",
    "The planner was never checked 20 Nov.", "Route: couldn't be checked 20 Nov, the form was not sent", "The route wasn't checked 20 Nov", "Prices not yet checked 20 Nov",
    "The price hasn't been checked 20 Nov", "Large bags must be checked 20 Nov and after", "checked 20/11", "checked 2/3 of the rooms", "Checked: 3 of 5 rooms", "seen Sunday morning"]) {
    assert.doesNotMatch(unsaid, TYPED_READ, unsaid);
  }

  const long = `The museum sits on an island in the river, a short walk from the old town, and opens every day of the week; its main hall, the mining level and the planetarium each take about an hour, and the tower closes in high wind, so ask at the desk before you climb it (hours checked 20 Nov 2026 on museum.example), and the café on the top floor stays open an hour longer than the halls on Fridays and Saturdays`;
  const [named] = typedReads([long]);
  assert.equal(named, "…in high wind, so ask at the desk before you climb it (hours checked 20 Nov 2026 on museum.example), and the café on the top floor stays open an hour longer th…");
  assert.equal(named.length, 160);
  // the words near a long line's start, or its end, are named with the cut on the other side only
  assert.equal(typedReads([`Prices seen 5 Aug ${"x".repeat(200)}`])[0], `Prices seen 5 Aug ${"x".repeat(141)}…`);
  assert.equal(typedReads([`${"x ".repeat(100)}hours checked 20 Nov 2026 on museum.example`])[0], `…${"x ".repeat(27)}hours checked 20 Nov 2026 on museum.example`);

  const html = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-typed-"));
  try {
    fs.writeFileSync(path.join(html, "index.html"), `<!doctype html><title>Visit</title><main><h1>Visit</h1>
<p>The special exhibition can be seen 3 Oct 2026 to 15 Jan 2027.</p><p>Route: couldn't be checked 20 Nov, the form was not sent</p>
<p>${long}</p><p><a href="https://museum.example/">Museum</a> · checked: 20 Nov 2026</p></main>`);
    assert.deepEqual(checkSite(html).typed, [{ file: "index.html", line: named, words: ["checked 20 Nov 2026 on museum.example"] },
      { file: "index.html", line: "Museum · checked: 20 Nov 2026", words: ["checked: 20 Nov 2026"] }]);
    const out = run("check", html);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /^TYPED: 2 line\(s\) say "checked <date>" or "seen <date>" in typed words\. Delete those words from each:\n- index\.html: delete "checked 20 Nov 2026 on museum\.example", from "…in high wind, .* \(hours checked 20 Nov 2026 on museum\.example\), .*…"\.\n- index\.html: delete "checked: 20 Nov 2026", from "Museum · checked: 20 Nov 2026"\.$/m);
  } finally {
    fs.rmSync(html, { recursive: true, force: true });
  }
});

// A page to share went out saying a journey planner nobody ran was "checked 20 Nov 2026". Its check had named that
// line twice, each time quoting what site.trust draws ("checked 8 Nov on maker.com ↗") as its example: the turn's
// first answer was to reword the caption ("… checked 20 Nov 2026 in Instafy's browser"), and its last to run the
// check and the card's command joined by ";". The fix for typed words is always to delete them, so the check says
// which words, on each line, and quotes nothing the helpers draw, and it says that rewording never passes, the second
// time as the first. A fact that says how its page was read gets "checked" from site.trust or site.cite, and a planner
// nobody ran keeps its name and link.
test("the check says which words to delete on each typed line, quotes nothing the helpers draw, and that rewording never passes", () => {
  for (const [line, words] of [["Hours and distance · Museum on city.example · checked 20 Nov 2026", "checked 20 Nov 2026"],
    ["Tip: go on Thursday. Museum · checked 20 Nov 2026 on museum.example", "checked 20 Nov 2026 on museum.example"],
    ["Last checked: Thu 20 Nov", "checked: Thu 20 Nov"], ["Checked on November 8, 2026, by phone", "Checked on November 8, 2026"],
    ["€549 at Shop · seen 17 Oct", "seen 17 Oct"], ["checked 20-Nov-2026 on shop.example.net.", "checked 20-Nov-2026 on shop.example.net"],
    ["Prices checked 2026-11-20 on the shop's page", "checked 2026-11-20"], ["Open daily", ""]]) assert.deepEqual(typedWords(line), words ? [words] : [], line);
  // a line that has them twice names both, so deleting what the check names passes
  assert.deepEqual(typedWords("Hours checked 20 Nov 2026 on museum.example · €12 · seen 20 Nov"), ["checked 20 Nov 2026 on museum.example", "seen 20 Nov"]);
  const twice = blankSite(`(function () {
  "use strict";
  site.start({ data: null, render: function () {
    site.head({ title: "Tickets" });
    document.getElementById("list").replaceChildren(site.h("p", {}, "Hours checked 20 Nov 2026 · Prices seen 20 Nov"));
  } });
})();
`);
  try {
    assert.match(run("check", twice).stdout, /^- app\.js: delete "checked 20 Nov 2026" and "seen 20 Nov", from "Hours checked 20 Nov 2026 · Prices seen 20 Nov"\.$/m);
  } finally {
    fs.rmSync(twice, { recursive: true, force: true });
  }

  const page = (hours, planner) => `(function () {
  "use strict";
  var museum = "https://museum.example/visit";
  var planner = "https://transit.example/planner?from=Main%20station&to=Museum";
  site.start({ data: null, render: function () {
    site.head({ title: "A visit to the museum", lede: "Opening hours and how to get there." });
    document.getElementById("list").replaceChildren(
      site.h("article", { "class": "card" },
        site.h("h2", { text: "Opening hours" }),
        site.h("p", { text: "Thursday: 10 am–8 pm" })),
      site.h("footer", { "class": "notes" },
        ${hours},
        ${planner})
    );
  } });
})();
`;
  const typedHours = 'site.h("p", {}, "Hours · ", site.link(museum, "Museum on museum.example"), " · checked 20 Nov 2026")';
  const typedPlanner = (said) => `site.h("p", {}, "Route planner · ", site.link(planner, "City timetable"), " · ${said}; route details not confirmed")`;
  const rewording = "Rewording a line around those words never passes: only deleting them does.";
  const dir = blankSite(page(typedHours, typedPlanner("checked 20 Nov 2026")));
  try {
    const first = run("check", dir, "--expect", "Opening hours");
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.equal(first.stdout, `TYPED: 2 line(s) say "checked <date>" or "seen <date>" in typed words. Delete those words from each:
- app.js: delete "checked 20 Nov 2026", from "Hours · Museum on museum.example · checked 20 Nov 2026".
- app.js: delete "checked 20 Nov 2026", from "Route planner · City timetable · checked 20 Nov 2026; route details not confirmed".
Only site.trust(fact) and site.cite(fact) write those words, from a fact that says how its page was read ({"v", "src", "url", "date", "viewer"}): where a line is about such a fact, that call goes in the words' place. A tool or a form nobody ran has no such fact: its line keeps its name and its link and says "not run", with no day. A day that is the page's own content, not when a source was read, goes in a cell or field of its own.
Rewording a line around those words never passes: only deleting them does.
1 of 1 expected item(s) shown: Opening hours.
Read 2 file(s): the HTML text, the data files, and the text the page's scripts pass to site.h and site.head or hold in their lists and objects.
`);
    // nothing a helper draws is quoted: the arrow of a drawn link, a day beside a site's name
    assert.doesNotMatch(first.stdout, /↗|maker\.com|\d on [a-z]+\.com/);

    // the caption reworded, as that turn did: the same lines, and the check says again that rewording never passes
    fs.writeFileSync(path.join(dir, "app.js"), page(typedHours.replace("checked 20 Nov 2026", "checked 20 Nov 2026 in the browser"), typedPlanner("checked 20 Nov 2026 in the browser")));
    const reworded = run("check", dir, "--expect", "Opening hours");
    assert.equal(reworded.status, 1, reworded.stdout);
    assert.match(reworded.stdout, /^- app\.js: delete "checked 20 Nov 2026", from "Route planner · City timetable · checked 20 Nov 2026 in the browser; route details not confirmed"\.$/m);
    assert.ok(reworded.stdout.includes(`goes in a cell or field of its own.\n${rewording}\n1 of 1 expected item(s) shown`), reworded.stdout);

    // the words deleted: the hours' page drawn as the fact it is, the planner linked by its name, "not run", no day
    fs.writeFileSync(path.join(dir, "app.js"), page('site.h("p", {}, "Hours · ", site.cite({ src: "Museum", url: museum, date: "2026-11-20", viewer: "shared browser" }))',
      'site.h("p", {}, "Route planner · ", site.link(planner, "City timetable"), " · not run")'));
    const passed = run("check", dir, "--expect", "Opening hours");
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.doesNotMatch(passed.stdout, /TYPED|Rewording/);
    // the check keeps nothing of itself in the site's folder
    assert.equal(fs.existsSync(path.join(dir, ".bind", "check.json")), false);
    assert.deepEqual(checkSite(dir).files, ["app.js", "index.html"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // A page that logs someone's own checks is still named where a line says "<thing> checked <day>": those are a
  // caption's words too ("Hours checked 8 Nov"), and nothing in them tells the two apart. With each day in a cell of
  // its own, as the check says of a day that is the page's own content, nothing is typed.
  const log = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-log-"));
  try {
    const page = (rows) => `<!doctype html><title>Car log</title><main><h1>Car log</h1>${rows}</main>`;
    fs.writeFileSync(path.join(log, "index.html"), page("<ul><li>Tyres checked 3 Nov</li><li>Oil checked 12 Oct</li></ul>"));
    assert.deepEqual(checkSite(log).typed.map((t) => t.line), ["Tyres checked 3 Nov", "Oil checked 12 Oct"]);
    assert.match(run("check", log).stdout, /A day that is the page's own content, not when a source was read, goes in a cell or field of its own\.$/m);
    fs.writeFileSync(path.join(log, "index.html"), page("<table><tr><th>Part</th><th>Checked</th></tr><tr><td>Tyres</td><td>3 Nov</td></tr><tr><td>Oil</td><td>12 Oct</td></tr></table>"));
    assert.deepEqual(checkSite(log).typed, []);
  } finally {
    fs.rmSync(log, { recursive: true, force: true });
  }

  // typed inside a fact that says how its page was read: the helper draws that fact's caption already
  const options = compareSite(["Brooks Ghost 16", "Hoka Arahi 7"]);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(options, "data.json"), "utf8"));
    data.items[0].facts = { weight: { v: "9.5 oz, checked 19 Nov 2026", src: "Brooks", url: "https://brooks.example/ghost-16", date: "2026-11-19", viewer: "server fetch" } };
    data.items[1].facts = { weight: { v: "9.9 oz, seen 19 Nov", src: "A search", url: "https://hoka.example/arahi-7", date: "2026-11-19", viewer: "search result" } };
    fs.writeFileSync(path.join(options, "data.json"), JSON.stringify(data));
    assert.deepEqual(checkSite(options).typed, [{ file: "data.json", line: "9.5 oz, checked 19 Nov 2026", words: ["checked 19 Nov 2026"], fact: true },
      { file: "data.json", line: "9.9 oz, seen 19 Nov", words: ["seen 19 Nov"] }]);
    const out = run("check", options, "--expect", "Brooks Ghost 16");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^- data\.json: delete "checked 19 Nov 2026", from "9\.5 oz, checked 19 Nov 2026"\. Its fact says how its page was read, so site\.trust\(fact\) or site\.cite\(fact\) writes them from its "date" and "viewer"\.$/m);
    assert.match(out.stdout, /^- data\.json: delete "seen 19 Nov", from "9\.9 oz, seen 19 Nov"\.$/m);
  } finally {
    fs.rmSync(options, { recursive: true, force: true });
  }
});

// A line longer than the check quotes was cut to 160 characters before the words to delete were read from it: past
// the cut, a second "seen 20 Nov" went unnamed, and a caption at the cut was named only in part ("checked 20 Nov"),
// so deleting what the check named left "2026 on museum.example" on a page whose next check passed. The words come
// from the whole line, and only the quote of it is cut. A check that found typed words also said "the check before
// this one named typed words here too" after the card's own command, after a check that named other lines, and in a
// copied folder: no check keeps anything of itself, and each says what rewording does.
test("the words to delete come from the whole line, however long, and every check says rewording never passes", () => {
  const lead = "The museum is open daily from ten in the morning and has a garden, a shop, two galleries, a library, a cafe and a hall.";
  const first = "Hours checked 20 Nov 2026 on museum.example. The museum is open daily from ten in the morning, has a garden, a shop, two galleries, a library and a cafe. Prices seen 20 Nov";
  const second = `${lead} Hours checked 20 Nov 2026 on museum.example.`;
  assert.ok(first.length > 160 && second.length > 160);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-long-"));
  const page = (lines) => `<!doctype html><title>The museum</title><main><h1>The museum</h1>${lines.map((line) => `<p>${line}</p>`).join("\n")}</main>`;
  try {
    fs.writeFileSync(path.join(dir, "index.html"), page([first, second]));
    assert.deepEqual(checkSite(dir).typed.map((t) => t.words), [["checked 20 Nov 2026 on museum.example", "seen 20 Nov"], ["checked 20 Nov 2026 on museum.example"]]);
    const out = run("check", dir, "--expect", "The museum");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^- index\.html: delete "checked 20 Nov 2026 on museum\.example" and "seen 20 Nov", from "Hours checked 20 Nov 2026 on museum\.example\. The museum .*…"\.$/m);
    assert.match(out.stdout, /^- index\.html: delete "checked 20 Nov 2026 on museum\.example", from "The museum is open daily .*…"\.$/m);
    assert.match(out.stdout, /^Rewording a line around those words never passes: only deleting them does\.$/m);
    assert.doesNotMatch(out.stdout, /check before this one/);
    assert.equal(JSON.parse(run("check", dir, "--expect", "The museum", "--json").stdout).typedAgain, undefined);

    // deleting exactly the words named leaves nothing typed, and no stray year or site
    let html = page([first, second]);
    for (const words of ["checked 20 Nov 2026 on museum.example", "seen 20 Nov"]) html = html.replaceAll(words, "");
    fs.writeFileSync(path.join(dir, "index.html"), html);
    const passed = run("check", dir, "--expect", "The museum");
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.doesNotMatch(passed.stdout, /TYPED|Rewording/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /2026|museum\.example/);

    // a later page with another typed line reads as a first check, and the check writes nothing in the site's folder
    fs.writeFileSync(path.join(dir, "index.html"), page(["Tickets €12 · seen 21 Nov"]));
    const later = run("check", dir, "--expect", "Tickets");
    assert.match(later.stdout, /^- index\.html: delete "seen 21 Nov", from "Tickets €12 · seen 21 Nov"\.$/m);
    assert.doesNotMatch(later.stdout, /check before this one/);
    assert.equal(fs.existsSync(path.join(dir, ".bind", "check.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The value check told a turn to say how a value was read in "viewer", and quoted a drawn caption as its example
// ("checked 27 Oct on maker.com"): written that way, the typed-words scan held the card for words the page never shows,
// and its answer, to delete them, deleted the reader site.trust needs. A fact's "viewer" names its reader: it is never
// drawn, so it is no typed line, and the value check names readers as its example.
test("a fact's \"viewer\" is never a typed line, and the value check's example for it is a reader", () => {
  const dir = optionsSite("compare", (data) => {
    data.items[2].facts.rating = { v: "4.4 of 5", src: "Maker" };
    return data;
  });
  try {
    const [problem] = checkValues(dir).problems;
    assert.match(problem, /^Option C · Rating: "4\.4 of 5" has no "url" \(the page\) or "date" \(the day\): add the page that gives this value and the day you read it, and its reader in "viewer" \("server fetch", "shared browser" or "personal browser"\)\. /);
    assert.doesNotMatch(problem, /checked \d|seen \d/);
    const file = path.join(dir, "data.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.items[2].facts.rating = { v: "4.4 of 5", src: "Maker", url: "https://maker.example/c", date: "2026-10-27", viewer: "checked 27 Oct on maker.example" };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    assert.deepEqual(checkSite(dir).typed, []);
    assert.doesNotMatch(run("check", dir, "--expect", "Option C").stdout, /TYPED/);
    // the fact's own value still is one
    data.items[2].facts.rating.v = "4.4 of 5, checked 27 Oct";
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    assert.deepEqual(checkSite(dir).typed.map((t) => t.line), ["4.4 of 5, checked 27 Oct"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A card shows a line under its title: the command's --summary, else the page's own <meta name="description">. Neither
// was read for typed words, so "checked <date>" could reach the card of a page that passed its check.
test("a page's description is read for typed words, and the card's own command reads its --summary too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-summary-"));
  const page = (description) => `<!doctype html><html><head><title>Museum hours</title><meta name="description" content="${description}"></head><body><main><h1>Museum hours</h1><p>Thursday: 10 am–8 pm</p></main></body></html>`;
  try {
    fs.writeFileSync(path.join(dir, "index.html"), page("Opening hours &amp; prices · checked 20 Nov 2026"));
    assert.deepEqual(checkSite(dir).typed, [{ file: "index.html", line: "Opening hours & prices · checked 20 Nov 2026", words: ["checked 20 Nov 2026"] }]);
    assert.equal(run("check", dir, "--expect", "Museum hours").status, 1);
    assert.match(cardWaits(dir).lines.join("\n"), /^- index\.html: delete "checked 20 Nov 2026", from "Opening hours & prices · checked 20 Nov 2026"\.$/m);

    fs.writeFileSync(path.join(dir, "index.html"), page("Opening hours and prices"));
    assert.equal(cardWaits(dir), null);
    assert.equal(cardWaits(dir, { summary: "3 museums · 2 days" }), null);
    const waits = cardWaits(dir, { summary: "3 museums · prices seen 20 Nov" });
    assert.deepEqual(waits.typed, [{ file: "--summary", line: "3 museums · prices seen 20 Nov", words: ["seen 20 Nov"] }]);
    assert.match(waits.lines.join("\n"), /^- --summary: delete "seen 20 Nov", from "3 museums · prices seen 20 Nov"\.$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

// The check says an item is missing only when it could have seen it: one its files don't say is looked for on the page
// as drawn, and where nothing serves the page (here: outside a space, with no preview) it cannot tell.
test("an item whose words a script holds where the check cannot place them, or that it fetches from another site, is never reported missing (exit 2)", () => {
  const dir = blankSite(`var heading = "Opening hours";
var card = document.createElement("article");
card.innerHTML = "<h2>" + heading + "</h2>";
document.getElementById("list").appendChild(card);
`);
  try {
    const out = run("check", dir, "--expect", "New page, Opening hours");
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /MISSING|UNREAD/);
    assert.match(out.stdout, /^Nothing serves the page yet, so the check cannot tell whether it shows: Opening hours\. Look at it where it is served: `instafy preview check --port <its port>`\.$/m);
    assert.match(out.stdout, /1 of 2 expected item\(s\) shown: New page\./);
    const json = JSON.parse(run("check", dir, "--expect", "Opening hours", "--json").stdout);
    assert.deepEqual([json.ok, json.missing, json.unknown, json.unread, json.drawn], [false, [], ["Opening hours"], ["app.js"], { port: null, error: "nothing serves the page" }]);
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

// The check names each line that sets HTML from a string, so the turn redraws it with site.h and site.trust. A line
// that only empties an element draws nothing, and words that only mention innerHTML (in a string, a comment, a
// regular expression or a page's own text) set nothing: none of them is named.
test("the check names each line that sets HTML from a string, and no line that only empties an element or mentions innerHTML", () => {
  const dir = blankSite(`var list = document.getElementById("list");
list.innerHTML = ''; // clear the list
list.innerHTML = ""; list.append(document.createElement("p"));
var tip = document.createElement("p");
tip.textContent = "Use el.innerHTML = x never";
// list.innerHTML = rows.join("");
/* list.innerHTML = rows.join(""); */
var re = /\\.innerHTML\\s*=/;
var note = \`
list.innerHTML = rows;
\`;
if (list.innerHTML === "") list.dataset.empty = "1";
var old = list.innerHTML;
list.innerHTML = "<li>" + old + "</li>";
list.innerHTML = ""; list.innerHTML = old;
list.insertAdjacentHTML("beforeend", old);
list.innerHTML += old;
list.outerHTML = old;
`);
  try {
    assert.deepEqual(checkSite(dir).markup.map((m) => [m.file, m.line]), [14, 15, 16, 17, 18].map((line) => ["app.js", line]));
    // an HTML page: its own scripts' lines, never its text
    fs.writeFileSync(path.join(dir, "app.js"), "site.head({ title: \"New page\" });\n");
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8")
      .replace('<section id="list"></section>', '<section id="list"><p>Never set el.innerHTML = x with what a page said.</p></section>')
      .replace('<script src="app.js"></script>', '<script src="app.js"></script>\n<script>\n  var box = document.getElementById("list");\n  box.innerHTML = ""; // emptied\n  box.innerHTML = window.saved;\n</script>');
    fs.writeFileSync(path.join(dir, "index.html"), html);
    const at = html.split("\n").findIndex((line) => line.includes("box.innerHTML = window.saved")) + 1;
    assert.deepEqual(checkSite(dir).markup.map((m) => [m.file, m.line, m.code]), [["index.html", at, "box.innerHTML = window.saved;"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A comparison's line under its title is the compare starter's own, from its sorts and cells, and data.json's "lede" is
// not drawn: an item only that lede names is not on the page, and the check says the lede isn't drawn. A page made
// before keeps its own app.js, which draws the lede, so there it counts.
test("a comparison's stored lede isn't drawn, so an item only it names is missing; on a page made before it still counts", () => {
  const dir = compareSite(["Option A", "Option B", "Option C"]);
  try {
    const file = path.join(dir, "data.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.lede = "Option D isn't sold here, so it has no row.";
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    const out = run("check", dir, "--expect", "Option A, Option B, Option C, Option D");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Option D\.$/m);
    assert.match(out.stdout, /^NOTE: data\.json's "lede" is not drawn: the line under a comparison's title comes from its sorts and cells\. Say in the reply what it says\.$/m);
    // a page made before: its own app.js draws the lede
    fs.writeFileSync(path.join(dir, "app.js"), 'site.start({ data: "data.json", render: function (data) { site.head(data); } });\n');
    const before = run("check", dir, "--expect", "Option A, Option B, Option C, Option D");
    assert.equal(before.status, 0, before.stdout + before.stderr);
    assert.doesNotMatch(before.stdout, /lede/);
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

// A comparison captioned what a web search's excerpts said "checked 19 Nov on <site>" (a local test, Nov 19): its data
// gave each value a source and a day and never said how it was read ("viewer"), and the check passed it. A page now
// shows such a value's page alone (site.readThere), and the check names each one, so the build can say how it read the
// ones it read on their pages. A note, never a failure: the page says nothing untrue without it.
test("check names each value that gives a day and not how it was read, and never fails it", () => {
  const DAY = "2026-11-19";
  const dir = optionsSite("compare", (data) => {
    data.columns = [{ key: "price", label: "Price", type: "price" }, { key: "review", label: "Independent review", type: "text" },
      { key: "weight", label: "Weight", type: "text" }];
    data.sort = [{ key: "price", label: "Price, low to high", dir: "asc" }];
    data.items = [
      { ref: "option:a", name: "Option A", facts: {
        price: { v: "€349", src: "Shop One · search listing", url: "https://shop-one.example/a", date: DAY },
        review: { v: "A five-star all-rounder", src: "Review One · search result, review not read", url: "https://review-one.example/a", date: DAY },
        weight: { v: "250 g", src: "Maker", url: "https://maker.example/a", date: DAY, viewer: "server fetch" } } },
      { ref: "option:b", name: "Option B", facts: {
        price: { v: "€379", src: "Shop Two", url: "https://shop-two.example/b", date: DAY, viewer: "provider search" },
        review: { v: "Comfortable", src: "Review Two", url: "https://review-two.example/b", date: DAY, viewer: "shared browser" },
        weight: { src: "Maker", url: "https://maker.example/b", date: DAY } } },
      { ref: "option:c", name: "Option C", facts: {
        price: { note: "no shop's page gave a price" },
        review: { v: "Bass-heavy", src: "Review Three", url: "https://review-three.example/c", asof: "2026-10-02" },
        weight: { v: "about 260 g", est: true, url: "https://maker.example/c" } } },
    ];
    return data;
  });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
    assert.deepEqual(unsaidReaders(data), ["Option A · price", "Option A · review", "Option B · weight", "Option C · review"]);
    const values = checkValues(dir);
    assert.deepEqual(values.problems, []);
    const note = values.notes.find((n) => n.includes('"viewer"'));
    assert.equal(note, '4 value(s) give a day but not how they were read ("viewer"), so the page shows each one\'s page alone, never "checked" or "seen": Option A · price, Option A · review, Option B · weight and Option C · review. For each one read on its page, add the reader that read it: "viewer": "server fetch" (instafy web read), "shared browser" or "personal browser" (Instafy\'s browser), or a skill\'s own command. A value only a web search gave gets "provider search".');
    const out = run("check", dir, "--expect", "Option A, Option B, Option C");
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^NOTE: 4 value\(s\) give a day but not how they were read \("viewer"\)/m);
    // each one read on its page says so: nothing is named
    data.items[0].facts.price.viewer = "server fetch";
    data.items[0].facts.review.viewer = "server fetch";
    data.items[1].facts.weight.viewer = "server fetch";
    data.items[2].facts.review.viewer = "uw cite";
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 2));
    assert.deepEqual(unsaidReaders(data), []);
    assert.equal(checkValues(dir).notes.some((n) => n.includes('"viewer"')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // every page, not only a page of options: by what each value is about and its key
  const plan = { title: "A day", days: [{ n: 1, date: DAY, stops: [{ ref: "stop:museum", name: "Museum", time: { v: "10:00", src: "Museum", url: "https://museum.example/hours", date: DAY } },
    { ref: "stop:walk", name: "Walk", time: { v: "11:00", est: true } }] }] };
  assert.deepEqual(unsaidReaders(plan), ["Museum · time"]);
  const list = { title: "Pack", groups: [{ id: "g", title: "Bags", items: [{ ref: "item:plug", text: "A plug adapter", fact: { v: "Type G", src: "Travel advice", url: "https://travel.example/plugs", date: DAY } }] }] };
  assert.deepEqual(unsaidReaders(list), ["A plug adapter · fact"]);
  const ranked = { title: "Top", items: [{ ref: "option:a", rank: 1, name: "Option A", details: [{ label: "Review score", fact: { v: "4.6", src: "Reviews", url: "https://reviews.example/a", date: DAY } }] }] };
  assert.deepEqual(unsaidReaders(ranked), ["Option A · Review score"]);
  // a page from what Octo knows cites nothing, and the check fails anything it cites
  assert.deepEqual(unsaidReaders({ ...list, from: "memory" }), []);
  const timeline = optionsSite("timeline", (data) => {
    data.days[0].stops[1].time = { v: "14:00", src: "Venue booking", url: "https://example.com/booking", date: DAY };
    return data;
  });
  try {
    const values = checkValues(timeline);
    assert.equal(values.checked, false);
    assert.deepEqual(values.problems, []);
    assert.match(values.notes[0], /^1 value\(s\) give a day but not how they were read \("viewer"\), so the page shows each one's page alone, never "checked" or "seen": Sound check · time\./);
  } finally {
    fs.rmSync(timeline, { recursive: true, force: true });
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
    assert.match(problems[2], /^Option C · Rating: "4\.4 of 5" has no "src", "url" \(the page\) or "date" \(the day\): add the page that gives this value and the day you read it, and its reader in "viewer" \("server fetch", "shared browser" or "personal browser"\)\. When no page gives it \(such as a count of what you found, with none found\), leave out "v" and say why in "note"\. Without a source the page shows it as not checked\.$/);
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

// A comparison of three hotels showed one of the nine values the request asked for (a location), and its reply opened
// "The comparison page covers location, reviewer comments and date-specific prices for all three hotels" (a local
// test, Nov 23; the page's data as it was saved is tests/fixtures/hotel-comparison/data.json). Its check had passed,
// counting the hotels it named, never their values. A comparison's check ends with one line for the reply, which the
// reply's first line follows: how many of its values the page shows, in all and per column, in the page's order.
test("a comparison's check ends with how many of its values the page shows, for the reply", () => {
  const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hotel-comparison", "data.json"), "utf8"));
  const expect = ["--expect", saved.items.map((item) => item.name).join(",")];
  const last = (text) => text.trimEnd().split("\n").at(-1);
  const saw = (dir) => {
    const out = run("check", dir, ...expect);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const json = JSON.parse(run("check", dir, ...expect, "--json").stdout);
    assert.equal(Object.keys(json).at(-1), "for_the_reply");
    assert.equal(json.for_the_reply, last(out.stdout));
    return last(out.stdout);
  };
  const dir = optionsSite("compare", () => saved);
  try {
    assert.equal(saw(dir), "The page shows 1 of 9 values: Location 1 of 3, What reviewers say 0 of 3, Price for 12–14 February 0 of 3.");
    // every value read on its page: all nine
    const read = { src: "The hotel's own page", url: "https://hotel.example/stay", date: "2026-11-23", viewer: "shared browser" };
    const all = structuredClone(saved);
    for (const item of all.items) for (const key of Object.keys(item.facts)) item.facts[key] = { v: `${key} of ${item.name}`, ...read };
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(all, null, 2));
    assert.equal(saw(dir), "The page shows 9 of 9 values: Location 3 of 3, What reviewers say 3 of 3, Price for 12–14 February 3 of 3.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The count is of what the compare starter draws (app.js and site.trust): a value with its page or an estimate, and in
// the price column a price a check read, unless that check found the store blocked (the seed is drawn then). A value
// with no page reads "Not checked", a page read without the value "Not found", "—" nothing: none is a value. On a page
// from what Octo knows every value is drawn, "<value>, not checked", and the line says none is checked. A sixth column
// is never drawn, and a page with no columns (ranked, timeline, blank) or no rows has no such line.
test("the line for the reply counts the values the page draws, as the compare starter draws them", () => {
  const read = { src: "Maker", url: "https://maker.example/a", date: "2026-11-23", viewer: "server fetch" };
  const dir = optionsSite("compare", (data, d) => {
    fs.mkdirSync(path.join(d, "data/records"), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(d, "data/records/read_offer.json"), JSON.stringify({ schema: "instafy.records@1", records: [
      { type: "offer", ref: "option:option-c", price: { amount: 120, currency: "USD" }, prov: { observed_at: at } },
      { type: "claim", ref: "option:option-b", attr: "price", value: null, status: "uncertain", note: "blocked", prov: { observed_at: at } },
    ] }));
    return {
      ...data,
      columns: [...data.columns, { key: "colour", label: "Colour", type: "text" }, { key: "size", label: "Size", type: "text" }],
      items: data.items.map((item, i) => ({ ...item, facts: {
        price: i === 1 ? { v: "$129", ...read } : { note: "no price on the shop's page today" },
        weight: [{ v: "about 9 oz", est: true, url: "https://maker.example/how" }, { v: "9.1 oz" }, { ...read }][i],
        rating: [{ v: "4.6 of 5", ...read }, { v: "—", ...read }, { note: "no rating found" }][i],
        warranty: { v: "2 years", ...read },
        colour: { v: "Grey", ...read },
        size: { v: "Large", ...read },
      } })),
    };
  });
  try {
    // Option C's price a check read, Option B's seed kept by the blocked check; Option A's weight an estimate, B's
    // without a page and C's read without the value; a dash says nothing; the sixth column isn't drawn
    assert.equal(shownLine(dir), "The page shows 10 of 15 values: Price 2 of 3, Weight 1 of 3, Rating 1 of 3, Warranty 3 of 3, Colour 3 of 3.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const memory = optionsSite("compare", (data) => ({ title: "Two e-readers", from: "memory",
    columns: [{ key: "screen", label: "Display", type: "text" }, { key: "price", label: "Price", type: "price" }],
    items: [{ ref: "reader:a", name: "Reader A", facts: { screen: { v: "6 in" }, price: { v: "$130" } } },
      { ref: "reader:b", name: "Reader B", facts: { screen: { v: "7 in" }, price: { note: "not known" } } }] }));
  try {
    assert.equal(shownLine(memory), "The page shows 3 of 4 values, from what Octo knows and none checked: Display 2 of 2, Price 1 of 2.");
  } finally {
    fs.rmSync(memory, { recursive: true, force: true });
  }
  for (const starter of ["ranked", "timeline"]) {
    const other = optionsSite(starter);
    try {
      assert.equal(shownLine(other), null, starter);
      assert.doesNotMatch(run("check", other, "--expect", "Option A").stdout, /^The page shows/m, starter);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }
  const blank = blankSite(null);
  try {
    assert.equal(shownLine(blank), null);
  } finally {
    fs.rmSync(blank, { recursive: true, force: true });
  }
  const empty = optionsSite("compare", (data) => ({ ...data, items: [] }));
  try {
    assert.equal(shownLine(empty), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// A price only a web search gave ("viewer": "provider search", or any viewer that names a search, such as the "search
// result" `instafy web search` gives its answers) is shown with its label, and the page lists its row apart, never as
// within the limit (site.within), nor names it the lowest under the title: the note says so, for the reply to say it
// too, and the sort check reads it as the page does.
test("a price only a web search gave is noted as listed apart, as the page lists it", () => {
  for (const [starter, viewer] of [["compare", "provider search"], ["ranked", "provider search"], ["compare", "search result"], ["ranked", "web search"]]) {
    const dir = optionsSite(starter, (data) => {
      const b = data.items[1];
      if (starter === "compare") b.facts.price = { ...b.facts.price, viewer };
      else b.price = { ...b.price, viewer };
      return { ...data, filter: { key: "price", max: 140, label: "Under $140" } };
    });
    try {
      const { notes, problems } = checkValues(dir);
      assert.deepEqual(problems, [], `${starter}, ${viewer}`);
      assert.equal(notes.length, 2, `${starter}, ${viewer}: ${notes.join("\n")}`);
      assert.match(notes[0], /^1 item\(s\) have no price the page can show: Option C\./, `${starter}, ${viewer}`);
      const say = starter === "compare" ? "the reply" : "the lede and the reply";
      assert.equal(notes[1], `1 item(s) have a price only a web search gave: Option B. The page lists them apart ("Price unknown"), never as "Under $140"; say so in ${say}.`, `${starter}, ${viewer}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // two prices, one a web search's: no sort decides, so none is asked for
  const priced = (v, extra = {}) => ({ v, src: "Shop", url: "https://shop.example/x", date: "2026-10-27", ...extra });
  const data = {
    title: "Two",
    columns: [{ key: "price", label: "Price", type: "price" }],
    items: [{ ref: "option:a", name: "A", facts: { price: priced("€449") } }, { ref: "option:b", name: "B", facts: { price: priced("€399", { viewer: "provider search" }) } }],
  };
  assert.deepEqual(unsortedNumbers(data), []);
  data.items[1].facts.price = priced("€399", { viewer: "search result" });
  assert.deepEqual(unsortedNumbers(data), []);
  data.items[1].facts.price = priced("€399");
  assert.deepEqual(unsortedNumbers(data), [{ key: "price", label: "Price" }]);
  data.items[1].facts.price = priced("€399", { viewer: "server fetch" });
  assert.deepEqual(unsortedNumbers(data), [{ key: "price", label: "Price" }]);
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
    // a source with its name: a page made before the starter named each source by its site draws that name (with no
    // name, "Sources: undefined ↗"); the starter now names it by its site whatever its name
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

// A comparison of three e-readers told what it didn't find three times; the third was its own "unchecked" entry, "Weight,
// price and the requested independent reviews were not found in the pages read.", under "Still to confirm", beside what
// the page names there from its cells (a local test, Nov 10). The check notes an "unchecked" entry that names a column
// no row has a value for, by the page's own labels: once, naming them, for the build to judge. Naming a label is no
// repeat by itself ("Check train times on Taiwan Railway before you book" says what the reader can do), so it never
// fails the page. A column some rows have, a price a store can still check, words that only contain a label, a page from
// what Octo knows and a page whose own app.js names no missing value are left as they are.
test("check notes an \"unchecked\" entry that names what the page already names as missing, and never fails it", () => {
  const DAY = "2026-11-10";
  const reader = (ref, name) => ({
    ref: `reader:${ref}`, name,
    facts: {
      screen: { v: "6 in", src: "Maker", url: `https://maker.example/${ref}`, date: DAY, viewer: "server fetch" },
      weight: { note: "I didn't find weight" },
      price: { note: "I didn't find price" },
      reviews: { note: `I didn't find two independent reviews for ${name}` },
    },
  });
  const readers = () => ({
    title: "Three e-readers",
    columns: [{ key: "screen", label: "Screen", type: "text" }, { key: "weight", label: "Weight (g)", type: "text" },
      { key: "price", label: "Price", type: "price" }, { key: "reviews", label: "Independent reviews", type: "text" }],
    items: [reader("a", "Reader A"), reader("b", "Reader B"), reader("c", "Reader C")],
    unchecked: [
      "Weight, price and the requested independent reviews were not found in the pages read.",
      "Reader A's page at its first address wasn't at the address Octo tried.",
      "Which models are priced in euros",
      "Screens of other sizes",
    ],
  });
  const repeats = uncheckedRepeats(readers());
  assert.deepEqual(repeats.map((r) => [r.entry, r.labels]), [
    ["Weight, price and the requested independent reviews were not found in the pages read.", ["Weight (g)", "Price", "Independent reviews"]],
  ]);
  const note = '"unchecked": "Weight, price and the requested independent reviews were not found in the pages read." names Weight (g), Price and Independent reviews, which the page already names as still missing, from its cells, with each value\'s "note". Keep the entry only for what the reader can do that the page doesn\'t say; leave out one that only says again what is missing.';
  assert.equal(repeats[0].note, note);
  // in the plural too
  assert.deepEqual(uncheckedRepeats({ ...readers(), unchecked: ["Prices for each model"] }).map((r) => r.labels), [["Price"]]);
  // a column one row has a value for: the entry may say more than the missing ones
  const somePrice = readers();
  somePrice.items[0].facts.price = { v: "€149", src: "Shop", url: "https://shop.example/a", date: DAY, viewer: "server fetch" };
  assert.deepEqual(uncheckedRepeats(somePrice).map((r) => r.labels), [["Weight (g)", "Independent reviews"]]);
  // a price every store can still check is on its row
  const stores = readers();
  for (const item of stores.items) item.store = { name: "Shop", url: `https://shop.example/${item.ref}`, readable: true };
  assert.deepEqual(uncheckedRepeats(stores).map((r) => r.labels), [["Weight (g)", "Independent reviews"]]);
  // a page from what Octo knows, and a page that is no comparison
  assert.deepEqual(uncheckedRepeats({ ...readers(), from: "memory" }), []);
  assert.deepEqual(uncheckedRepeats({ title: "Plan", unchecked: ["Weight"] }), []);

  const dir = optionsSite("compare", () => readers());
  const file = path.join(dir, "data.json");
  try {
    // a note for the build, never a problem: the check passes
    const values = checkValues(dir);
    assert.deepEqual(values.problems, []);
    assert.deepEqual(values.notes, [note]);
    const out = run("check", dir, "--expect", "Reader A, Reader B, Reader C");
    assert.equal(out.status, 0, out.stdout);
    assert.ok(out.stdout.split("\n").includes(`NOTE: ${note}`), out.stdout);
    assert.doesNotMatch(out.stdout, /^VALUES:/m);
    fs.writeFileSync(file, JSON.stringify({ ...readers(), unchecked: readers().unchecked.slice(1) }));
    assert.deepEqual(checkValues(dir).notes, []);
    // the cheat sheet's own footer entry, beside a column no row has: what the reader can do, kept as it is
    const trains = {
      title: "Two trains",
      // the fare is a number in every row, so it has its sort (the line under the title names the cheaper)
      sort: [{ key: "fare", label: "Fare, low to high", dir: "asc" }],
      columns: [{ key: "fare", label: "Fare", type: "price" }, { key: "times", label: "Train times", type: "text" }],
      items: [["a", "Express A", "NT$ 300"], ["b", "Local B", "NT$ 200"]].map(([ref, name, fare]) => ({
        ref: `train:${ref}`, name,
        facts: { fare: { v: fare, src: "Rail", url: `https://rail.example/${ref}`, date: DAY }, times: { note: "timetable not read" } },
      })),
      unchecked: ["Check train times on Taiwan Railway before you book"],
    };
    fs.writeFileSync(file, JSON.stringify(trains));
    const kept = run("check", dir, "--expect", "Express A, Local B");
    assert.equal(kept.status, 0, kept.stdout);
    assert.deepEqual(checkValues(dir).problems, []);
    // a page whose own app.js names no missing value: the page says it nowhere else, so no note says it does
    fs.writeFileSync(file, JSON.stringify(readers()));
    fs.writeFileSync(path.join(dir, "app.js"), 'site.head({ title: "Three e-readers" });\n');
    assert.deepEqual(checkValues(dir).notes, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.deepEqual(notes, [], "no note asks to call the remembered prices unknown");
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

// The line under a comparison's title names the option each "sort" entry puts first. Two builds of a comparison of
// three laptops wrote every column as text and no "sort", and the page said nothing under its title, although every row
// had its starting price ("From €619") and its weight ("1.3kg"). With two or more options, a column that would say
// something there, and no entry by a column that reads as a number, the check names the columns that do, for an entry
// with its "dir" for each that is an amount the person compares by. A number in a name reads as one too ("Chip Ultra 5"
// is 5), so which columns are amounts is the build's to say, and an entry by any column that reads as a number settles
// it: had only an entry that decides something now settled it, a comparison whose amounts each lack a value in some row
// could pass only by an entry for its chips, and its page would name the "highest CPU" by the digits in their names.
test("check asks a comparison with no sort by a number for an entry per amount the person compares by, and names the columns that read as one", () => {
  const at = (v, page, extra = {}) => ({ v, src: "Maker", url: `https://maker.example/${page}`, date: "2026-11-09", ...extra });
  const unread = { note: "two independent reviews not found" };
  const laptops = () => ({
    title: "Three laptops",
    columns: [{ key: "cpu", label: "CPU", type: "text" }, { key: "battery", label: "Battery", type: "text" }, { key: "weight", label: "Weight", type: "text" },
      { key: "price", label: "Starting price", type: "text" }, { key: "reviews", label: "Independent reviews", type: "text" },
      // a sixth column is not drawn, so no sort is by it
      { key: "screen", label: "Screen", type: "text" }],
    items: [
      { ref: "laptop:12", name: "Maker Laptop 12", facts: { cpu: at("Chip 3", "12?tab=specs"), battery: at("50 Wh", "12?tab=specs"), weight: at("1.3kg", "12?tab=specs"),
        price: at("From €619", "12/configure"), reviews: unread, screen: at("12.2 in", "12?tab=specs") } },
      { ref: "laptop:13-pro", name: "Maker Laptop 13 Pro", facts: { cpu: at("Chip Ultra 5", "13pro?tab=specs"), battery: at("74 Wh", "13pro?tab=specs"),
        weight: at("1.4 kg", "13pro?tab=specs"), price: at("€1,349", "13pro/configure"), reviews: at("Review One · Review Two", "13pro/reviews"), screen: at("13.5 in", "13pro?tab=specs") } },
      { ref: "laptop:16", name: "Maker Laptop 16", facts: { cpu: at("Chip AI 300", "16?tab=specs"), battery: at("85 Wh", "16?tab=specs"), weight: at("2.1 or 2.4 kg", "16?tab=specs"),
        price: at("From €1,409", "16/configure"), reviews: unread, screen: at("16 in", "16?tab=specs") } },
    ],
  });
  const expect = "Maker Laptop 12, Maker Laptop 13 Pro, Maker Laptop 16";
  const asked = (columns) => `the sort: no "sort" entry is by a column that reads as a number, so nothing is said under the title. Of the columns that do (${columns}), add an entry, with "dir", for each that is an amount the person compares by (a price, a weight, a size): once every row shows its value, the page names the option it puts first under its title ("Lowest price: Option B"), and under 5 options no row moves. A number in a name (a chip, a model, a version) is no amount: if no column is one, add none, and nothing is said there.`;
  const all = asked("CPU, Battery, Weight and Starting price");
  const notFound = (what) => ({ note: `${what} not found on maker.example's page` });
  const price = { key: "price", label: "Starting price, low to high", dir: "asc" };
  const weight = { key: "weight", label: "Weight, light first", dir: "asc" };
  const battery = { key: "battery", label: "Battery, largest first", dir: "desc" };
  const dir = optionsSite("compare", laptops);
  const file = path.join(dir, "data.json");
  const write = (data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  try {
    assert.deepEqual(checkValues(dir).problems, [all]);
    const out = run("check", dir, "--expect", expect);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /^VALUES: 1 value\(s\) to fix in data\.json:$/m);
    assert.ok(out.stdout.split("\n").includes(`- ${all}`), out.stdout);
    assert.match(out.stdout, /3 of 3 expected item\(s\) shown/);
    assert.deepEqual(JSON.parse(run("check", dir, "--expect", expect, "--json").stdout).values.problems, [all]);

    // an entry by a column no row shows a number for never says anything, nor does one by a column the page doesn't
    // draw: still asked
    write({ ...laptops(), sort: [{ key: "reviews", label: "Most reviews", dir: "desc" }] });
    assert.deepEqual(checkValues(dir).problems, [all]);
    write({ ...laptops(), sort: [{ key: "screen", label: "Screen, largest first", dir: "desc" }] });
    assert.deepEqual(checkValues(dir).problems, [all]);

    // an entry for each amount the person compares by (the price and the weight): the line names the cheapest and the
    // lightest, the check passes, and no entry is asked for the CPU
    write({ ...laptops(), sort: [price, weight] });
    assert.deepEqual(checkValues(dir).problems, []);
    assert.equal(run("check", dir, "--expect", expect).status, 0);
    // one entry by a number is enough
    write({ ...laptops(), sort: [{ key: "reviews", dir: "desc" }, { key: "weight", dir: "asc" }] });
    assert.deepEqual(checkValues(dir).problems, []);

    // the person's amounts each lack a value in some row, and only the chips' names read as a number in every row: the
    // check names the amounts too, and their entries settle it, though nothing is said under the title until the values
    // are found. No entry is asked for the chips.
    const gaps = laptops();
    for (const i of gaps.items) i.facts.battery = notFound("battery");
    gaps.items[0].facts.price = notFound("price");
    gaps.items[1].facts.weight = notFound("weight");
    write(gaps);
    assert.deepEqual(checkValues(dir).problems, [asked("CPU, Weight and Starting price")]);
    write({ ...gaps, sort: [price, weight] });
    assert.deepEqual(checkValues(dir).problems, []);
    // so does an entry whose rows all show the same, or one by a price whose source dates it over 30 days ago: the page
    // says nothing there until a row differs or a check reads the price again
    const same = laptops();
    for (const i of same.items) i.facts.battery = at("60 Wh", "specs");
    write({ ...same, sort: [battery] });
    assert.deepEqual(checkValues(dir).problems, []);
    const old = laptops();
    old.columns[3].type = "price";
    for (const i of old.items) i.facts.price = { ...i.facts.price, asof: "2026-01-05" };
    write({ ...old, sort: [price] });
    assert.deepEqual(checkValues(dir).problems, []);

    // under a stated limit the line speaks of the rows the page draws first: those within it (and any it can't place)
    const limited = () => {
      const data = laptops();
      data.columns[3].type = "price";
      data.filter = { key: "price", max: 1400, label: "€1,400 or less", rest: "over €1,400" };
      return data;
    };
    // the 16 is over the limit: an entry by a column only it shows a number for says nothing on the page as first drawn
    const beyond = limited();
    for (const i of beyond.items.slice(0, 2)) i.facts.battery = notFound("battery");
    write({ ...beyond, sort: [battery] });
    assert.deepEqual(checkValues(dir).problems, [asked("CPU, Weight and Starting price")]);
    // and a column that differs only by that row asks for nothing: no column decides between the rows drawn (the other
    // two, whose prices are unknown, so the page draws them apart)
    const tie = limited();
    for (const i of tie.items.slice(0, 2)) {
      for (const key of ["cpu", "weight", "price"]) i.facts[key] = notFound(key);
      i.facts.battery = at("60 Wh", "specs");
    }
    write(tie);
    assert.deepEqual(checkValues(dir).problems, []);
    write({ ...tie, filter: undefined });
    assert.deepEqual(checkValues(dir).problems, [all]);

    // nothing to decide between: one option, or no column a number in every row
    write({ ...laptops(), items: laptops().items.slice(0, 1) });
    assert.deepEqual(checkValues(dir).problems, []);
    const words = laptops();
    for (const i of words.items) for (const key of ["cpu", "battery", "weight", "price"]) i.facts[key] = notFound(key);
    write(words);
    assert.deepEqual(checkValues(dir).problems, []);
    // a page made before keeps its own app.js, which draws no such line
    write(laptops());
    fs.writeFileSync(path.join(dir, "app.js"), 'site.start({ data: "data.json", render: function (data) { site.head(data); } });\n');
    assert.deepEqual(checkValues(dir).problems, []);
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
