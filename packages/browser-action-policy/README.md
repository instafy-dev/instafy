# @instafy/browser-action-policy

Secret redaction, step classification and sent-page reading for browsers an
agent drives. Two hosts use the same files:

- the Desktop Personal Browser bundles them from this workspace package;
- the hosted Shared Browser controller in runtime-agent embeds the source.

The files are plain scripts with no imports and no build step. Loaded through
CommonJS they export their API. Evaluated where `module` is undefined, they
publish it on `globalThis.__instafyBrowserRedaction`,
`globalThis.__instafyBrowserActionPolicy`,
`globalThis.__instafyBrowserPageCapture` and
`globalThis.__instafyBrowserFormSubmission`; load `redaction.js` first.

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
- `formSubmission.js`: `formSubmissionRulesInPage()` runs inside a page (or an
  isolated world) and computes the submission a form step makes, as the
  browser does: a submit button's `formaction`, `formmethod`, `formenctype` and
  `formtarget` over the form's own, Enter through the form's default button
  (a disabled one blocks it), `<base href>` and `<base target>`, frame names
  and `method="dialog"`. Both browsers report it as `formActionUrl`,
  `formMethod`, `formEnctype`, `formTarget`, `formNewWindow`, `formSubmission`
  and `formSubmits`, which `actionPolicy.js` judges. `stepSubmission(facts,
  step, key)` says which steps submit and where to. Publishes
  `globalThis.__instafyBrowserFormSubmission`. `formSubmissionCases.json` is
  the one table of form steps both browsers' tests run.
- `pageCapture.js`: `pageSecretSignalsInPage(sources)` runs inside a page and
  answers the four yes/no secret checks that `redactPageObservation` takes.
  `captureSentPage(redaction, options)` reads a page a person chose to send
  with **Send page to Octo**: it runs in an isolated world next to
  `redaction.js`, masks the address, title and text with the snapshot rules,
  and returns no text for a secret screen or a page it could not check.
  `maskSentPage` is the masking step on its own, for a host that reads the
  page another way. Publishes `globalThis.__instafyBrowserPageCapture`; load
  `redaction.js` first.

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
