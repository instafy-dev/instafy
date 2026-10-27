// `instafy web link`: guided mode for sites the web-research skill lists as link-only. The link is filled from the
// skill's own list (placeholders, each site's search template, home and deepLinks) and nothing is ever fetched, so these
// tests need no network at all.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import * as linkOnly from "@instafy/browser-action-policy/linkOnly";
import { registerWebCommand, LINK_ONLY_FILE, LINK_ONLY_SCHEMA } from "../src/web-read.js";
import { WEB_LINK_EXIT_OK, WEB_LINK_EXIT_USAGE, parseLinkValues, registerWebLinkCommand, runWebLinkCli, webLink } from "../src/web-link.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliBin = path.resolve(here, "..", "bin", "instafy.js");
const SKILL_LIST_PATH = path.resolve(here, "../../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json");
type ListedSite = {
  name: string;
  match: string[];
  kind: string;
  why: string;
  terms: { url: string; checked: string; quote: string; note?: string };
  home: string;
  deepLinks?: boolean;
  search?: string;
};
const SKILL_LIST = JSON.parse(fs.readFileSync(SKILL_LIST_PATH, "utf8")) as {
  placeholders: Record<string, { format: string; about: string }>;
  sites: ListedSite[];
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-web-link-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const bundled = () => {
  const merged = linkOnly.linkOnlyListFrom(SKILL_LIST);
  expect(merged.warnings).toEqual([]);
  return merged.list!;
};
const link = (site: string, values: Record<string, string | number> = {}) => linkOnly.guidedLink(bundled(), site, values);
const site = (name: string) => SKILL_LIST.sites.find((entry) => entry.name === name)!;
/** A list with the bundled placeholders and these sites, compiled, with its warnings. */
const compiled = (sites: unknown[]) =>
  linkOnly.compileLinkOnlyList({ schema: LINK_ONLY_SCHEMA, placeholders: SKILL_LIST.placeholders, sites }, { source: "test" });

describe("the skill's list: kinds, evidence and guided-mode data", () => {
  it("gives every site a kind and the terms it rests on: the page, the day it was read and the deciding clause", () => {
    expect(SKILL_LIST.sites.length).toBeGreaterThan(0);
    for (const entry of SKILL_LIST.sites) {
      expect(linkOnly.KINDS, entry.name).toContain(entry.kind);
      expect(entry.terms.url, entry.name).toMatch(/^https:\/\/[^\s]+$/);
      expect(entry.terms.checked, entry.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.terms.checked)), entry.name).toBe(false);
      expect(entry.terms.quote.trim().length, entry.name).toBeGreaterThan(10);
      expect(entry.terms.quote.length, entry.name).toBeLessThanOrEqual(200);
      // A site is read but not reused only with a note on why reading is not barred.
      if (entry.kind === "no-reuse") expect(entry.terms.note?.trim(), entry.name).toBeTruthy();
    }
    // Most sites bar agents outright; the strict kind is the default.
    expect(SKILL_LIST.sites.filter((entry) => entry.kind === "no-agents").length).toBeGreaterThan(SKILL_LIST.sites.length / 2);
    for (const name of ["Booking.com", "Agoda", "Airbnb", "Amazon", "Tripadvisor", "Expedia group"]) expect(site(name).kind, name).toBe("no-agents");
  });

  it("compiles every home page and search template without a warning, each on the site's own hosts", () => {
    const list = bundled();
    for (const entry of SKILL_LIST.sites) {
      const compiledSite = list.sites.find((candidate) => candidate.name === entry.name)!;
      expect(compiledSite.kind, entry.name).toBe(entry.kind);
      expect(compiledSite.home, entry.name).toBe(new URL(entry.home).href);
      expect(compiledSite.deepLinks, entry.name).toBe(entry.deepLinks !== false);
      expect(Boolean(compiledSite.search), entry.name).toBe(Boolean(entry.search));
      if (entry.deepLinks === false) expect(entry.search, `${entry.name} bars deep links`).toBeUndefined();
      // The home page and the search link are on the site itself, which every reader refuses as that site.
      for (const address of [entry.home, ...(entry.search ? [entry.search.replace(/\{[a-z_]+\}/g, "x")] : [])]) {
        expect(linkOnly.linkOnlyMatch(list, address)?.site, address).toBe(entry.name);
      }
    }
    // The sites whose terms bar deep links say so.
    for (const name of ["Agoda", "Tripadvisor", "Expedia group", "Trip.com"]) expect(site(name).deepLinks, name).toBe(false);
    expect(site("Booking.com").search).toMatch(/^https:\/\/www\.booking\.com\//);
  });
});

describe("filling a search link", () => {
  it("fills Booking.com's template with each value URL-encoded, and leaves out the values not given", () => {
    const result = link("booking.com", { query: "São Paulo & co=1#top", checkin: "2026-11-12", checkout: "2026-11-14", adults: "2", rooms: 1 });
    expect(result).toMatchObject({ ok: true, site: "Booking.com", kind: "no-agents", deepLinks: true, typeIn: [] });
    if (!result.ok) throw new Error(result.error);
    const url = new URL(result.link);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("www.booking.com");
    expect(url.hash).toBe("");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ss: "São Paulo & co=1#top",
      checkin: "2026-11-12",
      checkout: "2026-11-14",
      group_adults: "2",
      no_rooms: "1",
    });
    expect(result.link).toContain("ss=S%C3%A3o+Paulo+%26+co%3D1%23top&");
    expect(result.link).not.toContain("group_children");
    // The site's name, a host on it or an address on it all name it.
    for (const reference of ["Booking.com", "BOOKING.COM", "https://www.booking.com/hotel/x.html"]) {
      expect(linkOnly.guidedLink(bundled(), reference, { query: "Lisbon" }), reference).toMatchObject({ ok: true, link: "https://www.booking.com/searchresults.html?ss=Lisbon" });
    }
  });

  it("writes a path value as one encoded segment, so it cannot add segments or leave the site", () => {
    const result = link("Airbnb", { query: "Lisbon/../../evil.example?x=1", adults: 2 });
    if (!result.ok) throw new Error(result.error);
    expect(result.link).toBe("https://www.airbnb.com/s/Lisbon%2F..%2F..%2Fevil.example%3Fx%3D1/homes?adults=2");
    expect(new URL(result.link).pathname.split("/")).toHaveLength(4);
    // A path placeholder is required.
    expect(link("Airbnb", { adults: 2 })).toEqual({ ok: false, error: "the link needs {query}" });
  });

  it("gives the home page and what to type there when the site bars deep links, whatever values are given", () => {
    for (const name of ["Agoda", "agoda.com", "Tripadvisor", "Expedia group", "Trip.com"]) {
      const result = link(name, { query: "Lisbon", checkin: "2026-11-12", adults: "2" });
      expect(result, name).toMatchObject({ ok: true, deepLinks: false });
      if (!result.ok) throw new Error(result.error);
      expect(new URL(result.link).pathname, name).toBe("/");
      expect(new URL(result.link).search, name).toBe("");
      expect(result.link, name).toBe(result.home);
      expect(result.typeIn, name).toEqual([
        { name: "query", about: SKILL_LIST.placeholders.query!.about, value: "Lisbon" },
        { name: "checkin", about: SKILL_LIST.placeholders.checkin!.about, value: "2026-11-12" },
        { name: "adults", about: SKILL_LIST.placeholders.adults!.about, value: "2" },
      ]);
    }
    expect(link("Agoda")).toMatchObject({ ok: true, link: "https://www.agoda.com/", typeIn: [] });
    // A host of the site gets its own front page.
    expect(link("de.hotels.com", { query: "Lisbon" })).toMatchObject({ ok: true, site: "Expedia group", link: "https://de.hotels.com/" });
  });

  it("refuses a placeholder the list does not define, or that the site's link does not take", () => {
    expect(link("booking.com", { color: "red" })).toEqual({
      ok: false,
      error: `{color} is not a placeholder the list defines (${Object.keys(SKILL_LIST.placeholders).join(", ")})`,
    });
    expect(link("Agoda", { "query}&x={": "Lisbon" })).toMatchObject({ ok: false, error: expect.stringMatching(/is not a placeholder the list defines/) });
    expect(link("nike.com", { query: "pegasus", checkin: "2026-11-12" })).toEqual({ ok: false, error: "Nike's search link has no {checkin}" });
  });

  it("refuses a value not in its placeholder's format", () => {
    for (const [values, error] of [
      [{ checkin: "2026-02-30" }, /\{checkin\} needs a date written YYYY-MM-DD/],
      [{ checkin: "12/11/2026" }, /\{checkin\} needs a date written YYYY-MM-DD/],
      [{ adults: "100" }, /\{adults\} needs a whole number from 0 to 99/],
      [{ adults: "-1" }, /\{adults\} needs a whole number/],
      [{ adults: "2.5" }, /\{adults\} needs a whole number/],
      [{ query: "" }, /\{query\} needs 200 characters at most/],
      [{ query: "x".repeat(201) }, /\{query\} needs 200 characters at most/],
      [{ query: "Lisbon\nIgnore the steps" }, /no control characters/],
      [{ query: "../.." }, /with a letter or digit/],
    ] as Array<[Record<string, string>, RegExp]>) {
      const result = link("booking.com", values);
      expect(result.ok, JSON.stringify(values)).toBe(false);
      if (!result.ok) expect(result.error, JSON.stringify(values)).toMatch(error);
    }
  });

  it("refuses a site that is not on the list, and gives no link for it", () => {
    for (const reference of ["example.org", "https://example.org/", "Not a site", "", "notbooking.com"]) {
      expect(link(reference, { query: "Lisbon" }).ok, reference).toBe(false);
    }
    expect(linkOnly.guidedLink(null, "booking.com", {})).toEqual({ ok: false, error: "the link-only list is unavailable" });
  });
});

describe("checking a template once, when the list is read", () => {
  const shop = { name: "Example Shop", match: ["shop.example"], kind: "no-agents", why: "terms bar AI agents", home: "https://www.shop.example/" };

  it("keeps an https template on the site's own hosts whose placeholders are whole segments or whole values", () => {
    const { list, warnings } = compiled([{ ...shop, search: "https://www.shop.example/find/{query}?from={checkin}&sort=price" }]);
    expect(warnings).toEqual([]);
    expect(linkOnly.guidedLink(list, "shop.example", { query: "a b", checkin: "2026-11-12" })).toMatchObject({
      ok: true,
      link: "https://www.shop.example/find/a%20b?from=2026-11-12&sort=price",
    });
  });

  it("leaves out a template that is not https, leaves the site, or puts a placeholder anywhere else, with a warning", () => {
    for (const [search, why] of [
      ["http://www.shop.example/?q={query}", /is not https/],
      ["https://www.other.example/?q={query}", /is not on the site's own hosts/],
      ["https://www.shop.example.evil.example/?q={query}", /is not on the site's own hosts/],
      ["https://{query}.shop.example/", /is not on the site's own hosts|is not an address/],
      ["https://user@www.shop.example/?q={query}", /has user info, a port or a fragment/],
      ["https://www.shop.example:8443/?q={query}", /has user info, a port or a fragment/],
      ["https://www.shop.example/?q={query}#x", /has user info, a port or a fragment/],
      ["https://www.shop.example/item-{query}/", /is not a whole path segment/],
      ["https://www.shop.example/?q=best+{query}", /is not a whole query value/],
      ["https://www.shop.example/?{query}=1", /is not a whole query value/],
      ["https://www.shop.example/?q={query}&r={query}", /uses a placeholder twice/],
      ["https://www.shop.example/?q={colour}", /uses \{colour\}, which the list's placeholders do not define/],
      ["https://www.shop.example/?q={query", /has a \{ or \} that is not a placeholder/],
      ["https://www.shop.example/?q=instafyplaceholder0x", /is not a link/],
      [42, /is not a link/],
    ] as Array<[unknown, RegExp]>) {
      const { list, warnings } = compiled([{ ...shop, search }]);
      expect(warnings.join("\n"), String(search)).toMatch(why);
      expect(list!.sites[0]!.search, String(search)).toBeNull();
      // The site itself is still listed, and its home page is what the person gets.
      expect(linkOnly.guidedLink(list, "shop.example", { query: "x" }), String(search)).toMatchObject({ ok: true, link: "https://www.shop.example/" });
    }
  });

  it("leaves out a home page off the site, and a template on a site that bars deep links", () => {
    const { list, warnings } = compiled([
      { ...shop, home: "https://elsewhere.example/" },
      { ...shop, name: "Deep", match: ["deep.example"], home: "https://deep.example/", deepLinks: false, search: "https://deep.example/?q={query}" },
      { ...shop, name: "Odd", match: ["odd.example"], home: "https://odd.example/", deepLinks: "no", search: "https://odd.example/?q={query}" },
    ]);
    expect(warnings.join("\n")).toMatch(/Example Shop's home is not an https address on its own hosts/);
    expect(warnings.join("\n")).toMatch(/Deep bars deep links, so its search link was left out/);
    expect(warnings.join("\n")).toMatch(/Odd has a deepLinks other than true or false, so it gets no deep links/);
    expect(list!.sites.map((entry) => [entry.home, entry.deepLinks, entry.search])).toEqual([
      [null, true, null],
      ["https://deep.example/", false, null],
      ["https://odd.example/", false, null],
    ]);
    expect(linkOnly.guidedLink(list, "shop.example", { query: "x" })).toMatchObject({ ok: true, link: "https://shop.example/" });
  });

  it("lets a space's copy add a template, or bar deep links, but never allow them for a site that bars them", () => {
    const space = {
      schema: LINK_ONLY_SCHEMA,
      placeholders: { query: { format: "count", about: "redefined" }, colour: { format: "text", about: "a colour" } },
      sites: [
        { name: "Booking.com", match: ["booking.com"], kind: "no-agents", why: "this space keeps to the home page", deepLinks: false },
        { name: "Agoda", match: ["agoda.com"], kind: "no-agents", why: "tries to allow deep links", home: "https://www.agoda.com/", search: "https://www.agoda.com/search?city={query}" },
        { name: "Example Shop", match: ["shop.example"], why: "terms bar AI agents", home: "https://shop.example/", search: "https://shop.example/?c={colour}&q={query}" },
      ],
    };
    const merged = linkOnly.linkOnlyListFrom(SKILL_LIST, [{ data: space, source: "space" }]);
    expect(merged.warnings).toEqual([]);
    const list = merged.list!;
    // Stricter: Booking.com now gets its home page only.
    expect(linkOnly.guidedLink(list, "booking.com", { query: "Lisbon" })).toMatchObject({ ok: true, deepLinks: false, link: "https://www.booking.com/" });
    // Never looser: Agoda still bars deep links.
    expect(linkOnly.guidedLink(list, "agoda.com", { query: "Lisbon" })).toMatchObject({ ok: true, deepLinks: false, link: "https://www.agoda.com/" });
    // A space's own site and placeholder; a bundled placeholder keeps its meaning.
    expect(linkOnly.guidedLink(list, "shop.example", { colour: "red", query: "kettle" })).toMatchObject({
      ok: true,
      link: "https://shop.example/?c=red&q=kettle",
    });
    expect(list.placeholders.query!.format).toBe("text");
  });
});

describe("the command", () => {
  const io = () => {
    const out: string[] = [];
    return { out, io: { out: (line: string) => out.push(line), err: (line: string) => out.push(line) } };
  };
  const deps = { skillRoots: [] as string[] };

  it("prints the link, the kind and what Octo does with it, as JSON or text", async () => {
    const json = io();
    expect(await runWebLinkCli("booking.com", ["query=Lisbon", "checkin=2026-11-12", "adults=2"], { json: true }, json.io, deps)).toBe(WEB_LINK_EXIT_OK);
    const report = JSON.parse(json.out[0]!);
    expect(report).toMatchObject({
      ok: true,
      site: "Booking.com",
      kind: "no-agents",
      link: "https://www.booking.com/searchresults.html?ss=Lisbon&checkin=2026-11-12&group_adults=2",
    });
    expect(report.tell).toMatch(/Octo never opens or reads this link, in any tab or reader\./);
    expect(report.tell).toMatch(/short numbered steps/);
    expect(report.tell).toMatch(/press "Send page to Octo" on each\. Work only from the pages they send\./);
    const text = io();
    expect(await runWebLinkCli("Agoda", ["query=Lisbon"], {}, text.io, deps)).toBe(WEB_LINK_EXIT_OK);
    expect(text.out[0]).toMatch(/^Agoda \(no-agents, no deep links\)\nlink: https:\/\/www\.agoda\.com\/\ntype: .*: Lisbon\n/);
    // A "no-reuse" site is readable; the tell says how its content may be used.
    const reuse = io();
    expect(await runWebLinkCli("runrepeat.com", [], { json: true }, reuse.io, deps)).toBe(WEB_LINK_EXIT_OK);
    expect(JSON.parse(reuse.out[0]!)).toMatchObject({ kind: "no-reuse", link: "https://runrepeat.com/" });
    expect(JSON.parse(reuse.out[0]!).tell).toMatch(/never copy its reviews, photos or price lists/);
  });

  it("refuses a value that is not name=value, a name given twice, an unknown placeholder or an unlisted site with exit 64", async () => {
    expect(() => parseLinkValues(["Lisbon"])).toThrow(/is not name=value/);
    expect(() => parseLinkValues(["query=a", "query=b"])).toThrow(/query is given twice/);
    expect({ ...parseLinkValues(["query=a=b", "adults=2"]) }).toEqual({ query: "a=b", adults: "2" });
    expect(webLink("booking.com", parseLinkValues(["__proto__=x"]), deps)).toMatchObject({ ok: false, error: expect.stringMatching(/\{__proto__\} is not a placeholder/) });
    for (const [site, pairs] of [
      ["booking.com", ["Lisbon"]],
      ["booking.com", ["color=red"]],
      ["example.org", ["query=Lisbon"]],
    ] as Array<[string, string[]]>) {
      const run = io();
      expect(await runWebLinkCli(site, pairs, { json: true }, run.io, deps), `${site} ${pairs}`).toBe(WEB_LINK_EXIT_USAGE);
      expect(JSON.parse(run.out[0]!)).toMatchObject({ ok: false, exitCode: WEB_LINK_EXIT_USAGE });
    }
  });

  it("fails closed when the bundled list does not load", async () => {
    const run = io();
    expect(await runWebLinkCli("booking.com", [], { json: true }, run.io, { skillRoots: [], bundledLinkOnly: null })).toBe(70);
    expect(JSON.parse(run.out[0]!).error).toMatch(/link-only site list .* could not be loaded/);
  });

  it("adds the space's own copy of the list", () => {
    const skills = path.join(tmp, "skills");
    const file = path.join(skills, "instafy-web-research", "references", LINK_ONLY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: LINK_ONLY_SCHEMA,
        sites: [{ name: "Example Shop", match: ["shop.example"], why: "terms bar AI agents", home: "https://shop.example/", search: "https://shop.example/?q={query}" }],
      }),
    );
    expect(webLink("Example Shop", { query: "kettle" }, { skillRoots: [skills] })).toMatchObject({ ok: true, kind: "no-agents", link: "https://shop.example/?q=kettle" });
  });

  it("is registered as `instafy web link`, and the built CLI carries it", () => {
    const program = new Command();
    registerWebLinkCommand(registerWebCommand(program));
    const web = program.commands.find((command) => command.name() === "web")!;
    expect(web.commands.map((command) => command.name())).toEqual(["read", "link"]);
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const run = spawnSync(process.execPath, [cliBin, "web", "link", "booking.com", "query=Lisbon", "adults=2", "--json"], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, INSTAFY_SKILL_PACKS_DIR: "" },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(WEB_LINK_EXIT_OK);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, link: "https://www.booking.com/searchresults.html?ss=Lisbon&group_adults=2" });
  });
});
