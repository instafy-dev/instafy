---
name: instafy-interactive-artifacts
description: Use when the answer should be a page the user taps through, not a long chat reply (map, ranking, comparison or shopping table, dashboard, quiz, timeline, planner, tracker, checklist). Picks the builder from the installed skills and shows the site in Studio with `instafy preview open`.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: interactive, map, maps, tap through, dashboard, quiz, timeline, planner, tracker, calculator, comparison table, side by side, checklist, ranking, ranked, top 10, shortlist, visualize, interaktiv, tidslinje, planerare, kalkylator, checklista, jämförelse, tablero, ダッシュボード
---

# Interactive artifacts

The page holds the detail; chat holds a short reply. One site per request; follow-ups change the same site.
Never stop to ask before building: a vague ask gets sensible defaults, stated in the reply.

## 1. Pick the builder

Read the Skills index first. Installed skills, including skill packs that ship with the runtime, can build their
own kind of page.

- **A skill whose description covers this kind of page** (for example a map skill for anything on a map): read its
  SKILL.md in full and build with its commands. Never hand-write what it generates.
- **Values that change or must be checked per click** (prices, stock, opening hours): a bound site per
  `instafy-bound-sites`.
- **Anything else:** the closest starter, `instafy bind init sites/<slug> --starter compare|ranked|timeline|checklist|blank`:
  compare = 2-8 options side by side; ranked = "top N", "best X"; timeline = days or steps in time; checklist =
  packing, to-dos; blank = quiz, calculator, the rest. Keep `theme.css` and `site.js`; write `data.json` and
  `app.js`. Restyle only when asked.
- A request that needs many items researched first (several stops, products or options, each looked up live):
  `instafy-research-team` plans the research, then builds here.

## 2. Build

- Phone-first, no build step, no secrets in the page. Render text with `textContent`; only open `https:` links.
- One primary button per page; no search, filter or sort nobody asked for. The lede: the verdict plus the biggest
  unknown. Facts carry their trust: `seen 17 Oct`, `checked 4 min ago`, `Estimate`, `Not checked`.
- Keep sort, filters and the open tab in the URL query and give rows ids, so links and Studio's Follow keep them.
- Every item the request names (stops, products, entries) is on the page, or the reply says plainly which is
  missing and why. Check before the card with the builder skill's own check, else
  `instafy bind check <dir> --expect "<item>,<item>"`.
- Facts come from pages you opened this turn, never from memory: the builder skill's source or fetch command when
  it has one, else Instafy's browser (`instafy-browser-automation`). Keep each fact's link and date.
- "Near me": never `navigator.geolocation` (Studio blocks it); `await instafyBind.location()` per
  `instafy-bound-sites`, with a typed place as a fallback.

## 3. Serve it, then show it

1. Start it so it outlives your turn, on a free port (4173-4199): the builder skill's serve command as it says;
   a bound or plain site with `instafy bind serve <dir> --port <port> --preview --detach`.
2. `instafy preview open --port <port> --title '<short title>' --json` (or `--serve-cmd "<command>" --start`
   per `instafy-frontend-previews`). Then `instafy preview check --port <port>` loads it as Studio does: fix every
   error it lists and look at the phone screenshot.
3. Never post preview, tunnel or localhost URLs. A public link only when the user asks for one:
   `instafy-frontend-previews`.
4. After an edit no new card is needed; reload open viewers if the builder can (`instafy bind command <dir>
   reload '{}'`). If the server stopped, start it again and rerun `instafy preview open`.

## 4. Reply

2-5 lines in the user's terms: the verdict, what the page lets them do, what is unverified, and ONE `Assumed:` line
for the defaults you chose. End with 2-3 short suggested replies they can send as-is (adjustments of what you
assumed). "Open it from the card above" (no link) only once the card is posted. No file paths, commands or
"validation passed".
