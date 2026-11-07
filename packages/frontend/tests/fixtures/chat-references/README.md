# Chat references review

This fixture mounts production `MessageContent` with its real conversation-metadata and
conversation-file contexts. Workspace file reads and tab/status side effects are inert,
local substitutes. It sends no messages, invites no users, and calls no backend.

```sh
pnpm --filter @instafy/frontend exec vite --config tests/fixtures/chat-references/vite.config.ts --host 127.0.0.1
pnpm --filter @instafy/frontend exec playwright test --config tests/fixtures/chat-references/playwright.config.ts
```

Open `/tests/fixtures/chat-references/index.html?theme=dark&state=error` to exercise a
failed first read followed by successful Retry. `state=loading` delays the file response;
`text=large` increases root text size. The default state contains a long filename and a
highlighted source line.

Browser checks cover reachable quote-source targets, keyboard preview/Escape/focus return,
loading recovery, file opening without draft loss, long-press preview, and short/landscape
viewport bounds. Tests simulate mobile touch in Chromium; they do not certify native
Android/iOS lifecycle or Electron native-view behavior. The real message-route guard is exercised with an inert navigation callback, including exact source IDs and stale-space denial. Existing navigation integration tests own actual source-message scrolling/history.

For screenshots, set `INSTAFY_REVIEW_ARTIFACT_DIR` to an external output directory and run
`node tests/fixtures/chat-references/capture.mjs` from the frontend package. Capture before
from an immutable source snapshot using `INSTAFY_REVIEW_BASELINE_SRC` with a separate server
and `INSTAFY_REVIEW_VERSION=before`. No snapshots or private data belong in source control.
