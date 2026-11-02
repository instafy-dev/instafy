# Chat reading space

Inert visual and interaction fixture for the transcript next to a browser pane.
It renders the production transcript viewport, message rows, identities, stopped
turn, browser approval, typing row, surface tabs, composer and resizable panels.
The adjacent page is explicitly a static sample; no browser transport, remote
runtime, model call or authenticated account is involved. Theme setup also sets
CSS `color-scheme`, matching production so native scrollbar tracks follow dark mode.

The composer adapter's standalone minimum height is removed only in this host:
the actual composer is positioned over the transcript, as it is in ChatPanel.
Scrollbar measurements flow from the viewport to the composer through the same
optional props as the production chat.

## Run

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/chat-pane-reading-space/vite.config.ts
pnpm exec playwright test --config tests/fixtures/chat-pane-reading-space/playwright.config.ts
```

Open `/tests/fixtures/chat-pane-reading-space/index.html`. Query options:

- `theme=light|dark`
- `people=solo|group`
- `state=working|completed`
- `status=busy` — a wrapped waiting message with an idle face
- `pane=420|560` — initial chat width at desktop sizes
- `layout=full` — chat without the sample browser
- `scrollbar=classic` — native Chromium scrollbar styled to 12px for reproducible
  clearance diagnostic; omitted uses the actual production shared scrollbar preset
  on pointer-driven desktop and native styling on coarse pointers
- `stress=1` — long unbroken source URL and code block
- `typing=multi&warning=1` — peer typing, multiple agents and workspace recovery
- `sameHandle=1&people=group` — same-named agents with distinct profile identities
- `timeline=1` — completed exchanges spanning yesterday, today and a same-day
  break longer than one hour; `people=group` adds a human and a custom agent
  within the final continuous stretch

The review tests cover 320/390px mobile, 420/560px chat panes in a 1280px window,
1440px full chat, both themes, working/completed states, both participant layouts, classic scrollbar
reservation, matching composer/transcript edges, keyboard profile activation,
local approval dismissal, draft preservation across resizing and scrolling, multi-agent
typing, recovery warnings, resizing across the identity breakpoint, and horizontal
overflow. Mobile matrix cases use touch/coarse-pointer Chromium emulation.
The actual message menu exposes its timestamp through keyboard and native
emulated long-press; Escape returns keyboard focus. Desktop forced-colors
fallback is checked as well. Browser approval decisions are recorded locally rather than sent.

## Before/after captures

Set `INSTAFY_REVIEW_ARTIFACT_DIR` to an untracked artifact directory to save PNGs.
For a baseline, extract the desired commit's `packages/frontend/src`, point
`INSTAFY_REVIEW_BASELINE_SRC` at that source directory and start another fixture
server on port 5374. The shared review config supplies baseline source without
changing the current working tree. Run the same test with
`INSTAFY_REVIEW_VERSION=before`; this captures identical data and layout but skips
assertions for the new identity and spacing behavior.

This fixture verifies the shared UI in Chromium. It does not replace native
Electron, operating-system scrollbar or physical-device testing.

## Time divider review

The separate timeline suite fixes the clock to 2 November 2026 at 13:00 in
Europe/Vienna before navigation. It checks the first dated message, a local day
change and a one-hour gap using semantic timestamps, without asserting localized
copy in browser tests. It also verifies chronology, contiguous replies, custom
agent identity, compact layout, preserved drafts after resizing, and exact
message timestamps through keyboard-accessible message actions.

```sh
pnpm exec playwright test --config tests/fixtures/chat-pane-reading-space/time-dividers.playwright.config.ts
```

Set `INSTAFY_TIME_REVIEW_ARTIFACT_DIR` to save screenshots at the start and end
of the same transcript. The separate pre-divider baseline runs on port 5375
with `INSTAFY_REVIEW_BASELINE_SRC` pointing to its immutable source snapshot;
`INSTAFY_TIME_REVIEW_VERSION=before` runs the same data and layout against it.
The after suite uses the existing live fixture on port 5372. This does not replace or
overwrite the original reading-space baseline and comparison images.
