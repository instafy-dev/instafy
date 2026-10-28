/* Ranked starter: a top-N list ("best X", "top 10"). One layout at every width; the ranking is the order.
 * You design the content in data.json; keep theme.css and site.js. Restyle only when asked.
 *
 * data.json:
 *   title, lede     the page title and its one-line answer (the verdict, and the biggest unknown if there is one)
 *   basis           how it is ranked, one line: "Ranked by safety reviews, then price."
 *   filter (only for a constraint the person stated): {key: "price", max: 300, label: "Under $300", unknown?:
 *            "Price unknown"}. Only a price the page shows counts: a row without one is never listed as under $300;
 *            it is listed apart, under "Price unknown".
 *   items: [{ref: "option:a", rank, name, why (one short line), badge?, specs: [fact] (at most 3), price?: fact,
 *            store?: {name, url, readable}, details?: [{label, fact}], sources?: [{name, url}]}]
 *   badge: only for a label the person must notice. "Our pick" only when it is your own pick and "why" says why;
 *          a source's pick or award for a row is that row's badge, saying whose ("BabyGearLab's top pick",
 *          "BabyGearLab: best budget"), never a "Details" toggle. Nothing is added by itself.
 *   price: the price as a fact (not in specs), with "asof" when the source dates it; a live check replaces it. A
 *          review site's price is its list price: "list": true, so the row says "list price" and never reads as the
 *          store's price now. When one page on one date gives every price, one line under the list names it once
 *          ("List prices on BabyGearLab ↗ · seen 5 Aug"), and "Sources" does not name it again. A missing price reads
 *          "Price unknown", then why ({"note": "the store blocks price checks"}).
 *   details: only facts the row does not already show.
 *   unchecked: ["what was not checked", …]
 *   fact: {"v": "$145", "src": "Example Store", "url": "https://…", "date": "2026-10-17", "est": false}
 * The item shape is the compare starter's, so the same items work there ("Compare these", only when asked).
 * Query: ?show=all&open=<slug>. Rows: id="row-<slug>", data-ref="<ref>".
 * SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  "use strict";
  var h = site.h;

  site.start({
    data: "data.json",
    state: function (data) { return { show: data.filter ? "fit" : "all", open: "" }; },
    select: function (ref) { return { open: site.slug(ref) }; },
    render: render
  });

  /** The price a row shows: a live check, else the seed price (also when the check found the store blocked). */
  function priceOf(item) {
    var live = site.live(item.ref, "price");
    if (live && site.blocked(item.ref)) return item.price || live;
    return live || item.price || null;
  }
  function valueFor(item, key) {
    if (key === "price") return priceOf(item);
    var d = (item.details || []).filter(function (x) { return x.key === key; })[0];
    return d ? d.fact : null;
  }
  /** "Price unknown": the heading of the rows the filter cannot place. */
  function unknownTitle(data) {
    var f = data.filter;
    if (f.unknown) return f.unknown;
    if (f.key === "price") return "Price unknown";
    var d = (data.items || []).map(function (i) { return (i.details || []).filter(function (x) { return x.key === f.key; })[0]; }).filter(Boolean)[0];
    return ((d && d.label) || f.key) + " unknown";
  }
  function lowerFirst(text) { text = String(text || ""); return text.charAt(0).toLowerCase() + text.slice(1); }
  function render(data, st) {
    site.head(data); // title, lede and the basis line ("Ranked by …") come first, before any button
    var items = (data.items || []).slice().sort(function (a, b) { return (a.rank || 0) - (b.rank || 0); });
    // the stated limit shows the rows within it, then the rows nobody could place ("Price unknown", never counted as
    // within it); "All" is the whole ranking
    var parts = st.show === "all" || !data.filter ? { "in": items, unknown: [], out: [] }
      : site.byFilter(items, data.filter, function (i) { return valueFor(i, data.filter.key); });
    var shown = parts["in"];
    var apart = parts.unknown;
    var hidden = parts.out.length;
    var priced = items.some(function (i) { return i.price || i.store; });
    var shared = sharedPrice(items);

    var bar = document.getElementById("bar");
    bar.replaceChildren();
    if (data.filter) {
      bar.appendChild(site.seg("show", "Show", [{ value: "all", label: "All" }, { value: "fit", label: data.filter.label }], st.show,
        function (v) { site.setState({ show: v }); }));
    }
    if (priced) site.append(bar, site.checkAll(items));
    bar.hidden = !bar.firstChild;

    var list = document.getElementById("list");
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(site.empty("Nothing ranked yet.", null, "Ask in chat to add some."));
    } else {
      var wrap = h("div", { "class": "stack" });
      var stores = priced ? site.priceNotice(items) : null; // the reason a store can't be read, said once
      // every store refuses checks from the start and one line already names the list prices: that line says where
      // today's price is ("Open a store for today's price."), instead of a box about checks nobody was offered
      var inline = !!(shared && stores && site.storesBlocked(items));
      if (inline) stores = null;
      if (shown.length) wrap.appendChild(h("ol", { "class": "list ranked" }, shown.map(function (item) { return row(item, st, priced, shared); })));
      else wrap.appendChild(h("p", { "class": "cap", text: "None is known to be " + lowerFirst(data.filter.label) + "." }));
      if (apart.length) {
        wrap.appendChild(h("section", { "class": "group", attrs: { id: "group-unknown", "aria-label": unknownTitle(data) } },
          h("div", { "class": "group-head" }, h("h2", { text: unknownTitle(data) }),
            h("span", { "class": "cap", text: "Not counted as " + lowerFirst(data.filter.label) })),
          h("ol", { "class": "list ranked" }, apart.map(function (item) { return row(item, st, priced, shared); }))));
      }
      if (hidden > 0) {
        wrap.appendChild(h("p", { "class": "cap" }, hidden + " hidden · ",
          h("button", { "class": "link-btn", text: "Show all", attrs: { type: "button", "data-key": "show-all" }, on: { click: function () { site.setState({ show: "all" }); } } })));
      }
      if (shared) wrap.appendChild(sharedLine(shared, inline));
      if (stores) wrap.appendChild(stores);
      list.appendChild(wrap);
    }

    var sources = [];
    items.forEach(function (i) {
      sources = sources.concat(site.sourcesOf((i.specs || []).concat([i.price])));
      (i.sources || []).forEach(function (s) { sources.push(s); });
    });
    // the line under the list already names the prices' source: "Sources" does not say it a second time
    if (shared) sources = sources.filter(function (s) { return s.name !== shared.src && !(site.host(s.url) && site.host(s.url) === site.host(shared.url)); });
    // the footer belongs to a list: an empty page has nothing to confirm
    site.notes(items.length ? data.unchecked : [], items.length ? sources : []);
  }

  /** The price fact every priced row shares (one page on one date), else null. */
  function sharedPrice(items) {
    var facts = items.map(function (i) { return i.price; }).filter(Boolean);
    if (facts.length < 2) return null;
    var page = function (f) { var u = site.safeUrl(f.url); return u ? u.split("#")[0] : "src:" + f.src; };
    var key = function (f) { return f && f.src && !f.est && site.valueText(f) ? [page(f), f.asof || f.date || "", f.list ? "list" : ""].join("|") : null; };
    var k = key(facts[0]);
    return k && facts.every(function (f) { return key(f) === k; }) ? facts[0] : null;
  }
  /** "List prices on BabyGearLab ↗ · seen 5 Aug" ("Prices: Store ↗ · …" for a store's own), said once under the
   * list (" · may have changed" when it is old; "Open a store for today's price." when no store can be checked, as its own sentence, so no wrapped line starts with a dot). */
  function sharedLine(f, openStore) {
    var when = site.seen(f);
    return h("p", { "class": "cap shared-line" }, f.list ? "List prices on " : "Prices: ", site.link(f.url, f.src), when ? [" · ", h("span", { "class": "nowrap", text: when })] : "",
      site.old(f, true) ? " · may have changed" : "", openStore ? ". Open a store for today's price." : "");
  }
  /** Details holds only what the row does not already show, and a source link once: a page on a site the row's
   * facts already link to is not repeated. */
  function extras(item) {
    var onRow = {};
    (item.specs || []).concat([item.price]).forEach(function (f) { var v = site.valueText(f); if (v) onRow[v.toLowerCase()] = 1; });
    var facts = (item.details || []).filter(function (d) { var v = site.valueText(d.fact); return v && !onRow[v.toLowerCase()]; }).slice(0, 8);
    var linked = {};
    (item.specs || []).concat([item.price], facts.map(function (d) { return d.fact; })).forEach(function (f) {
      if (f && f.url) { linked[f.url] = 1; if (site.host(f.url)) linked["@" + site.host(f.url)] = 1; }
    });
    var sources = (item.sources || []).filter(function (s) { return s && !linked[s.url] && !linked["@" + site.host(s.url)]; });
    return { facts: facts, sources: sources };
  }
  function hasMore(item) { var x = extras(item); return !!(x.facts.length || x.sources.length); }

  function row(item, st, priced, shared) {
    var open = st.open === site.slug(item.ref);
    // a badge only when the data names one ("Our pick" when the reason is in "why"; "BabyGearLab's top pick" when a
    // source picked it). Never added by itself.
    var badge = item.badge || null;
    var specs = (item.specs || []).slice(0, 3).map(function (f) {
      var v = site.valueText(f);
      return v && !f.src && !f.est ? v + ", not checked" : v;
    }).filter(Boolean);
    var live = site.live(item.ref, "price");
    var details = hasMore(item) ? h("button", {
      "class": "btn quiet more-btn",
      text: open ? "Hide details" : "Details",
      attrs: { type: "button", "aria-expanded": open ? "true" : "false", "aria-label": (open ? "Hide details for " : "Details for ") + item.name, "data-key": "details:" + item.ref },
      on: { click: function () { site.setState({ open: open ? "" : site.slug(item.ref) }); } }
    }) : null;
    return h("li", { "class": "row", attrs: site.rowAttrs(item.ref) },
      h("span", { "class": "rank", text: item.rank, attrs: { "aria-hidden": "true" } }),
      h("div", { "class": "row-body" },
        // "Details" stays at the end of the first line even when a badge wraps under the name
        h("div", { "class": "name-line" },
          h("div", { "class": "name-wrap" }, h("span", { "class": "name" }, h("span", { "class": "sr-only", text: "Number " + item.rank + ": " }), item.name),
            badge ? h("span", { "class": "badge", text: badge }) : null), details),
        item.why ? h("p", { "class": "why", text: item.why }) : null,
        specs.length ? h("p", { "class": "cap", text: specs.join(" · ") }) : null,
        // every priced row has the same price line, with or without a store
        priced ? site.trust(live || item.price || null, { label: "Price", unknown: "Unknown", price: true, ref: item.ref, intent: "read_offer", store: item.store, seed: item.price || null, shared: !live && !!shared && !!item.price }) : null,
        open && hasMore(item) ? more(item) : null));
  }

  function more(item) {
    var x = extras(item);
    return h("div", { "class": "more" },
      x.facts.length ? h("dl", { "class": "facts" }, x.facts.map(function (d) {
        return h("div", null, h("dt", { text: d.label }), h("dd", null, site.trust(d.fact)));
      })) : null,
      x.sources.length ? h("p", { "class": "cap" }, "Sources: ", x.sources.map(function (s, i) {
        return [i ? ", " : "", site.link(s.url, s.name)];
      })) : null);
  }
})();
