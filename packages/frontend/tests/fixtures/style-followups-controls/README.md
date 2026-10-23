# Sidebar and local-tab shared styles

Run from `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/style-followups-controls/vite.config.ts
```

Open `/tests/fixtures/style-followups-controls/index.html` on port 5242. Query parameters:

- `surface=sidebar|spaces|shared-tab`
- `theme=light|dark`
- Local-tab `state=following|requested|control|exploring|browse-requested|disconnected`
- Sidebar `state=error` shows retry.
- `controls=0` hides the fixture-only buttons that simulate approval.

All controls, popovers, modal, parsers and keyboard UI are production components. Only local-tab transport/video data is replaced. The frame is a locally generated JPEG; requests update local socket data and never access real pages, credentials or controllers. Sidebar callbacks record inert actions. Width determines the same desktop/mobile panel distinction; pointer media controls target density.

Selectors: `local-tab-toolbar`, `local-tab-view-mode`, `local-tab-explore-action`, `local-tab-control-action`, `local-tab-reconnect`, `sidebar-project-switcher-menu`, `sidebar-project-switcher-close|back`, `sidebar-project-search-toggle`, `sidebar-project-new`, `review-action-log`. More opens `Shared tab options`; mode opens `Shared tab view`; Expand/Minimize exercise the real fullscreen dialog. Browser requests can be approved using the two fixture footer buttons.

A before server uses `INSTAFY_REVIEW_BASELINE_SRC` and `--port 5243`; the common review config substitutes production source text while keeping identical fixture data.

Use `pane=300` to review a narrow embedded browser on a wide screen. Release remains inline in wider panes and moves into More below 360px of actual pane width so the mode label remains readable. Focused behavior regression:

```sh
pnpm exec playwright test --config tests/fixtures/style-followups-controls/playwright.config.ts
```

The regression covers touch and mouse narrow panes, keyboard focus, request/cancel and release placement. These are inert component tests, not authenticated transport tests.
