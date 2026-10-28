---
"@instafy/cli": patch
---

`instafy web search` no longer tells Octo to stop and ask the person when a space has no search key, finds nothing or cannot search. Its `tell` says to go on without it: find official sites with `--chain reference-search` (no key), read them and the pages of publishers that cover the topic with `instafy web read`, then answer or build the page with what was read, each missing fact marked unknown with why. The key card in `offer` may go in the reply once, as a way to search next time, and is never waited for. Reference search's own `tell` points to reading official sites directly, never back to itself. `instafy web read` names the address with `www.` added or removed once when a site's own address does not answer (`unreachable` or `timeout` on the address asked for, not after a redirect), since some sites answer only at one of them. It names it once a turn: not when that address did not answer either, so the two never send a turn back and forth.
