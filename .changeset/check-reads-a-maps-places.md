---
"@instafy/cli": patch
---

`instafy bind check` reads a site's GeoJSON data files too, so a map's places (its layers in `data/<layer>.geojson`) count as shown. A map that showed every place the request named was reported as missing all of them, because the check read only HTML and `.json` files. What a map lists as not found yet (its config's `"missing"`) still does not count.
