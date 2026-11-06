# Search into an older conversation

This secret-free review mounts production search controls and scope chips,
`useStudioSearchHistory`, browser history controls, transcript rows, the real
scroll controller and newer-history intent hook, attachment viewers and composer.
Search for **navigation**, open the original message, inspect its image or notes,
then return to results or the latest message. Both routes preserve search context.

Only data boundaries are inert. The Storage download adapter serves a local
repository image and Markdown bytes, while the real attachment validator, image
cache and viewers run normally. Conversation pages are deterministic arrays.
Nothing authenticates, loads environment files, contacts a controller or calls a
model. The adjacent desktop reference is a static sample page, not a connected
browser. The real sidebar team menu and recent-space picker use a single inert
team/space and change local scope; they do not enumerate real accounts.

From `packages/frontend`:

```sh
pnpm exec vite --config tests/fixtures/search-reading-flow/vite.config.ts
pnpm exec playwright test --config tests/fixtures/search-reading-flow/playwright.config.ts
```

Open `/tests/fixtures/search-reading-flow/index.html`. Options:

- `theme=light|dark`
- `layout=full` to suppress the desktop reference pane
- `image=retry|unavailable` or `file=retry|unavailable` for download recovery
- `file=large` for two UTF-8-safe text-preview pages
- `delay=1` for visible attachment loading
- `history=retry` for the first newer-page request to fail
- `longNames=1` for production scope pickers with long team and space names
- `review=image` for the current reading layout when comparing a frozen image viewer
- `imageShape=tall|design-tall|design-wide` for extreme aspect ratios and readable reference rasters

The regression matrix covers widths 320, 390, 768 and 1280 in both themes.
The first three use coarse/touch input, and desktop uses a fine pointer with a
split chat pane. Tests follow keyboard search activation, target reveal, image
focus trapping and dismissal, file reading, focus/scroll restoration, search
checkpoint restoration and return-to-latest focus. They also check horizontal
overflow, download recovery and that programmatic scroll/resize cannot authorize
newer-history loading. A short 438px viewport models keyboard-reduced space;
this does not replace physical-device or native keyboard testing.
An actual edit in the Lexical composer is checked across attachment dismissal
and return to latest. The fixture's local draft state does not prove production
draft persistence across a route that unmounts the conversation.

## Before and after

Set `INSTAFY_REVIEW_ARTIFACT_DIR` to an untracked directory to save screenshots.
The optional `INSTAFY_REVIEW_BASELINE_SRC` points to a frozen copy of the
frontend `src` directory, outside the checkout. The shared fixture config serves
its source at the same module identities without modifying the worktree or
reading environment files. Start that server on a separate port, for example:

```sh
INSTAFY_REVIEW_BASELINE_SRC=/absolute/path/to/frozen/src \
  pnpm exec vite --config tests/fixtures/search-reading-flow/vite.config.ts --port 5401
INSTAFY_SEARCH_READING_URL=http://127.0.0.1:5401 INSTAFY_REVIEW_VERSION=before \
  pnpm exec playwright test --config tests/fixtures/search-reading-flow/playwright.config.ts
```

The host adapter mirrors the matching `ChatPanel` composition: the original
search baseline has its latest action at the history footer, while current
sources put it above the composer. `review=image` selects the latter layout for
newer image-review baselines. This is the only version-dependent host layout. All
search controls, transcript rows, attachment widgets and their styles come from
the selected source tree. Baseline runs close the old image overlay with its
button and skip new text-viewer assertions because the old attachment was a
non-interactive filename. Captures are named by version, theme, width and step.

Set `INSTAFY_SEARCH_READING_URL` for a different local server and
`PLAYWRIGHT_BROWSER_UI_CHANNEL` for another installed Chromium channel.

## Image inspection

The separate inspection matrix uses the same production viewer and inert Storage
boundary. Its tall and wide design references are deterministic local rasters
with small type and repository imagery, so fitting, zooming and panning inspect
actual source pixels. The existing `tall` variation remains unchanged.

```sh
pnpm exec playwright test --config tests/fixtures/search-reading-flow/image-inspection.config.ts
```

This covers 320/390px touch, 1280px desktop and rotated 844×390 touch landscape
in both themes: trusted Chromium pinch,
double-tap, Fit width and panning, two-to-one finger transitions, actual size,
keyboard zoom and arrows, Ctrl-wheel zoom, ordinary wheel pan, focus at zoom
boundaries, and rotation with source-anchor drift below two rendered pixels.
Page zoom must remain unchanged. The original reading-flow suite separately
covers overview dismissal, attachment focus, edited drafts and history intent.

For this matrix, select a frozen source from the fullscreen-viewer baseline,
set `INSTAFY_SEARCH_READING_URL` to its server, and use
`INSTAFY_REVIEW_VERSION=before`. Before captures exercise opening, fitting,
rotation and closing; new inspection actions run only against current source.
The two residual-pinch tests skip explicitly on the baseline. Use the same
`INSTAFY_REVIEW_ARTIFACT_DIR` convention to collect before/after screenshots.
These browser tests do not replace physical iOS/Android or Electron verification.


The image-review baseline freezes the previous media viewer with all reading-flow
controls present. Before screenshots show Fit only; enlarged after captures are
labeled as new inspection states, not identical-state visual comparisons.

The inspection suite also covers optional mobile controls: initially hidden,
image single-tap reveal/hide, gesture isolation in either state, no image reflow,
keyboard focus and Space/Enter toggling, and visibility through rotation.
Desktop controls remain visible. Hidden mobile tools retain keyboard and
assistive access; tests assert opacity and `data-visible` because Playwright's
visibility definition includes transparent elements. Touch-controls baseline
captures use the preceding always-visible toolbar, while all other image and
reading components remain real and unchanged in the host adapter.
