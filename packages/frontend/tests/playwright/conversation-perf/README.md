# Conversation performance lane

Run from the repository root after `pnpm install --frozen-lockfile`:

```bash
pnpm --filter @instafy/frontend exec playwright install chromium
pnpm --filter @instafy/frontend test:e2e:conversation-perf
```

To use an explicitly installed Chrome instead of Playwright Chromium, prefix the second
command with `PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome`. Missing browsers fail the lane; it never
silently skips. The config runs one worker without retries on the fixed loopback port 5207.

The lane builds production React/TypeScript assets with a separate Vite configuration. It
loads no local `.env` files, accounts, controller, database, model, runtime or provider. All
history responses are synthetic GET-only HTTP routes; unexpected controller operations and
requests outside its loopback origin fail the test. The token in the fixture is an inert
label, never a usable credential.

## What it verifies

The real history HTTP service, TanStack Query hook, bounded cache, message mapping,
`ConversationMessageRows`, deferred rows, Markdown renderer and transcript viewport run in
the browser. Fixture org/space/tab buttons change the same user/conversation query scopes.
The surrounding Studio providers and navigation controls are substituted. This lane does
**not** establish authorization, complete Studio navigation, localStorage restoration,
network latency on a hosted system, or runtime streaming behavior; use the full application
journey for those boundaries.

- Load two chats to 400 messages, then measure 24 warm switches through two animation frames.
  Warm switches must show no initial loading placeholder and must not replay older pages.
  The repeated-sample p95 must stay below 1 second and no sample may exceed 2 seconds. These
  deliberately generous regression gates catch seconds-long regressions, rather than
  claiming a cross-device latency guarantee.
- Hold and fail reads, switch away from a cold pending history, verify transport cancellation,
  and recover an initial error using Retry. Cached transcripts stay visible during failure.
- Load 1,100 messages, switch away, and verify the inactive transcript keeps at most 20 pages.
  One round of small payloads visits 21 conversation scopes and reaches the 10-history cap.
  Three further rounds use larger payloads in 21 scopes each, varying org, space and tab.
  Inactive cache entries settle at most 10 conversations and 8 MiB of estimated serialized
  UTF-16 payload. After releasing the final observer, an accelerated browser clock proves
  collection after the real 30-minute retention interval.
- At the same points after each soak round, Chromium's `HeapProfiler.collectGarbage` and
  `Runtime.getHeapUsage` measure **actual V8 heap** separately. The third round may add at most
  32 MiB over the first, and settled used heap must stay below 256 MiB for this fixture. DOM
  counters and backing storage are reported too. These are fixture regression budgets, not
  application-wide memory limits; V8 heap excludes browser/native/GPU memory, and serialized
  cache payload is neither V8 heap nor process RSS.

JSON measurements and failure traces are written under `test-results/conversation-perf/`.
The separate production bundle lives under `test-results/conversation-perf-app/`. Both are
ignored build/test artifacts. Attachments contain synthetic numeric measurements only.
