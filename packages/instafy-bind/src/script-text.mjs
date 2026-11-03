// What a page's own script shows, read from its source and never run (`instafy bind check`):
// - lines: the text it passes to site.js's helpers, one line per element as the page draws it: site.h's children and
//   "text" (an inline child, such as <strong> or a site.link, joins its parent's line), site.head's title, lede and
//   basis, site.link's words, site.notice, site.empty and site.notes. Calls count as site.h(…), window.site.h(…) or
//   through a name the script gives the helper (`var h = site.h`, `const { h, head } = site`). A blank starter page
//   keeps its words there, in app.js.
// - data: the strings of its own lists and objects ([…], {…}) outside those calls, read as a data file's are: not an
//   object's keys, the values of keys that hold no text (class, href…), nor what a key or a name such as "missing"
//   lists.
// - other: every other string it holds (a variable's value, a function's argument, the HTML it gives innerHTML…): words
//   the page may show that the check cannot place.
// - loads: whether it fetches text from another site while the page runs.
// SPDX-License-Identifier: AGPL-3.0-only

const HELPERS = new Set(["h", "head", "link", "notice", "empty", "notes"]);
// What a script may call the global `site` through.
const GLOBALS = new Set(["window", "globalThis", "self"]);
// Keys whose values are never text on the page (an address, a class, an attribute map, an event).
const NO_TEXT_KEY = /^(?:class|className|id|href|src|url|target|rel|type|role|style|ref|key|attrs|on|for|htmlFor)$|^(?:data|aria)-|^on[A-Z]/;
// The elements that start a line of their own on the page; any other (strong, a, span…) is on its parent's line, and a
// br ends it, as check.mjs's htmlLines reads an HTML page.
const BLOCK = new Set(["p", "div", "li", "dt", "dd", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
  "header", "footer", "aside", "nav", "figcaption", "caption", "summary", "details", "blockquote", "pre", "ul", "ol", "dl", "table",
  "main"]);
// Words after which "{" starts an object and "[" a list (not a block, not an index).
const BEFORE_VALUE = new Set(["return", "typeof", "case", "default", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield",
  "await"]);
// Where a br ends its parent's line.
const BREAK = "\u0000";
// What fetches text while a page runs.
const FETCHES = new Set(["fetch", "EventSource", "WebSocket"]);
// After these a "/" starts a regular expression, not a division.
const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "=>",
  "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const ID_START = /[\p{L}\p{Nl}$_]/u;
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$‌‍]/u;
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

/** One escape sequence at src[j] ("\\"): its character and where the source goes on. */
function escape(src, j) {
  const c = src[j + 1];
  if (c in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[c], j + 2];
  if (c === "x" && /^[0-9a-f]{2}$/i.test(src.slice(j + 2, j + 4))) return [String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)), j + 4];
  if (c === "u" && src[j + 2] === "{") {
    const end = src.indexOf("}", j + 3);
    const code = end < 0 ? NaN : parseInt(src.slice(j + 3, end), 16);
    return [Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "", end < 0 ? src.length : end + 1];
  }
  if (c === "u" && /^[0-9a-f]{4}$/i.test(src.slice(j + 2, j + 6))) return [String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)), j + 6];
  if (c === "\r") return ["", src[j + 2] === "\n" ? j + 3 : j + 2];
  if (c === "\n") return ["", j + 2];
  return [c ?? "", j + 2];
}

/** A '…' or "…" string at src[i]: its value and where the source goes on. */
function readString(src, i) {
  let value = "";
  let j = i + 1;
  while (j < src.length && src[j] !== src[i] && src[j] !== "\n") {
    if (src[j] === "\\") {
      const [ch, next] = escape(src, j);
      value += ch;
      j = next;
    } else value += src[j++];
  }
  return [value, j + 1];
}

/** The rest of a `${…}` from src[j] (just after "${"): where the source goes on after its "}". */
function skipExpression(src, j) {
  for (let depth = 1; j < src.length;) {
    const c = src[j];
    if (c === '"' || c === "'") j = readString(src, j)[1];
    else if (c === "`") j = readTemplate(src, j)[1];
    else if (c === "/" && src[j + 1] === "/") j = src.indexOf("\n", j) < 0 ? src.length : src.indexOf("\n", j);
    else if (c === "/" && src[j + 1] === "*") j = src.indexOf("*/", j + 2) < 0 ? src.length : src.indexOf("*/", j + 2) + 2;
    else {
      if (c === "{") depth += 1;
      else if (c === "}" && --depth === 0) return j + 1;
      j += 1;
    }
  }
  return j;
}

/** A `…` template at src[i]: its fixed text (a space where a ${…} goes) and where the source goes on. */
function readTemplate(src, i) {
  let value = "";
  let j = i + 1;
  while (j < src.length && src[j] !== "`") {
    if (src[j] === "\\") {
      const [ch, next] = escape(src, j);
      value += ch;
      j = next;
    } else if (src[j] === "$" && src[j + 1] === "{") {
      value += " ";
      j = skipExpression(src, j + 2);
    } else value += src[j++];
  }
  return [value, j + 1];
}

/** A regular expression at src[i]: where the source goes on after it and its flags. */
function skipRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j += 1) {
    if (src[j] === "\\") j += 1;
    else if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) {
      j += 1;
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
      return j;
    }
  }
  return src.length;
}

/** JS source → tokens: {t: "str", v} (a string, or a template's fixed text), {t: "id", v}, {t: "num"}, {t: "re"} and
 *  {t: "p", v} (punctuation, "=>" and "..." as one). Comments are dropped. */
export function tokens(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/\s/.test(c)) i += 1;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) < 0 ? src.length : src.indexOf("*/", i + 2) + 2;
    else if (c === '"' || c === "'" || c === "`") {
      const [v, next] = c === "`" ? readTemplate(src, i) : readString(src, i);
      out.push({ t: "str", v });
      i = next;
    } else if (c === "/" && (!out.length || ((out.at(-1).t === "p" || out.at(-1).t === "id") && BEFORE_REGEX.has(out.at(-1).v)))) {
      out.push({ t: "re" });
      i = skipRegex(src, i);
    } else if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j += 1;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j += 1;
      out.push({ t: "num" });
      i = j;
    } else {
      const v = src.startsWith("...", i) ? "..." : src.startsWith("=>", i) ? "=>" : c;
      out.push({ t: "p", v });
      i += v.length;
    }
  }
  return out;
}

const is = (tok, v) => !!tok && tok.t === "p" && tok.v === v;
const isId = (tok, v) => !!tok && tok.t === "id" && (v === undefined || tok.v === v);

/** Where toks[i] is `site` itself (or `window.site`), not a property of something else: the index after it, or -1. */
function siteAt(toks, i) {
  if (!isId(toks[i], "site")) return -1;
  if (is(toks[i - 1], ".") && !(isId(toks[i - 2]) && GLOBALS.has(toks[i - 2].v) && !is(toks[i - 3], "."))) return -1;
  return i + 1;
}

/** Where toks[k] starts `site` or `window.site`: the index after it, or -1. */
function siteFrom(toks, k) {
  if (isId(toks[k]) && GLOBALS.has(toks[k].v) && is(toks[k + 1], ".")) k += 2;
  return isId(toks[k], "site") ? k + 1 : -1;
}

/** The names a script gives the helpers: `h = site.h` (var, let, const or an assignment) and `{ h, head: top } = site`. */
function helperNames(toks) {
  const names = new Map();
  for (let i = 0; i < toks.length; i += 1) {
    if (!is(toks[i], "=")) continue;
    const after = siteFrom(toks, i + 1);
    if (after < 0) continue;
    if (isId(toks[i - 1]) && !is(toks[i - 2], ".") && is(toks[after], ".") && isId(toks[after + 1]) && HELPERS.has(toks[after + 1].v)
      && !["(", ".", "["].some((p) => is(toks[after + 2], p))) {
      names.set(toks[i - 1].v, toks[after + 1].v);
    } else if (is(toks[i - 1], "}") && !["(", ".", "["].some((p) => is(toks[after], p))) {
      let open = -1;
      for (let j = i - 1, depth = 0; j >= 0; j -= 1) {
        if (is(toks[j], "}")) depth += 1;
        else if (is(toks[j], "{") && --depth === 0) {
          open = j;
          break;
        }
      }
      for (let j = open + 1; open >= 0 && j < i - 1; j += 1) {
        if (isId(toks[j]) && HELPERS.has(toks[j].v) && (is(toks[j - 1], "{") || is(toks[j - 1], ","))) {
          names.set(is(toks[j + 1], ":") && isId(toks[j + 2]) ? toks[j + 2].v : toks[j].v, toks[j].v);
        }
      }
    }
  }
  return names;
}

/** A call to a helper at toks[i]: {name, open} (open: the index of its "("), or null. */
function helperCall(toks, i, names) {
  const after = siteAt(toks, i);
  if (after >= 0 && is(toks[after], ".") && isId(toks[after + 1]) && HELPERS.has(toks[after + 1].v) && is(toks[after + 2], "(")) {
    return { name: toks[after + 1].v, open: after + 2 };
  }
  if (isId(toks[i]) && names.has(toks[i].v) && is(toks[i + 1], "(") && !is(toks[i - 1], ".") && !isId(toks[i - 1], "function")) {
    return { name: names.get(toks[i].v), open: i + 1 };
  }
  return null;
}

/** From toks[k], the index of the next "," or closing bracket at this depth (or `limit`). */
function itemEnd(toks, k, limit) {
  for (let depth = 0; k < limit; k += 1) {
    const t = toks[k];
    if (t.t !== "p") continue;
    if (t.v === "(" || t.v === "[" || t.v === "{") depth += 1;
    else if (t.v === ")" || t.v === "]" || t.v === "}") {
      if (depth === 0) return k;
      depth -= 1;
    } else if (t.v === "," && depth === 0) return k;
  }
  return limit;
}

/** The arguments of the call whose "(" is toks[open]: [[start, end), …]. */
function callArgs(toks, open) {
  const list = [];
  for (let k = open + 1; k < toks.length;) {
    const end = itemEnd(toks, k, toks.length);
    if (end > k) list.push([k, end]);
    if (!is(toks[end], ",")) return { list, end: end + 1 };
    k = end + 1;
  }
  return { list, end: toks.length };
}

/** The index of the bracket that closes the one at toks[open]. */
function closing(toks, open) {
  for (let k = open + 1; k < toks.length;) {
    const end = itemEnd(toks, k, toks.length);
    if (!is(toks[end], ",")) return end;
    k = end + 1;
  }
  return toks.length;
}

/** The entries of an object literal that is the whole of [s, e): [{key, s, e}], or null when it is not one. */
function objectEntries(toks, [s, e]) {
  if (!is(toks[s], "{") || closing(toks, s) !== e - 1) return null;
  const entries = [];
  for (let k = s + 1; k < e - 1;) {
    const end = itemEnd(toks, k, e - 1);
    if ((toks[k].t === "id" || toks[k].t === "str") && is(toks[k + 1], ":")) entries.push({ key: toks[k].v, s: k + 2, e: end });
    k = end + 1;
  }
  return entries;
}

/** A second argument site.h takes as its props: an object, or a name or property that may hold one (null too). */
function propsLike(toks, [s, e]) {
  if (objectEntries(toks, [s, e])) return true;
  for (let k = s; k < e; k += 1) if (!(isId(toks[k]) || (is(toks[k], ".") && k > s))) return false;
  return true;
}

/** The strings in [s, e) that the page shows, into `words`: not an object's keys, nor the values of keys that hold no
 *  text. A helper call inside is read as the element it draws: an inline one's words join `words`, a block one is a
 *  line of its own. */
function collect(toks, [s, e], ctx, words) {
  for (let k = s; k < e; k += 1) {
    const call = helperCall(toks, k, ctx.names);
    if (call) {
      ctx.consumed.add(k);
      const read = readCall(toks, call, ctx, true);
      if (read.text) words.push(read.text);
      k = read.end - 1;
      continue;
    }
    const t = toks[k];
    if ((t.t === "id" || t.t === "str") && is(toks[k + 1], ":") && (is(toks[k - 1], "{") || is(toks[k - 1], ","))) {
      k = NO_TEXT_KEY.test(t.v) ? itemEnd(toks, k + 2, e) - 1 : k + 1;
      continue;
    }
    if (t.t === "str" && t.v.trim()) words.push(t.v);
  }
}

/** The helper calls in [s, e) of an argument that draws nothing: never read as the page's text. */
function drop(toks, [s, e], ctx) {
  for (let k = s; k < e; k += 1) if (helperCall(toks, k, ctx.names)) ctx.consumed.add(k);
}

/** An element's tag, when the call names it with a string ("p"); else "". */
function tagOf(toks, range) {
  return range && range[1] - range[0] === 1 && toks[range[0]].t === "str" ? toks[range[0]].v.trim().toLowerCase() : "";
}

/** One helper call: the lines it draws go to ctx.lines; inside another element's children (`nested`), an inline
 *  element's words come back instead, for its parent's line. Also the index after its ")". */
function readCall(toks, { name, open }, ctx, nested = false) {
  const { list, end } = callArgs(toks, open);
  const words = [];
  const take = (range) => range && collect(toks, range, ctx, words);
  const line = (parts) => {
    for (const part of parts.join(" ").split(BREAK)) {
      const text = part.replace(/\s+/g, " ").trim();
      if (text) ctx.lines.push(text);
    }
  };
  const entries = (range) => (range && objectEntries(toks, range)) || [];
  if (name === "h" || name === "link") {
    if (name === "link") take(list[1]);
    else {
      // h(tag, props, ...children): a second argument that is not props is its first child, from site.js 1.7.0 on
      if (list[1] && propsLike(toks, list[1])) {
        for (const entry of entries(list[1])) if (entry.key === "text") take([entry.s, entry.e]);
      } else if (list[1] && ctx.childArg) take(list[1]);
      else if (list[1]) drop(toks, list[1], ctx);
      list.slice(2).forEach(take);
    }
    const tag = name === "link" ? "a" : tagOf(toks, list[0]);
    if (tag === "br") return { end, text: nested ? BREAK : "" };
    if (nested && !BLOCK.has(tag)) return { end, text: words.join(" ") };
    line(words);
  } else if (name === "head") {
    for (const entry of entries(list[0])) {
      if (!["title", "lede", "basis"].includes(entry.key)) continue;
      const parts = [];
      collect(toks, [entry.s, entry.e], ctx, parts);
      line(parts);
    }
  } else if (name === "notes") {
    // a line per thing still to confirm, and per source
    for (const range of list) {
      const parts = [];
      collect(toks, range, ctx, parts);
      for (const part of parts) line([part]);
    }
  } else {
    // notice(tone, text, action) and empty(text, action, hint): one block, its action on its line
    (name === "notice" ? list.slice(1) : list).forEach(take);
    line(words);
  }
  return { end, text: "" };
}

/** A "[" after this token is an index (a[0], f()[0]), not a list. */
function indexes(prev) {
  return !!prev && (prev.t === "str" || prev.t === "num" || (prev.t === "id" && !BEFORE_VALUE.has(prev.v)) || is(prev, ")") || is(prev, "]"));
}

/** A "{" after this token starts an object, not a block. */
function startsObject(prev) {
  if (!prev) return false;
  if (prev.t === "id") return BEFORE_VALUE.has(prev.v);
  return prev.t === "p" && ![")", "]", "}", "{", ";", "=>"].includes(prev.v);
}

/** The strings outside the helper calls (`skip`: where each starts → where it ends): `data`, a value in the script's
 *  own lists and objects, read as a data file's are; `other`, the rest. `lists`: the keys and names whose values list
 *  what the page could not show ("missing"), which are no text it shows. */
function readRest(toks, skip, lists) {
  const data = [];
  const other = [];
  const listsNothing = (name) => typeof name === "string" && lists.has(name.toLowerCase());
  const noText = (frame) => frame.kind === "object" && frame.key != null && (NO_TEXT_KEY.test(frame.key) || listsNothing(frame.key));
  const stack = [{ kind: "block", key: null, skip: false }];
  for (let k = 0; k < toks.length; k += 1) {
    if (skip.has(k)) {
      k = skip.get(k) - 1;
      continue;
    }
    const t = toks[k];
    const prev = toks[k - 1];
    const top = stack.at(-1);
    if (t.t === "str") {
      if (top.skip || !t.v.trim()) continue;
      if (top.kind === "object" && is(toks[k + 1], ":") && (is(prev, "{") || is(prev, ","))) other.push(t.v);
      else if (!noText(top)) (top.kind === "list" || top.kind === "object" ? data : other).push(t.v);
    } else if (is(t, "(") || is(t, "[") || is(t, "{")) {
      const kind = t.v === "(" ? "call" : t.v === "[" ? (indexes(prev) ? "index" : "list") : startsObject(prev) ? "object" : "block";
      const named = is(prev, "=") && isId(toks[k - 2]) && listsNothing(toks[k - 2].v);
      stack.push({ kind, key: null, skip: top.skip || noText(top) || named });
    } else if (is(t, ")") || is(t, "]") || is(t, "}")) {
      if (stack.length > 1) stack.pop();
    } else if (is(t, ",") && top.kind === "object") top.key = null;
    else if (is(t, ":") && top.kind === "object" && (prev?.t === "id" || prev?.t === "str") && (is(toks[k - 2], "{") || is(toks[k - 2], ","))) {
      top.key = prev.v;
    }
  }
  return { data, other };
}

/** Whether the script fetches text from another site while the page runs: fetch, EventSource or WebSocket given that
 *  site's address (https://…, //…). */
function loadsElsewhere(toks) {
  for (let i = 0; i < toks.length; i += 1) {
    if (!isId(toks[i]) || !FETCHES.has(toks[i].v) || !is(toks[i + 1], "(")) continue;
    if (is(toks[i - 1], ".") && !(isId(toks[i - 2]) && GLOBALS.has(toks[i - 2].v))) continue;
    if (toks[i + 2]?.t === "str" && /^\s*(?:(?:https?|wss?):)?\/\//i.test(toks[i + 2].v)) return true;
  }
  return false;
}

/** What a script shows: { lines, data, other, loads } (the top of this file). `childArg`: site.h takes a second
 *  argument that is not its props as its first child (site.js 1.7.0 and later; an older copy draws nothing for it).
 *  `lists`: the keys and names whose values list what the page could not show. */
export function readScript(source, { childArg = true, lists = new Set() } = {}) {
  const toks = tokens(String(source ?? ""));
  const ctx = { names: helperNames(toks), childArg, lines: [], consumed: new Set() };
  // the calls read on their own (not as another element's child), outermost first: what the rest of the script is
  const skip = new Map();
  let outer = 0;
  for (let i = 0; i < toks.length; i += 1) {
    if (ctx.consumed.has(i)) continue;
    const call = helperCall(toks, i, ctx.names);
    if (!call) continue;
    const { end } = readCall(toks, call, ctx);
    if (i >= outer) {
      skip.set(i, end);
      outer = end;
    }
  }
  return { lines: ctx.lines, ...readRest(toks, skip, lists), loads: loadsElsewhere(toks) };
}
