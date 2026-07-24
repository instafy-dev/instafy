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

Public Build keeps four stable job names:

- Secret scan
- JavaScript packages
- Go packages
- Rust packages

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
check in addition to the four Public Build names.

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
builds/tests the Desktop app and its runtime helper. The Go and Rust jobs test
the public service packages directly. Full-stack Playwright suites remain
available to contributors and downstream distributions, but are not required
public-branch checks because they depend on a larger local/deployment fixture.

Environment-gated suites remain non-required:
- payments
- voice / speech / desktop voice
- private GitHub / secrets-dependent flows
- desktop or hardware-specific smokes

Stripe-backed payment tests are opt-in and require test-mode Stripe credentials. They are not part
of the default public CI gate.

Automation browser cleanup:
- repo-launched Playwright Chromium sessions now run under `tmp/automation-browsers`
- the Playwright wrapper and smoke scripts clean up those owned browser trees on normal exit, failures, and handled interrupts
- if a prior run was killed hard and left owned automation browsers behind, run `pnpm test:automation:cleanup`

Run the local stack first:
- `pnpm stack:up`
- `pnpm stack:down` when finished.

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
