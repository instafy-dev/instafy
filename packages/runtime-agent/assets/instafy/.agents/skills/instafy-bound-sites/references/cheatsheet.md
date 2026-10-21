# Bound sites cheat sheet

## Files

```
site/                   instafy bind init <dir> --starter compare|ranked|timeline|checklist|blank
  index.html, app.js    the page (loads theme.css, site.js, __bind/client.js); you write app.js
  theme.css, site.js    the shared look and helpers: keep them
  data.json             seed items with refs; every fact {"v", "src", "url", "date", "asof"?, "est"}
  bound.json            intents (below)
  data/records/*.json   written by the binder (instafy.records@1); never by you or a handler
  handlers/*.mjs        script handlers (optional)
```

## bound.json

```jsonc
{
  "version": 1,
  "intents": {
    "read_offer": {
      "label": "Read price", "emoji": "🏷️",
      "executor": "script", "handler": "handlers/read_offer.mjs",
      "params": { "type": "object", "required": ["url", "ref"], "additionalProperties": false,
        "properties": { "url": { "type": "string", "format": "uri", "maxLength": 500 },
                        "ref": { "type": "string", "pattern": "^shoes:[a-z0-9-]{1,50}$" },
                        "size": { "type": "string", "maxLength": 12 } } },
      "target": { "records": "data/records/read_offer.json" },
      "lanes": ["local"], "pending": "item", "cooldown_s": 15, "timeout_s": 45
    },
    "check_size": {
      "label": "Ask Octo", "executor": "agent",
      "agent": { "prompt": "Open {{url}}. Is size {{size}} in stock? … claim attr {{attr}} for ref {{ref}} …",
                 "allowed_origins": ["https://www.example-store.com"], "lane": "assist", "timeout_s": 300 },
      "params": { "...": "every {{name}} in the prompt must be a declared param; a ref param with a pattern is required;
                          free-text params get a pattern or enum; url params must be inside allowed_origins" },
      "target": { "records": "data/records/check_size.json" }, "pending": "cell:size", "cooldown_s": 30
    }
  },
  "results": { "files": ["data/records/read_offer.json", "data/records/check_size.json"], "poll_s": 3, "sse": true }
}
```

Schema keywords allowed in `params`: type, properties, required, additionalProperties:false, enum, const,
default, minimum, maximum, minLength, maxLength, pattern, items, minItems, maxItems, format (date, date-time,
uri), title, description. Params ≤ 4 KB.

## Script handler (NDJSON on stdout)

```js
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();          // {intent, bound, site}; site is an object, not a path
const { ref, url } = intent.params;
await main();                                      // a module cannot `return` at top level: use a function

async function main() {
  const item = (kit.readJson("data.json").items || []).find((i) => i.ref === ref);   // the site's own files
  if (!item || item.store.url !== url) return kit.error("invalid", "unknown item or store URL");
  const host = new URL(url).hostname.replace(/^www\./, "");
  const blocked = (note) => { kit.records([kit.uncertain({ ref, attr: "price", url, note })]); kit.done(note); };
  kit.progress(1, 2, `Reading ${host}`, host);
  let page;
  try { page = await kit.fetch(url); }             // refuses private addresses and paths robots.txt disallows
  catch (err) { return blocked(`${host} could not be read (${err.message}); open the store link`); }
  if (!page.ok) return blocked(`${host} blocks automated price checks (HTTP ${page.status}); open the store link`);
  const html = await page.text();                  // also: await page.json()
  const [offer] = await kit.offers(html);          // the price the page states in its schema.org offers
  if (!offer) return blocked("no price data on the page; open the store link");
  kit.records([{ type: "offer", oid: kit.rid("off", ref, host), ref, price: { amount: offer.amount, currency: offer.currency },
    seller: { name: item.store.name }, prov: { source: host, url } }]);
  kit.done(`${offer.currency} ${offer.amount}`);
}
```

`kit.fetch` throws when a site refuses the connection, sends something unreadable, or refuses automated reads
(robots.txt disallows the path for bots: error code `policy`): catch it and still answer for that
item with `kit.uncertain({ref, attr, url, note})`, so every row ends with a value or a reason. Error code
`unavailable` = the site did not answer (down, timed out, 5xx): the note says it could
not be checked right now ("shop.com did not answer; check again later"), never that the item is gone; the row's
button is the viewer's retry. Try every script
intent before you reply: `instafy bind try <dir> <intent> '{"ref":"…","url":"…"}'` runs it as a click would and
exits 1 on a crash, an error or a rejected record; with `--save` its records stay on the page (fill every item so
the page opens with prices). The binder
stamps a script record's missing `prov.observed_at`, `ttl_s`, `lane` (`local`) and `source` (the URL's host); a
job whose every record is rejected ends as an `error` event, which the page must show in the cell.

## Records (`instafy.records@1`)

```jsonc
{ "type": "claim", "cid": "clm_on-cm2_in_stock_on.com", "ref": "shoes:on-cloudmonster-2", "attr": "in_stock",
  "value": "In stock", "label": "Stock", "status": "ok", "basis": "live", "confidence": "high",
  "prov": { "source": "on.com", "source_label": "On Shop", "lane": "local", "url": "https://www.on.com/…",
            "observed_at": "2026-10-11T15:04:09Z", "ttl_s": 21600, "class": "live" } }

{ "type": "offer", "oid": "off_on-cm2_on.com", "ref": "shoes:on-cloudmonster-2",
  "seller": { "name": "On Shop", "trust": "curated" },
  "price": { "amount": 140, "currency": "USD", "kind": "sale" }, "availability": "in_stock",
  "handoff": { "url": "https://www.on.com/…", "label": "Open on on.com" }, "basis": "live", "prov": { "…": "…" } }

// A script that could not read the page still answers, with a valid basis (never "unverified"/"blocked"):
{ "type": "claim", "cid": "clm_on-cm2_price_on.com", "ref": "shoes:on-cloudmonster-2", "attr": "price",
  "value": null, "label": "Price", "status": "uncertain", "basis": "live", "confidence": "low",
  "note": "on.com blocks automated reads; open the store link",
  "prov": { "source": "on.com", "lane": "local", "url": "https://www.on.com/en-us/",
            "observed_at": "2026-10-11T15:04:09Z", "ttl_s": 3600 } }

{ "type": "item", "iid": "osm_123", "layer": "found", "kind": "cafe", "name": { "en": "…" },
  "geo": { "lng": 121.5, "lat": 25.0 }, "prov": { "…": "…" } }
```

- `ref`: `<kind>:<id>` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[A-Za-z0-9_.:-]{1,120}$`; the intent's envelope `ref` must
  match this too). `cid/oid/iid`: `^[A-Za-z0-9_.:-]{1,96}$` (agent replies may leave them out).
- `attr`: `^[a-z][a-z0-9_]{0,47}$`. `value`: string ≤ 140, number, boolean or null.
- `basis`: measured, routed, counted, estimated, registry, filed, live, brand, user_note, editorial, modelled, inferred.
- `status`: ok, not_found, uncertain, error. `confidence`: high, medium, low.
- `prov` needs `source`, `lane`, `observed_at`, `ttl_s`. Lanes: link, official, open, capture, feed, assist, local.
  Script records may only use open, official or local; agent records are `assist` (or `capture`), carry the
  clicked ref only, and get `prov.observed_at` from the binder's clock. The binder stamps `prov.intent`/`prov.job`
  on all. URLs must be `https:`.
- `price.kind`: total, nightly, from, regular, sale, member. `availability`: in_stock, out, unknown.

**Merge:** same key → newer `observed_at` wins. Claims with the same `(ref, attr, prov.source, prov.lane)` replace
each other, so put anything per-person (a size, a date) into the `attr` (`size_10`) or the offer's `variant.label`.
An `assist`/`capture` record never replaces one from another lane.

## Client (`__bind/client.js`)

```js
const bind = window.instafyBind;
const { connected, names, byName } = await bind.ready;    // names = intents a click can run here (also bind.names)
const id = bind.intent("read_offer", { url, ref }, { ref, ui: "cell" });
bind.on("progress", (m) => status(m.progress.message));    // m.progress = {step?, of?, message?, source?}
bind.on("done", (m) => status(""));                         // m.summary, m.count; "error": m.error.message
bind.on("error", (m) => status(m.error.message));           // done and error end the job: clear its status
bind.on("records", render); bind.on("pending", render);      // pending: a click started, moved or ended (redraw
                                                             // whatever isPending draws, e.g. a "Checking…" button)
// also ack (m.status: queued|running), results (m.records), command, records (store changed)
bind.records("shoes:on-cloudmonster-2");                    // merged store; bind.pending() → your intent ids
bind.isPending(ref, "read_offer");                           // any viewer's click on that ref is running
bind.ageText(r); bind.expired(r); bind.retry(r);             // "4 min ago"; past ttl_s; re-send prov.intent
bind.cancel(id);                                             // your own click only
// Ask Octo (an agent intent) is in names only where Instafy sends it as the clicker's message (ack m.status "sent",
// then done); byName.check_size.disabled is why this person cannot, so show the button disabled with that text
const ask = byName.check_size;
if (ask) askButton({ label: ask.label, disabled: Boolean(ask.disabled), title: ask.disabled || "" }, () => bind.intent("check_size", { url, size, attr, ref }, { ref }));
```

Age: < 1 min "now", < 60 min "N min", < 24 h "N h", else "9 Sep". Expired = now > observed_at + ttl_s.

## Location ("near me")

`instafyBind.location()` is the one call: on a page of its own it asks the browser. In a frame it asks only the
host that frames it, when that host says it answers location requests. Studio's side of that (one browser prompt
for Instafy and a 📍 marker showing which site has the position) is not built yet, so in Studio's preview card
today `location()` rejects with code `unavailable` and the message "Location is not available in this preview
yet." Never call `navigator.geolocation` yourself, and give every "near me" page a typed place too (a city or
postcode field), so it works in the card and anywhere location is refused.

```js
const pos = await instafyBind.location();                    // {coords: {latitude, longitude, accuracy}, via}
const watch = instafyBind.location({ watch: true }, (p) => move(p.coords));   // follow me; watch.stop() when done
// errors: err.code denied | unavailable | timeout | stopped | hidden; show err.message as is, then the typed place
```

On `stopped` say "Location is off for this site · turn it on in Studio's menu for this preview" (the page's own
button cannot undo a stop). The position is the person's: send it to a handler as intent params, never into records.
Records are shared with every viewer and saved with the site, so return the places with their own coordinates and
compute distances in the page. The binder keeps coordinate params (and any listed in the intent's
`"private_params"`) out of `prov.intent`, so `retry(r)` cannot re-send them: search again with a fresh `location()`.
An "Ask Octo" click becomes a chat message everyone in the conversation reads: the client rounds a position to
about 100 m and leaves `"private_params"` out of it.

## Follow mode (one person presents, the others' copies follow)

The starters already do this (`site.state` / `site.setState`, row ids and `data-ref`); the recipe is for a page you
write yourself. Studio's Present / Follow needs nothing from a page that loads `__bind/client.js`: while someone presents it shares
the path, the URL query and hash, the element with an id at the top of the window and the scroll position, and
followers' pages get the same query (`popstate`) and scroll. So keep sort and filters in the query and give rows ids:

```js
const state = () => { const q = new URLSearchParams(location.search); return { sort: q.get("sort") || "price", size: q.get("size") || "" }; };
function setState(next) {                                     // a sort button or the size filter
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(next)) v ? q.set(k, v) : q.delete(k);
  const s = q.toString();
  history.replaceState(history.state, "", location.pathname + (s ? "?" + s : "") + location.hash);
  render();
}
addEventListener("popstate", render);                         // a presenter's view arrives as a new query
// render(): rows from state(), each <tr id="row-<slug>"> so followers scroll to the same row
```

State that is not in the address (an open panel, a scroller inside the page): `instafyBind.follow({ get: () =>
({ panel }), apply: (s) => openPanel(s.panel) })`, ≤ 2 KB. Never put the viewer's position in the query. Once a page
has called `location()`, views leave out its query, hash and state (only the scroll goes) unless the presenter shares
location; a page whose view never holds the position says so with `follow({ ..., locationFree: true })`. Mark the
"me" marker `data-instafy-private` so a tap on it stays home. Studio's Present / Follow side is not built yet: the
page is ready for it. `packages/instafy-bind/examples/follow-table` is the whole thing.

## Commands

`instafy bind serve <dir> [--port 4180] [--preview] [--allow-local] [--allow-env NAME] [--public-url <tunnel url>]
[--detach [--log <file>]]` (`--preview`: no viewer token, for `instafy preview open --port <port>`; `--detach`: keeps
serving after your turn; `--agent-executor` is the owner's own option, never yours) ·
`instafy bind command <dir> <name> '<json args>'` (select, highlight, toast, reload) ·
`instafy bind init <dir> [--starter <name>] [--force]` · `instafy bind confirm <dir> <job>` · `instafy bind doctor [dir]`

## Restyle on request

Only when the person asks. Tokens first: `--if-*` overrides in a `<style>` after `theme.css`
(`:root { --if-accent: #b4235a; }`, with the dark value under the same two dark selectors theme.css uses). Then
component rules (`.card`, `.btn`, `.seg` …) in that `<style>`. Edit `theme.css` itself only for a whole new look.
Never a second parallel theme, a webfont, a gradient or pill buttons unless asked. "Always dark":
`<html data-theme="dark" data-theme-fixed>`.

## Writing the content (every starter)

- Lede: the verdict, plus the biggest unknown about the title's question ("None was tested for flat feet; try
  the Brooks first."). A row names only its own unknown. The footer ("Still to confirm") holds only what the page
  does not already say (not the lede's unknown, not a cell's "Not listed"), each as something the reader can do
  ("Check train times on Taiwan Railway before you book"), never how you worked ("no timetable was read").
- `date` is the day you read the page ("seen 17 Oct"); add `asof` when the source dates the fact itself
  (shown instead: "seen 5 Aug"; a price over 30 days old also says "may have changed"), so an old list price never
  looks fresh. A store known to block checks gets `"readable": false` from the start (no button that will fail).
- When every price or most of a column comes from one source on one date, the starters say it once under the list.
- A seller's own product copy names itself as such (`"src": "Fleet Feet product page"`), so it never reads as a review;
  a feel or ride from it is the seller's words in `why` too ("the store calls it gently guided"). Plain words over
  brand names for features ("firm rails at the heel", not "GuideRails").
- A badge only for a label the person must notice. "Our pick" only for your own pick, with the reason in `why`;
  a source's pick or award says whose ("BabyGearLab's top pick", "BabyGearLab: best budget") and is the row's
  badge, not something behind "Details".
- An estimate you made (a leg time, a walk) names its basis: a `src` and `url` ("Estimate · Taiwan Railway ↗")
  or a route-search `url` ("Estimate · how ↗"). "Not checked" means nobody checked it; a fact with a `url` says
  where to check. A page you read that does not give the value is `{"src", "url", "date"}` without `v`: "Not listed ·
  Fleet Feet product page ↗". On a checklist the same reads "To confirm" ("checked" is the tick there).
- A review site's price is its list price, `"list": true`: the row says "list price" next to the store link, so it
  never reads as the store's price today, and the line under the list names the source once; the lede need not say
  it again.
- No control nobody asked for: compare shows "Sort by" only with 5+ options (otherwise rows keep the order in
  `items`, so list them in the lede's order); one filter only from a stated constraint. A per-person checklist (`people`) asks "Whose list is this?" before showing any ticks.
- Details holds only what the row does not already show. No emoji in labels or notes.

## Products and prices

- Check each product is the current model before you name it, in chat too: open the maker's line-up page or a review
  from the last 12 months and lead with the newest generation; call an older one "previous generation" (often
  discounted), and never judge a budget from an old list price.
- A review site's price is its list price (`"list": true`, its date in `asof`: "$900 · list price on BabyGearLab ↗ ·
  seen 5 Aug"). A store's price is a check record or a page you opened, with store, link and date.
- Before a store becomes a price-check target, open its product page once as a script would (`instafy bind try`):
  a store that refuses (403, a bot check, robots.txt) stays a plain link, and the price button goes to stores that
  serve schema.org Product/Offer data to automated reads. Check this turn; never assume.

## Worked example: "find me running shoes, I'm a US 10"

1. Shortlist 3-4 shoes of the current generation (Products and prices, above);
   `instafy bind init shoes --starter compare`, then write `data.json` (`ref`, name, why, facts, store, sources).
2. `bound.json`: `read_offer` (script, `handlers/read_offer.mjs`, params `{url, ref, size?, attr?}`, lane
   `local`; an `uncertain` claim with a note when the store blocks the read) and, as an extra, `check_size`
   (agent, prompt "Open {{url}} … is size {{size}} in stock … claim attr {{attr}}").
   The page computes `attr` (`size_10`) so per-person sizes never overwrite each other.
3. The page: the compare starter's table (a list on phones) with Price, Stock, Your size, Sizes, Store; "Check all
   prices" as the page's one primary button and no button per row (a row's caption says "Check price" only when it
   is the one row that can be checked, "Try again" after an error, "Open <store> ↗" when blocked); "Ask Octo to
   check" only inside a row's Details. A price you copied from a page you opened is seed data, the row's
   `"price": {"v": "$145", "src": "Fleet Feet", "url": "https://…", "date": "2026-10-17"}`, shown as
   "$145 at Fleet Feet ↗ · seen 17 Oct" until a live check gives a record. Before the
   reply fill the grid: `instafy bind try shoes read_offer '{"url":"…","ref":"shoes:…"}' --save` per readable
   store (the records carry source and age like a click's).
4. Serve `shoes` detached with `--preview` on port 4180 and run `instafy preview open --port 4180 --title "Running
   shoes"` (step 7). When the user writes "show me the On", run
   `instafy bind command shoes select '{"ref":"shoes:on-cloudmonster-2"}'`.
5. "Add the Guide 19 and drop anything over $160": edit `data.json` (and `app.js` if needed), then
   `instafy bind command shoes reload '{}'` so every open viewer shows the new list, and reply.

