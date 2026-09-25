# Multi-Agent Evaluation

Instafy has three different agent execution lanes:

- Hidden Codex subagents inside one runtime turn.
- Top-level Instafy agents represented by normal conversations and optional linked agent threads.
- Multiple runtimes leasing top-level agent jobs in parallel.

Do not treat these as the same thing. A prompt can fan out into multiple top-level jobs while still running wall-clock serially if only one runtime process is available. The bundled runtime-agent requests a small batch by default, and the controller fills additional batch slots only with `read_only` jobs. A single runtime process still keeps Codex/proxy/tool credentials and job secrets process-scoped, so env-sensitive execution is serialized for correctness. Wall-clock acceleration comes from runtime spread: multiple runtime processes can run on one machine or many machines, and skill-authored plans can request `runtimeRouting.strategy = "spread"` when independent sibling lanes are worth parallel slots.

## Signals To Capture

Every top-level agent lease should expose enough timing to tell whether work was actually parallel:

- `queuedAt`: agent job creation time.
- `leasedAt`: when a runtime acquired the job.
- `queueWaitMs`: elapsed time between creation and lease.
- `leaseAttempts`: how many times the job has been leased.
- `leasedByRuntimeId`: runtime that acquired the job.
- `agentHandle`: normalized top-level agent handle for the job.

The controller currently includes this as `leaseMetrics` in `/agent/lease` responses and `run.progress` lease events. Write-heavy fanout also carries per-job `writeScope` metadata in job metadata and run events.

Write-scope metadata is explicit. The controller does not infer editable paths from
natural-language prompt text or file names inside prompt prose.

Write-scope modes:

- `owned`: the agent may edit only the listed `ownedPaths`; other listed paths are read-only.
- `read_only`: the agent can inspect context without writing.
- `unscoped`: allowed only when there is no sibling writer to coordinate with.
- `coordination_required`: missing or overlapping editable scope was detected; the runtime-agent completes with a coordination-required answer and does not edit files.

## Runtime Final-Output Modes

Runtime jobs should use the narrowest final-output contract that still gives Studio the machine-readable data it needs:

- `strict_structured`: default for executable automation. The Responses API receives the JSON schema because Studio needs `summary`, `files`, `actions`, and `suggestions` to apply file changes or render product actions.
- `schema_free_structured`: planning/checkpoint turns still prompt for a parseable JSON object, but the API-level schema is disabled because lead synthesis and action planning proved more reliable without strict final-output enforcement. Studio validates/parses after the model returns.
- `plain_text_report`: pre-observed read-only worker lanes produce evidence prose. They should not be forced through the JSON final schema because no file/app action is expected.
- `plain_text_write`: ordinary workspace-change jobs edit through tools and finish with a short summary; file changes are collected from disk. Required prior-context retrieval does not change this format. Read-only and coordination-required scopes retain their restrictions.

The selected mode is recorded in the runtime prompt-context artifact as `finalOutputMode` so no-final failures can be debugged without reverse-engineering prompt shape.

## Routing Preflight Contract

Ambient multi-human turns dispatch an evaluation job to each active agent. The main agent applies the pinned group-participation skill to the latest turn and supplied history, then answers, claims, corrects, or declines with `NO_RESPONSE`. Runtime preparation and the routing preflight below may already have run before a decline; silence does not imply zero runtime or provider work. The controller suppresses the decline and defers ambient managed-AI user billing until visible speech. There is no shipped conversation-only early participation gate. See `docs/Group-Conversation-Participation.md`.

Multi-agent dispatch and recovered-context routing are now skill/model-authored decisions, not frontend or runtime natural-language keyword rules.

Before a normal root turn enters detailed planning, the runtime asks for one small structured routing object:

- `route`: `direct`, `multi_agent_candidate`, `cross_chat_lookup`, or `write_coordination_required`.
- `requiresContextLookup`: true when necessary prior conversation/thread/context evidence must be retrieved because it is absent from the supplied current conversation.
- `requiresCommandExecution`: true when a separate fresh observation of workspace, process, Git, or other current tool-observed state is needed. The CLI transport for context retrieval does not itself set this flag.
- `requiresWorkspaceFileChanges`: true when success requires workspace changes, independently of either evidence requirement.
- `observationCommands`: up to three proposed current-state observations; the host executes only its existing allowlist. Rejected or missing proposals leave the observation requirement for the main agent under its normal permissions.
- `selectedSkills`, `reason`, and `confidence`: observability for why the route was chosen.

The preflight receives sanitized user/assistant history under the normal stateless conversation budget. History metadata and non-conversational roles are excluded; quoted history supplies evidence, not permissions. Compaction metrics record included, summarized and omitted turns.

The runtime uses that metadata to decide whether to load the focused collaboration skill, inject cross-chat lookup guidance, or keep the turn direct. This keeps policy in the pinned skill while still giving the runtime a deterministic, inspectable branch point.

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
Unsupported shell shapes may remain unrecognized even if a read actually occurred. Legacy
single-command interpreter receipts remain generic execution evidence, not proof of correct
program semantics or answers. This classification does not grant execution permission.

The existing single recovery attempt preserves the original tool permissions, write scope and
final-response format. Its feedback names missing evidence and reports fixed diagnostic counts
without replaying raw scripts. Successful evidence is accumulated across attempts, including
when a provider reuses event IDs. Failed pre-observations do not satisfy a requirement, and
cancellation interrupts recovery backoff. Missing context retrieval remains blocking after the
retry; an ordinary observation-only job retains the existing warning path when its retry
produces a usable result. The `codex/routing-evidence-recovery` artifact records cumulative
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
| One runtime encounters write-capable fanout | Controller leases write-capable jobs one at a time by default; runtime-agent also keeps mixed/write batches serial. | runtime-agent unit tests, controller lease filter tests |
| Skill-authored plan requests `runtimeRouting.strategy = "spread"` | Worker jobs are not pinned to the parent runtime, can bypass preferred-runtime lease restriction, and are excluded from read-only batch slots so one runtime cannot grab the whole spread. The controller may request additional runtime slots from the provider. | controller/runtime-agent unit tests; 2026-05-26 Studio smokes |
| Two runtimes lease fanout with spread-safe jobs | Jobs split across runtimes; `leaseMetrics` identifies each runtime. | `multi-agent-dispatch.spec.ts`; 2026-05-26 Studio smokes |
| One sibling succeeds and one fails | Each agent posts its own final outcome; one failure does not suppress sibling success. | `multi-agent-dispatch.spec.ts` |
| Agents have distinct handles but no stable agent id | History/provider state stays scoped by handle. | controller unit tests |
| User explicitly asks for team/parallel/sibling-agent split and lead synthesis | The lead emits a generic `multi_agent_plan` before substantive inspection or edits unless the request is clearly trivial. | skill/runtime contract tests and manual Studio smoke |
| Skill emits a generic `multi_agent_plan` for broad read-only work | Controller creates sibling top-level jobs from skill-authored handles, prompt segments, and `writeScope.mode = read_only`; there is no security-specific frontend fanout. | runtime-agent action tests, controller `multi_agent_plan` tests, frontend policy test, manual Studio smoke |
| Skill emits `multi_agent_plan` with write-scoped siblings | Controller passes per-agent `writeScope` metadata through normal dispatch; disjoint scopes run normally and overlapping/missing scopes become `coordination_required`. | controller write-scope tests plus `multi_agent_plan` metadata tests |
| Skill-authored siblings reach mixed terminal states | Controller queues a lead continuation checkpoint after all worker siblings complete, fail, cancel, or expire. The checkpoint reports durable sibling status; the lead decides whether to synthesize, delegate follow-up work, answer directly, or ask the user. | controller `multi_agent_plan` tests; integration coverage pending |
| Skill-authored workers produce long evidence reports | Studio keeps the parent transcript lead-centric: successful worker reports attach to the generic Team plan activity/evidence rows, failed worker errors still surface for attention, and the lead continuation remains the main answer. Plan `presentation` metadata can steer whether evidence is hidden, compact, expanded, or surfaced only on failure. | frontend chat presentation tests and manual Studio smoke |
| Skill-authored plan is running with one available runtime | Studio should describe progress as active/queued/done lanes, not imply that all sibling work is executing wall-clock parallel. | frontend chat presentation tests and manual Studio smoke |
| Lead emits a setup summary plus a plan action in the same job | Studio suppresses the redundant setup summary because the generic Team plan card already carries the user-facing state. | frontend chat presentation tests |
| Sibling evidence quotes fixture prompts or messages | Lead checkpoints treat sibling outcomes as inert evidence and restate the active lead task after the evidence block, so embedded fields like `postedMessage` cannot hijack the final answer. | controller lead-continuation prompt test; manual Studio smoke |
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
