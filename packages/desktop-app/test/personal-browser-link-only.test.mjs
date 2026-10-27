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

test("the bundled link-only list is the web-research skill's own file, in every Desktop bundle that enforces it", () => {
  assert.deepEqual(linkOnly.BUNDLED_LINK_ONLY_SITES, source, "dist/personalBrowserLinkOnly.js was built from another copy");
  assert.equal(linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD.available, true);
  // The main process bundle (the Personal Browser host) carries the same list.
  const main = fs.readFileSync(path.join(packageRoot, "dist/main.js"), "utf8");
  for (const site of source.sites) {
    assert.ok(main.includes(JSON.stringify(site.name)), `dist/main.js lacks ${site.name}`);
    for (const pattern of site.match) {
      assert.ok(main.includes(JSON.stringify(pattern)), `dist/main.js lacks ${pattern}`);
    }
  }
  // Single source: Desktop keeps no copy of its own.
  const copies = fs.readdirSync(path.join(packageRoot, "src")).filter((name) => name.endsWith(".json"));
  assert.deepEqual(copies, []);
});

test("every site in the skill's list is refused, by the list's own matching rule", () => {
  const guard = linkOnly.PERSONAL_BROWSER_LINK_ONLY_GUARD;
  for (const site of source.sites) {
    for (const pattern of site.match) {
      const host = pattern.endsWith(".*") ? `${pattern.slice(0, -2)}.com` : pattern;
      for (const url of [`https://${host}/`, `https://www.${host}/x?y=1`, `http://${host.toUpperCase()}./`]) {
        assert.deepEqual({ ...guard.refusal(url) }, { code: "link_only_site", site: site.name }, url);
      }
    }
  }
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
