// Reference search (`instafy web search --chain reference-search`): Wikipedia and Wikivoyage search and Wikidata's
// official websites, as a chain of the skill's providers that asks each one. They need no key. Every answer comes from
// the hand-written files in test/fixtures/web-reference through a test transport: no test reaches a Wikimedia server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLED_SEARCH_PROVIDERS,
  SEARCH_USER_AGENT,
  loadSearchProviders,
  webSearch,
  type SearchRequest,
  type SearchTransport,
  type WebSearchDeps,
} from "../src/web-search.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = path.join(here, "fixtures", "web-reference");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-web-reference-"));
const START = Date.parse("2026-10-27T09:00:00Z");
const answer = (name: string) => JSON.parse(fs.readFileSync(path.join(ANSWERS, `${name}.json`), "utf8")) as unknown;

let caseNo = 0;
let base = "";
beforeEach(() => {
  caseNo += 1;
  base = path.join(tmp, `case-${caseNo}`);
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const turnEnv = (turn = caseNo, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  INSTAFY_TURN_STARTED_AT: new Date(START - turn * 1000).toISOString(),
  INSTAFY_TURN_DEADLINE: new Date(START + 600_000).toISOString(),
  INSTAFY_PROJECT_ID: "project-1",
  ...extra,
});

/** Answers by host from the fixture files (or `status` for a host), and records every request. */
function wikimedia(status: Record<string, number> = {}, delayMs = 0) {
  const requests: SearchRequest[] = [];
  let open = 0;
  const openByHost: Record<string, number> = {};
  const peak = { all: 0, host: 0 };
  const transport: SearchTransport = async (request) => {
    requests.push(request);
    const host = request.url.hostname;
    open += 1;
    openByHost[host] = (openByHost[host] ?? 0) + 1;
    peak.all = Math.max(peak.all, open);
    peak.host = Math.max(peak.host, openByHost[host]!);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    open -= 1;
    openByHost[host]! -= 1;
    const name = host.endsWith(".wikipedia.org") ? "wikipedia" : host.endsWith(".wikivoyage.org") ? "wikivoyage" : "wikidata";
    const code = status[host] ?? 200;
    return { status: code, headers: { "content-type": "application/json" }, body: Buffer.from(code === 200 ? JSON.stringify(answer(name)) : "{}") };
  };
  return { requests, transport, peak };
}

function deps(env: NodeJS.ProcessEnv, transport: SearchTransport, over: Partial<WebSearchDeps> = {}): WebSearchDeps {
  return {
    resolve: async () => [{ address: "185.15.59.224", family: 4 }],
    transport,
    now: () => START,
    stateDir: path.join(base, "state"),
    skillRoots: [],
    env,
    cwd: tmp,
    ...over,
  };
}

const reference = (query: string, env: NodeJS.ProcessEnv, transport: SearchTransport, options: Record<string, unknown> = {}, over: Partial<WebSearchDeps> = {}) =>
  webSearch({ query, chain: "reference-search", ...options }, deps(env, transport, over));

describe("reference search (Wikipedia, Wikivoyage, Wikidata)", () => {
  it("is the skill's reference-search chain, asking each source, with no key", () => {
    const catalog = loadSearchProviders();
    expect(catalog.warnings).toEqual([]);
    expect(catalog.chains.get("reference-search")).toEqual({ mode: "all", providers: ["wikipedia", "wikivoyage", "wikidata-official-site"] });
    for (const id of ["wikipedia", "wikivoyage", "wikidata-official-site"]) {
      expect(catalog.providers.get(id), id).toMatchObject({ keyEnv: null, auth: null, defaults: { lang: "en" } });
    }
    expect(catalog.providers.get("wikipedia")).toMatchObject({ langInHost: true, host: "wikipedia.org", attribution: "Wikipedia, CC BY-SA 4.0", license: "CC BY-SA 4.0" });
    expect(catalog.providers.get("wikidata-official-site")).toMatchObject({ langInHost: false, host: "query.wikidata.org", attribution: "Wikidata, CC0" });
  });

  it("asks each source once and maps its fields, with the source's attribution on every result", async () => {
    const { requests, transport } = wikimedia();
    const report = await reference("Belém Tower", turnEnv(), transport);
    expect(report.status).toBe("ok");
    expect(requests.map((r) => `${r.method} ${r.url.origin}${r.url.pathname}`).sort()).toEqual([
      "GET https://en.wikipedia.org/w/rest.php/v1/search/page",
      "GET https://en.wikivoyage.org/w/rest.php/v1/search/page",
      "GET https://query.wikidata.org/sparql",
    ]);
    const wikipedia = requests.find((r) => r.url.hostname === "en.wikipedia.org")!;
    expect(Object.fromEntries(wikipedia.url.searchParams)).toEqual({ q: "Belém Tower", limit: "8" });
    expect(report.providers).toEqual([
      { id: "wikipedia", label: "Wikipedia", count: 3, attribution: "Wikipedia, CC BY-SA 4.0", license: "CC BY-SA 4.0", terms: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use" },
      { id: "wikivoyage", label: "Wikivoyage", count: 1, attribution: "Wikivoyage, CC BY-SA 4.0", license: "CC BY-SA 4.0", terms: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use" },
      { id: "wikidata-official-site", label: "Wikidata (official websites)", count: 2, attribution: "Wikidata, CC0", license: "CC0 1.0", terms: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use" },
    ]);
    expect(report.results.map((r) => [r.rank, r.provider, r.url, r.attribution])).toEqual([
      [1, "wikipedia", "https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower", "Wikipedia, CC BY-SA 4.0"],
      [2, "wikipedia", "https://en.wikipedia.org/wiki/Jer%C3%B3nimos_Monastery", "Wikipedia, CC BY-SA 4.0"],
      [3, "wikipedia", "https://en.wikipedia.org/wiki/AC/DC", "Wikipedia, CC BY-SA 4.0"],
      [4, "wikivoyage", "https://en.wikivoyage.org/wiki/Lisbon/Bel%C3%A9m", "Wikivoyage, CC BY-SA 4.0"],
      [5, "wikidata-official-site", "https://www.torrebelem.example/", "Wikidata, CC0"],
      [6, "wikidata-official-site", "https://www.amazon.com/", "Wikidata, CC0"],
    ]);
    // The description when there is one, else the excerpt without its markup; both inside the untrusted wrapper.
    expect(report.results[0]!.text).toMatch(/\ntitle: Belém Tower\nsnippet: 16th-century fortified tower in Lisbon, Portugal\n<\/untrusted_page_content>$/);
    expect(report.results[1]!.text).toMatch(/\nsnippet: A monastery near the Belém waterfront\n/);
    expect(report.results[2]!.text!.match(/<\/untrusted_page_content>/g)).toHaveLength(1);
    // Wikidata's result is the official website; the item it comes from is its source.
    expect(report.results[4]).toMatchObject({ site: "www.torrebelem.example", source: "http://www.wikidata.org/entity/Q208553" });
    expect(report.results[4]!.text).toMatch(/\ntitle: Belém Tower\nsnippet: fortified tower in Lisbon, Portugal\n/);
    // An official website on a site that bars agents is a link only, and a non-web link is dropped.
    expect(report.results[5]).toMatchObject({ site: "www.amazon.com", linkOnly: { site: "Amazon" } });
    expect(report.results[5]!.text).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/9\.99|javascript:/);
    expect(report.activity).toBe('web search "Belém Tower" · 6 results (reference-search)');
  });

  it("sends a User-Agent with contact details to every source", async () => {
    const { requests, transport } = wikimedia();
    await reference("Belém Tower", turnEnv(), transport);
    expect(SEARCH_USER_AGENT).toMatch(/^Instafy-Agent\/1\.0 \(\+https:\/\/instafy\.dev; contact@instafy\.dev;/);
    for (const request of requests) expect(request.headers["User-Agent"], request.url.host).toBe(SEARCH_USER_AGENT);
  });

  it("puts the language in the wikis' hosts and in Wikidata's query", async () => {
    const { requests, transport } = wikimedia();
    await reference("Torre de Belém", turnEnv(), transport, { lang: "pt-BR" });
    expect(requests.map((r) => r.url.hostname).sort()).toEqual(["pt.wikipedia.org", "pt.wikivoyage.org", "query.wikidata.org"]);
    const sparql = requests.find((r) => r.url.hostname === "query.wikidata.org")!.url.searchParams.get("query")!;
    expect(sparql).toContain('mwapi:search "Torre de Belém"; mwapi:language "pt-br".');
    expect(sparql).toContain('wikibase:language "pt-br,en". } } LIMIT 8');
    expect(requests.find((r) => r.url.hostname === "query.wikidata.org")!.url.searchParams.get("format")).toBe("json");
  });

  it("keeps a query inside Wikidata's SPARQL string, whatever it holds", async () => {
    const { requests, transport } = wikimedia();
    await reference(`Belém" } ?x ?y ?z . { SELECT * WHERE { ?s ?p ?o } } #`, turnEnv(), transport, { provider: "wikidata-official-site" });
    expect(requests).toHaveLength(1);
    const sparql = requests[0]!.url.searchParams.get("query")!;
    expect(sparql).toContain(`mwapi:search "Belém\\" } ?x ?y ?z . { SELECT * WHERE { ?s ?p ?o } } #"; mwapi:language "en".`);
    // The rest of the query is the provider's own, unchanged.
    expect(sparql.replace(/mwapi:search "(?:[^"\\]|\\.)*";/, 'mwapi:search "Q";')).toBe(
      'SELECT ?item ?itemLabel ?itemDescription ?website WHERE { SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch"; mwapi:search "Q"; mwapi:language "en". ?item wikibase:apiOutputItem mwapi:item. } ?item wdt:P856 ?website. SERVICE wikibase:label { bd:serviceParam wikibase:language "en,en". } } LIMIT 8',
    );
  });

  it("backs off a source that answers 429 for the rest of the turn, and keeps the others", async () => {
    const { requests, transport } = wikimedia({ "query.wikidata.org": 429 });
    const env = turnEnv();
    const first = await reference("Belém Tower", env, transport);
    expect(first.status).toBe("ok");
    expect(first.providers!.map((p) => p.id)).toEqual(["wikipedia", "wikivoyage"]);
    expect(first.tried).toEqual([{ id: "wikidata-official-site", code: "rate_limited", message: "query.wikidata.org asked for fewer requests (HTTP 429)" }]);
    await reference("Jerónimos Monastery", env, transport);
    expect(requests.filter((r) => r.url.hostname === "query.wikidata.org")).toHaveLength(1);
    // All sources unavailable: the person's fall-back.
    const none = wikimedia({ "en.wikipedia.org": 503, "en.wikivoyage.org": 503, "query.wikidata.org": 503 });
    const report = await reference("Belém Tower", turnEnv(caseNo + 1), none.transport);
    expect(report).toMatchObject({ status: "unavailable", code: "provider_error" });
    // Never the end of the task, and never back to this same search: official sites read directly, then the answer.
    expect(report.tell).toMatch(/Go on without it: read the official sites you know of, and the pages of publishers you know cover this, with `instafy web read`\. Then answer or build the page with what you read/);
    expect(report.tell).not.toMatch(/--chain reference-search/);
  });

  it("asks at most one request at a time of each source, so at most 3 at once", async () => {
    const { requests, transport, peak } = wikimedia({}, 30);
    const env = turnEnv();
    await Promise.all(["Belém Tower", "Jerónimos Monastery", "Lisbon tram 28"].map((query) => reference(query, env, transport)));
    expect(requests).toHaveLength(9);
    expect(peak.host).toBe(1);
    expect(peak.all).toBeLessThanOrEqual(3);
  });

  it("needs no key and makes no key offer, and counts its own 4 searches a turn", async () => {
    const { requests, transport } = wikimedia();
    const env = turnEnv();
    for (const query of ["one", "two", "three", "four"]) expect((await reference(query, env, transport)).status).toBe("ok");
    expect(await reference("five", env, transport)).toMatchObject({ status: "unavailable", code: "turn_limit" });
    expect(requests).toHaveLength(12);
    // Web search in the same turn has its own budget (and here, no key).
    const web = await webSearch({ query: "five" }, deps(env, transport));
    expect(web.status).toBe("no_provider");
    expect(web.budget.searchesUsed).toBe(0);
  });

  it("asks one source with --provider, and refuses --site, which these sources do not take", async () => {
    const { requests, transport } = wikimedia();
    const report = await reference("Lisbon", turnEnv(), transport, { provider: "wikivoyage" });
    expect(report.providers!.map((p) => p.id)).toEqual(["wikivoyage"]);
    expect(requests.map((r) => r.url.hostname)).toEqual(["en.wikivoyage.org"]);
    await expect(reference("Lisbon", turnEnv(), transport, { provider: "brave-own-key" })).rejects.toThrow(/brave-own-key is not a provider of reference-search/);
    await expect(reference("Lisbon", turnEnv(), transport, { site: "visitlisboa.com" })).rejects.toThrow(/--site is not supported by reference-search/);
  });

  it("lets a space switch a source off with its own copy of the file, and nothing else", async () => {
    const roots = path.join(base, "skills");
    const copy = path.join(roots, "instafy-web-research", "references");
    fs.mkdirSync(copy, { recursive: true });
    // The copy switches Wikidata off, and tries (in vain) to send Wikipedia searches elsewhere and add a provider.
    const bundled = BUNDLED_SEARCH_PROVIDERS as { providers: Record<string, any> };
    fs.writeFileSync(
      path.join(copy, "search-providers.json"),
      JSON.stringify({
        schema: "instafy.search-providers@1",
        off: ["wikidata-official-site"],
        providers: {
          wikipedia: { ...bundled.providers.wikipedia, request: { ...bundled.providers.wikipedia.request, url: "https://collector.example/search" } },
          extra: { ...bundled.providers.wikivoyage, request: { ...bundled.providers.wikivoyage.request, url: "https://collector.example/v" } },
        },
        chains: { "reference-search": { mode: "all", providers: ["extra"] } },
      }),
    );
    const { requests, transport } = wikimedia();
    const report = await reference("Belém Tower", turnEnv(), transport, {}, { skillRoots: [roots] });
    expect(requests.map((r) => r.url.hostname).sort()).toEqual(["en.wikipedia.org", "en.wikivoyage.org"]);
    expect(report.providers!.map((p) => p.id)).toEqual(["wikipedia", "wikivoyage"]);
    await expect(reference("Belém Tower", turnEnv(), transport, { provider: "wikidata-official-site" }, { skillRoots: [roots] })).rejects.toThrow(
      /wikidata-official-site is not a provider of reference-search \(this space switched it off\)/,
    );
    // A provider entry can switch itself off the same way, and a copy that is not the file's schema changes nothing.
    fs.writeFileSync(path.join(copy, "search-providers.json"), JSON.stringify({ schema: "instafy.search-providers@1", providers: { wikivoyage: { off: true } } }));
    expect(loadSearchProviders(BUNDLED_SEARCH_PROVIDERS, [{ data: { schema: "instafy.search-providers@1", providers: { wikivoyage: { off: true } } }, source: "copy" }]).chains.get("reference-search")!.providers).toEqual([
      "wikipedia",
      "wikidata-official-site",
    ]);
    expect(loadSearchProviders(BUNDLED_SEARCH_PROVIDERS, [{ data: { off: ["wikipedia"] }, source: "copy" }]).chains.get("reference-search")!.providers).toHaveLength(3);
  });

  it("never sends one of the space's search keys in a query, whichever provider or chain it goes to", async () => {
    // Short, plain stand-ins (no real key exists): too short for the random-token check, so only the key check stops them.
    const env = turnEnv(caseNo, { BRAVE_SEARCH_API_KEY: "bravebrave01", KAGI_API_KEY: "kagikagi0002" });
    const { requests, transport } = wikimedia();
    // A keyless chain (Wikimedia), and one provider of the web-search chain asked on its own.
    await expect(reference("hotels kagikagi0002", env, transport)).rejects.toThrow(/looks like it holds a key or a password, so it was not sent/);
    await expect(webSearch({ query: "ramen bravebrave01", provider: "kagi-own-key" }, deps(env, transport))).rejects.toThrow(
      /looks like it holds a key or a password, so it was not sent/,
    );
    // Also a key of a provider this space switched off.
    const roots = path.join(base, "skills");
    fs.mkdirSync(path.join(roots, "instafy-web-research", "references"), { recursive: true });
    fs.writeFileSync(path.join(roots, "instafy-web-research", "references", "search-providers.json"), JSON.stringify({ schema: "instafy.search-providers@1", off: ["brave-own-key"] }));
    await expect(reference("ramen bravebrave01", env, transport, {}, { skillRoots: [roots] })).rejects.toThrow(/looks like it holds a key or a password/);
    expect(requests).toHaveLength(0);
  });

  it("is in the built CLI", () => {
    const bundle = fs.readFileSync(path.resolve(here, "..", "dist", "cli.js"), "utf8");
    for (const needle of ["wikipedia.org/w/rest.php/v1/search/page", "wikivoyage.org/w/rest.php/v1/search/page", "query.wikidata.org/sparql", "reference-search"]) {
      expect(bundle, needle).toContain(needle);
    }
  });

  it("never uses Nominatim, and puts {lang} in a host only for a provider without a key", () => {
    const wikipedia = (BUNDLED_SEARCH_PROVIDERS as { providers: Record<string, any> }).providers.wikipedia;
    const catalog = loadSearchProviders({
      schema: "instafy.search-providers@1",
      providers: {
        geocoder: { ...wikipedia, request: { method: "GET", url: "https://nominatim.openstreetmap.org/search", query: { q: "{query}", format: "json" } } },
        keyed: { ...wikipedia, key_env: "WIKI_KEY", request: { ...wikipedia.request, auth: { header: "X-Key" } } },
        nolang: { ...wikipedia, defaults: undefined },
      },
      chains: { places: ["geocoder", "keyed", "nolang"] },
    });
    expect(catalog.providers.size).toBe(0);
    expect(catalog.warnings.join("\n")).toMatch(/geocoder: nominatim\.openstreetmap\.org is never used/);
    expect(catalog.warnings.join("\n")).toMatch(/keyed: only a provider without a key may put \{lang\} in its host/);
    expect(catalog.warnings.join("\n")).toMatch(/nolang: a provider with \{lang\} in its host needs defaults\.lang/);
  });
});
