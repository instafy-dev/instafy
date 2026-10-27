# Composer panels review

This fixture mounts the production composer action menu, queued-message and
stashed-draft popovers, Stop confirmation, and browser Take over confirmation.
All account, storage, controller and runtime boundaries are inert. It needs no
backend and cannot send messages, stop real work or take control of a browser.

From `packages/frontend`, run:

```bash
pnpm exec vite --config tests/fixtures/composer-panels/vite.config.ts
pnpm exec playwright test --config playwright.composer-panels.config.ts
```

Open `http://127.0.0.1:5310/tests/fixtures/composer-panels/index.html` and use
`surface=menu|commands|connect|queue|queue-edit|stash|stop|takeover` and
`theme=light|dark` query parameters. `longName=1` exercises a long Stop label.
For Take over, `outcome=error` returns an inert error and `outcome=pending`
waits until the fixture receives the `composer-panels:resolve-takeover` window
event; the test releases it after checking pending dismissal guards.

The spec also installs the inert data-module routes itself so it can run in the
normal `component` Playwright project without this fixture's custom Vite plugin.
Its matrix covers 320/390px touch and 768/1280px mouse viewports in both themes,
keyboard navigation, safe confirmation defaults, queue reordering and editing,
stash restoration, focus restoration, and viewport overflow.

For a local before/after review, the Vite configuration supports
`INSTAFY_REVIEW_BASELINE_SRC` pointing to a pre-change `src` snapshot. That server
uses port 5311; snapshots and screenshots stay outside the repository.
