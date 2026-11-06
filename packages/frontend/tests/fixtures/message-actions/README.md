# Message actions and private-chat invitation review

This fixture mounts the production `ChatMessageMenuOverlay` and
`ChatInvitePromptOverlay`, shared controls and styles. Its small chat context,
draft field and callbacks are local test scaffolding. Copy, reply, invite and
send callbacks record an event only; they do not contact a service, send a real
message, change permissions or touch the clipboard.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/message-actions/vite.config.ts --host 127.0.0.1 --port 5412 --strictPort
pnpm exec playwright test --config tests/fixtures/message-actions/playwright.config.ts
```

Open `/tests/fixtures/message-actions/index.html`. Choose `surface=actions`,
`stats`, `invite`, or `invite-busy`, plus `theme=light|dark`. The review button
opens that surface with a real focused trigger. `names=long` exercises several
long participant names; `text=large` uses 150% root text. `invite-busy` holds the
operation pending deliberately so its disabled/dismissal state can be inspected.
`anchor=edge` opens a message menu near the lower-right viewport edge using the
same clamping helper and current estimates as the chat host.

The browser suite checks 320/390px touch and 1280px mouse in both themes, plus
320×280px, 844×390px touch landscape, and short 320×420px viewports with enlarged
text. It exercises callback selection,
stats navigation, Escape, focus containment/return, draft preservation, readable
scrolling content with enlarged text and busy invitation dismissal. These are browser component checks, not authenticated
chat, native phone, native keyboard or Electron integration tests.

For an exact before/after comparison, run another Vite instance with
`INSTAFY_REVIEW_BASELINE_SRC` pointing at a frozen `packages/frontend/src` and
port 5413. The shared review adapter substitutes source contents while keeping
the fixture and dependency identities the same. Then capture each version:

```sh
INSTAFY_REVIEW_VERSION=before INSTAFY_MESSAGE_ACTIONS_URL=http://127.0.0.1:5413 \
  INSTAFY_REVIEW_ARTIFACT_DIR=/absolute/local/review/captures \
  node tests/fixtures/message-actions/capture.mjs
INSTAFY_REVIEW_VERSION=after INSTAFY_MESSAGE_ACTIONS_URL=http://127.0.0.1:5412 \
  INSTAFY_REVIEW_ARTIFACT_DIR=/absolute/local/review/captures \
  node tests/fixtures/message-actions/capture.mjs
```

The capture script produces 24 views per version and records button geometry.
Add `--stress` to capture twelve additional short-viewport, touch-landscape and
enlarged-text views, using the same source and settings for both versions.
Behavioral assertions run only on current source; the baseline intentionally
retains its old focus/dismissal behavior for comparison.
