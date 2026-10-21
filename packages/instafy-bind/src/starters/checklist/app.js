/* Checklist starter: packing, to-do, steps, a shared list. Ticks are shared by every viewer and device.
 * You design the content in data.json; keep theme.css and site.js. Restyle only when asked.
 *
 * data.json:
 *   title, lede
 *   people?: ["Ana", "Ben"]    only when each person keeps their own ticks ("each of us packs")
 *   groups: [{id, title, items: [{ref: "item:charger", text, note?, fact?}]}]
 *   fact: {"v": "Sockets are type G", "src": "…", "url": "https://…", "date": "2026-10-17"}
 * A tick sends set_check {ref, done, who?}; the binder stores it and every page shows it. Without a binder,
 * ticks stay on this device. Checked items stay in place (muted, struck through). Query: ?who=<name>. A per-person
 * list shows no ticks until the viewer picks a name ("Whose list is this?" with one plain button per person, "I'm
 * Ana"); this browser remembers the pick. After that a segmented "Ana | Ben" switches lists.
 * Rows: id="item-<slug>", data-ref="<ref>".
 * SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  "use strict";
  var h = site.h;
  var optimistic = {}; // "<ref>|<attr>" -> {done, id}: shown at once, until the binder answers
  var failed = {};     // "<ref>|<attr>" -> the tick that did not save
  var mine = {};       // intent id -> "<ref>|<attr>"
  var known = false;   // the binder (if any) has said whether it stores ticks

  var bind = window.instafyBind;
  if (bind) {
    bind.on("done", function (m) { var k = mine[m.id]; if (!k) return; delete mine[m.id]; delete optimistic[k]; site.schedule(); });
    bind.on("error", function (m) { var k = mine[m.id]; if (!k) return; delete mine[m.id]; failed[k] = optimistic[k] && optimistic[k].done; delete optimistic[k]; site.schedule(); });
    bind.on("ack", function (m) {
      if (m.status !== "rejected" || !mine[m.id]) return;
      var k = mine[m.id];
      delete mine[m.id];
      failed[k] = optimistic[k] && optimistic[k].done;
      delete optimistic[k];
      site.schedule();
    });
  }
  site.ready().then(function () { known = true; site.schedule(); });

  site.start({
    data: "data.json",
    // a per-person list never guesses whose it is: the viewer picks (and this browser remembers it)
    state: { who: "" },
    render: render
  });

  function shared() { return site.canCheck("set_check", { readable: true }); }
  function attrFor(who) {
    if (!who) return "done";
    return "done_" + (who.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x");
  }
  function storeKey() { return "checklist:" + location.pathname; }
  function readLocal() {
    try { return JSON.parse(localStorage.getItem(storeKey()) || "{}") || {}; } catch (e) { return {}; }
  }
  function writeLocal(all) {
    try { localStorage.setItem(storeKey(), JSON.stringify(all)); } catch (e) { /* private window: ticks last this visit */ }
  }
  var memory = null; // when localStorage is blocked
  function isDone(ref, attr) {
    var k = ref + "|" + attr;
    if (optimistic[k]) return optimistic[k].done;
    if (shared()) {
      var r = site.live(ref, attr);
      return !!(r && r.value === true);
    }
    var all = memory || readLocal();
    if (all[attr] && ref in all[attr]) return !!all[attr][ref];
    var saved = site.live(ref, attr); // a saved copy of the page still shows the ticks it was saved with
    return !!(saved && saved.value === true);
  }
  function tick(ref, attr, who, done) {
    var k = ref + "|" + attr;
    delete failed[k];
    if (shared()) {
      var params = { ref: ref, done: done, at: new Date().toISOString() };
      if (who) params.who = who;
      try {
        var id = bind.intent("set_check", params, { ref: ref, ui: "check" });
        mine[id] = k;
        optimistic[k] = { done: done, id: id };
      } catch (e) {
        failed[k] = done;
      }
    } else {
      var all = memory || readLocal();
      all[attr] = all[attr] || {};
      all[attr][ref] = done;
      writeLocal(all);
      if (readLocal()[attr] === undefined) memory = all;
    }
    site.schedule();
  }

  var restored = false;
  function render(data, st) {
    site.head(data);
    var people = data.people || [];
    if (people.length && !st.who && !restored) {
      restored = true;
      var mine = site.recall("who");
      if (mine && people.indexOf(mine) >= 0) return site.setState({ who: mine });
    }
    var who = people.length && people.indexOf(st.who) >= 0 ? st.who : "";
    var attr = attrFor(who);
    var groups = data.groups || [];
    var all = [];
    groups.forEach(function (g) { (g.items || []).forEach(function (i) { all.push(i); }); });
    var doneCount = all.filter(function (i) { return isDone(i.ref, attr); }).length;

    var bar = document.getElementById("bar");
    bar.replaceChildren();
    var pick = function (v) { site.remember("who", v); site.setState({ who: v }); };
    if (people.length && !who) {
      // nothing to tick until the viewer says whose list it is, so nobody ticks someone else's bag: a question and one
      // plain button per person (an empty segmented control looks broken, not like a question)
      bar.appendChild(h("p", { "class": "progress pick-q", text: "Whose list is this?" }));
      people.forEach(function (p) {
        bar.appendChild(h("button", { "class": "btn", text: "I'm " + p, attrs: { type: "button", "data-key": "pick:" + p }, on: { click: function () { pick(p); } } }));
      });
      bar.hidden = false;
      document.getElementById("list").replaceChildren();
      site.notes([], []); // the notes belong to a list; there is none yet
      return;
    }
    if (people.length) bar.appendChild(site.seg("who", "Whose list", people.map(function (p) { return { value: p, label: p }; }), who, pick));
    bar.hidden = !bar.firstChild;

    var list = document.getElementById("list");
    list.replaceChildren();
    if (!all.length) {
      list.appendChild(site.empty("Nothing on the list yet.", null, "Ask in chat to add some."));
      site.notes([], []);
      return;
    }
    var top = h("div", { "class": "stack" },
      h("div", null,
        h("p", { "class": "progress", text: (who ? who + ": " : "") + doneCount + " of " + all.length + " done" }),
        known && !shared() ? h("p", { "class": "cap", text: "Ticks are saved on this device only." }) : null));
    groups.forEach(function (g) {
      var items = g.items || [];
      var n = items.filter(function (i) { return isDone(i.ref, attr); }).length;
      top.appendChild(h("section", { "class": "group", attrs: { id: "group-" + site.slug(g.id || g.title) } },
        h("div", { "class": "group-head" }, h("h2", { text: g.title }), h("span", { "class": "cap", text: n + " of " + items.length })),
        h("ul", { "class": "list checks" }, items.map(function (i) { return row(i, attr, who); }))));
    });
    list.appendChild(top);

    var sources = [];
    all.forEach(function (i) { sources = sources.concat(site.sourcesOf([i.fact])); });
    site.notes(data.unchecked, sources);
  }

  function row(item, attr, who) {
    var k = item.ref + "|" + attr;
    var done = isDone(item.ref, attr);
    var input = h("input", { attrs: { type: "checkbox", checked: done, disabled: !known, "data-key": "tick:" + item.ref } });
    input.addEventListener("change", function () { tick(item.ref, attr, who, input.checked); });
    var attrs = site.rowAttrs(item.ref, "item");
    var linked = !!(item.fact && site.safeUrl(item.fact.url));
    return h("li", { "class": "item", attrs: attrs },
      h("label", { "class": "check" }, input,
        h("span", { "class": "text" },
          h("span", { "class": "label-text", text: item.text }),
          item.note ? h("span", { "class": "cap", text: item.note }) : null,
          // a fact without a link reads like a note, in the row ("To confirm · whether pools need a swim cap")
          item.fact && !linked ? h("span", { "class": "item-fact cap" }, site.trust(item.fact, { unknown: "To confirm" })) : null)),
      // a fact with a link sits under the row, outside the tick target, as a quiet caption
      item.fact && linked ? h("p", { "class": "item-fact" }, site.trust(item.fact, { unknown: "To confirm" })) : null,
      k in failed ? h("p", { "class": "cap err" }, site.icon("error"), " Couldn't save · ",
        h("button", { "class": "link-btn", text: "Try again", attrs: { type: "button", "data-key": "retry:" + item.ref }, on: { click: function () { tick(item.ref, attr, who, failed[k] !== false); } } })) : null);
  }
})();
