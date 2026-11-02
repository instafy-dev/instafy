# Multi-Agent Evaluation

Instafy has three different agent execution lanes:

- Hidden Codex subagents inside one runtime turn.
- Top-level Instafy agents represented by normal conversations and optional linked agent threads.
- Multiple runtimes leasing top-level agent jobs in parallel.

Do not treat these as the same thing. A prompt can fan out into multiple top-level jobs while still running wall-clock serially. The controller leases batches of at most five jobs (one in strict mode). Additional slots require compatible read-only or exact write-scoped siblings. The default scoped file-generation lane uses concurrent tool-free model requests. Ordinary native jobs that depend on process-wide environment remain serialized. An experimental isolated subprocess lane can execute eligible workers with disjoint write scopes and real tools concurrently on one runtime. Skill-authored plans can also request `runtimeRouting.strategy = "spread"` across runtime processes on one or many machines.

## Choosing a Delegation Lane

The pinned `instafy-agent-collaboration` skill owns the soft choice between direct work,
temporary native helpers, and durable Instafy workstreams. A generic request for parallel
inspection does not require a controller-managed team. Ordinary parent turns receive a small
delegation-choice excerpt even when broader workspace memory is omitted or the provider
thread is restored. Tool availability, permissions and capacity remain runtime constraints;
skill-selection metadata does not grant capabilities.

Routing preflight receives runtime-owned facts from the resolved parent configuration and
model, before the classifier disables its own tools. These distinguish the normal parent
from concurrent scoped file-generation workers, which cannot execute commands. The skill
uses those facts when selecting a route for command-dependent subtasks. Native helper
availability and capacity still come from the parent's actual exposed tools; exact file
ownership alone does not make a scoped worker capable of running a command. Experimental
isolated tools remain opt-in and require controller admission.

Use direct work when coordination would add more cost than benefit. Exposed native subagent
tools can support bounded independent subtasks within the same parent job. Use top-level
Instafy worker plans when separate job tracking, independent worker context or personas, a
lead checkpoint, or other runtimes are useful or explicitly requested. Creating or continuing
one linked conversation uses ordinary conversation tools; it does not itself require a worker
plan. Preserve an explicit mechanism or worker count; report an unavailable mechanism instead
of silently substituting another.

Native helpers share their parent's workspace, permissions and scoped proxy envelope. They
do not acquire separate controller worker leases or independently enforced owned-file scopes;
asking helpers to use separate files is coordination, not isolation. The parent remains
responsible for waiting for helpers and integrating their results. Native capacity comes
from the pinned Codex configuration and exposed tool surface, independently of the space's
top-level team settings. Space managers can set **Concurrent helpers per task** in space
settings or use `instafy agents settings --max-native-subagents 10`. The default is three
helpers, with a supported range of 1–64; the parent is excluded from this number. Each parent
job has its own native helper budget, not a shared space-wide pool. The controller sends the
setting through the authorized job configuration, and the runtime applies it to the resolved
Codex configuration. New jobs, including later chat turns, receive the current value; running
jobs keep their existing limit. A successful response from an older controller without this
setting keeps the default of three. If fetching the job's settings fails, the runtime clears
the previous job's secrets and settings and conservatively limits native helpers to one; a
failed fetch cannot expand a space's configured limit. This setting does not enable native tools where they are
otherwise disabled. Bounded browser turns and experimental isolated tool workers disable
native subdelegation. Apply `20261025170000_project_native_subagent_settings.sql` before
starting the updated controller.

The `ai/task-usage` diagnostic artifact explicitly covers `root_turns_only`; it must not be
presented as the combined cost of a parent and its native helpers. Child requests use the same
job-scoped Instafy proxy path, where authoritative request metering belongs. Native helper
activity is not a separate Team plan card or durable worker status stream.

Before returning from a native attempt or retrying it, the runtime waits for its pending session
startups and registered Codex threads to shut down, including unfinished helpers. Cleanup runs outside the model-run
deadline and uses `CODEX_CANCEL_SHUTDOWN_TIMEOUT_SECONDS` (five seconds by default). It must
finish before another job can replace process-wide credentials. Unconfirmed cleanup fails
the attempt and prevents runtime reuse; abruptly dropping the caller also prevents reuse
unless cleanup was already acknowledged. Shared Browser retains its additional confirmed
tool-process shutdown requirement.

The deterministic `native_subagents` proxy integration fixtures exercise both pinned native
APIs with real shell commands and a scripted local provider. They cover simultaneous tool
barriers, capacity rejection, the shared scoped proxy route, root-only diagnostic accounting,
and child writes after cancellation or early parent return. They do not measure live-model
routing quality, latency, token savings, or hosted UI behavior.

The tests cover already registered helpers and ordinary shell descendants. Cancellation
during native child admission remains an upstream validation gap: Codex's `PendingSpawn`
cleanup removes the child from its manager before awaiting shutdown in a detached task.
An empty manager therefore does not prove that this pending cleanup has finished. The
runtime does not claim complete process containment or a verified barrier for that case.

## Live research and tool requirements

Plan agents may set `requiresTools: true` for live reads, commands or tests. This is a
capability requirement, not a permission grant. The controller retains it per worker through
retries, timed continuations and human replies. A tool-free owned-file worker fails before
model execution when tools are required; a complete read-only file preview no longer removes
its required tools. Plans without the field retain their existing behavior.

The research-team skill chooses available native helpers for ordinary independent live
research, or admitted tool-capable durable workers when useful. It does not treat owned files
or runtime spread as proof of execution capability. Isolated tool workers remain opt-in,
retain private snapshots and scoped publication, and receive their own host-generated turn
clock for paced web tools. CLI availability, authorized search configuration and the worker's
actual tool results still need verification. Fresh public-page loads share one controller-owned
budget across the parent, native helpers, durable workers and their continuations. The lead
allocates the remaining allowance to distinct source questions and reconciles sources and
unknowns before synthesis. Search quotas and job execution deadlines retain their existing scopes.

Space managers can configure **Web research** in space settings or use
`instafy web settings --max-page-loads 200 --max-page-loads-per-site 50` (also `--interactive`).
The defaults are 100 fresh loads total and 25 per site; both values are bounded at 1–200,
with the per-site value no greater than the total. The controller snapshots settings for each
new task. Changing settings does not replenish running tasks or their continued workers.
Spaces without saved settings use these defaults; explicit settings remain unchanged.
`instafy web budget --json` reports remaining allowance without fetching a page.

Apply `20261028170000_shared_research_budgets.sql` and
`20261029130000_research_budget_defaults.sql` before updating the controller.
Job bindings and reservations are controller-owned, with atomic accounting across runtimes
and idempotent reservation retries. A tool receives only a research-scoped capability for
its live job; isolated workers still receive no general controller credential. Cached reads
do not reserve a load, failed fresh attempts do, and redirects count each distinct site's
allowance while retaining one total page load. The controller spaces each site's reserved
start slots by at least two seconds; workers wait for their slot. Transport and DNS delays
can shift actual request times. A shared-budget service failure cannot create a local replacement allowance.
Standalone CLI use and older controllers without shared-budget support use the updated CLI's
local 100/25 accounting; all participating components must be updated for cross-runtime sharing.

Interactive browser control remains single-agent. Research helpers use public reading/search
commands and return browser-dependent gaps for a separate authorized browser step. This
change does not alter model defaults, enable isolated execution or introduce model-cost routing.

## Worker Settings and Evidence Handoffs

Scoped workers preserve the controller-resolved agent model and reasoning effort. An explicit
agent effort overrides the runtime's launch setting, then the existing job policy. Parallel
workers use immutable launch settings and their own proxy envelope, so another active job's
process environment cannot supply their credentials or model selection. Controller settings
are separated from granted secrets only when the secret inventory is present; project secrets
cannot override reserved model/process keys. Older responses without an inventory remain
usable by ordinary jobs, but cannot supply trusted settings to parallel scoped workers.

Read-only workers can use the compact, tool-free lane when the runtime has completely read
all declared files within the observation budgets. Truncated files, missing or invalid paths,
directory samples and omitted paths use the existing read-only Codex tool path instead.
Observation limits and workspace permissions are unchanged; tools can fetch relevant missing
evidence, not broader authority. A complete preview describes only the declared files, not
proof that the plan covered every dependency or that the review is correct.

Lead checkpoints carry bounded initial-preview gap metadata separately from worker summaries,
including for older runtime artifacts that record truncation. These are initial observations,
not a claim that later worker reads left the gaps unresolved. The collaboration skill asks the
lead to reconcile them with actual inspection evidence, close material gaps with existing
read-only tools or scoped follow-up work, and disclose remaining limitations. Job completion
alone does not establish a complete review. This can cost more than excerpt-only synthesis;
quality, latency and returned usage must be evaluated separately.

An early failure checkpoint and the group's final checkpoint run in order. Once all workers
are terminal, the final checkpoint waits for any queued or running early checkpoint to end,
then reads the current worker outcomes. Completion and cancellation callbacks, with idle
recovery after an interrupted handoff, can wake that final checkpoint. The existing group
lock, once-only final dispatch and explicit Stop behavior still apply.
Apply `20261025145800_agent_jobs_early_checkpoint_recovery_idx.sql` before enabling the
updated controller so idle recovery uses the partial early-checkpoint index rather than
scanning ordinary job history. The recovery query still checks historical early checkpoints
for a final result; it is not a constant-cost queue.

Profile selection and settings propagation are separate checks. A planner can still create an
ephemeral worker when a request names a saved profile. Verify the controller-stamped profile ID
before attributing a run to that profile, then inspect the effective worker settings. Correct
settings on an explicitly selected worker do not establish reliable autonomous profile selection.

## Shared Team Capacity

A space defaults to 64 agents per plan and eight concurrently leased team workers across
all its conversations and runtimes. These are separate limits: a ten-agent plan is retained
in full while excess workers wait in the queue. Root and lead turns do not consume the worker
budget, and each runtime's smaller batch and safety limits still apply. Lowering concurrency
does not cancel active work; new worker leases wait until capacity is available.

Space managers can inspect or update these controller-owned settings with
`instafy agents settings --space <id> --interactive`, or use `--max-agents-per-plan` and
`--max-concurrent-agents`. The supported ranges are 1–256 agents per plan and 1–64 concurrent
team workers. Read-only members can inspect settings; runtime tokens cannot change them.
See [CLI](CLI.md). The controller validates the complete plan before dispatch, so an oversized
plan produces a visible error instead of silently omitting agents. Planning prompts receive
the current limits; changing a setting does not expand tool, credential, or filesystem access.

Self-hosted runtimes must register themselves; a spread request cannot start more of them.
Spread fairness yields work only to ready/running group runtimes with a recent heartbeat,
so requested or stale slots do not strand a sibling in the queue.

Canceling a whole group records a durable stop, cancels its active lead as well as workers,
and suppresses later lead checkpoints. Canceling one worker retains the normal checkpoint
behavior. Studio distinguishes queued, working, waiting for approval, and canceled work;
terminal rows reload from persisted runs, with a bounded group-status lookup for older cards.
Historical cards with no recoverable group identity cannot use that fallback.

### Worker questions and human replies

Tracked worker assignments can return a structured `request_user_input` action with 1–3
questions and a bounded `continuationNote`. This ends the current turn and releases its
execution slot while keeping its assignment unfinished. The controller persists a question
message in the owning conversation, bound to the exact job, plan group and original human
requester. The original requester can select Reply on that message and answer through the
usual composer, whose recipient indicator makes the routing explicit. Multiple questions
are answered one at a time in that composer; the complete set is submitted together.
Replies accept text; attachments remain in the composer until removed or sent as an ordinary
chat message. Replies are task information, never tool approvals or credential entry. Use
the existing credential flow for secrets.
Workstream chips show the plan's task label, retaining the agent handle as identity and as
the fallback for older plans without labels. A chip opens its helper's run trace (or its
details); its "…" menu shows on hover or keyboard focus, and on a touch screen, which has
no hover, a long-press on the chip opens it.

An ordinary single-recipient chat turn can also answer pending worker questions naturally.
The controller supplies the existing routing preflight with a bounded set of questions owned
by that human in the same chat. The collaboration skill decides whether the message answers
them, needs clarification, or is unrelated. Explicit recipient/reply selections, control
commands, browser requests, delegated turns, and fanout to multiple top-level chat agents
retain their existing routes. Worker count is separate from this top-level recipient limit.

Natural answers identify request and question IDs and quote exact text from a controller-bound
human message. One message can answer several workers. The controller validates all selected
requests before saving any answer, reuses the original human message, and continues each
existing assignment with its original scope and connection. It rejects stale targets,
unrelated sources and conflicting replays. A request containing several questions requires
the complete answer set; missing answers prompt clarification rather than partial writes.

Ambiguous answers produce a normal chat question before any worker resumes. The next eligible
reply can clarify the target while retaining the earlier answer: after “concise” and “Which
task?”, “Meeting note” selects the task without becoming its answer. Unrelated messages leave
worker questions pending. Routing diagnostics and provider usage remain part of the ordinary
job accounting; natural reply matching is a model decision, not a domain-specific keyword rule.
The explicit Reply option remains available to choose a question directly.

Planning and lead checkpoints load the same User-facing results section from the workspace's
collaboration skill. That skill owns presentation guidance; runtime/controller contracts retain
output schemas, permissions and evidence requirements. Plans leave `expectedReportFormat`
absent or null unless the user requested a particular format. Explicit formats in existing
plans remain supported. Handoffs carry deliverables, completion checks and unresolved work
rather than another copy of presentation policy.

Prompt diagnostics identify the skill source and content hash, allowing runs to verify which
version each stage used. The workspace remains authoritative: later checkpoints use the current
skill if it changes, without persisting a second copy in plan state. Material failures and
incomplete work remain in checkpoint evidence and must still be explained.

The controller saves the answer before scheduling a continuation of the same assignment,
with its existing write scope, agent and connection. It restores provider history only from
that source job; absent history falls back to the saved assignment, note and answer. Duplicate
answers and restart recovery reuse the same continuation. Temporary dispatch failures use
bounded delayed recovery; repeated failure expires visibly. An answer received before job
completion waits for that completion. Studio distinguishes waiting for input, answer saved,
and worker queued. Other workers can continue during the wait.

This is a durable new worker turn, not resumption of an in-memory native tool call. Native
child helpers still negotiate upward, and parent–worker discussion uses linked agent chats;
only an explicit decision for the human creates a human question message. This does not enable
unrestricted nested worker plans. The parent's final checkpoint waits for unresolved questions.

Stopping the group or chat, invalidating the source lease, or deleting the space expires its
pending questions. Existing team deadlines and automatic continuation limits still apply;
human wait does not silently extend the team's time budget. A question whose budget or
original connection is no longer usable expires visibly and needs a fresh user request.
Apply the complete ordered worker-input migration set, from
`20261024120000_agent_user_input_requests.sql` through
`20261024120022_validate_agent_user_input_requests_answer_message_id_fkey.sql`, before deploying
this controller/runtime and frontend combination. The intermediate migrations add and validate
the conversation, run, prompt, runtime and message references separately to bound live-table
locks; do not roll out after only the table-creation step. The five constraint-addition steps
use the reviewed, content-hash-bound lock exceptions described in `supabase/MIGRATIONS.md` and
require reviewer approval. Older runtimes do not emit these actions.

The controller settles a planning job when it dispatches or refuses its plan. The originating
runtime may subsequently submit its fenced, one-time usage and artifact receipt without
changing that terminal result, posting another answer, or scheduling another continuation.

Apply migrations `20261015120000_project_multi_agent_settings.sql` and
`20261015120100_multi_agent_planning_receipts.sql` before starting the updated controller.
Its scheduling and completion paths require the new table and receipt column.

## Experimental Tool Workers

`INSTAFY_EXPERIMENTAL_ISOLATED_TOOL_WORKERS=1` opts a runtime into concurrent native
Codex workers with explicit, disjoint exact owned paths (no globs). It is off by default and
currently supports Linux and macOS only; other platforms fail before spawning a worker
until their filesystem sandbox backend is wired and verified. Each worker has a
private source copy, home and Codex state directory. Model requests still use the job's
Instafy proxy envelope; the runtime keeps registration, origin and publication credentials.
The runtime's temporary directory must be outside every Git repository; workers reject
repository ancestors so pre-turn Git discovery cannot inspect an unrelated host checkout.
The parent streams native tool events and retains task usage, then checks the entire result
against the write scope and verifies that the original owned files have not changed before
applying and saving it. Publication requires the controller to select this runtime’s local
origin. Source validation, writes and the scoped local commit share the origin’s
process-independent workspace lock. Publication then uses the normal policy/recovery
path with an empty file selection, preserving later Studio edits without uploading or
staging them; previously committed work may publish alongside the worker commit.
Conflicts fail visibly without rerunning the model. Completed and
failed publication attempts retain usage artifacts. The existing lease-loss path does not
submit a canceled job's returned usage artifact; cancellation therefore does not yet provide
a complete durable per-worker usage receipt.

This initial lane is for bounded source/file tasks. It omits existing dependencies, build
outputs, VCS/runtime metadata and secret files using the origin publication policy; custom
`.gitignore` rules are not evaluated. The snapshot limits are 20,000 entries, 128 MiB total,
20 MiB per file and 64 directory levels. Included symlinks, unsupported entries and oversized
trees fail visibly. Every new or modified file must be owned, including tool-generated caches;
put disposable tool output in the worker's private temporary directory. Empty-directory-only
changes and file/directory replacements are unsupported. Browser, MCP and attachment inputs
are unsupported in this lane; opted-in scoped jobs requiring them fail explicitly before
executing instead of silently dropping capabilities. Native subdelegation and active-turn steering are disabled
inside this experimental lane; controller group/worker cancellation remains authoritative.

Shell tools receive a restricted filesystem policy, not the runtime's normal full-access
policy. Cancellation first asks Codex to stop, then terminates the observed process tree;
normal shell/background processes are covered. An unconfirmed shutdown stops the runtime
from taking more work. Descendant polling on macOS is not an
OS-enforced containment guarantee against intentionally detached double-forks. Local apply
can roll back ordinary write failures but is not crash-atomic across multiple files. These
limitations are reasons to keep the lane experimental.

The default file-generation shortcut remains unchanged until the new lane is validated. It
has no execution tools: asking it to wait does not execute a timer. Prior poem-generation
timings measured that shortcut and do not benchmark the experimental native lane.

## Signals To Capture

Every top-level agent lease should expose enough timing to tell whether work was actually parallel:

- `queuedAt`: agent job creation time.
- `leasedAt`: when a runtime acquired the job.
- `queueWaitMs`: elapsed time between creation and lease.
- `leaseAttempts`: how many times the job has been leased.
- `leasedByRuntimeId`: runtime that acquired the job.
- `agentHandle`: normalized top-level agent handle for the job.

The controller currently includes this as `leaseMetrics` in `/agent/lease` responses and `run.progress` lease events. Write-heavy fanout also carries per-job `writeScope` metadata in job metadata and run events.

For filesystem checks, distinguish runtime setup from worker edits. Capture a prepared workspace
baseline or declare exact bootstrap asset hashes before execution; do not ignore an entire
guidance directory. Protect existing and read-only files, reject unexpected or altered support
files, and verify proposed and published paths against the owned scope. Keep original failed
checks intact when later analysis explains a fixture-boundary error; label a replay of retained
evidence separately from a new live run.

Write-scope metadata is explicit. The controller does not infer editable paths from
natural-language prompt text or file names inside prompt prose.
Structured paths do not require a recognized extension: top-level `.txt` files,
extensionless files and supported directory/glob scopes are valid. Each path and
scope field is validated before dispatch. Malformed explicit scopes, conflicting
scope declarations or more than 12 unique paths in either path list become
`coordination_required`; invalid entries are not dropped and cannot fall back to
`unscoped`. Missing scope metadata retains the existing dispatch defaults.

Write-scope modes:

- `owned`: the agent may edit only the listed `ownedPaths`; other listed paths are read-only.
- `read_only`: the agent can inspect context without writing.
- `unscoped`: allowed only when there is no sibling writer to coordinate with.
- `coordination_required`: invalid, missing or overlapping editable scope was detected; the runtime-agent completes with a coordination-required answer and does not edit files.

## Runtime Final-Output Modes

Runtime jobs should use the narrowest final-output contract that still gives Studio the machine-readable data it needs:

- `strict_structured`: default for executable automation. The Responses API receives the JSON schema because Studio needs `summary`, `files` and `actions` to apply file changes or render product actions.
- `schema_free_structured`: planning/checkpoint turns still prompt for a parseable JSON object, but the API-level schema is disabled because lead synthesis and action planning proved more reliable without strict final-output enforcement. Studio validates/parses after the model returns.
- `plain_text_report`: pre-observed read-only worker lanes produce evidence prose. They should not be forced through the JSON final schema because no file/app action is expected.
- `plain_text_write`: ordinary required or conditional workspace-change jobs use tools and finish with a short summary; actual file changes are collected from disk. Conditional review can finish with an evidenced no-change result. Required prior-context retrieval does not change this format. Read-only and coordination-required scopes retain their restrictions.

The selected mode is recorded in the runtime prompt-context artifact as `finalOutputMode` so no-final failures can be debugged without reverse-engineering prompt shape.

## Routing Preflight Contract

Ambient multi-human turns dispatch an evaluation job to each active agent. The main agent applies the pinned group-participation skill to the latest turn and supplied history, then answers, claims, corrects, or declines with `NO_RESPONSE`. Runtime preparation and the routing preflight below may already have run before a decline; silence does not imply zero runtime or provider work. The controller suppresses the decline and defers ambient managed-AI user billing until visible speech. There is no shipped conversation-only early participation gate. See `docs/Group-Conversation-Participation.md`.

Multi-agent dispatch and recovered-context routing are now skill/model-authored decisions, not frontend or runtime natural-language keyword rules.

Before a normal root turn enters detailed planning, the runtime asks for one small structured routing object:

- `route`: `direct`, `multi_agent_candidate`, `cross_chat_lookup`, or `write_coordination_required`.
- `requiresContextLookup`: true when necessary prior conversation/thread/context evidence must be retrieved because it is absent from the supplied current conversation.
- `requiresCommandExecution`: true when a separate fresh observation of workspace, process, Git, or other current tool-observed state is needed. The CLI transport for context retrieval does not itself set this flag.
- `workspaceFileChangeRequirement`: `none` when no mutation is requested, `conditional` when inspection or validation determines whether edits are warranted, or `required` when success needs actual workspace changes. This is independent of either evidence requirement.
- `observationCommands`: up to three proposed current-state observations; the host executes only its existing allowlist. Rejected or missing proposals leave the observation requirement for the main agent under its normal permissions.
- `selectedSkills`, `reason`, and `confidence`: observability for why the route was chosen.

Write permission and completion requirements are separate. Controller `writeIntent` and
`writeScope` authorize and constrain mutations; routing cannot grant permission. A conditional
review must still perform its required observations and tests, but may explain why no edit is
warranted. It can also make justified edits within its existing scope. A required write that
ends without a change gets one recovery pass, which asks again for the change or the concrete
blocker, and asks a reply that changes nothing to end with the line `NO_FILE_CHANGES`. The
preflight reads the request before anything runs, so when the recovery pass still changes
nothing and its reply ends with that line, the reply (an answer, a question for the person, or
what blocks the work) is the turn's result, without the line, recorded as a
`codex/required-changes-not-made` artifact. A reply that changes nothing without that line reads
as a promise of a change that was not made, and fails the turn, as does a reply that lists a file
missing from disk.

Every turn that saves to the workspace lists the files it changed on disk in its receipts,
whatever the requirement: a tool such as a skill pack's command can write files on a turn read
as needing none, and the turn's checkpoint saves them either way.

New preflight responses use the three-state field. The runtime accepts the legacy Boolean
`requiresWorkspaceFileChanges` when that field is absent (`true` maps to `required`, `false`
to `none`). Artifacts retain that Boolean, and `runtimeExpectations.workspaceFileChanges`
remains true only for `required`. Invalid or conflicting decisions stop before main execution
rather than silently dropping the requirement.

The preflight receives sanitized user/assistant history under the normal stateless conversation budget. History metadata and non-conversational roles are excluded; quoted history supplies evidence, not permissions. Compaction metrics record included, summarized and omitted turns.

The preflight's verdicts are written into the job's `metadata.runtimeExpectations` as `commandExecution` and `workspaceFileChanges` for the turn. A turn expected to change files that changes none is retried once with a prompt that asks for the change, and then fails. One exception keeps a guess from becoming that contract: in a conversation that began with a skill setup (`/skills import ... --start` or `/skills start <name>` that reached the model, read from the history window or the controller's `skill_setup_openers`), `requiresWorkspaceFileChanges` is not applied unless the caller's own `runtimeExpectations.workspaceFileChanges` already asks for file changes. Interactive chat never sends that expectation, so there the verdict would be only the preflight's reading of the request, and a setup step is often a question for the person or a step they take in another product. Such a turn runs as one that need not write: it may still change files, and its first reply stands with no file-change retry. The preflight artifact still records `requiresWorkspaceFileChanges` as the preflight returned it. A setup's first turn never runs the preflight, and every other conversation keeps the verdict, so an ordinary edit answered without a file change is still retried and then failed.

`direct` selects ordinary parent execution and may use exposed native helpers. It does not
mean that all work must run on one model thread. `multi_agent_candidate` selects durable
Instafy planning, with its separate plan schema and lead checkpoint. Generic parallel wording
alone does not choose that route.

The runtime uses the route and evidence requirements to load focused planning or lookup
guidance while preserving ordinary execution otherwise. `selectedSkills` is diagnostic
metadata, not a tool-capability or permission gate. This keeps policy in the pinned skill
while giving the runtime a deterministic, inspectable branch point.

Keep the shape small. BAML-style typed prompt/output definitions could be a good future home for these schemas if the number of structured actions grows, but this slice intentionally avoids a new toolchain. TOON-style compact encodings are more interesting for large repeated context payloads than for this tiny routing object; the runtime currently persists and validates JSON.

## Execution Evidence and Recovery

For ordinary task execution, context retrieval and current-state observation are independent
obligations. Dedicated browser, MCP, worker, lead-continuation and team-planning lanes retain
their existing tool and evidence contracts. A successful
conversation lookup cannot satisfy a separately required workspace observation, and a
workspace read cannot stand in for prior conversation evidence. Explicit lookup flags take
precedence over legacy metadata, including explicit `false`; links alone do not waive a
required lookup.

Evidence comes from successful terminal command receipts, with exact argv retained separately
from display text. Failed, incomplete or malformed receipts do not count. The recognizer accepts
bounded literal read sequences conservatively: a successful `&&` segment proves its reads,
while earlier commands before a semicolon or newline are not proven by the final exit status.
A `|` pipeline counts as one observation of its first command when every later stage only
formats output (such as `head`, `tail`, `grep`, `wc`, `sort`, `jq` without `-n`, `--arg` or
file operands, or `python3 -m json.tool`). Without pipefail a pipeline's exit status proves
only its last stage, so a pipeline never proves a conversation lookup, and a failed first stage
can still be credited as an observation; its error text stays in the output because an earlier
stage may not discard stderr. Stderr may go to `/dev/null` only on an unpiped command or a
pipeline's last stage; any other redirect is rejected. Commands that only print literal text
(`echo`, `printf`, `yes`) never count, piped or not. Short read flags such as `grep -h` and
`ls -h` are reads, while `--help` and `--version` are not.
Unsupported shell shapes may remain unrecognized even if a read actually occurred. Legacy
single-command interpreter receipts remain generic execution evidence, not proof of correct
program semantics or answers. This classification does not grant execution permission.

The existing single recovery attempt preserves the original tool permissions, write scope and
final-response format. Its feedback names missing evidence and reports fixed diagnostic counts
without replaying raw scripts. Successful evidence is accumulated across attempts, including
when a provider reuses event IDs. Failed pre-observations do not satisfy a requirement, and
cancellation interrupts recovery backoff. Missing context retrieval remains blocking after the
retry; an ordinary observation-only job retains the existing warning path when its retry
produces a usable result. The job keeps the first attempt's answer, records a
`codex/final-message-kept-from-attempt` artifact and still merges the retry's evidence when all
of these hold: the retry ran only for missing command observation; the first attempt completed a
command that ran a program beyond literal output (`echo`, `printf`, `cd` and here-documents do
not count, while an unsupported read shape does); the retry returned no actions and wrote no
files; and the retry brings no answer of its own (an empty or fence-only reply, a lead-in line
before empty fences, an internal fallback, a transient upstream error, or a reply from a retry
that ran no such program, where a failed `grep` still counts as having run). The saved provider
thread remains the retry's. The `codex/routing-evidence-recovery` artifact records cumulative
requirements, evidence and receipt counts, not command contents.

## Context Recovery Contract

The intended memory model is explicit recovery, not global agent memory.

- Same-chat follow-ups can use the parent transcript, Team plan evidence rows, inline conversation/thread/message refs, and same-conversation context cards.
- Linked agent threads are durable lanes for a scoped agent. If a follow-up should update that agent's local memory, continue in that thread or post to it with `instafy chat --conversation <threadId> ... --no-wait --json`.
- New or unrelated chats with the same handle do not automatically inherit old provider thread state. The lead should recover context with `instafy agents context list --json --query "<topic>"`, then `instafy conversation search "<topic>" --include-threads --json`, and only `instafy conversation show <conversationId> --json` for the best match.
- Compact context cards are an index/cache for durable cross-chat facts. They should point toward the right conversation/agent/thread or summarize durable conclusions; they should not become transcript dumps.
- Soft topic focus and current work direction live in context cards plus conversation/thread refs, not a separate controller object. Cards can say which agent/thread is focused on which paths/domains and what remains open, but they are hints rather than locks.
- Before broad or cross-chat work, leads should search cards and conversation history to avoid duplicate investigation. If overlap exists, the skill decides whether to reuse evidence, ask the prior thread one focused question, split the new work orthogonally, or explain the coordination requirement.
- Raw runtime/Codex debug traces such as `.codex-runtime*`, `.codex-runtime-fallback`, `.codex/sessions`, and runtime logs are not user-facing conversation memory. They are allowed for debugging only when the user explicitly asks for logs; cross-chat recovery should use the Instafy context/conversation CLI contract above.
- If recovered evidence is enough, answer directly and cite the relevant handle/thread/card. If it is not enough and one prior focused thread is clear, ask that one linked thread. Escalate to multiple prior threads or a new `multi_agent_plan` only when the follow-up itself is broad or cross-domain.

## Scenario Matrix

| Scenario | Expected behavior | Current coverage |
| --- | --- | --- |
| One prompt mentions two agents, no thread cue | Two top-level jobs, both inline in the parent conversation. | `multi-agent-dispatch.spec.ts` and `chat-assistant-toggle.spec.ts` |
| One prompt mixes inline and explicit linked-thread wording | Only the explicitly split agent gets a linked thread. | `chat-assistant-toggle.spec.ts` |
| Prompt says not to create a thread | Negated thread wording stays inline. | `agentCollaborationPolicy.test.ts` |
| One runtime leases read-only fanout | Controller can lease a read-only batch together, but runtime-agent serializes process-env-sensitive Codex/tool execution inside that runtime. | runtime-agent unit tests, controller lease filter tests, manual Studio smoke |
| One runtime encounters write-capable fanout | Exact write-scoped siblings can share a batch; eligible direct-proxy workers with disjoint scopes run concurrently. Other writes retain their serialized path. | runtime-agent batch/direct-worker unit tests, controller lease filter tests |
| Skill-authored plan requests `runtimeRouting.strategy = "spread"` | Worker jobs are not pinned to the parent runtime, can bypass preferred-runtime lease restriction, and are excluded from read-only batch slots so one runtime cannot grab the whole spread. The controller may request additional runtime slots from the provider. | controller/runtime-agent unit tests; 2026-05-26 Studio smokes |
| Two runtimes lease fanout with spread-safe jobs | Jobs split across runtimes; `leaseMetrics` identifies each runtime. | `multi-agent-dispatch.spec.ts`; 2026-05-26 Studio smokes |
| One sibling succeeds and one fails | Each agent posts its own final outcome; one failure does not suppress sibling success. | `multi-agent-dispatch.spec.ts` |
| Agents have distinct handles but no stable agent id | History/provider state stays scoped by handle. | controller unit tests |
| User requests bounded parallel inspection within one parent task | The skill may choose exposed native helpers under the ordinary parent execution contract; a durable plan is not forced by parallel wording. | runtime prompt contract tests; live policy evaluation pending |
| Native helpers execute inside one parent job | Real child tools can overlap within the native limit, inherit the parent proxy scope, and stop before the parent job releases its execution environment. Root diagnostics retain their narrower coverage label. | `native_subagents` proxy integration tests for V1 and V2/code-mode; live-model performance evaluation pending |
| User explicitly requests separately tracked Instafy workers and a lead checkpoint | The lead emits a generic `multi_agent_plan` before substantive inspection or edits, preserving the requested mechanism and worker count. | skill/runtime contract tests and manual Studio smoke |
| Skill emits a generic `multi_agent_plan` for broad read-only work | Controller creates sibling top-level jobs from skill-authored handles, prompt segments, and `writeScope.mode = read_only`; there is no security-specific frontend fanout. | runtime-agent action tests, controller `multi_agent_plan` tests, frontend policy test, manual Studio smoke |
| Skill emits `multi_agent_plan` with write-scoped siblings | Controller passes per-agent `writeScope` metadata through normal dispatch; disjoint scopes run normally and overlapping/missing scopes become `coordination_required`. | controller write-scope tests plus `multi_agent_plan` metadata tests |
| Skill-authored siblings reach mixed terminal states | Controller queues a lead continuation checkpoint after all worker siblings complete, fail, cancel, or expire. A worker the controller fails before any runtime ran it (the idle sweep's stranded platform jobs, a runtime limit wait's give-up or refusal) counts like a canceled one: it never wakes the lead early, and failing the last live worker runs the checkpoint, once per plan however many sweeps fail its workers. A limit wait's refusal ends the wait, so the lead it queues that way fails with the same reason in the same tick. The checkpoint reports durable sibling status; the lead decides whether to synthesize, delegate follow-up work, answer directly, or ask the user. | controller `multi_agent_plan`, `self_hosted_platform_lane_tests` and limit-wait tests; integration coverage pending |
| A lane runs out of turn time with work left | Shortly before the hard limit (`CODEX_RUN_TIMEOUT_SECONDS`) the runtime steers a plan lane's live turn once to save its work and end (`INSTAFY_TURN_WRAP_UP_SECONDS`, default 120 s before the limit; 0 turns it off). Other turns (a person's own, a lead's) get no wrap-up. A lane with continuations left also gets `INSTAFY_TURN_CONTINUE_FILE` (each attempt starts without one); the note it writes there becomes `agent/turn-continuation` (`endedBy: "agent"`). A turn the limit stops anyway asks for one too (`endedBy: "time_limit"`), with its last commands as the note when it wrote none, keeps its run log, and is not rerun in-process. Its edits are not saved by that turn: it keeps its record of how the folder began (`turn_baseline`), and the continuation, which names it (`continuation.of`), begins from that record, so its save counts the stopped turn's edits too (on the same runtime; on another runtime the unsaved edits are not there). The controller starts the same lane again in the same group, on the runtime that ran it, with its own prompt and the note: at most two continuations per lane, the last marked so (it gets no continue file), none for a stopped group or a cancelled or expired lane, and none when the plan's send ran on Instafy AI and the org could no longer pay for another managed prompt. Continuations, like a lane's first turn, are not charged a prompt of their own. The group stays open meanwhile, so the lead checkpoint waits for it, and the lead reads the continued job's line as superseded by its continuation. A continuation that stops on a short provider rate limit is retried as that turn. Studio reads the rerun the same way (from the new job's `continuation.of`/`rateLimitRetry.of`, or the group status's `retriedAs`/`retriedFor`): the lane's chip shows its newest run, the stopped run never counts as failed, and one quiet line under the team card (and at the end of the stopped run's trace) says it continued, with a link to the continuation. Every ordinary turn also records `agent/turn-timings`: each command's start and duration, the wrap-up, and the steps tools append to `INSTAFY_STEP_TIMINGS_FILE` (one JSON object per line). | runtime-agent `jobs::turn_continuation`, `jobs::turn_baseline` and the `turn_wrap_up` proxy integration tests; controller `multi_agent_plan::turn_continuation` and `self_hosted_platform_lane_tests`; Studio `planReruns`, `MultiAgentPlanEntry` and `PlanRerunNotice` unit tests and the `plan-rerun-notice` component spec |
| A lead's turn (the person's turn it plans in, or a checkpoint) stops on a short provider rate limit before it acted | When several teams start at once on one upstream, a lead's first request can land in an exhausted window. A lane that stops this way runs once more in its group; any other turn goes back to the queue instead of failing, up to three times, as a runtime stop puts back the turns it cut off: the same job and run, the run shown as queued again (`progress_stage` `requeued`, `metadata.interruption.reason` `upstream_rate_limit`), and no failure posted. No runtime leases it before `payload.rateLimitRetry.heldUntilMs`: the stated wait plus a per-job jitter (as for lanes), never before its upstream's pacing cooldown ends, and at most 60 s. The rules are the lanes': the shared provider rate-limit kind (`run_failure_fixtures.json`) with a stated wait of at most 30 s (never a usage limit, quota, auth or other 4xx, or a rate limit with no or a long wait); the turn ran no command (the runtime's routing pre-observation aside), MCP tool or file change, posted no visible reply and started no job; at most three times per job (`payload.rateLimitRetry.attempts` counts them; one re-run was not enough when four teams started at once on an upstream that takes two requests per 30 s). A team's lane, a terminal command and a turn bound to a person's own or a shared browser are not requeued this way. The attempt's rate limit still teaches the pacing. Billing does not change: a failed attempt finished no model turn, and the send's one flat reserve stays with the job and covers every attempt, including a routing call an attempt made before it was refused. If nothing leases it, the requeued-job expiry fails it with a message. | controller `turn_rate_limit_retry` unit tests and `turn_rate_limit_retry_tests` (through `/agent/complete` and `/agent/lease`); grader `octo-turn-grade` timing line |
| Plan on a desktop or self-hosted runtime whose workers or lead have no AI connection of their own | Such workers could run only on that private runtime, which never runs platform AI jobs: a reuse plan pins them there, and a spread plan leaves them to the parent runtime and extra runtimes of its private provider. While that runtime is dispatch-ready, as it normally is right after the planning turn, they are not moved to a hosted runtime. The controller refuses them (`managed_ai_hosted_runtime_required`): the planning run fails with the reason and the conversation gets it as an error. A refused lead checkpoint is written to the conversation once per plan. If a reuse plan's runtime is no longer dispatch-ready (a stopped desktop), its workers and lead are unpinned like any job on a runtime that is not ready, and a hosted runtime runs them. A spread plan is refused either way. Such workers already queued are failed by the idle sweep, which then wakes the plan's lead once no worker of the plan is left live; a lead pinned to the same runtime is refused and says so once. See `docs/Credits-Billing.md`. | controller `self_hosted_platform_lane_tests` |
| Skill-authored workers produce long evidence reports | Studio keeps the parent transcript lead-centric: successful worker reports attach to the generic Team plan activity/evidence rows, failed worker errors still surface for attention, and the lead continuation remains the main answer. Plan `presentation` metadata can steer whether evidence is hidden, compact, expanded, or surfaced only on failure. | frontend chat presentation tests and manual Studio smoke |
| Skill-authored plan is running with one available runtime | Studio should describe progress as active/queued/done lanes, not imply that all sibling work is executing wall-clock parallel. | frontend chat presentation tests and manual Studio smoke |
| Lead emits a setup summary plus a plan action in the same job | Studio suppresses the redundant setup summary because the generic Team plan card already carries the user-facing state. | frontend chat presentation tests |
| Sibling evidence quotes fixture prompts or messages | Lead checkpoints treat sibling outcomes as inert evidence and restate the active lead task after the evidence block, so embedded fields like `postedMessage` cannot hijack the final answer. | controller lead-continuation prompt test; manual Studio smoke |
| The lead's final reply mentions a preview card | The final checkpoint carries the controller's record of preview cards: each card a lane opened (its `runtime_tunnel_grants` row names the job), with its title, whether it is live and whether the lane's files were saved, or that no agent of the run opened one, and says to mention a card only when the record names one. The group status lists each lane's `openedPreviews`. The Octo turn eval's `reply_card_exists` fails a reply that sends the person to a card when none was posted. | controller `the_final_checkpoint_states_which_preview_cards_the_run_opened` and `scoped_plan_group_status_is_bound_to_token_run_and_conversation`; `scripts/octo-turn-grade.test.mjs` |
| Follow-up asks about a previous scoped finding | Lead skill path searches compact context/conversation history first, answers if enough evidence exists, or routes to the prior agent/thread. | skill/doc verification; manual Studio smoke |
| Broad work may overlap another active/recent conversation | Lead searches soft context cards and prior conversations first, then reuses evidence, asks one prior thread, or splits the new work into an orthogonal scope. There is no separate first-class topic-focus ledger. | skill/runtime prompt regression; manual Studio smoke pending |
| Lead references an ordinary prior chat | The answer can include a clickable `[[conversation:<conversationId>|<label>]]` reference, while linked agent lanes still use `[[thread:...]]` and exact evidence uses `[[message:...]]`. | Studio message render tests |
| Follow-up names code/path/topic but not the relevant prior lane | Lead treats agent-to-agent questions as first-class conversations: lookup first, answer directly when enough evidence exists, ask one likely focused thread when durable context matters, and escalate to multiple prior lanes/team plan only when the follow-up crosses the threshold. | skill prompt regression; manual Studio smoke |
| New chat asks a same-handle agent about prior team work | The agent does not assume global memory. It recovers context through compact cards and conversation/thread search before answering or delegating to the old linked thread. Raw runtime/session traces are rejected as user-facing evidence. | skill/runtime prompt regression; 2026-05-31 Studio smoke |
| Prior sibling thread is the right focus for a narrow question | Lead posts one focused `@agent` question into that linked thread, preferably non-blocking from an active runtime turn, instead of polling all siblings or spawning a team. | skill/runtime prompt regression; manual Studio smoke |
| External public repo, documentation, or artifact review needs team fanout | Lead prepares needed sources under the shared project workspace before emitting `multi_agent_plan`. Small generated handoff files can be returned as normal internal `files` entries; larger clones/fetches use runtime tools. Worker prompts and `writeScope.readOnlyPaths` carry exact shared paths/globs. | skill/runtime prompt regression; manual Studio smoke |
| Prepared shared paths feed later workers/follow-up | The lead records compact context cards for reusable prepared inputs and passes shared source roots/paths in worker prompts/scopes. Follow-up recovery uses conversation/context evidence rather than controller-inferred source semantics. | skill/runtime prompt regression; prior-evidence recovery tests |
| External preparation is required before review lanes | Preparation and dependent review lanes do not belong in the same sibling batch because sibling jobs can start immediately and may run on different runtimes. The lead must finish shared-workspace preparation first, then emit the team plan. | skill/runtime prompt regression; manual Studio smoke |
| Prepared source lives in shared workspace | Lead plans can reference prepared workspace paths directly and request `runtimeRouting.strategy = "spread"` for independent read-only lanes, so one shared checkout/fetch can feed multiple runtime workers. Runtime-local `/tmp` paths require `reuse` or self-contained worker fetch instructions. | runtime-agent/controller tests; manual Studio smoke |
| Spread workers receive prepared source roots | Workers use exact shared workspace locators and bounded commands in their lane prompt. Runtime-agent does not auto-fetch repo trees or infer lane files from GitHub URLs. | 2026-05-26 `dao-xyz/borsh-ts` Studio smoke |
| Two write-heavy agents have disjoint explicit file scopes | Jobs get `writeScope.mode = owned` and can lease normally. Prompt text alone is insufficient for editable scope. | controller unit/integration tests; 2026-05-26 Studio smoke |
| Two write-heavy agents touch the same file scope | Jobs get `writeScope.mode = coordination_required`; runtime-agent completes with a coordination-required answer and does not edit files. | controller + runtime-agent unit tests; 2026-05-31 Studio smoke |
| Read-only multi-agent work | Jobs get `writeScope.mode = read_only` and are unrestricted by editable write scope. | controller unit tests |
| Credits run out while jobs are queued | Chat should show only the live out-of-credits blocker and vanish after refill. | Runtime & AI/credits UI tests |

## Manual Smoke Notes

- 2026-05-24 manual Studio smoke: a real-composer `write_scoped multi_agent_plan` with five sibling writers (`alpha`, `bravo`, `charlie`, `delta`, `echo`) created five disjoint files successfully on one hosted runtime. Lease timing confirmed same-runtime write-capable siblings were serial, not wall-clock parallel; each worker carried `writeScope.mode = owned`, and Octo's lead continuation remained `read_only`.
- 2026-05-25 implementation checkpoint: `runtimeRouting.strategy = "spread"` is now a generic skill-authored scheduling hint. Spread jobs are unpinned from the parent runtime and excluded from single-runtime read-only batches; the controller can request additional provider runtime slots for the plan.
- 2026-05-26 `dao-xyz/borsh-ts` Studio smoke: a real-composer public repo review prepared the public repo once in the shared workspace, then emitted four explicit read-only scoped workers with `runtimeRouting.strategy = "spread"`. The workers leased across four distinct runtimes and Octo synthesized the final report.
- 2026-05-26 disjoint-write Studio smoke: five explicit write-scoped workers for `multi-agent-dispatch-smoke-20260526h/{alpha,bravo,charlie,delta,echo}.txt` leased across five distinct runtimes and produced the expected files in the shared origin workspace.
- 2026-05-26 overlapping-write Studio smoke: a same-file write request stayed coordination-required/single-agent, created zero `multi_agent_plan` worker jobs, and did not create the target file.
- 2026-05-27 implementation checkpoint: the dedicated preparation action was removed from the controller/runtime contract. The lead now prepares any needed inputs through ordinary workspace/tool work, chooses shared workspace paths such as `handoff/<task>/` or `sources/<label>/`, declares them in `multi_agent_plan.handoffPaths`, and passes exact paths/globs to worker prompts and `writeScope.readOnlyPaths`.
- 2026-05-27 follow-up checkpoint: controller `multi_agent_plan` dispatch now carries only generic handoff path metadata from the skill-authored plan. Workers/final jobs cite source roots/locators because the lead put them in ordinary prompts/scopes, not because the controller inferred source workflow semantics.
- 2026-05-27 shared-FS contract correction: the preferred handoff is skill-driven shared workspace preparation, followed by a `multi_agent_plan` that passes exact paths/scopes. Small internal handoff files use the ordinary `files` contract; larger external prep uses runtime tools before the plan. There is no product-special preparation workflow in this slice.
- 2026-05-31 parent-dispatch hardening: a live Team plan parent job can be marked completed immediately after sibling dispatch and publish the same `run.completed` event shape as normal agent completion. This prevents a leased parent planning job from being re-leased later and duplicating the Team plan if the runtime disappears before `/agent/complete`.
- 2026-05-31 read-only spread smoke: a compact two-lane read-only Team plan over `AGENTS.md` completed without a stale root-agent "Thinking" state; sibling lanes leased on distinct runtime ids when spread capacity was available.
- 2026-05-31 disjoint-write spread smoke: a real-composer `write_scoped` plan with `@alpha`, `@beta`, and `@gamma` wrote three distinct files under `multi-agent-smoke/write-final-20260531a/` across three runtime ids, with each worker constrained to exactly one owned path.
- 2026-05-31 overlapping-write smoke: the system remained safe and did not race same-file writes, but the live agent still sometimes used a noisy coordination Team card. The collaboration skill and runtime planning reminder now state that overlapping same-path writes override the explicit-team threshold and should be answered as coordination-required before emitting a Team plan.
- 2026-05-31 Studio observability checkpoint: the compact Team chip now exposes runtime spread in its tooltip and accessibility label, and expanded worker evidence rows show each lane's runtime id, queue wait, and lease attempts. These metrics stay out of the default visible chip row to avoid adding attention noise to ordinary chat.
- 2026-05-31 lead-continuation checkpoint: lead synthesis prompts now include generic sibling lease metadata (`runtimeId`, `queueWaitMs`, `leaseAttempts`, `queuedAt`, `leasedAt`) as operational scheduling context, so a lead can answer whether a run appears spread across runtimes when the user asks.
- 2026-05-31 shared handoff smoke: a real-composer `dao-xyz/borsh-ts` review prepared one visible workspace checkout under `handoff/handoff-borsh-20260531g/repo`, emitted a two-lane read-only Team plan, passed exact `handoffPaths`/`writeScope.readOnlyPaths` to both workers, and leased the workers on two runtimes (`45a435a3...` and `c1d46c7e...`). No `.instafy/source-prep` contract was involved. The final synthesis produced the expected bigint/finalizer findings, but the lead did not explicitly restate runtime spread despite the prompt asking for it; the collaboration skill now tells leads to preserve user-requested reporting fields in the checkpoint prompt and final answer.
- 2026-05-31 command-status checkpoint: compact command labels now recognize common work embedded inside short shell scripts, such as `git clone` inside a setup script, so public-repo prep can show `Cloning source repo...` instead of only `Running command...`.
- 2026-05-31 cross-chat recovery cleanup: a fresh new-chat follow-up asking which prior borsh-ts lane found the bigint issue stayed single-agent, recovered `@correctness-audit`, linked the concrete `handoff/handoff-borsh-20260531g/repo/packages/borsh/src/bigint.ts:15` evidence, and did not leak raw `/bin/bash`, `.codex-runtime*`, or `Recovered assistant message` text. When older recovered messages do not contain persisted lease spread, the runtime answer now says runtime spread is unavailable instead of inventing it.
- 2026-05-31 command-status cleanup: nested shell/Python context-recovery commands that mention raw runtime session paths are summarized as prior-context work in the compact rail, and final summaries containing those raw traces are treated as unhelpful and replaced by controller conversation/context evidence when possible.

## Next Gaps

- Add wall-clock duration, tool count, and direct trace/message deep links to the same Team/worker inspection path once the trace URL contract is stable.
- Add more live coverage for shared-workspace handoff beyond the verified public-repo clone-once path: multiple source locators, generated handoff files, and cleanup/no-cleanup decisions owned by the lead agent.
- Persist or derive runtime spread into durable conversation evidence consistently enough that future cross-chat recovery can answer "one runtime or multiple runtimes?" for older team runs without relying on the lead's prose.
- Add a deterministic UI lab for delayed/failing fake agents so manual QA can inspect queued, running, failed, and completed states without spending model credits.
- Add runtime-agent telemetry that reports per-job wall time, tool count, and whether hidden Codex subagents were used inside the turn.
- Add full integration coverage where a live lead emits `multi_agent_plan`, siblings save context cards, receives a lead continuation checkpoint, and a follow-up uses saved context without hard-coded domain routing.
- Add automated e2e coverage for Team plan evidence row deep links into worker job traces and exact messages.
- Add fake-agent UX fixtures for `presentation.workerEvidenceVisibility` modes so skills can steer attention without domain-specific UI.
