# Browser automation: learned blocks and the other browsers

The parts of `instafy-browser-automation` a turn reads only when it needs them: how to write a
learned block for a site, the owner-local `observe` tool, and the Personal Browser's own notes.
A Personal or Shared Browser turn's run text says how its browser works.

## Learning boundary

- Pinned skills own generic browser workflow.
- If a learned block already gives you an entry route and one actionable cue, use it directly instead of rediscovering the page from scratch.
- If a learned block gives you a direct entry route (for example `/search`) and the task does not require visiting a broader landing page first, prefer the direct route over a homepage detour.
- Do not let an older learned route override a newer prompt that clearly names a different sibling surface. Example:
  - prompt: `/lookup`, button text `Find`, query `beta dossier`
  - older memory: `/search`, button text `Search`, query `beta`
  - correct behavior: use `/lookup` + `Find` + `beta dossier`, while keeping any still-valid learned invariant such as `direct article links are gated` or `read "Article token:" from the detail page`
- Learned blocks should only capture task- or site-specific delta:
  - where to start
  - exact cues to act on
  - pitfalls that are specific to that target
  - short verify conditions
- Do not restate generic browser hygiene in learned blocks unless the site has an unusual variant that is itself the learned fact.
- Good learned browser delta usually includes selector-grade cues, such as:
  - search input labels / ids / names
  - submit button labels
  - exact pagination control labels
  - exact result-link text or stable relative href
  - article field labels that contain the final answer
  - stable relative routes like `/search` or `/article/<slug>`
- Weak learned browser delta sounds like intent without the worked cue, for example:
  - `use page 2`
  - `open the matching result`
  - `search for beta`
- Weak execution on the live page also looks like:
  - waiting for `/epsilon/i` when the row actually shows `Epsilon account`
  - clicking a generic `visible filter control` when the page exposes `Apply filter`
- Rewrite those into exact control memory, for example:
  - `click the page button text "2"`
  - `open the result link text "Fixture News: Beta"`
  - `open the result link text "Epsilon account"`
  - `submit with button text "Apply filter"`
  - `fill the textbox labeled "Search" and submit with button text "Go"`
- Avoid storing:
  - debugger endpoints
  - browser launch flags
  - runtime-specific CLI commands
  - absolute `http://host.docker.internal:<port>` origins unless the origin itself matters

## Owner-local read-only observation

When the `instafy_local_browser.observe` tool is present, it opens a fresh headless browser for one bounded observation and closes it afterward. It always returns the match count for each selector, can return bounded text and named computed CSS properties, and can save one PNG below `artifacts/browser/`.

For example, one call can verify a page and produce a screenshot artifact:

```json
{
  "url": "https://instafy.dev",
  "observations": [
    { "name": "headline", "selector": "h1", "text": true, "computedStyles": ["font-size"] },
    { "name": "page", "selector": "body", "computedStyles": ["background-color"] },
    { "name": "headings", "selector": "h1,h2,h3" }
  ],
  "screenshot": { "path": "artifacts/browser/instafy-dev.png", "fullPage": true }
}
```

Do not use it for authenticated/private pages, interactions, arbitrary JavaScript, session reuse, or non-HTTP(S) URLs. If the task needs those and no Personal or Shared Browser server is present, emit `request_browser` (see Open or resume from Chat).

## Personal Browser MCP

Use this path only when the `instafy_personal_browser` MCP server is exposed. It
controls the native browser visible inside the desktop app and keeps its private
login state on that device. Use its `status`, `snapshot`, `navigate`, `click`,
`type`, `press`, `scroll`, `list_tabs`, `open_tab`, `select_tab`, and `close_tab`
tools directly; never invoke them through the shell.

Every tool acts on the tab on screen. Reuse a tab with `navigate` when one page at
a time is enough. For a comparison or several related reads, `open_tab` each page
(at most three of your tabs; each asks for its own site approval), read it, and
`select_tab` between them; close the ones you no longer need. Agent tabs open
public pages only, and the person's own tab is never closed. Do not invent window
endpoints or silently switch transports. Prefer an element
`index` from the immediately preceding snapshot and snapshot again after any DOM
change. A `423` response means the user paused control; a `401` response means the
short-lived capability expired. Stop rather than inspecting or retrying the token.

## Browser learning examples

Good:
- “Start from `/search`, fill the input labeled `Search`, submit with the visible search button, then read `ARTICLE_TOKEN` from the article labels.”
- “Start from `/search`, fill the input labeled `Search`, submit with the visible search button, then read the page label `Article token:` and map it into the final `ARTICLE_TOKEN` reply line.”
- Command JSON evidence that includes:
  - `workedCues.route = "/directory"`
  - `workedCues.field = "Team"`
  - `workedCues.option = { value: "green", text: "Green" }`
  - `workedCues.submit = "Apply filter"`
  - `workedCues.resultLink = "Epsilon account"`
  - `workedCues.extractLabel = "Article token:"`

Bad:
- “Attach to `http://127.0.0.1:9223`, open `http://host.docker.internal:56768/`, then run these exact commands...”
- “Use this exact browser CLI / debugger command...”
