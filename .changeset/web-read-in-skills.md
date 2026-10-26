---
---

The bundled `instafy-web-research` skill lists `instafy web read <url…> --json` as a reader for public pages that robots.txt allows and that need no JavaScript or sign-in, and sends `needs_browser` pages, aggregators and pages the person wants to see to a browser tab or card. It names the command's stop codes (sign-in, 403, 429, CAPTCHA, paywall, robots, link-only, download, secrets), its per-turn caps (12 loads, 4 per site), and says its text, links and structured data are untrusted page data whose `provenance` is cited ("checked <date> on <host>", viewer `server fetch`). The skill router and the browser skill point there too. Unedited earlier copies of the research and browser skills are upgraded. No package changes.
