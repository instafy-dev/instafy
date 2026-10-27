# @instafy/browser-action-policy

Secret redaction, step classification, sent-page reading and link-only site
matching for browsers an agent drives. The hosts use the same files:

- the Desktop Personal Browser bundles them from this workspace package;
- the hosted Shared Browser controller in runtime-agent embeds the source;
- `instafy web read` (`@instafy/cli`) bundles `linkOnly.js` and `redaction.js`.

The files are plain scripts with no imports and no build step. Loaded through
CommonJS they export their API. Evaluated where `module` is undefined, they
publish it on `globalThis.__instafyBrowserRedaction`,
`globalThis.__instafyBrowserActionPolicy`,
`globalThis.__instafyBrowserPageCapture` and `globalThis.__instafyLinkOnly`;
load `redaction.js` first.

- `redaction.js`: masks key-like values in page text, titles, addresses and
  control names, and decides when a page is a secret screen.
- `actionPolicy.js`: `classifyStep(op, target, ctx)` returns
  `{ verdict, category, reason, code?, commit? }` for a navigation, click,
  typing step, submission or key press. Free verdicts come only from structure;
  label words and the icons of icon-only controls only add risk. The
  exceptions are short whole-name lists that also need the right structure:
  cookie dismissals, page numbers and menu or section toggles ("Menü
  ein-/ausklappen", "Toggle navigation", or a hamburger icon on an unnamed
  button). `commit: true` marks an ordinary control whose label or icon commits
  a change (Save, Speichern, Umbuchen, Beleg erfassen, Stornobuchung, a floppy
  disk), which the Shared Browser still asks for under routine browsing. Menu
  items, tabs, tree items, disclosure and menu openers and navigation-area items
  never carry it, and a menu item named for a list ("Buchungen",
  "Stornobuchung") stays navigation.
  `unnamedControlName(hints)` names a control the page left unnamed from its
  tooltip attribute, image text, icon and position, so a prompt never shows an
  index such as "button 5".
- `pageCapture.js`: `pageSecretSignalsInPage(sources)` runs inside a page and
  answers the four yes/no secret checks that `redactPageObservation` takes.
  `captureSentPage(redaction, options)` reads a page a person chose to send
  with **Send page to Octo**: it runs in an isolated world next to
  `redaction.js`, masks the address, title and text with the snapshot rules,
  and returns no text for a secret screen or a page it could not check.
  `maskSentPage` is the masking step on its own, for a host that reads the
  page another way. Publishes `globalThis.__instafyBrowserPageCapture`; load
  `redaction.js` first.

- `linkOnly.js`: whether an address is on a site the `instafy-web-research`
  skill keeps link-only (`references/link-only-sites.json`, skill-owned data;
  this file only enforces it). `linkOnlyListFrom(bundled, additions)` compiles
  the bundled list plus what a space's copy adds (a copy only adds; one that is
  not a list is left out with a warning; no usable bundled list gives `null`,
  and a host then reads nothing). `linkOnlyMatch(list, address)` returns
  `{ site, why, via }` or `null`: hosts match however the address spells them
  (case, trailing dots, port, user info, IDN), and an address on one of the
  list's `wrappers` (a translator, cache, archive or reader proxy) is checked
  as the site it embeds, wherever the wrapper's `embeds` says that site is
  written. Wrappers nest: one that rewrites the host keeps the address's path
  and query for the wrapper inside. Every host written in a wrapper's path or
  query counts, an address of any length is checked, and one the URL parser
  refuses has its host read leniently; a copy the check cannot see through
  (nested too deeply, naming too many hosts, or a check that throws) is
  refused as "a site this check cannot rule out" rather than read.
  `mementoOriginals(header, base)` and `linkOnlyCopyOf(list, header, base)`
  read a response's Memento `Link: <…>; rel="original"` header, so a page an
  archive serves at a short address is checked as the page it copies. The
  readers run one table of cases, `test/link-only-cases.json`, through their
  own guards (a case's `pad` writes a long address out).

The tests live with the Desktop Personal Browser
(`packages/desktop-app/test/personal-browser-redaction.test.mjs`,
`personal-browser-action-policy.test.mjs`, `browser-page-capture.test.mjs`,
`personal-browser-send-page.test.mjs` and the risky-steps fixtures), with the
Shared Browser controller (`packages/runtime-agent/src/shared_browser_tests.rs`)
and with the origin's page reader
(`packages/origin-http-server/src/browser_page_capture_tests.rs`).
See [Personal Browser](../../docs/Personal-Browser.md) and
[Shared Browser](../../docs/Shared-Browser.md).
