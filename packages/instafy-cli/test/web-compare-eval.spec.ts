// The shopping comparison eval (test/web-compare-eval.mjs) on its hand-written fixtures: three robot vacuums under 600
// EUR, "the official site and two independent reviews", as a comparison page. The reference turn is played with the
// real `instafy web search` (reference search too), `instafy web read` and `instafy web link` (this test build answers
// from the fixtures; Wikimedia's answers come from a test transport), and its page is the compare starter with the
// turn's data.json. The maker's official website as Wikidata records it is its bare domain, which does not answer: the
// read's tell names the "www." address, which does. It passes every check with a search key and without one (then the
// reviews come from a reviewer's home page), and each way of breaking a rule (an invented price, a sibling model's
// review counted, a filter that lets an unknown price through, a dash for a value, the 28 Oct drive's turn that asked
// for a key and the browser and built nothing) fails exactly the checks for that rule. When the maker's site never
// answers (the third 28 Oct drive), the turn reads a reviewer's home page and lists every model it names, each
// price unknown and never within the limit; the drive's turn (the maker's site only, then a page with no rows) fails.
// When no review can be read either, the turn searches, tries every review the search found, and lists the models the
// search results name, each "not checked" (its row names the result's site in "found"); placeholder rows ("candidate
// 1/2/3") and rows that say nowhere where they come from fail.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webLink } from "../src/web-link.js";
import { webRead, wwwSibling } from "../src/web-read.js";
import { webSearch, type SearchTransport } from "../src/web-search.js";
// @ts-expect-error -- a plain ES module, also run on its own to grade a model's transcript
import * as evalKit from "./web-compare-eval.mjs";
// @ts-expect-error -- the bound-sites starters, a plain ES module
import { initSite } from "../../instafy-bind/src/init.mjs";

type Check = { id: string; pass: boolean; detail: string };
type Item = { slug: string; name: string; page: { url: string; status?: number } };
type Kase = {
  ask: string;
  brand: string;
  official: { url: string };
  items: Item[];
  shops: Array<{ item: string; url: string }>;
  reviews: Array<{ item: string; url: string; model?: string; independent?: boolean }>;
  linkOnly: { url: string; title: string };
  poisoned: { url: string };
  searches: Record<string, string[]>;
  wikidata: { website: string };
  hubs: Array<{ url: string; reviews: string[] }>;
};
type Transcript = Record<string, any>;
type Edit = (t: Transcript, change: (data: any, dir: string) => void) => Transcript;
type Breaker = [string, (t: Transcript, k: Kase, edit: Edit) => Transcript, string[]];

const { CASE, OFFICIAL_DOWN_CASE, SEARCH_ONLY_CASE, BREAKERS, NO_PROVIDER_BREAKERS, OFFICIAL_DOWN_BREAKERS, SEARCH_ONLY_BREAKERS, failedIds, gradeCompare, officialDownPage, officialDownReply, searchOnlyPage, searchOnlyReply, referenceAnswer, referencePage, referenceReply, reviewsAsked, writeCompareFixtures } = evalKit as {
  CASE: Kase;
  OFFICIAL_DOWN_CASE: Kase;
  SEARCH_ONLY_CASE: Kase;
  BREAKERS: Breaker[];
  NO_PROVIDER_BREAKERS: Breaker[];
  OFFICIAL_DOWN_BREAKERS: Breaker[];
  SEARCH_ONLY_BREAKERS: Breaker[];
  officialDownPage: (kase: Kase, readAt: string) => Record<string, any>;
  officialDownReply: (kase: Kase, readAt: string, o: { links: Record<string, string> }) => string;
  searchOnlyPage: (kase: Kase) => Record<string, any>;
  searchOnlyReply: (kase: Kase, o: { links: Record<string, string> }) => string;
  failedIds: (checks: Check[]) => string[];
  gradeCompare: (transcript: Transcript, kase?: Kase) => Check[];
  referenceAnswer: (kase: Kase, hostname: string) => unknown;
  referencePage: (kase: Kase, readAt: string, o: { key: boolean }) => Record<string, any>;
  referenceReply: (kase: Kase, readAt: string, o: { key: boolean; links: Record<string, string> }) => string;
  reviewsAsked: (ask: string) => number;
  writeCompareFixtures: (folder: string, kase?: Kase) => string;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-web-compare-eval-"));
const FIXTURES = path.join(tmp, "fixtures");
const FIXTURES_DOWN = path.join(tmp, "fixtures-official-down");
const FIXTURES_SEARCH_ONLY = path.join(tmp, "fixtures-search-only");
const START = Date.parse("2026-10-27T09:00:00Z");
const KEY = "BSAcomparekey00fixtureonly3";

beforeAll(() => {
  writeCompareFixtures(FIXTURES);
  writeCompareFixtures(FIXTURES_DOWN, OFFICIAL_DOWN_CASE);
  writeCompareFixtures(FIXTURES_SEARCH_ONLY, SEARCH_ONLY_CASE);
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Wikimedia's answers for the brand (reference search needs no key); nothing leaves the machine. */
const wikimedia: SearchTransport = async (request) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify(referenceAnswer(CASE, request.url.hostname))),
});

let turnNo = 0;
/** One turn's real readers on a fixture folder: `read` and `search` record what they did, as a transcript keeps it. */
function startTurn(fixtures: string, { key }: { key: boolean }) {
  turnNo += 1;
  const time = { clock: START + turnNo * 3_600_000 };
  const env: NodeJS.ProcessEnv = {
    INSTAFY_WEB_FIXTURES: fixtures,
    INSTAFY_TURN_STARTED_AT: new Date(time.clock).toISOString(),
    INSTAFY_TURN_DEADLINE: new Date(time.clock + 600_000).toISOString(),
    INSTAFY_PROJECT_ID: `compare-${turnNo}`,
    ...(key ? { BRAVE_SEARCH_API_KEY: KEY } : {}),
  };
  const common = { now: () => time.clock, skillRoots: [] as string[], env, cwd: tmp };
  const searches: Transcript[] = [];
  const reads: Transcript[] = [];
  const findings: Transcript[] = [];
  const readDeps = {
    ...common,
    stateDir: path.join(tmp, "read-state", String(turnNo)),
    cacheDir: null,
    sleep: async (ms: number) => {
      time.clock += ms;
    },
  };
  const read = async (urls: string[], find?: string) => {
    const report = await webRead({ urls, ...(find ? { find } : {}) }, readDeps);
    for (const p of report.pages) {
      reads.push({ url: p.requestedUrl, status: p.status, ...(p.code ? { code: p.code } : {}) });
      if (p.status === "read") findings.push({ url: p.requestedUrl, title: p.provenance.title, readAt: p.provenance.readAt, viewer: p.provenance.viewer, facts: [] });
    }
    return report;
  };
  const searchState = path.join(tmp, "search-state", String(turnNo));
  /** The official site, from the open reference search (no key; its answers come from the test transport). */
  const officialSite = async (kase: Kase) => {
    const { INSTAFY_WEB_FIXTURES: _fixtures, ...openEnv } = env;
    const reference = await webSearch(
      { query: kase.brand, chain: "reference-search" },
      { ...common, env: openEnv, stateDir: searchState, resolve: async () => [{ address: "185.15.59.224", family: 4 }], transport: wikimedia },
    );
    searches.push({ query: reference.query, chain: "reference-search", status: reference.status, results: reference.results });
    return reference.results.find((r) => r.provider === "wikidata-official-site")!.url;
  };
  return { env, common, searches, reads, findings, read, searchState, officialSite };
}

/**
 * The reference turn: reference search for the brand's official site, the maker's pages (the latest models, then each
 * model's page), with a key one search per model for its reviews and one for the S8's price, the reviews and the shop
 * page those searches found (never the link-only hit, the poisoned one, a sibling model's review or the maker's own),
 * a guided link to the link-only shop for each price that could not be read, and the page built with the compare
 * starter.
 */
async function referenceTurn({ key }: { key: boolean }): Promise<Transcript> {
  const { env, common, searches, reads, findings, read, searchState, officialSite } = startTurn(FIXTURES, { key });
  const official = await officialSite(CASE);
  expect(official).toBe(CASE.wikidata.website);
  // Wikidata records the bare domain, which does not answer; the read's tell names the www. address, read once.
  const bare = await read([official]);
  const www = wwwSibling(new URL(official))!.href;
  expect(bare.pages[0]).toMatchObject({ status: "failed", code: "unreachable" });
  expect(bare.pages[0]!.tell).toContain(`read ${www} once instead`);
  expect(www).toBe(CASE.official.url);
  await read([www]);
  // Each model's own page: one gives no price, one refuses the read.
  await read(CASE.items.map((i) => i.page.url));

  const pick: string[] = [];
  let offer: Transcript | null = null;
  const queries = key ? [...CASE.items.map((i) => `${i.name} reviews`), `${CASE.items[0]!.name} price`] : [`${CASE.items[0]!.name} reviews`];
  for (const query of queries) {
    const search = await webSearch({ query }, { ...common, stateDir: searchState });
    searches.push({ query: search.query, status: search.status, results: search.results, tell: search.tell, ...(search.offer ? { offer: search.offer } : {}) });
    if (search.status === "no_provider") {
      offer = search.offer ?? null;
      break;
    }
    // Leads only: an independent review of that exact model, or a shop's page; never the link-only hit, the poisoned
    // result, a sibling model's review or the maker's own page.
    for (const result of search.results) {
      if (result.linkOnly || pick.includes(result.url)) continue;
      const review = CASE.reviews.find((r) => r.url === result.url);
      const shop = CASE.shops.find((s) => s.url === result.url);
      if ((review && !review.model && review.independent !== false) || (shop && query.endsWith(" price"))) pick.push(result.url);
    }
  }
  if (!key) {
    // No key: the reviews a reviewer's home page links to, of each exact model (never a guessed review address).
    const hub = (await read([CASE.hubs[0]!.url], CASE.items.map((i) => `"${i.name}"`).join(" "))).pages[0]!;
    expect(hub.status).toBe("read");
    for (const item of CASE.items) {
      const link = hub.links?.find((l) => l.text.toLowerCase().startsWith(`${item.name.toLowerCase()} review`));
      if (link) pick.push(link.href);
    }
  }
  if (pick.length) await read(pick);

  // A guided link to the link-only shop for each model whose price could not be read.
  const priced = new Set(key ? ["s8", "q5"] : ["q5"]);
  const links: Transcript[] = [];
  for (const item of CASE.items.filter((i) => !priced.has(i.slug))) {
    const guided = webLink("amazon", { query: item.name }, { skillRoots: [], env, cwd: tmp });
    if (guided.ok === false) throw new Error(guided.error);
    links.push({ site: "amazon", query: item.name, link: guided.link, slug: item.slug });
  }
  const readAt = findings[0]!.readAt;
  const reply = referenceReply(CASE, readAt, { key, links: Object.fromEntries(links.map((l) => [l.slug, l.link])) });
  const site = path.join(tmp, "sites", `compare-${turnNo}`);
  initSite(site, { starter: "compare" });
  fs.writeFileSync(path.join(site, "data.json"), JSON.stringify(referencePage(CASE, readAt, { key }), null, 2));
  return { searches, reads, findings, links: links.map(({ slug: _slug, ...l }) => l), reply, site, actions: offer ? [offer] : [] };
}

/**
 * The maker's site never answers (the third 28 Oct drive): its address from reference search and the www. one, each
 * tried once; the search, which has no key; then an independent source, a reviewer's home page, which names the
 * three latest models and links a review of each; those reviews; a guided link per price; and the page built with the
 * compare starter: a row per model, each price unknown.
 */
async function officialDownTurn(): Promise<Transcript> {
  const kase = OFFICIAL_DOWN_CASE;
  const { env, common, searches, reads, findings, read, searchState, officialSite } = startTurn(FIXTURES_DOWN, { key: false });
  const official = await officialSite(kase);
  const bare = await read([official]);
  expect(bare.pages[0]).toMatchObject({ status: "failed", code: "unreachable" });
  const www = wwwSibling(new URL(official))!.href;
  const second = await read([www]);
  expect(second.pages[0]).toMatchObject({ status: "failed", code: "unreachable" });
  const search = await webSearch({ query: `${kase.brand} robot vacuums reviews` }, { ...common, stateDir: searchState });
  searches.push({ query: search.query, status: search.status, results: search.results, tell: search.tell, ...(search.offer ? { offer: search.offer } : {}) });
  expect(search.status).toBe("no_provider");
  // Two failures on the official site: an independent source before building. Its links name the candidates.
  const hub = (await read([kase.hubs[0]!.url], `"${kase.brand}"`)).pages[0]!;
  expect(hub.status).toBe("read");
  const pick = (hub.links ?? []).filter((l) => / review\b/i.test(l.text) && kase.items.some((i) => l.text.toLowerCase().startsWith(`${i.name.toLowerCase()} review`)));
  expect(pick).toHaveLength(kase.items.length);
  await read(pick.map((l) => l.href));
  const links: Record<string, string> = {};
  const guided: Transcript[] = [];
  for (const item of kase.items) {
    const g = webLink("amazon", { query: item.name }, { skillRoots: [], env, cwd: tmp });
    if (g.ok === false) throw new Error(g.error);
    links[item.slug] = g.link;
    guided.push({ site: "amazon", query: item.name, link: g.link });
  }
  const readAt = findings[0]!.readAt;
  const site = path.join(tmp, "sites", `compare-${turnNo}`);
  initSite(site, { starter: "compare" });
  fs.writeFileSync(path.join(site, "data.json"), JSON.stringify(officialDownPage(kase, readAt), null, 2));
  return { searches, reads, findings, links: guided, reply: officialDownReply(kase, readAt, { links }), site, actions: search.offer ? [search.offer] : [] };
}

/**
 * Neither the maker's site nor any review answers a reader (29 Oct drive 4): the maker's two addresses, each tried
 * once; then, as two failed pages on one site say, a search for reviews, every review it found tried (each refuses
 * automated reads); a guided link per price; and the page built with the compare starter: a row per model the search
 * results name, each "not checked".
 */
async function searchOnlyTurn(): Promise<Transcript> {
  const kase = SEARCH_ONLY_CASE;
  const { env, common, searches, reads, read, searchState, officialSite } = startTurn(FIXTURES_SEARCH_ONLY, { key: true });
  const official = await officialSite(kase);
  expect((await read([official])).pages[0]).toMatchObject({ status: "failed", code: "unreachable" });
  expect((await read([wwwSibling(new URL(official))!.href])).pages[0]).toMatchObject({ status: "failed", code: "unreachable" });
  const search = await webSearch({ query: `${kase.brand} robot vacuums reviews` }, { ...common, stateDir: searchState });
  searches.push({ query: search.query, status: search.status, results: search.results, tell: search.tell });
  expect(search.status).toBe("ok");
  const leads = search.results.filter((r) => !r.linkOnly).map((r) => r.url);
  expect(leads).toHaveLength(kase.items.length);
  for (const page of (await read(leads)).pages) expect(page).toMatchObject({ status: "stopped", code: "forbidden" });
  const links: Record<string, string> = {};
  const guided: Transcript[] = [];
  for (const item of kase.items) {
    const g = webLink("amazon", { query: item.name }, { skillRoots: [], env, cwd: tmp });
    if (g.ok === false) throw new Error(g.error);
    links[item.slug] = g.link;
    guided.push({ site: "amazon", query: item.name, link: g.link });
  }
  const site = path.join(tmp, "sites", `compare-${turnNo}`);
  initSite(site, { starter: "compare" });
  fs.writeFileSync(path.join(site, "data.json"), JSON.stringify(searchOnlyPage(kase), null, 2));
  return { searches, reads, findings: [], links: guided, reply: searchOnlyReply(kase, { links }), site, actions: [] };
}

let edits = 0;
/** A copy of the transcript whose page is a copy of its folder, changed by `change(data, dir)`. */
const edit: Edit = (t, change) => {
  edits += 1;
  const dir = path.join(tmp, "edits", String(edits));
  fs.cpSync(t.site, dir, { recursive: true });
  const file = path.join(dir, "data.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  change(data, dir);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { ...t, site: dir };
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("the shopping comparison eval (fixtures)", () => {
  it("asks for two independent reviews per item, and its fixtures hold each case the live test hit", () => {
    expect(reviewsAsked(CASE.ask)).toBe(2);
    expect(CASE.items.map((i) => i.page.status ?? 200)).toEqual([200, 403, 200]);
    expect(CASE.reviews.filter((r) => r.model)).toHaveLength(1);
    expect(CASE.reviews.filter((r) => r.independent === false)).toHaveLength(1);
    // the maker's recorded website is its bare domain, which the fixtures do not answer; its www. host does
    expect(new URL(CASE.wikidata.website).hostname).toBe("brightvac.example");
    expect(new URL(CASE.official.url).hostname).toBe("www.brightvac.example");
    expect(CASE.hubs).toHaveLength(1);
  });

  it("with a search key: the reference turn passes, and each broken rule is caught", async () => {
    const reference = await referenceTurn({ key: true });
    // The real commands did what the turn relies on: the official site came from reference search, the maker's page
    // of the S8 Pro refused the read, and the link-only hit came back as a link only.
    expect(reference.searches.map((s: Transcript) => [s.chain ?? "web-search", s.status])).toEqual([
      ["reference-search", "ok"],
      ["web-search", "ok"],
      ["web-search", "ok"],
      ["web-search", "ok"],
      ["web-search", "ok"],
    ]);
    expect(reference.reads[0]).toMatchObject({ url: CASE.wikidata.website, status: "failed", code: "unreachable" });
    expect(reference.reads.find((r: Transcript) => r.url.endsWith("/s8-pro"))).toMatchObject({ status: "stopped", code: "forbidden" });
    const hit = reference.searches[1].results.find((r: Transcript) => r.url === CASE.linkOnly.url);
    expect(hit.linkOnly).toBeTruthy();
    expect(hit.text).toBeUndefined();
    expect(reference.reads.filter((r: Transcript) => r.status === "read").map((r: Transcript) => new URL(r.url).host).sort()).toEqual([
      "www.brightvac.example",
      "www.brightvac.example",
      "www.brightvac.example",
      "www.review-one.example",
      "www.review-one.example",
      "www.review-one.example",
      "www.review-two.example",
      "www.shop-one.example",
    ]);
    const checks = gradeCompare(reference);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.pass))).toEqual([]);
    for (const [what, breakIt, expected] of BREAKERS) {
      const result = gradeCompare(breakIt(clone(reference), CASE, edit));
      expect(failedIds(result), `${what}: ${JSON.stringify(result.filter((c) => !c.pass))}`).toEqual([...expected].sort());
    }
  });

  it("without a search key: the turn reads the maker's site at its www. address and a publisher's reviews, builds the page, and offers the key card at most once", async () => {
    const reference = await referenceTurn({ key: false });
    expect(reference.searches[1]).toMatchObject({ status: "no_provider", offer: { type: "request_secret", name: "BRAVE_SEARCH_API_KEY" } });
    // the search's tell says to go on without it, never to stop and ask
    expect(reference.searches[1].tell).toMatch(/^This space has no search key\. Go on without it: find official sites/);
    expect(reference.reads.filter((r: Transcript) => r.status === "read").map((r: Transcript) => new URL(r.url).host).sort()).toEqual([
      "www.brightvac.example",
      "www.brightvac.example",
      "www.brightvac.example",
      "www.review-one.example",
      "www.review-one.example",
      "www.review-one.example",
      "www.review-one.example",
    ]);
    const checks = gradeCompare(reference);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.pass))).toEqual([]);
    for (const [what, breakIt, expected] of NO_PROVIDER_BREAKERS) {
      const result = gradeCompare(breakIt(clone(reference), CASE, edit));
      expect(failedIds(result), `${what}: ${JSON.stringify(result.filter((c) => !c.pass))}`).toEqual([...expected].sort());
    }
  });

  it("the maker's site never answers: the turn reads a reviewer's home page and its reviews and lists every model, prices unknown; the drive's turn fails", async () => {
    const reference = await officialDownTurn();
    // both of the maker's addresses failed, then an independent source and the reviews it links were read
    expect(reference.reads.slice(0, 2)).toEqual([
      { url: OFFICIAL_DOWN_CASE.wikidata.website, status: "failed", code: "unreachable" },
      { url: OFFICIAL_DOWN_CASE.official.url, status: "failed", code: "unreachable" },
    ]);
    expect(reference.reads.slice(2).map((r: Transcript) => [new URL(r.url).host, r.status])).toEqual([
      ["www.review-one.example", "read"],
      ["www.review-one.example", "read"],
      ["www.review-one.example", "read"],
      ["www.review-one.example", "read"],
    ]);
    // a row per model, each price unknown and listed apart from the limit
    const data = JSON.parse(fs.readFileSync(path.join(reference.site, "data.json"), "utf8"));
    expect(data.items.map((row: Transcript) => row.name)).toEqual(OFFICIAL_DOWN_CASE.items.map((i) => i.name));
    const checks = gradeCompare(reference, OFFICIAL_DOWN_CASE);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.pass))).toEqual([]);
    for (const [what, breakIt, expected] of OFFICIAL_DOWN_BREAKERS) {
      const result = gradeCompare(breakIt(clone(reference), OFFICIAL_DOWN_CASE, edit), OFFICIAL_DOWN_CASE);
      expect(failedIds(result), `${what}: ${JSON.stringify(result.filter((c) => !c.pass))}`).toEqual([...expected].sort());
    }
  });

  it("only a search names the models: the turn tries every review it found and lists the models, each not checked; placeholder rows fail", async () => {
    const reference = await searchOnlyTurn();
    expect(reference.reads.map((r: Transcript) => [new URL(r.url).host, r.status])).toEqual([
      ["brightvac.example", "failed"],
      ["www.brightvac.example", "failed"],
      ["www.review-one.example", "stopped"],
      ["www.review-one.example", "stopped"],
      ["www.review-one.example", "stopped"],
    ]);
    const data = JSON.parse(fs.readFileSync(path.join(reference.site, "data.json"), "utf8"));
    expect(data.items.map((row: Transcript) => row.name)).toEqual(SEARCH_ONLY_CASE.items.map((i) => i.name));
    // each row names the site of the search result that names it, which is where its reviews were found
    expect(data.items.map((row: Transcript) => row.found)).toEqual(SEARCH_ONLY_CASE.items.map(() => "www.review-one.example"));
    const checks = gradeCompare(reference, SEARCH_ONLY_CASE);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.pass))).toEqual([]);
    for (const [what, breakIt, expected] of SEARCH_ONLY_BREAKERS) {
      const result = gradeCompare(breakIt(clone(reference), SEARCH_ONLY_CASE, edit), SEARCH_ONLY_CASE);
      expect(failedIds(result), `${what}: ${JSON.stringify(result.filter((c) => !c.pass))}`).toEqual([...expected].sort());
    }
  });

  it("grades by rules the skills and the starter state", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    const skills = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../runtime-agent/assets/instafy/.agents/skills");
    const research = flat(fs.readFileSync(path.join(skills, "instafy-web-research/SKILL.md"), "utf8"));
    for (const rule of [
      "## Comparing items",
      "None there, or a stop: say so (\"no price on <page>\", \"<page> is closed to automated reads\")",
      "`instafy web search \"<name> price\" --json`, or `--chain reference-search` for shops' official sites",
      "a link-only shop gets `instafy web link <site> query=<name>` (Guided mode)",
      "never a remembered or guessed price",
      "that many per item, each on that exact model, by a publisher other than the maker, the shops and each other (a sibling model's review does not count)",
      "Short: \"<item>: 1 of 2 reviews found\", in the reply and on the page, citing only those reviews.",
      "an item with no price read this turn is listed as \"price unknown\", never as within it",
      "each fact not read marked unknown with why.",
      "and an item's name as its official page gives it",
      "`no_provider` (no key), `not_found` or `unavailable` never ends the task: go on with steps 3 and 5.",
      "for reviews, a reviewer's home page, then its links.",
      "An address that does not answer: once more with `www.` added or removed, as its `tell` says.",
      "Its `offer` (the key card, a `request_secret` action) may go in your reply once; never ask for a key in chat or wait for it.",
      "A failed search or site never ends the turn without the page: every item stays on it, each fact not read marked unknown with why.",
    ]) {
      expect(research, rule).toContain(rule);
    }
    // Another source after a failed page, and which names a comparison lists, are the browser skill's "Finding a
    // page", which the research skill points to.
    expect(research).toContain('as "Finding a page" in `instafy-browser-automation` says');
    const browser = flat(fs.readFileSync(path.join(skills, "instafy-browser-automation/SKILL.md"), "utf8"));
    for (const rule of [
      "## Finding a page",
      "A page that fails (busy, blank, or an error page such as 504): open the place's own site now, in this turn. After that, another official source.",
      "Comparing: list the models a page you read names, and mark one only a search result names \"not checked\". Never names from memory, never placeholders such as \"candidate 1\".",
      // a stopped page ends that page, never the research: the next source is "Finding a page"'s
      "ends that page, not the task: \"Finding a page\" says what comes next. Never retry that page another way.",
    ]) {
      expect(browser, rule).toContain(rule);
    }
    // The compare starter says how a row names where it comes from, and draws a search's names "Not checked".
    const starter = flat(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../instafy-bind/src/starters/compare/app.js"), "utf8").replace(/\n\s*\*\s+/g, " "));
    expect(starter).toContain("When only a search result names it, \"found\" is that result's site instead, and the row says \"Not checked\".");
    expect(starter).toContain("`instafy bind check` fails a row with neither: a guess or a placeholder.");
    const hub = flat(fs.readFileSync(path.join(skills, "instafy-interactive-artifacts/SKILL.md"), "utf8"));
    for (const rule of [
      "each value names the page it was read on and the day; one nobody found reads `Unknown` and why",
      "never a blank or a dash",
      "an item whose value is unknown is listed apart (\"Price unknown\"), never as within it, on the page, in the lede and in the reply",
      "`site.byFilter`",
      "A candidate nothing could be read for is still a row, with `Unknown` in each cell: a page of options is never empty (\"No options yet\") while a page you read named what to compare.",
    ]) {
      expect(hub, rule).toContain(rule);
    }
  });
});
