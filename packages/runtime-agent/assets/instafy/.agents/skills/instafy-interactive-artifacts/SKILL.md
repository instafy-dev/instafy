---
name: instafy-interactive-artifacts
description: Use when the answer should be a page the user taps through, not a long chat reply (map, ranking, comparison or shopping table, dashboard, quiz, timeline, planner, tracker, checklist). Picks the builder from the installed skills and shows the site in Studio with `instafy preview open`.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: interactive, map, maps, tap through, dashboard, quiz, timeline, planner, tracker, calculator, comparison table, side by side, checklist, ranking, ranked, top 10, shortlist, compare, versus, shopping, cheapest, best price, where to buy, which to buy, should i buy, visualize, interaktiv, tidslinje, planerare, kalkylator, checklista, jämförelse, tablero, ダッシュボード
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
  unknown. Facts carry their trust: `checked 17 Oct on maker.com`, `€549 at Shop · seen 17 Oct`, `checked 4 min
  ago`, `Estimate`, `Unknown`.
- Options side by side: each value names the page it was read on and the day; one nobody found reads `Unknown` and
  why ("no price on maker.com's page"), never a blank or a dash. A filter from a stated limit ("under €600") counts
  known values only: an item whose value is unknown is listed apart ("Price unknown"), never as within it, on the
  page, in the lede and in the reply. The starters do this with `site.byFilter`; a page you write uses it too. A
  candidate nothing could be read for is still a row, with `Unknown` in each cell: a page of options is never empty
  ("No options yet") while a page you read named what to compare.
- Keep sort, filters and the open tab in the URL query and give rows ids, so links and Studio's Follow keep them.
- Every item the request names (stops, products, entries) is on the page, or the reply says plainly which is
  missing and why. Check before the card with the builder skill's own check, else
  `instafy bind check <dir> --expect "<item>,<item>"`; it also lists blank values, values without their page or
  date, and a filter applied without `site.byFilter`. Fix each.
- Facts come from pages you opened this turn, never from memory: the builder skill's source or fetch command when
  it has one, else `instafy-web-research` (its "Comparing items" for prices and reviews per item) or Instafy's
  browser (`instafy-browser-automation`). Keep each fact's link and date.
- "Near me": never `navigator.geolocation` (Studio blocks it); `await instafyBind.location()` per
  `instafy-bound-sites`, with a typed place as a fallback.

## 3. Serve it and show it

1. One command, from the site's folder, starts it so it outlives your turn and posts its card:
   `instafy preview open --title '<short title>' --serve-cmd "<serve command>" --start --json`, with `{port}` where
   the serve command takes its port. The serve command is the builder skill's; a bound or plain site's is
   `instafy bind serve . --port {port} --preview`. It picks the port: never choose one.
2. `instafy preview check --port <port>` (the JSON's) loads it as Studio does: fix every error it lists and look at
   the phone screenshot.
3. Never post preview, tunnel or localhost URLs. A public link only when the user asks for one:
   `instafy-frontend-previews`.
4. After an edit no new card is needed; reload open viewers if the builder can (`instafy bind command <dir>
   reload '{}'`). If the server stopped, rerun the same `instafy preview open`.

## 4. Reply

2-5 lines in the user's terms: the verdict, what the page lets them do, what is unverified, and ONE `Assumed:` line
for the defaults you chose. End with 2-3 short suggested replies they can send as-is (adjustments of what you
assumed). The card speaks for itself: never point them to it. No file paths, commands or "validation passed".
