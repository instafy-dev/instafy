// `instafy-bind check <dir> --expect "<item>,<item>"`: does the site show every item the request named?
// A builder that loses an item to a lookup that timed out, or trims a list to what fits, must not ship a page that
// quietly leaves it out. The check reads what the page can show without a browser: the text of its HTML pages, every
// string in its data files (data.json, data/**/*.json, records included, and GeoJSON layers: a map's places are
// in data/<layer>.geojson), and in its own scripts the text they pass to site.js's helpers (site.h, site.head…: a
// blank starter page keeps its words in app.js) and the strings of their lists and objects (script-text.mjs). Items
// come from --expect and from an "expect" array in data.json. Text that only says an item is unavailable ("Not found
// yet: Tokyo", a data file's "missing" list) does not count as showing it: builders are told to say on the page what
// they could not add, and that line must not pass the check. An item is missing only when no file of the site names
// it: one whose words a script holds where the check cannot place them, or that a script fetches from another site, is
// one it cannot tell about, never one it reports missing. On a page of options it also checks the values and where each
// row comes from (below). A page is served from its own folder, so the check also fails a page that loads a file from
// outside it ("../another-page/site.js"), and names the command that gives the page its own files. Pure helpers are
// exported for the tests.
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { readScript } from "./script-text.mjs";
import { STARTER_HTML, STARTERS, STARTERS_DIR } from "./init.mjs";
import { shellWord } from "./preview-host.mjs";

const SKIP_DIRS = new Set([".bind", "node_modules", "handlers", ".git", ".uwcache", "test", "tests"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 400;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** "Brooks Adrenaline GTS 24, Hoka Arahi 7" (commas, semicolons or new lines), a JSON array of names, or an array of
 *  names / { name } objects → unique names in order. */
export function parseExpect(raw) {
  let list = raw;
  if (raw == null || raw === "") return [];
  if (typeof raw === "string") {
    if (/^\s*\[/.test(raw)) {
      try {
        list = JSON.parse(raw);
      } catch (error) {
        throw new Error(`--expect is not a JSON array (${error.message})`);
      }
    } else list = raw.split(/[,;\n]/);
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const name = String(entry && typeof entry === "object" ? entry.name ?? "" : entry ?? "").trim();
    if (name && !out.some((x) => norm(x) === norm(name))) out.push(name);
  }
  return out;
}

const norm = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Does the text name the item, as whole words ("Gel-Kayano 31" in "ASICS Gel Kayano 31 review"; not "Arahi 7" in
 *  "Arahi 75")? Scripts written without spaces (日本語, 中文) match as a substring. */
export function names(text, item) {
  return named(hay(text), item);
}
/** A text made ready for `named`, once for every item looked for in it. */
const hay = (text) => ` ${norm(text)} `;
function named(text, item) {
  const want = norm(item);
  if (!want) return false;
  return CJK.test(want) ? text.includes(want) : text.includes(` ${want} `);
}

/** The visible text of an HTML page: no scripts, styles, comments or tags. */
export function htmlText(html) {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ");
}

/** A line or string that only says an item is unavailable (the eval grader reads pages the same way). */
export const UNAVAILABLE_RE = /^\s*(not found( yet)?|(still )?missing|not on the (map|page)( yet)?|could ?n[o']t (find|add|place)|unavailable|not available)\b/i;
/** Data keys that list what the page could not show ("missing": [...] in the map pack's data); in a script, the keys
 *  and names of its lists of that. */
export const UNAVAILABLE_KEYS = new Set(["expect", "missing", "notfound", "not_found", "unavailable", "unplaced"]);

/** The visible text of an HTML page as lines (block ends and <br> break them), without lines that only say an item is
 *  unavailable. */
export function htmlLines(html) {
  const blocks = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|dt|dd|tr|td|th|h[1-6]|section|article|header|footer|aside|nav|figcaption|caption|summary|details|blockquote|pre|ul|ol|dl|table|main)\s*>/gi, "\n");
  return htmlText(blocks.replace(/\n/g, " \u0000 "))
    .split("\u0000")
    .map((line) => line.trim())
    .filter((line) => line && !UNAVAILABLE_RE.test(line));
}

/** Every string value in a JSON value (keys are not shown, values are), except the "expect" list, lists of what is
 *  unavailable, and strings that only say an item is. */
export function jsonStrings(value, out = []) {
  if (typeof value === "string") {
    if (!UNAVAILABLE_RE.test(value)) out.push(value);
  } else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!UNAVAILABLE_KEYS.has(k.toLowerCase())) jsonStrings(v, out);
  }
  return out;
}

function siteFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".") && depth < 4) walk(full, depth + 1);
      } else if (entry.isFile() && (/\.(html?|json|geojson|m?js|css)$/i.test(entry.name) || SOURCE.test(entry.name)) && entry.name !== "bound.json" && entry.name !== "package.json") {
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return files;
}

/** Page code the check does not read as a script (JSX, TypeScript, a framework's components): its words are only words
 *  the page may show. */
const SOURCE = /\.(?:jsx|tsx|m?ts|vue|svelte|astro)$/i;
/** A source that fetches text from another site while the page runs (fetch, EventSource or WebSocket given its address). */
const SOURCE_LOADS = /\b(?:fetch|EventSource|WebSocket)\s*\(\s*[`'"]\s*(?:(?:https?|wss?):)?\/\//i;
/** The starters' shared helpers (site.js) define `site`: their own words are no page's text. */
const DEFINES_SITE = /\bwindow\.site\s*=\s*\{/;
/** The scripts an HTML page carries in itself: [attributes, source]. */
const INLINE_SCRIPTS = /<script\b(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script\s*>/gi;
/** An inline script's type that is JavaScript (none is too); a JSON block or a template is not the page's script. */
const SCRIPT_TYPE = /(?:^|\s)type\s*=\s*["']?\s*([^"'\s>]*)/i;
const JS_TYPE = /^(?:module|(?:text|application)\/(?:java|ecma)script)?$/i;

// ---------- what a page loads from outside its folder ----------
// A page is served from its own folder (its card serves the folder it runs in), so a file it loads from another folder
// ("../other-page/site.js") is not there when it is served, and the page would change whenever that folder does.

/** Whether `ref`, given in a file in `from` (its folder in the site, "" at the top), climbs above the site's folder. An
 *  address of another site, a data: URL, a path from the site's root ("/theme.css") and a fragment stay inside. */
export function leavesFolder(ref, from = "") {
  const file = String(ref).trim().split(/[?#]/)[0].replace(/\\/g, "/");
  if (!file || file.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(file)) return false;
  let depth = from ? from.split("/").filter(Boolean).length : 0;
  for (const part of file.split("/")) {
    if (part === "..") {
      if (--depth < 0) return true;
    } else if (part && part !== ".") depth += 1;
  }
  return false;
}

const LOAD_TAG = /<([a-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const TAG_ATTR = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g;
const CSS_LOAD = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
/** A string in a script that names a file above its own folder ("../other/data.json": fetched, imported, a data path),
 *  not a folder or a bare "../" that code compares with. */
const SCRIPT_PATH = /(["'`])((?:\.\/)*\.\.\/[^"'`\s$]*[\w-])\1/g;
const cssLoads = (css) => [...String(css).matchAll(CSS_LOAD)].map((m) => m.slice(1).find((v) => v != null) ?? "");
const scriptPaths = (source) => [...String(source).matchAll(SCRIPT_PATH)].map((m) => m[2]);

/** What an HTML page loads, as [ref, from]: what an element loads (src, srcset, poster, an <object>'s data, a <link>'s
 *  href), what its styles load, and the paths its scripts name. */
function htmlLoads(html, from) {
  const out = [];
  const text = String(html).replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (all, tag, attrs, body) => {
    // a script the page carries reads its paths from the page
    for (const ref of tag.toLowerCase() === "style" ? cssLoads(body) : scriptPaths(body)) out.push([ref, from]);
    return `<${tag}${attrs}>`;
  });
  for (const [, tag, attrs] of text.matchAll(LOAD_TAG)) {
    for (const [, name, ...values] of attrs.matchAll(TAG_ATTR)) {
      const key = name.toLowerCase();
      const value = values.find((v) => v != null) ?? "";
      if (key === "srcset") for (const each of value.split(",")) out.push([each.trim().split(/\s+/)[0], from]);
      else if (key === "src" || key === "poster" || (key === "data" && tag.toLowerCase() === "object") || (key === "href" && tag.toLowerCase() === "link")) out.push([value, from]);
      else if (key === "style") for (const ref of cssLoads(value)) out.push([ref, from]);
    }
  }
  return out;
}

/** The files a site's pages, styles and scripts load from outside its folder: [{ file, loads: [ref, …] }]. A script's
 *  path counts only when it climbs out from the script's folder and from the top of the site alike (fetch reads it from
 *  the page, an import from the script). */
function outsideLoads(files) {
  const out = [];
  for (const { file, rel, raw } of files) {
    const from = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    let loads = [];
    if (/\.html?$/i.test(file)) loads = htmlLoads(raw, from);
    else if (/\.css$/i.test(file)) loads = cssLoads(raw).map((ref) => [ref, from]);
    else if (/\.m?js$/i.test(file)) loads = scriptPaths(raw).filter((ref) => leavesFolder(ref, "")).map((ref) => [ref, from]);
    const refs = [...new Set(loads.filter(([ref, base]) => leavesFolder(ref, base)).map(([ref]) => ref.trim()))];
    if (refs.length) out.push({ file: rel, loads: refs });
  }
  return out;
}

/** The starter whose files a page loads from another folder, from the first line of a starter's script ("/* Compare
 *  starter: …"), else blank: every starter brings theme.css and site.js, and blank nothing else a page would load. */
function borrowedStarter(root, outside) {
  for (const { file, loads } of outside) {
    for (const ref of loads) {
      if (!/\.m?js$/i.test(ref.split(/[?#]/)[0])) continue;
      let head = "";
      try {
        const fd = fs.openSync(path.resolve(root, path.dirname(file), ref.split(/[?#]/)[0]), "r");
        try {
          const buffer = Buffer.alloc(200);
          head = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, 200, 0));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      const name = /^\s*\/\*\s*([A-Za-z]+) starter\b/.exec(head)?.[1]?.toLowerCase();
      if (name && Object.hasOwn(STARTERS, name)) return name;
    }
  }
  return "blank";
}

/** site.js's version, [major, minor, patch], or null. */
function siteVersion(source) {
  const m = /\bversion\s*:\s*["'](\d+)\.(\d+)(?:\.(\d+))?["']/.exec(source);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
const before = (version, [major, minor]) => !!version && (version[0] < major || (version[0] === major && version[1] < minor));

/** What the site can show: [{ file, kind, text }] for its HTML pages, data files and scripts ("html", "data",
 *  "script"), the "expect" list of data.json, its own scripts ([{ file, other, loads }]: a script file, or the
 *  scripts an HTML page carries; `other`, the words they hold where the check cannot place them, and `loads`, whether
 *  they fetch text from another site), and what it loads from outside its folder (`outside`). */
export function readSite(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`no site folder at ${dir}`);
  const parts = [];
  const scripts = [];
  let declared = [];
  const files = [];
  for (const file of siteFiles(root)) {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      files.push({ file, rel: path.relative(root, file).split(path.sep).join("/"), raw: fs.readFileSync(file, "utf8") });
    } catch {
      continue;
    }
  }
  // site.js before 1.7.0 draws nothing for a second argument to site.h that is not its props (h("p", "text"))
  const childArg = !files.some(({ file, raw }) => /\.m?js$/i.test(file) && DEFINES_SITE.test(raw) && before(siteVersion(raw), [1, 7]));
  const read = (source) => readScript(source, { childArg, lists: UNAVAILABLE_KEYS });
  const shownText = (script) => [...script.lines, ...script.data].filter((text) => !UNAVAILABLE_RE.test(text));
  const otherText = (script) => script.other.filter((text) => !UNAVAILABLE_RE.test(text));
  for (const { file, rel, raw } of files) {
    if (/\.css$/i.test(file)) continue;
    if (/\.(geo)?json$/i.test(file)) {
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (rel === "data.json" && Array.isArray(value?.expect)) declared = parseExpect(value.expect);
      parts.push({ file: rel, kind: "data", text: jsonStrings(value).join("\n") });
    } else if (SOURCE.test(file)) {
      scripts.push({ file: rel, other: raw, loads: SOURCE_LOADS.test(raw) });
    } else if (/\.m?js$/i.test(file)) {
      if (DEFINES_SITE.test(raw)) continue;
      const script = read(raw);
      parts.push({ file: rel, kind: "script", text: shownText(script).join("\n") });
      scripts.push({ file: rel, other: otherText(script).join("\n"), loads: script.loads });
    } else {
      const inline = [...raw.matchAll(INLINE_SCRIPTS)]
        .filter(([, attrs, source]) => JS_TYPE.test(SCRIPT_TYPE.exec(attrs)?.[1] ?? "") && source.trim() && !DEFINES_SITE.test(source))
        .map(([, , source]) => read(source));
      parts.push({ file: rel, kind: "html", text: [...htmlLines(raw), ...inline.flatMap(shownText)].join("\n") });
      if (inline.length) scripts.push({ file: rel, other: inline.flatMap(otherText).join("\n"), loads: inline.some((s) => s.loads) });
    }
  }
  return { root, parts, declared, scripts, outside: outsideLoads(files) };
}

/** Which expected items the site shows, and where; which it leaves out; and which it cannot tell about (`unknown`):
 *  their words are in a script where the check cannot place them, or a script fetches text from another site, so the
 *  page may show them all the same (`unread`: those scripts). An item no file of the site names is missing. `outside`:
 *  the files its pages, styles and scripts load from outside its folder. */
export function checkSite(dir, expect = []) {
  const site = readSite(dir);
  const items = parseExpect([...site.declared, ...parseExpect(expect)]);
  const parts = site.parts.map((p) => ({ file: p.file, text: hay(p.text) }));
  const scripts = site.scripts.map((s) => ({ file: s.file, loads: s.loads, text: hay(s.other) }));
  const shown = [];
  const missing = [];
  const unknown = [];
  const unread = new Set();
  for (const item of items) {
    const where = parts.filter((p) => named(p.text, item)).map((p) => p.file);
    if (where.length) {
      shown.push({ item, files: where.slice(0, 3) });
      continue;
    }
    const held = scripts.filter((s) => s.loads || named(s.text, item)).map((s) => s.file);
    if (!held.length) missing.push(item);
    else {
      unknown.push(item);
      for (const file of held) unread.add(file);
    }
  }
  return { items, shown, missing, unknown, unread: [...unread], files: site.parts.map((p) => p.file), outside: site.outside };
}

// ---------- the values of a page of options (the compare and ranked starters' data.json) ----------
// Each value on such a page names the page it was read on and the day ("checked 27 Oct on maker.com"), and a value
// nobody found says so with why; a dash or "n/a" is not a value. A filter from a stated limit ("under €600") counts
// only values the page shows: the starters' site.byFilter lists a row whose value is unknown apart ("Price
// unknown"), never as within the limit. A row of a comparison is a candidate a page read names (a value's or a
// "sources" page), or only a search result ("found": its site, drawn "Not checked"). A page the person asked for from
// what Octo knows, with nothing looked up ("from": "memory"), cites no page at all: each value reads "<value>, not
// checked". These rules read the data the same way site.js and the compare starter draw it.

/** A value that only says nothing is known: blank, dashes, "?", "n/a", "unknown", "TBD" (site.js: no value). */
export const NO_VALUE = /^(?:[\s\-\u2010-\u2015?.\u00b7\u2026/]*|n\s*\/\s*a|unknown|tb[ad])$/i;
const valueOf = (fact) => (fact && typeof fact === "object" && fact.v != null ? String(fact.v) : "");
const hasValue = (fact) => !!valueOf(fact) && !NO_VALUE.test(valueOf(fact).trim());
const httpsUrl = (url) => {
  try {
    return new URL(String(url)).protocol === "https:";
  } catch {
    return false;
  }
};

/** The first number in a text, read the way shops write it (site.js: numberIn): a ".", ",", space or "'" before
 *  exactly three digits groups thousands ("1.299", "1 299", "1,299" are 1299), and the last "." or "," is the decimal
 *  mark otherwise ("1.299,00" is 1299, "549,99" is 549.99, "4.6" is 4.6). */
export function numberIn(text) {
  const m = /(-?)(\d+)((?:[.,'\u2019 \u00a0\u2009\u202f]\d+)*)/.exec(String(text ?? ""));
  if (!m) return null;
  const head = m[2];
  const parts = m[3] ? m[3].match(/[.,'\u2019 \u00a0\u2009\u202f]\d+/g) : [];
  const decimalMark = (p) => p[0] === "." || p[0] === ",";
  let dec = -1;
  parts.forEach((p, i) => {
    if (decimalMark(p)) dec = i;
  });
  // the last "." or "," groups thousands when three digits follow it, one to three (not just 0) lead, and no other kind
  // of decimal mark comes before it: "1.299", "1,299,000"
  if (dec >= 0 && parts[dec].length === 4 && head.length <= 3 && head !== "0" && parts.slice(0, dec).every((p) => !decimalMark(p) || p[0] === parts[dec][0])) dec = -1;
  let whole = head;
  for (const part of parts.slice(0, dec >= 0 ? dec : parts.length)) {
    // a mark that does not group thousands ends the number: "2 3-year plans" is 2
    if (head.length > 3 || part.length !== 4) return Number(m[1] + whole);
    whole += part.slice(1);
  }
  return Number(m[1] + whole + (dec >= 0 ? `.${parts[dec].slice(1)}` : ""));
}

/** The number a page shows for a seed fact (site.known): a value with its source, or an estimate; else null. */
export function knownNumber(fact) {
  if (!hasValue(fact) || !(fact.src || fact.est)) return null;
  if (typeof fact.n === "number") return fact.n;
  return numberIn(valueOf(fact));
}

/** Is this data.json a page of options: compare (columns of facts per item) or ranked (a price and specs per item)? */
export function isOptionsData(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) return false;
  return Array.isArray(data.columns) || data.items.some((i) => i && typeof i === "object" && ("price" in i || "specs" in i || "rank" in i));
}

/** Every value of a page of options: [{item, ref, label, key, fact, price}]. Compare: each column of each item;
 *  ranked: each item's price (when it has one or a store), specs and details. */
export function optionCells(data) {
  const out = [];
  if (!isOptionsData(data)) return out;
  const columns = Array.isArray(data.columns) ? data.columns.filter((c) => c && typeof c === "object" && c.key) : null;
  for (const item of data.items) {
    if (!item || typeof item !== "object") continue;
    const base = { item: String(item.name ?? item.ref ?? "an item"), ref: item.ref };
    if (columns) {
      for (const c of columns.slice(0, 5)) out.push({ ...base, label: String(c.label ?? c.key), key: c.key, fact: item.facts?.[c.key], price: c.type === "price" });
      continue;
    }
    if ("price" in item || item.store) out.push({ ...base, label: "Price", key: "price", fact: item.price, price: true });
    for (const fact of Array.isArray(item.specs) ? item.specs : []) out.push({ ...base, label: "spec", key: null, fact });
    for (const d of Array.isArray(item.details) ? item.details : []) out.push({ ...base, label: String(d?.label ?? d?.key ?? "detail"), key: d?.key ?? null, fact: d?.fact });
  }
  return out;
}

/** The newest live record per ref and attribute in the site's record files (what a check wrote): Map ref -> record[]. */
function liveRecords(root) {
  const byRef = new Map();
  const dir = path.join(root, "data", "records");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return byRef;
  }
  for (const file of files) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    for (const r of Array.isArray(value?.records) ? value.records : []) {
      if (!r || typeof r !== "object" || typeof r.ref !== "string") continue;
      (byRef.get(r.ref) || byRef.set(r.ref, []).get(r.ref)).push(r);
    }
  }
  return byRef;
}

/** Does a check record give the row a value for `key` that the page shows (a priced offer, or a claim that found it)? */
function liveValue(records, key) {
  const list = (records || []).filter((r) => (key === "price" && r.type === "offer" && typeof r.price?.amount === "number") || (r.type === "claim" && r.attr === key));
  const newest = list.sort((a, b) => (Date.parse(b.prov?.observed_at) || 0) - (Date.parse(a.prov?.observed_at) || 0))[0];
  if (!newest) return null;
  if (newest.type === "offer") return newest.price.amount;
  if (["uncertain", "not_found", "error"].includes(newest.status) || newest.value == null) return null;
  return NO_VALUE.test(String(newest.value).trim()) ? null : numberIn(String(newest.value));
}

/** A page made from what Octo knows, at the person's ask, with nothing looked up ("from": "memory"). */
export const fromMemory = (data) => !!data && typeof data === "object" && data.from === "memory";

/** The keys that say a value was read, on which page and when, and a row's store, which the page offers to check. */
const READ_KEYS = new Set(["src", "url", "date", "asof", "store"]);

/** On a page from what Octo knows, as problems: every source, address, day or store it gives, since nothing was read,
 *  so each would claim or offer a check ("checked 1 Mar on maker.com"); a filter, under which no value counts as known;
 *  and the mark on a page only the compare starter draws. One problem per row, and one for the rest of the page. */
export function memoryCitations(data) {
  if (!fromMemory(data)) return [];
  if (!Array.isArray(data.columns)) return [`the page: only the compare starter ("columns" and "items") draws a page from what Octo knows ("from": "memory"). Build it with that starter, each value only its "v" (or a "note").`];
  const keysIn = (value, keys = new Set()) => {
    if (Array.isArray(value)) for (const v of value) keysIn(v, keys);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        // a row's "facts" are keyed by its columns ("date" for a "Released" column): only the values say anything
        if (k === "facts" && v && typeof v === "object") keysIn(Object.values(v), keys);
        else if (READ_KEYS.has(k) && v != null && String(v).trim() !== "") keys.add(k);
        else keysIn(v, keys);
      }
    }
    return keys;
  };
  const listed = (keys) => [...keys].map((k) => `"${k}"`).join(", ").replace(/, ([^,]*)$/, " and $1");
  const problem = (label, keys) => `${label}: this page is from what Octo knows ("from": "memory"), so nothing on it was read: leave out its ${listed(keys)}. Each value is only its "v" (or a "note"), and reads "<value>, not checked". A page you read is cited on a page without "from": "memory".`;
  const out = [];
  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    const keys = keysIn(item);
    if (keys.size) out.push(problem(String(item?.name ?? item?.ref ?? "a row"), keys));
  }
  const rest = keysIn({ ...data, items: [] });
  if (rest.size) out.push(problem("the page", rest));
  if (data.filter && typeof data.filter === "object") {
    out.push(`the filter "${String(data.filter.label || data.filter.key || "")}": nothing on a page from what Octo knows was checked, so no value on it counts as within the limit. Leave out "filter", and say in the lede how each compares with it.`);
  }
  return out;
}

/** A page a row cites: a value with its source and https page, or a "sources" entry with an https page. */
const citesPage = (fact) => !!(fact && typeof fact === "object" && !fact.est && fact.src && httpsUrl(fact.url));

/** A site as a search result names it ("reviews.example.net"): a host name, not a word or an address. */
const SITE_NAME = /^(?=.{1,253}$)(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}[\p{L}\p{N}-]*$/u;

/** The rows of a comparison (the compare starter's data: "columns" and "items") that say nowhere where they come from:
 *  no value or "sources" entry cites a page that was read, and no "found" names the site of the search result that
 *  alone names them. Such a row is a guess or a placeholder ("Model 1"): [{item, problem}]. Judged by the data's
 *  shape, never by the row's words. A list of names the same turn writes (`--expect`, data.json's "expect") only says
 *  what the page must show; it never vouches for a row. */
export function uncitedRows(data) {
  // a page from what Octo knows cites no page by design: its values say "not checked" (memoryCitations)
  if (!isOptionsData(data) || !Array.isArray(data.columns) || fromMemory(data)) return [];
  const out = [];
  for (const item of data.items) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name ?? item.ref ?? "");
    const facts = [...Object.values(item.facts && typeof item.facts === "object" ? item.facts : {}), ...(Array.isArray(item.more) ? item.more.map((m) => m?.fact) : [])];
    const sources = Array.isArray(item.sources) ? item.sources : [];
    if (facts.some(citesPage) || sources.some((s) => s && typeof s === "object" && s.name && httpsUrl(s.url))) continue;
    if (typeof item.found === "string" && SITE_NAME.test(item.found.trim())) continue;
    const label = name || "a row";
    out.push({
      item: label,
      problem: `${label}: nothing says where this row comes from. Cite the page you read that names it (a value's "src" and "url", or "sources": [{"name", "url"}]). When only a search result names it, put that result's site in "found" ("found": "example.com"): the page then says it is not checked. Naming it in --expect or "expect" does not count. A row nothing named (a guess, "Model 1") does not belong on the page.`,
    });
  }
  return out;
}

/** The values of a site's page of options, and where its rows come from: problems to fix before the card, and notes
 *  for the reply. */
export function checkValues(dir) {
  const root = path.resolve(dir);
  const problems = [];
  const notes = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, "data.json"), "utf8"));
  } catch {
    return { checked: false, problems, notes };
  }
  if (!isOptionsData(data)) return { checked: false, problems, notes };
  const memory = fromMemory(data);
  for (const cell of optionCells(data)) {
    const { fact } = cell;
    const where = `${cell.item} · ${cell.label}`;
    if (!fact || typeof fact !== "object") continue; // drawn "Unknown": nothing was found, and the page says so
    if (fact.v != null && !hasValue(fact)) {
      problems.push(`${where}: "${valueOf(fact).trim() || " "}" says nothing. Leave out "v" and say why in "note" ("price not found on maker.com's page"), or give the page you read without finding it there ({"src", "url", "date"}); the page then says "Unknown".`);
      continue;
    }
    // a value from what Octo knows names no page and no day (memoryCitations, below)
    if (memory || !hasValue(fact) || fact.est) continue;
    const lacks = [!fact.src && '"src"', !httpsUrl(fact.url) && '"url" (the page)', !fact.date && !fact.asof && '"date" (the day)'].filter(Boolean);
    const list = lacks.length > 1 ? `${lacks.slice(0, -1).join(", ")} or ${lacks[lacks.length - 1]}` : lacks[0];
    if (lacks.length) problems.push(`${where}: "${valueOf(fact)}" has no ${list}: add the page that gives this value and the day you read it ("checked 27 Oct on maker.com"). When no page gives it (such as a count of what you found, with none found), leave out "v" and say why in "note".${fact.src ? "" : " Without a source the page shows it as not checked."}`);
  }
  for (const row of uncitedRows(data)) problems.push(row.problem);
  problems.push(...memoryCitations(data));

  const filter = data.filter;
  // a page from what Octo knows has no filter (memoryCitations)
  if (filter && typeof filter === "object" && !memory) {
    const label = String(filter.label || "the filter");
    const columns = Array.isArray(data.columns) ? data.columns : null;
    const isNumber = (v) => v != null && v !== "" && Number.isFinite(Number(v));
    if (!filter.key) problems.push(`the filter "${label}" has no "key".`);
    if (!filter.label) problems.push('the filter has no "label" (what the person asked for: "€600 or less").');
    else if (columns && !columns.some((c) => c && c.key === filter.key)) problems.push(`the filter's key "${filter.key}" is not a column, so "${label}" filters nothing.`);
    if (!isNumber(filter.max) && !isNumber(filter.min)) problems.push(`the filter "${label}" has no number in "max" or "min".`);
    let app = "";
    try {
      app = fs.readFileSync(path.join(root, "app.js"), "utf8");
    } catch {
      /* a page without app.js draws no filter */
    }
    if (app && !/\bsite\.byFilter\s*\(|\bsite\.within\s*\(/.test(app)) {
      problems.push(`data.json has a filter, and app.js applies it without site.byFilter: a row whose value is unknown may be listed as "${label}". Use the starter's filter code (site.byFilter), which lists such rows apart.`);
    }
    if (filter.key) {
      const live = liveRecords(root);
      // per item, as the page's filter reads it: its value for the key (none counts as unknown), or a check's
      const factOf = (item) => columns ? item.facts?.[filter.key]
        : filter.key === "price" ? item.price : (Array.isArray(item.details) ? item.details : []).find((d) => d?.key === filter.key)?.fact;
      const unknown = data.items
        .filter((item) => item && typeof item === "object")
        .filter((item) => knownNumber(factOf(item)) == null && liveValue(live.get(item.ref), filter.key) == null)
        .map((item) => String(item.name ?? item.ref ?? "an item"));
      if (unknown.length) {
        const col = columns?.find((c) => c && c.key === filter.key);
        const title = filter.unknown || `${col?.label ?? (filter.key === "price" ? "Price" : filter.key)} unknown`;
        notes.push(`${unknown.length} item(s) have no ${String(col?.label ?? filter.key).toLowerCase()} the page can show: ${unknown.join(", ")}. The page lists them apart ("${title}"), never as "${label}"; say so in the lede and the reply, with why for each.`);
      }
    }
  }
  return { checked: true, problems, notes };
}

/** The page's title for its card: data.json's "title", else the title its script gives site.head, else its HTML's
 *  <title> unless a starter wrote it ("Compare"), else its folder's name. */
export function cardTitle(dir) {
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      return "";
    }
  };
  let data = null;
  try {
    data = JSON.parse(read("data.json"));
  } catch {
    /* no data.json */
  }
  const words = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const titleOf = (html) => words(htmlText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? ""));
  const head = /\bsite\.head\(\s*\{[\s\S]{0,400}?\btitle\s*:\s*(["'`])((?:\\.|(?!\1)[^\\\n])+)\1/.exec(read("app.js"))?.[2]?.replace(/\\(.)/g, "$1");
  const starters = new Set([STARTER_HTML, ...Object.values(STARTERS).map((files) => fs.readFileSync(path.join(STARTERS_DIR, files["index.html"]), "utf8"))].map(titleOf));
  const html = titleOf(read("index.html"));
  const title = [typeof data?.title === "string" ? data.title : "", head, starters.has(html) ? "" : html].map(words).find(Boolean);
  return (title || words(path.basename(path.resolve(dir)).replace(/[-_]+/g, " "))).slice(0, 120);
}

const listed = (texts) => (texts.length > 1 ? `${texts.slice(0, -1).join(", ")} and ${texts.at(-1)}` : texts[0] ?? "");

/** The lines for files a page loads from outside its folder, and the command that gives it its own. */
function outsideLines(dir, root, outside) {
  const starter = borrowedStarter(root, outside);
  const own = new Set(Object.keys(STARTERS[starter]));
  const refs = outside.flatMap((o) => o.loads);
  const other = [...new Set(refs.filter((ref) => !own.has(path.posix.basename(ref.split(/[?#]/)[0]))))];
  const first = refs[0];
  const init = `instafy bind init ${shellWord(dir)} --starter ${starter}`;
  return {
    init,
    lines: [
      `OUTSIDE: ${outside.map((o) => `${o.file} loads ${listed(o.loads)}`).join("; ")}, from outside ${dir}. A page is served from its own folder, so there it can't load ${refs.length > 1 ? "them" : "it"}, and it would change whenever that other folder does.`,
      `Give it its own files: \`${init}\` adds the starter's files it lacks and keeps yours.${other.length ? ` Copy ${listed(other)} into its folder too.` : ""} Load each from the page's own folder (${path.posix.basename(first.split(/[?#]/)[0])}, not ${first}), then check again.`,
    ],
  };
}

/** The CLI's lines and exit code: 0 every item shown and every value fine, 1 an item missing, a value to fix or a file
 *  loaded from outside the site's folder, 2 nothing to check, or items the check cannot tell about because the page
 *  draws its text in a way it cannot read. `card`: the command that serves the site and posts its card, while no
 *  preview shows it. A check that passes takes that step itself with `post` (which runs the command and says what it
 *  answered); any other answer ends with the command, since a failing check never holds the card back, except for a
 *  page that loads files from outside its folder: served on its own it can't load them, so its card waits for the
 *  check that passes. */
export function checkReport(dir, expect, { json = false, card = null, post = null } = {}) {
  const result = checkSite(dir, expect);
  const values = checkValues(dir);
  const { missing, unknown, outside } = result;
  const fix = outside.length ? outsideLines(dir, path.resolve(dir), outside) : null;
  const next = card && !fix ? `post its card: ${card}` : null;
  const nextLines = next ? [`next: ${next}`] : [];
  if (!result.items.length && !values.problems.length) {
    const message = 'nothing to check: pass --expect "<item>,<item>" (each item the request named) or put "expect": [...] in data.json';
    const exit = fix ? 1 : 2;
    if (json) return { exit, lines: [JSON.stringify({ ok: false, error: message, values, ...(fix ? { outside, init: fix.init } : {}), ...(next ? { next } : {}) })] };
    return { exit, lines: [...(fix ? fix.lines : []), message, ...values.notes.map((n) => `NOTE: ${n}`), ...nextLines] };
  }
  const exit = missing.length || values.problems.length || fix ? 1 : unknown.length ? 2 : 0;
  // the check that passes posts the card itself, while no preview shows the site
  const posted = exit === 0 && card && post ? post() : null;
  if (json) {
    const step = posted ? { card: { posted: posted.ok, command: posted.command, ...(posted.ok ? { answer: answerOf(posted.output) } : { error: posted.error }) }, ...(posted.ok ? {} : { next: `post its card: ${posted.command}` }) } : next ? { next } : {};
    return { exit, lines: [JSON.stringify({ ok: exit === 0, ...result, values, ...(fix ? { init: fix.init } : {}), ...step })] };
  }
  const lines = [...(fix ? fix.lines : [])];
  if (missing.length) {
    lines.push(`MISSING: the request named ${missing.length} item(s) the site does not show: ${missing.join(", ")}.`);
    lines.push("Add each one to the page, or say plainly in the reply which are missing and why.");
  }
  if (unknown.length) {
    lines.push(`UNREAD: ${result.unread.join(", ")} may draw the page's text in a way the check cannot read (it reads the text a script passes to site.h and site.head, and the strings of its lists and objects), so the check cannot tell whether the page shows: ${unknown.join(", ")}.`);
    lines.push("Look at the page itself instead: `instafy preview check --port <its port>` loads it as Studio does and saves screenshots of it.");
  }
  if (values.problems.length) {
    lines.push(`VALUES: ${values.problems.length} value(s) to fix in data.json:`);
    for (const problem of values.problems) lines.push(`- ${problem}`);
  }
  for (const note of values.notes) lines.push(`NOTE: ${note}`);
  if (result.items.length) {
    lines.push(`${result.shown.length} of ${result.items.length} expected item(s) shown${result.shown.length ? `: ${result.shown.map((s) => s.item).join(", ")}` : ""}.`);
    lines.push(`Read ${result.files.length} file(s): the HTML text, the data files, and the text the page's scripts pass to site.h and site.head or hold in their lists and objects.`);
  } else {
    lines.push('No items to check: pass --expect "<item>,<item>" (each item the request named) or put "expect": [...] in data.json.');
  }
  if (posted?.ok) lines.push(`Posted its card: ran ${posted.command}, which answered:`, ...(posted.output ? posted.output.split("\n") : []));
  else if (posted) lines.push(`The card was not posted: ${posted.error}.`, `next: post its card: ${posted.command}`);
  return { exit, lines: [...lines, ...(posted ? [] : nextLines)] };
}

/** What the card's command answered: its JSON, or its words. */
function answerOf(output) {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}
