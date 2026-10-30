// `instafy-bind check <dir> --expect "<item>,<item>"`: does the site show every item the request named?
// A builder that loses an item to a lookup that timed out, or trims a list to what fits, must not ship a page that
// quietly leaves it out. The check reads what the page can show without a browser: the text of its HTML pages and
// every string in its data files (data.json, data/**/*.json, records included). Items come from --expect and from
// an "expect" array in data.json. Text that only says an item is unavailable ("Not found yet: Tokyo", a data file's
// "missing" list) does not count as showing it: builders are told to say on the page what they could not add, and
// that line must not pass the check. On a page of options it also checks the values and where each row comes from
// (below). Pure helpers are exported for the tests.
// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";

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
  const want = norm(item);
  if (!want) return false;
  const hay = ` ${norm(text)} `;
  return CJK.test(want) ? hay.includes(want) : hay.includes(` ${want} `);
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
export const UNAVAILABLE_RE = /^\s*(not found( yet)?|missing|not on the (map|page)( yet)?|could ?n[o']t (find|add|place)|unavailable|not available)\b/i;
/** Data keys that list what the page could not show ("missing": [...] in the map pack's data). */
const UNAVAILABLE_KEYS = new Set(["expect", "missing", "notfound", "not_found", "unavailable", "unplaced"]);

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
      } else if (entry.isFile() && /\.(html?|json)$/i.test(entry.name) && entry.name !== "bound.json" && entry.name !== "package.json") {
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return files;
}

/** What the site can show: [{ file, text }] for its HTML pages and data files, and the "expect" list of data.json. */
export function readSite(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`no site folder at ${dir}`);
  const parts = [];
  let declared = [];
  for (const file of siteFiles(root)) {
    let raw;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (/\.json$/i.test(file)) {
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (rel === "data.json" && Array.isArray(value?.expect)) declared = parseExpect(value.expect);
      parts.push({ file: rel, text: jsonStrings(value).join("\n") });
    } else parts.push({ file: rel, text: htmlLines(raw).join("\n") });
  }
  return { root, parts, declared };
}

/** Which expected items the site shows, and where; which it leaves out. */
export function checkSite(dir, expect = []) {
  const site = readSite(dir);
  const items = parseExpect([...site.declared, ...parseExpect(expect)]);
  const shown = [];
  const missing = [];
  for (const item of items) {
    const where = site.parts.filter((p) => names(p.text, item)).map((p) => p.file);
    if (where.length) shown.push({ item, files: where.slice(0, 3) });
    else missing.push(item);
  }
  return { items, shown, missing, files: site.parts.map((p) => p.file) };
}

// ---------- the values of a page of options (the compare and ranked starters' data.json) ----------
// Each value on such a page names the page it was read on and the day ("checked 27 Oct on maker.com"), and a value
// nobody found says so with why; a dash or "n/a" is not a value. A filter from a stated limit ("under €600") counts
// only values the page shows: the starters' site.byFilter lists a row whose value is unknown apart ("Price
// unknown"), never as within the limit. A row of a comparison is a candidate a page read names (a value's or a
// "sources" page), or only a search result ("found": its site, drawn "Not checked"). These rules read the data the
// same way site.js and the compare starter draw it.

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
  if (!isOptionsData(data) || !Array.isArray(data.columns)) return [];
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
  for (const cell of optionCells(data)) {
    const { fact } = cell;
    const where = `${cell.item} · ${cell.label}`;
    if (!fact || typeof fact !== "object") continue; // drawn "Unknown": nothing was found, and the page says so
    if (fact.v != null && !hasValue(fact)) {
      problems.push(`${where}: "${valueOf(fact).trim() || " "}" says nothing. Leave out "v" and say why in "note" ("no price on maker.com's page"), or give the page you read that does not list it ({"src", "url", "date"}); the page then says "Unknown".`);
      continue;
    }
    if (!hasValue(fact) || fact.est) continue;
    const lacks = [!fact.src && '"src"', !httpsUrl(fact.url) && '"url" (the page)', !fact.date && !fact.asof && '"date" (the day)'].filter(Boolean);
    const list = lacks.length > 1 ? `${lacks.slice(0, -1).join(", ")} or ${lacks[lacks.length - 1]}` : lacks[0];
    if (lacks.length) problems.push(`${where}: "${valueOf(fact)}" has no ${list}: add where you read it and when ("checked 27 Oct on maker.com"), or leave the value out.${fact.src ? "" : " Without a source the page shows it as not checked."}`);
  }
  for (const row of uncitedRows(data)) problems.push(row.problem);

  const filter = data.filter;
  if (filter && typeof filter === "object") {
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

/** The CLI's lines and exit code: 0 every item shown and every value fine, 1 an item missing or a value to fix, 2
 *  nothing to check. */
export function checkReport(dir, expect, { json = false } = {}) {
  const result = checkSite(dir, expect);
  const values = checkValues(dir);
  const bad = result.missing.length > 0 || values.problems.length > 0;
  if (!result.items.length && !values.problems.length) {
    const message = 'nothing to check: pass --expect "<item>,<item>" (each item the request named) or put "expect": [...] in data.json';
    return { exit: 2, lines: [json ? JSON.stringify({ ok: false, error: message, values }) : message, ...(json ? [] : values.notes.map((n) => `NOTE: ${n}`))] };
  }
  if (json) return { exit: bad ? 1 : 0, lines: [JSON.stringify({ ok: !bad, ...result, values })] };
  const lines = [];
  if (result.missing.length) {
    lines.push(`MISSING: the request named ${result.missing.length} item(s) the site does not show: ${result.missing.join(", ")}.`);
    lines.push("Add each one to the page (its data file), or say plainly in the reply which are missing and why.");
  }
  if (values.problems.length) {
    lines.push(`VALUES: ${values.problems.length} value(s) to fix in data.json:`);
    for (const problem of values.problems) lines.push(`- ${problem}`);
  }
  for (const note of values.notes) lines.push(`NOTE: ${note}`);
  if (result.items.length) {
    lines.push(`${result.shown.length} of ${result.items.length} expected item(s) shown${result.shown.length ? `: ${result.shown.map((s) => s.item).join(", ")}` : ""}.`);
    lines.push(`Read ${result.files.length} file(s): the HTML text and the data files (what a script renders from elsewhere is not seen).`);
  } else {
    lines.push('No items to check: pass --expect "<item>,<item>" (each item the request named) or put "expect": [...] in data.json.');
  }
  return { exit: bad ? 1 : 0, lines };
}
