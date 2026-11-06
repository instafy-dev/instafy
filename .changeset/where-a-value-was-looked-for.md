---
"@instafy/cli": patch
---

On a page of options, a value the page that was read does not give now reads "Not found · checked 17 Oct on maker.com ↗", saying where it was looked for, instead of "Not listed", which said the page lacks it. On a phone, such a value is named once, in its card's "Not found yet" line, with the page it was looked for on ("Weight (checked 17 Oct on maker.com ↗)"). A store page whose price a live check cannot find says "price not found on the shop.example page", and `instafy bind check`'s hint for a value that says nothing gives that wording too. Pages made before keep their own copy of `site.js` and `app.js`.
