/* site.js: shared helpers for Instafy starter pages. Plain script, no build step, no dependencies.
 * Copied into the site with theme.css by `instafy bind init <dir> --starter <name>`. Keep it; edit it only on request.
 *
 *   site.start({ data: "data.json", state: (data) => ({ sort: "price", open: "" }), render(data, state) {…},
 *                select(ref, data) { return { open: site.slug(ref) }; } });
 *
 * - Query state: site.state(defaults), site.setState(patch) (history.replaceState, then render), site.onState(fn).
 *   Only the keys in `state` go in the query, so Studio's Present / Follow and shared links show the same view.
 * - Rows: give each row id="row-<slug>" and data-ref="<kind>:<slug>" (site.rowAttrs(ref)). A "select" command from
 *   chat scrolls to the row and marks it; "highlight" fades the rows it names. "toast" and "reload" are the client's.
 * - Facts: one shape everywhere, {"v": "8.9 oz", "src": "Maker", "url": "https://…", "date": "2026-10-17", "est": false}.
 *   "url" is the page it was read on and "date" the day it was read; each value cites them: "checked 17 Oct on
 *   maker.com ↗" (a price: "seen 17 Oct on shop.com ↗"). Optional "asof": the source's own date, shown in place of
 *   "date" ("seen 5 Aug on …"); a price with an "asof" over 30 days old is muted and says "may have changed", like a
 *   live price past its time. A value that only says nothing is known ("—", "n/a", "?", "unknown") is no value.
 *   site.trust(fact | record, opts) draws the one trust line: "checked 17 Oct on maker.com ↗", "at Store ↗ · checked
 *   4 min ago", "Estimate", "Price not checked" (nobody checked it), "Not listed · checked 16 Oct on maker.com ↗" (a
 *   fact with a source and no value: the source was read and does not give it); in a table of options a value nobody
 *   found reads opts.unknown, "Unknown · why" ("Price unknown"). A price fact with "list": true is that source's
 *   list price, never a store's price now: "$900 · list price on BabyGearLab ↗ · seen 5 Aug".
 * - Filters: site.within(value, filter) is "in", "out" or "unknown" for the page's one filter ({key, max, min}), and
 *   site.byFilter(rows, filter, valueOf) splits rows into {in, unknown, out}. Only a value the page shows counts: a
 *   row without one is never "under $140"; the starters list it apart ("Price unknown").
 * - Live checks: site.checkAll(rows) is the page's one primary button ("Check all prices", with two or more checkable
 *   rows). trust(value, {ref, intent, store, seed}) ends a row's caption in its one quiet action: "Check price" (only
 *   without "Check all prices"), "Try again" after an error, "Open store ↗" when the store can't be read. While a
 *   check runs the value keeps its caption and adds "Checking…"; a failed check says "Couldn't check · why · Try again"
 *   once. site.priceNotice(rows) says once why stores can't be read. "Check all prices" goes away while every price it
 *   would check is fresh, or is left only with failed rows (each has its own "Try again").
 * - Links: a source in a caption is a quiet citation (muted, a faint underline); an action ("Open Amazon ↗",
 *   "where to check ↗", "Try again") is in the link colour.
 * - Safety: every text goes through textContent; site.link() only links https: URLs.
 * SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  "use strict";

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var ESTIMATE_BASIS = ["estimated", "modelled", "inferred"];
  var ICONS = {
    check: ["M5 13l4 4L19 7"],
    info: ["M12 11.5v5", "M12 7.51l.01-.011", "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"],
    warning: ["M12 9v4", "M12 17.01l.01-.011", "M10.24 3.957 2.51 17.5A2 2 0 0 0 4.27 20.5h15.46a2 2 0 0 0 1.76-3L13.76 3.957a2 2 0 0 0-3.52 0z"],
    error: ["M12 7v6", "M12 16.51l.01-.011", "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"],
    chevron: ["M9 6l6 6-6 6"]
  };

  function bind() { return window.instafyBind || null; }

  // ---------- DOM ----------
  /** h("li", {class, id, text, attrs: {...}, on: {click}}, ...children). Strings become text nodes; null is skipped. */
  function h(tag, props) {
    var el = document.createElement(tag);
    props = props || {};
    if (props["class"]) el.className = props["class"];
    if (props.id) el.id = props.id;
    if (props.text != null) el.textContent = String(props.text);
    var attrs = props.attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      el.setAttribute(k, v === true ? "" : String(v));
    });
    var on = props.on || {};
    Object.keys(on).forEach(function (k) { el.addEventListener(k, on[k]); });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  /** Append children to el, skipping null and false (site.rowAction returns null when a row has no action). */
  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  function icon(name, cls) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    });
    return svg;
  }
  /** An https link that opens in a new tab and ends in " ↗"; anything else is plain text. */
  function safeUrl(url) {
    try { var u = new URL(String(url)); return u.protocol === "https:" ? u.href : null; } catch (e) { return null; }
  }
  function link(url, text, cls) {
    var href = safeUrl(url);
    if (!href) return h("span", { "class": cls || null, text: text });
    // the ↗ never wraps away from its words (the space before it sits in a no-wrap span)
    return h("a", { "class": cls || null, attrs: { href: href, target: "_blank", rel: "noopener noreferrer" } }, String(text), h("span", { "class": "arr", text: " ↗" }));
  }
  /** "babygearlab.com" for a link, "" for anything else. */
  function host(url) {
    var href = safeUrl(url);
    return href ? new URL(href).hostname.replace(/^www\./, "") : "";
  }
  function slug(text) {
    var s = String(text == null ? "" : text);
    if (s.indexOf(":") >= 0) s = s.slice(s.indexOf(":") + 1);
    return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
  }
  /** id and data-ref for a row: rowAttrs("option:a") → {id: "row-a", "data-ref": "option:a"}. */
  function rowAttrs(ref, prefix) {
    return { id: (prefix || "row") + "-" + slug(ref), "data-ref": ref };
  }

  // ---------- dates and values ----------
  function parseDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var t = Date.parse(iso);
    return isFinite(t) ? new Date(t) : null;
  }
  /** "17 Oct" (the year only when it is not this year). */
  function date(iso) {
    var d = parseDate(iso);
    if (!d) return "";
    var text = d.getDate() + " " + MONTHS[d.getMonth()];
    return d.getFullYear() === new Date().getFullYear() ? text : text + " " + d.getFullYear();
  }
  /** "Sat 24 Oct". */
  function dayDate(iso) {
    var d = parseDate(iso);
    return d ? DAYS[d.getDay()] + " " + date(iso) : "";
  }
  function ago(iso) {
    var t = Date.parse(iso || "");
    if (!isFinite(t)) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return date(new Date(t).toISOString());
  }
  function money(price) {
    if (!price || typeof price.amount !== "number") return "";
    var cur = String(price.currency || "").toUpperCase();
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency: cur || "USD", maximumFractionDigits: price.amount % 1 ? 2 : 0 }).format(price.amount);
    } catch (e) {
      return (cur ? cur + " " : "") + price.amount;
    }
  }
  function isRecord(x) { return !!(x && typeof x === "object" && x.prov && x.type); }
  /** A value that only says nothing is known: blank, dashes, "?", "n/a", "unknown", "TBD". */
  var NO_VALUE = /^(?:[\s\-\u2010-\u2015?.\u00b7\u2026/]*|n\s*\/\s*a|unknown|tb[ad])$/i;
  /** The text of a fact or record value ("" when there is none, or it only says nothing is known: a dash in a table
   * is never drawn as if it were a value). */
  function valueText(x) {
    if (!x) return "";
    var text;
    if (isRecord(x)) {
      if (x.type === "offer") return money(x.price);
      if (x.value === true) return "Yes";
      if (x.value === false) return "No";
      text = x.value == null ? "" : String(x.value);
    } else {
      text = x.v == null ? "" : String(x.v);
    }
    return NO_VALUE.test(text.trim()) ? "" : text;
  }
  /** The first number in a text, read the way shops write it: a ".", ",", space or "'" before exactly three digits
   * groups thousands ("1.299", "1 299", "1'299", "1,299" are 1299), and the last "." or "," is the decimal mark
   * otherwise ("1.299,00" and "1,299.00" are 1299, "549,99" is 549.99, "4.6" is 4.6, "0.125" is 0.125). */
  function numberIn(text) {
    var m = /(-?)(\d+)((?:[.,'’    ]\d+)*)/.exec(String(text == null ? "" : text));
    if (!m) return null;
    var head = m[2];
    var parts = m[3] ? m[3].match(/[.,'’    ]\d+/g) : [];
    var mark = function (p) { return p.charAt(0); };
    var dec = -1;
    parts.forEach(function (p, i) { if (mark(p) === "." || mark(p) === ",") dec = i; });
    // the last "." or "," groups thousands when three digits follow it, one to three (not just 0) lead, and no other
    // kind of decimal mark comes before it: "1.299", "1,299,000"
    if (dec >= 0 && parts[dec].length === 4 && head.length <= 3 && head !== "0" &&
      parts.slice(0, dec).every(function (p) { return (mark(p) !== "." && mark(p) !== ",") || mark(p) === mark(parts[dec]); })) dec = -1;
    var whole = head;
    var end = dec >= 0 ? dec : parts.length;
    for (var i = 0; i < end; i++) {
      // a mark that does not group thousands ends the number: "2 3-year plans" is 2
      if (head.length > 3 || parts[i].length !== 4) return Number(m[1] + whole);
      whole += parts[i].slice(1);
    }
    return Number(m[1] + whole + (dec >= 0 ? "." + parts[dec].slice(1) : ""));
  }
  /** A number to sort by: fact.n, an offer's amount, else the first number in the value text (numberIn). */
  function num(x) {
    if (!x) return null;
    if (isRecord(x) && x.type === "offer") return x.price && typeof x.price.amount === "number" ? x.price.amount : null;
    if (typeof x.n === "number") return x.n;
    return numberIn(valueText(x));
  }
  /** The number of a value the page shows, else null. A value counts only when its trust line draws it: a live value,
   * an estimate, or a fact with its source. An unsourced fact (drawn "Not checked"), a check that could not read it,
   * and a dash are unknown, so no filter or sort counts them. */
  function known(x) {
    if (!x) return null;
    if (isRecord(x)) {
      if (x.type === "claim" && (x.status === "uncertain" || x.status === "not_found" || x.status === "error")) return null;
      return valueText(x) ? num(x) : null;
    }
    if (!valueText(x) || !(x.src || x.est)) return null;
    return num(x);
  }
  /** Where a value stands against the page's one filter ({key, max?, min?}): "in", "out", or "unknown" when the page
   * has no number for it. Unknown is never "in": a row without a price is not "under $140". */
  function within(x, filter) {
    if (!filter) return "in";
    var n = known(x);
    if (n == null) return "unknown";
    var max = filter.max == null || filter.max === "" ? null : Number(filter.max);
    var min = filter.min == null || filter.min === "" ? null : Number(filter.min);
    return (max == null || n <= max) && (min == null || n >= min) ? "in" : "out";
  }
  /** Rows split by the page's one filter, each part in the rows' own order: {in, unknown, out}. Without a filter every
   * row is "in". valueOf(row) gives the row's value for the filter's key. */
  function byFilter(rows, filter, valueOf) {
    var parts = { "in": [], unknown: [], out: [] };
    (rows || []).forEach(function (r) { parts[within(filter ? valueOf(r) : null, filter)].push(r); });
    return parts;
  }

  // ---------- live values ----------
  function expired(r) {
    var b = bind();
    if (b && b.expired) return b.expired(r);
    var ttl = r && r.prov && r.prov.ttl_s;
    return typeof ttl === "number" && ttl > 0 && Date.parse(r.prov.observed_at) + ttl * 1000 < Date.now();
  }
  var OLD_SEED_MS = 30 * 86400000;
  /** A value that may have changed: a live record past its time, or a price whose source dates it ("asof") over 30
   * days ago (a review's list price from August is not today's price). */
  function isOld(x, price) {
    if (!x) return false;
    if (isRecord(x)) return expired(x);
    if (!price || !x.asof) return false;
    var d = parseDate(x.asof);
    return !!d && Date.now() - d.getTime() > OLD_SEED_MS;
  }
  /** "seen 17 Oct": the source's own date when it gives one, else the day it was read. */
  function seenText(x) {
    var when = x && (x.asof || x.date);
    return when && date(when) ? "seen " + date(when) : "";
  }
  /** Where and when a value was read, as one caption part: "checked 17 Oct on maker.com ↗" (the host links the page it
   * was read on). A price, or a date the source gives ("asof"), is "seen": "seen 5 Aug on reviews.example ↗", never
   * "checked", so it does not read as today's price. Without a page link it names the source: "Maker · checked 17
   * Oct". o.price: the value is a price. */
  function citeParts(x, o) {
    o = o || {};
    if (!x) return [];
    var when = x.asof || x.date;
    var day = when && date(when) ? ((o.price || x.asof ? "seen " : "checked ") + date(when)) : "";
    var site = host(x.url);
    if (site) return [h("span", { "class": "cite" }, day ? day + " on " : "", link(x.url, site))];
    var out = [];
    if (x.src) out.push(String(x.src));
    if (day) out.push(h("span", { "class": "age", text: day }));
    return out;
  }
  /** cite() as one inline piece, for a line under a list ("Weight: checked 17 Oct on maker.com ↗"). */
  function cite(x, o) {
    var parts = citeParts(x, o);
    if (!parts.length) return null;
    var el = h("span", null);
    parts.forEach(function (p, i) { if (i) el.appendChild(document.createTextNode(" · ")); append(el, p); });
    return el;
  }
  function newest(list) {
    return list.slice().sort(function (a, b) { return (Date.parse(b.prov.observed_at) || 0) - (Date.parse(a.prov.observed_at) || 0); })[0] || null;
  }
  /** The newest live record for a row: an offer with a price for "price", else the claim with that attr. */
  function live(ref, attr) {
    var b = bind();
    if (!b || !ref) return null;
    var all = b.records(ref) || [];
    var list = all.filter(function (r) {
      if (attr === "price" && r.type === "offer") return r.price && typeof r.price.amount === "number";
      return r.type === "claim" && r.attr === attr;
    });
    return newest(list);
  }

  // ---------- the trust line ----------
  var checks = { errors: new Map(), mine: new Map(), intents: {}, allShown: false, noticed: {} };
  /** Only the checks drawn with trust({action}) / checkAll report errors on their rows. */
  function isCheck(m) { return !m.name || !!checks.intents[m.name]; }
  function capital(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  /** A note that only repeats the state ("not checked yet") says nothing. */
  function usefulNote(note) {
    var n = String(note || "").trim();
    return n && !/^not (checked|verified)( yet)?\.?$/i.test(n) ? n.slice(0, 100) : "";
  }
  /** The newest live price for a row is a "could not read it" answer (a blocked or unreadable store). */
  function blockedRecord(ref) {
    var b = bind();
    if (!b || !ref) return null;
    var list = (b.records(ref) || []).filter(function (r) {
      return (r.type === "offer" && r.price && typeof r.price.amount === "number") || (r.type === "claim" && r.attr === "price");
    });
    var top = newest(list);
    return top && top.type === "claim" && top.status !== "error" && (top.status === "uncertain" || top.status === "not_found" || top.value == null) ? top : null;
  }
  function names() { var b = bind(); return b ? (b.names || []) : []; }
  /** This row can be checked here: the binder runs the intent, the seed says the store is readable, and the last check
   * did not find it blocked. */
  function canCheck(intent, store, ref) {
    return names().indexOf(intent) >= 0 && !!(store && store.readable) && !(ref && blockedRecord(ref));
  }

  /**
   * The one trust line for a fact or a live record: the value, then a quiet caption.
   *   value · checked 17 Oct on maker.com ↗    (a seed fact: the page it was read on and the day; "seen 5 Aug on …"
   *                                            for a price or the source's own date)
   *   value at Store ↗ · checked 4 min ago     (a live check; " · may have changed" once it is old)
   *   value · Estimate · how ↗
   *   Price not checked · reason · where to check ↗
   * opts: label ("Price": says what was not checked), unknown (the word for a missing value: "Unknown" in a table of
   * options, "To confirm" on a checklist), price (a price: "at <store>"), shared (the source is said once for the
   * whole column: value only), and for a row that can be checked live: ref, intent, store, params. Then the
   * caption ends in the row's one action: "Check price" (only when there is no "Check all prices"), "Try again" after
   * an error, "Open store ↗" when the store can't be read. While a check runs the value stays and the caption says
   * "Checking…".
   */
  function trust(x, opts) {
    opts = opts || {};
    var b = bind();
    var el = h("span", { "class": "trust" });
    var meta = [];
    var add = function (part) { if (part) meta.push(part); };
    var live = opts.ref && opts.intent;
    if (live) checks.intents[opts.intent] = true;
    var pending = !!(live && b && b.isPending && b.isPending(opts.ref, opts.intent));
    var blocked = live ? blockedRecord(opts.ref) : null;
    var seed = opts.seed || null;
    // a blocked check keeps the seed value it had (the reason is said once, under the list or on this row)
    if (blocked && isRecord(x) && x.type === "claim" && x.attr === blocked.attr && x.prov.observed_at === blocked.prov.observed_at) x = seed;
    var value = valueText(x);
    // "Not checked" has one meaning on every page: nobody checked it. A checklist says "To confirm" (opts.unknown),
    // because there "checked" is the tick.
    // A table of options says "Unknown" ("Price unknown") for a value nobody found, then why; "Not listed" when the
    // page that was read does not give it.
    var word = opts.unknown || "Not checked";
    var notChecked = function (note, url) {
      add((opts.label ? opts.label + " " + word.toLowerCase() : word) + (usefulNote(note) ? " · " + usefulNote(note) : ""));
      if (safeUrl(url)) add(link(url, "where to check", "act"));
    };
    // looked for and not there: the source was read and does not give it ("Not listed · checked 16 Oct on maker.com
    // ↗"); the link to the page that was read stays even when the source is named once for the column (then without
    // the date)
    var notListed = function (note, src, url, fact) {
      add((opts.label ? opts.label + " not listed" : "Not listed") + (usefulNote(note) ? " · " + usefulNote(note) : ""));
      if (fact && !opts.shared) citeParts(fact, { price: opts.price }).forEach(add);
      else if (safeUrl(url)) add(link(url, host(url) || src));
      else if (src) add(src);
    };
    var failed = live && !pending && checks.errors.has(opts.ref);

    if (isRecord(x)) {
      var src = (x.seller && x.seller.name) || x.prov.source_label || x.prov.source || "";
      var url = (x.handoff && x.handoff.url) || x.prov.url;
      if (x.type === "claim" && x.status === "not_found") {
        value = "";
        notListed(x.note, x.prov.source_label || x.prov.source || "", x.prov.url, null);
      } else if (x.type === "claim" && (x.status === "uncertain" || x.value == null)) {
        value = "";
        notChecked(x.note);
      } else if (x.type === "claim" && x.status === "error") {
        value = "";
        add(h("span", null, icon("error"), "Couldn't check" + (usefulNote(x.note) ? " · " + usefulNote(x.note) : "")));
      } else if (!value) {
        // a record whose value only says nothing is known ("—") is unknown, never a caption without a value
        notChecked(x.note);
      } else if (ESTIMATE_BASIS.indexOf(x.basis) >= 0) {
        add("Estimate");
        if (safeUrl(url)) add(link(url, "how"));
      } else {
        add(src ? (opts.price || x.type === "offer" ? h("span", null, "at ", link(url, src)) : link(url, src)) : null);
        add(h("span", { "class": "age", text: "checked " + ago(x.prov.observed_at) }));
      }
      if (expired(x) && value) { el.classList.add("is-old"); add("may have changed"); }
    } else if (x && x.est && value) {
      // an estimate names its basis: a source to check it against ("Estimate · Taiwan Railway ↗") or how ↗
      add("Estimate");
      if (x.src) add(link(x.url, x.src)); else if (safeUrl(x.url)) add(link(x.url, "how"));
    } else if (x && x.src && value) {
      var seedOld = isOld(x, opts.price);
      if (seedOld) el.classList.add("is-old");
      var atStore = opts.price && opts.store && opts.store.name && String(opts.store.name).toLowerCase() === String(x.src).toLowerCase();
      // a list price ("list": true, a review site's "List price $900") says so on the row itself, even when one line
      // under the list names the source: next to "Open Amazon ↗" a bare "$900" reads as Amazon's price today
      var list = opts.price && !atStore && x.list;
      if (!opts.shared) {
        if (atStore || list) {
          add(atStore ? h("span", null, "at ", link(x.url, x.src)) : h("span", null, "list price on ", link(x.url, x.src)));
          var when = seenText(x);
          if (when) add(h("span", { "class": "age", text: when }));
        } else {
          // every value cites the page it was read on and the day: "checked 17 Oct on maker.com ↗"
          citeParts(x, { price: opts.price }).forEach(add);
        }
        if (seedOld) add("may have changed");
      } else if (list) {
        add("list price");
      }
    } else if (x && x.src && !value) {
      notListed(x.note, x.src, x.url, x);
    } else {
      value = "";
      // a check that failed says so once ("Couldn't check · reason · Try again"), not under "Not checked" as well
      if (!failed && !pending) notChecked(x && x.note, x && x.url);
    }

    // While a check runs the value keeps its caption (an old price stays muted and says "may have changed") and the
    // caption ends in "Checking…"; with no value there is only "Checking…".
    if (pending) {
      if (!value) meta.length = 0;
      add("Checking…");
    }

    // the row's one action, at the end of the caption
    var action = null;
    if (live && !pending && !failed) {
      if (blocked && !checks.noticed[blocked.note || ""] && usefulNote(blocked.note)) add(usefulNote(blocked.note));
      // opts.label says what was not checked ("Price"); the action keeps its own words ("Check price")
      action = rowAction(Object.assign({}, opts, { label: null }));
      add(action);
    }

    if (value) el.appendChild(h("span", { "class": "v", text: value }));
    if (meta.length) el.appendChild(caption(meta, action, !!value));
    if (failed) {
      var again = canCheck(opts.intent, opts.store, opts.ref) ? retry(opts) : null;
      var why = [h("span", null, icon("error"), "Couldn't check"), checks.errors.get(opts.ref)];
      if (again) why.push(again);
      // with no value the failure is the whole caption, on the value's line; under a value it is a line of its own
      var err = caption(why, again, false);
      err.classList.add("err");
      el.appendChild(err);
    }
    return el;
  }
  /**
   * A caption: its parts joined by " · ". The first " · " sits in .lead, which the table and fact grids hide when
   * they put the caption on its own line. A short part keeps its " · " with it, and the line may break before a dot;
   * site.js then checks the drawn lines (tidyCaptions): a part that starts a new line takes that line without its
   * dot, so no line starts or ends in a dot. The row's action ("Open Amazon ↗", "Try again") is marked .is-act: in a
   * narrow cell (table, fact grid, a phone row's sorted value) it takes its own line, without a dot in front.
   */
  function caption(parts, action, lead) {
    var m = h("span", { "class": "meta" });
    if (lead) m.appendChild(h("span", { "class": "lead", text: " · " }));
    parts.forEach(function (part, i) {
      var p = h("span", { "class": "part" }, part);
      if (i === 0) { m.appendChild(p); return; }
      var short = String(p.textContent || "").length <= 28;
      var act = part === action;
      if (short) m.appendChild(document.createElement("wbr"));
      m.appendChild(h("span", { "class": "sp" + (short ? " keep" : "") + (act ? " is-act" : "") }, h("span", { "class": "dot", text: " · " }), p));
    });
    return m;
  }
  /** The top of the first and last drawn line of an element (null when it is not drawn). */
  function lines(el) {
    var r = el && el.getClientRects ? el.getClientRects() : [];
    var tops = [];
    for (var i = 0; i < r.length; i++) if (r[i].width > 0 || r[i].height > 0) tops.push(r[i].top);
    return tops.length ? { first: tops[0], last: tops[tops.length - 1] } : null;
  }
  /** No caption line starts or ends in a dot: a part the line wrapped before (or right after its dot) goes on a line
   * of its own without the dot, and a caption that starts under its value drops its first dot. Runs after each render
   * and when the page width changes. */
  function tidyCaptions() {
    var metas = document.querySelectorAll(".trust .meta");
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      m.classList.remove("is-wrap");
      var wrapped = m.querySelectorAll(".sp.is-wrap");
      for (var j = 0; j < wrapped.length; j++) wrapped[j].classList.remove("is-wrap");
    }
    for (var k = 0; k < metas.length; k++) {
      var meta = metas[k];
      var lead = meta.querySelector(":scope > .lead");
      var leadAt = lines(lead);
      var first = meta.querySelector(":scope > .part");
      if (leadAt) {
        var v = lines(meta.previousElementSibling);
        var f = lines(first);
        if ((v && leadAt.first > v.last + 4) || (f && f.first > leadAt.last + 4)) meta.classList.add("is-wrap");
      }
      var prev = first;
      var sps = meta.querySelectorAll(":scope > .sp");
      for (var n = 0; n < sps.length; n++) {
        var sp = sps[n];
        var dot = lines(sp.firstChild);
        var before = lines(prev);
        var part = lines(sp.lastChild);
        if (dot && ((before && dot.first > before.last + 4) || (part && part.first > dot.last + 4))) sp.classList.add("is-wrap");
        prev = sp.lastChild;
      }
    }
  }
  var tidyQueued = false;
  function tidySoon() {
    if (tidyQueued) return;
    tidyQueued = true;
    (window.requestAnimationFrame || setTimeout)(function () { tidyQueued = false; tidyCaptions(); });
  }

  // ---------- live checks ----------
  function reasonText(code, reason) {
    if (code === "cooldown") return "checked a moment ago, try again soon";
    if (code === "rate" || code === "busy") return "too many checks, try again in a minute";
    if (code === "offline" || /No binder|No host/.test(reason || "")) return "not connected";
    if (code === "timeout") return "it took too long";
    return String(reason || "it did not work").replace(/\s+/g, " ").slice(0, 100);
  }
  function send(intent, params, ref) {
    var b = bind();
    if (!b) return;
    checks.errors.delete(ref);
    try {
      var id = b.intent(intent, params, { ref: ref, ui: "row" });
      checks.mine.set(id, ref);
    } catch (e) {
      checks.errors.set(ref, "not available here");
    }
    schedule();
  }
  function actionButton(o, label, key) {
    var b = bind();
    var intent = o.intent || "read_offer";
    return h("button", {
      "class": "link-btn",
      text: label,
      attrs: { type: "button", "data-key": key + ":" + o.ref },
      on: { click: function () { if (!b.isPending(o.ref, intent)) send(intent, o.params || { ref: o.ref }, o.ref); } }
    });
  }
  function retry(o) { return actionButton(o, "Try again", "retry"); }
  /**
   * A row's one action (null when it has none): "Check price" when this row can be checked and the page has no
   * "Check all prices"; "Open <store> ↗" ("Open Amazon ↗") when the store can't be read here (blocked, not readable,
   * or no binder).
   * trust() puts it at the end of the row's caption; call it yourself only for a row without a trust line.
   */
  function rowAction(o) {
    o = o || {};
    var intent = o.intent || "read_offer";
    checks.intents[intent] = true;
    var b = bind();
    if (b && b.isPending && b.isPending(o.ref, intent)) return null;
    if (canCheck(intent, o.store, o.ref)) return checks.allShown ? null : actionButton(o, o.label || "Check price", "check");
    if (o.store && safeUrl(o.store.url) && (!b || readyDone)) return link(o.store.url, "Open " + (o.store.name || "store"), "act");
    return null;
  }
  /** Kept for pages written against site.js 1.0: the same as rowAction. */
  function checkButton(o) { return rowAction(o); }
  /**
   * The page's one primary button: checks every row that can be checked. Shown only when two or more can be; then rows
   * have no "Check price" of their own. It goes away while every one of those rows has a fresh live price (it comes
   * back once one may have changed). Call it before drawing the rows.
   */
  function checkAll(rows, o) {
    o = o || {};
    var intent = o.intent || "read_offer";
    var b = bind();
    checks.intents[intent] = true;
    var ok = (rows || []).filter(function (r) { return canCheck(intent, r.store, r.ref); });
    var busy = ok.some(function (r) { return b.isPending(r.ref, intent); });
    checks.allShown = ok.length >= 2 || (busy && checks.allShown);
    if (!checks.allShown) return null;
    var isFresh = function (r) { var x = live(r.ref, o.attr || "price"); return !!x && !expired(x) && !checks.errors.has(r.ref); };
    if (!busy && ok.every(isFresh)) return null;
    // a press checks only what is not fresh: a price checked a minute ago is not asked again (and never shows a
    // "checked a moment ago" error on a row that is fine)
    var todo = ok.filter(function (r) { return !isFresh(r); });
    // what is left are checks that failed: each row says why and has its own "Try again", so no second way to retry
    if (!busy && todo.every(function (r) { return checks.errors.has(r.ref); })) return null;
    return h("button", {
      "class": "btn primary",
      text: busy ? "Checking…" : (o.label || "Check all prices"),
      attrs: { type: "button", "data-key": "check-all", "aria-busy": busy ? "true" : false },
      on: { click: function () {
        todo.forEach(function (r) { if (!b.isPending(r.ref, intent)) send(intent, r.params || { ref: r.ref }, r.ref); });
      } }
    });
  }
  /** Any row's live check still running (rows keep their order until every check has finished). */
  function anyPending(rows, intent) {
    var b = bind();
    if (!b || !b.isPending) return false;
    return (rows || []).some(function (r) { return b.isPending(r.ref, intent || "read_offer"); });
  }
  /**
   * One neutral notice under the list when stores can't be read, so the reason is said once and not on every row.
   * A reason shared by two or more rows goes here; a reason only one row has stays on that row. Call it before the
   * rows and append what it returns after them.
   */
  function priceNotice(rows, o) {
    o = o || {};
    checks.noticed = {};
    var priced = (rows || []).filter(function (r) { return r.store; });
    if (!priced.length) return null;
    var by = {};
    priced.forEach(function (r) {
      var rec = blockedRecord(r.ref);
      if (rec && usefulNote(rec.note)) (by[rec.note] = by[rec.note] || []).push(r.ref);
    });
    var shared = Object.keys(by).filter(function (k) { return by[k].length >= 2; });
    shared.forEach(function (k) { checks.noticed[k] = true; });
    var seedBlocked = priced.every(function (r) { return !(r.store && r.store.readable); });
    var tail = " Open a store to see today's price.";
    if (shared.length === 1) return notice("info", capital(usefulNote(shared[0])) + "." + tail);
    if (shared.length > 1) return notice("info", "Some stores can't be checked automatically." + tail);
    if (seedBlocked) return notice("info", "These stores don't allow price checks from this page." + tail);
    return null;
  }

  /** Every priced row's store refuses checks from the start ("readable": false): the page offers no check at all. */
  function storesBlocked(rows) {
    var priced = (rows || []).filter(function (r) { return r.store; });
    return priced.length > 0 && priced.every(function (r) { return !(r.store && r.store.readable); });
  }

  // ---------- query state ----------
  var defaults = {};
  var renderers = [];
  function state(defs) {
    if (defs) defaults = Object.assign({}, defs);
    var q = new URLSearchParams(location.search);
    var out = {};
    Object.keys(defaults).forEach(function (k) {
      var v = q.get(k);
      out[k] = v == null ? defaults[k] : v;
    });
    return out;
  }
  function setState(next) {
    var q = new URLSearchParams(location.search);
    var cur = state();
    Object.keys(next || {}).forEach(function (k) {
      if (!(k in defaults)) return;
      cur[k] = next[k] == null ? defaults[k] : String(next[k]);
    });
    Object.keys(defaults).forEach(function (k) {
      if (cur[k] === "" + defaults[k] || cur[k] === defaults[k]) q.delete(k);
      else q.set(k, cur[k]);
    });
    var search = q.toString();
    try { history.replaceState(history.state, "", location.pathname + (search ? "?" + search : "") + location.hash); } catch (e) { /* sandboxed */ }
    render();
  }
  function onState(fn) { renderers.push(fn); render(); }

  // ---------- rendering, guarded ----------
  var queued = false;
  var failedPage = false;
  var selectedRef = null;
  function schedule() {
    if (queued) return;
    queued = true;
    Promise.resolve().then(function () { queued = false; render(); });
  }
  function render() {
    if (failedPage) return;
    var active = document.activeElement;
    var key = active && active.getAttribute && (active.getAttribute("data-key") || (active.id ? "#" + active.id : null));
    try {
      renderers.forEach(function (fn) { fn(); });
    } catch (e) {
      console.error("[site] render failed", e);
      return fail();
    }
    markSelected();
    syncThemeColor();
    tidySoon();
    if (key && document.activeElement !== active) {
      var again = key.charAt(0) === "#" ? document.getElementById(key.slice(1)) : document.querySelector('[data-key="' + cssEscape(key) + '"]');
      if (again && again.focus) again.focus({ preventScroll: true });
    }
  }
  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
  function fail() {
    failedPage = true;
    var main = document.querySelector("main") || document.body;
    // the page keeps its title (the person still sees which page this is), and Reload looks like a button
    var top = main.querySelector(".head");
    main.replaceChildren();
    if (top) main.appendChild(top);
    main.appendChild(notice("error", "This page couldn't load its data. Reload to try again.",
      h("button", { "class": "btn", text: "Reload", attrs: { type: "button" }, on: { click: function () { location.reload(); } } })));
  }
  function notice(tone, text, action) {
    return h("div", { "class": "notice" + (tone === "error" ? " is-error" : tone === "warn" ? " is-warn" : ""), attrs: { role: tone === "error" ? "alert" : null } },
      icon(tone === "error" ? "error" : tone === "warn" ? "warning" : "info"), h("p", { "class": "notice-text", text: text }), action || null);
  }
  /** An empty list: "No options yet." plus, only in Studio (where the owner can ask), a hint such as "Ask in chat to add
   * some." A friend who opened a shared link has no chat to ask in. */
  function empty(text, action, hint) {
    return h("div", { "class": "empty" }, h("p", null, text, hint ? h("span", { "class": "in-studio", text: " " + hint }) : null), action || null);
  }
  function skeleton(rows, text) {
    var list = h("div", { "class": "skel-rows", attrs: { "aria-hidden": "true" } });
    for (var i = 0; i < (rows || 3); i++) list.appendChild(h("div", { "class": "card" }, h("span", { "class": "skel w1" }), h("span", { "class": "skel w2" })));
    return h("div", { "class": "stack" }, list, h("p", { "class": "cap", text: text || "Loading…" }));
  }
  var toastTimer = null;
  function toast(text) {
    var el = document.querySelector(".toast") || h("div", { "class": "toast", attrs: { role: "status" } });
    el.textContent = String(text || "").slice(0, 120);
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, 2500);
  }

  /** Fetch a JSON file of the site. While it loads, #list shows skeleton rows; a failure shows the error notice. */
  function load(url) {
    var list = document.getElementById("list");
    if (list && !list.firstChild) list.appendChild(skeleton(3));
    return fetch(url, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(url + ": HTTP " + r.status); return r.json(); })
      .catch(function (e) { console.error("[site] load failed", e); fail(); throw e; });
  }
  var readyDone = !bind();
  /** Resolves when the binder (if any) has said which checks it runs. Without __bind/client.js: at once. */
  function ready() {
    var b = bind();
    if (!b) { readyDone = true; return Promise.resolve({ connected: false, names: [] }); }
    var timeout = new Promise(function (resolve) { setTimeout(function () { resolve({ connected: false, names: [] }); }, 4000); });
    return Promise.race([b.ready, timeout]).then(function (info) { readyDone = true; return info; });
  }

  // ---------- header, notes ----------
  function head(data) {
    var title = document.getElementById("title") || document.querySelector("h1.title");
    var lede = document.getElementById("lede") || document.querySelector("p.lede");
    if (data && data.title) { document.title = data.title; if (title) title.textContent = data.title; }
    if (lede) {
      lede.replaceChildren();
      if (data && data.lede) lede.appendChild(document.createTextNode(data.lede));
      if (data && data.map && safeUrl(data.map)) { lede.appendChild(document.createTextNode(" ")); lede.appendChild(link(data.map, "Map")); }
      lede.hidden = !lede.firstChild;
    }
    // how the list is ordered ("Ranked by …") belongs with the answer, before any button
    var headEl = (lede && lede.parentNode) || (title && title.parentNode);
    if (headEl) {
      var basis = headEl.querySelector("p.basis");
      if (data && data.basis) {
        if (!basis) { basis = h("p", { "class": "cap basis" }); headEl.appendChild(basis); }
        basis.textContent = data.basis;
      } else if (basis) basis.remove();
    }
  }
  /** The footer: "Still to confirm" (each thing once, plain text) and "Sources: A ↗, B ↗" (one link per site). */
  function notes(unchecked, sources) {
    var el = document.getElementById("notes");
    if (!el) return;
    el.replaceChildren();
    var list = (unchecked || []).filter(Boolean);
    if (list.length) {
      // "Still to confirm", not "Not checked": a checklist's boxes are "checked" too, and a value's own caption says
      // "Not checked"
      el.appendChild(h("h2", { text: "Still to confirm" }));
      el.appendChild(h("ul", { "class": "cap" }, list.map(function (t) { return h("li", { text: t }); })));
    }
    var seen = {};
    var links = [];
    (sources || []).forEach(function (s) {
      if (!s || !s.name) return;
      var key = String(s.name).toLowerCase();
      var site = host(s.url);
      if (seen[key] || (site && seen["@" + site])) return;
      seen[key] = 1;
      if (site) seen["@" + site] = 1;
      links.push(s);
    });
    if (links.length) {
      var p = h("p", { "class": "cap" }, "Sources: ");
      links.forEach(function (s, i) { if (i) p.appendChild(document.createTextNode(", ")); p.appendChild(link(s.url, s.name)); });
      el.appendChild(p);
    }
    el.hidden = !el.firstChild;
  }
  /** Every {src, url} in a list of facts, for notes(). */
  function sourcesOf(facts) {
    var out = [];
    (facts || []).forEach(function (f) { if (f && f.src && !f.est) out.push({ name: f.src, url: f.url }); });
    return out;
  }

  // ---------- segmented control, select ----------
  /** One single choice: native radios (arrow keys work). options: [{value, label}] (at most 4; more → field select). */
  function seg(name, label, options, value, onChange) {
    if (options.length > 4) return selectField(name, label, options, value, onChange);
    var group = h("div", { "class": "seg", attrs: { role: "radiogroup", "aria-label": label } });
    options.forEach(function (o) {
      var input = h("input", { attrs: { type: "radio", name: name, value: o.value, checked: String(o.value) === String(value), "data-key": "seg:" + name + ":" + o.value } });
      input.addEventListener("change", function () { if (input.checked) onChange(o.value); });
      group.appendChild(h("label", null, input, h("span", { text: o.label })));
    });
    return group;
  }
  function selectField(name, label, options, value, onChange) {
    var id = "f-" + name;
    var sel = h("select", { id: id, attrs: { name: name } }, options.map(function (o) {
      return h("option", { text: o.label, attrs: { value: o.value, selected: String(o.value) === String(value) } });
    }));
    sel.addEventListener("change", function () { onChange(sel.value); });
    return h("div", { "class": "field inline" }, h("label", { text: label, attrs: { "for": id } }), sel);
  }

  // ---------- select / highlight commands ----------
  var hooks = { select: null };
  function rowFor(ref) {
    var all = document.querySelectorAll("[data-ref]");
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute("data-ref") === ref) return all[i];
    return null;
  }
  var marked = {}; // ref -> until (highlight without motion)
  function markSelected() {
    var lit = document.querySelectorAll(".is-highlighted");
    for (var j = 0; j < lit.length; j++) lit[j].classList.remove("is-highlighted");
    Object.keys(marked).forEach(function (ref) {
      if (marked[ref] < Date.now()) { delete marked[ref]; return; }
      var r = rowFor(ref);
      if (r) r.classList.add("is-highlighted");
    });
    var all = document.querySelectorAll(".is-selected");
    for (var i = 0; i < all.length; i++) all[i].classList.remove("is-selected");
    var row = selectedRef ? rowFor(selectedRef) : openWithoutDetails();
    if (!row) return;
    // the tint marks it; no check mark, which would read as "recommended" or "verified"
    row.classList.add("is-selected");
  }
  /** ?open=<slug> on a row that has no details to open: the row is marked instead, so the link still shows something. */
  function openWithoutDetails() {
    var open = "open" in defaults ? state().open : "";
    var row = open && document.getElementById("row-" + open);
    if (!row) return null;
    var next = row.nextElementSibling;
    return row.querySelector(".more") || (next && next.classList.contains("more-row")) ? null : row;
  }
  function select(ref) {
    selectedRef = String(ref || "") || null;
    var patch = hooks.select && selectedRef ? hooks.select(selectedRef) : null;
    if (patch) setState(patch); else render();
    var row = selectedRef && rowFor(selectedRef);
    if (row) row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }
  function reducedMotion() { return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function highlight(refs, ms) {
    var dur = Math.min(Number(ms) || 1600, 10000);
    (Array.isArray(refs) ? refs : [refs]).forEach(function (ref) {
      var row = rowFor(String(ref));
      if (!row) return;
      if (reducedMotion() || !row.animate) {
        // no fade, but the rows chat pointed at are still marked for a while (kept across redraws)
        marked[String(ref)] = Date.now() + dur;
        row.classList.add("is-highlighted");
        setTimeout(render, dur + 20);
        return;
      }
      var to = getComputedStyle(row).backgroundColor;
      var from = getComputedStyle(document.documentElement).getPropertyValue("--if-selected").trim() || "#F6F3EF";
      row.animate([{ backgroundColor: from }, { backgroundColor: to }], { duration: dur, easing: "ease-out" });
    });
  }

  // ---------- per-viewer conveniences (this browser only; may be empty or blocked) ----------
  function remember(key, value) {
    try { localStorage.setItem("site:" + location.pathname + ":" + key, String(value)); } catch (e) { /* private window */ }
  }
  function recall(key) {
    try { return localStorage.getItem("site:" + location.pathname + ":" + key); } catch (e) { return null; }
  }

  // ---------- theme-color follows the page theme ----------
  function syncThemeColor() {
    var root = document.documentElement;
    var t = root.getAttribute("data-theme");
    var dark = t === "dark" || (t !== "light" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      if (t) metas[i].setAttribute("content", dark ? "#141414" : "#FFFFFF");
    }
  }

  // ---------- one quiet status line for screen readers (rows are redrawn, so they are not live regions) ----------
  var statusEl = null;
  function announce(text) {
    if (!statusEl) {
      statusEl = h("p", { "class": "sr-only", attrs: { role: "status" } });
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = text;
  }

  // ---------- wiring ----------
  function wire() {
    window.addEventListener("popstate", render);
    // captions are tidied against the drawn lines: again when the width or the font changes
    window.addEventListener("resize", tidySoon);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(tidySoon);
    try { new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch (e) { /* old browsers */ }
    var b = bind();
    if (!b) return;
    b.on("records", schedule);
    b.on("pending", schedule);
    // An error listener also keeps the client's generic "did not work" toast away: the row says it instead.
    b.on("error", function (m) {
      if (!isCheck(m)) return;
      var ref = m.ref || checks.mine.get(m.id);
      checks.mine.delete(m.id);
      if (!ref) return;
      if (!(m.error && m.error.code === "cancelled")) {
        checks.errors.set(ref, reasonText(m.error && m.error.code, m.error && m.error.message));
        announce("Couldn't check · " + checks.errors.get(ref));
      }
      schedule();
    });
    b.on("ack", function (m) {
      if (m.status !== "rejected" || !checks.mine.has(m.id)) return;
      var ref = checks.mine.get(m.id);
      checks.mine.delete(m.id);
      checks.errors.set(ref, reasonText(m.reason, m.reason));
      announce("Couldn't check · " + checks.errors.get(ref));
      schedule();
    });
    b.on("done", function (m) {
      if (!isCheck(m)) return;
      var ref = m.ref || checks.mine.get(m.id);
      if (checks.mine.has(m.id)) announce("Checked");
      checks.mine.delete(m.id);
      if (ref) checks.errors.delete(ref);
      schedule();
    });
    b.on("command", function (m) {
      var c = m.command || {};
      var args = c.args || {};
      if (c.name === "select") select(args.ref);
      if (c.name === "highlight") highlight(args.refs || args.ref, args.ms);
    });
    ready().then(schedule);
    setInterval(schedule, 60000); // ages ("4 min ago") stay current
  }

  /**
   * Start a page: load the data, keep `state` keys in the query, render now and on every change (query, live values,
   * checks, Studio's view). render(data, state) builds the page; select(ref, data) returns a state patch (optional).
   */
  function start(o) {
    // The page draws after its data loads: Studio says it is opening the site until the first view is drawn.
    var b = bind();
    if (b && typeof b.drawsLater === "function") b.drawsLater();
    var dataUrl = o.data === undefined ? "data.json" : o.data;
    var got = dataUrl ? load(dataUrl) : Promise.resolve({});
    return got.then(function (data) {
      state(typeof o.state === "function" ? o.state(data) : (o.state || {}));
      if (o.select) hooks.select = function (ref) { return o.select(ref, data); };
      var list = document.getElementById("list");
      if (list) list.replaceChildren();
      onState(function () { o.render(data, state()); });
      drawnSoon();
      return data;
    }, function () { /* fail() already showed the notice */ drawnSoon(); });
  }
  /** The first view is on the page (or the notice saying why not): told once it is painted. */
  function drawnSoon() {
    var b = bind();
    if (!b || typeof b.drawn !== "function") return;
    (window.requestAnimationFrame || setTimeout)(function () { b.drawn(); });
  }

  window.site = {
    version: "1.6.0",
    h: h, append: append, icon: icon, link: link, slug: slug, rowAttrs: rowAttrs, safeUrl: safeUrl,
    date: date, dayDate: dayDate, ago: ago, money: money, num: num, valueText: valueText, host: host, seen: seenText,
    cite: cite, known: known, within: within, byFilter: byFilter, old: isOld, expired: expired,
    live: live, trust: trust, rowAction: rowAction, checkButton: checkButton, checkAll: checkAll, canCheck: canCheck,
    anyPending: anyPending, priceNotice: priceNotice, storesBlocked: storesBlocked, blocked: blockedRecord, tidy: tidyCaptions, remember: remember, recall: recall,
    state: state, setState: setState, onState: onState, render: render, schedule: schedule,
    load: load, ready: ready, start: start, fail: fail,
    head: head, notes: notes, sourcesOf: sourcesOf, notice: notice, empty: empty, skeleton: skeleton, toast: toast,
    seg: seg, selectField: selectField, select: select, highlight: highlight, announce: announce,
    get selected() { return selectedRef; }
  };
  wire();
})();
