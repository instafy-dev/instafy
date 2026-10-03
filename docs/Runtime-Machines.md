# Hosted Runtime Machines

How hosted runtimes are sized, paused, billed, and attributed. Code:
`packages/runtime-controller/src/runtime/` (sizes.rs, sweeps.rs, ensure.rs,
limit_waits.rs, stop.rs, provider.rs),
`packages/runtime-provider-core/src/allocator/docker.rs`,
`docker/docker-compose.runtime.provider.yml`.

## The model

Two user-facing concepts, deliberately no size matrix:

- **Hosted machine** — a small cloud computer per project. Pauses when
  unused, keeps project files and caches, wakes on interaction.
- **Your machine** — the desktop runtime agent; free, unlimited, offered at
  every ceiling (RAM, credits, capacity, repo size).

## Sizes

Catalog in `runtime/sizes.rs` (server-validated; clients pick an id, never raw
resource values — `metadata.env.RUNTIME_CPU_LIMIT/RUNTIME_MEMORY_LIMIT` are
always overwritten server-side):

| id | specs | credit burn |
|---|---|---|
| `standard` | 2 CPU · 4 GB | 1× provider rate |
| `boost` | 4 CPU · 8 GB | 2× (ceil) |

The size travels `ensure metadata.sizeId` → lease metadata → billing sweep
(`rl.metadata->>'sizeId'`) and → provider env → compose `cpus`/`mem_limit`.
Per-size credits/hour are exposed in `/credits/policy` (`usage.runtimeSizes`).
The frontend preference is per-project (`runtime/runtimeSizePreference.ts`,
localStorage) with a picker in the runtime menu; it applies on next start.

## Tenant leases

`POST /runtime/ensure` with `scope: "tenant"` and a `runtimeId` attaches the
request's project to a runtime whose active lease is `shared`. It launches
nothing and is not billed; the runtime's own project keeps paying for it.

- The caller needs write access to the tenant project and to the runtime's
  own project, and the tenant project's organization must be allowed to use
  the runtime's provider. Access to the runtime's project is checked again
  when the attach locks the runtime. Access to the tenant project is checked
  once, before the attach, as the `exclusive` and `shared` scopes check
  their project.
- Tenant refusals are uniform with each other: a runtime id that does not
  exist, a runtime whose own project is missing or deleted, and a runtime
  whose own project the caller cannot write to all get the same `404`
  (`code: "runtime_not_found"`). This applies to `scope: "tenant"` only. The
  `exclusive` and `shared` scopes and `POST /projects/:id/runtime/request`
  answer a `runtimeId` as before, for example with `403` for a runtime of
  another project.
- Tenant lease metadata keeps only the string fields `source` and `label`,
  whatever the provider. Every other key is dropped, on the first attach and
  on re-attach: `_instafy`-prefixed keys and launch settings such as
  `runtimeFlavor`, `sizeId`, `env` or `runtimeAgentImage` alike. A re-attach
  without metadata under the same shared lease keeps the stored metadata. A
  re-attach after a relaunch creates a new lease that holds only the metadata
  it sends.
- A tenant lease ends with the shared lease it attached under: releasing that
  lease, as a stop does, or failing its launch releases the tenant leases in
  the same transaction. A dispatch reconnect that forces a new lease ends
  tenant attachments too: it stops the runtime and relaunches it under an
  `exclusive` lease, which tenants cannot attach to. A re-attach reuses the
  project's tenant lease only under the runtime's current shared lease; after
  a relaunch it creates a new one. In an existing database, tenant leases
  whose shared lease was released before this rule existed stay unreleased. No
  migration closes them: the attach never reuses them, and no reader treats a
  tenant lease as live.
- The attach leaves the runtime's origin alone. The response's `origin` is
  the host project's origin for its shared lease, as it is, or absent when
  there is none; `originMode`, `originProtocols` and `originMetadata` are
  ignored.
- Launch-generation readers (requeue relaunch, dispatch reconnect, provider
  route rotation, operator hosted hours) ignore tenant leases, and a
  runtime's status shows only its own project's origin.
- A tenant lease registers no runtime. `POST /runtime/register` answers a
  tenant lease's id with the `404` for a lease that does not exist, before
  it locks anything.

## Idle stop (pause/wake lifecycle)

`RUNTIME_IDLE_STOP_SECONDS` (default 1800, 0 disables). A hosted runtime stops
with reason `idle` when ALL durable signals agree, for the whole window: no
leased agent job, no agent_jobs activity for the project, no genuine user
activity in `project_user_activity` (written by the activity endpoint; clients
re-ping every 5 min while active), and the active lease is older than the
window. The in-memory tracker is deliberately NOT consulted (it is refreshed
by sweep bookkeeping and dies on restart). If `project_user_activity` is not
migrated yet the sweep skips entirely — fail safe, never stop blind.

Pause semantics: the frontend marks the project idle-paused
(`runtime/idlePauseRegistry.ts`), which gates auto-ensure — otherwise the
state-driven ensure would relaunch the machine seconds after every pause. Any
pointerdown/keydown clears the pause and the machine wakes automatically.

## Stop reasons

Sweep stops publish `runtime.stopped` with a `reason`:

- `idle` — pause; explained toast; wakes on interaction.
- `credits_exhausted` — no auto-restart; toast links to credits. The ensure
  precheck (402 `insufficient_credits`) prevents launching a machine the first
  billing bucket would kill.
- `oom_killed` — heartbeat timeout whose container the provider post-mortem
  (`/runtime/inspect`, docker `State.OOMKilled`) attributes to the memory
  wall. No auto-restart into the same wall; the toast offers **Boost** (sets
  the size preference) or your-own-machine, escalating when the project has
  ≥2 OOM stops in 7 days (`runtime_events` query).
- `heartbeat_timeout` — genuine agent death; auto-recovery unchanged.
- `runtime_limit_reclaim` — the machine was idle and another space in the
  organization was waiting for the hosted runtime slot (see "Waiting on the
  runtime limit" below). The event carries `queuedJobCount`, the work left
  queued in that space (work that landed between the idleness check and the
  stop is requeued); such a space then waits on the limit itself. A studio
  open on the reclaimed space does not relaunch it unless it has work of its
  own there (a queued or running turn, or `queuedJobCount > 0`); otherwise it
  holds the machine like an idle pause until the next interaction.
  Controllers before this reason was introduced published
  `idle_runtime_limit_reclaim`; the frontend accepts both.

Jobs requeued by any stop are stamped (`payload.requeuedAt`) and expire after
15 minutes **only if the project has no live runtime** — an interrupted run
must not replay days later, but a queued job behind a busy machine is fine.
The stamp is cleared when a job is leased. In a space that is waiting on the
runtime limit (below), the work that wait covers (unpinned, or pinned to the
space's own hosted runtime) is left to its own 30-minute give-up, including
work an idle-slot reclaim requeued. Work in that space pinned to a desktop or
another machine is never retried or given up on by the wait, so it keeps this
15-minute expiry.

## Waiting on the runtime limit

When every hosted runtime an organization may run is in use, an ensure for
another runtime is refused with 402 `runtime_limit_reached`. The runtime
holding the slot can be in another space or in the same one: a space's
standard runtime can hold the slot its Webdev runtime needs. If the machine
holding the slot is in another space and has been idle for
`RUNTIME_LIMIT_RECLAIM_IDLE_SECONDS` (default 120, 0 disables), the ensure
stops it and launches the waiting space instead (reason
`runtime_limit_reclaim`). That reclaim only runs inside an
ensure, and clients ask again only on interaction, so the controller retries
for them (`runtime/limit_waits.rs`):

- Every limit refusal of a real ensure (the studio's, the dispatch reconnect,
  requeue recovery, automations) is recorded in `hosted_runtime_limit_waits`,
  one row per space, with the refused request. A user's own request (which
  carries the machine size) is never replaced by a server-initiated one.
- A sweep on every controller (every 10 s) replays the refused request through
  the ordinary ensure path for spaces that still have queued agent work a
  hosted machine would run (unpinned, or pinned to the space's own hosted
  runtime) and no live runtime that would run it (see the last point). The
  organization limit, the credit precheck and the reclaim apply unchanged, so
  it never launches a machine a user's own ensure could not.
- Retries back off per space: 30 s after the refusal, then 60 s, 120 s,
  240 s and every 5 minutes. At most 5 spaces are handled per tick per
  controller, each at most once, and each retry is one ensure bounded by the
  provider call deadlines below. Spaces holding a job past the give-up window
  are claimed before plain retries, so a give-up never waits behind slow
  launches, and within a tick an organization's next space goes after every
  other organization's first.
- Replicas share the table: a sweep claims one due row at a time, right
  before handling it, with `for update skip locked` and a 20-minute claim
  lease, so a space is retried by one controller at a time and a claim
  abandoned by a dead controller expires. The lease's expiry is also the
  claim's token: releasing, finishing or backing off a wait only applies
  while the row still carries it, so a controller whose claim lapsed cannot
  undo the claim another controller took since.
- The organization limit itself is one decision at a time: an ensure takes a
  per-organization advisory lock (`pg_advisory_xact_lock`) around counting
  the organization's active hosted runtimes and inserting its lease, so two
  replicas launching for two spaces at once cannot both take the last slot.
  The lock lasts only for that database transaction; it is released before a
  reclaim stops another machine and is never held across a provider call.
- A launch refused for a reason waiting cannot fix (credits, access, a deleted
  space, a provider this controller no longer offers) ends the wait and fails
  the waiting work at once, through the same path as the give-up below
  (failed run, conversation message, refund of an unused managed-AI reserve).
  The conversation gets the refusal's own message only when it is one the
  studio already shows people (out of credits); any other refusal's text is
  operator detail, so it gets a plain "a cloud runtime could not be started
  for this space" reason and the refusal goes to the controller log. A
  recorded request that cannot be replayed at all fails its work the same
  way. When that fails the last waiting workers of a multi-agent plan, the
  lead their failure queues fails with the same reason too, since the wait
  that would start it is over. Conflicts, throttling and 5xx keep backing off.
- Work that has waited on the limit for 30 minutes fails with a reason in
  the conversation ("every cloud runtime in this team stayed busy for 30
  minutes...") and a Try again, its run fails, and the managed-AI reserve of
  a job no runtime ever leased is refunded, so a message that never ran costs
  nothing (a job that was leased may have called the model, so its charge
  stands, as for any expired requeued job). The clock
  starts when the job was queued (or requeued by a stop), or when the space
  began waiting, whichever is later: a job that sat behind its own busy
  machine gets the full window once it is refused a new one. The studio's
  waiting copy promises this bound. Queued follow-ups in that conversation
  are then dispatched as after any finished turn, and when the failed job was
  the last live worker of a multi-agent plan, the plan's lead checkpoint runs
  first, once per plan, as for a canceled worker.
- The wait ends when a live runtime (an unreleased lease or a recent
  heartbeat) would run the waiting work: a hosted runtime of the space, the
  machine a job is pinned to (unless that machine is private and the job is a
  platform AI job, which it never takes), or, for unpinned work, a machine
  that would lease it. A heartbeating desktop that never takes work pinned to
  the hosted runtime, or only takes its owner's own-key work and terminal
  commands (never a platform AI job), does not end it, and the give-up still
  applies to that work. The `requested` row
  dispatch leaves behind does not count, and neither does a generation
  quarantined as `cleanup_pending`. A runtime preference held in one
  controller's memory is invisible to the sweep. A wait with no queued work is
  dropped once it has been quiet (no refusal and no retry) for 30 minutes; a
  refusal after that starts a new wait.

The table ships in migration `20260924120000_hosted_runtime_limit_waits.sql`.
A controller running before it is applied logs one warning and does not
retry; nothing else changes.

## Provider call deadlines

Every call the controller makes to a runtime provider has an overall deadline
that covers auth-token fallback retries and reading the response. A deadline
only stops the controller from waiting; it never cancels work the provider
already accepted. The bounds are code constants in `runtime/provider.rs` and
`runtime/ensure.rs`, not configuration:

| Call | Used by | Deadline | When it expires |
|---|---|---|---|
| `POST /runtime/ensure` | launch | 120 s | Handled like any provider error: the new lease is quarantined as `cleanup_pending`, then a compensating release (up to 15 min) runs outside the database fence. |
| `POST /runtime/release` | stop, remove, the idle, credit, heartbeat and launch-timeout sweeps, idle-slot reclaim, the dev-only offline endpoint | 180 s | The stop fails with 502 (a sweep logs it and moves on) and the generation stays quarantined (see below). The dev-only offline endpoint only logs it. |
| `POST /runtime/inspect` | OOM post-mortem in the heartbeat-timeout sweep | 15 s | The attribution is unknown and the stop proceeds as `heartbeat_timeout`. |

An idle-slot reclaim (stopping an organization's idle machine so a waiting
space can launch) runs while that launch holds the controller's single
provider-launch slot, so the tunnel-broker revoke after its release is bounded
as well: after 15 s the controller stops waiting, and the stopped runtime's
tunnel grants stay active until they expire, the same outcome as a broker
error.

No provider call holds a pooled database connection or an open transaction
while it waits, with one deliberate exception: a launch keeps one
runtime, lease and project row guard across `/runtime/ensure`, so a stop or a
project deletion cannot overtake it. At most one such guard exists per
controller process; other launches queue for it outside the pool.

### Cleanup after a failed release (502)

A stop is two-phase. It first commits a quarantine: the lease becomes
`cleanup_pending`, the runtime returns to `requested` with its endpoint and
heartbeat cleared, jobs on it are requeued or failed, and a
`provider_release_cleanup_pending` event is recorded. Only then does it ask the
provider to release. If the release fails or passes its 180 s deadline, the
stop answers **502** ("runtime provider cleanup is still pending; retry the
stop") and the quarantine stays in place:

- New ensures for that runtime fail closed with 409 ("runtime cleanup is still
  pending; retry after the provider release completes") and late registrations
  are refused, so no second machine starts under the same generation.
- Retrying the stop sends the release again for the same lease. The idle and
  active-job preconditions are not re-checked; they held before the quarantine.
- Cleanup is also retried without a caller: the next ensure for that runtime
  retries the quarantined release before launching, and the launch-timeout
  sweep retries quarantined runtimes whose lease is older than 15 minutes.
- Once the provider acknowledges a release, the stop finalizes: the lease is
  `released`, the runtime `stopped`, and a `provider_release_acknowledged`
  event is recorded.

The provider serializes ensure and release per runtime, so a retried release
queues behind any release or late launch still running there.

## Caches

`/workspace/.cache` is a per-project host mount
(`<codex-root>/../workspace-caches/<project_id>`) surviving re-provision;
compose points `CARGO_HOME`, `RUSTUP_HOME`, `GOPATH`, `PIP_CACHE_DIR`,
`UV_CACHE_DIR`, `npm_config_cache` at it, so toolchains and registries survive
pauses. The provider service prunes caches untouched for
`RUNTIME_CACHE_TTL_DAYS` (default 30, 0 disables) — deletion only happens when
a bounded scan proves every file is older than the cutoff (fail-safe on
uncertainty). Real per-org disk quotas remain future work.

## Workspace durability

Hosted workspaces are meant to be **git-canonical working copies**, not primary
storage: the durable copy is the bare repo on persistent git-shard storage plus
encrypted offsite backups. That holds only when the runtime has a git remote,
which needs both of these:

- The controller has `GIT_REMOTE_BASE_URL` set. It then adds
  `ORIGIN_GIT_REMOTE_URL=<base>/<project>.git` to each runtime's launch
  metadata. Without it the controller logs an error at startup and keeps
  serving.
- The provider's compose file forwards `ORIGIN_GIT_REMOTE_URL` into the runtime
  container. `docker/docker-compose.runtime.provider.yml` does, and
  `scripts/check-self-host-compose.test.mjs` fails when that file drops a
  launch variable the allocator allowlists, except the two documented WebRTC
  variables (`INSTAFY_BROWSER_WEBRTC_SENDER_URL` and
  `INSTAFY_BROWSER_WEBRTC_BIND`) that are not forwarded yet.

If either is missing, the runtime writes files only to the node's disk
(`RUNTIME_REPO_HOST`, which the Docker allocator sets to
`DOCKER_REPO_HOST/<project>`). Each save after a turn is recorded as failed
(`gitSyncStatus: "failed"`, "git remote is not configured for this project"),
and the files are lost when the node is replaced, for example by a blue-green
controller replacement.

With a remote, the origin server's `ensure_git_checkout` clones from it on
runtime start, so a fresh node restores each working tree and a replacement
loses only work that never reached the remote:

- Before each turn the runtime agent brings its checkout up to date: under a
  workspace lease it calls its own origin's `POST /git/sync {"mode":"refresh"}`,
  which pushes parked recovery refs, publishes commits a previous turn left on
  the local branch and moves the checkout to `main`. This runs before the
  project memory scaffold is written, so scaffold copies of files `main`
  already has cannot block the move. A run that cannot get a lease (a
  read-only run, or someone else holds it) refreshes read-only instead: the
  origin fetches with its own `git.read` credential and moves the checkout
  only when it holds nothing unpublished. The outcome is recorded on the turn
  as an `origin/refresh` artifact; a failure never fails the turn.
- After a model turn the agent saves the files the model reported plus every
  file whose `git status` changed during the turn, minus paths that are never
  published. A client's `autoSyncAfterApply: false` is ignored: every turn
  saves (only the runtime-wide `RUNTIME_GIT_SYNC_AFTER_APPLY=0` turns saving
  off). Multi-agent write-scoped workers save their files through the same
  checkpoint.
- `/skills import`, with or without `--start`, pushes the skill files it
  installed through the same checkpoint. [Git Service](Git-Service.md#embedded-repositories-and-protected-checkpoints)
  lists the import cases it does not save.
- Paths a save leaves out are reported per file: the `origin/apply` artifact
  carries `conflictedPaths`, `rejectedPaths` (each with a `reason`:
  `ignored`, `secret`, `excluded`, `too_large`, ...), `recoveryRef` and
  `gitSyncStatus: "partial"`, and the turn's reply ends with one
  `Not saved: <paths> (kept at <ref>)` sentence per group. `instafy git sync`
  prints the same lines and exits 1.
- A save publishes by merging: the checkout's commits reach `main` unchanged,
  as a fast-forward or under one merge commit on the current tip. Files that
  `main` changed too keep `main`'s copy, and the agent's copy goes to a
  recovery ref (`refs/instafy/recovery/<origin id>/<name>`); work that cannot
  be pushed at all goes to one as well. See
  [the origin server](../packages/origin-http-server/README.md#publishing-workspace-runtimes-and-desktop).
- **A stop never publishes dirty files.** Before the controller stops a
  provider-managed runtime (idle reaper, credit stop, a user's Stop or
  removal, ensure replacement, the sweeps), and before it fences the runtime,
  it calls the hosted origin's `POST /git/flush` and waits at most 25 seconds.
  The flush first stores everything on local recovery refs, with no network
  call: finished local commits that are not on `main` as `unpublished`, and
  files no turn saved as `unsaved`. When a job is running on the runtime, or
  was cancelled in the last minute, the request says `turnActive`, and that
  turn's local commits go to the `unsaved` ref with its files and leave the
  branch instead of reaching `main`. Then, best effort and within its time,
  it publishes the finished commits by merge (which retires their local
  copy) and pushes the refs. Until the next refresh, the origin refuses
  further saves (409), so a checkpoint racing the stop cannot put the parked
  work on `main` as well. The origin gets `git.write` with a 60-second
  `fs.write` token the controller mints for the holder of the project's
  active workspace lease; the runtime's machine token still cannot mint
  `git.write`. When nobody holds a lease this runtime may save under (an idle
  stop, say), the controller mints nothing for anyone and does not call the
  origin (`no_writer`), and the runtime's own shutdown flush keeps the work
  locally. The response's `unpushedRefs` and `unpushedRefNames` list what is
  still only on the node, and the outcome is recorded as a `workspace_flush`
  runtime event. A failure is logged and the stop goes on; whatever was
  stored stays on the local refs.
- On the process's own graceful stop of a hosted runtime,
  `flush_workspace_before_shutdown` does the same local step without network
  or credentials: finished local commits are kept on a local `unpublished`
  ref (and stay on the branch for the next refresh to publish), files no turn
  saved on a local `unsaved` ref. When the last job lost its lease before its
  turn finished (a stop requeued or cancelled it), that turn's commits are
  set aside instead of left for the next publish. After it succeeds it writes
  `.instafy/.git/instafy-stopped-clean`, which every origin start removes. The
  next publish or pre-turn refresh with `git.write` pushes the refs. Work
  parked only locally is lost if the node is replaced before that push.
  Desktop folders are never flushed.
- Residual exposure: a hard node loss mid-run (the in-flight run's work), work
  parked locally whose push has not happened yet, and gitignored files.

**Recovery refs.** Work that cannot reach `main` is never dropped. It is
committed first to a local ref, `refs/instafy/local-recovery/<name>`, without
any network call, then pushed to `refs/instafy/recovery/<origin id>/<name>` by
the next save, refresh or controller flush that holds `git.write`. The origin
id is the one recorded in the commit (`Instafy-Origin`), so a later runtime on
the same checkout, which has a new origin id, pushes and reads earlier refs
where they belong. A local ref moves to
`refs/instafy/local-recovery-pushed/<name>` only after the push is confirmed.
Each refresh mirrors the space's `refs/instafy/recovery/*` into the checkout,
so an agent can read kept work on any machine with
`instafy git show <ref>:<path>` and merge it
(`.agents/skills/instafy-git-canonical-conflicts/SKILL.md`). Kept work stays
until someone restores or dismisses it; dismissed work is never published
again, and later local commits built on it are published without it. A
recovery ref never carries a file that may not be published (secrets, legacy
chat uploads, build output): such files stay on the runtime's disk only.

**Checkout lifetime.** The hosted checkout is a bind mount of the node's disk,
`DOCKER_REPO_HOST/<project>`. It survives container stops and re-provisioning
on that node and is lost when the node is replaced; correctness does not
depend on it, because the next start clones `main` again. The provider service
evicts stopped checkouts:

- after `RUNTIME_CHECKOUT_TTL_DAYS` without a start or stop (default 7, 0
  turns idle eviction off), and, oldest first, while the node's checkouts
  together exceed `RUNTIME_CHECKOUT_DISK_BUDGET_GIB` (unset or 0: no budget),
  skipping any used in the last hour;
- never on stop (a stop only starts the idle clock), never while any runtime
  container of the project exists on the node or a start is in progress, and
  never for a workspace without a canonical remote;
- never while the checkout holds a `refs/instafy/local-recovery/*` ref: that
  work is not pushed yet. The sweep logs the project and keeps the checkout;
  the next start pushes the refs, and a later sweep evicts;
- never unless the runtime that last used it stopped cleanly
  (`.instafy/.git/instafy-stopped-clean`, see above). A crash, a kill or a
  stop that could not keep its work may leave files or commits that exist
  nowhere else; such a checkout is kept until a later start and clean stop.
  Checkouts from before this marker are kept the same way.

A stop takes the same per-project lock as a start while it runs and marks the
checkout as used, and the sweep reads that mark again once it holds the lock,
so a checkout is never evicted as its runtime stops.

The sweep runs every `RUNTIME_CHECKOUT_SWEEP_INTERVAL_SECS` (default six
hours, 0 turns it off). It reads refs from the repository files without
running git, and keeps any checkout whose state it cannot read with certainty.

**Compatibility: upgrading the provider compose file turns the remote on.**
Before `docker/docker-compose.runtime.provider.yml` forwarded
`ORIGIN_GIT_REMOTE_URL`, a provider runtime never received it, even when the
controller set `GIT_REMOTE_BASE_URL`. With the current file it does, and the
origin server runs `ensure_git_checkout` when the runtime starts. That does not
adopt a tree that already lives on the node: a workspace that is not empty and
has no `.instafy/.git` makes it fail with "workspace root is not empty but
ORIGIN_GIT_REMOTE_URL is set", the runtime agent exits, and the runtime does
not start. A workspace that has run a job usually has files in it. Until the origin
can adopt an existing tree, roll the new compose file out only to fresh nodes or
to runtimes whose workspace is empty. Do not upgrade it in place on a node that
already holds workspaces, including a same-VM rollout.

**Operational invariant:** `GIT_REMOTE_BASE_URL` must be configured for hosted
deployments, and `ORIGIN_GIT_REMOTE_URL` must reach the runtime container.
Without them, workspaces have no durable backing. A dedicated single-attach
workspace volume is structurally incompatible with controller replacement or
multi-node controller pools.

## Import pre-flight

GitHub imports check repo size/language up front (`githubImport.ts`): large
repos and heavy-toolchain languages (Rust/Go/JVM/…) get a heads-up nudging
toward your-own-machine; nothing hard-blocks on GitHub's `size` (it counts
full history, the backend cap counts one ref's archive). Backend archive-cap
errors are rewritten to plain language.

## Enabling idle stop

- Apply the included `project_user_activity` migration before idle stops activate (the sweep
  fail-safes to off without it).
- No env needed for defaults; set `RUNTIME_IDLE_STOP_SECONDS=0` to disable
  idle stops, or override sizes only by editing `runtime/sizes.rs`.
