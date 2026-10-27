---
"@instafy/cli": patch
---

The web-research skill's link-only list now gives each site a `kind` and the terms it rests on. `instafy web read` never fetches a `no-agents` site (its terms bar AI agents or automated access, and a site with no kind or an unknown one), nor a wrapper's copy of one, as before; a `no-reuse` site (its terms bar copying, not reading) is read, robots.txt included, and comes back with `noReuse` and a `tell` on how its content may be used, and links to one are marked `noReuse`. A space's copy of the list can add sites or make one stricter, never looser. New `instafy web link <site> [name=value…]` gives the link a person opens in their own tab for a `no-agents` site (guided mode): the site's search template from the list, filled with values checked against the list's placeholders and URL-encoded, https on the site's own hosts, or its home page and what to type there when the site bars deep links. It refuses unknown placeholders and reads nothing.
