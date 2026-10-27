import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Address-bar search in the Personal Browser: the engines and their search
// links are the web-research skill's data (references/search-engines.json),
// bundled into Desktop; Desktop checks the list and builds each search's
// address from it. Nothing here reaches the network.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const search = require(path.join(packageRoot, "dist/personalBrowserSearch.js"));
const SKILL_LIST = JSON.parse(fs.readFileSync(path.resolve(
  packageRoot,
  "../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/search-engines.json",
), "utf8"));

const list = (engines, defaultId = engines[0]?.id) => ({ schema: "instafy.search-engines@1", default: defaultId, engines });
const engine = (id, searchLink) => ({ id, name: id, search: searchLink });

test("the build carries the skill's own engine list, and it checks out", () => {
  assert.deepEqual(search.BUNDLED_SEARCH_ENGINES, SKILL_LIST);
  const parsed = search.PERSONAL_BROWSER_SEARCH_ENGINES;
  assert.ok(parsed, "the bundled list loads");
  assert.deepEqual(parsed.engines.map((entry) => entry.id), SKILL_LIST.engines.map((entry) => entry.id));
  assert.equal(parsed.defaultId, SKILL_LIST.default);
  assert.ok(parsed.engines.length >= 2, "a short list to pick from");
});

test("words open a search on the picked engine, encoded, on that engine's own https host", () => {
  for (const entry of search.PERSONAL_BROWSER_SEARCH_ENGINES.engines) {
    const host = new URL(entry.search.replace("{query}", "q")).host;
    for (const [typed, encoded] of [["best ramen tokyo", "best%20ramen%20tokyo"], ["ramen", "ramen"], ["c++ & rust?", "c%2B%2B%20%26%20rust%3F"]]) {
      const address = search.searchAddress(entry, typed);
      const url = new URL(address);
      assert.equal(url.protocol, "https:", entry.id);
      assert.equal(url.host, host, entry.id);
      assert.ok(address.includes(encoded), `${entry.id}: ${address}`);
    }
  }
  const duck = search.PERSONAL_BROWSER_SEARCH_ENGINES.engines.find((entry) => entry.id === "duckduckgo");
  assert.equal(search.searchAddress(duck, "  best   ramen\ntokyo "), "https://duckduckgo.com/?q=best%20ramen%20tokyo");
  assert.equal(search.searchAddress(duck, "   "), null);
  assert.equal(search.searchAddress(duck, 42), null);
  assert.equal(new URL(search.searchAddress(duck, "x".repeat(10_000))).searchParams.get("q").length, search.MAX_SEARCH_QUERY_CHARS);
});

test("the picked engine is kept, and an unknown one falls back to the list's default", () => {
  const parsed = search.PERSONAL_BROWSER_SEARCH_ENGINES;
  const other = parsed.engines.find((entry) => entry.id !== parsed.defaultId);
  assert.equal(search.selectedSearchEngine(parsed, other.id).id, other.id);
  assert.equal(search.selectedSearchEngine(parsed, "gone").id, parsed.defaultId);
  assert.equal(search.selectedSearchEngine(parsed, undefined).id, parsed.defaultId);
  assert.equal(search.selectedSearchEngine(null, other.id), null);
  // Studio gets names, never the links.
  const choice = search.searchChoice(parsed, other.id);
  assert.equal(choice.selected, other.id);
  assert.deepEqual(Object.keys(choice.engines[0]).sort(), ["id", "name"]);
  assert.deepEqual(search.searchChoice(null, other.id), { engines: [], selected: null });
});

test("a list that does not check out offers no search", () => {
  const good = engine("ok", "https://search.example/?q={query}");
  assert.ok(search.parseSearchEngines(list([good])));
  for (const [why, data] of [
    ["not a list", null],
    ["other schema", { ...list([good]), schema: "instafy.search-engines@2" }],
    ["no engines", list([])],
    ["unknown default", list([good], "missing")],
    ["duplicate id", list([good, { ...good, name: "Again" }])],
    ["bad id", list([engine("Not An Id", "https://search.example/?q={query}")])],
    ["plain http", list([engine("a", "http://search.example/?q={query}")])],
    ["no placeholder", list([engine("a", "https://search.example/?q=")])],
    ["two placeholders", list([engine("a", "https://search.example/?q={query}&r={query}")])],
    ["placeholder in the host", list([engine("a", "https://{query}.search.example/")])],
    ["user and password", list([engine("a", "https://user:pass@search.example/?q={query}")])],
    ["port", list([engine("a", "https://search.example:8443/?q={query}")])],
    ["IP address", list([engine("a", "https://93.184.216.34/?q={query}")])],
    ["localhost", list([engine("a", "https://search.localhost/?q={query}")])],
    ["javascript", list([engine("a", "javascript:alert('{query}')")])],
  ]) {
    assert.equal(search.parseSearchEngines(data), null, why);
  }
});
