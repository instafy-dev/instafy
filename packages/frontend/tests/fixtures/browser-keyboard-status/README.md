# Browser keyboard and status review

This fixture mounts the production `RemoteBrowserMobileKeyboard`,
`PersonalBrowserSurface`, and `BrowserSessionModal`. Only the controller SDK,
collaboration state, native bounds bridge and remote viewer boundaries are inert.
It has no account, credentials, remote page or live browser transport.

Start from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/browser-keyboard-status/vite.config.ts --port 5332
pnpm exec playwright test --config tests/fixtures/browser-keyboard-status/playwright.config.ts
```

The same spec also runs against the generic CI transform server, using route-level
service stubs rather than the review server's plugin:

```sh
pnpm exec playwright test --config playwright.ci-ui.config.ts browser-keyboard-status.spec.ts --reporter=list
```

This is a focused check. The full required lane retains its coverage reporter;
running only this spec does not claim that the complete lane passed.

Use `/tests/fixtures/browser-keyboard-status/index.html?surface=keyboard&theme=light`.
Surfaces: `keyboard`, `keyboard-inline`, `personal-opening`, `personal-error`,
`personal-retrying`, `shared-opening`, `shared-connected`. Use `theme=dark` and
`version=before` for comparison labels. Both keyboard surfaces keep the closed
keyboard's icon in a toolbar: `keyboard` sits over the page and puts its icon in
the toolbar's slot, as the browser view does; `keyboard-inline` sits in the
toolbar, as a shared tab does. Viewport width must be set by the browser,
not simulated by a smaller div; use 320, 390, 768 and 1280px. Set `hasTouch` below
640px. Touch controls intentionally remain hidden for a fine mouse pointer. The
suite also covers a 768px touch tablet: the input keeps 16px native text and its
utilities keep 44px targets even above a desktop-sized typography breakpoint.

For an opening compact Shared card, use an actual desktop viewport of 1280×700.
Production policy opens Shared browser fullscreen on mobile and under 620px high.
Its connected card branch is currently unreachable through public props/state;
the fixture does not fake React internals to display it. `shared-connected`
therefore reviews the reachable connected surface.

For a before server, set `INSTAFY_REVIEW_BASELINE_SRC` to the complete previous
frontend `src` directory, then launch on another port. Both versions use the same
fixture, production component imports, boundaries and shared CSS compilation.

The browser spec covers pointer-aware visibility, focus/open/close, typing/paste,
IME commit de-duplication, Backspace/Enter routing, pending retry with retained
focus and blocked duplicate activation, fullscreen
opening, long diagnostic wrapping and horizontal overflow in both themes.
`window.__browserKeyboardStatusReview` records callback effects without exposing
diagnostic counters in the screenshots. Retry completion is controlled by
`finishRetry()` so busy state can be inspected reliably.

Reducing the browser viewport to 420px simulates available space when a keyboard
is present. It does **not** validate physical Android/iOS keyboard appearance,
safe-area behavior or native IME integration; those need a real device pass.
