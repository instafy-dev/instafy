# Testing

## Playwright (Studio)
- Required frontend CI mirror: `pnpm quality:frontend:required`
- Frontend lint budget gate: `pnpm lint`
- Frontend unit gate: `pnpm --filter @instafy/frontend test:unit`
- Browser component/layout gate: `pnpm -C packages/frontend test:e2e:component`
- Current warning budget: `0` frontend warnings max
- Default product e2e: `pnpm test:e2e`
- Focused smoke subset: `pnpm test:e2e:smoke`
- Controller-focused subset: `pnpm test:e2e:controller`
- Benchmarks only: `pnpm test:e2e:bench`
- Headed: `pnpm test:e2e:headed`
- Target a failing spec: `pnpm -C packages/frontend test:e2e -- tests/playwright/app.spec.ts -g "renders landing hero content"`

The default `pnpm test:e2e` loop is intentionally product-focused:
- it covers the regular Playwright regression surface
- it does not load the opt-in benchmark specs under `tests/playwright/bench`
- benchmark coverage stays available through `pnpm test:e2e:bench`, which sets `PLAYWRIGHT_RUN_BENCH=1`

Public Build keeps its existing job names:

- Secret scan
- JavaScript packages
- Go packages
- Rust packages

It also calls the secret-free `Browser verification` workflow on every pull
request, `main` push, and manual Public Build run. That workflow has three
non-optional jobs: `Personal Browser E2E`, `Browser UI rendering`, and
`Shared Browser profile E2E`. A failure in any of them fails Public Build,
including its downstream release-workflow result. Repository administrators
must also require the emitted browser job checks in branch protection; adding
workflow YAML does not change repository protection settings.

Pull requests are leak-gated by the separate
`Public boundary (trusted base)` check. Its `pull_request_target` workflow owns
the scanner, policy, and Gitleaks configuration from protected `main`, checks
the GitHub-generated merge tree out separately as data, verifies its observed
OID and exact event base/head parents (plus the payload merge OID when GitHub
supplies one), and never installs, imports, sources, caches, or executes
candidate code. It has read-only repository permission and no
repository or deployment secrets. Its candidate checkout is the one deliberate
`allow-unsafe-pr-checkout` exception required by current `actions/checkout`;
the trusted checkout does not opt out. Before public visibility, require this
check in addition to the Public Build checks above.

The same workflow emits that exact check name for every push to protected
`main`. The push lane binds its checkout to `github.sha`, treats that protected
commit as both the trusted controls and scanned tree, and repeats the policy and
Gitleaks gates without secrets or write permission. This gives release tooling
an exact-main attestation while the pull-request lane remains base-owned and
continues to treat candidate bytes only as unexecuted data.

The trusted gate rejects unreviewed environment templates, live
environment/auth files, private-only package/product markers, personal paths,
private hosts/networks, browser-exposed service-role names, token prefixes,
symlinks, Git LFS indirection, unexpected Git index modes, unknown or repinned
submodules, invalid UTF-8, and every unknown binary/archive. The policy
allowlists exactly 16 inert environment templates, the reviewed Codex gitlink
object, and 45 binary path/SHA-256 pairs. Marker matching covers paths, ordinary
UTF-8, common UTF-16/UTF-32 layouts, and bounded recursive URL, Base64, and hex
decoding for the private product marker.

Pinned Gitleaks 8.30.1 scans the candidate with path-aware rules and scans a
second path-independent stream of tracked bytes so inherited global filename
allowlists cannot hide secrets in files such as lockfiles or SVGs. It traverses
one archive level and three decoding levels, uses an empty ignore file,
disables inline allowances, has no target-size skip, redacts findings, and
fails on timeout. Protected `main` repeats the current-tree and introduced
history scans as defense in depth.

`.github/CODEOWNERS` assigns every workflow/action and boundary control,
including itself, `.gitattributes`, `.gitmodules`, and `codex`, to the security
maintainer. Branch protection must require code-owner review for those paths
without imposing review on ordinary product changes. Do not use a push-path
ruleset as the permanent trust anchor: GitHub disables all push rulesets when
an internal repository becomes public.

The trusted policy intentionally makes a binary addition/removal, approved
environment-path addition, or Codex repin fail its own PR. Those rare changes
require a security maintainer to inspect the bytes or object, update the policy,
and use the explicit protected-branch break-glass path. Normal source
contributions do not require that manual security review.

The JavaScript job performs a frozen install, validates and applies the public
migration track to an empty database, checks the self-host contract, lints and
builds the frontend, runs frontend units, proves the CLI package artifact, and
builds/tests the Desktop app and its runtime helper. The empty-database test
prefetches its digest-pinned Postgres image with bounded retry/backoff and then
disables implicit pulls; image acquisition may retry, while container, SQL, and
schema-verification failures remain fatal. The Go and Rust jobs test
the public service packages directly. The browser lanes below run real browser
processes separately from frontend unit tests. The Shared Browser job also
runs one signed-in Studio journey against real local authentication, the
controller, and runtime agent. Cloud-provider allocation, model-driven
browsing, and cross-user collaboration remain outside these public checks.

Environment-gated suites remain non-required:
- payments
- voice / speech / desktop voice
- private GitHub / secrets-dependent flows
- other packaged-release Desktop and hardware-specific smokes

Stripe-backed payment tests are opt-in and require test-mode Stripe credentials. They are not part
of the default public CI gate.

Automation browser cleanup:
- repo-launched Playwright Chromium sessions now run under `tmp/automation-browsers`
- the Playwright wrapper and smoke scripts clean up those owned browser trees on normal exit, failures, and handled interrupts
- if a prior run was killed hard and left owned automation browsers behind, run `pnpm test:automation:cleanup`

For the full-stack suites, run the local stack first:
- `pnpm stack:up`
- `pnpm stack:down` when finished.

## Secret-free browser CI lanes

These lanes use disposable data, do not load local `.env` files, and do not
need a real account, model API key, or production controller. Personal and UI
lanes run through `pnpm test:browser:ci <lane>`, which removes ambient
credentials and development endpoint overrides before starting Playwright.
Their strict reporter requires the known test inventory and a single passing
attempt per test: skips, expected failures, retries, filtered subsets, and zero
tests fail the lane. Failure traces and a machine-readable result are retained
under `packages/frontend/test-results/browser-ci/<lane>`.

| Lane | What it proves | Local requirements |
| --- | --- | --- |
| `personal` | Real Electron profile/cookie persistence across restarts and projects, per-user isolation, clear, kill switch, and renderer ownership revocation (4 tests) | Installed workspace dependencies and compiled Desktop fixture; no Docker or database |
| `browser-ui` | Real Chromium rendering of browser chrome, cursor overlay, approval layouts, rendered-frame checks, and mobile drawer safe-area geometry (13 tests) | Installed workspace dependencies and Playwright Chromium; no Docker, database, or controller |
| Shared profile fixture | Real Chromium HttpOnly/JS cookies, localStorage and server cookie echo; production runtime save/restore; controller authorization, encrypted database storage, stale-writer rejection, and clear/no-resurrection | Disposable Linux, Xvfb, Chromium, Go, Rust, and fully migrated loopback Postgres |
| Shared Studio fixture | Real signed-in application, authorized project creation, Shared launch, CDP pixels/input, periodic snapshot, acknowledged provider stop, replacement login restoration, and UI clear | Disposable Linux, Xvfb, Chromium, Go, Rust, `x11-utils`, `sqlite3`, `psql`, and fresh local Supabase including GoTrue |

After `pnpm install --frozen-lockfile`, run Personal locally with:

```bash
pnpm --filter @instafy/desktop-runtime-agent build
pnpm --filter @instafy/desktop-app exec tsup
pnpm test:browser:ci personal
```

Linux also needs the browser/display system dependencies and `xvfb-run -a`
before the last command, as shown in `.github/workflows/browser-e2e.yml`.
Run the component lane with:

```bash
pnpm --filter @instafy/frontend exec playwright install chromium
pnpm test:browser:ci browser-ui
```

If a browser download is unavailable, an already installed Google Chrome can
be used explicitly with
`PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome pnpm test:browser:ci browser-ui`.
That verifies the installed channel, not the lockfile's Chromium revision;
CI always installs and uses the locked Playwright browser.

The Shared fixture command on a disposable Linux machine is:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  xvfb-run -a node scripts/browser-profile-e2e.mjs
```

It invokes explicitly selected Rust browser/controller tests, requires both
completion receipts, and fails when dependencies or migrations are missing.
The Shared job retains only a fixed-field `shared-profile/result.json` receipt
under the browser CI results directory, never the profile archive or tokens.
It refuses pre-existing `/tmp/instafy` resources. Both Shared fixtures check the
actual X-display connection after the long builds. A failed profile fixture
retains only fixed diagnostic categories from at most the last 64 KiB of its
owned Chromium log, never raw log lines. Categories are observations, not a
root-cause diagnosis; missing or unrecognized evidence remains explicit.

The standard hosted workflow uses Docker to provision disposable migrated
Supabase (Postgres and local authentication); Chromium and runtime/controller
processes run natively on Linux. The profile-only command also accepts a
separately provisioned compatible migrated loopback database. No local Docker
installation is needed to run these checks on GitHub-hosted runners.

The Shared fixture uses a test-only HTTP bridge so the browser receives real
cookies without weakening the production public-only egress policy. It does
not prove network egress enforcement, container isolation, provider stop
ordering, full Studio streaming/control, or model-driven browsing. Those need
their own larger integration fixtures; a green profile lane is not evidence
that those paths ran.

### Signed-in Shared Studio journey

On a disposable Linux host with a **fresh, empty local Supabase stack**:

```bash
xvfb-run -a node scripts/shared-browser-studio-e2e.mjs
```

This separate runner deliberately does not import the general developer
Playwright harness or its environment/credential loaders. It refuses an
occupied database or pre-existing browser resources, obtains only the local
stack configuration, and creates separate throwaway Studio and controller-service
users with `mint-test-user.mjs`. The service identity is explicitly configured
and never enters the renderer; automatic service-account bootstrap is not part
of this lane. It creates the Studio user's project through the real
authenticated controller API, then enables persistence for only that project
on the disposable controller.

The Studio-driving Playwright process uses an empty fixture home and a fresh
browser context. The runner resolves and checks the installed, lockfile-pinned
Chromium executable before that environment isolation, then passes only the
executable path to Playwright. Sharing installed browser binaries does not share
browser profiles, cookies, localStorage, or developer credentials. A missing
installation fails the fixture preflight rather than skipping the journey.

On failure the runner records only fixed provider-validation/launch stages,
numeric response/exit codes, runtime/origin counts, and a closed vocabulary of
runtime startup observations. The owned guardian drains process output with a
bounded classifier; raw log text, grant bodies, URLs, and session material are
never emitted or retained. These observations narrow the failing boundary but
do not themselves establish a root cause or count as a passing journey.
Response observers accept the application's `127.0.0.1` → `localhost`
controller normalization only at the exact fixture port, including grant and
clear responses. Browser capability/status and WebSocket diagnostics retain
only fixed operation/event names, never payloads or connection URLs.

The fresh database must contain only its unchanged migration-seeded provider.
The runner registers its additional disposable provider through the controller's
service-role-only API; environment fallback does not override a populated registry.

Studio launches an actual native runtime-agent through a test-only loopback
allocator implementing the controller's existing provider protocol. The
production runtime restores and launches Chromium; Studio receives real
controller grants and drives the real origin pixel/input paths. Only website
traffic for the inert test origin is bridged into the owned HTTP fixture;
production egress policy remains enabled. The fixture is not a cloud allocator,
container-isolation or network-egress proof. The existing
`VITE_DISABLE_AUTO_RUNTIME_ENSURE` switch disables background workspace
allocation in this lane; the explicit Shared Browser UI launch remains real.

Before restart, the runner inspects the actual encrypted stored snapshot for
the test cookie records and localStorage marker. It then stops the runtime
through the controller/provider acknowledgment path. A replacement must restore
the exact website login state; the test does not rely on a final shutdown save.
Finally, the visible clear action must retire the browser, start a fresh one,
and show empty website data while Studio remains signed in. No model job is
submitted. Only fixed-field result receipts are retained; traces, video,
screenshots, raw service logs, profiles, and session values are not uploaded.
Cleanup removes only this fixture's project, provider registration, both users,
processes and temporary data, leaving the migration-seeded provider untouched.

## Stripe E2E
- `PLAYWRIGHT_STRIPE_E2E=1 pnpm -C packages/frontend test:e2e:payments`

Requires env vars:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_PRO`
- `STRIPE_PRICE_ID_SCALE`

## Group Conversation Participation

Run `pnpm test:e2e:orgs` against the local stack for the collaboration contract in
`docs/Group-Conversation-Participation.md`. The suite covers permission-filtered participant
discovery, human-only sends without AI credentials, per-sender AI preferences, explicit agent
mentions, idempotent message persistence, and race handling around active agent jobs.

For manual cross-client validation, use disposable local test accounts and the debug bundle built
from the current checkout. Confirm that the same conversation syncs across web, Electron, and the
selected mobile clients, and use `scripts/android-debug-ota-proof.mjs` before trusting Android UI
evidence. Hosted smoke accounts, production endpoints, and release sign-off orchestration are
maintained outside the public repository.

## Local Tri-Client Camera Smoke
- Run: `pnpm test:camera:tri-client:smoke`
- Requires:
  - local stack up (`pnpm stack:up`)
  - a connected Android device over adb with the Instafy debug app installed
  - `.env.user` with `TEST_USER_1_EMAIL` / `TEST_USER_1_PASSWORD`, or `TRI_CLIENT_EMAIL` / `TRI_CLIENT_PASSWORD`
- What it does:
  - creates a fresh local project and conversation
  - opens the same conversation in browser, Electron, and the connected Android app
  - attaches the Android app device as `Camera`
  - sends `@octo capture a front selfie` from Electron
  - verifies the phone captures and the assistant result lands back in the shared conversation
- Useful overrides:
  - `TRI_CLIENT_BASE_URL`
  - `TRI_CLIENT_CONTROLLER_URL`
  - `TRI_CLIENT_SERIAL`
  - `TRI_CLIENT_PROMPT`
  - `TRI_CLIENT_EXPECTED_RESPONSE`
  - `TRI_CLIENT_DESKTOP_CDP_PORT`
  - `TRI_CLIENT_ANDROID_WEBVIEW_PORT`

## Local Two-Device Camera Smoke
- Simulator-backed day-to-day lanes:
  - `pnpm test:camera:tri-client:smoke:ios-simulator`
  - `pnpm test:camera:tri-client:smoke:desktop-provider:ios-simulator`
  - use these when no physical iPhone is connected; they prove provider routing and chat/capture lifecycle without proving real iPhone hardware or permission prompts
- Recommended day-to-day lane:
  - `pnpm test:camera:tri-client:smoke:recommended`
- Physical Android + second Camera device:
  - `pnpm test:camera:tri-client:smoke:two-devices`
- Physical Android + iPhone simulator:
  - `pnpm test:camera:tri-client:smoke:two-devices:ios-simulator`
- Recommended default:
  - use `pnpm test:camera:tri-client:smoke:two-devices:ios-simulator` for the regular multi-device lane
  - use the fully physical lane only when you specifically need real iPhone hardware validation
- Device checklist:
  - Android stays connected over adb
  - both phones stay in the same Instafy space
  - both phones stay unlocked long enough for setup and capture
  - when running the physical iPhone lane, watch for Apple automation or trust prompts
- What it does:
  - creates a fresh local project and conversation
  - attaches Android as the first Camera device
  - attaches an iPhone device as the second Camera device
  - sends one capture request to Android
  - switches the preferred Camera device in `Extensions`
  - sends a second capture request and verifies it routes to the newly preferred iPhone device
- Physical iPhone notes:
  - the phone must stay unlocked and awake during XCTest startup
  - Apple UI automation approval may need to be accepted on-device
  - the separate XCTest runner app (`dev.instafy.studio.uitests.xctrunner`) can require a developer-certificate trust step on the phone even if `Instafy` itself already launches
  - if the run fails before the Instafy flow starts with a certificate-trust or `xctrunner` launch error, trust the developer certificate in `Settings -> General -> VPN & Device Management`, then rerun
  - Apple’s physical-device XCTest automation can still fail before the Instafy flow starts; if that happens, rerun the simulator-backed lane to validate product logic first
  - the run currently needs enough free space on the phone to reinstall `Instafy` for the UI test bundle; if iOS reports insufficient storage, free space on the device or use the simulator-backed lane instead

Recommended camera validation matrix:
- regular camera regression lane: `pnpm test:camera:tri-client:smoke:recommended`
- strongest Android hardware lane: `pnpm -C packages/frontend test:android:camera:smoke`
- strongest cross-device hardware lane: `pnpm test:camera:tri-client:smoke:two-devices`
- use the full physical two-device lane only when you specifically need real iPhone camera hardware evidence

Interpretation:
- use the recommended lane for normal product work and regressions
- use the Android hardware lane when you are changing the Android native capture path
- use the full physical two-device lane only for final confidence that browser/Electron can route to two real phones and switch the preferred device correctly

## iPhone Camera Smoke
- Run: `pnpm test:ios:camera:smoke`
- Requires:
  - a connected iPhone with Developer Mode enabled
  - `Settings > Safari > Advanced > Web Inspector` enabled
  - the Instafy iPhone app installed
  - the phone unlocked during the first automation run
- What it does:
  - opens `Extensions`
  - attaches the current iPhone as `Camera`
  - grants camera permission if needed
  - captures a real photo on the device and verifies Camera records it
