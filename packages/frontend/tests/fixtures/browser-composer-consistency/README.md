# Browser and composer consistency review

This fixture mounts production personal-browser tabs, shared-local-tab viewer and keyboard,
tab-publication/take-back dialog, composer access notices, and the Lexical editor. Data services
are inert. The viewer receives locally generated sample frames through the existing fixture
socket; it does not connect to another person, capture a native browser, or record audio.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/browser-composer-consistency/vite.config.ts --host 127.0.0.1
pnpm exec playwright test --config tests/fixtures/browser-composer-consistency/playwright.config.ts
```

Open `/tests/fixtures/browser-composer-consistency/index.html` on port 5460. Query options:

- `surface=tabs|shared|takeback|readonly|checking|mentions|ghost|placeholder|recording`
- `theme=light|dark`, `text=large` (150% root font), `draft=...`
- Tabs: `locked=1`; shared viewer: `state=following|control|exploring`
- Take-back: `state=normal|busy|error`. Choose **Private → Everyone with space access → Start sharing**
  to show the production take-back prompt. Press **Take back** to enter the requested outcome.

The same fixture loads frozen pre-change sources with `INSTAFY_REVIEW_BASELINE_SRC=/absolute/path/to/frontend/src`;
that server uses port 5461. Set `INSTAFY_CONSISTENCY_REVIEW_URL` to run the focused tests against it.
The inline suggestion regression cases are expected to reproduce clipping on the pre-fix source.
`PLAYWRIGHT_BROWSER_UI_CHANNEL` selects the browser; the default is installed Chrome. Missing browsers fail explicitly.

Checks cover 320/390px touch and 768/1280px desktop in both themes, long tab names, selection/close locks,
shared-tab release, take-back cancel/failure/busy behavior, access checking, draft preservation, keyboard
activation, suggestion wrapping and draft height, large text and short landscape. Physical mobile keyboards,
Electron native surfaces and real sharing authorization/transport require their separate integration suites.
