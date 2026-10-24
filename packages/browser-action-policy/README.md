# @instafy/browser-action-policy

Secret redaction and step classification for browsers an agent drives. Two
hosts use the same files:

- the Desktop Personal Browser bundles them from this workspace package;
- the hosted Shared Browser controller in runtime-agent embeds the source.

Both files are plain scripts with no imports and no build step. Loaded through
CommonJS they export their API. Evaluated where `module` is undefined, they
publish it on `globalThis.__instafyBrowserRedaction` and
`globalThis.__instafyBrowserActionPolicy`; load `redaction.js` first.

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
  a change (Save, Speichern, a floppy disk), which the Shared Browser still asks
  for under routine browsing. Menu items, tabs, tree items, disclosure and menu
  openers and navigation-area items never carry it.
  `unnamedControlName(hints)` names a control the page left unnamed from its
  tooltip attribute, image text, icon and position, so a prompt never shows an
  index such as "button 5".

The tests live with the Desktop Personal Browser
(`packages/desktop-app/test/personal-browser-redaction.test.mjs`,
`personal-browser-action-policy.test.mjs` and the risky-steps fixtures) and with
the Shared Browser controller (`packages/runtime-agent/src/shared_browser_tests.rs`).
See [Personal Browser](../../docs/Personal-Browser.md) and
[Shared Browser](../../docs/Shared-Browser.md).
