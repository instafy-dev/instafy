---
name: instafy-interactive-artifacts
description: Use when the answer should be a page the user taps through, not a long chat reply (map, ranking, comparison or shopping table, dashboard, quiz, timeline, planner, tracker, checklist). Picks the builder from the installed skills and shows the site in Studio with `instafy preview open`.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: interactive, map, maps, tap through, as a page, on a page, into a page, small page, simple page, one page, shareable page, dashboard, quiz, timeline, planner, tracker, calculator, comparison, comparison table, side by side, checklist, ranking, ranked, top 10, shortlist, compare, versus, shopping, cheapest, best price, where to buy, which to buy, should i buy, visualize, interaktiv, tidslinje, planerare, kalkylator, checklista, jämförelse, tablero, ダッシュボード
---

# Interactive artifacts

The page holds the detail; chat holds a short reply. One site per request.

A message that asks for a page gets this chat's own page, in its own folder, also when another chat has made one on
the subject: build it. "Made in another chat" (the space's pages) answers only a request to change that page.

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

- Phone-first (never wider than the screen, one column when narrow), no build step, no secrets in the page. Render
  text with `textContent`; only open `https:` links.
- Light and dark, like the starters' `theme.css`: a page you write sets its dark colours, with `color-scheme: dark`,
  under `:root:not([data-theme="light"])` inside `@media (prefers-color-scheme: dark)` and under
  `:root[data-theme="dark"]` (Studio's theme, which `instafy bind serve` puts on `<html>`). Never
  `color-scheme: light` alone; one look only when asked.
- One primary button per page; no search, filter or sort nobody asked for, and no sort by a value no row has. A
  comparison still gets a `sort` entry, with `dir`, for each amount the person compares by (a price, a weight, a
  size), the main one first, never for a number in a name (a chip, a model, a version): under 5 options no row moves,
  the page names the option each puts first under its title ("Lowest price: Option B"), and a phone shows the first
  one's value on each row. Facts carry their trust: `checked 17 Oct on maker.com`, `€549 at Shop · seen 17 Oct`,
  `checked 4 min ago`, `Estimate`, `Unknown`, each drawn by the starter's `site.trust` or `site.cite` from the fact's
  `"viewer"` (how it was read), never typed. A tip no page gave is plain text, never styled like a source line.
  A tool or step nobody ran (a planner whose form was never sent) gets a caption that links it by its name and says
  "not run", with no day. A page says what it shows, never "I".
- Options side by side: each value names the page it was read on and the day; one nobody found reads `Unknown` and
  why, as `instafy-comparing` says, never a blank or a dash. A note on the page never names the tools, searches or
  services you used. A value cites only a page that gives it: a count of
  what you found cites only what it counts, so none found cites no page. A filter from a stated limit ("under €600")
  counts known values only: an item whose value is unknown is listed apart ("Price unknown"), never as within it, on
  the page or in the reply. The starters do this with `site.byFilter`; a page you write uses it too. A
  candidate nothing could be read for is still a row, with `Unknown` in each cell: a page of options is never empty
  ("No options yet") while a page you read named what to compare. An item whose own page wasn't opened is "not
  checked (its own page wasn't opened)" in the reply, and each of its unknown values has `"note": "its own page wasn't
  opened"`. A value whose page you couldn't read is not checked: only its `"url"` (where to check) and
  `"note": "its page couldn't be read"`, never a sentence about how that page is built. A value says only what its
  page or search result says: what nobody read is "not checked", never "not stated in the page read".
- Options asked for from what you already know, with nothing looked up: the compare starter with `"from": "memory"`,
  each value only its `"v"`, from your own knowledge, never from the space's other pages. No `src`, `url`, `date`,
  store or filter (`instafy bind check` fails them): the starter reads each value "<value>, not checked" and says
  "From what Octo knows; nothing checked." under the title.
- Keep sort, filters and the open tab in the URL query and give rows ids, so links and Studio's Follow keep them.
- Every item the request names (stops, products, entries) is on the page, or the reply says plainly which is
  missing and why. Check with `instafy bind check <dir> --expect "<item>,<item>"` (it also lists blank values, values
  without their page or date, a source line with no link, and a filter applied without `site.byFilter`) and fix what
  it lists; a check that passes posts the card. A failing check never holds the card back: it names the card's
  command. Only two findings hold it until they are fixed: files loaded from outside the page's folder, and a typed
  "checked <date>" or "seen <date>": delete those words, never reword them (a day that is the page's own content
  goes in a cell of its own). Until then the card's own command posts no card either. A site with no binder, such
  as a map a builder skill hosts: post the card first (step 3), then run that skill's own check.
- Facts come from pages you opened this turn, never from memory unless asked (above): the builder skill's source or
  fetch command when it has one, else `instafy-web-research` (`instafy-comparing` for prices and reviews per item)
  or Instafy's browser (`instafy-browser-automation`). Keep each fact's link and date.
- "Near me": never `navigator.geolocation` (Studio blocks it); `await instafyBind.location()` per
  `instafy-bound-sites`, with a typed place as a fallback.

## 3. Serve it and show it

1. A page `instafy bind check` checks gets its card from that check (above), whose answer gives its port. Any other
   site: one command, run inside the site's folder, starts it so it outlives your turn and posts its card:
   `(cd sites/<slug> && instafy preview open --title '<short title>' --start --json)`. A builder skill's site adds
   that skill's `--serve-cmd "<serve command>"`, with `{port}` where it takes its port. It picks the port: never
   choose one.
2. `instafy preview check --port <port>` (the JSON's) loads it as Studio does: fix every error it lists and look at
   the phone screenshot.
3. Never post preview, tunnel or localhost URLs. A public link only when the user asks for one:
   `instafy-frontend-previews`.
4. After any edit, check again. No new card is needed: once your change is saved, every open view of the page loads
   it again by itself. If the server stopped, rerun the same `instafy preview open`.

## 4. Reply

2-5 lines in the user's terms: the verdict, what the page lets them do and what is unverified. The first line says
what the page has, as `instafy bind check`'s last line counts it ("The page shows 1 of 9 values: …"), never something
it lacks (prices, reviews, a route it doesn't show). Values whose page couldn't be read are named once, as not
checked, with an offer to look in Instafy's browser. An `Assumed:` line only for a default you chose that the person
didn't give (dates, a currency, which models), and none when there is none. A page they want to share says in one line
who can open it (people in this space) and how to get a link anyone can open (ask for a public link), not as an
assumption. The card speaks for itself: never point them to it or say it opened. No file paths, commands, "validation
passed", "the provided read" or "updated for viewers".
