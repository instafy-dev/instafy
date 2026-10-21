/* Timeline starter: a day plan (itinerary, schedule, project plan). Days in order, stops in order, legs between.
 * You design the content in data.json; keep theme.css and site.js. Restyle only when asked.
 *
 * data.json:
 *   title, lede, map?    map: the https link of the same trip's map site (the lede then ends in "Map ↗")
 *   days: [{n, date: "2026-10-24", place, base?: {name, url}, note? (the day's own note: a warning, a plan B),
 *           stops: [{ref: "stop:museum", name, time?: fact, note?, facts?: [fact], sources?: [{name, url}]}],
 *           legs: [{from: "<stop ref>", to: "<stop ref>", mode: "walk"|"train"|…, duration: fact}]}]
 *   unchecked: ["what was not checked", …]
 *   fact: {"v": "10:00", "src": "Opening hours", "url": "https://…", "date": "2026-10-17", "est": false}
 * A time shows only when it has a source; otherwise the order carries the sequence. Five days or fewer are all
 * open; six or more fold, with day 1 (or ?day=<n>) open, and a folded day's caption counts what was not checked.
 * A leg's time is "Estimate" unless it has a source; give an estimate a "url" (a route search) so it ends in "how ↗".
 * A "Not checked" fact with a "url" ends in "where to check ↗". Rows: id="day-<n>", id="stop-<slug>", data-ref.
 * SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  "use strict";
  var h = site.h;
  var opened = {}; // days this viewer opened or closed: n -> true | false
  var scrolled = false;

  site.start({
    data: "data.json",
    state: { day: "" },
    select: function (ref, data) {
      var day = (data.days || []).filter(function (d) {
        return "day:" + d.n === ref || (d.stops || []).some(function (s) { return s.ref === ref; });
      })[0];
      if (!day) return null;
      opened[day.n] = true;
      return { day: String(day.n) };
    },
    render: render
  });

  /** "25 min walk", "2 h 10 by train". An estimate says "Estimate" in its caption, so no "About" in front. */
  function legText(leg) {
    var v = site.valueText(leg.duration);
    if (!v) return "";
    return v + (leg.mode === "walk" ? " walk" : leg.mode ? " by " + leg.mode : "");
  }
  /** Things on this day that were not checked (facts without a source, legs without a time). */
  function uncheckedCount(day) {
    var n = 0;
    (day.stops || []).forEach(function (s) { (s.facts || []).forEach(function (f) { if (f && !f.src && !f.est) n++; }); });
    (day.legs || []).forEach(function (l) { if (!site.valueText(l.duration)) n++; });
    return n;
  }

  function render(data, st) {
    site.head(data);
    var days = data.days || [];
    var fold = days.length >= 6;
    var current = st.day || (days[0] ? String(days[0].n) : "");
    var list = document.getElementById("list");
    list.replaceChildren();
    if (!days.length) {
      list.appendChild(site.empty("No days planned yet.", null, "Ask in chat to add some."));
    } else {
      list.appendChild(h("div", { "class": "list days" }, days.map(function (day) {
        var isOpen = opened[day.n] != null ? opened[day.n] : String(day.n) === current;
        return dayBlock(day, fold, isOpen);
      })));
    }
    var sources = [];
    days.forEach(function (d) {
      (d.stops || []).forEach(function (s) {
        sources = sources.concat(site.sourcesOf([s.time].concat(s.facts || [])));
        (s.sources || []).forEach(function (x) { sources.push(x); });
      });
      (d.legs || []).forEach(function (l) { sources = sources.concat(site.sourcesOf([l.duration])); });
    });
    site.notes(days.length ? data.unchecked : [], sources);
    if (!scrolled) {
      scrolled = true;
      var target = st.day && document.getElementById("day-" + st.day);
      if (target) target.scrollIntoView({ block: "start" });
    }
  }

  function dayBlock(day, fold, isOpen) {
    var stops = day.stops || [];
    var title = (day.date ? site.dayDate(day.date) : "Day " + day.n) + (day.place ? " · " + day.place : "");
    var open = uncheckedCount(day);
    var cap = h("p", { "class": "cap" }, stops.length + (stops.length === 1 ? " stop" : " stops"),
      open ? " · " + open + " not checked" : null,
      day.base && day.base.name ? [" · stay: ", site.link(day.base.url, day.base.name)] : null);
    var head = h("div", { "class": "day-head" }, h("h2", { text: title }), cap);
    // the day's own note (a warning, a plan B) above its stops, as the map's plan shows it
    var body = day.note ? h("div", { "class": "stack" }, h("p", { "class": "day-note", text: day.note }), stopList(day)) : stopList(day);
    var section = h("section", { "class": "day", attrs: { id: "day-" + day.n, "data-ref": "day:" + day.n } });
    if (!fold) {
      section.append(head, body);
      return section;
    }
    var details = h("details", { "class": "fold", attrs: { open: isOpen } },
      h("summary", { attrs: { "data-key": "day:" + day.n } }, head, site.icon("chevron")), body);
    details.dataset.shown = isOpen ? "1" : "0";
    details.addEventListener("toggle", function () {
      if ((details.open ? "1" : "0") === details.dataset.shown) return; // our own render, not the viewer
      details.dataset.shown = details.open ? "1" : "0";
      // keep every day as the viewer sees it now, so opening one never folds another away under their finger
      document.querySelectorAll("section.day > details.fold").forEach(function (d) {
        opened[d.parentNode.id.slice(4)] = d.open;
      });
      if (details.open) site.setState({ day: String(day.n) });
    });
    section.appendChild(details);
    return section;
  }

  function stopList(day) {
    var stops = day.stops || [];
    var legs = (day.legs || []).slice();
    var timed = stops.some(function (s) { return s.time && s.time.src; });
    var ol = h("ol", { "class": "stops" + (timed ? " has-times" : "") });
    stops.forEach(function (stop) {
      ol.appendChild(stopRow(stop, timed));
      legs.filter(function (l) { return l.from === stop.ref; }).forEach(function (l) { ol.appendChild(legRow(l)); });
    });
    return ol;
  }

  function stopRow(stop, timed) {
    var time = stop.time && stop.time.src ? site.valueText(stop.time) : "";
    var facts = (stop.facts || []).map(function (f) { return h("div", null, site.trust(f)); });
    return h("li", { "class": "stop", attrs: site.rowAttrs(stop.ref, "stop") },
      timed ? h("span", { "class": "time", text: time }) : null,
      h("div", { "class": "stop-body" },
        h("span", { "class": "name", text: stop.name }),
        stop.note ? h("p", { "class": "cap", text: stop.note }) : null,
        facts,
        stop.sources && stop.sources.length ? h("p", { "class": "cap" }, stop.sources.map(function (s, i) {
          return [i ? ", " : "", site.link(s.url, s.name)];
        })) : null));
  }

  function legRow(leg) {
    var text = legText(leg);
    var fact = Object.assign({}, leg.duration || {}, { v: text });
    return h("li", { "class": "leg" }, text ? site.trust(fact) : h("span", { "class": "trust", text: "Not checked · how long it takes" }));
  }
})();
