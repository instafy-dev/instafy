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

The standalone UI configs are `packages/frontend/playwright.ci-ui.config.ts`
and `packages/frontend/vite.ci-ui.config.ts`. Avoid `.br` inside these source
basenames: the pinned scanner's [archive matcher](https://github.com/mholt/archives/blob/v0.1.2/brotli.go)
treats that substring as Brotli, including ordinary `.browser` names.
The rename preserves the browser lane, fixture inventory and Vite cache path;
scanner rules, archive depth and unexpected-read failure behavior are unchanged.
`node --test scripts/browser-ci-workflow.test.mjs` covers the names, all consumers
and the existing browser-lane behavior.

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
production image publisher, plus scheduled/manual image reconciliation. The
arm64 runtime lane, `publish-runtime-agent-multiarch.yml`, has no such route and
always runs on GitHub-hosted runners. The canonical
repository ID must still be private; main must be protected and the workflow
ref and source SHA must match. Manual requests must name that same source SHA.
PRs, forks, public visibility, other refs and a disabled/unset switch retain
their original hosted runners. The existing isolated ARM64 push coordinator
route takes precedence and is unchanged. This BUILD route uses trusted,
ephemeral jobs with the existing Docker-capable build profile; its static labels
are placement, not a claim of VM or network isolation.

The seven service cells, the two amd64 runtime cells, original 30/75-minute
limits, approval, scan-before-login gates, immutable manifests, GitHub-token
permissions and provenance settings are unchanged. The production runtime
publisher builds amd64 only; on BUILD its scanner uses the pinned x64 Trivy
binary. The arm64 cells run in the hosted multi-arch lane (see
[Runtime image release lanes](#runtime-image-release-lanes)). Hosted runner
matrix selections and scanner pins are unchanged. The five-minute
coordinator never waits for child publishers, so it releases a shared BUILD
runner before those jobs need it.

Debian service final stages explicitly refresh inherited security packages and
check distribution-specific minimum versions after installation. Installing an
unrelated package does not refresh every vulnerable base package. Bookworm
services enforce the PCRE2 floor; Trixie services additionally enforce gzip,
SQLite and Perl-base floors. `node --test scripts/check-production-image-inputs.test.mjs`
checks every Debian publisher cell plus the standalone speech-host image.
These source checks do not replace the unchanged scan-before-publication gate.

Self-hosted amd64 image cells select the digest-pinned **amd64** BuildKit
v0.32.2 image, even when the Docker daemon itself is ARM64. This lets a
Rosetta-enabled Docker VM use its registered x86 translator. An ARM BuildKit
daemon can fail its x86 capability probe and silently inject its bundled QEMU
instead; a Rust compiler crash mentioning `/dev/.buildkit_qemu_emulator` is
evidence of that fallback, not proof of an application defect. ARM image cells
and hosted builders keep their native/default builder. This selection does not
install Rosetta or make an unsupported host compatible. Qualify each runner
with an actual target compiler build and execution before enrollment; a builder
label or `buildx inspect` alone is insufficient. Do not restart the Docker VM or
change system-wide emulation while image jobs are active.

Image builders remain ephemeral on every runner: retaining Docker volumes would
violate the current BUILD runner's clean-daemon admission check. The runtime
publisher keeps its layer cache in a registry package instead (see
[Runtime image layer cache](#runtime-image-layer-cache)). Its export runs the same
way on hosted and BUILD runners, is bounded by a shell timeout and only warns when
it fails. Compilation, image loading, security scans, registry pushes and manifest
checks still fail closed. The services publisher uses no layer cache.

Before enabling this route, an operator must deliberately enroll this repository
and these three exact `@refs/heads/main` workflow refs in the BUILD group's
protected workflow allowlist and its existing registration policy. Qualify actual
Buildx builds and Trivy scans for the amd64 platform, at least 20 GiB free disk,
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

`.github/CODEOWNERS` assigns **all paths** to the existing trusted code owners,
`@instafy-bot` and `@instafy-bot-2`, including every explicit workflow/action and
boundary-control entry. CODEOWNERS uses the last matching rule, so those entries
must retain both owners. Outside contributions, including
ordinary product changes and edits to CODEOWNERS itself, need an applicable
owner's review. GitHub uses CODEOWNERS from the target branch, so a PR cannot
remove its own review requirement. Either trusted bot can approve the other's
PR or an outside contribution after reviewing it; GitHub does not allow a PR
author to approve their own PR.

Keep the blanket required-approval count at **zero**, code-owner review
**enabled**, and all required CI checks intact. Zero blanket approvals and
CODEOWNERS membership do not by themselves exempt a bot-authored PR from review.
The public repository's review-only ruleset grants both existing trusted bots
the same **pull-request-only** exception. This permits an explicitly authorized
merge of a trusted bot's own changes after review and exact-head CI, without
fabricating an approving review. Keep required CI outside that exception and
do not extend it to direct pushes, release tags or deployment. GitHub grants the
exception to the merging account, not to a PR author: operators must still
require a trusted owner's approval for outside-authored changes. Never re-author
outsider changes as a bot PR or add an auto-approve Action to evade review. A new
trusted bot identity requires an explicit ownership-policy review; a name ending
in `[bot]` does not confer trust.

If `gh pr merge` reports a branch-policy block despite passing CI, do not assume
that the bot lacks its configured exception. The CLI can reject a `BLOCKED`
merge state before asking GitHub to evaluate the merging account; enabling
auto-merge may also leave that PR waiting for review. For an already authorized
trusted-bot merge, verify the exact repository, PR author, head SHA, applicable
review-only exception, and every required check on that SHA. The current base
must satisfy branch-update requirements. Do not ignore an outstanding request
for changes, an unresolved required review thread, or another protection. Then
use GitHub's normal merge endpoint with the reviewed head pinned:

```bash
gh api --method PUT "repos/instafy-dev/instafy/pulls/$REVIEWED_PR/merge" \
  -f sha="$REVIEWED_HEAD" -f merge_method=squash
```

Set `REVIEWED_PR` and `REVIEWED_HEAD` from the reviewed PR, using the full commit
SHA; do not resolve a moving branch name at merge time. The request lets GitHub
evaluate the existing exception and remaining protections. It does not request
a blanket `--admin` override. Never use it to ignore failed, pending or unknown
required CI, waive an outside contribution's review, or change protection just
to clear a merge block. If GitHub rejects the request, diagnose that rejection.

Before making the repository public, verify the live branch settings (source
tests do not configure GitHub): code-owner review enabled, blanket approvals
zero, stale approvals dismissed after code changes, both trusted bots granted
the same review-only PR exception, and existing required checks unchanged.
Confirm an unapproved outside contribution still needs review and both bots can
review all protected paths. Inspect these settings without merging a PR merely
to test them. Retain the self-hosted runner groups' server-side
exclusion of public repositories; YAML runner selection alone is not isolation.
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
GitHub also documents the [self-approval restriction](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request)
and the merge endpoint's [expected-head `sha` parameter](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

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
| Rust test runtime agent | Codex code-mode host build, then agent `--no-run`, `--lib --test controller_client --test proxy_retry_budget`, `proxy_retry_budget` again with `INSTAFY_TEST_CODEX_MODEL` set to `gpt-5.6-sol` and to `gpt-5.5`, and `proxy_integration codex_read_reference_`, each with `--test-threads=1` | `public-rust-test-agent` |
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
30-minute limit. GitHub-hosted children save only from `refs/heads/main` (pushes
and manual dispatches); pull requests and other refs use the restore-only step
and read main's entries, because PR-scoped entries would use the shared cache
budget yet serve only that PR. Keys include every `packages/*/Cargo.lock` with
no fallback, so a pull request that changes a lockfile compiles cold on each push
until it merges. The contracts lane's migration-image cache is split by ref only:
it saves from `refs/heads/main` on any runner, self-hosted included, and every
other ref restores only. Cargo caches hold only `~/.cargo/registry/index`,
`~/.cargo/registry/cache`, `~/.cargo/git/db` and the target directory; Cargo
re-extracts crate sources and does not compare file times under `CARGO_HOME`,
so cached registry and git dependencies stay fresh, while workspace and path
crates still rebuild. An uncanceled Build never ignores a test
failure, child cancellation or aggregate failure.
The existing unused-toolchain disk cleanup runs only on
GitHub-hosted images, never against a self-hosted host or guest image.

Only the self-hosted Linux `Rust test runtime agent` Cargo test step defaults unset
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

The same compiler-cache policy applies to the Shared Browser children and
Controller database tests: self-hosted runs and refs other than `main` restore
only, and only hosted `main` runs save; the Shared Browser profile child never
saves (see below). Their pnpm caches are unchanged. Shared Browser no longer
restores the standalone migration-image cache (see below). Cache restoration
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

## Runtime image release lanes

The runtime-agent image is published in two lanes, so an arm64-only problem
(such as a Debian security update that reaches arm64 hours after amd64) can no
longer hold a backend release.

- **Production, amd64.** `publish-runtime-agent.yml` builds, scans and pushes
  the base and webdev images for `linux/amd64` only, then seals
  `runtime-agent-release-manifest` with those scanned single-platform digests
  (schema v1, unchanged keys). Every production host is amd64, and release
  consumers read only this workflow's artifact. The run pushes only the
  `<sha>-linux-amd64` architecture tags; it creates no multi-arch index and
  refuses `update_channel_tags=true`.
- **Best effort, arm64.** `publish-runtime-agent-multiarch.yml` binds to the one
  sealed first-attempt production run for the exact current main and checks
  that its manifest archive matches the recorded artifact digest. It then builds,
  scans and smokes the base and webdev images natively on `ubuntu-24.04-arm`,
  re-scans the two reused amd64 digests straight from the registry
  (anonymously, same pinned Trivy and flags), and only then creates the `<sha>`
  and `webdev-<sha>` indexes. Each index must hold exactly the sealed amd64 image
  and this run's arm64 image. It seals `runtime-agent-multiarch-manifest`
  (`kind: runtime-agent-multiarch`, with the production run ID, its manifest
  digest and every index and child reference) and, like production, refuses a
  second successful publication for the same commit. Its arm64 and assemble
  jobs refuse a re-run attempt before anything is pushed, so "Re-run failed
  jobs" cannot reuse an earlier approval; a fresh dispatch is the only retry.
  It never rebuilds amd64.

`continuous-image-publication.yml` runs the arm64 lane as a third lane, as the
last step of a pass. It dispatches only when that pass found the production
runtime manifest sealed, no arm64 run for the commit is active or sealed, fewer
than four arm64 runs have failed for it, the production release is exactly one
successful first-attempt run (the only kind the arm64 workflow can bind to),
and main still equals the commit. So a commit gets at most four arm64 runs:
the first attempt and three retries. Any unsuccessful run counts, including a
cancelled one or a rejected `ghcr-release` approval; each run needs its own
approval. Because the coordinator does not wait, the first dispatch comes in the
pass after production seals, and each retry in a later pass (a push, a Build
completion or the six-hourly schedule), so four attempts on a quiet main can
span about a day.

A sealed but expiring multi-arch manifest, an exhausted retry cap, a production
release the lane cannot bind to, an arm64 run active for more than six hours
(usually an approval nobody gave) or any API error ends in a `::warning::` and a
summary line, never a failed pass. The step writes only its own `multiarch_*`
outputs and its script always ends with status 0; the runner also bounds the
step to two minutes with `continue-on-error`, so even a stalled API call cannot
fail the pass. The job's timeout is the production steps' five minutes plus
those two. Once four runs have failed, the summary reads "arm64 lane exhausted
for `<sha>`; production unaffected; dispatch
`publish-runtime-agent-multiarch.yml` manually". A manual dispatch, after fixing
the cause, is the only further attempt for that commit. The lane serves only
current main: a commit that main moved past before its arm64 lane succeeded
keeps amd64-only tags.

Consequences for consumers:

- Only the digests in a sealed manifest are release authority. Every tag is
  pushed before its run seals, so a failed attempt can leave a `-linux-<arch>`
  tag behind, and a failed multi-arch attempt can leave `<sha>` or
  `webdev-<sha>` pointing at an unsealed index until a later attempt re-points
  it.
- `<sha>-linux-amd64` and `webdev-<sha>-linux-amd64` exist for every published
  commit; the multi-arch `<sha>` and `webdev-<sha>` tags may lag or be missing.
  The pull-request runtime browser smoke therefore pulls
  `webdev-<sha>-linux-amd64`, which may come from an attempt that scanned and
  smoked the image but did not seal.
- The two halves of an index are scanned at different times; the amd64 re-scan
  before assembly keeps both at the same database standard.
- The `latest`/`webdev` channel tags still move only on an explicit
  `update_channel_tags=true` dispatch, now of the multi-arch workflow. The
  coordinator always dispatches it with `false`, and its once-per-commit seal
  then blocks a later dispatch for that commit. A separate path that promotes
  channel tags from a sealed multi-arch manifest without rebuilding is a
  follow-up.

`node --test scripts/check-image-coordinator.test.mjs` runs the coordinator's
real step Bash against inert fixtures, including a replay of an arm64-only scan
lag (production seals and ships while arm64 fails three times, then the fourth
arm64 run seals) and the retry cap.
`node --test scripts/check-runtime-multiarch-workflow.test.mjs` runs both
runtime publishers' binding, verification, assembly and re-scan steps against
stub `gh`, `docker` and `trivy`.

## Nightly image scan

`.github/workflows/image-scan.yml` builds and scans every image the
protected-main publishers release, so a broken input surfaces before a release
rather than during one. It covers the two amd64 runtime cells of
`publish-runtime-agent.yml` (base and webdev on `ubuntu-24.04`), the two arm64
runtime cells of `publish-runtime-agent-multiarch.yml` (base and webdev on
`ubuntu-24.04-arm`) and the seven services of
`publish-production-services.yml` (amd64, two at a time as the publisher
builds them). Each cell uses the publisher's
Dockerfile, target, platform and build arguments, the same pinned Trivy binary
and the same blocking scan: vulnerabilities and secrets, HIGH and CRITICAL,
fixed versions only, no ignore file. Webdev cells also run the Shared Browser
start check that publication requires. The runtime build reads the publisher's
layer cache anonymously and always rebuilds the final stage, so OS and npm
packages are as current as a release would get them.

Nothing is published: no step logs in to a registry, pushes, tags a registry
reference or writes a cache, and images stay in the runner's Docker engine.
The workflow runs at 03:17 UTC every night, on manual dispatch, and on pull
requests that change Dockerfiles, `docker/**`, `.dockerignore`, the files those
builds pin, the Shared Browser smoke, any of the three publishers, or this
workflow and its tests. The pinned files are every dependency manifest and
lockfile a Dockerfile copies (the root `package.json`, `pnpm-lock.yaml` and
`pnpm-workspace.yaml` and the CLI package manifests, whose production
dependencies ship in the runtime image; the Rust `Cargo.toml`/`Cargo.lock`
files; the browser helpers' Go modules), the `codex` submodule and
`scripts/fetch-rusty-v8.sh`. Other source changes to the copied packages are
left to the nightly run. Pull request runs get a read-only token and report
only in their checks. Every cell runs to the end
(`fail-fast: false`), and each cell's job summary names its image and platform,
the check that failed and, for a failed scan, every finding with its package,
installed version and fixed version.

Scheduled and manual runs on `main` keep one issue titled "Nightly image scan
failing" up to date: the first failure opens it with the failing jobs, links and
findings, later failures update its body and comment, and the next passing run
closes it. Only that reporting job holds `issues: write`, and it never runs for
pull requests. No other notification channel or secret is used.

When it fails:

1. Open the failing job from the issue and read its summary.
2. A **scan failure** names packages with a fixed version available. Base-image
   packages usually need a refreshed digest pin or a raised minimum-version
   argument in the Dockerfile (the `*_MIN_VERSION` floors). npm's vendored
   copies are patched by the `*_VERSION`/`*_SHA256` arguments in
   `docker/runtime/Dockerfile`. Make the fix in a pull request; the path filter
   runs these same cells on it before merge.
3. A **build failure** often means an upstream repository stopped serving a
   pinned package version, as when Alpine dropped an OpenSSL release. Update the
   pin (and `scripts/check-production-image-inputs.test.mjs`) to a version the
   repository serves.
4. A failure on **one architecture only**, such as a Debian security update
   that reached amd64 hours before arm64, usually clears on its own. Dispatch
   the workflow again later, or re-run its failed jobs; the issue then lists
   only that attempt's failures. An arm64-only failure does not hold a
   production release, which is amd64 only, but the arm64 lane's own scan keeps
   the arm64 images and multi-arch tags back until it passes.
5. Never make the scan pass by weakening it. The flags, the empty ignore file
   and the pinned Trivy must stay identical to the publishers';
   `scripts/check-image-scan-workflow.test.mjs` derives them from all three
   publisher files and fails on any difference.

`node --test scripts/check-image-scan-workflow.test.mjs` checks that the cells,
build inputs, Trivy pin and scan flags match the publishers, that nothing writes
to a registry, the permission and trigger rules, and the summary and issue
reporting against a stub `gh`.

## Runtime image layer cache

The runtime-agent publishers keep one BuildKit layer cache per flavor and
architecture in a dedicated GHCR package, `ghcr.io/instafy-dev/instafy-build-cache`,
tagged `publish-runtime-agent-<flavor>-<architecture>`. The production release
writes the amd64 tags and the multi-arch lane writes the arm64 tags, by the same
rules. It is never written to the release package. It replaced the GitHub
Actions cache: one release's `mode=max` export is about 10 GiB, more than the
repository's Actions cache holds, so every release evicted its own entries
along with the CI caches. This reverses the
earlier rule that the publisher would never use a registry cache.

- The audit build reads the cache (`cache-from: type=registry`) before any
  registry login. The read is anonymous, so it only hits once the package is
  public; until then the build runs cold and nothing fails. The final stage, the
  matrix target, is always rebuilt (`no-cache-filters`), so the OS and npm
  packages the scan sees are current; the builder stages, including the
  cargo-chef dependency build, come from the cache.
- Nothing writes the cache until the image has passed the scan and, for webdev,
  the Shared Browser check, and has been pushed and recorded. A final step then
  repeats the audit build on the same builder with `--output type=cacheonly` and
  `--cache-to type=registry,...,mode=max,ignore-error=true`. It creates no image,
  tag or local copy, so it cannot change the published bytes. A shell `timeout`
  bounds it to 15 minutes (16 with the kill grace), and the job's
  `timeout-minutes` includes that bound, so a slow export cannot time out a cell
  that has already published. A failed or timed-out build only logs a warning.
  With `ignore-error=true` a failed cache write does not fail the build; BuildKit
  reports it as an `ERROR` line in the plain progress log, and the step also turns
  that into a warning. Either way the next release may build cold.
- The production services publisher uses no layer cache. Its former Actions-cache
  flags never took effect (a plain `run:` step has no Actions cache token), and a
  public cache would expose the layers of its private images.

One-time setup: the first export creates the package with `GITHUB_TOKEN`. If it is
not public, an organization owner sets its visibility to Public in the package
settings. This is irreversible; the cached layers are built from public source. The
owner also limits the package's Actions access to this repository and reviews who
else has write or admin access to it. Check the package's "Inherit access from
source repository" setting: while it is on, everyone with write access to this
repository can also write the package. For Actions-only writes, turn it off and
grant this repository's Actions write access explicitly.

Trust boundary: an Actions cache scoped to `main` could only be written by runs on
`main`. A registry tag can be overwritten by any workflow run of this repository,
on any branch, that requests `packages: write`, and by anyone with write or admin
access to the package (including repository writers while access is inherited).
Fork pull request runs receive a read-only token and cannot write it. A
`pull_request_target` workflow would run with this repository's token, so no
workflow triggered by pull requests may request `packages: write`; a test in
`scripts/check-production-image-inputs.test.mjs` enforces that. A release build
reuses whatever cached layers match its build steps, and the image scan would not
detect layers placed there by such a writer. Treat write access to this package
like write access to the release workflow.

To reset a suspect cache:

1. First review the package's write and admin access and any workflow that holds
   `packages: write`, and remove whatever allowed the suspect write, so the cache
   cannot be written again before the reset.
2. Delete the package's versions in its settings. GitHub refuses to delete a
   version of a public package that has more than 5,000 downloads; in that case,
   move the cache to a new tag in a reviewed pull request (updating the tests that
   pin the reference), so the old tag is never read again.
3. The next release builds cold and exports a fresh cache.
4. The scan cannot clear a release built from a suspect cache, so rebuild and
   republish every runtime release whose build read the cache after the suspect
   write.

A merely broken cache only needs step 2. Deleting the whole package also works,
but the one-time setup must then be repeated. Each export leaves the previous
cache manifest untagged, and deleting untagged versions is safe.

`node --test scripts/check-production-image-inputs.test.mjs scripts/check-image-build-routing.test.mjs`
covers the read-before-login and export-after-publication order, the exact
cache-only command (run against a stub `docker`), the final-stage filter and the
reconstruction of the previously reviewed workflow bytes.

## Supabase CI image mirror

ECR Public caps anonymous pulls by data volume per source IP, and GitHub-hosted
runners share IPs, so CI stacks failed with `toomanyrequests: Data limit
exceeded` and reruns did not help. CI therefore pulls the Supabase images it
starts from GHCR by the same digest, with ECR Public as the fallback.

- `supabase/image-mirror.lock.json` pins the ten images the locked Supabase CLI
  2.92.0 starts in CI, each by its upstream index digest, and records which
  startup profiles use it. Its tests fail until the lock matches the CLI version
  in `pnpm-lock.yaml`, that CLI's image tags, and the digest pinned by the
  empty-database migration test.
- `.github/workflows/mirror-supabase-images.yml` runs only on protected `main`
  (lock, script or workflow changes, weekly, or manual dispatch; never for pull
  requests). It copies each index unchanged to
  `ghcr.io/instafy-dev/supabase/<name>` under the upstream tag with
  `docker buildx imagetools create`, skips images whose index, tag and child
  manifests GHCR already serves (a deleted tag or child manifest is copied
  again), and then proves anonymously that every index, tag and child manifest
  resolves to the locked digest. The source is ECR Public, with Docker Hub (identical digests)
  as its fallback. Only `GITHUB_TOKEN` with `packages: write` is used. These are
  unmodified upstream images, not Instafy builds.
- `scripts/ensure-supabase-postgres-image.mjs` (the contracts lane and the
  private composition job) makes one bounded GHCR pull after the local and cache
  checks, then falls back to its unchanged five-attempt ECR pull. Either pull is
  by digest, so the digest-bound cache tag is unchanged.
- `pnpm supabase:up` pulls each locked image the selected profile needs (four
  for database-only, seven for Auth-only, ten for browser-test and full) from
  GHCR by digest, or from ECR Public by digest, and tags it with the CLI's own
  `public.ecr.aws/supabase/<name>:<tag>` reference. The pinned CLI finds that
  reference locally and skips its own pull. The CLI registry is not redirected.
  Full mode, which no CI lane uses, also starts Edge Runtime. That image is not
  in the lock, so the CLI still pulls it from ECR Public.
  Pulls run one at a time, bounded to three minutes each and ten minutes in
  total. A pull that times out or cannot reach its registry is not retried, and
  that registry is skipped for the rest of the start, so a stalled GHCR costs
  one three-minute timeout rather than the whole budget. A failure is logged
  with the same fixed hints as serial preparation and leaves that image to the
  CLI's own pull, which was the previous behavior.

`SUPABASE_IMAGE_MIRROR=ghcr` turns the mirror on and `off` turns it off. Unset,
it is on only when `GITHUB_ACTIONS=true`, so local startup is unchanged unless
you opt in. Anonymous GHCR pulls work locally once the packages are public.
Startup leaves pulls to the CLI when `SUPABASE_INTERNAL_IMAGE_REGISTRY` is set or
when the installed CLI is not the locked version. Running
`pnpm test:migrations:empty-db` on its own still pulls from ECR Public; run
`node scripts/ensure-supabase-postgres-image.mjs` first to use the mirror.

When the Supabase CLI is bumped, update the lock's tags and digests in the same
change. The mirror workflow copies them after merge; until then CI falls back to
ECR Public. If the workflow reports that a package is not anonymously pullable,
an organization owner must set that `supabase/<name>` package's visibility to
Public in its package settings. This is irreversible, and the upstream images
are already public. Run
`node --test scripts/lib/supabaseImageMirror.test.mjs scripts/mirror-supabase-images.test.mjs scripts/ensure-supabase-postgres-image.test.mjs`
for offline regression tests.

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
prepares all 13 images except Edge Runtime. When the
[GHCR mirror](#supabase-ci-image-mirror) is on, it runs first, so serial
preparation finds the ten mirrored references already present. It still pulls
Logflare, Vector and Supavisor from ECR Public: the mirror does not copy them,
because `config.toml` disables Analytics and the pooler and no profile starts
them.

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
are uploaded, separately per child. Both children use one compiler cache key,
which includes the operating system, architecture and every workspace Cargo
lockfile, with no old-lock or cross-architecture fallback. Only the Studio child
saves it, from hosted `main`; the profile child restores that entry and never
saves.

The two restore-only compiler steps used by self-hosted runs set
`SEGMENT_DOWNLOAD_TIMEOUT_MINS=2`; the Studio step also serves hosted runs
outside `main`.
For the pinned action's Azure SDK downloader, this limits each 128 MiB segment
to two minutes of wall time, even if bytes are arriving. It is not a total
restore/job or inactivity timeout; legacy/non-Azure download paths do not use
this setting. A segment timeout aborts that download and continues as a cache
miss; migrations, compilation and both full fixtures still run. The 30-minute
job limit remains, so cold compilation must fit it. See the
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
