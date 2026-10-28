// The shopping comparison eval (test/web-compare-eval.mjs) on its hand-written fixtures: three robot vacuums under 600
// EUR, "the official site and two independent reviews", as a comparison page. The reference turn is played with the
// real `instafy web search` (reference search too), `instafy web read` and `instafy web link` (this test build answers
// from the fixtures; Wikimedia's answers come from a test transport), and its page is the compare starter with the
// turn's data.json. It passes every check with a search key and without one, and each way of breaking a rule (an
// invented price, a sibling model's review counted, a filter that lets an unknown price through, a dash for a value)
// fails exactly the checks for that rule.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webLink } from "../src/web-link.js";
import { webRead } from "../src/web-read.js";
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
};
type Transcript = Record<string, any>;
type Edit = (t: Transcript, change: (data: any, dir: string) => void) => Transcript;
type Breaker = [string, (t: Transcript, k: Kase, edit: Edit) => Transcript, string[]];

const { CASE, BREAKERS, NO_PROVIDER_BREAKERS, failedIds, gradeCompare, referenceAnswer, referencePage, referenceReply, reviewsAsked, writeCompareFixtures } = evalKit as {
  CASE: Kase;
  BREAKERS: Breaker[];
  NO_PROVIDER_BREAKERS: Breaker[];
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
const START = Date.parse("2026-10-27T09:00:00Z");
const KEY = "BSAcomparekey00fixtureonly3";

beforeAll(() => {
  writeCompareFixtures(FIXTURES);
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
/**
 * The reference turn: reference search for the brand's official site, the maker's pages (the latest models, then each
 * model's page), with a key one search per model for its reviews and one for the S8's price, the reviews and the shop
 * page those searches found (never the link-only hit, the poisoned one, a sibling model's review or the maker's own),
 * a guided link to the link-only shop for each price that could not be read, and the page built with the compare
 * starter.
 */
async function referenceTurn({ key }: { key: boolean }): Promise<Transcript> {
  turnNo += 1;
  let clock = START + turnNo * 3_600_000;
  const env: NodeJS.ProcessEnv = {
    INSTAFY_WEB_FIXTURES: FIXTURES,
    INSTAFY_TURN_STARTED_AT: new Date(clock).toISOString(),
    INSTAFY_TURN_DEADLINE: new Date(clock + 600_000).toISOString(),
    INSTAFY_PROJECT_ID: `compare-${turnNo}`,
    ...(key ? { BRAVE_SEARCH_API_KEY: KEY } : {}),
  };
  const common = { now: () => clock, skillRoots: [] as string[], env, cwd: tmp };
  const searches: Transcript[] = [];
  const reads: Transcript[] = [];
  const findings: Transcript[] = [];
  const readDeps = {
    ...common,
    stateDir: path.join(tmp, "read-state", String(turnNo)),
    cacheDir: null,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const read = async (urls: string[]) => {
    const report = await webRead({ urls }, readDeps);
    for (const p of report.pages) {
      reads.push({ url: p.requestedUrl, status: p.status, ...(p.code ? { code: p.code } : {}) });
      if (p.status === "read") findings.push({ url: p.requestedUrl, title: p.provenance.title, readAt: p.provenance.readAt, viewer: p.provenance.viewer, facts: [] });
    }
    return report;
  };

  // The official site, from the open reference search (no key; its answers come from the test transport).
  const { INSTAFY_WEB_FIXTURES: _fixtures, ...openEnv } = env;
  const reference = await webSearch(
    { query: CASE.brand, chain: "reference-search" },
    { ...common, env: openEnv, stateDir: path.join(tmp, "search-state", String(turnNo)), resolve: async () => [{ address: "185.15.59.224", family: 4 }], transport: wikimedia },
  );
  searches.push({ query: reference.query, chain: "reference-search", status: reference.status, results: reference.results });
  const official = reference.results.find((r) => r.provider === "wikidata-official-site")!.url;
  expect(official).toBe(CASE.official.url);
  await read([official]);
  // Each model's own page: one gives no price, one refuses the read.
  await read(CASE.items.map((i) => i.page.url));

  const pick: string[] = [];
  let offer: Transcript | null = null;
  const queries = key ? [...CASE.items.map((i) => `${i.name} reviews`), `${CASE.items[0]!.name} price`] : [`${CASE.items[0]!.name} reviews`];
  for (const query of queries) {
    const search = await webSearch({ query }, { ...common, stateDir: path.join(tmp, "search-state", String(turnNo)) });
    searches.push({ query: search.query, status: search.status, results: search.results, ...(search.offer ? { offer: search.offer } : {}) });
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

  it("without a search key: the turn says what it could not find, offers the key card once, and guides the person", async () => {
    const reference = await referenceTurn({ key: false });
    expect(reference.searches[1]).toMatchObject({ status: "no_provider", offer: { type: "request_secret", name: "BRAVE_SEARCH_API_KEY" } });
    const checks = gradeCompare(reference);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.pass))).toEqual([]);
    for (const [what, breakIt, expected] of NO_PROVIDER_BREAKERS) {
      const result = gradeCompare(breakIt(clone(reference), CASE, edit));
      expect(failedIds(result), `${what}: ${JSON.stringify(result.filter((c) => !c.pass))}`).toEqual([...expected].sort());
    }
  });

  it("grades by rules the skills and the starter state", () => {
    const flat = (s: string) => s.replace(/\s+/g, " ");
    const skills = path.join(path.dirname(new URL(import.meta.url).pathname), "../../runtime-agent/assets/instafy/.agents/skills");
    const research = flat(fs.readFileSync(path.join(skills, "instafy-web-research/SKILL.md"), "utf8"));
    for (const rule of [
      "## Comparing items",
      "None there, or a stop: say so (\"no price on <host>'s page\", \"<host> blocks automated price checks\")",
      "`instafy web search \"<name> price\" --json`, or `--chain reference-search` for shops' official sites",
      "a link-only shop gets `instafy web link <site> query=<name>` (Guided mode)",
      "never a remembered or guessed price",
      "that many per item, each on that exact model, by a publisher other than the maker, the shops and each other (a sibling model's review does not count)",
      "Short: \"<item>: 1 of 2 reviews found\", in the reply and on the page.",
      "an item without a price read this turn is never listed or described as within it",
      "and an item's name as its official page gives it",
    ]) {
      expect(research, rule).toContain(rule);
    }
    const hub = flat(fs.readFileSync(path.join(skills, "instafy-interactive-artifacts/SKILL.md"), "utf8"));
    for (const rule of [
      "each value names the page it was read on and the day; one nobody found reads `Unknown` and why",
      "never a blank or a dash",
      "an item whose value is unknown is listed apart (\"Price unknown\"), never as within it, on the page, in the lede and in the reply",
      "`site.byFilter`",
    ]) {
      expect(hub, rule).toContain(rule);
    }
  });
});
