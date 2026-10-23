// `instafy-bind check <dir> --expect "<item>,<item>"`: does the site show every item the request named?
// A builder that loses an item to a lookup that timed out, or trims a list to what fits, must not ship a page that
// quietly leaves it out. The check reads what the page can show without a browser: the text of its HTML pages and
// every string in its data files (data.json, data/**/*.json, records included). Items come from --expect and from
// an "expect" array in data.json. Pure helpers are exported for the tests.
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

/** Every string value in a JSON value (keys are not shown, values are). */
export function jsonStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (k !== "expect") jsonStrings(v, out);
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
    } else parts.push({ file: rel, text: htmlText(raw) });
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

/** The CLI's lines and exit code: 0 every item shown, 1 some missing, 2 nothing to check. */
export function checkReport(dir, expect, { json = false } = {}) {
  const result = checkSite(dir, expect);
  if (!result.items.length) {
    const message = 'nothing to check: pass --expect "<item>,<item>" (each item the request named) or put "expect": [...] in data.json';
    return { exit: 2, lines: [json ? JSON.stringify({ ok: false, error: message }) : message] };
  }
  if (json) return { exit: result.missing.length ? 1 : 0, lines: [JSON.stringify({ ok: !result.missing.length, ...result })] };
  const lines = [];
  if (result.missing.length) {
    lines.push(`MISSING: the request named ${result.missing.length} item(s) the site does not show: ${result.missing.join(", ")}.`);
    lines.push("Add each one to the page (its data file), or say plainly in the reply which are missing and why.");
  }
  lines.push(`${result.shown.length} of ${result.items.length} expected item(s) shown${result.shown.length ? `: ${result.shown.map((s) => s.item).join(", ")}` : ""}.`);
  lines.push(`Read ${result.files.length} file(s): the HTML text and the data files (what a script renders from elsewhere is not seen).`);
  return { exit: result.missing.length ? 1 : 0, lines };
}
