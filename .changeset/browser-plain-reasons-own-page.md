---
---

Octo explains a page that would not load in plain words. When the network does not deliver a page, the Shared Browser's result now leads with a plain reason ("Instafy's browser couldn't reach that site", "couldn't find that site", "That site's secure connection failed", "kept redirecting") and keeps the browser's code (`net::ERR_…`) only in its details; the browser policy and the browser skill tell Octo never to paste raw error codes into a reply. A browser turn that starts on a page another chat left open is told so, and starts its own task there instead of describing that page as where it resumed. No package changes.
