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
- Large-chat navigation/cache benchmark: `pnpm --filter @instafy/frontend test:e2e:conversation-perf`
- Headed: `pnpm test:e2e:headed`
- Target a failing spec: `pnpm -C packages/frontend test:e2e -- tests/playwright/app.spec.ts -g "renders landing hero content"`

The default `pnpm test:e2e` loop is intentionally product-focused:
- it covers the regular Playwright regression surface
- it does not load the opt-in benchmark specs under `tests/playwright/bench`
- benchmark coverage stays available through `pnpm test:e2e:bench`, which sets `PLAYWRIGHT_RUN_BENCH=1`

The separate [conversation performance lane](../packages/frontend/tests/playwright/conversation-perf/README.md)
builds the production history/transcript components against synthetic HTTP. It needs no live
account, controller, database or compute. It measures repeated warm switches, cancellation and
failure recovery, cache eviction and post-GC Chromium heap across a navigation soak. Its fixture
org/space/tab controls exercise conversation scopes; full Studio navigation and access checks
remain the responsibility of the application suites. Install Playwright Chromium first, or set
`PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome` to select an installed Chrome explicitly. Measurements are
written under `packages/frontend/test-results/conversation-perf/`; serialized cache payload and
actual V8 heap are reported separately.

Public Build keeps its existing job names:

- Secret scan
- JavaScript packages
- Go packages
- Rust packages

It also calls the secret-free `Browser verification` workflow on every pull
request, `main` push, and manual Public Build run. That workflow has three
required checks: `Personal Browser E2E`, `Browser UI rendering`, and
`Shared Browser profile E2E`. The Shared check aggregates two complete,
independent fixture jobs. A failure in any of them fails Public Build,
including its downstream release-workflow result. Repository administrators
must also require the emitted browser job checks in branch protection; adding
workflow YAML does not change repository protection settings.

The four summary checks (`JavaScript packages`, `Rust packages`, `Rust tests`
and `Shared Browser profile E2E`) retain `always()` behavior for pull requests,
manual dispatches and other contexts. Only a canceled workflow from a protected
`main` push in the canonical repository may skip those aggregates, so an obsolete
Build need not retain workers for its summaries. An uncanceled Build still runs
the summaries and rejects every failed, canceled, skipped or missing child.
This exception does not change test commands, step-level artifact/stack cleanup,
runner routing or branch protection. Canceled/skipped Build runs are not successful
release evidence. Do not broaden this to PRs: GitHub can count a condition-skipped
required job as successful. See [workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
and [required-check semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
`node --test scripts/check-javascript-ci.test.mjs` covers all four predicates,
actual aggregate gates and complete workflow-byte preservation; these source
regressions do not prove GitHub scheduler behavior. The guard relies on GitHub's
native boolean [`github.ref_protected` context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context), not a caller-supplied string or
number; the fixtures also model Actions' numeric coercion for synthetic values.

System SDK and tool-cache reclamation is limited to GitHub-hosted runners.
Self-hosted runners retain their installed toolchains. Runtime image publication
checks its minimum 20 GiB free disk separately on every runner; skipping SDK
reclamation cannot skip that prerequisite. This safeguard does not select a
runner or enable publication. `node --test scripts/check-public-release-workflows.test.mjs`
includes the cleanup inventory and executable free-disk regression checks.

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

The boundary job runs on GitHub-hosted `ubuntu-latest`, like every other public
job; the public repository contains no self-hosted runner routing (see
`scripts/check-hosted-only-runners.test.mjs`). The installer verifies the pinned
Gitleaks 8.30.1 archive for either Linux x64 or ARM64 and rejects unsupported
architectures.

The standalone UI configs are `packages/frontend/playwright.ci-ui.config.ts`
and `packages/frontend/vite.ci-ui.config.ts`. Avoid `.br` inside these source
basenames: the pinned scanner's [archive matcher](https://github.com/mholt/archives/blob/v0.1.2/brotli.go)
treats that substring as Brotli, including ordinary `.browser` names.
The rename preserves the browser lane, fixture inventory and Vite cache path;
scanner rules, archive depth and unexpected-read failure behavior are unchanged.
`node --test scripts/browser-ci-workflow.test.mjs` covers the names, all consumers
and the existing browser-lane behavior.

Every Public Build job (secret scan, Go, Rust formatting, the npm policy check
and the split JavaScript/Rust lanes below) runs on GitHub-hosted Ubuntu. Run
`node --test scripts/check-hosted-only-runners.test.mjs` to prove that no
workflow names a self-hosted label, runner group or routing switch; it is
part of the JavaScript contracts lane.

### Protected-main manual CI

Explicit `workflow_dispatch` runs of protected `main` (Public Build, the
Browser workflows, Auth Email, Controller database tests, the Git conflict
fixture, npm Select/Version/Pack and the image publishers) run on the same
GitHub-hosted runners as push and pull-request events, with unchanged commands,
permissions and timeouts. The publishers' first step still requires
`inputs.commit_sha` to equal the current protected-main commit;
npm publish keeps its hosted `npm-release` environment and trusted-publisher
OIDC. Run `node --test scripts/check-public-release-workflows.test.mjs` for
the release-workflow regressions.

The seven service cells, four runtime flavor/architecture cells, original
30/75-minute limits, approval, scan-before-login gates, immutable manifests,
GitHub-token permissions and provenance settings are unchanged. Runtime builds
produce both amd64 and ARM64 images natively on architecture-matched hosted
runners, each scanned with its pinned per-architecture Trivy binary. The
five-minute coordinator never waits for child publishers.

Debian service final stages explicitly refresh inherited security packages and
check distribution-specific minimum versions after installation. Installing an
unrelated package does not refresh every vulnerable base package. Bookworm
services enforce the PCRE2 floor; Trixie services additionally enforce gzip,
SQLite and Perl-base floors. `node --test scripts/check-production-image-inputs.test.mjs`
checks every Debian publisher cell plus the standalone speech-host image.
These source checks do not replace the unchanged scan-before-publication gate.

The path-filtered `Public Git Conflict Contract` runs its five-minute
`Deterministic conflict fixture` on hosted `ubuntu-latest` with read-only
permission, an exact-event non-persistent checkout and the original local Git
conflict/rebase/push assertions. Run `node --test scripts/check-git-conflict-ci.test.mjs`
for the fixture regressions; the workflow runs these tests as well.

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

`.github/CODEOWNERS` assigns **all paths** to the existing trusted code owners,
`@instafy-bot` and `@instafy-bot-2`, and retains the narrower workflow/action and
boundary-control entries under `@instafy-bot`. Outside contributions, including
ordinary product changes and edits to CODEOWNERS itself, need an applicable
owner's review. GitHub uses CODEOWNERS from the
target branch, so a PR cannot remove its own review requirement. Keep the
blanket required-approval count at **zero** and code-owner review **enabled**:
the code owners' own bot-authored PRs retain their existing review behavior and
must still pass all protected CI checks. Do not introduce an auto-approve Action,
a bot bypass, or a new release gate to implement this policy. A new trusted bot
identity requires an explicit ownership-policy review; a name ending in `[bot]`
does not confer trust.

Before making the repository public, verify the live branch settings (source
tests do not configure GitHub): code-owner review enabled, blanket approvals
zero, stale approvals dismissed after code changes, and existing required checks
unchanged. Confirm an unapproved non-owner PR needs review and an existing
owner-authored bot PR gains no extra review requirement. Do not bypass a merge
block merely to test it.
After the visibility change, select **Require approval for all external
contributors** in this repository's Actions settings before approving any fork
run. That setting is not exposed while this repository is internal; do not
silently substitute an organization-wide policy change. Workflow approval only
permits the secret-free hosted checks; it does not approve a merge or release.
Issues and comments are untrusted input, never authority for privileged actions.

Do not use a push-path ruleset as the permanent trust anchor: GitHub disables
all push rulesets when an internal repository becomes public. See GitHub's
[code-owner rules](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
and [repository Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

The trusted policy intentionally makes a binary addition/removal, approved
environment-path addition, or Codex repin fail its own PR. Those rare changes
require a security maintainer to inspect the bytes or object, update the policy,
and use the explicit protected-branch break-glass path. Normal source
contributions do not require that manual security review.

The required `JavaScript packages` context is a strict aggregate over four
independent jobs, subject only to the canceled-main exception above. Each child
has a 30-minute limit, checks out the same exact event commit and recursive
submodules, and performs its own unfiltered frozen
monorepo installation on Node20. No existing check is removed:

| Child | Checks |
| --- | --- |
| JavaScript contracts and migrations | Workflow/release/migration/self-host contracts and real empty-database migration application |
| JavaScript frontend | Frontend lint, build and the complete unit suite |
| JavaScript CLI and provider contract | CLI package artifact and automations; provider-contract packing |
| JavaScript Desktop and runtime | Runtime helper build/tests and complete Desktop build/tests |

The aggregate keeps the existing required name and fails if any fixed child
fails, times out, is cancelled, skipped or missing. It receives no repository
credentials and checks out no source. It has a five-minute limit and starts
only after the child jobs end.

All five jobs run on hosted `ubuntu-latest`. Run
`node --test scripts/check-javascript-ci.test.mjs` for coverage and aggregate
regressions.

### Bounded Rust CI

`Rust packages` and `Rust tests` retain their existing check names as strict
five-minute aggregates. The first requires all five compile-check children;
the second requires all five test children. Each child is independent, uses
the same exact event commit and recursive submodules, and has a 30-minute
limit. Missing, skipped, cancelled or failed children fail the corresponding
aggregate. Aggregates have no repository permissions or checkout and are
scheduled only after their children finish; they do not hold a worker while
waiting for other workers. Only the canceled-main exception above skips them;
pull requests and manual runs retain always-run, fail-closed aggregation.

| Child | Preserved commands |
| --- | --- |
| Rust check runtime controller | Controller `cargo check --locked --tests` |
| Rust check runtime agent | Agent `cargo check --locked --tests` |
| Rust check git service | Git service `cargo check --locked --tests` |
| Rust check runtime provider | Provider service `cargo check --locked --tests` |
| Rust check tunnel broker | Tunnel workspace `cargo check --locked --tests` |
| Rust test runtime contracts | Complete runtime-contracts suite |
| Rust test runtime agent | Agent `--no-run`, followed by `--lib --test controller_client -- --test-threads=1` |
| Rust test OpenAI proxy | Complete openai-proxy-server suite |
| Rust test origin server | Complete origin-http-server suite |
| Rust test git service | Complete git-service suite |

All eleven original Cargo commands retain their arguments and repository-root
working directory. Test children also retain the full frozen Node20/pnpm
installation, including the pinned Playwright fixture required by agent tests.
Stable native Rust and debug-info settings are unchanged. Each child has its
own target directory; Cargo caches are partitioned by job, operating system,
CPU architecture and the exact workspace Cargo lockfiles, with no cross-arch
or old-lock fallback, using the pinned save/restore cache action. A cache miss
still runs every command cold and must fit the same 30-minute limit. An
uncanceled Build never ignores a test failure, child cancellation or aggregate
failure. Test children free unused hosted-image toolchains before compiling.

All twelve jobs run on hosted `ubuntu-latest`. Run
`node --test scripts/check-rust-ci.test.mjs` for the exact command inventory
and strict aggregate regressions; these source tests do not run Cargo.

The empty-database test
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

## Disposable database and auth-email CI

For a clean, unlinked local stack on a connection-constrained Docker host,
`SUPABASE_SERIAL_PULL=true pnpm supabase:up` prepares image references one at a
time before the unchanged startup command. The default is unchanged. The option
requires the locked Supabase CLI 2.92.0: its ten-image `services --output json`
inventory is supplemented with the four ancillary images from that exact CLI.
Full-stack mode prepares all 14 images, including disabled extras (an intentional
download/disk cost); database-only mode prepares only its resolved Postgres image.
The explicit Auth-only profile prepares seven images after validating the same
complete pinned inventory: five persistent services plus Realtime and Storage
images for the CLI's one-shot schema initialization. Serial preparation itself does not change the selected
startup profile, skip tests, alter TLS, or increase runner limits.
The separate browser-test profile validates that complete inventory too, then
prepares all 13 images except Edge Runtime.

Preparation uses an empty temporary CLI/Docker home and anonymous public-ECR
pulls against the default local Docker daemon. Linked projects, local dotenv
files, registry/Docker/configuration overrides and credential-bearing proxies
are refused on this opt-in path. Only validated HTTP(S) proxy origins are copied;
existing developer homes and credentials are not loaded. A fixed invalid token
sentinel also prevents the CLI from consulting the operating-system keychain.
Each pull is bounded to three minutes and total preparation to ten minutes inside the existing job
timeout. Exact-ref local inspection must succeed before startup; failures stop
without entering the normal startup retry. Failed Docker commands report only
the fixed preparation stage/image name, bounded exit/signal/error-code fields,
and fixed hints derived from at most 32 KiB of stderr. Raw output, image tags,
URLs, paths and credentials are not logged. Hints are Docker-reported symptoms,
not proof of the underlying cause; a signal is not proof of an out-of-memory
failure. The `tls` hint retains compatible classification, with additional
`tls-certificate`, `tls-handshake-timeout` or `tls-handshake-rejected` hints
when Docker reports that specific symptom. Do not treat a certificate failure
as a network timeout or disable verification to make the pull succeed.
Missing/oversized/unrecognized diagnostics remain unclassified. This
does not retry a failed pull, skip an image or change the failure result.
CLI upgrades require updating and
testing the pinned ancillary inventory. Run
`node --test scripts/lib/supabaseSerialPull.test.mjs` for offline regression tests.
These do not qualify real cold downloads or concurrent connection usage.

`Controller database tests` (30 minutes) and `signup -> email -> activate`
(25 minutes) run on hosted `ubuntu-latest` with their complete commands, frozen
Node20 workspace installation, and read-only checkout. Controller tests use the local
Postgres-only stack and all public migrations; auth-email explicitly sets
`SUPABASE_AUTH_ONLY=1` for its startup step. This fixed profile retains Postgres,
GoTrue, Kong, Mailpit and PostgREST; PostgREST is needed for the unchanged CLI
status reader to report `API_URL`. Both initial startup and its existing retry
exclude Realtime, Storage, imgproxy, Edge Runtime, Postgres Meta, Studio,
Logflare, Vector and Supavisor. Template-mount verification, every migration,
status resolution and all signup/email/OTP/activation assertions remain intact.
With the pinned CLI 2.92.0 and Postgres 17, enabled Realtime and Storage still run
their sequential initialization containers before service exclusions apply.
Their images are therefore prepared too; configuration and schema initialization
are not disabled merely because those persistent services are unnecessary here.

For the same local profile, run `SUPABASE_AUTH_ONLY=1 pnpm supabase:up`, optionally
with `SUPABASE_SERIAL_PULL=true`. Auth-only accepts only unset, `0` or `1`, and
cannot be combined with `SUPABASE_DATABASE_ONLY=1`. Neither flag changes default
full-stack startup; database-only startup still uses `supabase db start`.
An already-running stack retains the existing reuse behavior, so the Auth workflow
explicitly stops stale stacks first. A passing Auth-only run does not qualify the
separate browser-test workloads used by Shared Browser. Neither lane needs
production credentials, an external mailbox, a deployment, or released images.

The controller needs native Rust, a C/C++ compiler, Make, pkg-config and OpenSSL
development files, all present on the hosted image; its protobuf compiler is
vendored by the locked Rust build. Cargo uses two compile jobs and an
OS/architecture/lock-specific cache. Auth-email does not compile Rust. Both
workflows stop their local stack on exit.

## Support workflow simulation

The support component browser suite exercises the production profile menu, report composer,
inbox, follow-up form, notification hook, and status toast in desktop and narrow phone viewports.
It uses synthetic authentication and controller responses with the real frontend HTTP client;
it needs no account, database, model, or provider credentials. From `packages/frontend`, run:

```bash
node ./node_modules/@playwright/test/cli.js test --config playwright.support-ci.config.ts
```

Use `PLAYWRIGHT_BROWSER_UI_CHANNEL=chrome` to select an installed Chrome when the pinned
Playwright Chromium is unavailable. The dedicated configuration launches the existing minimal
Vite component server directly and does not load local environment files. This is browser UI
simulation; it does not prove a deployed controller or external push delivery.

The corresponding controller checks require an isolated Postgres database with the public
migrations applied, selected explicitly by `TEST_DATABASE_URL`. Run from the repository root:

```bash
cargo test --manifest-path packages/runtime-controller/Cargo.toml tests::support_workflow_tests
cargo test --manifest-path packages/runtime-controller/Cargo.toml tests::support_report_messages_are_owner_scoped_safe_and_idempotent -- --exact
cargo test --manifest-path packages/runtime-controller/Cargo.toml tests::support_report_routes_enforce_customer_privacy_boundary -- --exact
```

These exercise the real report routes and database. The first group checks required and stale
triage versions, customer activity checks during resolution, simultaneous resolution-alert
claims, and viewing a resolution before the polling loop claims it. The lifecycle check covers
operator replies, review, resolution, acknowledgement, customer follow-up, and re-resolution.
The privacy check verifies owner isolation, operator boundaries, and account mismatch rejection.

## Secret-free browser CI lanes

`Browser verification / Browser UI rendering` and
`Browser verification / Personal Browser E2E`, called by Public Build, run on
hosted `ubuntu-24.04` with a 30-minute limit each; browser test-level timeouts,
commands, permissions, locked installations and required reports are unchanged.
Personal CI prepares the exact locked Electron binary with
`pnpm --filter @instafy/desktop-app exec install-electron` before the test process.
[Electron 42 and newer download lazily](https://www.electronjs.org/blog/electron-42-0), so a successful package install alone
does not prove that binary exists. The five-minute preparation step enables
Node's environment-proxy support (available since Node 22.21); it uses the installed package and its bundled
checksums, not an unpinned `npx` download. Proxy settings still do not enter the
scrubbed Playwright or Electron fixture environments. The workflow regressions
run in `node --test scripts/browser-ci-workflow.test.mjs`.

### Bounded Shared Browser CI

`Browser verification / Shared Browser profile E2E` retains its required name
as a strict five-minute aggregate, with only the canceled-main exception above.
It succeeds only when both fixed children finish successfully; missing, skipped,
cancelled or failed children
fail the aggregate. It has no repository permissions or checkout and starts
only after the children end, without holding a worker while waiting.

| Child | Complete command |
| --- | --- |
| Shared Browser profile lifecycle | `xvfb-run -a node scripts/browser-profile-e2e.mjs` |
| Shared Browser Studio journey | `xvfb-run -a node scripts/shared-browser-studio-e2e.mjs` |

Each child has a 30-minute limit and repeats the full locked workspace,
Chromium, Go/Rust, system-library and fixture-safety preparation. Each owns a
fresh migrated Supabase stack with local authentication and always attempts
stack teardown. The profile-only script still permits a separately provisioned
migrated loopback database; the signed-in Studio journey needs real local
GoTrue. No fixture command, scenario, receipt, cleanup or safety check is
replaced by the aggregate. Only the same fixed credential-free receipt paths
are uploaded, separately per child. Compiler cache keys include the
operating system and architecture; compiler targets are child-specific with
no old-lock or cross-architecture fallback.

The children use `pnpm supabase:up` to prepare their actual CLI-selected images
and apply migrations. They do not restore `~/.instafy-image-cache` or run
`ensure-supabase-postgres-image.mjs`: that helper prepares a digest-derived local
tag consumed by the separate empty-database migration test, not by CLI startup.
The standalone migration lane retains its image cache and helper. Removing this
extra archive transfer/load/save leaves browser image pulls, compiler caches,
authentication, assertions and teardown intact. Docker layers can overlap, so
measure both complete cold child jobs before claiming an end-to-end speedup.

Both children explicitly set `SUPABASE_BROWSER_TEST=1` only for startup. This
fixed profile excludes **only Edge Runtime**, using `supabase start --exclude
edge-runtime` on initial startup and the existing retry. Postgres, GoTrue, Kong,
Mailpit, PostgREST, Realtime, Storage and every other configured service remain
unchanged. The fixtures do not contain or invoke Edge Functions: the lifecycle
fixture exercises the real database/controller/browser, and the Studio journey
uses local Auth plus controller APIs. Excluding Edge Runtime avoids its unrelated
bootstrap module downloads; it does not replace any browser assertion, disable
schema initialization, change global Supabase configuration or grant network
access. New function-dependent scenarios require re-reviewing the profile.

For the same local profile, start a fresh stack with
`SUPABASE_BROWSER_TEST=1 pnpm supabase:up`, optionally adding
`SUPABASE_SERIAL_PULL=true` for the 13-image preparation. The profile accepts
only unset, `0` or `1`, and cannot be combined with Auth-only or database-only.
Default startup is still the full stack, database-only still uses `db start`,
and Auth-only retains its five persistent services plus two schema images.
Existing-stack reuse is unchanged: stop a previous stack before switching
profiles. This source change does not qualify cold Shared Browser execution;
both complete child scenarios and cleanup must still pass on the target runner.

All three jobs run on hosted `ubuntu-24.04`. CI sets
`INSTAFY_SHARED_BROWSER_COMPILER_PROXY=0`; the fixtures' compiler-only proxy
opt-in remains available for local runs and never enters database commands,
display probes, controller services or browser processes.

On Linux, the four Cargo fixture builds default to `RUSTFLAGS="-C link-arg=-fuse-ld=lld"`
only when `RUSTFLAGS` is unset. This keeps the existing compiler driver and
requires `lld` on the build host; both Shared workflow children already install
it. Every explicit `RUSTFLAGS` string, including an empty opt-out, is preserved
byte-for-byte. Other platforms and the two Go builds retain their existing
compiler environment. The default aims to reduce peak linker memory without
changing Cargo arguments, features, fixture assertions or runtime environments.
A warm final-link result alone does not qualify cold end-to-end CI or its memory
and time budgets.

Run
`node --test scripts/check-shared-browser-ci.test.mjs scripts/browser-profile-e2e.test.mjs scripts/shared-browser-studio-e2e.test.mjs`
for the workflow, fixture and environment regressions, not live browser qualification.

These lanes use disposable data, do not load local `.env` files, and do not
need a real account, model API key, or production controller. Personal and UI
lanes run through `pnpm test:browser:ci <lane>`, which removes ambient
credentials and development endpoint overrides before starting Playwright.
Their strict reporter requires the known test inventory and a single passing
attempt per test: skips, expected failures, retries, filtered subsets, and zero
tests fail the lane. Failure traces and a machine-readable result are retained
under `packages/frontend/test-results/browser-ci/<lane>`.

The 39-case serial `browser-ui` lane has a six-minute total budget for hosted
runners; each test still has a 30-second limit, with no retries or skips allowed.

| Lane | What it proves | Local requirements |
| --- | --- | --- |
| `personal` | Real Electron profile/cookie persistence across restarts and projects, per-user isolation, clear, kill switch, renderer ownership revocation, and native form-owner/type descriptors (4 tests) | Installed workspace dependencies and compiled Desktop fixture; no Docker or database |
| `browser-ui` | Real Chromium rendering of browser chrome, cursor overlay, routine approval, expansion/takeover sequencing, rendered-frame checks, full Shared modal safe-area/keyboard geometry, focused-editable reveal, phone session/resume/save-status controls, retained-editor Unicode input isolation, mobile drawer safe-area/focused-search geometry and Escape drill-in dismissal, Studio history/scroll navigation, and focused-chat header/overview dock/picker navigation with simulated keyboard geometry and a synthetic retained input (at least 39 tests) | Installed workspace dependencies and Playwright Chromium; no Docker, database, or controller |
| Shared co-browsing tool fixture | Production browser tools in real Chromium: one routine grant across two sites, highlighted manual fields, fresh continuation observation, and local action timings | Installed workspace dependencies and locked Playwright Chromium; no Docker, database, controller, model or real accounts |
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

The two Shared session/status cases mount the complete production modal at
390×844 and 844×390 with touch input and safe-area insets. They verify bounded
scrolling, readable save-status guidance, 44px touch controls, token-free resume
links, and exact session selection. Controller/status responses, transport and
clipboard delivery are simulated; these cases do not prove a live cross-device
runtime, native clipboard integration, or login recovery.

The retained-editor input case uses the production CDP/WebRTC input binding and
real Chromium pointer/keyboard events. It checks that Unicode text aimed at the
remote canvas cannot edit a previously focused local draft, and that disabled
input authority forwards no text. Its message sink is simulated; it does not
prove every operating-system IME or noncancelable composition event sequence.

The two expanded Shared mobile safe-area cases also simulate a visual-only
keyboard shrink while keeping the layout viewport unchanged. They check
visible height, viewport panning, restoration, and stable focused controls
without remounting the browser surface. This is layout coverage, not proof that
a physical iOS/Android keyboard opened or that a live remote field scrolled.

The focused-editable case extracts the exact fixed reveal script from the
origin and executes it after a real Chromium viewport shrink. It verifies
clipped editable fields, open shadow roots, nested scrollers, and non-editable
or already-visible no-ops without reading field values. This script-level case
does not substitute for the origin's resize-acknowledgement and control checks.

The mobile-sidebar keyboard case mounts the production drawer, drill-in and
workspace switcher with inert teams/spaces. It simulates visual-only keyboard
shrink and panning, including a search that filters away every following row,
and checks centered focus, retained text, restoration and unchanged backdrop
safe areas. Native iOS accessory controls are not part of Chromium's viewport:
physical verification must compare the field with both the keyboard and any
separate accessory toolbar, then verify normal clear/Back/close cleanup.

Studio navigation cases combine the production tab provider, routing hook, destination API,
chat scroll orchestration and mobile sidebar history with real Router/browser entries. They
check exact chat and job IDs, repeated visits with different reading positions, rapid navigation,
Home-style direct links, unloaded conversations and abandoned cross-space hydration. Separate
cases exercise URL-driven Settings sections and delayed panel scroll restoration, plus the
native-shell Back/Forward controls with 44px targets. Authentication, conversation/project data
and transcript rows are synthetic. These are not signed-in controller or physical-device proofs;
Android system Back, native keyboard ordering, iPhone Safari/WKWebView and the packaged Electron
shell still need explicit smoke checks against the candidate assets.

The three mobile navigation viewport cases use the production header, overview-only dock policy,
destination bar and compact picker. They verify no extra bottom row in a conversation, stable
Home/Chats/Spaces overview destinations, direct-entry Chats fallback, exact Back/Forward visits,
remote-only space selection without legacy store mutation, and retained input/picker geometry
across simulated keyboard transitions. Project access/data and the retained draft are inert
fixture boundaries; these cases do not replace full Studio/native keyboard verification.

Origin protocol unit tests also preserve fractional pointer coordinates, wheel
deltas, and device pixel ratios with the runtime's actual JSON parser features.
They retain strict field/type checks and the existing finite-value and viewport
bounds; successful integer-coordinate clicks alone are insufficient coverage.

The required **Browser UI rendering** job also runs the real co-browsing tool
fixture before the UI lane. Run it locally with:

```bash
node --test scripts/shared-browser-cobrowsing-e2e.test.mjs
node scripts/shared-browser-cobrowsing-e2e.mjs
```

The fixture creates two loopback websites and a disposable browser profile. It
executes the production approval/tool scripts, grants routine browsing once,
checks real field outlines at desktop and phone widths, waits for tool exit,
enters inert values manually and starts a fresh observation. It checks that the
password-style fixture value does not enter tool output or action telemetry.
It also checks that ordinary non-submitting form buttons use routine approval,
while genuine submission buttons wait for an explicit one-shot decision before
the inert form's submission handler runs.
Only fixed-schema results, timing summaries and inert-page screenshots are kept
under `packages/frontend/test-results/browser-ci/shared-cobrowsing`; the profile
and raw session files are removed.

The accompanying UI tests use production React controls with a synthetic native
host to prove Take over waits for confirmed quiescence, keeps manual state across
Expand/Collapse, and sends an explicit Done continuation. Rust/native/hook tests
separately cover shutdown, stale ownership and exact dispatch. These are layered
proofs, not a complete live-model, signed-in Studio handoff or deployment proof.

The tool fixture reports five-sample min/median/max wall times for snapshot and
click at two page sizes. These include process startup, CDP attachment and
settling; they are local responsiveness observations, not pixel-transport latency
or a release performance threshold. Hidden Shared action polling and overlapping
requests have separate regression coverage.

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

The four Shared fixture Cargo builds keep JSON artifact discovery unchanged.
On a failed build they report at most eight compiler-error headings and bounded
repository-relative Rust source locations. Quoted payloads, URLs, absolute
paths and credential-like headings are redacted; source snippets, linker
arguments, build-script environment, other JSON records and arbitrary child
stdout are not printed. Each JSON record is limited to 256 KiB for diagnostics;
oversized or unrecognized records are omitted, not inferred. This diagnostic
path does not make a failing compiler or missing executable pass. Crate-relative
locations use the fixed agent/controller callsite context only when Cargo's
manifest matches that exact checkout crate; dependency locations are omitted.
Absolute, Windows and escaping span paths are refused. Reproduce
the complete fixture on disposable Linux to obtain the real compiler error;
passing parser tests alone does not qualify the browser workload.

Compiler child notes can add only fixed observed categories: `linker-failed`,
`linker-killed`, `missing-library`, `undefined-symbol`, `disk-full`, or
`allocation-failed`. No matched note, command, environment, symbol or library
name is printed. Notes are explicitly `absent`, `unclassified`, `matched`,
`limited`, or `invalid`. The reader examines at most 16 direct notes, each at
most 64 KiB UTF-8, 128 lines and 2048 bytes per line; it never recurses. The
existing eight-error/256-KiB-record limits remain. Credential/URL/command-shaped
lines are ignored. These categories report compiler text, not proven causes:
in particular, linker SIGKILL is **not proof of an out-of-memory kill**.

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
Runtime generations also receive distinct mode-0700 temporary directories
directly below the owned fixture root. These paths are bounded to leave room
for Chromium's ProcessSingleton Unix socket; nesting them below runtime and
lease UUIDs exceeds Linux's socket-path limit and prevents Chromium startup.
The temporary data stays fixture-owned and is removed during final cleanup.

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
