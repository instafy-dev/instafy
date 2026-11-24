---
"@instafy/cli": patch
---

`instafy web read`'s answer for an address nobody gave the turn (`code: "not_given"`) no longer ends "Never link, cite or card this address." Not reading it says nothing about the page, so its `tell` now asks the turn to keep the address's link where the person, a file they attached, or a page or search result in the chat gave it, and never to link, cite or card an address it put together itself. A turn told never to pass such an address on dropped the correct link to a page the chat had read before its runtime started again.
