# Status feedback review

This fixture renders the production status provider, browser chrome and recovery,
workspace availability provider and banner, and preview feedback lane. Only the
workspace availability probe and optional assistant composition are inert. It
does not connect to an account, workspace, provider, or remote browser.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/status-feedback/vite.config.ts --port 5392
pnpm exec playwright test --config tests/fixtures/status-feedback/playwright.config.ts
```

The second command runs Chromium, Firefox, and WebKit and starts the fixture if
needed. Missing browser binaries fail explicitly; install them with Playwright
before running. `PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome` selects installed Chrome
for the Chromium project only. The same spec is included in the required
Chromium browser UI lane, where route stubs provide the same inert boundaries.

Open `/tests/fixtures/status-feedback/index.html?surface=toast-action&theme=dark`.
Surfaces: `toast-warning`, `toast-error`, `toast-action`, `toast-unbroken`,
`confirmation`, `browser-feedback`, `browser-reconnecting`, `browser-recovery`,
`location`, `location-blocked`, `location-approval`, `follow`, `workspace`, and
`inline-notice`, and `behavior`. The behavior surface has inert Recovery error,
Information, six-second Undo and Copy controls for exercising priority and timing.
Use `text=short` for short copy. Toasts persist for review by
default; `timeout=<milliseconds>` exercises ordinary dismissal. Location notices
retain their production timers. `workspace=1` places a real availability banner
above browser chrome; `safeArea=1` supplies simulated insets; `textScale=2` doubles
the root font size. These are layout simulations, not physical keyboard, OS
safe-area, or browser text-zoom proof.
`paneWidth=300&paneHeight=220` exercises an independently constrained embedded
browser pane on a desktop viewport.

`window.__review` exposes `triggerToast`, `copy`, `undo`, `clear`, `reset`,
`setFeedback`, `retryFinish`, `getState`, `rerender`, `showPreview`, `setActive`,
and action counters. `recovery`, `information`, `deadlineUndo`, and `hide(id)`
exercise the shared behavior presets. Workspace controls are `workspaceSetResult`,
`workspaceHoldNext`, `workspaceRetry`, `workspaceState`, and, with `workspace=1`,
`triggerWorkspaceFailure` and `workspaceFinish`. Every response stays local.

Review both themes at 320, 390, 768, and 1280 pixels, including a short viewport,
keyboard focus, hover, long unbroken text, and simultaneous location and Send
feedback. The tests use Playwright's cross-browser clock API, not CDP emulation.
Behavior regressions cover focused replacement, clipping, recovery priority,
absolute Undo deadlines, and ownership-aware focus return after Stop/dismiss.
Do not replace production styles in this fixture to make a regression pass.
