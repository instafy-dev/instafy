# Notification implementation verification

Verification performed on 2026-09-06 in the working tree, without committing,
publishing, deploying, or changing a shared database. Existing support changes
were preserved. Package-manager hooks were avoided; Node checks used installed
package entry points directly.

## Database and controller

`python3 scripts/test-durable-notifications.py --controller-test notification --controller-test support`
passed with all 76 public migrations, 18 notification-filtered Rust tests, and
12 support-filtered Rust tests after the combined integration review.
The script created and removed its own PostgreSQL cluster and used a separate
clean database for the HTTP and worker tests.

Verified behavior includes:

- Customer-visible support reply creates one owner-only notification.
- A source rollback or outbox insertion failure leaves neither partial source
  state nor a partial notification.
- Resolving emits once; repeating the resolved update emits nothing. Reopening
  and resolving again produces a distinct event.
- New resolution transitions reserve the legacy claim atomically, preventing
  older clients/controllers from claiming a duplicate support toast. SQL checks
  execute the old claim predicate and verify rollback, outbox failure, delivery
  eligibility, and unchanged support unread state. Earlier eligible resolutions
  retain the legacy claim fallback.
- Six initial producer types work, including human conversation replies,
  failed-run deduplication, and quiet-automation suppression. A quiet sentinel
  after earlier visible automation output still produces completion.
- Sixteen concurrent producer attempts share one event/recipient/job, and
  sixteen concurrent resolutions produce one transition event.
- Concurrent workers never share a lease. Crashes recover with new lease
  tokens; stale attempts cannot send or finalize another worker's lease.
  Exhausted jobs stop at eight attempts.
- Source access revocation, account reassignment, read/archive state, and
  preferences prevent delivery. A displayed toast suppresses pending external
  delivery while the notification remains unread.
- HTTP pagination, old mark-all watermarks, account isolation, preview defaults,
  invalid requests, archive, and the separate support cursor behave correctly.
- A mocked transient delivery retries with the same event ID, succeeds, and
  preserves its attempt history. Expired endpoints are removed with terminal
  audit retained.

Web Push and APNs HTTP contracts were tested against local mocks. Web Push
encryption matched the published RFC 8291 vector byte for byte. Additional tests
cover unsafe URLs/IPs/DNS answers, redirects, provider result bounds, native
platform validation, concurrent registration caps, exact lease tokens, and
authorization changes during transport preparation.

`cargo check`, `cargo check --tests`, and `cargo fmt --check` passed for the
runtime controller. Existing unrelated Rust warnings remain. The migration
catalog check and `git diff --check` passed.

## Frontend and desktop

The final complete frontend unit run passed **426 files / 2,811 tests**. Frontend
TypeScript, ESLint, and the Vite production build passed. The build reported
existing bundle-size and browser-data warnings.

Notification regressions cover canonical links, account switches, native
registration intent, late callbacks, queued toast acknowledgement, center
filters/read/archive/preferences, service-worker presentation, and notification
click routing. The final focused run passed **17 files / 94 tests** after the
integration fixes. Frontend TypeScript and ESLint were rerun successfully.
Desktop bundling and ten focused deep-link tests passed.

Independent review reproduced and fixed a service-worker account switch during
window lookup, a delayed old-account iOS registration overwriting the new account,
and external clicks discarding the event ID without acknowledging read state.
Regressions now cover account revalidation before presentation, serialized native
registration/cleanup, event/account identity surviving cold-start login, and
wrong-account redirects before protected resources render. Delayed click
acknowledgements cannot navigate back after Studio unmounts. Native request-order
reproduction retains the new account's token; this is a simulated provider boundary.

Desktop's separate TypeScript check still reports **28 existing diagnostics**
around module resolution, workspace exports, speech, and updater code. An isolated
copy of `HEAD` produced the same diagnostic messages; they were not introduced by
this change. Desktop bundling and the relevant runtime tests passed.

The older environment-gated assistant-notification smoke was updated to expect
durable events, account-scoped opt-in, stable tags, and generic private previews.
That live-app smoke was not run; the isolated browser suite below was run instead.

The new `playwright.notifications-ci.config.ts` browser suite passed **2/2** in
installed Chrome at **1280×900** and **360×800**. It uses the production center,
status queue, IndexedDB, and HTTP client with synthetic controller/authentication
and OS-delivery boundaries. It checks a background reply envelope and exact
support target click, a second browser context changing from unread to read solely
because that click uses the production authenticated destination consumer (without
a manual **Mark read** action), resolution
followed by reopen and a second resolution, pagination/filter transitions,
archive/read-all, and persisted preferences. Four All/Preferences screenshots
were visually checked for readable controls and overflow.

The browser suite caught and now guards a real regression: switching to Unread
after loading extra All pages must discard previously loaded read items.
Run it from `packages/frontend` with an installed Playwright browser:

```sh
PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome node node_modules/@playwright/test/cli.js \
  test --config playwright.notifications-ci.config.ts
```

## What these results do not establish

Database tests use a minimal local Supabase identity schema; they do not test
the hosted authentication service. Browser and transport simulations use
synthetic identities and mocked HTTP/provider boundaries. They do not establish
real provider acceptance, notification permission behavior, native provisioning,
or physical-device receipt.

Deployed VAPID/APNs configuration was **not verified**. No authoritative running
production controller or deployment configuration was inspected. Android push
registration is explicitly disabled and no FCM delivery is claimed.

The remaining browser/PWA, physical iPhone, packaged Electron, and deployment
checks are in the [notification rollout checklist](Notifications.md#configuration-and-operational-verification).
