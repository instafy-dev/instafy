# Browser boundary review

This fixture mounts the production conversation tabs, browser chrome and shared
browser panel with inert controller and transport boundaries. The page content
and composer are labeled samples. No authentication or remote runtime is used.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/browser-boundaries/vite.config.ts --port 5217 --strictPort
```

Open `/tests/fixtures/browser-boundaries/index.html`; add `?theme=dark` for dark
mode. Resize below 540px to inspect the full toolbar's wrapping controls.

For a local before/after review, `INSTAFY_BROWSER_BOUNDARIES_BASELINE_DIR` can
point to an external directory containing saved versions of
`BrowserSessionModal.tsx`, `BrowserChromeShell.tsx`, and
`ConversationSurfaceLayout.tsx`. These are loaded through the original module
paths, leaving their dependencies and all styles shared.

With the isolated server running, verify the desktop/mobile border ownership,
touch targets and keyboard/forced-colors selection:

```sh
pnpm exec playwright test --config tests/fixtures/browser-boundaries/playwright.config.ts
```
