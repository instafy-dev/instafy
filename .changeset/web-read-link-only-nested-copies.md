---
"@instafy/cli": patch
---

`instafy web read` finds more copies of link-only sites. The web-research skill's list now also names open fetch proxies (corsproxy.io, api.allorigins.win and others), 12ft.io and Yandex's page translator, and the matcher sees a copy inside another wrapper (Google Translate's proxy of an archive's or reader's copy), a site written anywhere in a wrapper's path or query however many other names come first, a host written with soft hyphens or zero-width characters, and a host with a label that is not valid punycode. A page whose links include such an address no longer stops the whole read with an error. An archive page that says it is a copy of a site listed as link-only after it was cached is no longer served from the cache.
