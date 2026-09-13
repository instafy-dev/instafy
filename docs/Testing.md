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

The boundary job alone has a temporary, default-off runner bootstrap switch:
`CI_BOOTSTRAP_SELF_HOSTED=true`. It selects a disposable Linux ARM64 runner only
while this repository is private, for same-repository `pull_request_target`
events targeting `main` or pushes to protected `main`. Public repositories,
fork pull requests, other events, and an unset or disabled switch retain
`ubuntu-latest`. The respective organization runner groups are `instafy-ci-pr`
and `instafy-ci-main`. A unique
`instafy-ci-bootstrap-<repository-id>-<run-id>-<attempt>-boundary` label replaces
the ordinary role label, so the bootstrap runner is scoped to this job and
attempt. Runner provisioning must independently authenticate that exact job
and destroy the disposable guest after it finishes. This switch does not
enable other CI jobs, change protection, or authorize release work.

Routing preserves the existing read-only permissions, trusted checkouts,
candidate-as-data boundary, scanner version and scans. The installer verifies
the pinned Gitleaks 8.30.1 archive for either Linux x64 or ARM64 and rejects
unsupported architectures. Remove or disable the switch to restore hosted
routing; no runner credentials or host configuration belong in this tree.

The independent, default-off `CI_EXPANDED_SELF_HOSTED=true` switch covers only
four additional short jobs. It does not replace the boundary switch:

| Job | Eligible events | Literal runner-label suffix |
| --- | --- | --- |
| Secret scan | Protected `main` push | `public-secret-scan` |
| Go packages | Same-repository PR to `main`; protected `main` push | `public-go` |
| Require reviewed Changeset release intent | Same-repository PR to `main` | `public-npm-policy` |
| Rust formatting | Same-repository PR to `main`; protected `main` push | `public-rust-fmt` |

All four require this repository to remain private; forks, public visibility
and unsupported events keep their existing hosted selection. The three
non-PR-policy jobs also support the exact-main manual route described below.
Each disposable Linux ARM64 runner uses the same trust-specific organization
group and unique `instafy-ci-bootstrap-<repository-id>-<run-id>-<attempt>-<suffix>`
label format as the boundary lane, without an ordinary role label. Labels are
placement constraints, not an exclusive job reservation: provisioning must
authenticate the exact workflow source and assignment, retain bounded job and
cleanup deadlines, and destroy the guest. Unknown cleanup must quarantine
capacity, not trigger a blind retry. No host credentials belong in the guest.
Before checkout, each self-hosted job requires an actual non-root Linux ARM64
process, Node22, the ephemeral marker, no private environment directory and its
baseline tools. This prerequisite check does not itself prove guest isolation.

Release jobs remain outside these switches. JavaScript, Rust compilation/tests
and the two browser lanes have their own independent switches described below.
The four job names, permissions and timeouts are unchanged; the main scanner
uses the same pinned x64/ARM64 Gitleaks archives as the boundary. Disable the
expanded switch to restore hosted routing for new runs; already queued jobs
do not automatically move pools. Run `node --test scripts/check-expanded-ci-routing.test.mjs`
for routing regressions. These tests are not real ARM64 workload or teardown
qualification, which is required before enabling the switch.

### Protected-main manual CI

The existing lane-specific switches also cover 31 job definitions on an explicit
`workflow_dispatch` of protected, current `main`: 20 direct Public Build jobs,
the five Browser jobs, Auth Email, Controller database tests, the Git conflict
fixture, and npm Select, Version and Pack. No new switch enables unrelated lanes.
These manual routes require the canonical repository and ID, private visibility,
the exact defining workflow ref on main, and workflow SHA equal to the event SHA.
Other branches, public visibility, unrelated callers and disabled switches retain
the original hosted selection.

Browser permits either its direct manual workflow or the existing exact Public
Build caller. GitHub's [reusable-workflow context](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#github-context)
belongs to the caller; these two cases therefore have different run paths and job
names. Admission must distinguish them explicitly and retain exact-attempt callee
metadata and both workflow pins for the Build case.

Every manual job uses the existing Linux ARM64 main group and unique
repository/run/attempt/job label, with its unchanged commands, resource profile,
timeout and cleanup. The manager must independently re-read protected main and
reject a dispatch whose event SHA is no longer current; inputs cannot choose an
alternate source. The six reviewed workflow pins and exact manual tuples must be
enrolled before activation, including the standalone Browser workflow identity.
Source tests are not a cold workload or cleanup qualification.

Npm Version retains its existing exact-main freshness check before exposing the
version bot credential; this route is not credential-free. Npm Publish still uses
its original hosted runner and trusted-publisher OIDC. Image publication retains
its independent BUILD route. No schedule, PR, automatic route or release authority
is broadened by these manual additions.

`node --test scripts/check-manual-ci-routing.test.mjs` exercises the real selectors
and npm preflights and reconstructs all six complete preceding workflows.
It is also imported by the existing expanded-CI test entrypoint. The preceding
automatic-route tests use only that finite inverse; their original expectations
and byte hashes remain, alongside raw old/new selector equivalence checks.

The separate, default-off `CI_PUBLIC_CONTROL_SELF_HOSTED=true` switch covers
four protected-`main` push jobs: npm `select` (15 minutes, suffix
`public-npm-select`), npm `version` (15 minutes, suffix `public-npm-version`),
npm `pack` (25 minutes, suffix `public-npm-pack`) and the
image coordinator (5 minutes, suffix `public-image-coordinator`). All require the
canonical private repository and repository ID, a protected main ref and their exact main workflow ref. They use
the disposable Linux ARM64 main group and per-run/attempt labels above. Public
visibility, PRs, forks, schedules and unsupported events retain
`ubuntu-24.04`. The three npm jobs also support the manual route above;
the image coordinator's scheduled/manual BUILD route is separate.

This source routing is not runner admission or a successful publication proof.
Before enabling it, provisioning must independently authenticate each exact
workflow/job/event tuple, install and qualify its baseline tools (`gh` for
Select, Version and the coordinator, plus `jq` and GNU `date -d` for the coordinator), and prove cold job
execution and teardown. The first steps fail closed on missing tools, wrong
source identity or a nonisolated runner; they do not install dependencies.
The npm selector retains read-only repository access. The coordinator retains
its existing GitHub-token `actions: write` permission to dispatch the two fixed
publishers, without receiving package, registry or production credentials.
Pack retains read-only actions/repository permissions and its exact selected
publish plan, package tests, pack verification and immutable artifact upload.
Its non-root Node22 preflight requires only the existing baseline tools; the
unchanged setup step then selects Node24 for the pack commands. It does not
receive npm OIDC or the version bot's credential. Version retains its existing
bot credential only in its two original steps, so this lane is not credential-free.
Before those steps, a fresh read must prove the event SHA is still protected main
and the checkout is exactly that SHA. API failure, source drift or failed runner
qualification prevents bot exposure. The original hosted fallback is unchanged.
This source-only route still needs exact runner admission and real cold
execution/cleanup qualification. npm publish remains hosted with its existing
trusted-publisher OIDC authority. A push coordinator can defer while Build is
incomplete. Its scheduled/manual follow-up and the image publishers have the
separate optional BUILD route below; the push-only control switch does not
enable that route. No `workflow_run` trigger is added. Run the source/fixture regressions with:

```bash
node --test scripts/check-public-release-workflows.test.mjs scripts/check-expanded-ci-routing.test.mjs
```

`TRUSTED_AMD64_BUILD_RUNNER_MODE=self-hosted` independently selects the
organization group `instafy-trusted-build` and static labels
`self-hosted`, `Linux`, `X64`, `instafy-build` for all four jobs in each exact-main
image publisher, plus scheduled/manual image reconciliation. The canonical
repository ID must still be private; main must be protected and the workflow
ref and source SHA must match. Manual requests must name that same source SHA.
PRs, forks, public visibility, other refs and a disabled/unset switch retain
their original hosted runners. The existing isolated ARM64 push coordinator
route takes precedence and is unchanged. This BUILD route uses trusted,
ephemeral jobs with the existing Docker-capable build profile; its static labels
are placement, not a claim of VM or network isolation.

The seven service cells, four runtime flavor/architecture cells, original
30/75-minute limits, approval, scan-before-login gates, immutable manifests,
GitHub-token permissions and provenance settings are unchanged. Runtime builds
still produce both amd64 and ARM64 images; on BUILD the scanner uses the existing
pinned x64 Trivy binary rather than the target image's architecture. Hosted
runner matrix selections and scanner pins are unchanged. The five-minute
coordinator never waits for child publishers, so it releases a shared BUILD
runner before those jobs need it.

Before enabling this route, an operator must deliberately enroll this repository
and these three exact `@refs/heads/main` workflow refs in the BUILD group's
protected workflow allowlist and its existing registration policy. Qualify actual
Buildx builds and Trivy scans for both platforms, at least 20 GiB free disk,
artifact commands and ephemeral cleanup on that profile. Source tests do not
prove physical capacity or successful image publication. Disable the switch to
restore hosted selection for new runs; queued jobs do not move automatically.

The version freshness regressions use credential-free Bash fixtures and an offline
`jq` projection of inert branch responses; both tools must be installed locally.

The path-filtered `Public Git Conflict Contract` has its own default-off
`CI_GIT_CONFLICT_SELF_HOSTED=true` switch. Only same-repository, non-fork PRs to
`main` and protected `main` pushes while this repository is private may select
the disposable Linux ARM64 pool. Exact-main manual runs use the route above;
public visibility, forks and unsupported events retain `ubuntu-latest`.
It uses the same trust-specific groups and
per-run/attempt label format above, with literal suffix `deterministic-conflict`.
The first step checks the isolated runner prerequisites before an exact-event,
non-persistent checkout. The five-minute `Deterministic conflict fixture` keeps
its read-only permission and original local Git conflict/rebase/push assertions.
Run `node --test scripts/check-git-conflict-ci.test.mjs` for routing and fixture
regressions; the workflow runs these tests as well. Enabling this switch still
requires independently reviewed exact-workflow admission and an actual cold
job/cleanup proof. It enables no release job.

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

The required `JavaScript packages` context is a strict aggregate over four
independent jobs, subject only to the canceled-main exception above. Each child
has a 30-minute limit, checks out the same exact event commit and recursive
submodules, and performs its own unfiltered frozen
monorepo installation on Node20. No existing check is removed:

| Child | Checks | Runner-label suffix |
| --- | --- | --- |
| JavaScript contracts and migrations | Workflow/release/migration/self-host contracts and real empty-database migration application | `public-js-contracts` |
| JavaScript frontend | Frontend lint, build and the complete unit suite | `public-js-frontend` |
| JavaScript CLI and provider contract | CLI package artifact and automations; provider-contract packing | `public-js-cli` |
| JavaScript Desktop and runtime | Runtime helper build/tests and complete Desktop build/tests | `public-js-desktop` |

The aggregate keeps the existing required name and fails if any fixed child
fails, times out, is cancelled, skipped or missing. It receives no repository
credentials and checks out no source. Its own label suffix is
`public-js-aggregate`, with a five-minute limit; it starts only after the child
jobs end, so it does not occupy a worker while waiting for another worker.

All five jobs default to hosted Ubuntu. The independent
`CI_JAVASCRIPT_SELF_HOSTED=true` switch selects isolated Linux ARM64 workers
only for private, same-repository PRs to main and protected-main pushes, using
the same group and per-job identity rules above. Neither the bootstrap switch
nor the expanded four-job switch enables these jobs. Exact-main manual dispatches
use the route above; other manual refs, forks and public visibility stay hosted.
Use canonical lowercase switch values.

Do not enable this switch until the manager admits all five exact job names,
labels and time budgets from the reviewed protected-main workflow. Its
existing 35-minute worker lifecycle may be retained; publication, migrations
outside the disposable fixture and credentials remain out of scope. Before
checkout, workers verify their native Linux ARM64 identity and ephemeral
marker; the migration child additionally checks a real Linux ARM64 Docker
daemon. Image acquisition needs a guest-owned Docker daemon configured to use
the restricted egress proxy. Node20 downloads, including Desktop speech assets,
must support that proxy without disabling TLS verification. Every child still
installs the full workspace, including approved dependency build scripts.
Splitting the source is not proof that cold installation/builds finish within
30 minutes: each actual ARM64 workload and complete cleanup needs qualification.
Disable the JavaScript switch to restore hosted selection for new runs;
already queued runs do not change runners. No required-check rule changes
are needed. Run `node --test scripts/check-javascript-ci.test.mjs` for routing,
coverage and aggregate regressions; these are not live workload qualification.

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

| Child | Preserved commands | Runner-label suffix |
| --- | --- | --- |
| Rust check runtime controller | Controller `cargo check --locked --tests` | `public-rust-check-controller` |
| Rust check runtime agent | Agent `cargo check --locked --tests` | `public-rust-check-agent` |
| Rust check git service | Git service `cargo check --locked --tests` | `public-rust-check-git` |
| Rust check runtime provider | Provider service `cargo check --locked --tests` | `public-rust-check-provider` |
| Rust check tunnel broker | Tunnel workspace `cargo check --locked --tests` | `public-rust-check-tunnel` |
| Rust test runtime contracts | Complete runtime-contracts suite | `public-rust-test-contracts` |
| Rust test runtime agent | Agent `--no-run`, followed by `--lib --test controller_client -- --test-threads=1` | `public-rust-test-agent` |
| Rust test OpenAI proxy | Complete openai-proxy-server suite | `public-rust-test-proxy` |
| Rust test origin server | Complete origin-http-server suite | `public-rust-test-origin` |
| Rust test git service | Complete git-service suite | `public-rust-test-git` |

All eleven original Cargo commands retain their arguments and repository-root
working directory. Test children also retain the full frozen Node20/pnpm
installation, including the pinned Playwright fixture required by agent tests.
Stable native Rust and debug-info settings are unchanged. Each child has its
own target directory; Cargo caches are partitioned by job, operating system,
CPU architecture and the exact workspace Cargo lockfiles, with no cross-arch
or old-lock fallback. Self-hosted Rust compile/test children restore these caches
with the pinned restore-only action; they do not upload caches in a post-job step.
This keeps an optional large cache save from exhausting the job after its Cargo
checks pass. A cache miss still runs every command cold and must fit the same
30-minute limit. GitHub-hosted children retain the original restore/save action,
keys and paths. An uncanceled Build never ignores a test failure, child
cancellation or aggregate failure.
The existing unused-toolchain disk cleanup runs only on
GitHub-hosted images, never against a self-hosted host or guest image.

Only the self-hosted Linux `Rust test runtime agent` Cargo step defaults unset
`RUSTFLAGS` to `-C link-arg=-fuse-ld=lld`; its scoped prerequisites already install
and verify `lld`. Explicit flags, including an empty opt-out, are preserved.
Hosted and non-Linux execution and other Rust children are unchanged. The default
retains the existing compiler driver and both full Cargo commands, including
compilation of every integration target before the database-free tests run.
It addresses a separately observed default-linker signal9 failure in that broad
compile path, which does not use the Shared fixture's JavaScript compiler helper.
Signal9 alone does not prove an out-of-memory cause. Cold completion and memory
use still require the real job; source regressions are not that qualification.

All twelve jobs default to `ubuntu-latest`. Only the independent
`CI_RUST_SELF_HOSTED=true` switch may select isolated Linux ARM64 workers, for
private same-repository PRs to `main` and protected-main pushes. It uses the
same trust-specific organization groups and per-run, per-attempt, per-job
labels as the JavaScript split. The aggregate suffixes are
`public-rust-check-aggregate` and `public-rust-test-aggregate`. Other switches
do not enable Rust compilation or tests; Rust formatting remains separately
controlled by `CI_EXPANDED_SELF_HOSTED`. Exact-main manual dispatches use the
route above; forks, public visibility and unsupported contexts keep hosted runners.

Do not enable this switch before independently enrolling the reviewed workflow
and all twelve exact job identities in the runner manager. Its existing
35-minute worker lifecycle remains sufficient only if the actual cold setup
and each full child workload fit their allotted window. Before checkout,
self-hosted children require non-root Linux ARM64, Node22, the ephemeral marker,
no private environment directory, and native Rust/C build tools. Those checks
do not prove that native libraries, downloads or workload timings are ready.
Each self-hosted child then installs the fixed missing native package set
(`clang`, `lld`, `cmake`, `libcap-dev`, `protobuf-compiler`) in a visible,
five-minute GitHub step inside the unchanged 30-minute job. The package list
stays unchanged. The install waits at most 120 seconds for the
DPkg lock if Ubuntu's automatic updater is finishing; it never deletes lock
files, kills the updater or skips package verification. Lock exhaustion still
fails within the existing five-minute step. Hosted jobs and
aggregates do not run that step. The manager must first qualify only APT's
fixed proxy configuration in the fresh guest; package installation stays in
the workflow, without changing the base image, repository trust or TLS rules.
The corresponding qualification resource profile is 8GiB/two CPUs and two
parallel Cargo jobs for these ten children only; aggregates and unrelated
jobs retain their existing resources. That configuration is not compile or
memory evidence.
Qualify each real cold ARM64 compile/test, Cargo and Node20 proxy downloads,
memory/disk use and complete guest teardown first. A split or a warm cache hit
is not that qualification; never reduce the test selection or ignore a timeout
to make a job green. No database, provider, signing or release credentials are
introduced by this lane.

The same restore-only compiler-cache policy applies to the two self-hosted
Shared Browser children and Controller database tests. Their hosted compiler
caches and pnpm caches are unchanged. Shared Browser no longer restores the
standalone migration-image cache (see below). Cache restoration
is an optimization, not evidence that a cold workload has passed.

Disable the Rust switch to restore hosted selection for new runs; already
queued jobs retain their selected pools. No required-check rule changes are
needed. Run `node --test scripts/check-rust-ci.test.mjs` for the exact command
inventory, routing and strict aggregate regressions. These source tests do not
run Cargo or establish real ARM workload completion.

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
failure. Missing/oversized/unrecognized diagnostics remain unclassified. This
does not retry a failed pull, skip an image or change the failure result.
CLI upgrades require updating and
testing the pinned ancillary inventory. Run
`node --test scripts/lib/supabaseSerialPull.test.mjs` for offline regression tests.
These do not qualify real cold downloads or concurrent connection usage.

The independent, default-off `CI_DATABASE_SELF_HOSTED=true` switch covers only
`Controller database tests` (30 minutes) and `signup -> email -> activate`
(25 minutes). Both preserve their complete existing commands, frozen Node20
workspace installation, and read-only checkout. Controller tests use the local
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

Only private, same-repository PRs to `main` and protected-main pushes may use
native Linux ARM64 guests in the corresponding `instafy-ci-pr` or
`instafy-ci-main` group. Exact-main manual dispatches use the route above;
forks, public visibility, other manual refs and disabled switches retain hosted
Ubuntu. Exclusive label suffixes are
`public-controller-db` and `public-auth-email`, prefixed with the repository ID,
run ID and attempt as in the other bounded lanes. Separate source authentication,
exact job assignment, complete guest destruction and credential revocation are
still provisioning requirements; the inline prerequisite check cannot prove them.

The controller needs native Rust, a C/C++ compiler, Make, pkg-config and OpenSSL
development files. Its protobuf compiler is vendored by the locked Rust build,
not a host installation. Cargo uses two compile jobs and an OS/architecture/lock-
specific cache. Auth-email does not compile Rust. Both need a real ARM64 Linux
Docker daemon, with its own restricted download proxy and loopback bypass for
the disposable stack. No cross-architecture Docker cache is introduced. Keep
TLS verification enabled. Both workflows stop their local stack on exit; failed
or interrupted cleanup still requires destruction of the whole guest.

Run `node --test scripts/check-database-ci-routing.test.mjs` for selector,
command-parity, prerequisite and cache regressions. These are not real cold ARM
workload qualification. Before enabling the switch, the manager must admit both
exact workflow identities, their PR/push/manual tuples and the 25-minute Listener
budget, then prove both complete workloads and cleanup within the unchanged
bounded worker lifecycle. Disable the switch for hosted routing of new runs;
already queued runs do not move pools automatically.

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

The independent, default-off `CI_BROWSER_SELF_HOSTED=true` switch covers only
`Browser verification / Browser UI rendering` and
`Browser verification / Personal Browser E2E`, called by Public
Build. It requires private visibility, a same-repository PR to `main` or a
protected-main push, and the exact `build.yml` caller. The manual route above
also permits the direct Browser workflow. Forks, public visibility, other
manual refs and unrelated callers retain `ubuntu-24.04`; Shared Browser has its
own independent switch below. Both short browser jobs have a 30-minute
limit, including their hosted fallback, to leave room for cold workspace,
browser and system-package installation. This is a conservative capacity bound,
not a measured completion claim. The worker lifecycle remains bounded to
35 minutes with its existing cleanup reserve; browser test-level timeouts,
commands, permissions, locked installations and required reports are unchanged.

The two label suffixes are `public-browser-ui` and `public-browser-personal`,
using the same trust-specific groups and per-run/attempt labels described
above. Provisioning must authenticate both caller and callee bytes at the same
tested commit and protected main, including the exact attempt's reusable-workflow
metadata. A caller-supplied input or matching label is not source authority.
Initially enable this switch only for supervised cold ARM64 qualification;
require both jobs and their cleanup to pass before routine use. Workers require
Node22, Xvfb and xauth before checkout; the unchanged
Playwright installation obtains Chromium and system libraries. The self-hosted
Personal job also explicitly installs Ubuntu24.04's GTK3 runtime package for
Electron before building its fixture. Restricted
workers also prepare the exact locked Electron binary with
`pnpm --filter @instafy/desktop-app exec install-electron` before the test process.
[Electron 42 and newer download lazily](https://www.electronjs.org/blog/electron-42-0), so a successful package install alone
does not prove that binary exists. The five-minute preparation step enables
Node's environment-proxy support (available since Node 22.21); it uses the installed package and its bundled
checksums, not an unpinned `npx` download. Proxy settings still do not enter the
scrubbed Playwright or Electron fixture environments. Restricted
workers must configure the disposable guest's APT proxy too: sudo does not
preserve the browser installer's proxy environment. Keep TLS and browser
sandbox protections intact. No template, host paths or proxy credentials belong
in the public workflow. Disable the switch to restore hosted routing for new
runs; queued jobs retain their original selection. The routing and prerequisite
regressions run in `node --test scripts/browser-ci-workflow.test.mjs`; they are
not a substitute for real browser execution and teardown.

### Bounded Shared Browser CI

`Browser verification / Shared Browser profile E2E` retains its required name
as a strict five-minute aggregate, with only the canceled-main exception above.
It succeeds only when both fixed children finish successfully; missing, skipped,
cancelled or failed children
fail the aggregate. It has no repository permissions or checkout and starts
only after the children end, without holding a worker while waiting.

| Child | Complete command | Runner-label suffix |
| --- | --- | --- |
| Shared Browser profile lifecycle | `xvfb-run -a node scripts/browser-profile-e2e.mjs` | `public-shared-browser-profile` |
| Shared Browser Studio journey | `xvfb-run -a node scripts/shared-browser-studio-e2e.mjs` | `public-shared-browser-studio` |

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

The two self-hosted compiler restores set `SEGMENT_DOWNLOAD_TIMEOUT_MINS=2`.
For the pinned action's Azure SDK downloader, this limits each 128 MiB segment
to two minutes of wall time, even if bytes are arriving. It is not a total
restore/job or inactivity timeout; legacy/non-Azure download paths do not use
this setting. A segment timeout aborts that download and continues as a cache
miss; migrations, compilation and both full fixtures still run. The 30-minute
job limit remains, so cold compilation must fit it. Hosted restores, cache keys
and paths are unchanged. See the
[cache action's timeout guidance](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/tips-and-workarounds.md#cache-segment-restore-timeout).

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

All three jobs default to hosted Ubuntu24.04. The separate, default-off
`CI_SHARED_BROWSER_SELF_HOSTED=true` switch uses the same private, same-repository
PR/protected-main and exact Public Build caller guards as the other browser
lanes. Its aggregate suffix is `public-shared-browser-aggregate`. Forks, public
visibility, other manual refs and unrelated callers stay hosted; exact-main
manual runs follow the route above. The manager must pin
both caller and callee source at the same tested commit and protected main and
authenticate exact-attempt reusable-workflow metadata before issuing a runner.
Neither the ordinary browser switch nor another CI switch enables this lane.

Only the two Shared compiler children use 8GiB/two CPUs, two parallel Cargo
jobs, and fresh-guest APT plus Docker proxy preparation; the aggregate retains
standard resources and neither daemon setup. Native package installation is
visible in the workflow and bounded inside each job. The base template, TLS
checks, network restrictions and 35-minute worker/cleanup budget are unchanged.
Before checkout, each child verifies a non-root ephemeral Linux ARM64 runner,
Node22 and an actual Linux ARM64 Docker daemon.

The self-hosted fixture step explicitly opts into compiler-only proxy handling.
The six Go/Cargo build calls receive only validated credential-free HTTP/HTTPS
proxy origins and their derived tool aliases, alongside the existing scrubbed
compiler environment. Database commands, display probes, production runtime
helpers, controller services and browser processes retain their existing
proxy/credential scrubbing. No general inherited environment, bypass list,
private endpoint, credential or TLS override is added to the public source.

On Linux, the four Cargo fixture builds default to `RUSTFLAGS="-C link-arg=-fuse-ld=lld"`
only when `RUSTFLAGS` is unset. This keeps the existing compiler driver and
requires `lld` on the build host; both Shared workflow children already install
it. Every explicit `RUSTFLAGS` string, including an empty opt-out, is preserved
byte-for-byte. Other platforms and the two Go builds retain their existing
compiler environment. The default aims to reduce peak linker memory without
changing Cargo arguments, features, fixture assertions or runtime environments.
A warm final-link result alone does not qualify cold end-to-end CI or its memory
and time budgets.

Cold ARM64 completion within 30 minutes is unproven: prior hosted timings or
warm caches do not qualify these split jobs. Keep activation supervised until
both full jobs and guest teardown pass; do not shorten scenarios or ignore
timeouts. Disable the switch to restore hosted selection for new runs;
already queued jobs keep their chosen pool. Run
`node --test scripts/check-shared-browser-ci.test.mjs scripts/browser-profile-e2e.test.mjs scripts/shared-browser-studio-e2e.test.mjs`
for local routing and environment regressions, not live browser qualification.

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
