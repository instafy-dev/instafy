# Browser picker and connection recovery review

This fixture mounts the production `SharedBrowserChrome` and `SharedLocalTabViewer`
components. It keeps the native tab selector and real JPEG decoding path while
replacing the share service, socket, and optional WebRTC video transport with inert
local data. It does not connect to a controller, authenticate a user, or grant input
control.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/browser-picker-review/vite.config.ts --host 127.0.0.1 --port 5424
pnpm exec playwright test --config tests/fixtures/browser-picker-review/playwright.config.ts
```

Open `/tests/fixtures/browser-picker-review/index.html`. Query options:

- `theme=light|dark`
- `surface=picker|recovery`
- `state=live|connecting|closed|error|reconnecting`
- `authority=none` disables tab selection and navigation while Octo has control.
- `layout=split` puts the browser in a 360px pane on a wide screen.
- `text=large` enlarges root text to 150% for a short, narrow screen.

The picker contains long titles and multiple agent-owned tabs. Recovery follows a
synthetic socket close or error through the actual viewer. `error` and `closed`
recover to a decoded page frame after Reconnect. `reconnecting` deliberately waits
until the test calls `window.__browserPickerReview.resume()` so pending behavior
can be inspected. Tests also cover closing before a connection resolves and a
share disappearing before retry.

For screenshots, start the fixture server, then run:

```sh
INSTAFY_REVIEW_ARTIFACT_DIR=/tmp/browser-picker-review node tests/fixtures/browser-picker-review/capture.mjs
INSTAFY_REVIEW_ARTIFACT_DIR=/tmp/browser-picker-review node tests/fixtures/browser-picker-review/capture.mjs --stress
```

The default matrix covers 320px, 390px and 1280px in both themes. Stress captures
cover a 360px split pane, 320px with enlarged text, and 844px landscape. Set
`INSTAFY_REVIEW_SURFACES=reconnecting` to capture one state, and
`INSTAFY_BROWSER_PICKER_URL` to override the server. An immutable source archive
can be served through the shared style-review Vite loader with
`INSTAFY_REVIEW_BASELINE_SRC`; `INSTAFY_REVIEW_VERSION=before` labels those captures
and defaults their server to port 5426.

The tests verify native type-ahead keyboard selection, full option labels,
disabled authority, pending retry focus, duplicate retry prevention, return of a
real decoded frame, stable focus after reconnect, and narrow-screen bounds.
Touch contexts simulate mobile Chromium. They do not verify physical-device
keyboard or operating-system picker sheets. Headless macOS Chrome does not drive
the native select popup with arrow keys; native type-ahead is tested instead.
