import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Link-only sites in the Personal Browser: the web-research skill owns the
// list, runtime-agent embeds the same file, and Desktop bundles it at build
// time and enforces it on every step the agent drives.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const linkOnly = require(path.join(packageRoot, "dist/personalBrowserLinkOnly.js"));
const security = require(path.join(packageRoot, "dist/personalBrowserSecurity.js"));

const SKILL_LIST = path.join(
  packageRoot,
  "../runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json",
);
const source = JSON.parse(fs.readFileSync(SKILL_LIST, "utf8"));
// The matching cases every reader runs through its own guard (`instafy web read`, the Shared Browser and this one).
const CASES = JSON.parse(fs.readFileSync(path.join(packageRoot, "../browser-action-policy/test/link-only-cases.json"), "utf8"));
// A case's address, with a long case's `{pad}` written out.
const caseUrl = (kase) => (kase.pad ? kase.url.replace("{pad}", kase.pad.text.repeat(kase.pad.times)) : kase.url);

test("the bundled link-only list is the web-research skill's own file, in every Desktop bundle that enforces it", () => {
  assert.deepEqual(linkOnly.BUNDLED_LINK_ONLY_SITES, source, "dist/personalBrowserLinkOnly.js was built from another copy");
  assert.equal(linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD.available, true);
  // The main process bundle (the Personal Browser host) carries the same list.
  const main = fs.readFileSync(path.join(packageRoot, "dist/main.js"), "utf8");
  assert.ok(source.wrappers.length > 0, "the skill's list names its wrappers");
  for (const site of [...source.sites, ...source.wrappers]) {
    assert.ok(main.includes(JSON.stringify(site.name)), `dist/main.js lacks ${site.name}`);
    for (const pattern of site.match) {
      assert.ok(main.includes(JSON.stringify(pattern)), `dist/main.js lacks ${pattern}`);
    }
  }
  // The matcher is the shared one, bundled into the main process too.
  assert.match(main, /__instafyLinkOnly/);
  // Single source: Desktop keeps no copy of its own.
  const copies = fs.readdirSync(path.join(packageRoot, "src")).filter((name) => name.endsWith(".json"));
  assert.deepEqual(copies, []);
});

test("every no-agents site in the skill's list is refused, and no no-reuse site, by the list's own matching rule", () => {
  const guard = linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD;
  assert.ok(source.sites.some((site) => site.kind === "no-reuse"), "the list has a site read but not reused");
  for (const site of source.sites) {
    for (const pattern of site.match) {
      const host = pattern.endsWith(".*") ? `${pattern.slice(0, -2)}.com` : pattern;
      for (const url of [`https://${host}/`, `https://www.${host}/x?y=1`, `http://${host.toUpperCase()}./`]) {
        const expected = site.kind === "no-reuse" ? null : { code: "link_only_site", site: site.name };
        const refusal = guard.refusal(url);
        assert.deepEqual(refusal === null ? null : { ...refusal }, expected, url);
      }
    }
  }
});

test("a no-reuse site is not refused, nor a copy or a page that says it is a copy of one; a no-agents one beside it still is", () => {
  const guard = linkOnly.createPersonalBrowserLinkOnlyGuard({
    schema: "instafy.link-only-sites@1",
    sites: [
      { name: "Reviews", match: ["reviews.example"], kind: "no-reuse" },
      { name: "Shop", match: ["shop.example"], kind: "no-agents" },
      { name: "Unknown kind", match: ["odd.example"], kind: "later" },
      { name: "Reviews, stricter", match: ["strict.reviews.example"] },
    ],
    wrappers: [{ name: "Archive", match: ["archive.example"], embeds: ["path", "query"] }],
  });
  for (const url of ["https://reviews.example/x", "https://archive.example/2024/https://reviews.example/x"]) {
    assert.equal(guard.refusal(url), null, url);
  }
  assert.equal(guard.copyRefusal({ Link: '<https://reviews.example/x>; rel="original"' }, "https://archive.example/AbC"), null);
  const site = (url) => guard.refusal(url)?.site ?? null;
  assert.equal(site("https://archive.example/2024/https://reviews.example/?u=https://shop.example/"), "Shop");
  assert.equal(site("https://odd.example/"), "Unknown kind");
  assert.equal(site("https://strict.reviews.example/"), "Reviews, stricter");
  assert.deepEqual(
    { ...guard.copyRefusal({ Link: '<https://reviews.example/x>; rel="original", <https://shop.example/>; rel="original"' }, "https://archive.example/AbC") },
    { code: "link_only_site", site: "Shop", copy: true },
  );
});

test("example.* covers one or two short suffix labels; example.com covers its subdomains, and nothing else", () => {
  const guard = linkOnly.createPersonalBrowserLinkOnlyGuard({
    schema: "instafy.link-only-sites@1",
    sites: [{ name: "Shop", match: ["shop.*"] }, { name: "Maps", match: ["maps.example"] }],
  });
  const site = (url) => guard.refusal(url)?.site ?? null;
  for (const url of ["https://shop.de/", "https://www.shop.co.uk/", "https://a.b.shop.com.au/"]) assert.equal(site(url), "Shop", url);
  for (const url of ["https://myshop.de/", "https://shop.example.org/", "https://shop.co.uk.evil.example/", "https://shop/", "https://shopping.com/"]) {
    assert.equal(site(url), null, url);
  }
  for (const url of ["https://maps.example/", "https://www.maps.example/"]) assert.equal(site(url), "Maps", url);
  for (const url of ["https://maps.example.org/", "https://notmaps.example/"]) assert.equal(site(url), null, url);
  // Only web pages are ever refused.
  for (const url of ["about:blank", "data:text/html,shop.de", "not a url"]) assert.equal(guard.refusal(url), null, url);
});

test("every case in the readers' shared table is refused or let through by kind, wrappers' copies and host spellings included", () => {
  const guard = linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD;
  // Both kinds are in the table: sites refused, and sites read but not reused.
  assert.ok(CASES.bundled.some((kase) => kase.site !== null && kase.kind === "no-reuse"));
  assert.ok(CASES.bundled.some((kase) => kase.site !== null && kase.kind !== "no-reuse"));
  for (const kase of CASES.bundled) {
    const refusal = guard.refusal(caseUrl(kase));
    const expected = kase.site === null || kase.kind === "no-reuse"
      ? null
      : kase.via ? { code: "link_only_site", site: kase.site, via: kase.via } : { code: "link_only_site", site: kase.site };
    assert.deepEqual(refusal === null ? null : { ...refusal }, expected, kase.url);
  }
});

test("an answer's Memento header is read in linear time, however a hostile server writes it", () => {
  const guard = linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD;
  // A Link header of unclosed "<" runs: a backtracking pattern takes minutes on it, in Desktop's main process.
  for (const link of ["<" + "<=".repeat(100_000), "<x>" + ";rel=".repeat(50_000), "<".repeat(200_000)]) {
    const started = process.hrtime.bigint();
    assert.equal(guard.copyRefusal({ Link: [link] }, "https://archive.ph/AbCdE"), null);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1_000, `${ms} ms for a ${link.length}-character header`);
  }
  // The original after such a run still counts.
  const tail = "<" + "<=".repeat(1_000) + ', <https://www.booking.com/>; rel="original"';
  assert.deepEqual({ ...guard.copyRefusal({ link: tail }, "https://archive.ph/AbCdE") }, { code: "link_only_site", site: "Booking.com", copy: true });
});

test("a wrapper's copy is named with the wrapper in what the agent is told", () => {
  const refusal = linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD.refusal("https://web.archive.org/web/2024/https://www.booking.com/hotel/x.html");
  const message = linkOnly.personalBrowserLinkOnlyMessage(refusal, "Nothing was opened.");
  assert.match(message, /^Booking\.com is link-only/);
  assert.match(message, /This address is its copy on the Wayback Machine\./);
  assert.match(message, /Send page to Octo/);
});

test("a missing, unknown or empty list fails closed for every web page", () => {
  for (const data of [
    null,
    undefined,
    "instafy.link-only-sites@1",
    { schema: "instafy.link-only-sites@2", sites: source.sites },
    { schema: "instafy.link-only-sites@1" },
    { schema: "instafy.link-only-sites@1", sites: [] },
    { schema: "instafy.link-only-sites@1", sites: [{ name: "Nothing valid", match: ["exa mple.com", "*", 7] }] },
  ]) {
    const guard = linkOnly.createPersonalBrowserLinkOnlyGuard(data);
    assert.equal(guard.available, false, JSON.stringify(data));
    assert.deepEqual({ ...guard.refusal("https://example.org/") }, { code: "link_only_list_unavailable" });
    assert.equal(guard.refusal("about:blank"), null);
  }
});

test("the agent is told the site, that nothing was read, and to give the person the link", () => {
  const message = linkOnly.personalBrowserLinkOnlyMessage({ code: "link_only_site", site: "Booking.com" }, "Nothing was opened.");
  assert.match(message, /^Booking\.com is link-only/);
  assert.match(message, /Nothing was opened\./);
  assert.match(message, /plain link/);
  assert.match(message, /Send page to Octo/);
  assert.match(linkOnly.personalBrowserLinkOnlyMessage({ code: "link_only_list_unavailable" }, "x"), /list is unavailable/);
});

test("the address a response came from is allowed only when public, or when it is the proxy in use", async () => {
  const neverProxy = async () => false;
  for (const ip of ["10.0.0.5", "127.0.0.1", "::1", "[::1]", "::ffff:10.0.0.5", "169.254.169.254", "fd00::1", "192.168.1.1", "not an address"]) {
    assert.equal(await security.personalBrowserConnectedAddressAllowed(ip, neverProxy), false, ip);
  }
  for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert.equal(await security.personalBrowserConnectedAddressAllowed(ip, neverProxy), true, ip);
  }
  // No address: the response came from the cache, with no connection.
  for (const ip of [undefined, null, "", "  "]) {
    assert.equal(await security.personalBrowserConnectedAddressAllowed(ip, neverProxy), true, String(ip));
  }
  const seen = [];
  assert.equal(await security.personalBrowserConnectedAddressAllowed("10.1.1.1", async (address) => { seen.push(address); return true; }), true);
  assert.deepEqual(seen, ["10.1.1.1"]);
});

test("the proxy in use is read from Chromium's answer and matched by address or by name", async () => {
  assert.deepEqual(security.personalBrowserProxyHosts("DIRECT"), []);
  assert.deepEqual(
    security.personalBrowserProxyHosts("PROXY 10.1.1.1:3128; HTTPS proxy.corp.example:443; SOCKS5 [::1]:1080; DIRECT"),
    ["10.1.1.1", "proxy.corp.example", "::1"],
  );
  const lookup = async (host) => {
    if (host !== "proxy.corp.example") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return [{ address: "10.2.2.2", family: 4 }];
  };
  assert.equal(await security.personalBrowserAddressIsProxy("10.1.1.1", ["10.1.1.1"], lookup), true);
  assert.equal(await security.personalBrowserAddressIsProxy("::1", ["0:0:0:0:0:0:0:1"], lookup), true);
  assert.equal(await security.personalBrowserAddressIsProxy("10.2.2.2", ["proxy.corp.example"], lookup), true);
  assert.equal(await security.personalBrowserAddressIsProxy("10.0.0.5", ["10.1.1.1", "proxy.corp.example", "gone.example"], lookup), false);
  assert.equal(await security.personalBrowserAddressIsProxy("10.0.0.5", [], lookup), false);
});
