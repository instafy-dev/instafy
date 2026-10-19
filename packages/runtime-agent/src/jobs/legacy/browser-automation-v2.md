---
name: instafy-browser-automation
description: Capability-aware guidance for Personal Browser, Shared Browser, and owner-local read-only page observation.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: browser, playwright, page, click, screenshot, visible session, live browser, open url, read title
---

# Browser automation

Never prune: yes

Goal: use the browser capability exposed for this turn safely and report only real observations.

## Browser terms

Use these terms consistently:

- `page` = a tab/page inside the current shared Chromium session
- `isolated session` = a separate browser context inside the same runtime, used only when cookie/login isolation is required
- `runtime-backed session` = a separate browser runtime / visible browser surface
- `Personal Browser` = the private Chromium view embedded in the Instafy desktop app and controlled through its project-scoped local RPC broker
- `owner-local browser` = a fresh headless Chromium process for credential-free, read-only public-page observation on an opted-in self-hosted runtime

For interactive Personal or Shared Browser work, default to `page` first. Do not escalate from `page` to `isolated session` or `runtime-backed session` unless the user explicitly asks for isolation or the task clearly requires incompatible account state. Owner-local observation always uses a fresh one-URL context.

## When to use this skill

Use this skill when the task requires opening, reading, clicking through, or verifying something in a browser. Follow only the browser tool exposed for the current turn. If none is exposed, report that the runtime has no browser capability instead of guessing a transport.

## Shared Browser command (only when Shared Browser is exposed)

For Shared Browser work, use only the tools exposed by the
`instafy_shared_browser` MCP server. It owns the Playwright/CDP attachment and
automatically emits the action ticker and AI cursor telemetry; do not invoke it
through the shell, write an ad-hoc Playwright script, or append action JSON.

Snapshot before using an index, snapshot again after substantial DOM changes, and
finish from the controller's observed title, URL, visible text, and elements. Keep
the same visible page focused. The controller accepts only these high-level
operations and never exposes arbitrary JavaScript execution.

## Core rules

- Prefer concrete action over narration. If the target and first cue are already known, keep pre-action commentary to one short line at most.
- Use the browser capability actually exposed for this turn. Personal and Shared Browser are visible interactive transports; the owner-local browser is a separate read-only headless observer. Never fall through from an unavailable transport to a different one.
- For Personal or Shared Browser, default to one browser-capable runtime per conversation. Owner-local observation instead opens one fresh process per tool call and accepts one URL per call.
- Do not start with install/bootstrap checks such as `node -v`, `npm -v`, `npx playwright --version`, `npm init`, or `npm i`.
- Do not start with env or repo spelunking such as `env | rg PLAYWRIGHT`, `command -v playwright`, or broad `rg` scans for browser snippets. Use the exposed bounded tool and report its concrete error if provisioning failed.
- Do not start browser tasks with `instafy runtime status`, `instafy --help`, or similar runtime/CLI introspection. A direct call to the exposed browser tool is the primary path.
- For requests like “open this page”, “read the title”, “click this button”, or “continue the current browser session”, the first executable step must target the page directly. Do not spend the first turn proving the browser exists.
- Do not reopen `INSTAFY.md`, `AGENTS.md`, or `.agents/skills/**` via shell before the first page action. Project memory and loaded learned blocks are already in context for this run.
- If a learned block was loaded for this run, trust it first. Only reopen memory files after a concrete browser action failed and the missing cue is still unclear.
- If the current prompt names exact controls, routes, labels, or query terms, those prompt-provided cues override older learned surface-specific cues. Use learned memory for durable invariants and retrieval guidance, not to overwrite the prompt with an older sibling-surface route.
- Prefer exact stable cues over broad guesses: selectors, ids, names, relative hrefs, visible labels, or routes you actually observed.
- On tables, listings, forms, and filtered result sets, prefer the exact visible control text or stable selector when it exists. Do not downgrade `button text "Apply filter"` or `link text "Epsilon account"` into substring regexes, `contains` checks, or vague phrases like `matching result`.
- For local/dev/test sites, prefer route-level and selector-level memory over full absolute origins or debugger endpoints. Only preserve host/port when the host itself is the learned fact.
- In Personal or Shared Browser, reuse the current tab when it already matches the task. If you must open or switch tabs, bring the controlled tab to the front so the user sees the same state.
- In Personal or Shared Browser, prefer multiple tabs/pages inside the same runtime when the transport supports them. Owner-local multi-site work uses one bounded `observe` call per URL and has no persistent tabs.
- In Personal or Shared Browser, do not create a second runtime/session just because the user wants to compare sites. Owner-local calls are intentionally fresh and are not reusable sessions.
- For “find me a good nearby place” style requests, treat the search engine page as a starting point, not the finish line. Continue until you can name concrete candidates or report a concrete blocker.
- When the user wants a recommendation, do not stop at a generic results list unless they explicitly asked only for links. Open the most promising local, map, review, or venue entries and extract real details.
- Prefer sources that can support an actual recommendation over repeating a search query or a list of blue links.
- If you cannot determine a single best option, summarize the strongest observed shortlist with concrete evidence instead of punting back to the user.
- For Personal or Shared Browser, only treat browser work as a separate session when the user explicitly asks for isolation or incompatible login state requires it. Owner-local observation is always fresh and credential-free.
- In Personal or Shared Browser, if the user asks for “another window” or “another browser”, clarify the intended level only when it matters:
  - usually interpret it as a new page/tab in the current session
  - interpret it as an isolated session only when they mention separate login/account/cookie state
  - interpret it as a new runtime-backed session only when they explicitly ask for a fully separate visible browser surface or runtime
- If a learned block already gives you an entry route and one actionable cue, use it directly instead of rediscovering the page from scratch.
- If a learned block gives you a direct entry route (for example `/search`) and the task does not require visiting a broader landing page first, prefer the direct route over a homepage detour.
- Do not let an older learned route override a newer prompt that clearly names a different sibling surface. Example:
  - prompt: `/lookup`, button text `Find`, query `beta dossier`
  - older memory: `/search`, button text `Search`, query `beta`
  - correct behavior: use `/lookup` + `Find` + `beta dossier`, while keeping any still-valid learned invariant such as `direct article links are gated` or `read "Article token:" from the detail page`
- Prefer a compact action path and at most one repair attempt. Do not fall into inspect/retry loops unless a direct attempt produced a concrete blocker.
- Treat consent/login/payment/MFA as user-owned steps. Pause and wait when the task requires a user-only action.
- A stored browser session is not blanket permission to act as the signed-in user. For a sensitive site or action, the current user message must name the site and the concrete action; otherwise stop before using the authenticated state and ask for confirmation.
- Treat financial services, healthcare, government/identity, employer administration, cloud consoles, source-control/org administration, password/account settings, and any page containing private communications as sensitive. Treat purchases, transfers, submissions, messages, permission changes, credential changes, downloads of private data, and destructive actions as high impact even on other sites.
- Confirmation is session- and action-specific. Approval to inspect one page does not authorize a later message, purchase, permission change, or destructive action. Ask again immediately before the high-impact step when the user's current message did not already authorize that exact step.
- Never type a password, one-time code, payment detail, government identifier, recovery secret, or other authentication secret into the Shared Browser. Let the user enter those values directly in the visible browser, then continue only after they say the step is complete.
- For initial Shared Browser pilots, use disposable, non-sensitive accounts only. Do not reuse a teammate's real login until the product exposes a project-level shared-login consent policy and audit surface.
- Report observed state or the exact execution error. Do not claim browser success without real execution output.
- When the `instafy_personal_browser` MCP server is present, use it exclusively for that turn. Do not attach Playwright or CDP in that runtime.
- Treat the Personal Browser token as a secret capability: never print it, interpolate it into a command argument, persist it to a file, include it in learned memory, or include it in an error report.

## Learning boundary

- Pinned skills own generic browser workflow.
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

## Default decision order

1. If the user named a URL, domain, or target app, go there first.
2. If a Personal or Shared task implies continuing from the current visible session, inspect current state and continue. Owner-local observation cannot continue a session.
3. In Personal or Shared Browser, keep multiple sites/pages inside the same runtime when supported. In owner-local mode, make one bounded observation call per URL.
4. If the target site is unclear, ask one short clarification question.
5. If the page already contains the requested answer, extract and verify it instead of re-navigating.
6. If the user asked for a recommendation and the current page is only an intermediate result list, keep going until you can justify a recommendation or explain the exact blocker.

## Multi-site and multi-session default

For Personal and Shared Browser, current default behavior is:

- one visible browser surface per conversation
- one browser-capable runtime reused across chat and browser work when possible
- extra sites/pages should usually live as additional tabs/pages inside that runtime
- if the UI already exposes existing browser page cards/contexts, continue in one of those by default instead of inventing a fresh session

Owner-local observation is different: it has no visible surface, tabs, cookies, or
continuation state. Each URL is a separate bounded `observe` call.

Interactive Personal/Shared escalation order is:

1. reuse current page
2. open/switch another page in the same session
3. create an isolated browser context in the same runtime if login separation is needed
4. create a separate runtime-backed browser session only if explicitly required

This means:

- Personal or Shared Browser may keep multiple sites open for comparison, monitoring, or automation prep
- describe Personal or Shared pages as tabs/pages within the same session unless the user explicitly asked for isolation
- if the UI only shows one visible browser surface, background Personal or Shared pages can stay open for later revisits, but they are not separate user-managed cards yet

When reporting or learning from multi-site work:

- label pages by site or purpose, for example `news source`, `status dashboard`, `competitor page`
- keep worked cues separated per site
- do not merge selectors/routes from sibling sites into one generic summary

## Execution style

- Use the runtime's advertised browser tool. Do not infer availability by printing environment values or probing binaries.
- The Personal Browser broker and MCP transport are already scoped to the active desktop project. Never try to reconstruct or substitute their project capability.
- Personal Browser RPC is deliberately high-level. Do not probe its localhost port, request CDP targets, inspect Electron internals, or bypass a `423` control-disabled response.
- Use `instafy_personal_browser` only when that server is exposed and `instafy_shared_browser` only when that server is exposed. Do not invoke Shared Browser merely because this skill file exists.
- When `instafy_local_browser.observe` is exposed, use it only for credential-free public HTTP(S) page observation. It is not a fallback for login, clicking, typing, or other interactive work.
- In a Shared Browser turn, if no browser panel is visible yet, still start with the exposed `snapshot` tool. A successful snapshot can create or reveal the shared headed browser session for the user.
- In a Shared Browser turn, if the first controller action fails, report that concrete failure or use it to drive one small repair attempt. Do not attempt the Shared controller in Personal or owner-local turns.
- Prefer one compact execution step that both acts and prints structured evidence over multi-step exploratory loops.
- When a task involves more than one actionable browser cue (for example route + field + submit + result link + extraction label), print those exact successful cues in the command's structured JSON evidence under a compact `workedCues` object or array. Use only cues that actually worked:
  - route or relative path
  - consent button text
  - field label / name / id
  - chosen query / option value / option text
  - exact submit button text / aria label / stable selector
  - exact result-link text / stable selector
  - exact page label used for the final extraction
- Do not include failed guesses, alternative controls that were not used, or generic summaries like `visible search control` or `matching result`.
- If the task asks for multiple fields from the same page, complete the full extraction inside one browser tool call whenever possible. Do not split “open page”, “read title/url”, and “read token/label” into separate repair calls unless the first call produced a concrete blocker.
- If one browser tool call already produced every field the user or harness asked for, stop there. Reply immediately from the observed values instead of launching a second call, rereading learned blocks, or adding a formatting-only repair step.
- A one-off browser tool call is complete only when it returns cleanly. Do not leave timers, watchers, hanging promises, or open interactive waits behind.
- Do not create inline Node/Playwright commands. Use only the bounded browser MCP exposed for the turn.
- If the user or harness requested an exact reply format, emit that final assistant reply immediately after you have the observed values. Do not leave the answer buried only in command output, preview text, or “one more repair attempt” narration.
- If a browser command already produced the requested evidence successfully, do not launch a second repair command just because you are worried about disconnect/timeout cleanup. Use the observed evidence and reply.
- Do not reopen `.agents/skills/instafy-learned/**`, `INSTAFY.md`, or other memory files after a successful browser extraction just to justify the answer. Memory is for deciding what to do before action, not for post-hoc explanation after the answer is already known.
- If one field is missing but you are already on the correct page, prefer a broader in-process fallback before launching a new command:
  - read the nearest parent text,
  - read the surrounding section text,
  - read `body.innerText()` and extract the needed value from the actual visible label.
- When the prompt asks for an output key like `ARTICLE_TOKEN` but the page uses a human label like `Article token:`, extract from the actual page label and then map it into the requested final reply line. Do not assume the page literally contains the requested output key.
- When a successful cue is an exact visible control or link text, report only that exact cue. Do not append nearby helper text, sibling labels, or surrounding UI copy such as `Search result` once the worked cue is already known to be `Beta`.
- Preserve the shared browser safely during cleanup:
  - never call `browser.close()` unless the user explicitly asked to close the session
  - guard `browser.disconnect()` because some attached browser objects do not expose it
- Preserve the shared session:
  - do not intentionally close the browser
  - do not leave the controlled tab hidden behind a different tab if the user should keep seeing it
- If you need repair logic, keep it small and driven by concrete observed state.
- When a task is likely to recur, store the reusable cue pattern in a learned block instead of encoding tool/runtime syntax into memory.
- If a harness or user requested exact final output lines, produce them immediately from the first successful browser command result. Do not spend another turn rereading memory or re-explaining the action path.

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

Do not use it for authenticated/private pages, interactions, arbitrary JavaScript, session reuse, or non-HTTP(S) URLs. If the task needs those and no Personal or Shared Browser server is present, state that the required interactive capability is unavailable.

## Personal Browser MCP

Use this path only when the `instafy_personal_browser` MCP server is exposed. It
controls the native browser visible inside the desktop app and keeps its private
login state on that device. Use its `status`, `snapshot`, `navigate`, `click`,
`type`, `press`, and `scroll` tools directly; never invoke them through the shell.

The broker controls one visible page. Reuse it and navigate sequentially; do not
invent tab/window endpoints or silently switch transports. Prefer an element
`index` from the immediately preceding snapshot and snapshot again after any DOM
change. A `423` response means the user paused control; a `401` response means the
short-lived capability expired. Stop rather than inspecting or retrying the token.

## Shared Browser implementation boundary

The high-level `instafy_shared_browser` MCP server is the only normal Shared
Browser automation path. It attaches to provisioned headed Chromium, selects the
focused page, bounds snapshot output, and emits cursor/ticker events. Do not
replace it with shell commands, inline Node, Playwright, CDP, direct action-log
writes, or a new browser process. If the tool returns a concrete error, report
that error and stop after at most one focused retry.

## Browser learning examples

Good:
- “Start from `/search`, fill the input labeled `Search`, submit with the visible search button, then read `ARTICLE_TOKEN` from the article labels.”
- “Start from `/search`, fill the input labeled `Search`, submit with the visible search button, then read the page label `Article token:` and map it into the final `ARTICLE_TOKEN` reply line.”
- “If a consent button labeled `I agree` is visible, click it once before continuing.”
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

## Good outputs

- “Opened `<url>` and observed `<title>` / `<heading>` / `<label>`.”
- “Clicked `<label>` and confirmed the page changed to `<state>`.”
- “Could not continue because `<exact error>`.”
