# Find running shoes

A phone-first compare grid for four shortlisted running shoes. Each cell shows **value · source · age**, has a
↻ to check again, and shows a skeleton while a check runs. Everyone viewing sees the same results live; the size
field is per person (kept in that browser only).

| Intent | Executor | What it does | Lane |
|---|---|---|---|
| `read_offer` | script, `handlers/read_offer.mjs` | Fetches the product page and reads its schema.org `Product` / `ProductGroup` / `Offer` / `AggregateOffer` JSON-LD: price (lowest in-stock), list price, stock, sizes listed and in stock, colours, and your size when the page lists stock per size | `local` |
| `check_size` | agent (Octo turn) | Octo opens the page in its browser, picks your size and reports stock and price | `assist` |

**Why lane `local`.** `read_offer` is a script on this machine reading a public page, not an open-data
download (`open`) or an official API (`official`), so its records say `local`. The binder accepts only `open`,
`official` and `local` from scripts; agent records are `assist`.

## Run it

From the repo root:

```sh
node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/shoes --port 4174
```

Open the printed URL (with its `#k=` token) on your phone or in two windows. Enter your size, tap
**Check all prices**. Progress shows per cell ("Fetching karhu.com · 1/3"), then the grid fills in both windows.

- ↻ on a cell re-runs the intent that produced it.
- 🐙 in **Your size** asks Octo. With an Instafy login (`instafy login`, or `INSTAFY_ACCESS_TOKEN` +
  `INSTAFY_CONVERSATION_ID`/`INSTAFY_SPACE_ID`) it runs a real turn. Without one, add `--dry-run` to see the
  rendered prompt:

  ```sh
  node packages/instafy-bind/bin/instafy-bind.mjs serve packages/instafy-bind/examples/shoes --port 4174 --dry-run
  ```

To try the full agent loop without an account, point the binder at a mock controller (the binder's own
`tests/mock-controller.mjs` implements the controller calls) with `--server-url`, `--conversation` and
`INSTAFY_ACCESS_TOKEN`.

Drive the view from chat ("show me B"):

```sh
node packages/instafy-bind/bin/instafy-bind.mjs command packages/instafy-bind/examples/shoes select '{"ref":"B"}'
node packages/instafy-bind/bin/instafy-bind.mjs command packages/instafy-bind/examples/shoes highlight '{"refs":["shoes:norda-005","shoes:karhu-fusion-5"]}'
```

`select` takes a ref or a column letter.

Run the handler alone:

```sh
cd packages/instafy-bind/examples/shoes
echo '{"intent":{"params":{"url":"https://nordarun.com/products/005-m-zephyr","ref":"shoes:norda-005","size":"10"}}}' \
  | node handlers/read_offer.mjs
```

Tests (parser, SSRF guard, handler against a local fixture server):

```sh
node --test packages/instafy-bind/examples/shoes/test/*.test.mjs
```

## The shortlist (checked 2026-10-11)

| | Shoe | Page | JSON-LD shape | Sizes in the data |
|---|---|---|---|---|
| A | Altra Vanish Pulse | altrarunning.com | `ProductGroup` → `hasVariant` by colour → `Offer` (USD) | no, so 🐙 is the way |
| B | On Cloudmonster 2 | on.com | `@graph` `ProductGroup` → variants by colour, `Offer` + `ListPrice` (USD, on sale) | no |
| C | norda 005 | nordarun.com | `@graph` `Product` → `offers[]`, one per size (CAD, or EUR when visiting from Europe) | yes, US (`M10`) |
| D | KARHU Fusion 5.0 | karhu.com (EU store) | `@graph` `ProductGroup` varying by size (EUR) | yes, EU (`44`) |

Prices come in two or three currencies (the stores localise by visitor), so the page only marks a "lowest"
within one currency and says so under the grid.

Pages that did not work for a script read, for the record: Topo Athletic (no JSON-LD on the product page),
Brooks, Inov-8 and New Balance (403 / bot wall to a plain fetch), Hoka and Vivobarefoot (JavaScript challenge),
Atreyu (works, but every size was sold out). Those are what `check_size` (an Octo turn with a browser) is for.

## Safety

- `read_offer` fetches `https:` only and refuses private, loopback, link-local and LAN addresses (checked on
  every DNS answer at connect time and on every redirect). `--allow-local` lifts this for local fixtures only.
- It reads typed JSON-LD fields only and stores short facts, never page copy.
- The `check_size` prompt tells Octo to report only what the page shows, decline cookie banners and never add
  to cart, sign in or accept terms; the binder appends the same rules and the output contract.
- Records are rendered with `textContent`; links open only if they are `https:`.

## Files

| File | What |
|---|---|
| `index.html`, `style.css`, `app.js` | The page (no build step) |
| `bound.json` | `read_offer` (script) and `check_size` (agent) |
| `data/items.json` | The shortlist: ref, letter, brand, model, URL |
| `handlers/read_offer.mjs` | Script handler |
| `handlers/lib/offers.mjs` | JSON-LD → `instafy.records@1` (pure, tested) |
| `handlers/lib/safe-fetch.mjs` | SSRF-guarded GET (self-contained, so the example's handler has no imports outside its folder) |
| `test/` | `node:test` tests with synthetic fixtures |
