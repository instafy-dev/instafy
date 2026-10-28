---
---

Instafy's browser proxy now logs each destination it could not open, with a fixed reason: the site did not answer in time, refused the connection, was unreachable, its name was not found, or the safety policy denied it. Chromium shows all of them as the same `net::ERR_TUNNEL_CONNECTION_FAILED`, and the proxy used to log nothing, so a page that would not load could not be explained afterwards. A line names the request kind, port and reason, never the host, path or address, and at most 30 lines are written a minute. No package changes.
