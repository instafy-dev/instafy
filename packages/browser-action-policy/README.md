# @instafy/browser-action-policy

Secret redaction, step classification, form submissions, sent-page reading and
link-only site matching for browsers an agent drives. The hosts use the same files:

- the Desktop Personal Browser bundles them from this workspace package;
- the hosted Shared Browser controller in runtime-agent embeds the source;
- `instafy web read` (`@instafy/cli`) bundles `linkOnly.js` and `redaction.js`.

The files are plain scripts with no imports and no build step. Loaded through
CommonJS they export their API. Evaluated where `module` is undefined, they
publish it on `globalThis.__instafyBrowserRedaction`,
`globalThis.__instafyBrowserActionPolicy`,
`globalThis.__instafyBrowserPageCapture`,
`globalThis.__instafyBrowserFormSubmission` and `globalThis.__instafyLinkOnly`;
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
  In a cookie or consent banner (the describer's `consentContext`), a
  refusal's button ("Reject all") is free with `consentRejection: true`, and a
  control or link whose words accept, agree or consent, or only allow
  ("Allow all cookies"), is refused
  (`step_refused_consent`): accepting is the person's step. An accept limited
  to the necessary cookies or to a selection ("Accept only necessary",
  "Accept selection") saves a refusal, so it asks with `commit: true` instead.
  `unnamedControlName(hints)` names a control the page left unnamed from its
  tooltip attribute, image text, icon and position, so a prompt never shows an
  index such as "button 5".
  `isFreeSiteSearch(target, pageUrl, submittedEntries)` is the stricter test
  the Shared Browser applies before it lets Enter in a site's own search box
  go without a prompt under routine browsing: Enter submits the form
  implicitly as a GET of the page's own origin in the same tab, to a public
  address, through a search field the classifier allows, sending at most 64
  `[name, value]` entries (the field with the typed text and the form's other
  controls, hidden ones included) none of which the redaction rules would
  mask, alone or as `name=value`, to an address that is not risky once those
  entries are its query (a hidden `format=csv` makes it an export).
- `formSubmission.js`: `formSubmissionRulesInPage()` runs inside a page (or an
  isolated world) and computes the submission a form step makes, as the
  browser does: a submit button's `formaction`, `formmethod`, `formenctype` and
  `formtarget` over the form's own, Enter through the form's default button
  (a disabled one blocks it), a click along its event path to the submit
  button it reaches (labels, plain buttons, fields and slotted elements pass it
  on; links, checkboxes and summaries take it), `<base href>` and
  `<base target>`, frame names and `method="dialog"`. Both browsers report it
  as `formActionUrl`, `formMethod`, `formEnctype`, `formTarget`,
  `formNewWindow`, `formSubmission` and `formSubmits`, which `actionPolicy.js`
  judges. `stepSubmission(facts, step, key)` says which steps submit and where
  to; a field inside a submit button (`nested`), which a click and Enter send
  in different ways, is one both hosts refuse. The rules' `sentFieldNames`
  names the fields a submission sends something from, by their label, legend
  or name attribute and never their values, for a prompt to say what a step
  sends. Publishes `globalThis.__instafyBrowserFormSubmission`. `formSubmissionCases.json` is
  the one table of form steps both browsers' tests run.
- `pageCapture.js`: `pageSecretSignalsInPage(sources)` runs inside a page and
  answers the four yes/no secret checks that `redactPageObservation` takes.
  `captureSentPage(redaction, options)` reads a page a person chose to send
  with **Send page to Octo**: it runs in an isolated world next to
  `redaction.js`, masks the address, title and text with the snapshot rules,
  and returns no text for a secret screen or a page it could not check. It also
  sends up to 200 of the page's web links (`pageLinksInPage`, which a host can
  run on its own), masked, with a link to a link-only site marked by name when
  the call passes `linkOnly: { api, sites }`; without it, no links.
  `maskSentPage` is the masking step on its own, for a host that reads the
  page another way. Publishes `globalThis.__instafyBrowserPageCapture`; load
  `redaction.js` first.

- `linkOnly.js`: whether an address is on a site the `instafy-web-research`
  skill keeps link-only (`references/link-only-sites.json`, skill-owned data;
  this file only enforces it). `linkOnlyListFrom(bundled, additions)` compiles
  the bundled list plus what a space's copy adds (a copy only adds; one that is
  not a list is left out with a warning; no usable bundled list gives `null`,
  and a host then reads nothing). Each site has a `kind`: `no-agents` (its
  terms bar AI agents or automated access; also a site with no kind or an
  unknown one) or `no-reuse` (its terms bar copying, not reading). Where
  several entries match, the strictest wins, so a space's copy can make a site
  stricter and never looser. `linkOnlyMatch(list, address)` returns
  `{ site, why, kind, via }` or `null`, and a reader refuses the address only
  when `barsAgents(match)`: hosts match however the address spells them
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
  own guards (a case's `pad` writes a long address out; `kind` says whether it
  is refused). `guidedLink(list, site, values)` is guided mode: it fills a
  site's `search` template with values checked against the list's
  `placeholders` (`text`, `date`, `count`) and URL-encoded, keeps the link
  https on the site's own hosts, refuses an unknown placeholder, and gives the
  site's `home` and what to type there when `deepLinks` is false
  (`instafy web link`).

The tests live with the Desktop Personal Browser
(`packages/desktop-app/test/personal-browser-redaction.test.mjs`,
`personal-browser-action-policy.test.mjs`, `browser-page-capture.test.mjs`,
`personal-browser-send-page.test.mjs`, `browser-form-submission.test.mjs` and
the risky-steps fixtures), with the Shared Browser controller
(`packages/runtime-agent/src/shared_browser_tests.rs`,
`scripts/shared-browser-form-submission-e2e.mjs`)
and with the origin's page reader
(`packages/origin-http-server/src/browser_page_capture_tests.rs`).
See [Personal Browser](../../docs/Personal-Browser.md) and
[Shared Browser](../../docs/Shared-Browser.md).
