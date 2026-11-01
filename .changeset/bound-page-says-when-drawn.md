---
"@instafy/cli": patch
---

A bound site's page that draws its first view after it loads now tells the Studio preview when it has drawn, so the preview keeps saying it is opening the site, with the page out of sight, until the page shows its content, instead of showing the page's placeholder rows while it fetches its data. The bind client has `instafyBind.drawsLater()` and `instafyBind.drawn()`: the layout's acknowledgement lists `ready`, and `ready` is sent once, after the first view is drawn. The starters' `site.start()` (`site.js` 1.6.0) calls both: when it starts, and once its first view, or the notice saying the data did not load, is on the page.
