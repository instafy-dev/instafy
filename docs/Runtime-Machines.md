# Hosted Runtime Machines

How hosted runtimes are sized, paused, billed, and attributed. Code:
`packages/runtime-controller/src/runtime/` (sizes.rs, sweeps.rs, ensure.rs),
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

Jobs requeued by any stop are stamped (`payload.requeuedAt`) and expire after
15 minutes **only if the project has no live runtime** — an interrupted run
must not replay days later, but a queued job behind a busy machine is fine.
The stamp is cleared when a job is leased.

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

Hosted workspaces are **git-canonical working copies**, not primary storage:
the durable copy is the bare repo on persistent git-shard storage plus encrypted
offsite backups. A fresh controller node restores each working tree automatically —
the origin server's `ensure_git_checkout` clones from
`GIT_REMOTE_BASE_URL/<project>.git` on runtime start — so a blue-green
controller replacement loses only work that never reached the remote:

- The agent pushes after **every run** (`auto_sync_after_apply`, default on).
- On any **graceful stop** (idle pause, credit stop, container drain) the
  origin server pushes a final `instafy: checkpoint before machine stop`
  commit of any dirty files (`flush_workspace_before_shutdown`; compose
  `stop_grace_period: 45s` gives it room).
- Residual exposure: a hard node loss mid-run (the in-flight run's WIP) and
  untracked/gitignored files. Accepted; both are bounded and disposable.

**Operational invariant:** `GIT_REMOTE_BASE_URL` must be configured for hosted
deployments—without it, workspaces have no durable backing and the controller
error-logs at startup. A dedicated single-attach workspace volume is structurally
incompatible with controller replacement or multi-node controller pools.

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
