# Hosted Runtime Machines

How hosted runtimes are sized, paused, billed, and attributed. Code:
`packages/runtime-controller/src/runtime/` (sizes.rs, sweeps.rs, ensure.rs,
limit_waits.rs, stop.rs, provider.rs),
`packages/runtime-provider-core/src/allocator/docker.rs`,
`docker/docker-compose.runtime.provider.yml`.

## The model

Two user-facing concepts, deliberately no size matrix:

- **Hosted machine** — a small cloud computer per project. Pauses when
  unused, keeps project files and caches, wakes when you write in the chat.
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
state-driven ensure would relaunch the machine seconds after every pause.
Clicking into or typing in the chat composer (`#studio-chat-input`) clears
the pause and the machine wakes automatically; Send and an explicit Start
clear it too. Clicks and keys elsewhere (the space switcher, the Machines
rail, shortcuts) do not, so leaving a space never starts its machine.

## Starting a machine on intent

Opening a space never starts its machine: not at startup, not from the space
switcher, a link or a `?panel=machines` deep link, and not on a reload. Every
time a space becomes the active one the frontend holds its auto-ensure
(`markRestoredAwaitingIntent`, set in the project-change layout effect of
`useHostedRuntimeProjectEffects.ts`). The hold lifts on the first intent in
that space: clicking into or typing in the composer, Send, or an explicit
Start or Reconnect. Focus reaching the composer on its own does not count.
The Machines panel only reads status. One exception remains: the shared
browser dock still asks for a machine itself when it connects without one.

The tab that makes a Stop or Remove holds the space the same way when that
leaves it no live hosted machine, and a Machines-panel takeover holds the
blocker's space, the one whose machine it stops. Unlike the hold on opening a
space, this one survives writing in the composer: it lifts only when someone
in that tab asks for a machine there with Send, Start or Reconnect. It also
stays when the stop answered a 5xx or nothing at all, either of which can
follow a stop the controller committed, and a failed stop lifts it only when
the controller refused the request with a 4xx (see "Cleanup after a failed
release (502)" below).

A platform stop holds every open tab: `credits_exhausted` and `oom_killed`
arrive as `runtime.stopped` and hold like an idle pause. A Stop, Remove or
takeover made in another tab or device does not reach this tab yet. The
controller records `user_stop`, `user_remove`, `runtime_limit_takeover` and
`browser_session_runtime_limit_takeover` in `runtime_events` but does not
publish `runtime.stopped` for them, so another tab where someone already
wrote in the chat can still start that machine again on its next status
refresh. The frontend already holds those reasons like a manual Stop (when
they leave the space no live hosted machine) once the controller publishes
them. Unexpected loss (`heartbeat_timeout`, `origin.expired` within 20
seconds of a machine this tab had ready) still recovers straight away.

## Stop reasons

Sweep stops publish `runtime.stopped` with a `reason`:

- `idle` — pause; explained toast; wakes when you write in the chat.
- `credits_exhausted` — no auto-restart (held like an idle pause); toast
  links to credits. The ensure precheck (402 `insufficient_credits`) prevents
  launching a machine the first billing bucket would kill.
- `oom_killed` — heartbeat timeout whose container the provider post-mortem
  (`/runtime/inspect`, docker `State.OOMKilled`) attributes to the memory
  wall. No auto-restart into the same wall (held like an idle pause); the
  toast offers **Boost** (sets the size preference) or your-own-machine,
  escalating when the project has ≥2 OOM stops in 7 days (`runtime_events`
  query).
- `heartbeat_timeout` — genuine agent death; auto-recovery unchanged.
- `launch_timeout` — the launch never registered within 15 minutes (see "A
  launch that does not come up" below). The Studio handles it like
  `heartbeat_timeout`: a tab that had the space running starts it again. If
  the provider never brings the runtime up, such a tab therefore relaunches
  it about every 15 minutes while it stays open.
- `runtime_limit_reclaim` — the machine was idle and another space in the
  organization was waiting for the hosted runtime slot (see "Waiting on the
  runtime limit" below). The event carries `queuedJobCount`, the work left
  queued in that space (work that landed between the idleness check and the
  stop is requeued); such a space then waits on the limit itself. A studio
  open on the reclaimed space does not relaunch it unless it has work of its
  own there (a queued or running turn, or `queuedJobCount > 0`); otherwise it
  holds the machine like an idle pause until someone writes in the chat
  there.
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

A turn a stop cuts off says so on its run. In the requeue's transaction, the
run of each requeued job that was `in_progress` or `awaiting_approval` goes
back to `queued` with `progress_stage` `requeued`, and `runs.metadata` gains
`interruption`: `reason` (the stop's reason, such as `user_stop`, `idle` or
`credits_exhausted`, or `other` when it is not a plain token), `jobId`,
`interruptedAt` (the job's `requeuedAt`) and `resumeBy`, 15 minutes later:
the earliest the expiry may give the turn up, not a deadline, since a space
waiting on the limit or a stop still waiting on its provider release waits
longer. `GET /runs` returns that record after a reload. `/runtime/stop` and
`/runtime/remove` also announce it once they answer, as a `run.progress` of
the stored run stamped with its `updated_at`; other stops do not, so other
viewers see it on their next load of the runs. A lease resumes the turn like
any queued run (`in_progress`, `agent:leased`), and `interruption` stays on
the run as history.

When the expiry gives a turn up, its run fails with `run.completed`
(`outcome` `expired`, `failureCode` `interrupted_run_expired`) and its
conversation gets a controller error message (`kind`
`interrupted_run_expired`, `interruptionReason` the stop's reason). The
failure of a turn that a person's Stop or Remove (`user_stop`, `user_remove`)
interrupted starts nothing on its own: no plan checkpoint and no send-queue
drain. A message queued behind it still goes out with the send-queue recovery
sweep.

## A launch that does not come up

Until a launched runtime registers, it stays `requested` with a `launching`
lease and every ensure reuses that launch, so pressing Start again only waits
on the same launch. Two things end a launch that never comes up:

- An explicit retry. `POST /runtime/ensure` with `replaceStalledLaunch: true`
  (the Studio sends it from the chat's Try again, and from Machines Start on a
  stalled launch) replaces the launch when the runtime is still `requested`,
  was never seen, its lease is still launching, and that lease was requested
  at least 5 minutes ago (`STALLED_LAUNCH_REPLACE_AFTER_SECONDS`, measured by
  the database clock). The old allocation is released through the provider
  (stop reason `launch_retry`) before a new lease launches. If a job was
  leased meanwhile, or another retry already replaced the lease, the stop is
  skipped and the current launch is reused. A younger launch, or a request
  without the flag, is reused as before. Ensures the controller starts on its
  own (dispatch reconnect, limit-wait replays, requeue recovery, automations)
  never replace a launch.
- The launch-timeout sweep. After 15 minutes
  (`REQUESTED_RUNTIME_LAUNCH_TIMEOUT_SECONDS`) it stops the launch, files a
  bug report, and publishes `runtime.stopped` with reason `launch_timeout` so
  open tabs refresh at once.

`GET /projects/:id/runtime/status` reports `launchRequestedAt`, the active
lease's request time, so the Studio can tell how long the current launch has
been coming up without keeping a clock of its own.

## Waiting on the runtime limit

When every hosted runtime an organization may run is in use, an ensure for
another runtime is refused with 402 `runtime_limit_reached`. The runtime
holding the slot can be in another space or in the same one: a space's
standard runtime can hold the slot its Webdev runtime needs. If the machine
holding the slot is in another space and has been idle for
`RUNTIME_LIMIT_RECLAIM_IDLE_SECONDS` (default 120, 0 disables), the ensure
stops it and launches the waiting space instead (reason
`runtime_limit_reclaim`). That reclaim only runs inside an
ensure, and clients ask again only when someone writes in the chat, sends or
presses Start, so the controller retries for them (`runtime/limit_waits.rs`):

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
| `POST /runtime/census` | the pool-retirement drain (census, drain stop, flush-checkout) | 30 s | The census marks the provider as not answering (`complete: false`); a drain must then hold the node. |
| `POST /runtime/origin` | a stop's pre-stop flush, to find the runtime's origin on its node | 10 s | The flush mints nothing and reports `no_writer` (`origin_not_attested`); the stop goes on. |

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
`provider_release_cleanup_pending` event is recorded with the stop's `source`
(for example `idle_stop` or `ensure_stale_generation`) and `reason`. Only then
does it ask the provider to release. If the release fails or passes its 180 s
deadline, the stop answers **502** ("runtime provider cleanup is still pending;
retry the stop") and the quarantine stays in place:

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
queues behind any release or late launch still running there. Two stops of the
same lease can therefore both be acknowledged, and they race to finalize it:
whichever locks the runtime first finalizes the lease, and the other gets a
409 ("runtime lease generation is no longer current"). When the 409 goes
to an ensure's stale-generation cleanup, for example one queued behind an idle
stop still waiting on its own release, the ensure takes it to mean the
generation is gone and launches the next lease, unless the other stop removed
the runtime. A prompt sent while an idle stop is releasing the machine
therefore starts it again without a "Workspace startup failed" alert, at the
standard size as after any idle stop. The cleanup stops only the lease its
probe found, so a lease that another ensure launched meanwhile is reused, not
released.

The Studio reads both of these answers to a person's Stop, the 502
`provider_cleanup_pending` and the 409 "runtime lease generation is no longer
current", as a stop that took effect: the quarantine was committed, so the
machine is fenced off and its running turn is back in the queue. Machines >
Stop reports the stop as requested, a Machines-panel takeover goes on to ask
for the waiting space's machine, and both keep the stopped space held (see
"Starting a machine on intent"). Remove still shows the error, because the
runtime stays listed until a removal finishes, but keeps the hold as well. Any
other 5xx answer, or none at all (a network failure, or a proxy or browser
timeout during the release), shows the error and keeps the hold too: the
controller may have committed the stop first, and the run record then shows
the requeued turn (the live announcement goes out only if the request ran to
the end). Only a 4xx refusal, such as 409 "provider-managed runtime is
missing its active lease generation", 403 or 404, lifts the hold, since the
machine is as it was.

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
  copy) and pushes the refs; every fetch, push and connection attempt stops
  at the end of its 18-second budget (a git command still running then gets
  SIGTERM, so it removes its lock files, and SIGKILL two seconds later). Until
  the next refresh, the origin refuses further saves with 503
  `workspace_stopping` (the runtime agent says the workspace is stopping, not
  that a save conflicted), so a checkpoint racing the stop cannot put the
  parked work on `main` as well. When the stop does not happen after all (it
  is skipped after the flush, or refused before its quarantine), the
  controller lifts that fence with the flush's own credential
  (`POST /git/flush/resume`); the fence also lapses on its own after ten
  minutes, so a controller that died mid-stop never blocks saves for good.
  The origin gets `git.write` with one of two short-lived credentials; the
  runtime's machine token still cannot mint `git.write`:
  - the holder of the project's active workspace lease (bound to this
    runtime or to none) gets a 60-second `fs.write` token;
  - when nobody holds such a lease (an idle stop, or a lease bound to
    another runtime, as after a pool cutover) and the controller stops the
    runtime on its own (its sweeps, idle-slot reclaim, stale-generation
    cleanup and the pool-retirement drain, never a stop a user or a runtime
    asked for), the space owner gets a 30-second save-only permission (scope
    `workspace.flush`). It is bound to the project, the runtime, its lease
    generation and its origin, opens `/git/flush` (and its resume) and
    nothing else, and takes no workspace lease, so someone who opens the
    space during the flush gets their own lease as usual. The controller
    exchanges it for `git.write` only while that generation is still active
    (not yet quarantined), its origin online, and the subject still the owner
    with write access; the git token never outlives it. Commits stay
    authored by the origin. Each exchange is logged with the project, runtime
    and origin, never a token.
  Either credential goes only to the runtime's own origin, at the address
  the runtime's provider gives for that exact lease generation on its node
  (`POST /runtime/origin`; the Docker provider answers the origin's
  published port on the node's host gateway, `http://host.docker.internal:<port>`,
  and only when the controller its runtimes call is on the same node:
  `CONTROLLER_BASE_URL` (or `PROXY_CONTROLLER_BASE_URL` when that is unset)
  unset, or naming `host.docker.internal`, `localhost` or a loopback address), and only when that address is on the node or its
  private network. The endpoint the runtime registered itself, with its
  machine token, is never used: a hosted runtime's is a public tunnel host,
  and any runtime could name any address. When the provider places no origin of that generation
  on the node, the stop mints nothing and reports `no_writer` with the
  reason `origin_not_attested`; so does every stop through a Docker provider
  whose runtimes call a controller on another machine.
  Otherwise (no owner, or a requested stop with no lease holder) the
  controller mints nothing and does not call the origin (`no_writer`), and
  the runtime's own shutdown flush keeps the work locally. The origin's
  `unpushedRefs` and `unpushedRefNames` list what is still only on the node.
  The outcome, with whose name it saved under (`lease_holder`, `owner_grant`
  or `none`), is recorded as a `workspace_flush` runtime event, and the stop
  and removal responses carry it as
  `flush: {status, unpushedRefs, unpushedRefNames, error?, reason?}`
  (`status` is `flushed`, `no_writer`, `failed`, `skipped` or `not_running`;
  `unpushedRefs` is `null` when unknown; `error` is a fixed code such as
  `origin_unreachable`, `origin_timeout` or `origin_refused:<status>`, never
  the origin's own text). A failure is logged and the stop goes on; whatever
  was stored stays on the local refs.
- With rolling saves on (`WORKING_STATE_SAVES`, below), the flush body also
  carries `workingState: true`: the stop ends with the working folder's own
  save. The origin then stores no `unsaved` copy of work that save already
  holds, holds back the copy it does store from every push until that save
  settles (removed when canonical then holds every change the copy carries,
  pushed as before otherwise; the copy of a turn on a history unrelated to
  `main` is never held back), raises a stop flag so a rolling save in flight
  gives up (down again when the request ends, also when the controller gives
  up on it), waits for the workspace instead of refusing, and keeps the
  whole stop under 22 seconds. The answer and the stop's `flush` add
  `workingState: {durable, persistedAt, error?}`, and the `workspace_flush`
  event adds top-level `durable`, `persistedAt` and, when the save did not
  land, `workingStateError`: whether canonical holds everything the folder
  held, and since when.
- An idle stop (the idle sweep, the idle reaper, an idle-slot reclaim) can
  wait up to 25 seconds on its flush. When someone comes back meanwhile (a
  new workspace lease this runtime serves, or a user's activity ping), the
  stop gives way (`workspace_reopened`) and the origin takes saves again. A
  pool-retirement drain never gives way.
- The idle lease release (a job whose lease ran out mid-turn is requeued and
  its runtime stopped) always flushes with `turnActive`: that turn was
  interrupted, whatever the jobs table shows by then. Only the controller's
  own idle sweep uses the owner's permission there; a client's idle signal
  saves only under a lease holder.
- On the process's own graceful stop of a hosted runtime,
  `flush_workspace_before_shutdown` does the same local step without network
  or credentials: finished local commits are kept on a local `unpublished`
  ref (and stay on the branch for the next refresh to publish), files no turn
  saved on a local `unsaved` ref. When a turn is still running, or one lost
  its lease (a cancel, or a stop's requeue) within the last minute or with no
  job started since (a fenced runtime may be shut down long after its stop),
  its commits are set aside instead of left for the next publish; each job
  counts on its own, as the controller's `turnActive` does, so one worker
  finishing never hides another's cancel. It raises the stop flag and waits
  up to ten seconds for a rolling save to let the workspace go, so an
  unfinished turn always steps back, and stores no `unsaved` copy of work
  the folder's last confirmed save holds. It writes the durable-stop marker
  `.instafy/.git/instafy-stopped-clean` (`durable v1`) only when the folder's
  final state is durable: nothing only this node holds, and canonical holds
  everything the folder held. Its local step has just stored a copy of
  everything canonical does not hold (no `unsaved` copy of work the last
  confirmed save holds, none of work already pushed or dismissed), so that
  is the case exactly when no local recovery ref is left, whether or not
  its process ever saved: a clean folder whose HEAD `main` holds, or a
  dirty one whose `unsaved` copy a controller stop's flush pushed (as with
  rolling saves off, or when the stop's own save failed). Every origin
  start removes it, and so does
  every shutdown before its flush and anything that takes the workspace
  lock (a save, a publish, a refresh), so a marker another runtime on the
  same folder (or the workspace itself) left never outlives a shutdown that
  was not durable or could not run. A sibling runtime that keeps working
  after another's durable stop clears that marker with its next save, so
  while its rolling saves run its edits sit under that marker until its
  next tick that gets a grant (about one save interval while grants
  succeed). With rolling saves off,
  or once its ticks have ended (a refused grant, an expired workspace
  token), a sibling that is then killed without a shutdown can leave its
  edits since its last save under the other runtime's marker until the
  checkout is evicted, or until a pool-retirement drain reads the
  checkout as clean (the marker and no local recovery ref) and the node is
  deleted. The marker sits in a directory the workspace
  can write, so it is a hint for eviction, never proof on its own. The next publish
  or pre-turn refresh with `git.write` pushes the refs. Work parked only
  locally is lost if the node is replaced before that push. Desktop folders
  are never flushed.
- Residual exposure: a hard node loss mid-run loses the folder's edits since
  its last confirmed rolling save (about two minutes while saves succeed,
  plus files a rolling save defers), work parked locally whose push has not
  happened yet, writes by background processes after a turn ended that no
  controller stop flushed, and gitignored files.

**Rolling saves.** While a write job runs on a hosted checkout, the runtime
saves the working folder's unfinished work to canonical every two minutes and
once more when the job ends, without moving the checkout's HEAD, index, files
or nested repositories. Canonical git is then the only permanent copy and the
node's checkout a cache.

- Each working folder has one save, its slot:
  `refs/instafy/recovery/<working-set id>/working`. The working-set id is a
  one-way hash of a random seed the first save writes to the checkout's
  repository config (`instafy.workingSet`), so runtimes that share a folder
  on a node share one slot, a fresh clone (another node) gets a new one, and
  a turn that copies another folder's visible slot id into its own config
  only renames its own slot. Each save replaces
  the slot under a lease on the exact commit it last confirmed (the shard
  lets only a slot move; every other recovery ref is created or deleted;
  when a push's answer is lost the slot is looked at again, and a commit
  this folder wrote becomes the one it last confirmed),
  and the slot is deleted once nothing is unsaved and nothing waits on a
  local recovery ref. Its commit sits on `main` (the merge base, or `main`
  for an unrelated history), names its last writer in `Instafy-Origin`, and
  passes the same publish filter as every save.
- A tick first asks the origin in process whether the folder changed since
  its last confirmed save (HEAD, the tracked `main`, `git status` without
  taking `index.lock`, then each candidate's size, mode, mtime, inode and
  ctime: a rewrite of the same size whose mtime `tar -x` or `cp -p` put back
  still moves the ctime). A save never takes a file whose mtime or ctime is
  less than a second older than the save's start as read: where the clock
  behind file timestamps ticks coarsely, a rewrite of the same size right
  after the save read it would keep those timestamps, so the next check
  saves again (with nothing new, that save needs no network). A
  publish that moved only `main` onto the folder's own commits counts as a
  change, so the next save drops the slot's copy of that work. Unchanged, it
  ends with no
  controller call. Otherwise the runtime asks the controller for a one-minute
  `workspace.persist` grant with the job's workspace token. The controller
  grants it only for a write job leased by this runtime (or cancelled in the
  last minute), whose user may still write, for this runtime generation's
  own online origin, and checks all of it again when the origin exchanges the
  grant for a git token. That token carries `git.persist` instead of
  `git.write`: Git Edge lets it push only as a rolling save does (create
  recovery refs, replace or delete a working slot) and the shard refuses
  every other ref update, so it never writes a branch or `main`. A rolling
  save takes no workspace lease.
- A tick never adds a path inside a nested repository and leaves out files
  over 2 MiB: both keep the slot's earlier entry (where that earlier save
  changed them and `main` has not changed them since; otherwise the current
  parent's) until the job's end or a
  stop saves them. A tick asks the controller for that token with the
  workspace let go, within its own ten seconds, so a stop that comes
  meanwhile takes the workspace at once. A tick also sends at most 16 MiB of
  new content, smallest
  files first, so a small edit lands within its ten-second budget however
  much else the turn wrote; the rest keeps its earlier entry and goes out
  with the next tick, which runs even if nothing changed meanwhile. A tick that finds the workspace busy answers 409 and waits
  for the next one; while a stop's fence is up it answers 503. Ticks never
  overlap and a missed one is not queued.
- Cost, measured with 20 or 200 changed files alike: an unchanged folder
  costs 6 git processes and no controller call; a changed tick about 38 git
  processes, a grant and a `git.persist` token from the controller, one leased
  push and one `ls-remote`; a job's end with nothing new since a save that
  held all of it costs the same 6 and no controller call. About 1,100 git
  processes per runtime-hour of
  continuous edits. Every git command in a checkout first checks that the
  repository config holds only data; that config is parsed again only when
  it changed.
- When the job's body returns, whatever it returned (a terminal command and a
  turn that changed no file included), the ticker stops and the job's own
  save runs, unless the change check finds the folder exactly as its last
  confirmed save held it, with nothing deferred and nothing local-only. A
  save that did not land is recorded on the job as a `working-state`
  artifact (`durable: false` and a fixed error code).
- A slot a person removed (or restored) is gone from canonical while the
  folder's record still names it: its paths are not saved again until they
  change, and a stop that saves the folder, like every shutdown, stores no
  `unsaved` copy of them when the slot already holds everything else the
  folder changed. A stop's flush without `workingState` (rolling saves off)
  still pushes the folder's whole copy.
- `WORKING_STATE_SAVES=off` on the controller turns rolling saves off: the
  grant answers 403 `rolling_saves_off`, the runtime stops ticking, and
  stops ask the origin for no save of their own. A stop's flush then pushes
  the folder's `unsaved` copy as before rolling saves, and the shutdown
  after it still leaves the durable-stop marker. Slots already written stay
  on canonical, because nothing deletes them while saves are off, and are
  listed as unsaved work once their origin stops. A 401 (the job's workspace
  token, minted once when the job is leased and valid for at least an hour,
  has expired) also ends the job's ticks, with one warning, and its own save
  at the end is recorded as `workspace_token_expired`. Between turns nothing ticks;
  a requested stop (a user's or a runtime's) does not save under anyone's
  write access, so the last turn-end save covers the agent's work.

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
again, and later local commits built on it are published without it. Several
dismissed refs from one chain are handled deepest first, and a dismissal is
marked done only after the branch no longer carries its commits: one that
cannot be applied yet fails that save (422 `dismissal_not_applied`, never a
merge conflict), keeps a stop from publishing, and is tried again by the next
publish. Every publish fetches and applies dismissals before it pushes
anything. A copy parked before a dismissal was seen (by a stop, offline, or in
a run whose dismissal failed) is never pushed as it is: it is replaced by
what is left without the dismissed commits, or retired when the branch
already carries that rest; work that cannot be separated is kept whole for a
person to decide. A
recovery ref never carries a file that may not be published (secrets, legacy
chat uploads, build output): such files stay on the runtime's disk only.

**Checkout lifetime.** The hosted checkout is a bind mount of the node's disk,
`DOCKER_REPO_HOST/<project>`. It survives container stops and re-provisioning
on that node and is lost when the node is replaced; correctness does not
depend on it, because the next start clones `main` again. `DOCKER_REPO_HOST`
is never the origin gateway's `ORIGIN_WORKSPACE_ROOT`: the gateway moves every
`<project>` folder of its root aside when it starts, and refuses to start on a
folder that holds runtime checkouts. The provider service evicts stopped
checkouts:

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
  Checkouts from before this marker are kept the same way. Origins with
  rolling saves write the marker only when the stop leaves nothing
  local-only, so a checkout that holds work only this node has is kept
  too.

A stop takes the same per-project lock as a start while it runs and marks the
checkout as used, and the sweep reads that mark again once it holds the lock,
so a checkout is never evicted as its runtime stops.

The sweep runs every `RUNTIME_CHECKOUT_SWEEP_INTERVAL_SECS` (default six
hours, 0 turns it off). It reads refs from the repository files without
running git, and keeps any checkout whose state it cannot read with certainty.

**Draining a node before its pool is retired.** Hosted runtimes run on the
node of the controller that started them, and their checkouts live on its
disk, so deleting the node deletes both, including work that is only on a
checkout's local recovery refs. Before a release retires the previous
controller pool, the release workflow asks that controller (directly, with
the service-role bearer; user, operator and scoped tokens get 403) to drain
its node. A controller that serves these routes answers `/healthz` with
`x-instafy-runtime-drain: 1`, so release tooling can tell it apart from one
that predates them, and one whose running workspaces take rolling saves
answers `x-instafy-working-state: 1` (`0` when `WORKING_STATE_SAVES` is off):

- `GET /operator/runtime-drain/census` lists what the node-local provider
  holds (`POST /runtime/census`: runtimes from their containers' `SPACE_ID`,
  `RUNTIME_ID` and `RUNTIME_LEASE_ID`, and checkouts with their unpushed
  local refs and clean-stop marker, read from the files without git), joined
  with the database: a runtime is `live` when its container runs the
  runtime's active generation and `orphan` otherwise, and a checkout with no
  running container (a stopped one flushes nothing) `needsFlush` when it
  holds unpushed refs, lacks the clean-stop marker or cannot be read.
  `complete: false` means a provider did not answer, cut its lists or could
  not read its checkout directory.
- `POST /operator/runtime-drain/fence {fenced, ttlSeconds <= 3600}` makes this
  process start no runtime (503 `controller_retiring`) and skip its own stop
  sweeps and reclaims (`controller_retiring`), which after a cutover act
  through this node's provider on runtimes that may now live elsewhere. It is
  process-local, so the serving controller on the same database is never
  fenced, and it lapses on its own.
- `POST /operator/runtime-drain/stop {runtimeId, projectId, leaseId}` stops
  one live runtime through the safe stop with the drain's source. It is
  skipped as `runtime_lease_mismatch` unless the runtime's active generation
  is `leaseId`, before anything is flushed or fenced. An active turn is
  interrupted (its commits go to a recovery ref and its job is requeued). The
  answer carries the stop's `flush` and the checkout as the census sees it
  afterwards; when that census fails or cannot list the checkout, the answer
  is `ok: false` with `checkoutError`, never an absent (clean) checkout.
  `/runtime/stop` takes the same guard as `expected_lease_id`.
- `POST /operator/runtime-drain/flush-checkout {projectId}` saves a stopped
  checkout: it releases containers of other generations by their own ids,
  then, when the checkout still holds work and the space runs nowhere else
  (`busy_elsewhere` otherwise), starts the space's runtime on this node even
  while fenced, stops it again through the same flush and reports the
  checkout. That wake leases no job and is never billed (a
  `pool_retirement_flush_wake` runtime event marks its generation). It
  answers `clean`, `flushed`, `busy_here`, `busy_elsewhere`, `no_runtime`,
  `wake_failed` or `failed`. A census that fails, cannot list the node or
  was cut short is never read as clean: the answer is `failed` with `error`.

Every drain action is recorded as a `pool_retirement_drain` runtime event
with ids, statuses and counts only.

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
