// SPDX-License-Identifier: AGPL-3.0-only
//
// What `instafy web read` takes from one fetched page: its text, title, links and the structured data the page
// itself publishes (JSON-LD, microdata, meta and og tags), plus the yes/no signals the stop rules need. Nothing here
// knows any site. Every scan is linear: a page is untrusted input of up to 2 MB, so no backtracking regex runs over
// the whole document and an unclosed tag never makes a scan restart from every later position.
import { jsonLdBlocks } from "@instafy/bind/web";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}\d{0,2});/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

/** One attribute of a tag's attribute text, entity-decoded, or null. */
export function attribute(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i");
  const match = attrs.match(re);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * Removes elements whose content is never page text (script, style, template, …) and comments, by plain index
 * scans. An element without its closing tag runs to the end of the document, as it would in a browser.
 */
export function withoutHiddenBlocks(html: string, tags: string[] = ["script", "style", "noscript", "template", "svg", "head", "iframe", "object"]): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let at = 0;
  while (at < html.length) {
    const next = lower.indexOf("<", at);
    if (next < 0) break;
    if (lower.startsWith("<!--", next)) {
      out.push(html.slice(at, next), " ");
      const end = lower.indexOf("-->", next + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = tags.find((name) => lower.startsWith(`<${name}`, next) && /[\s>/]/.test(lower[next + name.length + 1] ?? ">"));
    if (!tag) {
      out.push(html.slice(at, next + 1));
      at = next + 1;
      continue;
    }
    out.push(html.slice(at, next), " ");
    const end = lower.indexOf(`</${tag}`, next + tag.length + 1);
    if (end < 0) {
      at = html.length;
      break;
    }
    const close = lower.indexOf(">", end);
    at = close < 0 ? html.length : close + 1;
  }
  out.push(html.slice(at));
  return out.join("");
}

const BLOCK_END = /<(?:br|hr|\/p|\/li|\/h[1-6]|\/tr|\/div|\/section|\/article|\/header|\/footer|\/nav|\/aside|\/main|\/dd|\/dt|\/td|\/th|\/blockquote|\/pre|\/figcaption|\/caption|\/table|\/ul|\/ol|\/dl|\/form|\/label|\/option|\/address)\b[^>]*>/gi;

/** The page's text, one line per block, with markup, scripts, styles and comments dropped. */
export function pageLines(html: string): string[] {
  const body = withoutHiddenBlocks(html).replace(BLOCK_END, "\n").replace(/<[^>]*>/g, " ");
  return decodeEntities(body)
    .split("\n")
    .map(squash)
    .filter((line) => line.length > 1);
}

export function pageTitle(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return "";
  const start = lower.indexOf(">", open);
  if (start < 0) return "";
  const end = lower.indexOf("</title", start);
  return squash(decodeEntities(html.slice(start + 1, end < 0 ? Math.min(html.length, start + 2000) : end).replace(/<[^>]*>/g, " "))).slice(0, 300);
}

/** Every start tag named `name`, as its attribute text, found with index scans. */
export function startTags(html: string, name: string, max = 2000): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let at = 0;
  while (out.length < max) {
    const open = lower.indexOf(`<${name}`, at);
    if (open < 0) break;
    const after = lower[open + name.length + 1];
    if (after !== undefined && !/[\s>/]/.test(after)) {
      at = open + 1;
      continue;
    }
    const end = lower.indexOf(">", open);
    if (end < 0) break;
    out.push(html.slice(open + name.length + 1, end));
    at = end + 1;
  }
  return out;
}

export type PageLink = { text: string; href: string };

const MAX_LINK_CHARS = 2_048;

/** Plain `<a href>` links, resolved against the page (and its `<base href>`), http(s) only, first occurrence kept. */
export function pageLinks(html: string, pageUrl: string, max = 200): PageLink[] {
  let base = pageUrl;
  const baseTag = startTags(html, "base", 1)[0];
  const baseHref = baseTag ? attribute(baseTag, "href") : null;
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      // keep the page URL
    }
  }
  const lower = html.toLowerCase();
  const out: PageLink[] = [];
  const seen = new Set<string>();
  let at = 0;
  while (out.length < max) {
    const open = lower.indexOf("<a", at);
    if (open < 0) break;
    const after = lower[open + 2];
    if (after === undefined || !/[\s>]/.test(after)) {
      at = open + 2;
      continue;
    }
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd < 0) break;
    // The link text ends at </a> or, for an unclosed link, at the next link; never searched past 4,000 characters.
    const window = lower.slice(tagEnd + 1, tagEnd + 4001);
    let close = window.indexOf("</a");
    const nextLink = window.search(/<a[\s>]/);
    if (close < 0 || (nextLink >= 0 && nextLink < close)) close = nextLink >= 0 ? nextLink : window.length;
    at = tagEnd + 1 + close;
    const href = attribute(html.slice(open + 2, tagEnd), "href");
    // An over-long address is page-chosen text, not a link worth following.
    if (!href || href.length > MAX_LINK_CHARS) continue;
    let resolved: URL;
    try {
      resolved = new URL(href.trim(), base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (resolved.username || resolved.password) continue;
    resolved.hash = "";
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    const inner = html.slice(tagEnd + 1, tagEnd + 1 + close);
    const label = attribute(html.slice(open + 2, tagEnd), "aria-label") ?? attribute(html.slice(open + 2, tagEnd), "title") ?? "";
    const text = squash(decodeEntities(withoutHiddenBlocks(inner).replace(/<[^>]*>/g, " "))) || squash(label);
    out.push({ text: text.slice(0, 160), href: resolved.href });
  }
  return out;
}

export type StructuredItem =
  | { kind: "json-ld"; data: unknown }
  | { kind: "microdata"; data: { type: string | null; properties: Record<string, string[]> } }
  | { kind: "meta"; data: Record<string, string> };

const MAX_STRUCTURED_STRING = 600;
const MAX_STRUCTURED_ARRAY = 30;
const MAX_STRUCTURED_DEPTH = 7;

/** A bounded copy of parsed JSON: deep nodes dropped, long strings and arrays cut. */
export function boundJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > MAX_STRUCTURED_STRING ? `${value.slice(0, MAX_STRUCTURED_STRING)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_STRUCTURED_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_STRUCTURED_ARRAY).map((item) => boundJson(item, depth + 1));
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (++keys > 60) break;
    out[key.slice(0, 100)] = boundJson(item, depth + 1);
  }
  return out;
}

const META_KEY = /^(?:description|keywords|author|robots|og:.+|twitter:.+|article:.+|product:.+|place:.+|business:.+|geo\..+|icbm|dc\..+|dcterms\..+|citation_.+|license|copyright)$/i;

/** The page's raw structured data: JSON-LD blocks, microdata properties and descriptive meta tags, bounded. */
export function pageStructured(html: string, pageUrl: string): StructuredItem[] {
  const items: StructuredItem[] = [];
  for (const block of jsonLdBlocks(html, 12)) {
    if (block.length > 100_000) continue;
    try {
      items.push({ kind: "json-ld", data: boundJson(JSON.parse(decodeEntities(block.trim()).replace(/^\s*<!--|--!?>\s*$/g, ""))) });
    } catch {
      // not JSON: skipped
    }
  }
  const microdata = pageMicrodata(html);
  for (const item of microdata) items.push({ kind: "microdata", data: item });
  const meta: Record<string, string> = {};
  let count = 0;
  for (const attrs of startTags(html, "meta", 400)) {
    const key = (attribute(attrs, "property") ?? attribute(attrs, "name") ?? attribute(attrs, "itemprop") ?? "").trim().toLowerCase();
    const content = attribute(attrs, "content");
    if (!key || content === null || !META_KEY.test(key) || key in meta) continue;
    meta[key] = squash(content).slice(0, 400);
    if (++count >= 40) break;
  }
  for (const attrs of startTags(html, "link", 200)) {
    const rel = (attribute(attrs, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attribute(attrs, "href");
    if (!href) continue;
    for (const name of ["canonical", "license"]) {
      if (!rel.includes(name) || `link:${name}` in meta) continue;
      try {
        meta[`link:${name}`] = new URL(href, pageUrl).href;
      } catch {
        // not a URL
      }
    }
  }
  if (Object.keys(meta).length) items.push({ kind: "meta", data: meta });
  return items;
}

/** Microdata: each itemprop's value (content, href, src, datetime or its own text), grouped by the nearest itemtype before it. */
function pageMicrodata(html: string, maxProps = 80): Array<{ type: string | null; properties: Record<string, string[]> }> {
  const lower = html.toLowerCase();
  if (!lower.includes("itemprop")) return [];
  const groups: Array<{ type: string | null; properties: Record<string, string[]> }> = [];
  let current: { type: string | null; properties: Record<string, string[]> } | null = null;
  let props = 0;
  let at = 0;
  while (props < maxProps) {
    const open = lower.indexOf("<", at);
    if (open < 0) break;
    const end = lower.indexOf(">", open);
    if (end < 0) break;
    at = end + 1;
    const attrs = html.slice(open + 1, end);
    if (!/item(?:type|prop)/i.test(attrs)) continue;
    const type = attribute(attrs, "itemtype");
    if (type) {
      current = { type: type.slice(0, 200), properties: {} };
      groups.push(current);
      if (groups.length > 12) break;
    }
    const name = attribute(attrs, "itemprop");
    if (!name) continue;
    let value =
      attribute(attrs, "content") ?? attribute(attrs, "datetime") ?? attribute(attrs, "href") ?? attribute(attrs, "src") ?? null;
    if (value === null && !type) {
      const next = lower.indexOf("<", end + 1);
      value = squash(decodeEntities(html.slice(end + 1, next < 0 ? Math.min(html.length, end + 401) : Math.min(next, end + 401))));
    }
    if (value === null || value === "") continue;
    if (!current) {
      current = { type: null, properties: {} };
      groups.push(current);
    }
    for (const key of name.split(/\s+/).filter(Boolean).slice(0, 3)) {
      const list = (current.properties[key.slice(0, 60)] ??= []);
      if (list.length < 10) list.push(squash(value).slice(0, 400));
    }
    props += 1;
  }
  return groups.filter((group) => Object.keys(group.properties).length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Signals for the stop rules (structure only, never a site's name)

const LOGIN_TITLE = /(?<![\p{L}])(?:log\s?in|sign\s?in|signin|login|anmelden|anmeldung|einloggen|connexion|iniciar sesi[oó]n|accedi)(?![\p{L}])/iu;
const PAYWALL_MARKER = /\b(?:paywall|subscriber-only|subscribers-only|premium-content|piano-paywall|meteredcontent|regwall)\b/i;
const CREDENTIAL_LABEL_TAGS = ["h1", "h2", "h3", "label", "th", "dt", "legend"];

export type PageSignals = {
  /** an `<input type="password">` */
  passwordField: boolean;
  /** the title reads as a sign-in page */
  loginTitle: boolean;
  /** JSON-LD says `isAccessibleForFree: false`, or the markup names a paywall */
  paywallDeclared: boolean;
  paywallMarker: boolean;
  /** script elements, and a noscript that asks for JavaScript */
  scripts: number;
  noscriptAsksForJs: boolean;
  /** headings and labels, for the secret-screen check */
  labels: string[];
  /** values of read-only or disabled inputs, and the text of code and pre blocks */
  fieldValues: string[];
  codeBlocks: string[];
};

function elementTexts(html: string, tag: string, max: number, maxChars = 400): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let at = 0;
  while (out.length < max) {
    const open = lower.indexOf(`<${tag}`, at);
    if (open < 0) break;
    const after = lower[open + tag.length + 1];
    if (after === undefined || !/[\s>]/.test(after)) {
      at = open + 1;
      continue;
    }
    const start = lower.indexOf(">", open);
    if (start < 0) break;
    const window = lower.slice(start + 1, start + 1 + maxChars * 4);
    const close = window.indexOf(`</${tag}`);
    const inner = html.slice(start + 1, start + 1 + (close < 0 ? window.length : close));
    out.push(squash(decodeEntities(inner.replace(/<[^>]*>/g, " "))).slice(0, maxChars));
    at = start + 1;
  }
  return out;
}

function jsonLdDeclaresPaywall(html: string): boolean {
  for (const block of jsonLdBlocks(html, 12)) {
    if (/"isAccessibleForFree"\s*:\s*(?:false|"false"|"False")/.test(block)) return true;
  }
  return false;
}

export function pageSignals(html: string): PageSignals {
  const inputs = startTags(html, "input", 500);
  const passwordField = inputs.some((attrs) => (attribute(attrs, "type") ?? "").toLowerCase() === "password");
  const fieldValues = inputs
    .filter((attrs) => /(?:^|\s)(?:readonly|disabled)(?:[\s=/]|$)/i.test(attrs))
    .map((attrs) => attribute(attrs, "value") ?? "")
    .filter(Boolean)
    .slice(0, 50);
  const noscripts = elementTexts(html, "noscript", 5);
  return {
    passwordField,
    loginTitle: LOGIN_TITLE.test(pageTitle(html)),
    paywallDeclared: jsonLdDeclaresPaywall(html),
    paywallMarker: PAYWALL_MARKER.test(startTags(html, "div", 2000).concat(startTags(html, "section", 500), startTags(html, "article", 200)).join(" ")),
    // Only scripts that run: JSON-LD and other data blocks do not build a page.
    scripts: startTags(html, "script", 2000).filter((attrs) => /^(?:|text\/javascript|application\/javascript|module)$/i.test((attribute(attrs, "type") ?? "").trim())).length,
    noscriptAsksForJs: noscripts.some((text) => /javascript/i.test(text)),
    labels: CREDENTIAL_LABEL_TAGS.flatMap((tag) => elementTexts(html, tag, 40, 200)).slice(0, 120),
    fieldValues,
    codeBlocks: [...elementTexts(html, "code", 40, 600), ...elementTexts(html, "pre", 20, 600)],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// --find

/** Search terms: quoted phrases kept whole, other words split on spaces and commas; lower case, at most 12. */
export function findTerms(raw: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|([^\s,"]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) && terms.length < 12) {
    const term = squash(match[1] ?? match[2] ?? "").toLowerCase();
    if (term.length >= 2 && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

/**
 * The passages of `lines` that mention any term: each matching line with one line either side, overlapping windows
 * merged, most distinct terms first and then page order, until `maxChars`.
 */
export function findPassages(lines: string[], terms: string[], maxChars: number): { passages: string[]; matchedLines: number } {
  if (!terms.length) return { passages: [], matchedLines: 0 };
  const hits: number[] = [];
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (terms.some((term) => lower.includes(term))) hits.push(index);
  });
  const windows: Array<{ start: number; end: number }> = [];
  for (const index of hits) {
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length - 1, index + 1);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  const scored = windows.map((window, order) => {
    const text = lines.slice(window.start, window.end + 1).join("\n");
    const lower = text.toLowerCase();
    return { text, order, score: terms.filter((term) => lower.includes(term)).length };
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen: typeof scored = [];
  let used = 0;
  for (const passage of scored) {
    const text = passage.text.length > maxChars ? `${passage.text.slice(0, maxChars)}…` : passage.text;
    if (chosen.length && used + text.length > maxChars) continue;
    chosen.push({ ...passage, text });
    used += text.length + 3;
    if (used >= maxChars || chosen.length >= 12) break;
  }
  chosen.sort((a, b) => a.order - b.order);
  return { passages: chosen.map((passage) => passage.text), matchedLines: hits.length };
}
