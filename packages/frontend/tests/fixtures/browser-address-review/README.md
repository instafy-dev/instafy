# Browser address and recent-site review

This fixture mounts production `SharedBrowserChrome` and its `BrowserAddressField`.
It seeds the real local history store under a fixed fixture-only user ID. There is
no account, controller, remote browser or authentication session. Navigation only
records an event and updates the inert current page. Example URLs use reserved
`.test` domains, and fixture CSP prevents external favicon requests.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/browser-address-review/vite.config.ts --host 127.0.0.1 --port 5427
pnpm exec playwright test --config tests/fixtures/browser-address-review/playwright.config.ts
```

Open `/tests/fixtures/browser-address-review/index.html`. Use `theme=light|dark`,
`layout=split` for a 360px pane in a wide app, or `text=large` for 150% root text.
Click the mobile address field or focus the desktop input, then clear the address
to show recent sites. Titles, URLs and a title-less history entry exercise wrapping
and truncation. History changes persist for the current browser context.

The browser suite covers:

- Desktop title filtering, semantic option labels/descriptions, ArrowDown/Enter,
  Tab without navigation, Escape, keyboard access to Clear recent sites, and
  leaving the history footer in both directions.
- Phone invalid input, correction and Go, clearing the address and history,
  cancellation, control loss, focus restoration and 44px touch sizing.
- Rotation and keyboard-sized viewports without replacing the input or losing its
  selection, 320px enlarged text, 600px mouse-trigger sizing, and a narrow split pane.

The keyboard history traversal regression also runs in the required browser CI
lane through `browser-chrome-mobile-layout.spec.ts`.

Capture the review matrix with:

```sh
INSTAFY_REVIEW_ARTIFACT_DIR=/tmp/browser-address-review node tests/fixtures/browser-address-review/capture.mjs
INSTAFY_REVIEW_ARTIFACT_DIR=/tmp/browser-address-review node tests/fixtures/browser-address-review/capture.mjs --stress
```

The regular matrix covers 320px, 390px and 1280px in both themes. Stress captures
include a 360px split pane, 320px enlarged text, a rotated 844px editor, a 390×300
keyboard-sized viewport, and the closed 600px mouse trigger with enlarged text.
Set `INSTAFY_REVIEW_SURFACES=recent,filtered` for a subset and
`INSTAFY_BROWSER_ADDRESS_URL` to override the server. The shared review Vite loader
can serve an immutable source archive through `INSTAFY_REVIEW_BASELINE_SRC`.
`INSTAFY_REVIEW_VERSION=before` labels those captures and defaults to port 5429.

Touch emulation and resized visual viewports do not prove real Android/iOS IME,
autofill, browser chrome, or native soft-keyboard behavior. Those require a physical
device or native simulator. The fixture also does not test remote navigation.
