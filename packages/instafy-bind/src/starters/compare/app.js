/* Compare starter: 2-8 options side by side. A table when the page is wide, a list on phones, same order and ids.
 * You design the content in data.json; keep theme.css and site.js. Restyle only when asked.
 *
 * data.json:
 *   title, lede            the page title and its one-line answer: the verdict, and the biggest unknown about the
 *                          title's question if there is one ("Option B costs least. None was tested in the rain.").
 *                          Only what a page you read says: how many a page lists, or that these are all of them or the
 *                          latest, only when it says so.
 *   sort: [{key, label, dir: "asc"|"desc"}]   the first entry is the person's main criterion: phones show its value
 *                          on the right of each row. An entry whose column no row has a value for (nor, for a price, a
 *                          store that can be checked) is left out. With 5 or more options and more than one entry,
 *                          rows are sorted by the first entry left (fresh values first, then ones that may have
 *                          changed, then missing ones), and a "Sort by" select offers the entries left when there are
 *                          two or more. Otherwise rows keep the order of "items", before and after a price check: put
 *                          them in the order the lede talks about them.
 *   columns: [{key, label, type: "price"|"number"|"text"}]   at most 5; a "price" column can be checked live
 *   filter (only for a constraint the person stated): {key, max, label: "Under $160", rest: "over $160",
 *                          unknown?: "Price unknown"}. Only a value the page shows counts: a row whose value is
 *                          unknown is never listed as under $160; it is listed apart, under "Price unknown".
 *   items: [{ref: "option:a", name, why (one short line), badge?: "Previous model", note?, facts: {key: fact},
 *            store: {name, url, readable}, more?: [{label, fact}], sources?: [{name, url}], found?: "example.com"}]
 *                          every candidate a page you read named, also one nothing could be read for: its cells say
 *                          "Unknown" (a table of unknowns). Empty only when no page named any: it reads "No options yet".
 *                          A row cites a page you read that names it (a value's or a "sources" page). When only a
 *                          search result names it, "found" is that result's site instead, and the row says "Not
 *                          checked". `instafy bind check` fails a row with neither: a guess or a placeholder.
 *   unchecked: ["what was not checked", …]     listed once in the footer, on an empty page too
 *   fact: {"v": "$145", "src": "Example Store", "url": "https://…", "date": "2026-10-17", "asof"?: "2026-08-05", "est": false}
 *   Each value cites its page and day ("checked 17 Oct on maker.com ↗"), and no cell is blank: a source you read that
 *   does not give the value is the fact without "v" ({"src", "url", "date"}): "Not listed · checked 17 Oct on
 *   maker.com ↗"; any other missing value reads "Unknown", with {"note": "the store blocks price checks"} saying why.
 *   Never a dash. A value cites only a page that gives it: a count of what you found ("1 of 2 reviews found") cites a
 *   page it counts, and with none found it is {"note": "no review of this model read"}, citing no page.
 * When one page gives most of a column on one date, the cells show just the value and one line under the list cites
 * that page; so does a row whose own values come from one other page ("Option C (Support and Ride): checked 16 Oct on
 * fleetfeet.com ↗"). Any other cell keeps its own caption.
 * Query: ?sort=<key>&show=all&open=<slug>. Rows: id="row-<slug>", data-ref="<ref>".
 * SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  "use strict";
  var h = site.h;
  var TABLE_MIN = 760; // the list's own width (not the screen's): Studio's pane and a phone get the same rule
  var lastOrder = [];  // row order while a live check runs, so rows never move under the pointer

  site.start({
    data: "data.json",
    state: function (data) {
      return { sort: (data.sort && data.sort[0] && data.sort[0].key) || "", show: data.filter ? "fit" : "all", open: "" };
    },
    select: function (ref) { return { open: site.slug(ref) }; },
    render: render
  });
  var wideNow = null;
  if (window.ResizeObserver) {
    new ResizeObserver(function () { if (isWide() !== wideNow) site.render(); }).observe(document.querySelector("main") || document.body);
  } else {
    window.addEventListener("resize", function () { if (isWide() !== wideNow) site.render(); });
  }
  function isWide() {
    var main = document.querySelector("main") || document.body;
    var cs = getComputedStyle(main);
    return main.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) >= TABLE_MIN;
  }

  function columns(data) { return (data.columns || []).slice(0, 5); }
  function isPrice(col) { return col && col.type === "price"; }
  function colOf(data, key) { return columns(data).filter(function (c) { return c.key === key; })[0] || null; }
  function seedOf(item, col) { return (item.facts || {})[col.key] || null; }
  /** The value shown for a cell: a live check for the price column, else the seed fact. */
  function valueOf(item, col) {
    var seed = seedOf(item, col);
    if (!isPrice(col)) return seed;
    var live = site.live(item.ref, col.key);
    if (live && site.blocked(item.ref)) return seed; // a blocked check keeps the seed value
    return live || seed;
  }
  /** A fact's page and day: two values share a citation only when one page on one day gives both. */
  function citeKey(f) {
    var page = site.safeUrl(f.url);
    return [page ? page.split("#")[0] : "src:" + f.src, f.date || "", f.asof || ""].join("|");
  }
  /** Per column: the page most of its cells share ({src, date, asof, url}), when two or more cells and over half do. */
  function sharedSources(data, items) {
    var out = {};
    columns(data).forEach(function (c) {
      if (isPrice(c)) return;
      var count = {};
      items.forEach(function (i) {
        var f = seedOf(i, c);
        if (!f || !f.src || f.est || !site.valueText(f)) return;
        var k = citeKey(f);
        count[k] = count[k] || { n: 0, fact: f };
        count[k].n++;
      });
      var best = Object.keys(count).sort(function (a, b) { return count[b].n - count[a].n; })[0];
      if (best && count[best].n >= 2 && count[best].n * 2 > items.length) out[c.key] = { key: best, fact: count[best].fact };
    });
    return out;
  }
  function isShared(shared, item, col) {
    var s = shared[col.key];
    var f = seedOf(item, col);
    return !!(s && f && f.src && !f.est && citeKey(f) === s.key);
  }
  /** Per row: the one page its own cells share ({key, fact, labels}), when two or more of its cells outside the price
   * column come from one page on one date that is not their column's. The line under the list cites it once
   * ("Option C (Support and Ride): checked 16 Oct on fleetfeet.com ↗"), so the row is not a stack of links. */
  function rowSources(data, items, shared) {
    var out = {};
    items.forEach(function (i) {
      var by = {};
      columns(data).forEach(function (c) {
        if (isPrice(c) || isShared(shared, i, c)) return;
        var f = seedOf(i, c);
        if (!f || !f.src || f.est) return;
        var k = citeKey(f);
        (by[k] = by[k] || { key: k, fact: f, labels: [], values: 0 }).labels.push(c.label);
        if (site.valueText(f)) by[k].values++;
      });
      var keys = Object.keys(by);
      if (keys.length === 1 && by[keys[0]].labels.length >= 2 && by[keys[0]].values >= 1) out[i.ref] = by[keys[0]];
    });
    return out;
  }
  function ownRow(rows, item, col) {
    var r = rows[item.ref];
    var f = seedOf(item, col);
    return !!(r && f && f.src && !f.est && !isPrice(col) && citeKey(f) === r.key);
  }
  /** A missing value reads "Unknown" (with label: "Price unknown", where no column header or fact label says what). */
  function cell(item, col, src, label) {
    if (isPrice(col)) {
      return site.trust(valueOf(item, col), { price: true, ref: item.ref, intent: "read_offer", store: item.store, seed: seedOf(item, col), label: label, unknown: "Unknown" });
    }
    return site.trust(valueOf(item, col), { shared: isShared(src.cols, item, col) || ownRow(src.rows, item, col), label: label, unknown: "Unknown" });
  }
  function hasMore(item) { return !!(item.note || found(item) || (item.more && item.more.length) || (item.sources && item.sources.length)); }
  /** The site of the search result that alone names this row ("found"), or "". */
  function found(item) { return typeof item.found === "string" ? item.found.trim().slice(0, 100) : ""; }

  /** The sort entries data.json gives (none unless it is a list). */
  function sortList(data) { return Array.isArray(data.sort) ? data.sort : []; }
  /** The entries left: one whose column no row shows a value for (nor, for a price, a store that can be checked) is
   * left out. Sorted by it, the rows would keep their order under a label saying otherwise, and a phone would show
   * "Unknown" on the right of every row. */
  function sorts(data) {
    var items = data.items || [];
    return sortList(data).filter(function (s) {
      var col = s && s.key ? colOf(data, s.key) || { key: s.key } : null;
      return !!col && items.some(function (i) {
        return site.shown(valueOf(i, col)) || (isPrice(col) && !!(i.store && i.store.readable));
      });
    });
  }
  /** The sort in use: the chosen one when it is left, else the first one left; null when none is. */
  function sortDef(data, st) {
    var list = sorts(data);
    return list.filter(function (s) { return s.key === st.sort; })[0] || list[0] || null;
  }
  /** Rows are sorted only with 5 or more options and more than one entry in data.json, by an entry left. */
  function sorted(data) { return sortList(data).length > 1 && (data.items || []).length >= 5 && !!sorts(data).length; }
  /** The "Sort by" select shows only when rows are sorted and more than one entry is left to choose from. */
  function sortShown(data) { return sorted(data) && sorts(data).length > 1; }
  /** Sorted by the chosen key: fresh values first, then values that may have changed (an old price never leads), then
   * rows without one. */
  function sortItems(data, items, st) {
    var def = sortDef(data, st);
    if (!def) return items;
    var col = colOf(data, def.key) || { key: def.key };
    var tier = function (i) { var v = valueOf(i, col); return site.known(v) == null ? 2 : site.old(v, isPrice(col)) ? 1 : 0; };
    return items.slice().sort(function (a, b) {
      var ta = tier(a), tb = tier(b);
      if (ta !== tb) return ta - tb;
      if (ta === 2) return 0;
      var x = site.known(valueOf(a, col)), y = site.known(valueOf(b, col));
      return def.dir === "desc" ? y - x : x - y;
    });
  }
  /** The rows by the page's one filter: {in, unknown, out}. A row whose value is unknown is never "in". */
  function byFilter(data, items) {
    var f = data.filter;
    var col = f ? colOf(data, f.key) || { key: f.key } : null;
    return site.byFilter(items, f, function (i) { return valueOf(i, col); });
  }
  /** "Price unknown": the heading of the rows the filter cannot place. */
  function unknownTitle(data) {
    var f = data.filter;
    var col = colOf(data, f.key);
    return f.unknown || ((col ? col.label : f.key) + " unknown");
  }
  function lowerFirst(text) { text = String(text || ""); return text.charAt(0).toLowerCase() + text.slice(1); }

  function render(data, st) {
    site.head(data);
    var all = data.items || [];
    // unless data.json asks for a sort (5+ options), the rows keep their authored order: nothing moves when a check
    // comes back
    var items = sorted(data) ? sortItems(data, all, st) : all.slice();
    // while a check runs, keep the order the person was looking at; sort once when every check has finished
    if (site.anyPending(all) && lastOrder.length === all.length) {
      items = lastOrder.map(function (ref) { return all.filter(function (i) { return i.ref === ref; })[0]; }).filter(Boolean);
    }
    lastOrder = items.map(function (i) { return i.ref; });
    // "All" is one list; the stated limit shows the rows within it, then the rows nobody could place ("Price unknown",
    // never counted as within it), and one line for the rest
    var parts = st.show === "all" || !data.filter ? { "in": items, unknown: [], out: [] } : byFilter(data, items);
    var shown = parts["in"];
    var apart = parts.unknown;
    var hidden = parts.out.length;
    var hasPrice = columns(data).some(isPrice);
    var cols = sharedSources(data, all);
    var shared = { cols: cols, rows: rowSources(data, all, cols) };

    // the one control row: the sort (5+ options) and the one filter on the left, the one primary button on the right
    var bar = document.getElementById("bar");
    bar.replaceChildren();
    if (sortShown(data)) {
      bar.appendChild(site.selectField("sort", "Sort by", sorts(data).map(function (s) { return { value: s.key, label: s.label }; }), sortDef(data, st).key,
        function (v) { site.setState({ sort: v }); }));
    }
    if (data.filter) {
      bar.appendChild(site.seg("show", "Show", [{ value: "all", label: "All" }, { value: "fit", label: data.filter.label }], st.show,
        function (v) { site.setState({ show: v }); }));
    }
    if (hasPrice) site.append(bar, site.checkAll(all));
    bar.hidden = !bar.firstChild;

    var list = document.getElementById("list");
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(site.empty("No options yet.", null, "Ask in chat to add some."));
    } else {
      var stores = hasPrice ? site.priceNotice(all) : null;
      wideNow = isWide();
      var wrap = h("div", { "class": "stack" });
      if (shown.length) wrap.appendChild(wideNow ? table(data, shown, st, shared) : cards(data, shown, st, shared));
      else wrap.appendChild(h("p", { "class": "cap", text: "None is known to be " + lowerFirst(data.filter.label || "within the limit") + "." }));
      if (apart.length) {
        wrap.appendChild(h("section", { "class": "group", attrs: { id: "group-unknown", "aria-label": unknownTitle(data) } },
          h("div", { "class": "group-head" }, h("h2", { text: unknownTitle(data) }),
            h("span", { "class": "cap", text: "Not counted as " + lowerFirst(data.filter.label || "within the limit") })),
          wideNow ? table(data, apart, st, shared) : cards(data, apart, st, shared)));
      }
      var lines = [];
      if (hidden > 0) {
        lines.push(h("p", { "class": "cap hidden-line" }, hidden + " more " + (data.filter.rest || "hidden") + " · ",
          h("button", { "class": "link-btn", text: "Show", attrs: { type: "button", "data-key": "show-all" }, on: { click: function () { site.setState({ show: "all" }); } } })));
      }
      var missing = sorted(data) ? missingLine(data, shown, st) : null;
      if (missing) lines.push(missing);
      var from = sharedLine(data, shared, all);
      if (from) lines.push(from);
      if (lines.length) wrap.appendChild(h("div", { "class": "stack tight" }, lines));
      if (stores) wrap.appendChild(stores);
      list.appendChild(wrap);
    }

    var sources = [];
    items.forEach(function (i) {
      columns(data).forEach(function (c) { sources = sources.concat(site.sourcesOf([(i.facts || {})[c.key]])); });
      (i.sources || []).forEach(function (s) { sources.push(s); });
    });
    // a source the line under the list already names is not named again under "Sources"
    var named = [];
    Object.keys(cols).forEach(function (k) { named.push(cols[k].fact); });
    Object.keys(shared.rows).forEach(function (k) { named.push(shared.rows[k].fact); });
    sources = sources.filter(function (s) {
      return !named.some(function (f) { return f.src === s.name || (site.host(f.url) && site.host(f.url) === site.host(s.url)); });
    });
    // what was not checked is said on an empty page too: it is why the page is empty
    site.notes(data.unchecked, sources);
  }

  /** "2 without a price are listed last." when the sort key is missing for some rows. */
  function missingLine(data, items, st) {
    var def = sortDef(data, st);
    if (!def) return null;
    var col = colOf(data, def.key) || { key: def.key, label: def.key };
    var n = items.filter(function (i) { return site.known(valueOf(i, col)) == null; }).length;
    if (!n || n === items.length) return null;
    return h("p", { "class": "cap", text: n + " without " + (/^[aeiou]/i.test(col.label) ? "an " : "a ") + String(col.label).toLowerCase() + (n === 1 ? " is" : " are") + " listed last." });
  }
  /** "Support and Heel drop: checked 16 Oct on runningshoesguru.com ↗", plus ", unless a value says otherwise" when a
   * cell of those columns has its own source. */
  function sharedLine(data, src, items) {
    var groups = {};
    var and = function (list) { return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0]; };
    columns(data).forEach(function (c) {
      var s = src.cols[c.key];
      if (!s) return;
      var g = groups[s.key] = groups[s.key] || { fact: s.fact, labels: [], others: false };
      g.labels.push(c.label);
      // a value with its own source that no row line names keeps its own caption: "unless a value says otherwise"
      if (items.some(function (i) { var f = seedOf(i, c); return f && f.src && site.valueText(f) && !isShared(src.cols, i, c) && !ownRow(src.rows, i, c); })) g.others = true;
    });
    var out = Object.keys(groups).map(function (k) {
      var g = groups[k];
      return h("p", { "class": "cap" }, and(g.labels) + ": ", site.cite(g.fact), g.others ? ", unless a value says otherwise" : "");
    });
    items.forEach(function (i) {
      var r = src.rows[i.ref];
      if (!r) return;
      out.push(h("p", { "class": "cap" }, i.name + " (" + and(r.labels) + "): ", site.cite(r.fact)));
    });
    return out.length ? h("div", null, out) : null;
  }

  function nameBlock(item) {
    return [
      h("div", { "class": "name-line" }, h("span", { "class": "name", text: item.name }), item.badge ? h("span", { "class": "badge", text: item.badge }) : null,
        found(item) ? h("span", { "class": "badge", text: "Not checked" }) : null),
      item.why ? h("p", { "class": "cap", text: item.why }) : null
    ];
  }
  function detailsButton(item, st) {
    if (!hasMore(item)) return null;
    var open = st.open === site.slug(item.ref);
    return h("button", {
      "class": "btn quiet more-btn",
      text: open ? "Hide details" : "Details",
      attrs: { type: "button", "aria-expanded": open ? "true" : "false", "aria-label": (open ? "Hide details for " : "Details for ") + item.name, "data-key": "details:" + item.ref },
      on: { click: function () { site.setState({ open: open ? "" : site.slug(item.ref) }); } }
    });
  }
  function more(item) {
    var facts = (item.more || []).slice(0, 8);
    var linked = {};
    facts.forEach(function (f) { if (f.fact && f.fact.url) linked[f.fact.url] = 1; });
    var sources = (item.sources || []).filter(function (s) { return s && !linked[s.url]; });
    return h("div", { "class": "more" },
      item.note ? h("p", { text: item.note }) : null,
      found(item) ? h("p", { "class": "cap", text: "Named in a search result on " + found(item) + "." }) : null,
      facts.length ? h("dl", { "class": "facts" }, facts.map(function (f) {
        return h("div", null, h("dt", { text: f.label }), h("dd", null, site.trust(f.fact)));
      })) : null,
      sources.length ? h("p", { "class": "cap" }, "Sources: ", sources.map(function (s, i) {
        return [i ? ", " : "", site.link(s.url, s.name)];
      })) : null);
  }

  function table(data, items, st, shared) {
    var cols = columns(data);
    var anyMore = items.some(hasMore);
    var head = h("tr", null, h("th", { text: "Option", attrs: { scope: "col" } }),
      cols.map(function (c) { return h("th", { "class": c.type === "text" ? null : "num", text: c.label, attrs: { scope: "col" } }); }),
      anyMore ? h("th", { attrs: { scope: "col" } }, h("span", { "class": "sr-only", text: "Details" })) : null);
    var body = h("tbody");
    items.forEach(function (item) {
      body.appendChild(h("tr", { attrs: site.rowAttrs(item.ref) },
        h("td", null, nameBlock(item)),
        cols.map(function (c) { return h("td", { "class": c.type === "text" ? null : "num" }, cell(item, c, shared)); }),
        anyMore ? h("td", { "class": "act" }, detailsButton(item, st)) : null));
      if (st.open === site.slug(item.ref) && hasMore(item)) {
        body.appendChild(h("tr", { "class": "more-row" }, h("td", { attrs: { colspan: cols.length + 1 + (anyMore ? 1 : 0) } }, more(item))));
      }
    });
    return h("div", { "class": "table-wrap" }, h("table", { "class": "table" }, h("thead", null, head), body));
  }

  /** Phones: one list, a row per option. The sorted value (with its caption) sits on the right, so you compare by
   * scanning down the right edge; the other columns follow as facts in the same order on every row. */
  function cards(data, items, st, shared) {
    var cols = columns(data);
    var def = sortDef(data, st);
    var sortCol = def ? colOf(data, def.key) : null;
    return h("ol", { "class": "list cards" }, items.map(function (item) {
      var open = st.open === site.slug(item.ref);
      var rest = cols.filter(function (c) { return c !== sortCol; });
      return h("li", { attrs: site.rowAttrs(item.ref) },
        h("div", { "class": "card-head" },
          h("div", null, nameBlock(item)),
          sortCol ? h("div", { "class": "sortv" }, cell(item, sortCol, shared, sortCol.label)) : null),
        rest.length ? h("dl", { "class": "facts" }, rest.map(function (c) { return h("div", null, h("dt", { text: c.label }), h("dd", null, cell(item, c, shared))); })) : null,
        hasMore(item) ? h("div", { "class": "actions" }, detailsButton(item, st)) : null,
        open && hasMore(item) ? more(item) : null);
    }));
  }
})();
