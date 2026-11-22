// The app.js of a page a turn made on the blank starter, as it was saved (its names and addresses changed): the hours
// and the tip from pages that were read, and a journey planner nobody ran, each with "checked <date>" typed after it.
(function () {
  "use strict";
  site.start({
    data: null,
    render: function () {
      var list = document.getElementById("list");
      var hours = site.h("article", { class: "card" },
        site.h("h2", { text: "Opening hours" }),
        site.h("ul", { class: "list" }, [
          ["Monday", "Closed"], ["Tuesday", "10 am–6 pm"], ["Wednesday", "10 am–6 pm"],
          ["Thursday", "10 am–8 pm"], ["Friday", "10 am–6 pm"], ["Saturday", "10 am–6 pm"], ["Sunday", "10 am–6 pm"]
        ].map(function (row) { return site.h("li", {}, site.h("strong", { text: row[0] + ": " }), row[1]); })),
        site.h("p", {}, site.h("strong", { text: "Tip: " }), "Choose Thursday for the latest regular closing time (8 pm). ", site.link("https://museum.example/en/plan-your-visit/", "The museum · checked 20 Nov 2026 on museum.example")));
      var route = site.h("article", { class: "card" },
        site.h("h2", { text: "From the main station" }),
        site.h("p", { text: "The museum lists the main station as 1 km away and gives an 8-minute travel time. Its page links to the city's timetable for the museum's stop, but the operator's planner did not show route details, so the specific connection is not confirmed." }),
        site.h("p", {}, site.h("a", { href: "https://transit.example/en/timetable.html?fromname=Main%20station&toname=Museum", target: "_blank", rel: "noopener", text: "Check the Main station → Museum timetable ↗" })));
      var sources = site.h("footer", { class: "notes" },
        site.h("p", {}, "Hours and distance · ", site.link("https://city.example/en/visit/culture/museum", "The museum on city.example"), " · checked 20 Nov 2026"),
        site.h("p", {}, "Route planner · ", site.link("https://transit.example/en/timetable.html?fromname=Main%20station&toname=Museum", "City timetable"), " · checked 20 Nov 2026; route details not confirmed"));
      list.replaceChildren(hours, route, sources);
    }
  });
})();
