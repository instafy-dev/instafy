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
  `{ verdict, category, reason, code? }` for a navigation, click, typing step,
  submission or key press. Free verdicts come only from structure; label words
  only add risk.

The tests live with the Desktop Personal Browser
(`packages/desktop-app/test/personal-browser-redaction.test.mjs`,
`personal-browser-action-policy.test.mjs` and the risky-steps fixtures) and with
the Shared Browser controller (`packages/runtime-agent/src/shared_browser_tests.rs`).
See [Personal Browser](../../docs/Personal-Browser.md) and
[Shared Browser](../../docs/Shared-Browser.md).
