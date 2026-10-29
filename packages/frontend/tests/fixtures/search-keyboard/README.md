# Studio search with a short viewport

This fixture uses the production search hook, search styles and mobile history
controls inside the Studio search-shell structure. Search records and callbacks
are inert; it does not authenticate or make controller requests.

Run from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/search-keyboard/vite.config.ts --host 127.0.0.1
pnpm exec playwright test --config tests/fixtures/search-keyboard/playwright.config.ts
```

The fixture also works under `vite.ci-ui.config.ts`; set
`INSTAFY_SEARCH_KEYBOARD_URL` to that server for the focused command. Query options
are `theme=light|dark`, `state=results|error|loading|empty` and `many=1`.

The browser regression checks 320/360/390px keyboard-sized viewports and desktop,
both themes, search/focus/activation, index-explanation scrolling, native safe
areas, loading and error recovery. Short browser viewports model Android's
resized WebView; they do not prove a physical keyboard or native system bars.
