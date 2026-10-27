"use strict";

/*
 * Link-only sites: whether an address is on a site the web-research skill
 * keeps link-only (`references/link-only-sites.json`), shared by
 * `instafy web read`, the hosted Shared Browser and the Desktop Personal
 * Browser. The list is the skill's data; this file only enforces it.
 *
 * - `sites`: "example.com" matches that host and its subdomains; "example.*"
 *   matches the label followed by one or two public-suffix labels of two or
 *   three letters (example.de, www.example.co.uk).
 * - `wrappers`: services that serve another site's pages at an address of
 *   their own (translators, caches, archives, reader proxies). An address on
 *   one is also checked as the site it embeds, wherever the wrapper's
 *   `embeds` says that site is written: "subdomain" (example.com.proxy.test),
 *   "subdomain-dashes" (www-example-com.translate.goog: "." written "-" and
 *   "-" written "--"), "path" (web.archive.org/web/2024/https://example.com/)
 *   or "query" (…/search?q=cache:example.com). A wrapper is never refused for
 *   itself, only for its copies of a listed site. Wrappers may nest.
 *
 * Hosts are compared the way a browser connects to them: lower case, no
 * trailing dots, IDN in punycode, without port or user info. An IP literal
 * never matches a name. Merging lists only adds: a space's copy cannot
 * remove a bundled site.
 *
 * Plain script with no imports. In CommonJS it exports its API; evaluated
 * where `module` is undefined it sets `globalThis.__instafyLinkOnly`.
 */
(function defineLinkOnly(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.__instafyLinkOnly = api;
  }
})(typeof globalThis === "object" ? globalThis : null, function linkOnlyFactory() {
  const LINK_ONLY_SITES_SCHEMA = "instafy.link-only-sites@1";
  const EMBEDS = Object.freeze(["subdomain", "subdomain-dashes", "path", "query"]);
  const MAX_ENTRIES = 500;
  const MAX_PATTERNS_PER_ENTRY = 50;
  // A wrapper inside a wrapper inside a wrapper is looked into; deeper is not.
  const MAX_DEPTH = 3;
  // Host names taken from one wrapper address, and the characters of one
  // address part they are looked for in.
  const MAX_EMBEDDED_NAMES = 32;
  const MAX_SCANNED_CHARS = 8_192;
  const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
  const SHORT_SUFFIX_LABEL = /^[a-z]{2,3}$/;
  const WEB_PROTOCOLS = new Set(["http:", "https:"]);
  // Browser addresses that show another address's page or data.
  const INNER_ADDRESS_PROTOCOLS = new Set(["view-source:", "blob:", "filesystem:"]);
  // Characters that never belong to a host name, where host names in a
  // wrapper's path or query are split apart. Linear: no backtracking.
  const NOT_HOST_CHARACTER = /[^\p{L}\p{N}\p{M}.\-。．｡]+/u;
  const OTHER_DOTS = /[。．｡]/g;

  // Every trailing dot goes ("example.com.." names the same site to a lenient
  // resolver), with a loop rather than /\.+$/, which backtracks on a long run.
  function trimDots(value) {
    let start = 0;
    let end = value.length;
    while (start < end && value.charCodeAt(start) === 0x2e) start += 1;
    while (end > start && value.charCodeAt(end - 1) === 0x2e) end -= 1;
    return value.slice(start, end);
  }

  function parseAddress(address) {
    if (address && typeof address === "object" && typeof address.href === "string") address = address.href;
    if (typeof address !== "string" || address.length > 65_536) return null;
    try {
      return new URL(address);
    } catch (_) {
      return null;
    }
  }

  // The web address inside view-source:, blob: and filesystem: addresses.
  function innerAddress(url) {
    if (!INNER_ADDRESS_PROTOCOLS.has(url.protocol)) return null;
    return parseAddress(url.href.slice(url.protocol.length));
  }

  /** Is this an http(s) page, directly or inside view-source:, blob: or filesystem:? */
  function isWebAddress(address) {
    let url = parseAddress(address);
    for (let depth = 0; url && depth <= MAX_DEPTH; depth += 1) {
      if (WEB_PROTOCOLS.has(url.protocol)) return true;
      url = innerAddress(url);
    }
    return false;
  }

  function isIpLiteral(host) {
    return host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  }

  // A host name as a browser connects to it: the URL parser has already
  // lower-cased it and spelled IDN in punycode; trailing dots go.
  function hostOfUrl(url) {
    const host = trimDots(String(url.hostname || "").toLowerCase());
    return host && !isIpLiteral(host) ? host : null;
  }

  // A name written in a list or in a wrapper's address, spelled as a browser
  // would connect to it, or null when it is not a domain name.
  function asciiName(raw) {
    let name = trimDots(String(raw).trim().toLowerCase().replace(OTHER_DOTS, "."));
    if (!name || name.length > 253 || /[\s/\\:@?#%*[\]]/.test(name)) return null;
    if (!NAME.test(name)) {
      let host;
      try {
        host = new URL(`http://${name}/`).hostname;
      } catch (_) {
        return null;
      }
      name = trimDots(host.toLowerCase());
      if (!NAME.test(name)) return null;
    }
    // A name ends in a label with a letter; "1.2.3.4" and "10.0" are not names.
    return /[a-z]/.test(name.slice(name.lastIndexOf(".") + 1)) ? name : null;
  }

  // One pattern of a list entry: "example.com" or "example.*" (a leading
  // "*." is the same as none, since a pattern always covers subdomains).
  function compilePattern(raw) {
    if (typeof raw !== "string") return null;
    let text = raw.trim().toLowerCase();
    if (text.startsWith("*.")) text = text.slice(2);
    const anyEnding = text.endsWith(".*");
    if (anyEnding) text = text.slice(0, -2);
    if (text.includes("*")) return null;
    const name = anyEnding ? asciiStem(text) : asciiName(text);
    return name ? Object.freeze({ name, anyEnding }) : null;
  }

  // The label part of "example.*", which may be a single label.
  function asciiStem(text) {
    const stem = trimDots(text);
    if (!stem) return null;
    if (NAME.test(stem)) return stem;
    try {
      const host = trimDots(new URL(`http://${stem}/`).hostname.toLowerCase());
      return NAME.test(host) && !isIpLiteral(host) ? host : null;
    } catch (_) {
      return null;
    }
  }

  // The labels in front of a pattern's match ("" for the host itself), or
  // null when the host does not match.
  function prefixBefore(host, pattern) {
    if (!pattern.anyEnding) {
      if (host === pattern.name) return "";
      if (host.endsWith(`.${pattern.name}`)) return host.slice(0, -(pattern.name.length + 1));
      return null;
    }
    const labels = host.split(".");
    for (const suffixLength of [1, 2]) {
      if (labels.length <= suffixLength) continue;
      if (!labels.slice(-suffixLength).every((label) => SHORT_SUFFIX_LABEL.test(label))) continue;
      const rest = labels.slice(0, -suffixLength).join(".");
      if (rest === pattern.name) return "";
      if (rest.endsWith(`.${pattern.name}`)) return rest.slice(0, -(pattern.name.length + 1));
    }
    return null;
  }

  function cleanText(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function compileEntries(entries, kind, where, warnings) {
    const compiled = [];
    for (const entry of entries.slice(0, MAX_ENTRIES)) {
      const raw = entry && typeof entry === "object" ? entry : {};
      const listed = Array.isArray(raw.match) ? raw.match : Array.isArray(raw.domains) ? raw.domains : [];
      const patterns = listed.slice(0, MAX_PATTERNS_PER_ENTRY).map(compilePattern).filter(Boolean);
      const label = cleanText(raw.name, 80);
      if (!patterns.length) {
        warnings.push(`${where}a ${kind} entry${label ? ` (${label})` : ""} without a valid pattern was skipped`);
        continue;
      }
      const name = label || (patterns[0].anyEnding ? `${patterns[0].name}.*` : patterns[0].name);
      const why = cleanText(raw.why, 200) || cleanText(raw.reason, 200);
      if (kind === "site") {
        compiled.push(Object.freeze({ name, why: why || "listed as link-only", patterns: Object.freeze(patterns) }));
        continue;
      }
      const embeds = Array.isArray(raw.embeds) ? raw.embeds.filter((value) => EMBEDS.includes(value)) : [];
      if (!embeds.length) {
        warnings.push(`${where}the wrapper ${name} says nothing it knows about where the wrapped site is (embeds) and was skipped`);
        continue;
      }
      compiled.push(Object.freeze({ name, why, patterns: Object.freeze(patterns), embeds: Object.freeze([...new Set(embeds)]) }));
    }
    return compiled;
  }

  /**
   * One copy of the list, compiled. `list` is null when the data is not a
   * link-only list at all (another schema, no `sites` list, `wrappers` not a
   * list); an entry without a valid pattern is skipped with a warning.
   */
  function compileLinkOnlyList(data, options) {
    const source = options && typeof options.source === "string" && options.source ? options.source : "";
    const where = source ? `${source}: ` : "";
    const list = data && typeof data === "object" && !Array.isArray(data) ? data : null;
    if (!list) return { list: null, warnings: [`${where}is not a link-only list`] };
    if (list.schema !== LINK_ONLY_SITES_SCHEMA) return { list: null, warnings: [`${where}schema is not ${LINK_ONLY_SITES_SCHEMA}`] };
    if (!Array.isArray(list.sites)) return { list: null, warnings: [`${where}sites is not a list`] };
    if (list.wrappers !== undefined && !Array.isArray(list.wrappers)) {
      return { list: null, warnings: [`${where}wrappers is not a list`] };
    }
    const warnings = [];
    const sites = compileEntries(list.sites, "site", where, warnings);
    const wrappers = compileEntries(list.wrappers || [], "wrapper", where, warnings);
    return { list: Object.freeze({ sites: Object.freeze(sites), wrappers: Object.freeze(wrappers) }), warnings };
  }

  /**
   * The list a reader enforces: the bundled copy and what each space copy
   * adds. Without a bundled copy that names at least one site there is no
   * list (null), and a reader then reads nothing. A space copy that is not a
   * list is left out with a warning; the bundled list still applies.
   */
  function linkOnlyListFrom(bundled, additions) {
    const base = compileLinkOnlyList(bundled, { source: "bundled list" });
    const warnings = [...base.warnings];
    if (!base.list || base.list.sites.length === 0) {
      return { list: null, warnings: base.list ? [...warnings, "bundled list: names no site"] : warnings, sources: [] };
    }
    const sites = [...base.list.sites];
    const wrappers = [...base.list.wrappers];
    const sources = ["bundled"];
    for (const addition of Array.isArray(additions) ? additions : []) {
      const source = addition && typeof addition.source === "string" ? addition.source : "a space copy";
      const extra = compileLinkOnlyList(addition ? addition.data : undefined, { source });
      warnings.push(...extra.warnings);
      if (!extra.list) {
        warnings.push(`${source} was ignored; the bundled list still applies`);
        continue;
      }
      // A copy only adds: bundled entries come first and are never dropped.
      sites.push(...extra.list.sites.slice(0, Math.max(0, base.list.sites.length + MAX_ENTRIES - sites.length)));
      wrappers.push(...extra.list.wrappers.slice(0, Math.max(0, base.list.wrappers.length + MAX_ENTRIES - wrappers.length)));
      if (extra.list.sites.length || extra.list.wrappers.length) sources.push(source);
    }
    return { list: Object.freeze({ sites: Object.freeze(sites), wrappers: Object.freeze(wrappers) }), warnings, sources };
  }

  // Percent-decoding, repeated for an address encoded twice. Bytes that are
  // not UTF-8 are decoded one by one rather than given up on.
  function decoded(text) {
    let value = String(text).slice(0, MAX_SCANNED_CHARS);
    for (let round = 0; round < 3 && value.includes("%"); round += 1) {
      let next;
      try {
        next = decodeURIComponent(value);
      } catch (_) {
        next = value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      if (next === value) break;
      value = next;
    }
    return value;
  }

  // Host names written in a wrapper's path or query: runs of host characters
  // with a dot whose last label has a letter (not a time, version or address).
  function hostNamesIn(text) {
    const names = [];
    for (const token of decoded(text).split(NOT_HOST_CHARACTER)) {
      if (names.length >= MAX_EMBEDDED_NAMES) break;
      let name = trimDots(token.replace(OTHER_DOTS, "."));
      while (name.startsWith("-") || name.endsWith("-")) name = trimDots(name.replace(/^-+|-+$/g, ""));
      if (!name.includes(".") || !/\p{L}/u.test(name.slice(name.lastIndexOf(".") + 1))) continue;
      names.push(name);
    }
    return names;
  }

  // "www-example-com" -> "www.example.com", "my--shop-de" -> "my-shop.de".
  function undashed(label) {
    let out = "";
    for (let index = 0; index < label.length; index += 1) {
      if (label[index] !== "-") {
        out += label[index];
      } else if (label[index + 1] === "-") {
        out += "-";
        index += 1;
      } else {
        out += ".";
      }
    }
    return out;
  }

  // RFC 3492 decoding of one "xn--" label, or null.
  function punycodeLabel(label) {
    if (!label.startsWith("xn--")) return null;
    const input = label.slice(4);
    const base = 36;
    const tMin = 1;
    const tMax = 26;
    const adapt = (delta, points, first) => {
      let k = 0;
      delta = first ? Math.floor(delta / 700) : delta >> 1;
      delta += Math.floor(delta / points);
      for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
      return Math.floor(k + ((base - tMin + 1) * delta) / (delta + 38));
    };
    const digitOf = (code) => {
      if (code >= 0x30 && code <= 0x39) return code - 22;
      if (code >= 0x41 && code <= 0x5a) return code - 0x41;
      if (code >= 0x61 && code <= 0x7a) return code - 0x61;
      return base;
    };
    const output = [];
    const basic = Math.max(0, input.lastIndexOf("-"));
    for (let index = 0; index < basic; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0x80) return null;
      output.push(code);
    }
    let n = 128;
    let bias = 72;
    let i = 0;
    for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
      const old = i;
      for (let w = 1, k = base; ; k += base) {
        if (index >= input.length) return null;
        const digit = digitOf(input.charCodeAt(index));
        index += 1;
        if (digit >= base) return null;
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        w *= base - t;
        if (i > 0x10ffff * 64 || w > 0x10ffff * 64) return null;
      }
      bias = adapt(i - old, output.length + 1, old === 0);
      n += Math.floor(i / (output.length + 1));
      i %= output.length + 1;
      if (n > 0x10ffff || output.length >= 63) return null;
      output.splice(i, 0, n);
      i += 1;
    }
    try {
      return String.fromCodePoint(...output);
    } catch (_) {
      return null;
    }
  }

  // The addresses a wrapper's address embeds, as `http://<name>/` URLs.
  function embeddedAddresses(wrapper, prefix, url) {
    const names = [];
    if (prefix && wrapper.embeds.includes("subdomain")) names.push(prefix);
    if (prefix && wrapper.embeds.includes("subdomain-dashes")) {
      const label = prefix.slice(prefix.lastIndexOf(".") + 1);
      names.push(undashed(label));
      const unicode = punycodeLabel(label);
      if (unicode) names.push(undashed(unicode));
    }
    if (wrapper.embeds.includes("path")) names.push(...hostNamesIn(url.pathname));
    if (wrapper.embeds.includes("query")) names.push(...hostNamesIn(url.search.slice(1)));
    const addresses = [];
    for (const name of names.slice(0, MAX_EMBEDDED_NAMES)) {
      const ascii = asciiName(name);
      if (ascii) addresses.push(new URL(`http://${ascii}/`));
    }
    return addresses;
  }

  function matchUrl(list, url, depth) {
    if (!WEB_PROTOCOLS.has(url.protocol)) {
      const inner = depth < MAX_DEPTH ? innerAddress(url) : null;
      return inner ? matchUrl(list, inner, depth + 1) : null;
    }
    const host = hostOfUrl(url);
    if (!host) return null;
    for (const site of list.sites) {
      if (site.patterns.some((pattern) => prefixBefore(host, pattern) !== null)) {
        return { site: site.name, why: site.why, via: [] };
      }
    }
    if (depth >= MAX_DEPTH) return null;
    for (const wrapper of list.wrappers) {
      let prefix = null;
      for (const pattern of wrapper.patterns) {
        prefix = prefixBefore(host, pattern);
        if (prefix !== null) break;
      }
      if (prefix === null) continue;
      for (const embedded of embeddedAddresses(wrapper, prefix, url)) {
        const found = matchUrl(list, embedded, depth + 1);
        if (found) return { ...found, via: [wrapper.name, ...found.via] };
      }
    }
    return null;
  }

  /**
   * The link-only site an address is on, directly or as a wrapper's copy:
   * `{ site, why, via }` (`via` names the wrappers, outermost first), or
   * null. Only web pages match; a missing list matches nothing, so a caller
   * checks for the list first.
   */
  function linkOnlyMatch(list, address) {
    if (!list || !Array.isArray(list.sites)) return null;
    const url = parseAddress(address);
    return url ? matchUrl(list, url, 0) : null;
  }

  return Object.freeze({
    LINK_ONLY_SITES_SCHEMA,
    EMBEDS,
    compileLinkOnlyList,
    linkOnlyListFrom,
    linkOnlyMatch,
    isWebAddress,
  });
});
