---
"@instafy/cli": patch
---

`instafy web read` says what a stopped page leaves open. The address asked for and where it redirected are still never read another way, and the person still gets the plain link; the site's other pages (such as each product's own page, when a listing page is closed to bots) and other sources can still be read, each checked on its own. A stop of the whole site (a link-only site, a 429 or bot check, or a robots.txt that refuses every page, whether it cannot be read or its rules keep an agent it checks out of every path, as `Disallow: /` does) leaves only other sources, and says so. The note no longer ends "use a different source", which read as "leave this site".
