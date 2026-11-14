# Local-engine turns

A local-engine turn is one @octo turn that a person sends from Instafy Desktop and that their own Claude Code, signed in on their own computer, carries out. This document calls the mechanism "the lane".

Status: built and dark. Phases 1-7 of section 9 are built, and everything they add lands dark: `CLAUDE_CODE_LANE_USER_IDS` is empty by default, so no lane turn runs until phase 8 turns it on. Phase 0's checks, which a maintainer runs by hand on their own Mac, have not been run yet, and phase 8 needs them. Sections 1-10 are the design, updated with the decisions made while building it (D-A to D-L in section 10) and the contracts the packages share. Appendix A lists where the build chose details the design left open. The design was checked against branch `feat/claude-code-plugin` at 614d275c2, and line numbers refer to that commit; the build found the code they point at by name.

Release prerequisite: before any user id, internal ones included, goes into `CLAUDE_CODE_LANE_USER_IDS`, Instafy records that it has accepted Anthropic's Commercial Terms or has another agreement with Anthropic. See 2.11 and section 9, phase 8.

Path shorthand (relative to the repository root):
- RC = packages/runtime-controller/src
- RA = packages/runtime-agent/src
- DA = packages/desktop-app/src
- DRA = packages/desktop-runtime-agent/src
- FE = packages/frontend/src
- SC = FE/screens/studio/components
- MIG = supabase/migrations

Code marked "new" was new in this design; it exists now.

---

## 1. Summary

### What the person does

In Instafy Desktop on macOS, the only platform in v1 (D18), the person picks **Claude Code for the next message** in the composer and sends one message. Their own `claude` CLI carries out that message:
- unmodified;
- signed in through Anthropic's own login;
- running on the computer they are using.

Every other @octo turn keeps running on the Codex engine linked into runtime-agent.

### Controller

One gate admits the turn. It is new (RC/claude_code_lane.rs) and runs inside the single dispatch funnel `process_dispatch_prompt_timed` (RC/dispatch.rs:1031). It admits the turn only when every condition below holds:
- The person's own signed-in session sent the message now, and it carries no mark of anything Instafy wrote, queued, resent or delegated (1.2 covers what the gate cannot see).
- The message is a plain one to the sender's own @octo. It has no attachments and no `/` command.
- The message names a private self-hosted runtime that the sender owns (in v1, their Desktop; the controller cannot tell, see 2.10). That runtime is dispatch-ready and idle, and carries a `claudeCode` capability that the controller attested.
- The person has no other Claude Code turn running or waiting to start.
- The rollout switch `CLAUDE_CODE_LANE_USER_IDS` covers the sender.

The admitted job is stamped `agent_jobs.engine = 'claude-code'`. A CHECK constraint makes the forbidden job shapes impossible to insert, and a partial unique index allows one active lane turn per person.

The job:
- is leased once, within 60 s, and only by its runtime;
- carries no proxy envelope, model-facing controller token, project secrets, device grants or conversation history;
- costs no Instafy credits.

### Runtime agent

runtime-agent branches off before it fetches secrets or installs the proxy environment. It checks the job a second time, then starts the `claude` binary that Desktop handed it as a protected launch value:
- `claude -p` with stream-json output, `acceptEdits`, permission prompts off, user-scope settings only, and an empty, strict set of MCP servers;
- in the space's folder;
- with an environment built from an allowlist that was snapshotted at startup;
- with the person's recorded message on stdin, byte for byte.

It also:
- maps Claude Code's events onto the existing steps, reply draft and reply;
- ends the turn at a top-level `result` that arrives with no background task running other than a command, a Monitor watch or an `ambient` task, then stops `claude` and kills every process its tracker has seen (3.6); one that escapes the tracker survives (1.2);
- saves the turn's git delta, minus `.claude/`, through the existing checkpoint.

### Traffic and credentials

Only Claude Code's own traffic bypasses the Instafy proxy, under the sign-in the person made in it. It goes to Anthropic, or to a cloud provider or gateway the person set up in Claude Code (3.2). This is a written exception to the proxy rule (section 7). Instafy:
- never reads, stores, refreshes, forwards or proxies that sign-in;
- sets no `ANTHROPIC_*` or `CLAUDE_*` variable but the person's own `CLAUDE_CONFIG_DIR` (D26).

The controller refuses Claude sign-in material in stored credentials and project secrets (section 6). Anthropic API keys keep working as today (D23, decided).

### Nothing retries, queues or moves a lane job

No path retries, queues, schedules, fans out, moves or resumes a lane job by itself. Each path that could do so refuses or fails it (2.9). runtime-agent starts `claude -p` at most once per job.

### Wording

Lane surfaces say "Runs on your own Claude plan, under Anthropic's current terms." only when Claude Code reports a Claude plan sign-in. Otherwise, and before any probe, they say the turn runs under the person's own Claude Code sign-in (3.2). They never say "included" or "free".

### 1.1 Where each policy limit holds

| Limit | Where it holds |
|---|---|
| Claude Code works on the person's own request. No Instafy system prompt. | The runtime never passes a system-prompt flag (3.3). The prompt is the recorded message alone (3.5). The controller never adds the evaluation preamble or splits the text into segments for a lane job (2.3). Under `--setting-sources user`, project memory does not load: the space's CLAUDE.md, and the `AGENTS.md` and `INSTAFY.md` it imports, reach the turn only as files Claude Code chooses to open (3.3, 7.5). Phase 0 item 2 confirms this on the floor version and gates phase 8 (9). |
| No turn whose text Instafy wrote: evaluations, plans, automations, hand-backs, goal wake-ups, queued or automatic resends | The gate requires a person trigger and refuses all of these: delegation, a queue entry, a goal wake-up, a hand-back, a site ask, an automatic retry, a system turn, `dispatchContent`, special-dispatch metadata, a thread kind, and a message recorded earlier (2.2). The CHECK forbids plan roles (2.1). The runtime refuses such jobs too (3.9). |
| One turn the person starts, in the foreground | Lease once, within 60 s (2.4). A busy computer or chat is refused at send and never queued (2.2). One active lane turn per person (2.1). No retry, replay, requeue or move (2.9). The runtime's end-of-turn rule and process cleanup (3.6). |
| Only the person who owns the Claude login, on their own runtime | Runtime owner = sender (G6). The lease clause checks the same (2.4). Desktop grants the lane to one consenting Instafy user, and the runtime checks the job against that user (3.9, 4.3). |
| Instafy never stores, forwards or proxies Claude tokens, and neither Instafy nor a teammate sets `ANTHROPIC_BASE_URL` | The job has no envelope and no secrets (2.5). The child's environment is an allowlist (3.4). The credential guard (6). Project-scoped Claude settings stay out (3.3, 3.9). |
| The binary is never modified, and its sign-in methods are not restricted | Desktop and runtime only validate a path and run it (3.2, 4.1). `--bare` is never passed. Any authentication the person configured in Claude Code's own user settings still applies; a sign-in kept only in shell variables does not reach the turn (3.4). |
| A teammate's files cannot make the person's Claude Code run their code or leak private files | Partly. The pre-flight keeps project settings, hooks, MCP servers and out-of-folder imports out, and lane saves leave out `.claude/` (3.8). A teammate's words in a file Claude Code reads can still steer it within what it allows: it can copy untracked files such as `.env` into a reply or a saved file, which needs no allow rule, and run repository code through the person's own allow rules and hooks (1.2, 3.9). |

The rows above say where each limit holds. 1.2 lists the paths around limits 1-4 and 7 that remain, and how v1 treats them.

### 1.2 What the design cannot prove

- **Who typed the message.** `metadata.input.kind = "person"` is a client claim (RC/job_trigger.rs:117-131).
  - The controller proves only two things: the request came from the person's own user session, and it came from none of Instafy's internal paths.
  - Any software holding that session could make the claim, including the person's scripts, Claude Code using their `instafy login` session, and Codex on the same computer (below).
  - While a lane turn runs, the one-turn fences refuse another, and no lane turn waits in a queue behind it; an ordinary message may still queue and runs on Codex afterwards (2.8, D9).
  - After a lane turn ends, a process it left behind or set up, such as a helper that escaped it or a launchd or cron entry, can post a lane-claimed message with the person's saved `instafy login` session. The gate admits it as theirs: a lane turn nobody typed (D9).
- **Whose Claude login it is.** Instafy cannot tell which Claude account is signed in under the OS account. The person's consent on Desktop, given per Instafy user, is their statement that the login is theirs (4.5).
- **Which client sent it.** The controller does not verify that the send came from Desktop. Offering the choice only in Desktop is a UX limit (D19).
- **A teammate's words in the folder.** A teammate's words in a file Claude Code reads, such as `AGENTS.md`, a README or a code comment, can steer the person's Claude Code within what it allows (3.9). Steered that way, it can put the person's untracked files in the folder, such as `.env`, into a reply everyone in the space reads or into a file the save publishes, and run repository code through the person's own allow rules or hooks. It can also write the person's auto memory for this folder (under `~/.claude/projects/`), which Claude Code documents as loading at the start of every session whatever the setting sources are, so a teammate's words can outlast the turn and reach the person's later lane turns and their own terminal sessions there (Phase 0 item 14).
- **Codex on the same computer.** Codex turns on the person's computer run with full access as their OS user (RA/codex.rs:13630-13632), unattended ones included: automations and goal wake-ups dispatch as the person's own jobs (RC/automations.rs:966-1017; RC/conversation_goals/mod.rs:367-372), and plan workers can run on their parent's runtime (RC/multi_agent_plan.rs:230-233). Such a turn can start the person's signed-in `claude` itself, with text Instafy wrote, in any form D22's exec-policy rule does not refuse (D22 lists them), or post a lane-claimed message with their saved `instafy login` session, which the gate admits once the target computer is idle (G7, D22).
- **Processes that escape on macOS.** Descendants are tracked by parent links every 50 ms, as the isolated worker polls (RA/isolated_tool_worker.rs:390, 406-407).
  - A process that double-forks out between two observations, such as a background command whose shell returns at once, escapes, because macOS has no subreaper (RA/isolated_tool_worker/process_tree.rs:10-19).
  - It keeps running after the turn, with the person's own privileges and nothing more (D27). When runtime-agent itself dies (a crash, or SIGKILL from Desktop's stop escalation), its ProcessTree dies with it. Desktop's group kill (3.6) reaches only processes still in the group, so every descendant that called setsid or setpgid survives, not only a double fork.
- **Unverified Claude Code behaviour.** Flags and stream-json fields marked unverified are handled in three ways:
  - The version floor, 2.1.314, is the evidence that the documented flags exist, and a flag Claude Code does not know fails at startup, before the run. `--help` is read only for the bare-mode wording (3.2). A missing `init` field fails the turn (3.6).
  - Phase 0 and the live suite confirm what they do, on the versions they ran (sections 8 and 9). Any newer version also runs, unconfirmed: `verified: false` only adds a sentence to one failure message (2.10, 5.5).
  - Checks of the `init` event detect a flag that did not take effect, but they run after Claude Code has started. The pre-flight in 3.9 prevents that case by construction only for the project configuration it refuses. Project memory, such as the CLAUDE.md and `AGENTS.md` that Instafy seeds into every space (7.5), and untracked files below the folder's root are kept out only by the flags (3.9).

Decided by the owner on 2026-11-13 (D9, D22, D29):
- v1 is for messages a person types.
- A lane turn that an agent, an automation or a script starts is a later feature, not a v1 risk to sign off. It will be offered only when Claude Code is signed in with an API key or through a cloud provider (`planSignIn: false`, 2.10), because Anthropic's terms do not let a product route automated requests through a person's Claude plan.
- v1 builds no per-send proof, so the claimed sends above that the person did not type still get through. The owner accepted that with this decision, in place of the written sign-off that earlier drafts asked for.
- Codex on the person's computer must not start `claude`. What holds today is D22's exec-policy rule, which phase 8 requires and which has shipped. It refuses `claude` in any letter case, by name or by absolute path, as a command of its own or as a plain command of a shell script Codex can split. It does not refuse a direct launch that Codex checks as one shell command: a script with a redirection (`claude -p … 2>&1 | tail -n 80`), a substitution, a heredoc, a variable set before the name, a quoted name, or a word with a glob, `~` or `$` (`~/.local/bin/claude`, `$HOME/.local/bin/claude`). Nor does it refuse a `bash -c 'claude …'` nested in a script, or text a turn writes into a terminal session it opened. Closing those is a further phase 8 gate, before any user id goes into the switch. The indirect launches D22 names, the starts Codex's own configuration makes included, are the gap the owner accepted.
- A teammate's words steering the person's Claude Code within its own settings is how Claude Code behaves in any folder that others write to. It is documented, not gated: the consent dialog states it, and that everyone in the space reads the reply, in plain words (4.2).

Three options would narrow these risks: offering the lane only in spaces where only the sender can write, a per-send proof minted by Desktop's main process, and setting `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for lane turns, which keeps a steered turn out of the person's auto memory but also hides their own notes from it.

---

## 2. Controller

### 2.1 How a lane turn is marked

| Marker | Writer | Notes |
|---|---|---|
| Client claim `metadata.turnEngine: "claude-code"` | Studio, on `POST /conversations/:id/messages` (RC/conversations.rs:511-514, handler at 2835) | `claude_code_lane::take_claim` takes it and removes it beside the other claims (RC/dispatch.rs:1038-1077). It does this for every caller, the service role included; the existing `agent` strip skips the service role (1069-1077), and this one must not. It reads both spellings, `turnEngine` and `turn_engine`. Any other value, null included, is a 400 `claude_code_turn_engine_unknown` (D-G). The claim is never persisted. |
| Controller stamps `metadata.claudeCode: {"version": 1}`, `aiAccessMode: "claude-code"` and `managedAiUsed: false` | Admission only | Written to: run metadata (`insert_run_record` 1884-1893; `persist_run_ai_access_metadata` 2445-2451); the person's message (1895-1923); the job payload (RC/agent.rs:6322-6326); the reply, through `stamp_ai_access_mode_from_job_payload` (6369-6388), whose allowed set (6377) gains `"claude-code"`. A client-sent `claudeCode` is stripped at intake. It, the `turnEngine` claim and `claudeCodeFailure` are also stripped from recorded messages in `sanitize_client_recorded_message_metadata` (RC/conversations.rs:1284-1321), before that function's service-role early return at 1292. After that return, a message a member records, through `/messages/record` or a steer's send intent, which uses the same function, also loses the kind `claude_code_machine_stopped`, with `source`, `messageType` and `agent`, as it loses `runtime_alert`, `run_cancellation` and `change_undone`: only the controller writes a stopped turn's end (2.9). The service role keeps that kind, but never the stamp. |
| Column `agent_jobs.engine` | `enqueue_agent_job_record` only (RC/agent.rs:4728-4813), from the admission result | Every lease, sweep, refusal and loader reads the column, never payload metadata. Client metadata rides into queue entries and resends; a column cannot. |

The other ways to mark a lane job each fail:
- **A credential-less job.** "No credential and an AI intent" already means Instafy AI wherever the code checks for it: RC/dispatch.rs:2105-2108; RC/agent.rs:1200-1203 and 4926-4930; RC/runtime/limit_waits.rs:368-375; RC/upstream_pacing.rs:52-54.
- **A token-free credential row.** The kind CHECK and the NOT NULL ciphertext columns forbid it (MIG/20260000000012_user_credentials.sql:6).
- **`user_agents.provider`.** It is a per-agent setting, so it would reach automations, plans and evaluations. Unknown values also normalize to `openai` (RC/ai_agents.rs:278-291).

**Migrations.** These follow supabase/MIGRATIONS.md:
- Timestamps must be newer than every migration on `main` and end in an even digit (MIGRATIONS.md:6-8). The files below have the timestamps they landed with.
- Each file locks only `agent_jobs` (91-104).
- Validation runs in a migration of its own, so its scan holds SHARE UPDATE EXCLUSIVE rather than the first file's ACCESS EXCLUSIVE, as MIG/20261028140002 does for a CHECK (MIGRATIONS.md 129-134 states the same rule for foreign keys).
- The precedents are MIG/20261028140008_agent_device_grants.sql:46-55, MIG/20261028140002 and MIG/20261025145800.

```sql
-- supabase/migrations/20261113113600_agent_jobs_engine.sql
-- engine: what runs the job's turn when it is not the runtime's embedded engine.
-- Only dispatch writes it (claude_code_lane.rs), once, when it queues the job,
-- and never from a request body. Null: the runtime's embedded engine, as for
-- every job queued before this column. 'claude-code': its person's own signed-in
-- Claude Code on their own computer, for one turn they started
-- (docs/Local-Engine-Turns.md). Such a job holds no Instafy credential, no device
-- grant and no plan role, and records when its person sent it.
--
-- Its own file because it holds ACCESS EXCLUSIVE on agent_jobs (MIGRATIONS.md).
-- The column has no default, so nothing is rewritten, and the check is NOT VALID,
-- so nothing is scanned under that lock; the next migration validates it.
set local lock_timeout = '5s';

alter table public.agent_jobs
  add column engine text,
  add constraint agent_jobs_engine_check check (
    engine is null
    or (
      engine = 'claude-code'
      and credential_id is null
      and grant_ids is null
      and parent_job_id is null
      and plan_group_id is null
      and agent_role is null
      and trigger_received_at is not null
    )
  ) not valid;
```

```sql
-- supabase/migrations/20261113113602_validate_agent_jobs_engine_check.sql
-- Checks the rows that existed before 20261113113600 against the check it added
-- NOT VALID. Its own file because VALIDATE CONSTRAINT scans agent_jobs under
-- SHARE UPDATE EXCLUSIVE, which blocks no live read or write. Every earlier row
-- has a null engine.
set local lock_timeout = '5s';

alter table public.agent_jobs
  validate constraint agent_jobs_engine_check;
```

```sql
-- supabase/migrations/20261113113604_agent_jobs_one_active_claude_code_turn_idx.sql
-- At most one Claude Code turn per person that is running or may still start,
-- across all spaces: a running turn cannot start another through its person's
-- own session, and two concurrent sends cannot both be admitted. A queued turn
-- whose lease ended (lease_attempts > 0) can never start again and is left out.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261025145800_agent_jobs_early_checkpoint_recovery_idx.sql did.
set local lock_timeout = '5s';

create unique index agent_jobs_one_active_claude_code_turn_idx
  on public.agent_jobs ((payload ->> 'user_id'))
  where engine = 'claude-code'
    and (status = 'leased' or (status = 'queued' and lease_attempts = 0));
```

```sql
-- supabase/migrations/20261113212156_agent_jobs_stopped_claude_code_turn_recovery_idx.sql
-- The idle sweep finishes a local-engine turn (docs/Local-Engine-Turns.md) whose
-- runtime stop failed its job but whose own end was never written: it reads
-- only failed engine jobs that ended recently, oldest first. Ordinary jobs have
-- a null engine and are not in this index.
-- Its own file: the build holds SHARE on agent_jobs alone, as
-- 20261112084100_agent_jobs_lost_final_checkpoint_recovery_idx.sql did.
set local lock_timeout = '5s';

create index agent_jobs_stopped_claude_code_turn_recovery_idx
  on public.agent_jobs (completed_at, id)
  where engine is not null
    and status = 'failed';
```

Notes:
- `target_runtime_id` is deliberately left out of the CHECK. Its foreign key is `on delete set null` (MIG/20260000000017_agent_runtime_preferences.sql:27), so including it would make runtime deletes fail. The lease clause (2.4) enforces the pin instead.
- The insert always satisfies the CHECK, for these reasons:
  - Dispatch passes `credential_id = None` for lane jobs (2.3).
  - `grant_ids` is written through `nullif(..., '{}')`.
  - `trigger_received_at` is `coalesce($15, now())` (RC/agent.rs:4784).
  - The hierarchy columns come from plan metadata, which a lane payload never has.
- `payload.user_id` comes only from the request context (RC/agent.rs:6267-6272).

### 2.2 The dispatch gate

Every job-creating path goes through `process_dispatch_prompt_timed` (RC/dispatch.rs:1031). That covers HTTP sends, queue drains (RC/send_queue.rs:1395-1415), automations (RC/automations.rs:966-1019), goal wake-ups, hand-backs and plan workers.

The gate has two stages, both before `insert_prompt_record` (RC/dispatch.rs:1882). A refusal therefore writes no prompt, run, message or job, and burns no credit. Every refusal the lane adds, in the gate or elsewhere in dispatch (below), is a 4xx with a `claude_code_*` code and a `details.reason`. The one exception is the busy chat's existing 409 `dispatch_lane_busy` (below), which keeps its code, and its details carry no `reason` (RC/dispatch.rs:1435-1445). Studio words it for a lane send as a busy chat, not a busy computer (5.5), since the job or queued send that makes @octo busy there can be anyone's, on any runtime. The gate never falls back to another engine.

**Stage 1: the sender.** `claude_code_lane::check_sender` runs directly after the claim strips (RC/dispatch.rs:1077). For a claimed send:

- **G1. The lane is on for the sender.** `config.claude_code_lane.allow(sender)` must hold. `CLAUDE_CODE_LANE_USER_IDS` is parsed exactly like `DeviceGrantUsers` (RC/config.rs:1105-1154): unset or empty means nobody, `*` means everyone, otherwise a list of ids. A malformed value means nobody.
- **G2. The person's own session sent it, now, to a conversation that already existed.**
  - `request.trigger` is `Some`, with `trigger.user_id == context.user_id`, `trigger.kind == Some(Person)` and `trigger.received_at == None`. Only authenticated ingress sets a trigger: `POST /conversations/:id/messages` (RC/conversations.rs:2944-2945), `POST /projects/:id/conversations` (810-811) and `POST /dispatch-prompt` (RC/dispatch.rs:980). Queue drains also set `received_at` (RC/send_queue.rs:1402-1411). `normalize_dispatch_request` defaults the trigger to `None` (RC/dispatch.rs:3378), and automations (RC/automations.rs:1017), goal wake-ups, hand-backs and plan workers keep that default.
  - `request.delegating_job_id` is `None`. A job token's send sets it (RC/conversations.rs:2941). Inside dispatch, a job token appears as its subject's context, whose `scoped_claims` is `None` (RC/active_job_auth.rs:53-58, used at RC/conversations.rs:2876-2879 and 2953). So `scoped_claims` and `require_user_session` are not fences here. The trigger and `delegating_job_id` are. The trigger is computed from the caller's own credential (2942-2945).
  - `!context.is_service_role`, and `!request.conversation_is_new`, checked here and again in Stage 2. Here the flag is still false for a `POST /dispatch-prompt` send that names a new conversation id, because that route sets it only when no `conversationId` is given (RC/dispatch.rs:999-1004). `ensure_conversation_record` sets it when it inserts the conversation (RC/conversations.rs:3464, called at RC/dispatch.rs:1212-1214). Stage 2 runs in the same uncommitted transaction (RC/dispatch.rs:1169-1172), so its refusal also rolls back that insert.
  - RC/job_trigger.rs:95 becomes `kinded = !resent && (config.device_grants.allow(user_id) || config.claude_code_lane.allow(user_id))`. Its only other effect for lane users is that their messages get the `metadata.trigger` stamp (`stamp_message`, RC/job_trigger.rs:33-45). Device grants still check `device_grants.allow` themselves (RC/device_grants.rs:224).
- **G3. Nothing Instafy wrote, queued or resent.** All of the following must be absent or false:
  - `dispatch_queue_entry_id`, `goal_wakeup`, `goal_parent_job_id`, `allow_silent_automation_decline`, `allow_internal_review` (RC/dispatch.rs:223-239);
  - the site-intent, hand-back and automatic-retry claims (1055-1063);
  - `retryOfMessageId` and `goalContinuation` (RC/job_trigger.rs:18-22);
  - `dispatchContent`, which is what the app dispatches in place of the text it shows, for example "Continue this browser task."; and `displayContent`, `display_content`, `composerMessage` and `composer_message`, which Studio shows in place of the stored text (FE/conversations/conversationMessageUtils.ts:977-984), so everyone sees the words Claude Code ran;
  - every key `metadata_marks_special_dispatch` reads (RC/dispatch.rs:3863-3900), any `controllerDispatch`, and `spaceReview`;
  - a request `thread_kind`.

Stage 1 also changes how the rest of dispatch treats a claimed send:
- **Granted chat.** Where device grants name the conversation for someone else, dispatch records the message and starts nothing (`starts_agent_turns`, RC/dispatch.rs:1321-1361). For a claimed send, that branch answers 409 `claude_code_conversation_granted` before it records anything, so the send is not recorded as a message that started nothing.
- **Busy chat.** `request.expected_lane_idle = true`, so the busy check (RC/dispatch.rs:1367-1448) answers 409 `dispatch_lane_busy` when this chat's @octo is busy. `post_conversation_message` must not turn that 409 into a queue entry for a claimed send: RC/conversations.rs:2955-2981 gains `&& !claimed`. `claimed` is read from `body.metadata.turnEngine` before the body is serialized for the queue (2911-2920), because the handler never sees the claim dispatch takes.
- **Goals.** Goal binding (`bind_dispatch`, RC/dispatch.rs:1510) returns without binding, so a lane turn never becomes a goal source.
- **Ambient participation.** The ambient gate treats the claim like a strict browser target (`strict_browser_target`, RC/dispatch.rs:1531). A lane send is never turned into an evaluation and never gets the preamble (RC/agent.rs:6302-6314).
- **Worker input.** Routing a message to a worker as its answer is off: `should_route_worker_input` (RC/dispatch.rs:1927-1933) is passed strict = true.
- **Runtime record.** The runtime row is loaded `for share` and checked early, the way `ensure_personal_browser_runtime_dispatchable` is (RC/dispatch.rs:1187-1210). It is then used as the dispatch's strict runtime record, so `ensure_runtime_record` never re-ensures it (2001-2006).

**Stage 2: the turn.** `claude_code_lane::admit` runs right after `plain_turn` is computed (RC/dispatch.rs:1796-1801) and before device grants (1802). It requires:

- **G4. One plain turn to the sender's own @octo.**
  - `plain_turn` holds and `!skill_mode_ambient_evaluation`.
  - There is exactly one target. Its handle is `octo` and its `agent_id` is `Some`. Handles resolve only against the sender's own `user_agents` (RC/dispatch.rs:547-651).
  - No message was recorded earlier under the same client message id (`existing_recorded_message`, 1255-1319).
  - No `workerInputRouting` is added later: dispatch strips a client's copy (RC/dispatch.rs:1047) and adds its own only at 1944-1945, after this gate, so the fence is `should_route_worker_input` with strict = true (Stage 1).
- **G5. Shape.**
  - The intent is `feature` (`DEFAULT_PROMPT_INTENT`, RC/dispatch.rs:41) and the execution mode is `apply` (43).
  - `plan_seed`, `tool_limits`, `repo` and `requested_preview` are all `None`, and the conversation has no `thread_kind`.
  - The message metadata has no `attachments` (as read by RC/chat_attachments.rs:121-127).
  - The text is non-empty, at most `CLAUDE_CODE_LANE_MAX_PROMPT_CHARS`, a new limit of 100 000 characters that 3.9 also checks (dispatch has no prompt length limit today: `normalize_dispatch_request` only trims and requires text, RC/dispatch.rs:3249-3253), and does not start with `/` once leading whitespace is removed, as the ambient gate checks (RC/dispatch.rs:3715).
  - `writeIntent` is true and the metadata has none of the keys the write-scope plan reads, in either spelling and with any value, null included: `writeScope`/`write_scope`, `writeScopes`/`write_scopes`, `agentWriteScopes`/`agent_write_scopes`, and `writeScopes`/`write_scopes` under `agentSelection` (RC/agent_write_scopes.rs:314-352). The gate checks these keys, not the computed scope, which is built only after it (RC/dispatch.rs:1857). Any of them can yield `coordination_required`, as an invalid scope (RC/agent_write_scopes.rs:74-83) or an explicit one (482-489), and `job_allows_workspace_mutation` rejects that mode as it does a read-only one. Without them, a single-agent write gets the `unscoped` mode (180-182). `job_allows_workspace_mutation` (RC/origins.rs:1178-1184) then holds, so the internal workspace token gets minted.
- **G6. The person's own computer.** `request.runtime_id` was explicit in the request. Stage 1 records it, because `ensure_conversation_record` (called at RC/dispatch.rs:1212-1214) fills a missing one from the chat's stored runtime preference (RC/conversations.rs:3293-3306) before Stage 2 runs. The runtime row:
  - exists in this project. `ensure_runtime_target_owner` returns `Ok(None)` for a missing row (RC/dispatch.rs:5128-5130), so the gate checks this itself;
  - is private self-hosted (`runtime_is_private_self_hosted`, RC/runtime/access.rs:77-90);
  - has an attested owner equal to the sender, which is not the service runtime user. The owner comes from `self_hosted_owner_user_id` (access.rs:47-53) and is written only by the controller, from an authenticated identity: at registration from the runtime token subject or the registering session (RC/runtime/register.rs:403-437), and at `/agent/login` from the session user (RC/agent.rs:780-788, 836-841);
  - has no `personalBrowser` key. Such a runtime leases only browser jobs (RC/agent.rs:4993-5005);
  - is dispatch-ready: `runtime_not_dispatch_ready_detail` returns `None` (RC/dispatch.rs:4551-4579);
  - carries an attested `claudeCode` with `version 1` and `ready true` (2.10).
- **G7. The computer is idle.** No job of this project is queued or leased that is targeted at, or leased by, this runtime. Otherwise the answer is 409 `claude_code_machine_busy`. The lease takes pinned jobs by priority and then age (RC/agent.rs:5120-5123), so a queued Codex job would otherwise run first, and the lane job could miss its start window. G7 is a check before an insert, and the runtime row's `for share` lock serializes it in one direction only: a dispatch in another chat that is already under way can still queue a job for this computer after the turn is admitted. So the lease hands a lane job out before any other job pinned to the same runtime (2.4, rule 7), and such a job waits behind the turn.
- **G8. One lane turn per person.** The sender has no `engine = 'claude-code'` job that is leased, or queued with `lease_attempts = 0`. This is the unique index's own predicate, so the gate and the index never disagree.
  - When it fails, the answer is 409 `claude_code_turn_active`.
  - When the blocking turn's start window has already passed, `details.reason` is `start_window_passed`, and the message instead says that the earlier turn is about to be marked as not run, and to send again in a few seconds. The sweep runs every 10 s (RC/main.rs:415-425).
  - Two concurrent admissions are settled by the index: the second insert waits for the first transaction, then fails with 23505, which is mapped to the same 409.

**Refusal codes:**
- 400 `claude_code_turn_engine_unknown` (a claim with any other value, 2.1);
- 403 `claude_code_turn_not_allowed` (G1);
- 403 `claude_code_turn_not_person` (G2, G3);
- 422 `claude_code_turn_not_plain` (G4, G5);
- 409 `claude_code_runtime_not_ready` (G6);
- 409 `claude_code_machine_busy` (G7);
- 409 `claude_code_turn_active` (G8);
- 409 `claude_code_conversation_granted` (granted chat).

Each carries a `details.reason`; appendix A lists them. G6's reasons tell a computer that isn't the sender's or isn't connected (`no_runtime`, `runtime_missing`, `not_private`, `not_owner`, `personal_browser`, `not_dispatch_ready`) from one whose Claude Code can't take a turn (`capability_missing`, `capability_not_ready`), and Studio words the two apart (5.5).

The lane's other refusals, outside the gate, follow D-G: 403 `claude_code_turn_takes_no_secrets` and `claude_code_turn_has_no_job_token` (2.5), 403 `claude_code_turn_starts_no_turns` (2.6), 409 `claude_code_turn_takes_no_input` (2.8), 403 `claude_code_turn_has_no_proxy` (2.9), and 403 `claude_code_turn_not_person` with the reason `queued` or `automation` for a queue entry or an automation that carries the claim (2.9).

The gate returns `LaneAdmission { runtime_id }`.

### 2.3 What admission changes in the rest of dispatch

| Site | Change |
|---|---|
| Target credential | The lane target's `credential_id` becomes `None`. Without this, dispatch enqueues the target's own credential (RC/dispatch.rs:2607-2619), and the CHECK rejects the insert for every sender whose @octo has a connection or who has a default connection (RC/dispatch.rs:617-618). Every platform predicate below gains `lane.is_none()`, so a credential-less lane job is never mistaken for Instafy AI. |
| Device grants (1802-1816) | `grant_ids` stays empty. |
| Runtime choice (1818-1846) | `runtime_id` = `admission.runtime_id`, and the preference fallbacks go unused. `prefer_runtime = false`, overriding the default of true for any send that names a runtime (RC/conversations.rs:2907-2909), so the computer never becomes the chat's runtime preference (RC/dispatch.rs:2075-2091). Studio also sends `preferRuntime: false`, as Personal Browser does (SC/usePersonalBrowserBridge.ts:79). |
| Platform lane (2105-2108) | `platform_lane_ai_dispatch = lane.is_none() && …`. This one change also turns off the dispatch-time unpin (2114-2124), the private-runtime refusal (2146-2163), and the managed gate, reserve and daily count (2165-2448). |
| Access stamp (2420-2427) | Writes `claude-code` instead of `byoc`. `merge_ai_access_metadata` (5386-5404) takes a mode instead of a bool. |
| Prompt segment (2495; 472-484) | Not applied. `prompt_text` is the recorded message text. |
| Worker continuation (2544-2555) and Codex resume (2561-2579) | Not called. The lane loader is used instead (2.7). |
| Job target (2580-2593) | `target_runtime_id` and `queued_runtime_id` are both `admission.runtime_id`. `target_runtime_for_agent_job` (5152-5167) returns the explicit runtime for lane jobs, as it does for browser transports, so neither the agent's per-project pin nor spread metadata can move the job. |
| Enqueue (2607-2619) | Passes `engine` and `credential_id = None`. `enqueue_agent_job_record` maps 23505 on `agent_jobs_one_active_claude_code_turn_idx` to 409 `claude_code_turn_active` before its generic 500 (RC/agent.rs:4806), because by the time dispatch sees the error its SQLSTATE is gone. |
| Platform job record (2631-2652) | Its predicate gains `lane.is_none()`, so no `ai_usage_jobs` row is written. |
| Post-commit runtime alert (2873-2910) | Calls `should_retarget_unavailable_runtime(reason, strict_browser_runtime_id.or(lane_runtime))` (4538-4544). The job is never unpinned, the preference is never cleared, and there is no reconnect or launch (2963-3008). The unpin UPDATE (2885-2892) also gains `and engine is null` as a backstop. |
| Payload (RC/agent.rs:6305-6314) | Building a lane payload that carries the evaluation marker is an error. `plan_seed`, `tool_limits` and `repo` are never present (G5). The builder also leaves out `bootstrap`, which it otherwise copies from client metadata (RC/agent.rs:6257-6261, 6327-6329) and which no gate refuses. |

### 2.4 Leasing rules

These rules change `lease_next_agent_job` (RC/agent.rs:4816-5376), `agent_lease` (940-1378) and `attach_controller_tokens` (1869-1941). Rule 1 also changes the idle poll and the run-once sweep, and rule 6 changes the wire types.

1. **Lease once, within a minute.**
   - `granted_job_cannot_start!` (RC/device_grants.rs:57-68) becomes `run_once_job_cannot_start!`, covering `(grant_ids is not null or engine is not null)`.
   - It keeps the 60 s window (`GRANTED_TURN_START_WITHIN_SECONDS`, :51), measured from `trigger_received_at`.
   - The lease (RC/agent.rs:4900), the idle poll (1483) and the sweep (RC/runtime/sweeps.rs:1234) all use it.
2. **Exact pin, attested owner, attested capability.** This clause goes beside the `grantedTurns` clause (4901-4908):
   ```sql
   and (aj.engine is null or (
         aj.target_runtime_id = $2
     and exists (select 1 from runtimes lane_runtime
                  where lane_runtime.id = $2 and lane_runtime.project_id = $1
                    and lane_runtime.capabilities #>> '{_instafySelfHostedAccess,mode}' = 'private'
                    and lane_runtime.capabilities #>> '{_instafySelfHostedAccess,ownerUserId}'
                          = aj.payload #>> '{user_id}'
                    and lane_runtime.capabilities #> '{claudeCode,version}' = '1'::jsonb
                    and lane_runtime.capabilities #> '{claudeCode,ready}' = 'true'::jsonb)))
   ```
   Hosted runtimes have no owner filter (5006-5024 applies only to private ones), so this clause is what keeps them out. The existing owner filter still applies on top.
3. **Not a platform job.** The exclusion at 4926-4930 gains `and aj.engine is null`.
4. **Never batched.**
   - A lane job has no plan group, so the batch ends after it (1214-1230), and no batch continuation can match it (5055-5062).
   - An explicit `break` when `job.engine` is set makes this independent of those rules.
5. **The lease adds nothing else.**
   - No proxy envelope: `job.proxy = None` (1177-1195).
   - No metering bind: `platform_job` gains `&& job.engine.is_none()` (1200-1203).
   - No model-facing controller token: `attach_controller_tokens` skips `mint_job_controller_token` (1886-1904) and keeps the internal workspace token (1906-1926, minted at 2022-2070).
   - No conversation history (5252-5260), hand-back keys, skill openers, preview pages or attachment URLs.
6. **Wire format.**
   - `AgentJob` (190-240) gains `engine` and serializes it.
   - RA's `LeaseJob` (RA/controller.rs:176-218) gains `#[serde(default)] engine: Option<String>`.
   - An older runtime that ignores the field never receives a lane job, because it never advertises the capability.
7. **The lane job first.** The candidates are ordered by whether they are pinned to the leasing runtime, then `(engine is not null) desc`, then priority and age. A job another dispatch queued for the computer just as the turn was admitted (G7) therefore never uses up the turn's minute. Only the pinned runtime leases a lane job, so no other runtime's order changes, and neither does any order among other jobs.

### 2.5 What the job carries and does not carry

**It carries:**
- the job, project, run, prompt, session and conversation ids, `intent: "feature"`, `engine: "claude-code"` and `lease_attempts: 1`;
- the payload built by `build_agent_job_payload` (RC/agent.rs:6248-6361):
  - `user_id`, the sender (6267-6272);
  - `prompt_text`, the recorded message, verbatim;
  - `metadata`: only the controller-stamped `agent`, `writeScope` (G5's `unscoped` scope, RC/dispatch.rs:2506-2509), `claudeCode`, `aiAccessMode`, `managedAiUsed` (false), `conversationVisibility` and `runtimePreference`, plus the client's `input` and `writeIntent`. Dispatch stamps `runtimePreference` for the chosen runtime (RC/dispatch.rs:2065-2074), and `merge_runtime_preference_from_job_payload` copies it onto the reply (RC/agent.rs:6390-6403). Today `build_agent_job_payload` copies the whole request metadata (RC/agent.rs:6322-6326), client keys included, such as a client-chosen `userId` (RC/dispatch.rs:1107-1111), so it gains this allowlist for lane jobs;
  - the top-level `executionMode`, the workspace mode every write job carries, which for a lane job is always `shared_write`, whatever the client's metadata asked for. It is not the execution mode: the runtime reads that only from `metadata.execution_mode` (3.9). A test pins the payload's whole top-level key set, and runtime-contracts records one such payload (`laneJobPayload` in `claude_code_lane_fixtures.json`), which the controller's builder and the runtime's `LaneJob::of` are both tested against (8);
  - `provider_conversation_state`, when 2.7 finds a lane session;
- the internal workspace token, with scopes `workspace.lease.write` and `origin.token.mint` (RC/agent.rs:2043-2046) and a TTL of at least 1 h (2054). It is minted once, at lease (1263), and never renewed; the end-of-turn save needs it, which is what bounds the turn's wall clock (3.6). Its mutations revalidate the live job and the person's role (2050-2053). runtime-agent verifies it and never exports it (RA/jobs/mod.rs:7360-7362, 6343-6425).

**It does not carry:**
- **A proxy envelope or metering bind.**
- **A `controller_token`.**
  - That means no `prompt.execute`, which every job-token collaboration route requires (RC/active_job_auth.rs:17), and no `fs.write` or `git.token.mint.job` (RC/agent.rs:1943-1958, 1984-1991).
  - So the routes that start turns (RC/conversations.rs:2869-2945) or create automations (RC/automations.rs:1767-1786) cannot act for a lane job.
  - `authorize_active_job` (RC/active_job_auth.rs:202-300) also refuses any token whose job is a lane job, with 403 `claude_code_turn_has_no_job_token` (add `j.engine` to the select at 239-266).
- **Project secrets.**
  - `agent_secrets` (RC/secrets.rs:1189) answers 403 `claude_code_turn_takes_no_secrets` directly after its lease checks (1246-1258).
  - That also withholds the Codex model settings (1340-1362), `maxNativeSubagents` (1262-1271) and the research budget token (1286-1300).
- **Grants, a grant token or a credential id.** The CHECK forbids them.
- **History, hand-back keys, skill openers, preview pages, attachment URLs, `plan_seed`, `tool_limits` or `repo`.**

### 2.6 Completion

In `agent_complete` (RC/agent.rs:3244), for a job whose `engine` is set:

- **Only the runtime that leased it.** Only the runtime that leased a lane job can complete it or post messages to it. The completion and message routes match a lane job only when the caller's runtime is its `leased_by_runtime_id`, and a token that names no runtime, which a write member can mint while `STRICT_MODE` is off, never matches one: the answer is the existing 404, and nothing is written. A queued lane job therefore ends only through the sweeps, a stop of its runtime or a cancel. Other jobs keep their existing rules.
- **Provider.** Stored as `claude-code` whatever the runtime reports (3693). A job without an engine that reports `claude-code` stores no provider id, and the controller logs it.
- **Conversation state (3697-3704).** Only the lane shapes are kept:
  - `{"provider": "claude-code", "version": 1, "sessionId": "<uuid>", "runtimeId": "<uuid>"}`;
  - the reset shape `{"provider": "claude-code", "version": 1, "reset": true}`.

  Anything else is dropped. A Codex job's state that names `claude-code` is also dropped. Codex writes its own `provider` key (RA/codex.rs:3679) and never checks it on resume, so the controller is where engines are kept apart.
- **No credit charge.**
  - No reserve exists, because the platform lane is off.
  - The usage block (3772-3825) is skipped for lane jobs, so `usage_to_reconcile` stays `None` whatever the artifacts hold.
  - A forged `codex/run-log`, the only artifact `extract_turn_usage_from_artifacts` reads (4470-4508), therefore bills nothing. The completion drops `codex/run-log` artifacts from lane jobs.
- **Usage display.** The runtime attaches a `claude-code/usage` artifact with the model from `init` and the input, cache-creation, cache-read and output tokens.
  - The controller writes the Details-only usage row in place of `codex_turn_usage`. Its details kind is `claude_code_turn_usage`, it is marked `billed: false`, and it reads "Claude Code reported: input N, cached M, output K". N counts every input token, cache writes and reads included, as a Codex row's input includes its cached tokens, and M counts the cache reads. The row keeps the model and the four raw counts.
  - There is no dollar figure. The runtime drops Claude Code's `total_cost_usd`, which is an API-price estimate, not what a plan costs.
- **Failure code.**
  - The runtime fails a lane job with a `claude-code/failure` artifact `{code}` (RA/agent.rs:1648-1666 already sends failure artifacts). The runtime classifies the code from Claude Code's structured stream fields first, and from result text only as a fallback. An `assistant` message whose `error` is `authentication_failed` gives `not_signed_in`. A `rate_limit_event` whose `rate_limit_info.status` is `rejected` gives `plan_limit`, with `resetsAt` as the reset time; its `errorCode` `credits_required` means a claude.ai plan's included usage is used up. An `error` of `rate_limit` or `billing_error` without such an event can come from an API key or cloud account the person configured (3.4), so its message does not name their Claude plan.
  - The controller checks the code against the runtime's codes, the rows of 5.5's table above `claude_code_turn_not_allowed`, and copies it onto the failure message as `claudeCodeFailure`, beside its own stamps (`claudeCode`, `aiAccessMode` and `managedAiUsed: false`), as every writer of a lane failure message does (`stamp_failure`, 5.5). A code outside the list is left off, and Studio words that failure as one with no code.
  - The lists are named once, in runtime-contracts (`claude_code_lane`): the five not-ready reasons of 3.2, these 16 runtime codes, and the three codes only the controller writes (`claude_code_machine_stopped`, `start_by_passed`, `run_once_interrupted`). Its fixture, `claude_code_lane_fixtures.json`, holds the same lists, and the controller's, the runtime's and Studio's tests compare their own copies with it (8).
- **Upstream pacing.** `record_job_end` (RC/upstream_pacing.rs:343, called at RC/agent.rs:4102) returns at once for an engine job. Otherwise a credential-less lane job counts as the platform upstream (`upstream_key_sql`, 52-54), and a Claude plan limit that reads like a rate limit would hold the space's plan agents (395-470).
- **Agent messages.**
  - `agent_message` (RC/agent.rs:2280-2556) refuses plan, user-input-request and hand-back metadata from a lane job with 403 `claude_code_turn_starts_no_turns` (D-G), before anything is written.
  - `ensure_parent_job_allows_multi_agent_plan` (RC/multi_agent_plan.rs:316-335) refuses a lane parent, beside its browser-bound refusal. Today it takes only the job payload, so its caller (143) reads the job's `engine` column by `job_id` and passes it in.
- **Queue.** The send-queue drain after completion (RC/agent.rs:4008) runs queued messages as ordinary turns. No queue entry can hold the claim (2.9).

### 2.7 Resume

**The lane loader.** `claude_code_lane::load_session(tx, project, conversation, sender, agent_id, runtime_id)` returns `proxy_metadata->'conversation'` of the latest job that has a lane-shaped state (jobs without one are skipped, as the Codex loader skips them, RC/dispatch.rs:5526-5527) and that:
- has `engine = 'claude-code'`;
- is in the same conversation, for the same agent;
- belongs to the same person (`payload.user_id`);
- targets the same runtime (`target_runtime_id`);
- saved a conversation state: `proxy_metadata->'conversation'` is neither SQL null nor JSON null, as in the Codex loader (RC/dispatch.rs:5526-5527). Every completion writes that key, as JSON null when it keeps no state (RC/agent.rs:6055-6062), and a job with no completion, such as a stopped turn or one a sweep or runtime stop failed, keeps the column default `{}` (MIG/20260000000000_full_schema.sql:345). Without this condition, either kind of job would hide the last saved state.

If that latest state is the reset shape, the loader returns nothing and the next turn starts fresh.

**The Codex loader.** `load_provider_conversation_state_for_job` (RC/dispatch.rs:5501-5564) gains `and j.engine is null`. It could not return lane state anyway: a credential-less job matches only through an `ai_usage_jobs` row (5530-5537), and lane jobs have none. The column makes this explicit.

Each engine resumes only its own state. Codex still sees the lane's replies as ordinary chat history at its own lease.

**What the runtime passes.** runtime-agent passes `--resume <sessionId>` only when both hold:
- the state's `runtimeId` is its own registration id;
- `sessionId` parses as a UUID.

Otherwise it starts a new session. Claude Code's session stays in the person's own data on that computer; Instafy keeps only its id.

**A failed resume.** If `--resume` was passed and `claude` exits non-zero before its `system/init` event with the missing-session error that Phase 0 item 7 records (other startup exits, such as Claude Code refusing `--mcp-config` and `--strict-mcp-config` on a machine with a `managed-mcp.json`, fail with their own code and keep the session):
- The job fails as `session_unavailable`, with the reset shape in `proxy_metadata.conversation`. Failures go to `/agent/complete` with their proxy metadata (RA/controller.rs:1164-1187), and the completion saves conversation state on failures too (RC/agent.rs:3697-3704).
- The runtime starts no second process. The person's next lane message starts a new session.

**After a Stop.** A stopped turn sends no completion (RA/agent_executor.rs:272-282), so it saves no state: the stored session id changes only when a turn completes. The lane never passes `--fork-session` (3.3), so `--resume` reuses the stored session id and a resumed turn writes into that session. A stopped turn's partial work therefore stays in it, and the next turn continues from it, as it would in the person's own terminal after an interrupt. A stopped turn that started a new session stores no id, so the next turn starts a new session too.

### 2.8 Stop and steer

**Stop** is unchanged. Any member with write access can stop a lane turn through the conversation stop, interrupt and job-cancel routes (RC/conversations.rs:515-536).
1. The cancel reaches runtime-agent at the next one-second heartbeat (RA/agent.rs:117-193, 162-171).
2. runtime-agent stops `claude` (3.6) and sends the stopped-turn report.
3. Stopping starts nothing.

**Steer** is refused for everyone, the author included. In this lane nothing can deliver words into a running `claude -p`.
- In `apply_steer_send_intent`, before the active-job query (RC/send_intents.rs:672-699), a steer whose `expectedActiveJobId` names a job with `engine` set answers 409 `claude_code_turn_takes_no_input`, reason `steer` (D-G). As built, that lookup is scoped to the conversation's space and chat, so a job id from elsewhere falls through to the existing `active_job_conflict`.
- The refusal must come before that query. The query takes only jobs whose runtime is polling for input (`active_input_ready_*`, 691-693), and a lane job starts no `JobInputTask`. A check at 757-779 would never run, and the steer would answer 409 `active_job_conflict` (728) instead.
- runtime-agent also starts no `JobInputTask` for a lane job (RA/agent.rs:1476-1505).
- Queueing an ordinary message behind the turn still works. It runs on Codex afterwards.

### 2.9 Paths that must refuse or skip lane jobs

| Path | What it does today | Rule for lane jobs |
|---|---|---|
| Runtime-stop requeue, `resolve_jobs_for_unavailable_runtime` (RC/runtime/stop.rs:2457-2521) | Requeues non-browser jobs with `target_runtime_id = null` | The requeue gains `and engine is null`. A new `fail_claude_code_jobs_for_unavailable_runtime`, beside `fail_browser_jobs_for_unavailable_runtime` (2342), fails the lane jobs leased by or targeted at the runtime as `claude_code_machine_stopped`. The stop holds the runtime row `for update`, and dispatch locks a chat before a runtime, so the stop's transaction fails only the job. Once it commits, a short transaction of its own locks the turn's chat, fails the run and writes its Home row if the run is still unfinished, then records the failure message (2.6, 5.5); the message event, push and `run.completed` are published only for what that write recorded. That write is tried up to 3 times, and a turn whose failure message is already there gets nothing twice. Only the controller's own message counts as already there: one with no author, on the turn's run, with the `claudeCode` stamp. A message anyone records with the turn's `jobId` and kind `claude_code_machine_stopped` never does, so it cannot make that write, or the sweep step below, skip the turn and leave its run unfinished (2.1). A step in the 10 s sweep writes the same for a turn whose own write never committed, from 60 s to 24 h after the stop, 32 a tick, the oldest first, through `agent_jobs_stopped_claude_code_turn_recovery_idx` (2.1); it runs only while the switch names someone (2.11). |
| Expired-lease requeue (RC/runtime/status.rs:1690-1716) | Requeues the job and keeps its pin | Unchanged, but it runs only from the idle sweep for a space this controller process holds as idle in memory (RC/runtime/sweeps.rs:206-214), or on a client's idle signal (RC/runtime/status.rs:614-622). A new step in the 10 s sweep fails any leased lane job whose lease has expired, whatever the space's activity, as `run_once_interrupted`. The heartbeat refuses to renew an expired lane lease. A requeued job has `lease_attempts > 0`, so it is never leased again. |
| Run-once sweep, `fail_jobs_that_can_no_longer_start` (RC/runtime/sweeps.rs:1211-1275) | Fails device-grant jobs | Covers lane jobs through the macro, as `start_by_passed` and `run_once_interrupted`. |
| Stranded-platform sweep (RC/runtime/sweeps.rs:1084-1087 select, 1166-1169 update) | Tests `credential_id is null` inline | Both queries gain `and aj.engine is null`. These two do not call `job_is_platform_ai`. Without the change, a lane job queued for longer than `STRANDED_PLATFORM_JOB_GRACE_SECONDS` (30 s, :147) is failed with the managed-AI refusal. |
| Limit waits, `job_is_platform_ai` (RC/runtime/limit_waits.rs:368-375) | Credential-less AI job | Gains `and {j}.engine is null`. |
| Short rate-limit requeue, `retry_wait` (RC/turn_rate_limit_retry.rs:86-115) | Skips grant and browser jobs | Returns `None` for engine jobs. |
| Upstream pacing (RC/upstream_pacing.rs:343-470) | Paces the platform upstream | Skipped (2.6). |
| Proxy-token renewal (RC/agent/proxy_token.rs:11-112) | Mints an envelope for any leased job, and a metering bind for credential-less ones (102-112) | 403 `claude_code_turn_has_no_proxy`. |
| `/agent/secrets`, `authorize_active_job` | Serve any leased job | Refused (2.5). |
| Dispatch-time unpin and post-commit alert | Unpin from runtimes that are not ready | Never (2.3). |
| Codex replays and retry passes (RA/codex.rs:6632-6638; the retry block of `run_apply_job_observed`, RA/jobs/mod.rs:8929 onward) | Re-run failed Codex turns | Never reached (3.1). |
| Plans (RC/agent.rs:2531-2551; RC/multi_agent_plan.rs:316-335) | A running job may author one | Refused (2.6). Plan workers run as the service role and fail G2. |
| Automations: dispatch (RC/automations.rs:966-1019), create (1652), update (2050), run now (2534) | Trigger `None` | G2 refuses the dispatch. Create and update refuse prompt metadata that carries the claim, with 403 `claude_code_turn_not_person`, reason `automation` (D-G). |
| Ambient evaluations (RC/dispatch.rs:1515-1660) | Rewrite a group send into an evaluation | Never formed for a claim (2.2). G4 refuses any that remain. |
| Goal binding and wake-ups (RC/conversation_goals/mod.rs:62-149) | Bind a goal; wake-ups dispatch without a trigger | No binding. Wake-ups fail G2. |
| Hand-backs (RC/browser_hand_back.rs:1520-1530) | Dispatch a continuation | G3. |
| Send queue: `prepare_queue_message` (RC/send_queue.rs:359), used by enqueue (434; the HTTP route calls it at 572) and by edit restoration (1008) | Accepts any prompt body | Refuses a message that carries the claim, as it refuses a hand-back (379-385), with 403 `claude_code_turn_not_person`, reason `queued` (D-G). A drain carries `dispatch_queue_entry_id` and `received_at` (1402-1411), so G2 and G3 refuse it. The busy fallback (RC/conversations.rs:2955-2981) returns the 409 for a claim. |
| Steer | Any member may steer most turns | Refused (2.8). |

### 2.10 Capability attestation and runtime status

**Runtime token.**
- `RuntimeTokenRequest` (RC/runtime/token.rs:351-364) gains `localEngine: Option<String>`.
- `normalize_runtime_token_scopes` (106-143) adds a new scope, `claude_code.turns`, only for `localEngine: "claude-code"`, only when `claude_code_lane.allow(subject)` holds, and only for a person's own session (`require_user_session`, RC/auth.rs:82-91). The service role may name any subject (RC/runtime/token.rs:313-323), so it never gets the scope.
- The scope joins `RUNTIME_TOKEN_ALLOWED_SCOPES` (61-76). Like `personal_browser.control` (131-139), it cannot be requested without its flag.
- Desktop sends the flag only for a person who consented (4.3).
- Registration renewal carries the scope forward, as it does the Personal Browser scope (RC/runtime/register.rs:1004-1007).

**Registration.** `attest_runtime_capabilities` (register.rs:334-383) always removes a runtime-reported `claudeCode`. It writes back a rebuilt value only when all of these hold:
- the token holds the scope;
- the runtime is private self-hosted;
- its attested owner (403-437) is a person, not the service runtime user (`runtime_token_subject_is_controller_service`, 439);
- as built, it is not a Personal Browser runtime. G6 refuses one anyway, and 3.2 never reports the capability there, so attesting it would only make status offer a lane that dispatch refuses. Renewal then carries `claude_code.turns` forward only when the capability was attested.

The rebuilt value keeps only `version` (which must be 1), `ready` (a bool), `reason` (from the list in 3.2), `cli` (a semver), `verified` (a bool that says whether `cli` is at most `CLAUDE_CODE_LANE_VERIFIED_THROUGH`, 8), `planSignIn` (a bool that says whether the probe found a Claude plan sign-in, 3.2) and `partialMessages` (a bool).

**Status.** RC/runtime/status.rs passes `claudeCode: {ready, reason, cli, verified, planSignIn}` beside `skill_packs` (1231; `skill_packs_from_capabilities` at 177-190). Only the runtime's owner sees it in the space's status route, because private rows are filtered to their owner (`self_hosted_runtime_is_accessible_to_user`, 1146-1154), and only when the switch covers the viewer. Two callers skip that filter and see every private row: a service-role caller of the route (787), and the operator support snapshot, which calls the shared loader through `load_runtime_status_response` with no viewer (806-812, used at RC/operator_admin.rs:323). As built, ownership is checked on each row, and the viewer must be a person's own interactive session, so those two callers list the private rows as before but without `claudeCode`. The response also carries `claudeCodeLane: true` when the switch covers the viewer. Studio needs it, because before setup no runtime has `claudeCode`, whether the switch covers the person or not (5.1).

**What attestation proves.** It proves that the person's own session asked for a lane-capable token for this runtime, and that the switch allows it. It does not prove that Desktop made the request. The lease clause (2.4) and the runtime's own check (3.9) are what bind each job to the consenting person.

### 2.11 Configuration, deploy order, rollback

- **Default.** `CLAUDE_CODE_LANE_USER_IDS` is empty, which means nobody.
- **Deploy order.**
  1. Migrations.
  2. The controller, with the switch empty.
  3. runtime-agent, Desktop and Studio.
  4. The switch, for internal user ids, only once the release prerequisite is recorded: Instafy has accepted Anthropic's Commercial Terms or has another agreement with Anthropic. Anthropic's terms make no exception for internal users. Phase 8 lists the other gates.
  5. Wider.
- **Keep the switch empty until the previous controller pool is retired** and no load balancer still sends it requests. An older controller ignores `engine`: its runtime-stop requeue would unpin a lane job, and its lease would hand that job to a hosted runtime as an Instafy AI job. Device grants follow the same rule (docs/Architecture.md:317-322).
- **Rollback.** Empty the switch. Then wait until no job with `engine = 'claude-code'` is queued or leased, or fail the leased ones the way the runtime-stop path does (2.9). Queued ones start or are failed by the sweep within about 70 s. A leased one keeps its lease for as long as its turn runs, because the runtime heartbeats every second and each heartbeat extends it (RA/agent.rs:121; RC/agent.rs:2186-2199). So the wait can last the start window plus one whole turn, whose wall clock is at most 3000 s (3.6). Then roll back. The column, the CHECK and the indexes are additive; leave them in place.
  - Once the switch is empty, the sweep step that writes the end of a turn whose stop could not write it (2.9) no longer runs, so such a turn's run stays unfinished.
  - A controller from before the lane stores the `claudeCode` a runtime reports about itself as it is, unattested, and it stays until that runtime registers again with a current controller. Such a controller strips only the controller-owned capability keys it knows, so no choice of key name prevents this (D-D). When the release is deployed again, keep the switch empty until every runtime has registered again with the current controller.

---

## 3. Runtime agent

### 3.1 Where the lane branches

1. **Refusal before anything runs.** In `handle_job` (RA/agent.rs:1325), next to the Personal Browser refusal (1338-1355), and before heartbeats or secrets, `claude_code::refuse_unless_runnable(&job)` reports the failure with `fail_job_with_artifacts` and a `claude-code/failure` artifact `{code}` (2.6; plain `fail_job`, RA/controller.rs:1153-1162, sends no artifacts), and returns, when:
   - the job has an engine but this process has no ready grant;
   - the engine value is unknown;
   - any check in 3.9 that needs only the job and the captured grant fails: the job shape (apart from verifying the workspace token), the person and mode, the markers and the prompt. The token's verification needs the registration and the processor's verifier (RA/jobs/mod.rs:6343-6425), the folder pre-flight needs the refreshed checkout, and the per-turn probe belongs right before the spawn, so these run inside the turn instead (steps 2, 4 and 6 below).

   An unknown engine never falls back to Codex. Only the grant and probe refusals have a code of 5.5's table: no captured grant, a runtime off macOS or a Personal Browser runtime gives `binary_missing`, and a malformed grant gives its own reason. The other refusals (job shape, person, mode, markers, prompt, an unknown engine) fail with no code and a plain first line, and Studio shows the "anything else" sentence (D-I). The controller's gate keeps such jobs from reaching a runtime, so they show only if the gate fails.
2. **What `handle_job` skips for a lane job.**
   - `fetch_job_secrets` and `install_fetched_job_secrets` (1425-1434); the job uses `AgentRuntimeSettings::default()`.
   - The `SecretsRefreshTask` (1465-1474).
   - The `JobInputTask` (1476-1505).

   It keeps the heartbeat (1363-1388) and `JOB_PROCESS_ENV_LOCK` (1390-1402). The lock is harmless because a lane job is always alone in its batch. The child's environment comes from the startup snapshot, not from the process environment (3.4).
3. **The executor.** `AgentExecutor::run_apply_with_progress` (RA/agent_executor.rs:210-284) skips `job_proxy_auth::for_job` (222-227) for a lane job. Without the skip, a lane job would fail there before it starts: whenever the registration carries an envelope, which every registration does on a controller that can sign one (RC/runtime/register.rs:977, 1036), that call builds the grant only from the job's own envelope, and a job that has none fails as "job is missing its scoped proxy grant" (RA/job_proxy_auth.rs:42-54, 171-174). Beyond that call, only paths a lane job never reaches use the registration envelope: `run_apply_job_observed` (RA/jobs/mod.rs:7326, 7358) and the plan-worker lanes (RA/jobs/mod.rs:6101, 6156; RA/jobs/isolated_worker.rs:69, 141). Progress, reply drafts, rolling saves and the stopped-turn report (228-283) stay. Rolling saves never run on Desktop anyway: their gate needs a hosted checkout (RA/jobs/mod.rs:5965-5966), and Desktop's origin mode defaults to `desktop` (RA/config.rs:529-532).
4. **The turn.** In `JobProcessor::run_apply_job` (RA/jobs/mod.rs:7253-7311), the call at 7281-7293 becomes a match on `job.engine`:
   - `Some("claude-code")` → `run_claude_code_turn` (new, RA/jobs/claude_code_turn.rs);
   - `None` → `run_apply_job_observed`;
   - anything else → an error.

   The shared tail stays, apart from the stopped-turn report's lane changes (3.6): turn records, lost-lease changes and baseline cleanup (7294-7310). `run_apply_job_observed` (7313) refuses on its first line if `job.engine` is set. So a lane job can never reach `ProxyEnvGuard` (7358; struct at 3799-3841), `ControllerTokenGuard` (7359), the routing preflight (7715-7772) or `codex_for_project` (7670).
5. **Batches.** `handle_job_batch` (RA/agent.rs:1201-1323) fails a lane job that arrives in a batch with any other job.

**New files:**
- RA/claude_code/mod.rs: capture, validation, environment snapshot, probe, capability, reuse latch;
- RA/claude_code/command.rs: argv and environment;
- RA/claude_code/supervise.rs: spawn, stop, timeouts, process tree;
- RA/claude_code/events.rs: the event adapter;
- RA/claude_code/job.rs: the checks of 3.9 that need only the job and the grant, and the session a turn resumes (built as a file of its own);
- RA/claude_code/preflight.rs: the folder pre-flight of 3.9 (built as a file of its own);
- RA/claude_code/saves.rs: the lane filter of 3.8 (built as a file of its own);
- RA/jobs/claude_code_turn.rs: the turn.

**Moved:** RA/process_tree.rs, from RA/isolated_tool_worker/process_tree.rs. It gets the cleanup latch as a parameter, since today it calls `super::mark_cleanup_unconfirmed` (:147, :160).

**Order inside `run_claude_code_turn`:**
1. Take `jobs::JOB_PROCESS_ENV_LOCK` (RA/jobs/mod.rs:365), as `run_apply_job_observed` does (7353). Then `ensure_lease_held` (4749).
2. `verified_workspace_token` (6343-6425). It is required: without it the turn fails before spawning, because a lane job has no controller token to fall back on.
3. Prepare the folder:
   - `prepare_workspace_dir` (6501);
   - `refresh_workspace_before_turn` (6511, as at 7372-7394);
   - the scaffold (7395);
   - `take_the_controllers_pages` (7399).

   A pre-turn refresh that refuses saves ends the turn before spawning, with the failure that `turn_that_cannot_save` builds (7847, 14996). The lane checks `saves_refused` itself, because that function ends only a turn that must write files and lets any other turn go on (15003-15011).
4. The pre-flight in 3.9, within its own deadline. A Stop ends it, and with it the turn.
5. Record the starting point:
   - the git baseline `collect_git_status_porcelain` (19530, used at 8264);
   - `turn_start.record` (8285);
   - `HeldPages::of_turn` (8303).
6. The per-turn probe (3.2), then `confirm_lease_held` (4760) as the last step before the spawn, the way the Codex lane confirms right before it sends a turn (4756-4759).
7. Spawn and supervise (3.3-3.7).
8. Save (3.8), then return `JobExecution` (3011-3021).

### 3.2 Finding and probing `claude`

**Capture.** At RA/main.rs:85, right after `personal_browser::capture_and_scrub_process_capability()`, a new `claude_code::capture_and_scrub_launch_grant()` runs. That point comes before all of these:
- any thread;
- the skill-pack directory export (89);
- `arg0_dispatch`, which may load `$CODEX_HOME/.env` (95-99);
- the launch-credential scrub (103);
- skill-pack shims joining PATH (116-121);
- any job's `set_var` of granted secrets (RA/agent.rs:2284-2287).

The capture:
- reads and then removes `INSTAFY_CLAUDE_CODE_BIN`, `INSTAFY_CLAUDE_CODE_PATH`, `INSTAFY_CLAUDE_CODE_USER_ID` and `INSTAFY_CLAUDE_CODE_ENV_JSON` (the login-shell values D26 grants, as a JSON object), following RA/personal_browser.rs:76-110 for the read and the removal only. That function stops startup on a bad value (`bail!` at 88-90, returned through `?` at RA/main.rs:85). Here, a value that fails validation leaves the runtime running with a not-ready capability (`binary_missing` or `binary_unsafe`);
- validates them:
  - the binary path is absolute;
  - its canonical target is a regular file with an execute bit;
  - neither the target nor its directory can be written by anyone but its owner, apart from the `admin` group (below);
  - the target is owned by the effective uid or by root;
  - neither the path nor its target is under `WORKSPACE_DIR` or the project folder override (`project_workspace_dir`, RA/config.rs:641-651);
  - PATH entries are absolute, existing directories that are not under those folders;
  - a granted `CLAUDE_CONFIG_DIR` (a directory) and `NODE_EXTRA_CA_CERTS` (a regular file) are absolute, owned by the effective uid or by root, not group- or world-writable, and not under those folders (D26);
  - the user id is a UUID;
- snapshots the allowlisted launch environment (3.4);
- stores everything in a `OnceLock`.

The ownership and writability checks also cover the granted path's own directory, every symlink on the way to the target, and the PATH entries the child gets. A directory passes when only its owner (the effective uid or root) can write it, or when its only other writer is the `admin` group, whose members are root-equivalent through sudo: Homebrew makes `/opt/homebrew/bin` writable by `admin`, so without that allowance 4.1's own `/opt/homebrew/bin/claude`, and any PATH that holds it, would be refused. The same rule applies to the target checks above and to Desktop's static validation (4.1). A PATH entry that fails is dropped; a granted path or link that fails is `binary_unsafe`. The checks run again before each spawn, on whatever target the path resolves to at that moment, since Claude Code's updates move it (4.1), and the runtime spawns that checked target, not the symlink.

The runtime never looks `claude` up by name. It never copies, wraps, patches or writes the binary.

**Probe.**
- It runs `<bin> --version` and `<bin> --help` with:
  - the lane environment;
  - stdin set to null;
  - a fresh, empty, runtime-owned working directory, so no project settings can load;
  - a 10 s timeout and a 256 KiB output cap, with the process killed on timeout.
- Precedents: `node_on_path` (RA/skill_packs.rs:734-746) and rathole's `--help` probe (RA/config.rs:695-710).
- It runs at startup, for the capability, and again at the start of every lane turn. `--version` runs every time; `--help` runs again only when the version, or the binary's canonical path, size or mtime, has changed.
- At startup its three commands (`--version`, `--help` and `auth status`, below) share one deadline, one command's 10 s: the capability goes out with the runtime's first registration, and a granted `claude` that hangs must not hold up that registration, and every Codex turn behind it, for three timeouts. A startup probe that runs out of time gives `probe_failed`, an `auth status` cut short included, and the timed re-probe below corrects it, at the cost of one more registration. Each command of a per-turn probe keeps its own 10 s.
- It never sends a prompt, and Instafy reads no credential. The one sign-in check is Claude Code's own documented `claude auth status`, run with the same environment, working directory and limits as `--version`. It exits 0 when signed in and 1 when not, and its JSON `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party`. The runtime keeps only the exit status and `authMethod`, and discards the rest of the output. It reports only whether this is a Claude plan sign-in, as the capability's `planSignIn` (2.10): true only when the rule below gives the plan line. A lane surface that has this result says "Runs on your own Claude plan" only when `authMethod` is `claude.ai` or `oauth_token` on v2.1.286 or later; earlier versions also reported a Console sign-in's stored API key as `claude.ai`. Otherwise, and on surfaces shown before any probe, such as the consent dialog, it says the turn runs under the person's own Claude Code sign-in. That sign-in may bill their API or cloud account, and with a cloud provider or gateway the traffic goes there instead of to Anthropic. The proxy-exception text in 7.1-7.3 says the same.

**What "supported" means:**
- The version, parsed with `^\d+\.\d+\.\d+`, is at least 2.1.314. That floor includes `--permission-prompts` (2.1.259), the time limit on background commands in `-p` runs (2.1.285), and the 2.1.314 fixes: `claude -p` no longer exits 0 with no output when startup fails, and a settings file excluded by `--setting-sources` no longer supplies some settings.
- The floor is the evidence for the documented flags in 3.3. `--help` is read only for the bare check below. A flag missing from `--help` is logged, never a probe failure: Claude Code's CLI reference says `--help` does not list every flag, and an unknown flag already fails at startup, before the run.
- **The bare check passes.**
  - The lane is not ready (`bare_default`) when the `--bare` help line says bare *is* the default in print mode, even when `--help` also lists `--no-bare` (D-J). Phase 0 item 1 confirms that wording.
  - Wording that bare "will become" the default, or that refers to a future release, does not count.
  - When `--help` lists `--no-bare` and bare is not the default, the lane passes it.

**Capability.** A new `apply_claude_code_capability` runs after skill packs (RA/config.rs:315-321). Following 654-693, it always removes any launch-supplied value first.
- When ready: `"claudeCode": {"version": 1, "ready": true, "cli": "2.1.x", "verified": true, "planSignIn": true, "partialMessages": true}`, with `verified` as 2.10 defines it.
- When not ready: `{"version": 1, "ready": false, "reason": …}`. The reason is one of `binary_missing`, `binary_unsafe`, `probe_failed`, `unsupported_version` or `bare_default`.
- Absent when Desktop granted nothing, on any platform other than macOS in v1 (D18), and on a Personal Browser runtime.
- Never a path, which would reveal the OS user name.

The capability is fixed for each registration (it is sent at registration and renewal, RA/controller.rs:493-550). When a per-turn probe disagrees with it, runtime-agent registers again with the new value, so G6 refuses at send and Studio stops offering a lane that would fail at the runtime. While that value says not ready, runtime-agent probes again every 60 s and registers again when the result changes: no lane turn, and so no per-turn probe, runs to notice that the person has fixed Claude Code. Each registration keeps the value it sent, and the task that renews it compares that value with the published one when it starts and registers again at once when they differ, so a value published between a registration and the start of its renewal task reaches the controller at once, not at the next renewal. The per-turn probe is what decides: a result that is not ready fails the turn, with its reason, before anything starts.

**Reuse latch.** `claude_code::runtime_reuse_is_safe()` joins the check at RA/agent.rs:39-41. When cleanup is unconfirmed, the lease loop stops (1068-1071).

### 3.3 The exact command

```
<granted absolute path>
  --print
  --output-format stream-json
  --verbose
  --permission-mode acceptEdits
  --permission-prompts none
  --setting-sources user
  --strict-mcp-config
  --mcp-config <runtime-owned 0600 file containing {"mcpServers":{}}>
  --include-partial-messages
  [--no-bare]                            only when --help lists it
  [--resume <uuid>]                      only a session id the lane loader returned (2.7)
```

How the process is wired:
- It is started with no shell, one argv element per item.
- The working directory is the space's folder (`Config::project_workspace_dir`, RA/config.rs:644-651).
- stdin gets the prompt (3.5), then EOF.
- stdout and stderr are piped.
- The MCP config file lives in a runtime-owned directory outside every space folder, and is removed when the turn ends.

Why each flag:
- **`--print`, `stream-json`, `--verbose`, `--include-partial-messages`:** a headless run that emits machine-readable events, with the text deltas that stream the reply draft (3.7).
- **`acceptEdits`:**
  - File edits inside the folder are approved, and so are `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed` on paths inside it, so the turn can do coding work, including deleting and moving files that are then saved. Writes to protected paths such as `.git` and `.claude` still need approval, and are declined.
  - An explicit mode also overrides the Manual default of `-p` (version 2.1.302 and later), and overrides the person's own `defaultMode`, which might be `bypassPermissions`. That mode must never apply to a folder whose files come from teammates.
  - Edits outside the folder still need approval, and are declined.
  - This bounds edits only. Bash commands that the person's own allow rules permit can write anywhere. Claude Code's permission settings, not runtime-agent's containment, bound its tools (7.1).
- **`--permission-prompts none`:** anything else that would need approval is declined. Nobody can answer mid-turn in this lane: runtime-agent has no channel that could carry Claude Code's permission prompts to the person. It runs Codex with no approvals (`AskForApproval::Never`, RA/codex.rs:2630-2631), fails `approval_required` jobs as not implemented (RA/agent.rs:1678-1696), and starts no `JobInputTask` for a lane job (2.8). The prompts a person does answer mid-turn, such as the Shared Browser's for its browser steps (packages/runtime-agent/assets/shared-browser-approval.js:33-40), belong to Instafy's own tools.
- **`--setting-sources user`:**
  - The person's own user settings, hooks, plugins and allow rules load.
  - The space's `.claude/settings*.json` does not. Teammates write those files, and they can carry hooks, `env` (which could set `ANTHROPIC_BASE_URL`), `apiKeyHelper` and plugins.
  - Project memory stays out too. The project CLAUDE.md files (in the working directory and its parents), their imports and `.claude/rules/` load only through the `project` source, and `CLAUDE.local.md` only through `local`. So nothing Instafy seeds into the folder (step 3 in 3.1) reaches a lane turn as instructions. Phase 0 item 2 confirms this on the floor version, for `AGENTS.md` as well (9).
- **Strict, empty MCP:** no MCP server loads. That covers:
  - `.mcp.json`;
  - the person's own MCP servers and plugin servers;
  - claude.ai connectors;
  - the Instafy plugin's `instafy mcp`, which would act as the person's CLI session (packages/instafy-cli/src/mcp.ts:14-22).
- **`--resume` without `--fork-session`:** `--resume` reuses the session id, so a resumed turn writes into the stored session, and the stored id changes only when a turn completes (2.7). A stopped turn's partial work therefore stays in a resumed session, and the next turn continues from it, as it would in the person's own terminal after an interrupt. A stopped first turn stores no id, so the next turn starts a new session.

**Never passed** (a test asserts the exact argv):
- `--bare` or `--dangerously-skip-permissions`;
- the `bypassPermissions`, `dontAsk` or `auto` modes;
- `--system-prompt`, `--append-system-prompt` or any variant of them;
- `--allowedTools` or `--disallowedTools`;
- `--add-dir`, `--settings` or `--model`;
- `--max-turns`, `--continue` or `--fork-session`.

The binary is never modified, wrapped, copied or bundled, and its sign-in methods are left alone.

### 3.4 The exact environment

The runtime calls `env_clear()`, then sets only the following values: allowlisted values from the startup snapshot, the values Desktop granted, a `PATH` built from values captured at startup, and one constant.

- **From the snapshot:** `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TZ`, `SSL_CERT_FILE` and `SSL_CERT_DIR`.
  - This is `PERSISTENT_HELPER_BASE_ENV_KEYS` (RA/model_environment.rs:112-130) minus `PATH`, `TERM`, `COLORTERM`, `TMP` and `TEMP`.
  - `TMPDIR` was already sanitized at RA/main.rs:40.
- **From the grant (D26):** `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS`, with the person's own login-shell values from `INSTAFY_CLAUDE_CODE_ENV_JSON`, each only when Desktop granted it. A granted `CLAUDE_CONFIG_DIR` or CA file that fails the checks in 3.2 makes the lane not ready (`binary_unsafe`); it is never left out. Without the granted `CLAUDE_CONFIG_DIR`, Claude Code would load its default configuration directory, with its own sign-in, hooks and allow rules. Any other name in that object is ignored.
- **`PATH`, built from these sources, in order:**
  1. the directory of the granted path;
  2. Desktop's login-shell entries (`INSTAFY_CLAUDE_CODE_PATH`);
  3. the launch `PATH` from the snapshot, taken before skill-pack shims are appended (RA/main.rs:116-121).

  The entries are deduplicated, absolute and existing, and never under the workspace root or the project folder. The native installer's target is a single binary that needs nothing on PATH to start. An npm `#!/usr/bin/env node` launcher needs `node`, and its target's directory, the package under `{prefix}/lib/node_modules`, holds none. npm links the command into `{prefix}/bin`, so entry 1 finds `node` when npm's prefix is node's own, as with nvm or Homebrew; with a custom npm prefix, or a granted link that points to that link, `node` comes only from entries 2 and 3.
- **One value Instafy sets:** `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
  - It is documented by Claude Code and only makes it load less, namely claude.ai connectors.
  - It does not depend on `--strict-mcp-config`.

**Never passed:** any other variable. In particular:
- every `ANTHROPIC_*` and `CLAUDE_*` name, apart from a granted `CLAUDE_CONFIG_DIR`, which carries the person's own value;
- `OPENAI_*`, `CODEX_*`, `PROXY_*`, `CONTROLLER_*`, `RUNTIME_*`, `ORIGIN_*` and `INSTAFY_*` (including `INSTAFY_TURN_*`);
- the space, project and conversation ids;
- `ALL_PROXY`, and `HTTP(S)_PROXY` and `NO_PROXY` from anywhere but the grant;
- `NODE_OPTIONS`, and `NODE_EXTRA_CA_CERTS` from anywhere but the grant;
- `DYLD_*`, `LD_*` and `TERM`;
- granted project secrets;
- everything in `INTERNAL_CREDENTIAL_ENV_KEYS` (RA/model_environment.rs:6-84).

**Why a snapshot.** By the time a lane turn runs, the live process environment may hold:
- granted secrets from other jobs (`set_var`, RA/agent.rs:2284-2287);
- the proxy key, as `OPENAI_API_KEY` and `CODEX_API_KEY`;
- `CONTROLLER_ACCESS_TOKEN` (RA/jobs/mod.rs:3799-3911).

It may also have lost `HOME`, if a job had a secret of that name, which is removed when the job ends (RA/agent.rs:2276-2282). And `arg0_dispatch` may load `$CODEX_HOME/.env` (RA/main.rs:95-99). The snapshot is taken before all of these.

**Authentication configured in Claude Code's own user settings still works. A sign-in kept only in shell variables, such as `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, never reaches it: that is the price of limit 5 (1.1).** A person who uses an API key or a gateway sets it in their own Claude Code user settings (`env`, `apiKeyHelper`), which load under `--setting-sources user`. Instafy neither supplies nor removes those settings. A configuration directory, network proxy or CA bundle set in the person's login shell reaches Claude Code through the grant above (D26).

### 3.5 The prompt

The prompt is exactly the UTF-8 bytes of `payload.prompt_text`, the person's recorded message, written to stdin and followed by EOF.
- **It is not in argv:** argv shows in `ps`, has length limits, and could be read as a flag. The only exception is the D30 fallback below, which puts it in argv after `--` and accepts that `ps` shows it.
- **Nothing is added:** no history, memory, skills, context cards, attachments, browser cards, preamble, JSON schema or Instafy instructions. `build_turn_prompt` and `granted_turn_prompt` are never used.
- **No follow-up input:** no steer, wrap-up, continuation or retry.

Claude Code loads its own memory. Of the CLAUDE.md files and rules, a lane turn under `--setting-sources user` loads only the person's own `~/.claude/CLAUDE.md` and user rules: Claude Code's documentation says project CLAUDE.md files (in the folder and its parents), their imports and `.claude/rules/` load only through the `project` setting source, and CLAUDE.local.md only through `local`. So no Instafy-written text reaches a lane turn through the seeded CLAUDE.md, AGENTS.md or INSTAFY.md, though Claude Code can still open those files as ordinary files. Phase 0 item 2 confirms this on the floor version, AGENTS.md included, as a gate before Phase 8 (9). Continuity comes only from `--resume`.

Unverified: whether `-p` with no prompt argument reads the prompt from stdin. Phase 0 checks this. The fallback is the final argv element after `--` (D30).

### 3.6 Supervision

**Spawn.**
- `tokio::process::Command` with `env_clear()`, the allowlist, `current_dir(folder)`, piped stdio and `kill_on_drop(true)`.
- No `process_group(0)`. `claude` stays in runtime-agent's own process group, which Electron created (DRA/index.ts:878-887) and which it signals and proves gone as a unit (DRA/index.ts:571-647). The tree proof comes before the controller is told the runtime stopped (DA/main.ts:1076-1078).
- On Windows the runtime's job object (RA/main.rs:27-32) would cover it, but v1 advertises no capability there.
- A `ProcessTree` (moved) observes descendants every 50 ms, as the isolated worker polls it (RA/isolated_tool_worker.rs:390, 406-407); `observe` (process_tree.rs:45-68) has no interval of its own. It keeps reparented ones it has already seen. The root is not a group leader, so `killpg` stays off (process_tree.rs:101-106) and descendants are killed one by one.
- What the polling costs (D-F). Phase 4 measured it on a debug build on a Mac with 770 processes: about 74% of one core, mostly system time, for as long as a lane turn runs, because each observation refreshes every process on the computer. Isolated tool workers already pay the same. Phase 8 measures it again on a release build, with the ignored test `process_tree::tests::what_observing_every_50_ms_costs` (run by hand with `--ignored --nocapture`). A cheaper tracker, which reads only the tracked subtree (on macOS, `proc_listchildpids`) or polls less often, is a follow-up.

**Bounds.**
- stdout lines are at most 8 MiB. A longer line fails the turn as `crashed`, as do more than 50 lines that do not parse.
- stderr keeps its last 16 KiB in a ring buffer, used only for classification and Details. The isolated worker keeps a bounded 16 KiB (RA/isolated_tool_worker.rs:368-380). The reader writes into a buffer the turn keeps, so when a process that escaped the tracker still holds stderr open and the reader is stopped after 1 s, the text read so far is kept. A tail cut short at its start leaves out its first line, and its end is redacted as a draft's is: an end that could be the start of the folder's or the home directory's path, a whole one included, is left out, because a reader stopped between two parts of a write, or a writer killed in the middle of a line, can cut the tail inside a path.
- The run log is bounded like the Codex run log (RA/jobs/mod.rs:135-149).

**Redaction.**
- Every string the lane sends to the controller has `sk-ant-[A-Za-z0-9_-]+` replaced. That covers steps, drafts, the reply, failure text, the run log and the stopped-turn report, so Instafy never stores an `sk-ant-` value that Claude Code or a tool printed. That Claude's OAuth access, refresh and setup tokens also start with it is unverified (6).
- The absolute folder prefix becomes relative, and the home directory prefix becomes `~`, because both name the OS user. Command output, tool inputs and the run log can name paths outside the folder. So can the pre-flight's failure text (3.9), which quotes git's own words about a repository it could not read, and it goes through the same redaction.

**Stop.** A Stop arrives as the heartbeat's 409, which fires the cancel signal (RA/agent.rs:162-171), or as a refused message post (RA/agent_executor.rs:384-396).
1. SIGTERM goes to the `claude` pid only, never to the group, because the runtime is in that group. Claude Code documents exit code 143 for SIGTERM.
2. Wait up to 5 s.
3. `terminate_and_confirm` (process_tree.rs:124-152) sends SIGSTOP, then SIGKILL, to every observed descendant and to the root, and confirms they are gone within 3 s.
4. If that cannot be confirmed, the cleanup is marked unconfirmed, and the reuse latch stops leasing (3.2).
5. The turn returns the lost-lease error: there is no completion. The executor sends the stopped-turn report (RA/agent_executor.rs:276-282). The shared code that builds it changes for lane jobs. `TurnStart::attach_to_lost_lease` (RA/jobs/stopped_turn.rs:98-123) applies the lane filter (3.8). `StoppedTurnChanges::report` (286-332) names files by folder-relative paths, as the lane's own steps do, and stamps `provider: "claude-code"`. The controller matches the report's paths to the steps' paths as written (RC/agent/stopped_turn.rs:126-131, 208-215), so both must use the same form.

**Timeouts.**
- Wall clock: `INSTAFY_CLAUDE_CODE_TURN_TIMEOUT_SECONDS`, default 2700, allowed range 60 to 3000. The save at the end of the turn (3.8, step 4) uses the job's internal workspace token. The controller mints it once, at lease, with a lifetime of max(`AGENT_TOKEN_TTL_SECONDS`, 3600) s, and nothing renews it (RC/agent.rs:2050-2054; RC/config.rs:1407-1411; RA/jobs/rolling_saves.rs:18-20). The cap leaves at least 600 s of that lifetime for the steps before the spawn and for the save; of those steps, the pre-flight stops at its deadline of 60 s (3.9). Longer turns wait for a workspace-token renewal (D11).
- Stall: 15 minutes with no stream event.

Either one uses the same kill path and fails the turn as `turn_timeout` or `stalled`. Nothing is saved.

**End of the turn.** A `claude -p` run can stay open after its `result`. It waits for a background command the main conversation started, such as a dev server, until the command exits or reaches its time limit: 10 minutes by default with a text prompt, up to 2 hours when Claude passes a `timeout`. It also waits for Monitor watches, pending `/loop` wakeups, and background subagents and workflows. Every turn that background work starts prints another `result`. In `-p`, a subagent Claude spawns starts in the background unless Claude chooses to wait, so its outcome can arrive only in a later turn. The adapter tracks the live background tasks from the `system/task_started`, `system/task_notification` and `system/background_tasks_changed` events, leaving out `ambient` ones. Phase 0 item 5 confirms these events.
- While a live task is anything other than a background command or Monitor watch (`task_type` `local_bash`), for example a background subagent or workflow, a top-level `result` does not end the turn. The adapter keeps reading, within the wall-clock and stall limits.
- A top-level `result` that arrives with no such task live ends the turn. The runtime records it and stops `claude` as Stop does (steps 1 to 4 above): SIGTERM, on which Claude Code terminates the process tree of any running Bash command, then up to 5 s, then `terminate_and_confirm`. It ignores anything printed afterwards.
- The reply, and whether the turn succeeded, come from the latest top-level `result` read. Exit 143 after the runtime's own SIGTERM counts as exit 0. The `result` row in 3.7 and the success test in 3.8 follow this rule.

Until Phase 0 has confirmed the task events' shapes, the tracking fails closed: a shape it does not expect keeps a turn open longer, within the limits, and never ends it early.
- A `task_notification` removes a task only when it says the task ended. One with no status, or another status, changes nothing.
- A `background_tasks_changed` list adds the tasks it lists and removes those it marks ended or `ambient`. It never drops a task only because the list leaves it out. A listed task that is not a background command and has no id the adapter can read keeps the turn open until a later list no longer has such an entry.
- A task with no `task_type` keeps the turn open.

**Every exit.** After `claude` exits, by any route, `terminate_and_confirm` runs anyway, as the isolated worker does (RA/isolated_tool_worker.rs:468-479). Background shells and helpers that the tracker has already seen die with the turn. One whose parent exits between two observations escapes (1.2). If it stayed in runtime-agent's process group, it keeps running until Desktop stops the runtime, because `claude` shares that group and `killpg` stays off. If it started a group or session of its own, it outlives that too. A group of `claude`'s own would close only the first case, as the isolated worker's does (RA/isolated_tool_worker.rs:359; RA/isolated_tool_worker/process_tree.rs:102-105), and Phase 0 item 9 shows which case Claude Code's Bash tool produces. On a successful turn that left programs running, a status step says how many the runtime stopped: "Claude Code left N programs running when it finished; Instafy stopped them." A failed or stopped turn has no such step.

**Shutdown.**
- Electron signals the whole runtime group, `claude` included (DRA/index.ts:608-647).
- While the runtime's shutdown signal is set, the lane reports no completion. It still puts back what the turn changed under another chat's page first (3.8, step 2), a change on this computer only.
- Desktop's disposition then makes the controller fail the job as `claude_code_machine_stopped` (2.9).

**runtime-agent crash.**
- `claude` stays in the group. Desktop already covers this. When the root exits, the exit cleanup that `registerDesktopRuntime` installs (DA/main.ts:1544-1588) runs `stopAndDispositionDesktopRuntime`, which signals the still-alive group and proves it gone (DRA/index.ts:571-647) before the controller disposition. The turn's `ProcessTree` dies with runtime-agent, so a descendant that left the group survives (1.2). No Desktop change is needed, and Codex's tool processes are covered the same way.
- The disposition fails the job as `claude_code_machine_stopped` (2.9). If the controller cannot be reached, the lease lapses, the job is never leased again, and the sweep fails it.

**Sleep.**
- Heartbeats stop, and the lease lapses (it lasts at least 30 s, RC/agent.rs:5130). A sleep that ends before the lease expires changes nothing.
- Once the lease has expired, the job is failed as `run_once_interrupted` (2.9): by the new step in the 10 s sweep, whatever the space's activity, or by the run-once sweep if the idle release requeued it first (RC/runtime/status.rs:1690-1717).
- If the sleep outlasted the runtime's idle TTL (300 s by default, RA/config.rs:389-392), the stale-runtime sweep also stops the runtime (RC/runtime/sweeps.rs:96-107, 2200-2242), because an expired lease is not an active job (RC/runtime/stop.rs:499-520). That stop fails the job as `claude_code_machine_stopped` (2.9) only if the sweep has not failed it yet.
- On wake, the next heartbeat gets a 409, because the heartbeat refuses to renew an expired lane lease (2.9), and the stop path runs.

**Launch checks.** These read the `init` event. Claude Code documents `session_id`, `cwd`, `model`, `permissionMode` and `mcp_servers` as always present on `system/init`, so a missing field fails the turn as `unexpected_configuration`, the same as a mismatch.
- `session_id` is required and must be a UUID.
- `cwd` must canonicalize to the folder.
- `permissionMode` must be `acceptEdits`.
- `mcp_servers` must be empty.

A mismatch terminates the turn as `unexpected_configuration`. These checks detect a flag that did not take effect. They cannot undo a hook that already ran; prevention is the pre-flight in 3.9.

### 3.7 Mapping stream-json onto existing messages

The adapter (RA/claude_code/events.rs) turns Claude Code's lines into the Codex-exec-shaped events that the existing consumers read. The streaming handler is today a closure inside `run_apply_job_observed` (RA/jobs/mod.rs:8367-8393, repeated for the retry at 9274-9298), which a lane job never reaches (3.1). It moves into a function that both turns call. The `/terminal` lane writes a command step's metadata (`codex_command_execution`) without Codex (RA/jobs/mod.rs:3425-3446). It builds that metadata directly, with no `event` key, rather than an event for `extract_codex_messages`, so it is a precedent for the command step's shape only.

| Claude Code stream-json | Synthesized event | Consumer |
|---|---|---|
| `system` / `init` | None. Records `session_id` and `model`, and runs the launch checks. | lane |
| `system` / `task_started`, `task_notification`, `background_tasks_changed` | None. They update the live background tasks (3.6). | lane |
| Top-level `stream_event` text delta (no `parent_tool_use_id`) | `item.updated` `agent_message` `{id: "<message id>:<block index>", text: <cumulative>, phase: "final_answer"}` | `ReplyDraftStream` (RA/jobs/reply_draft.rs:76-140), with plain text allowed |
| A text block that a `tool_use` follows in the same message | `item.completed` `agent_message` with `phase: "commentary"`, and a draft reset (beside the restart on `stream.retry` at reply_draft.rs:77-84) | status step (`extract_codex_messages`, RA/jobs/mod.rs:21514) |
| Bash or Monitor `tool_use`, then its `tool_result` | `item.started` and `item.completed` `command_execution` `{command, aggregated_output (≤ 4,000 chars), exit_code: null, status}` | command step (21578); label from `command_activity` (RA/jobs/activity_labels.rs:1510) |
| Edit, Write, NotebookEdit | `item.completed` `file_change` `{paths relative to the folder, status}` | file-change step (21628); `file_change_activity` (1543) |
| WebSearch | `item.completed` `web_search` `{query}` | search step (21797); `web_search_activity` (1538) |
| TodoWrite, or where it is absent, TaskCreate and TaskUpdate | `item.updated` `todo_list` `{items: [{text: <content>, completed: <status is "completed">}]}`, the item shape the plan step and Studio read. For the task tools, the adapter keeps the list they build and sends all of it each time. With none of these tools on, no plan step appears. | plan step (21756) |
| Read, Grep, Glob, WebFetch, Agent (also Task, its name before v2.1.63) and any other tool | `mcp_tool_call` `{server: "claude-code", tool, engine: "claude-code"}` | tool step (21675). Its label comes from a new fixed table, `claude_code_tool_activity`: a quiet label for reads and searches, the web-read label for WebFetch, the generic tool label for the rest. `extract_codex_messages` uses that table only for an item with the `engine` mark, so a Codex turn's own MCP server named `claude-code` keeps the generic label. |
| Events with a `parent_tool_use_id` (Claude Code's subagents) | The same mapping, but never a draft | steps of the same turn |
| Thinking blocks | Ignored, and not logged | — |
| Top-level `result` | Nothing streamed. 3.6 says when one ends the turn. The latest one read gives the summary (its `result`) and the `claude-code/usage` artifact (its usage). | completion |
| Anything else | Ignored, but kept in the run log | — |

Rules that apply to every row:
- **Labels** come only from the runtime's own tables (packages/runtime-contracts/src/chat_activity.rs:1-13). New labels go into `chat_activity_fixtures.json`, so the runtime, the controller and Studio all check them.
- **Step metadata stores the synthesized event**, for example `"event": event.clone()` at RA/jobs/mod.rs:21666. Events therefore carry only relative paths, bounded output and redacted strings. A path outside the folder shows as "outside this space".
- **The reply** is the latest top-level `result.result` (3.6), redacted and with the folder prefix made relative. Instafy appends nothing to it. The notes that a Codex turn appends to its reply (held pages and not-saved files, RA/jobs/mod.rs:10505-10506) become separate status steps instead.
- **Notes.** Every status step the turn sends as a note of its own carries `"presentation": {"placement": "reply_note"}` in its metadata: what stayed on this computer and what its save left out (3.8), a save that failed after a good run (D-C/D-V), permission denials and programs stopped (3.6). The controller keeps a runtime's step metadata under `details`, so the hint arrives as `details.presentation.placement`, and Studio shows such notes as plain lines under the reply (5.7). The hint is generic: Studio's core reads it, never the lane's `claude_code_*` kinds.
- **Permission denials** come from `result.permission_denials` when present (unverified), and otherwise from tool results that report a denial. They produce a note, "Claude Code skipped N steps that need your OK…", whose metadata keeps the tool names (`tools`); Studio shows the sentence. The turn still succeeds.

### 3.8 Saving files

Only a successful run saves. Success means exit 0 and a `result` whose `is_error` is not true, both read as the end-of-turn rule in 3.6 says. This matches the Codex lane (RA/jobs/mod.rs:10374-10462).

1. `checkpoint_files_with_status_delta(&folder, before, &[])` (19720-19734). It already drops reserved and unpublishable paths (19750-19757). With no reported files, it returns an empty list when the baseline is missing or the final `git status` fails or hits its 10 s timeout (19725-19731; RA/jobs/workspace_change_detection.rs:19). So a turn whose baseline could not be read (3.1, step 5) ends before spawning, as a pre-turn refresh that refuses saves does (3.1, step 3), and a folder with no repository never gets this far: the pre-flight refuses it (3.9, D-A). When only the final read fails, the lane adds a note saying the turn's changes stayed on this computer and were not saved, rather than ending as if nothing changed: "Claude Code's changes stayed on this computer and weren't saved to the space: Instafy couldn't read what changed in this space's folder." (kind `claude_code_changes_not_saved`, reason `status_unreadable`). To tell that case from a turn that changed nothing, the lane reads the final status itself with the same two pieces, `collect_git_status_porcelain` and `status_delta_files_for_checkpoint`.
2. `held_pages.leave_out_held` (10384). Before any of this, once `claude` has exited and whether or not the run succeeded, a turn the runtime's shutdown ended included, `held_pages.put_back(&folder, before, TurnSteps::of_events(&folder, &events))` puts back what the turn changed under another chat's page, as the Codex turn does (8484-8498). `held_pages.artifact()` (10492) joins the artifacts.
3. **The lane filter.** Drop every path with a `.claude` segment, every `CLAUDE.local.md` and the `.mcp.json` at the folder's root, all compared as a Mac's folder compares names: ignoring case, as `is_reserved_path` does because macOS folders are case-insensitive (packages/origin-http-server/src/paths.rs:4-6), and beyond ASCII too, since APFS also opens `.mcp.jſon` (with a long s) as `.mcp.json`. The comparison is Unicode's canonical caseless match: NFD, then default case folding, then NFD again. The first two are Claude Code's per-person files, and a `.claude/settings.json` saved into the space would carry hooks onto teammates' machines. A saved root `.mcp.json` would offer them MCP servers to run and, like a saved `.claude/` path, would make the pre-flight (3.9) refuse every later lane turn in the space. Also drop every changed file whose name or content holds a token: `sk-ant-`, ignoring ASCII case, followed by at least 20 of `[A-Za-z0-9_-]` and not preceded by a letter or digit. A name is checked before the content, so a deleted file whose name holds one stays off the save too, and its path never reaches `apply/files`, `origin/apply` or a stopped turn's report. Name each such file in the not-saved status step, with the token replaced. The publish policy matches file names only (packages/origin-http-server/src/publish_policy.rs:108-129), so without this a token that Claude Code or a tool wrote into an ordinary file would be stored in the space and reach every teammate's checkout. A bare mention of the prefix does not count, so code and documents that only name it still save, as this repository's do (RA/jobs/card_text.rs:1162, RA/jobs/skill_declaration.rs:845).
4. `commit_to_hosted_origin`, with the verified workspace token (10404-10419). **A save that fails after a successful run fails nothing (D-C/D-V).** The reply is delivered with the note "Claude Code's changes stayed on this computer and weren't saved to the space." (kind `claude_code_changes_not_saved`, reason `save_failed`, with the files' paths, tokens replaced). The redacted error, with its causes, goes in an `origin/apply-error` artifact. `apply/files` then lists nothing, since nothing was saved, so Studio's files card and Undo offer nothing. A Stop that refused the save still ends as a stopped turn, as today.
5. `preview_pictures::reload_and_picture_turn_sites` (10464-10472). There are no page cards in v1, because `page_cards::post_missing_cards` (10474-10482) reads Codex events.
6. Status steps that list what stayed on this computer and what was not saved. Like every note of the turn, they carry the `reply_note` placement (3.7).

`JobExecution` is returned with:
- `provider: "claude-code"`;
- `messages_streamed`, set as the Codex turn sets it: true only if every streamed step reached the controller (RA/jobs/mod.rs:8586-8587). Otherwise the executor posts the steps again (RA/agent.rs:1759-1779);
- the lane conversation state;
- the artifacts `apply/files` (the saved files with folder-relative paths, built as `build_codex_artifacts` builds it, RA/jobs/mod.rs:21202-21223, with `metadata.provider: "claude-code"`), `origin/apply`, `claude-code/usage` and a bounded `claude-code/run-log`. Never a `codex/run-log`. Studio's file list and Undo read `apply/files`, and so does the stopped-turn report when a Stop refuses the completion (RA/agent.rs:1825-1835).

A failure or timeout saves nothing; its changes stay in the folder, as after a failed Codex turn. A Stop sends the stopped-turn report. The lane filter applies to lane saves only (D21). git-service's deny list stays reserved for build output (packages/git-service/src/policy.rs:20-42).

### 3.9 Refusals before spawning

`LaneJob::of` runs in the pre-run refusal (3.1) and again when the turn starts. It covers every check below that needs only the job and the captured grant. The workspace token's verification, the folder pre-flight and the per-turn probe run inside the turn instead (3.1, steps 2, 4 and 6): the pre-flight needs the refreshed checkout, and the token and the probe are checked where the turn uses them. The job fails without starting `claude` unless every one of these holds:

- **Grant and probe:** the grant was captured, and the per-turn probe says ready.
- **Job shape:**
  - `engine == "claude-code"` and `lease_attempts == 1`;
  - `proxy`, `controller_token`, `grants`, `grant_token` and `credential_id` are absent;
  - `workspace_token` is present and verifies.
- **Person and mode:**
  - `payload.user_id` equals the granted `INSTAFY_CLAUDE_CODE_USER_ID`;
  - `payload.metadata.input.kind == "person"`;
  - `execution_mode(&job)` is Apply (RA/agent.rs:1871-1882): `metadata.execution_mode`, and `metadata.executionMode`, which the lane's payload allowlist never carries, are absent or `apply`. The payload's top-level `executionMode` is the workspace mode, `shared_write` (2.5), and is not read.
- **Markers:** none of these is present:
  - `job_is_unattended` or `job_is_an_automations_run` (RA/jobs/mod.rs:4115-4140);
  - plan or worker markers, or the evaluation marker;
  - `plan_seed`, hand-back keys, `retryOfMessageId`, `goalContinuation` or `goal_continuation` (both spellings, as RC/job_trigger.rs:22 reads them);
  - a browser transport, `dispatchContent` or attachments.
- **Prompt:** non-empty, at most `CLAUDE_CODE_LANE_MAX_PROMPT_CHARS` (new, the same value G5 enforces, since dispatch has no prompt limit today), and not starting with `/` once leading whitespace is trimmed, as the runtime reads its own slash commands (RA/jobs/mod.rs:3124, RA/jobs/git_sync.rs:20).
- **The folder pre-flight**, run on the checkout after the pre-turn refresh. Its git commands read `.instafy/.git`, the repository the origin saves to, with the folder as work tree whenever that exists (`canonical_git_args`, RA/jobs/mod.rs:5319-5332; packages/origin-http-server/src/git.rs:634-646), otherwise the folder's `.git`. `workspace_git_args` reads a top-level `.git` first (RA/jobs/mod.rs:5315-5317, 19484-19491), which in a folder that has both is not the repository the origin saves to. Each command runs as `workspace_git_command` runs git, with hooks and fsmonitor off (19501-19515). A git command that fails refuses the turn as `preflight_failed`. A folder with neither repository (a Desktop folder with no `.git` of its own, when the controller advertises no git remote, docs/Architecture.md:41) is refused at the pre-flight's start, before it reads anything, as `preflight_failed` with the first line "This space's folder on this computer has no git repository, so Instafy couldn't tell what a turn changes." (D-A): nothing there records what a turn changes, so no turn could save or say what it changed.
  - **Project configuration (`project_config`).** No tracked path (`git ls-files`) at any depth has a segment that is `.claude`, and the folder's root, where Claude Code reads them, holds no `.claude` entry and no `.mcp.json`, tracked or not. Every name here, and `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` in the import check below, matches as a Mac's folder matches names, as in the lane filter (3.8): Claude Code opens a tracked `.Claude/settings.json` as `.claude/settings.json`, and a root `AGENTſ.md` (with a long s) as `AGENTS.md`. The root's `.claude`, `.mcp.json` and memory files are also looked up through the folder itself, which opens a name as Claude Code will, and named by the entry the folder holds. The root check covers files git does not list because Claude Code reads the folder, not git's index, and earlier turns leave such files uncommitted: a stopped or failed turn saves nothing, and the lane filter keeps `.claude/` out of every save (3.8). It therefore also refuses the person's own `.claude/`, such as the `.claude/settings.local.json` of their interactive Claude Code sessions or Claude Code's worktrees, and a `.claude/` file an earlier lane turn wrote; the failure text names each path it refused, relative to the folder, and the `project_config` sentence (5.5) sends the person to Details for them. If Phase 0 item 10 shows that a `-p` run itself writes under `.claude/`, this check needs a rule for those files before enabling, or every lane turn after the first is refused. Untracked and ignored files below the root, such as a nested `.claude/` or `CLAUDE.local.md`, are kept out only by the flags. This is the by-construction defence in case `--setting-sources user` or `--strict-mcp-config` behaves differently than expected (D6).
  - **Imports (`unsafe_import`).** Check every tracked `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, those at the folder's root whether tracked or not, and every file they import, followed recursively with a bound. From v2.1.277 Claude Code reads `AGENTS.md` as project instructions, at the root and in subdirectories, and expands its `@` imports. No path that a word after an `@` could import, anywhere in such a file, code, HTML and comments included (below), may be in the home folder (`~/…`), be absolute below an entry the filesystem's root holds, lead out of the folder to anything but a folder above it, resolve outside the folder after following symlinks, or resolve, after following symlinks, to an existing file that git does not track. An untracked or ignored file such as `.env` exists only on this computer, because the publish policy never saves it (packages/origin-http-server/src/publish_policy.rs:110-123). So a teammate's `@.env`, or an import of a tracked symlink that points at it, would put the person's own secrets in front of a turn whose reply everyone reads. This closes only the import route: Claude Code's own tools can still read such a file when a teammate's words ask them to (end of this section). The seeded CLAUDE.md imports `@AGENTS.md` and `@INSTAFY.md` (packages/runtime-agent/assets/instafy/CLAUDE.md:1-2), which teammates can edit, so the walk must follow those imports too.
    - **Paths outside the folder.** Claude Code reads `~` as the home folder only before `/`, so the pre-flight reads any other `~…`, such as the version range in `zod@~3.22.4`, as a relative path like any other. Absolute paths and paths out of the folder have their `.` and `..` read as written, as Claude Code resolves a path. Of an absolute path, only the root's own entry is looked up, by the path's first name as written and in NFC, the form Claude Code gives every path it resolves. A path whose first name the root does not hold names nothing, so a path alias such as `@/components/ui/button` passes, and so does `@/` alone, while `@/etc/hosts` and `@/components/../etc/hosts` are refused. A path out of the folder that ends at a folder above it, such as `@..`, names a folder, which loads nothing; any other, such as `@../README.md`, is refused without a lookup. Nothing deeper outside the folder is looked up: every member can read a refusal's text through the message history (5.5), so a deeper lookup would tell them which paths exist on the person's computer, and looking up a path a teammate wrote can mount a network share (`/net/<host>`), raise a macOS privacy prompt or reach a per-process path such as `/dev/fd/N`, which runtime-agent sees otherwise than `claude` does.
    - **Instafy's own seeded files (D-B).** The untracked rule does not apply to the root `AGENTS.md` and `INSTAFY.md`. The Desktop scaffold writes them and commits them only into a new or seed `.instafy/.git`, so in a folder whose repository is the person's own `.git` they are untracked, and every turn would otherwise be refused. The exemption holds only when an import resolves to the very file the root holds under one of those names (compared as the folder compares names), a regular file and never a link, and never because of the name the import was written with. The pre-flight finds those files once, from the root's entries as they are when it starts. Every other rule still applies to them, and their own imports are walked with every rule, the untracked one included.
    - **A memory file that is a link** counts as an import of its target. It must resolve inside the folder to a tracked file or to one of those seeded root files; otherwise the turn is refused as `unsafe_import`, for example "AGENTS.md links to .env". A target outside the folder is named only as "a file outside this space", since its path can name the OS user. This also refuses the person's own root `CLAUDE.local.md` that links out of the folder.
    - **What counts as tracked.** A file counts as tracked when git's index lists its path or, where the index spells a name otherwise than the folder does, lists a path the folder reads as the same name whose own folder entry is that file. A tracked link to the file never counts: on a case-sensitive folder, a teammate's tracked link `Credentials.json` that points at the person's untracked `credentials.json` leaves that file untracked, and an import by either name is refused.
    - **Where an import resolves from.** A file's imports are resolved from the path that brought the file in, as written, and from the file's own place once links are followed, since Claude Code may resolve either way. Either reading that is unsafe refuses the turn.
    - **How imports are read (D-L).** Not as Markdown. One pass over the file's text finds every path Claude Code could import from it, and more, so code spans, code blocks, HTML and comments are read like any other text:
      - A carriage return, alone or before a line feed, ends a line, as Claude Code reads it.
      - Every `@` starts a word, whatever comes before it, since in Claude Code's reading a word also starts where a Markdown token starts, and a token can start anywhere. An email address or `pkg@1` gives a word too; one that names nothing, or a folder, loads nothing.
      - A word runs to white space as JavaScript reads it (U+FEFF is white space, U+0085 is not), or to a backslash that escapes no space, so `@docs\notes.md` gives only `docs`, as it does for Claude Code. An escaped space (`\ `) is part of the word.
      - Its candidates are the word and each part of it from its start up to an ASCII punctuation character, without that character and with it, each with its escaped spaces read as spaces: a Markdown token can end there, and Claude Code cuts a path at its first `#`.
      - A word that stops at `\[` or `\]` is read again with them as brackets: in a link's text, Claude Code's Markdown reads them as `[` and `]` before it reads the words, so `[@x\]/../.env](u)` imports `.env`.
      - Each word is also read with its HTML comments removed, once with each comment closing on the line of the word's `@` and once closing anywhere, as Claude Code removes the comments of an HTML block that opens with one: `<!-- a -->@.e<!-- b -->nv` imports `.env`.

      A refusal names, for each word, the longest of its candidates that may not load, such as "AGENTS.md brings in @x]/../.env". The reading was checked against the import loader of Claude Code 2.1.321, whose Markdown keeps text as written; a Claude Code that decoded entities such as `&amp;` before reading words would need it checked again.

      It is stricter than Claude Code, which skips code, needs white space or a token's start before an `@`, and imports one path for each word. So a memory file can refuse every turn in the space with words Claude Code never imports (D-L): a path the rules above refuse, written in code or after other text, such as `curl -d @/tmp/body.json`, `cat @../README.md` or a `@~/components` path alias in a code block; and a part of a word, such as `.env` in `@.env.example`, which refuses every turn of anyone with an untracked `.env`, though Claude Code reads only `.env.example`.
    - **What reading may cost.** Each character a word reading scans, and each byte of each candidate, is spent from a budget of 16 per byte of the file plus 4 MiB. An ordinary file costs a few per byte, and the allowance lets a short file's few long lines be read, such as minified JSON in a code block, where each `@` starts a word that runs to the line's end. A file built to cost more, with words cut in many places or each starting inside the one before, is refused as `preflight_failed` ("… has too many @ imports for Instafy to check what it brings in.") rather than read in part. So is a file with a word of more than 4,096 characters ("… has an @ import too long for Instafy to check what it brings in."): Claude Code resolves `..` as written, so a word of any length can name a short path (`@aaaa…/../.env`), and a word is never cut short.
    - **Bounds.** Imports are followed 5 deep, as Claude Code follows them. Each file is read once, by its own path with every link followed, however many paths reach it, and its imports are resolved from each of them. More than 512 files to follow, a memory file over 1 MiB, or more than 20,000 candidates to resolve in one pre-flight refuses the turn as `preflight_failed`, the last with "This space's CLAUDE.md and AGENTS.md files have too many @ imports for Instafy to check what they bring in."; both counts take a file once for each path that reaches it.
  - **Links (`unsafe_link`).** No tracked symlink (mode 120000 in `git ls-files -s`) resolves outside the folder.
  - **Deadline and Stop.** The whole pre-flight has 60 s, of which its git command may take 30. A folder it cannot check by then is refused as `preflight_failed` ("Instafy took too long to check this space's folder."). A Stop while it runs ends the turn at once, as a Stop before the spawn does: a lost lease, with no completion and no report, and the job's locks are released, so the next turn on the computer runs. Either way its git command is killed, and the work left on its blocking thread stops at its next file or link. The runtime's own shutdown signal does not end it: it runs on to its end or its deadline.

  The pre-flight keeps a teammate's settings, hooks, MCP servers and out-of-folder imports from loading. It cannot keep a teammate's words in a file Claude Code reads (`AGENTS.md`, a README or code comments, which it opens as ordinary files) from steering it within what the person's own Claude Code allows. Claude Code can read this folder's untracked files, such as `.env`, without asking, and put them in a reply everyone reads or in a file the save publishes. It can also run repository code through the person's allow rules or hooks (`npm test`, or a formatter hook that loads `eslint.config.js`). So the limit that a teammate's files cannot make the person's Claude Code run their code or leak private files holds only partly. Codex turns on the same computer already have this exposure, with full access (RA/codex.rs:13630-13632). As the owner decided on 2026-11-13 (1.2), v1 documents this as how Claude Code behaves in a folder that others write to, and it is not a release gate. The consent dialog (4.2) states it in plain words. The option that narrows it is to allow the lane only in spaces where only the sender can write. That narrowing would still leave text that others wrote earlier, or that came with an imported repository.

---

## 4. Desktop

### 4.1 Finding the binary

**The feature module.** A typed Desktop feature module (new, DA/claudeCode/) is registered in `APPLICATION_DESKTOP_FEATURE_MODULES` (DA/publicDesktopFeatureManifest.ts:3-4, empty before the lane). The renderer calls its methods through the existing `instafy:desktopExtensionInvoke` (DA/main.ts:2864-2874; registry in DA/desktopExtensionRegistry.ts). It adds no IPC channel of its own. Today a method receives only the renderer's `payload` (DA/desktopExtensionRegistry.ts:10-12; DA/main.ts:2868-2872), and `readConfig`/`writeConfig` are private to DA/main.ts (479-493). So the registry gains a host context that main.ts passes with every call: the user id of the session read from the calling top-level frame (`resolveVisibleSupabaseSession(event)`, DA/main.ts:203-229, checked as at 931-933), the trusted controller origin, and a consent store. A user id in the payload is never a key, as for the Personal Browser (DA/personalBrowserIdentity.ts:159-161).

**Whose record: a trust assumption.** The check at 931-933 decodes the session token's payload and compares it; it does not verify the token. So Desktop trusts the Studio page's session as the key of the local consent record. Script running in Studio's top frame (main.ts refuses subframes) could name another Instafy user of this OS account, then learn whether that user turned the lane on and the path, remove that record without a dialog, or, if the person confirms a native picker or a consent dialog that names an email the page chose, create or retarget it. Nothing more follows. A grant resolves only for a runtime's bound user, whose token the controller verified when it minted the runtime token, so no turn, grant or credential is reached, and such script already holds the person's own session. Attesting the session through the controller before a write, as the Personal Browser does (DA/personalBrowserIdentity.ts), is a follow-up.

**Methods:**
- Every method answers `{supported, found, path?, consented, problem?, candidatePath?, candidateProblem?, shellSetting?}`. Studio drops fields and values it does not know, so a Desktop and a Studio of different ages still work together, and the older side just says less.
  - `supported` is true only on macOS in v1 (D18), and elsewhere the module grants nothing (4.3).
  - `found` holds exactly when there is a `path` and no `problem`.
  - `problem` is a validation code (below), `not_found`, or `shell_setting_unusable`, with `shellSetting` naming the variable (`CLAUDE_CONFIG_DIR` or `NODE_EXTRA_CA_CERTS`) and never its value.
  - While a consent record exists, `path` and `problem` are the record's, whatever the method, so a change the person kept from being made (4.3) never shows as made, and a find that is not in use never shows as in use. What the last Find or Locate turned up shows beside it as `candidatePath`, with its own `candidateProblem` (a validation code, or `not_found` for a Find that found nothing), when it is another program. The program in use shows there too, with no `candidateProblem`, when Find's login shell answered with values that pass while the recorded ones no longer do, and Find turned up that program or no program at all, as when the shell's `claude` is an alias or a function (below). A Find that turned up another copy, from the login shell or from the usual install folders it checks when the shell names no path, shows that copy instead, with its problem if it has one, and renews nothing. A Find whose login shell gave no answer (a timeout, the output cap, missing markers, a shell /etc/shells does not list, or one that fails to start) read no values, so it never offers new ones; a copy it finds in the usual folders shows only when it is another program.
  - The path is shown only on this computer and is never sent to the controller. No method returns a login-shell value.
- `status`, which is read-only: it runs only after any consent change before it has settled (4.3).
- `detect`.
- `locate`: a file picker. Without a Find for this account in this Desktop session, it runs the login shell as `detect` does, so the grant carries the person's PATH and D26 values; a shell that fails leaves them empty, as for Find. While the lane is on, a usable pick changes the path in use at once, with no second dialog, since the person chose the file in a native picker, and the runtime is replaced as for any consent change (4.3). A pick of the program in use keeps the last Find when it turned up that program, or no program while its login shell answered, since its login-shell values may be what the record needs, and drops any other Find. A pick Desktop can't use changes nothing.
- `enable`: the native consent dialog (4.2). With no record, it confirms the latest Find or Locate. While the lane is on, it confirms only what the answer offers: another program, or new values for the program in use, which it records as that program with the Find's PATH entries and D26 values. The dialog lists the program and the values, as for any consent; the PATH entries go only into the record. Otherwise it confirms the record as it is. It refuses without asking when the program or a login-shell value fails its checks.
- `disable`.

**`detect`.** It runs when the person clicks. Packaged apps get the GUI PATH, and nothing in DA or DRA resolves a login-shell PATH (DRA/index.ts:849-853 passes Electron's environment as it is). So `detect` runs the person's login shell once:
- the shell comes from `os.userInfo().shell` and must be listed in /etc/shells;
- it is invoked with `-ilc`, printing `command -v claude`, `$PATH` and the values of `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` (D26) between markers;
- with a minimal environment (`HOME`, `USER`, `SHELL`, `LANG`), cwd set to `HOME` and stdin ignored;
- with a 10 s timeout and a 64 KiB output cap.

Only an absolute path counts: an alias or a shell function prints something else and is treated as not found. The PATH and D26 values such a shell printed are still its answer.

If that fails or names no absolute path, `detect` stats these candidates and reports only what it finds: `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and `/usr/local/bin/claude`. These locations are unverified. Nothing under `~/.claude` is a candidate, though the person can still pick any file with Locate.

**Static validation.** Desktop never runs, opens or hashes the binary. It checks that:
- the realpath is a regular file and executable;
- it, its directory, the chosen path's own directory and every symlink on the way are owned by the user or root;
- none of them can be written by anyone else, apart from the `admin` group (the rule in 3.2);
- it is not inside the workspace root, a per-project folder (`config.projectWorkspaceDirs`, DA/main.ts:3039), the app bundle or `~/.instafy`.

Desktop stores the symlink path, not its target, so Claude Code's own updates keep working. runtime-agent validates the path again (3.2).

It checks the D26 values the way runtime-agent does (3.2), because the runtime refuses the whole grant as `binary_unsafe` for one value that fails, and Studio could then only blame the program. A `CLAUDE_CONFIG_DIR` must be a directory and a `NODE_EXTRA_CA_CERTS` a regular file. Each must be an absolute path whose links, followed one component at a time, are owned by the user or root; its target must be owned by the user or root and writable by nobody else, with no `admin` group allowance; and it must not be in a folder Desktop owns, as written or resolved. Desktop checks them at `detect` and `locate`, at `status`, the record's own values included (so a CA file deleted after consent is named precisely), and at `enable`, before the dialog and the write. A value that fails gives `shell_setting_unusable`.

Desktop never opens anything under `~/.claude` and never touches the keychain.

### 4.2 Consent

`enable` shows a native `dialog.showMessageBox` from the main process. Studio's web content can ask for it through `instafy:desktopExtensionInvoke`, but it cannot answer or fake it. The dialog is for the host context's verified user (4.1) and names that account by its email, so the session read (DA/main.ts:195-199) also returns `user.email`. The text:

> **Use Claude Code on this computer for {email}?** When you choose Claude Code for a message in Instafy, Instafy Desktop starts the `claude` program on this computer, signed in the way you signed in to it yourself, to carry out that one message. It runs under Anthropic's current terms, and that sign-in may bill your Claude plan or your own API or cloud account. Only your own Instafy account can start these turns, one at a time. Instafy gives Claude Code your message exactly as you wrote it and adds nothing. Everyone in the space can read the steps it takes and its reply. Claude Code uses your own Claude Code settings, including what you've allowed it to run without asking, except that it changes files in this space's folder without asking, whatever your own setting says, and skips anything else that would need your OK. What others wrote in this space's files can steer it within those settings: it may copy files kept only on this computer, such as `.env`, into its reply or into files saved to the space, and run the space's code through commands or hooks you've allowed. Instafy never reads, stores or sends your Claude sign-in. Only turn this on if the Claude account signed in on this computer account is yours.
>
> Buttons: **Use Claude Code** / **Cancel**

The consent record is `{binaryPath, pathEntries, env, consentedAt, osUser}`, where `env` holds the D26 values `detect` found; the dialog lists them below its text. It lives in Desktop's own config (`readConfig`/`writeConfig`, DA/main.ts:479-493), keyed by controller origin and Instafy user id. It is never sent to the controller. Turning it off removes the record.

As built, the dialog's text is plain (the backticks above are this document's), it lists the program ("Program: …") and the login-shell values ("From your login shell: …") below the text, and Cancel is its default button. Desktop never shows it for a program or a value that fails its checks (4.1).

### 4.3 Passing it to the runtime

**A new typed contribution.** DA/desktopExtensionRegistry.ts, which today has only `desktopExtensions` (20-22), gains `desktopRuntimeLaunchGrants: [{ id, protectedEnvKeys, resolve({projectId, controllerOrigin, instafyUserId}) → {env, localEngine} | null }]`. The Desktop shell applies these grants without knowing what product they belong to (AGENTS.md:12-13).

**When grants are asked for.** `instafy:startDesktopRuntime` (DA/main.ts:2876-3195) asks each contribution for its grant only when all of these hold:
- the start is bound to the visible session: Studio asked for ambient credentials, and `assertDesktopControllerStartSessionBinding` (DA/desktopControllerTrust.ts:72-86, called at 97) matched its token to the session read from the calling frame (DA/main.ts:931-933). The grant is for that session's user. Packaged Desktop keeps the user id in the runtime's ambient provenance (DA/desktopRuntimeActivity.ts:21-23). Unpackaged Desktop records `fixed` provenance, which has none (`allowAmbientRefresh: app.isPackaged`, DA/main.ts:940; DA/desktopControllerTrust.ts:98-100), so `resolveDesktopRuntimeControllerCredentialProvenance` (DA/main.ts:906-944, used at 2974-2983) also returns the bound user id, and the runtime record (DA/main.ts:841-850) keeps it;
- that user has consented;
- it is not a Personal Browser start, whose runtime never offers the lane (3.2). Its declared keys are still stripped, and a consent change never replaces a runtime bound to the Personal Browser.

A start that asked for fixed credentials skips the binding (DA/main.ts:928-930) and gets no grant. Granting a bound start that Desktop keeps fixed is what lets the lane run in an unpackaged build, which accepts only a loopback controller (DA/desktopControllerTrust.ts:58-62): in development against a local stack, and in a self-hosted setup that runs such a build against its own controller on the same computer. Packaged Desktop accepts only https://controller.instafy.dev (DA/desktopControllerTrust.ts:3, 49-55), so no other controller can offer the lane to a packaged build.

**Applying them.**
- `applyProtectedDesktopRuntimeEnv` (DRA/index.ts:240-283) gains a generic `launchGrants` option. It first deletes every declared key from the inherited environment, as it already does for `RUNTIME_ID` and the Personal Browser keys (250-255). Then it sets the granted values. The declared keys of every registered contribution are stripped on every start, including starts that get no grant (no binding to the visible session, no consent, another user), not only when a grant resolves.
- It runs after `childEnv` merges `process.env` and `options.env` (849-867), so neither a parent shell nor the generic environment bag can inject these keys.
- `buildRuntimeTokenRequestBody` (285-303) adds the grant's `localEngine` (2.10).
- Grants stay out of `DesktopRuntimeRestartOptions` (DA/main.ts:836-839). `resumePersonalBrowserRuntime` (1640-1668), the other path that starts a runtime, replays those options without going through `instafy:startDesktopRuntime`, so it starts without a grant.

**The granted keys:** `INSTAFY_CLAUDE_CODE_BIN`, `INSTAFY_CLAUDE_CODE_PATH`, `INSTAFY_CLAUDE_CODE_USER_ID` and `INSTAFY_CLAUDE_CODE_ENV_JSON` (the record's `env`, as a JSON object).

**Restarts.** The restart check compares grants the way it already compares Personal Browser credentials (DA/main.ts:2985-3019). Turning the lane on or off, or changing the binary path, must restart the runtime too, and nothing does that today. The check runs only when Studio calls `instafy:startDesktopRuntime`, which it does only from the Start button and the Personal Browser bridge (FE/screens/StudioLayout.tsx:2318-2345; SC/usePersonalBrowserBridge.ts:577), and registration renewal keeps the scope (2.10). So once a method of a feature module that also contributes `desktopRuntimeLaunchGrants` returns, the shell's invoke handler (DA/main.ts:2864-2874) resolves that module's grant again for the running runtime's project, controller origin and user. Only when the result differs from the grant the runtime was started with does the shell replace the runtime, as `instafy:startDesktopRuntime` would from the runtime's own start options, and it fences and asks as 4.4 describes even when the old runtime had no grant. A change that leaves that grant as it was, such as another Instafy user's, restarts nothing, and no Studio page needs to call start. Until the replacement, the old runtime keeps its grant, its scope and its capability. If the person chooses **Keep working**, the shell puts the consent store back as it was before the method ran and reports the change as not made, so Studio never shows the lane as off, or on a new path, while the running runtime still holds the old grant.
- The refusal reads "Instafy is still working on this computer, so that change was not made." Its error carries no name of its own, so that sentence is all Electron passes to the page after its "Error invoking remote method" prefix, and Studio strips a leading `<Name>Error:` too.
- The replacement starts with a session token read from the Studio window after the old runtime stopped and right before the new start, used only when it belongs to the runtime's bound user, and otherwise with the token the runtime kept, which the fence's refresh may have renewed. The token read when the method began may have expired while a consent dialog stayed open.
- A replacement that fails once the change is made, such as a start that fails, is logged, and the method's answer still returns: the change stays made, and Studio shows the space as not running on this computer, with its Start action.
- A read-only method (`status`) of such a module runs inside the runtime lock, after any consent change before it has settled, so a status read during a Keep-working question never answers with a change that is then put back.

### 4.4 Process lifetime

The process chain is Electron → runtime-agent (in its own process group, DRA/index.ts:878-887) → `claude` (in the same group).

- **Stopping the runtime.** Desktop sends SIGINT to the group, waits 5 s, sends SIGTERM, waits 2 s, then sends SIGKILL. It proves the group is gone (DRA/index.ts:374-376, 571-647) before it tells the controller (DA/main.ts:1067-1097).
- **Quitting.** The existing wait-for-jobs dialog applies (DA/main.ts:1099 onward).
- **Replacing the runtime.** Desktop runs one runtime at a time. A start for another space, user or credential replaces it (DA/main.ts:3020-3031), and so does a consent change that alters its grant (4.3).
  - New: when the runtime being replaced was started with any launch grant, or a consent change replaces it (4.3), Desktop first fences it (`fenceDesktopRuntimeForDrain`, 1022-1032) and reads its count of active jobs.
  - If a job is running, Desktop asks natively: "Instafy is still working on this computer. Stop it and continue?"
  - Choosing **Keep working** resumes the runtime (1034-1044) and refuses the new start.
  - If the fence call fails, the count is unknown, and Desktop asks as the quit path does (1157-1169, 1323-1331); it never replaces silently. After a user switch this is the usual case once the old user's token expires, because that token cannot be refreshed from the new user's session (DA/desktopRuntimeActivity.ts:64-79).
- **Sleep** is covered in 3.6.

### 4.5 Another Instafy user on the same OS account

- A different Instafy user replaces the runtime (DA/desktopRuntimeActivity.ts:35-62; DA/main.ts:2985-3031).
- The new user has no consent record, so their runtime gets no grant, no scope and no capability. Studio shows "Set up Claude Code on this computer".
- If that user consents, the dialog adds: "Another Instafy account on this computer account also uses Claude Code. Claude Code turns run on whichever Claude sign-in this computer account has. Only continue if it is yours."
- The runtime's person check (3.9) and the lease clause (2.4) keep each user's lane jobs off the other user's runtime.
- Earlier sessions are not resumed across users, because the runtime and the person differ (2.7).
- Instafy cannot tell whose Claude sign-in is in `HOME`. Consent is the person's statement that it is theirs.

---

## 5. Studio

### 5.1 The per-turn choice

- **Feature slot.** `FrontendFeatureContributions` (FE/features/frontendFeatureModule.ts:50-63) gains a typed `turnEngines` slot. The lane lives in FE/features/claudeCode/ (new) and is listed in FE/features/publicFrontendFeatureManifest.ts and in the manifest the hosted Studio is built with, because a packaged Desktop shows the hosted Studio (DA/main.ts:171, 361-362) and that build can select its own manifest (packages/frontend/featureManifestSelector.ts:32-49). As built, only the public manifest lists it (D-E): listing it in packages/frontend/hosted/hostedFrontendFeatureManifest.ts needs two release guard tests changed, scripts/release/web/build-hosted-web.test.mjs, which pins that manifest's list, and scripts/release/web/workflow-guard.test.mjs, which forbids the string "claude" in the file. That moves to phase 8, and until then a packaged Desktop shows no row. The presentation and Your AI row slots (`presentation`, `YourAiRow`) sit on the contribution's type itself (`FrontendTurnEngineContribution`). The core composer renders the menu row, the token and the send gate from the contribution. The contribution also supplies everything else that is specific to Claude Code: the submit routing and its blocked cases (5.2), the Your AI row (5.3), the failure, refusal and steer sentences (5.5), the retry, queue and stash exclusions (5.6) and the speaker label (5.7). Where those sections name a core file, that file gains only a generic hook keyed on the engine id (`turnEngine` on a send, `aiAccessMode` on a message). It holds no Claude Code logic or wording of its own (AGENTS.md:12-13), just as the Desktop shell applies launch grants without knowing their product (4.3).
- **Where it is offered.** Only inside Desktop (`window.instafyDesktop`), in v1 only on macOS (D18), and only for a viewer whose space status carries `claudeCodeLane` (2.10). The Your AI row (5.3) follows the same rule. It can be chosen only when this Desktop's own runtime for the space reports `claudeCode.ready` in its status entry; otherwise the row shows disabled, with a reason (5.3). That runtime is the one whose id Desktop's start call returned (DA/main.ts:3014-3018, 3163). The lane therefore runs on the computer the person is sitting at.
- **Menu row.**
  - Title: "Claude Code for the next message".
  - Description: the plan or sign-in line (5.4).
  - Hint, under the description: "Instafy gives Claude Code only your message. Everyone who can see this chat sees its steps and reply."
  - testid `composer-action-menu-claude-code`, with a "Next" badge while the choice is pending.
  - It is a sibling of "Ask AI for a new tab" (SC/ComposerActionMenu.tsx:406-424).
- **Token.**
  - Label: "Claude Code · next message", with a cancel action labelled "Don't use Claude Code".
  - testids `composer-claude-code-token` and `composer-claude-code-cancel`.
  - It generalizes `ComposerContextToken` (SC/ChatComposerSurface.tsx:262-293).
- **One message only.** The choice is used once. As built it reaches the submit flow as `options.turnEngine` rather than through `ChatSubmitOverride` (SC/chatSubmitPlanning.ts:17-25), and the engine's routing then supplies the runtime override and metadata, as the Personal Browser routing does. It is:
  - never sticky;
  - never an agent setting, because agent settings reach automations, plans and evaluations;
  - never stored in the send queue or in stashes. `SC/chatSendQueueStorage.ts` and `SC/chatMessageStashEnvelope.ts` strip it.

### 5.2 Submitting

`resolveClaudeCodeSubmitRouting` sits beside `resolvePersonalBrowserSubmitRouting` (SC/useChatSubmitFlow.ts:90-106, 463-564). It applies only to the composer's own Send of the draft it shows (Enter or the send button, SC/ChatPanel.tsx:2515-2529, 2780-2786). Any send another caller makes with a `ChatSubmitOverride` goes out without the claim and leaves the token pending. That covers undo (SC/ChatPanel.tsx:2486-2492), the goal's help prompt (2544-2560), selection replies (3931-3935), Try again (SC/useRunFailureRetryActions.ts:145-164) and the send queue's Send now and drain (SC/useChatSendQueueActions.ts:200-210, 512-532). Nothing tells such Instafy-written text from typed text later, neither the controller's G3 keys nor the runtime's markers, so this one rule keeps it off the lane. As built it is one pure helper, `composerTurnEngineFor` (SC/composerTurnEngine.ts), which ChatPanel uses and tests cover caller by caller: the composer's own Send and a restored stash carry the choice, and every override or automatic send carries nothing. For the composer's own Send, all of these must hold: the send is not `automatic`, the intent is `send`, AI is required, it is not a terminal command, there are no attachments, the conversation has no `threadKind` (G5 refuses learn, agent and automation threads), and the only target is @octo. In such a thread the composer shows the row disabled, with that reason (5.3), so the choice cannot be made there. It then:
- sets `runtimeOverride` to Desktop's own runtime, with `preferRuntime: false`;
- adds `turnEngine: "claude-code"` and `agentSelection: {active: ["octo"], mentions: ["octo"]}` to the metadata. The submit flow overwrites `agentSelection` with the one it resolves from the text (FE/conversations/useConversationSubmitFlow.ts:760-786); for a send that carries the claim, it keeps the lane's own;
- keeps `input: {kind: "person"}`, which `withPersonInput` (80-88) adds;
- is resolved before the group-participation preflight (SC/useChatSubmitFlow.ts:423-437). For a send that carries the claim, that preflight returns `unchanged` with `groupParticipationPreflight: {status: "bypassed"}`, as it does for a browser task (FE/conversations/useConversationSubmitFlow.ts:210-217). That status also stops the conversation layer's own participation check (825-945), so neither check can turn a lane send into a message that is only recorded;
- never sends the message to a model for the chat's title. Today the first message of a chat with a default title also goes, through the proxy, to the person's own AI connection for a title (FE/conversations/useConversationSubmitFlow.ts:947-948; RC/credentials.rs:1318-1338). That call, and the two effects that later take a chat's latest user message as its title seed (FE/conversations/useConversationAutoTitle.ts:176-184; FE/conversations/useConversation.tsx:182-194), pass over a message that carries the claim or `aiAccessMode: "claude-code"`. So nothing Instafy runs for a lane send calls a model (7.2).

While the token is pending, the composer's own Send is blocked with a notice whenever a condition above fails, and the text is kept; it never goes out without the lane. It is also blocked for a pending new tab, because that send dispatches Instafy's wording in place of the text (SC/chatSubmitPlanning.ts:131-140), and G3 refuses that as `dispatchContent`. It is blocked from a browser's own composer, Shared or Personal (SC/useChatSubmitFlow.ts:466-481, 549-564), because G3 refuses its `browserTransport` as a special dispatch (RC/dispatch.rs:3867). It is blocked in a thread (`threadKind`), which G5 refuses. It is blocked when it would open a private chat's invite prompt (SC/useChatSubmitFlow.ts:840-864), as a Personal Browser task already is (853-859): the prompt's later send carries neither the metadata nor the runtime (SC/useChatInvitePromptHandlers.ts:67-73, 103-109), so it would go out as an ordinary turn. These cases are blocked too:
- Queue or Steer: the Steer primary action (SC/composerSendMode.ts:19-37), or a Queue send from the menu or the Enter action (SC/ChatPanel.tsx:2780-2786, 6985-6987);
- attachments;
- a `/` command;
- a send marked `automatic` whose own metadata carries the claim (an automatic send without the claim goes out as usual, and the token stays pending);
- a runtime that is not ready;
- a busy chat: @octo is still replying here, or a message is still sending, so `runChatSubmitPreflight` would queue the send (SC/chatSubmitPreflight.ts:494-526). The lane checks this before that preflight runs. `enqueueChatSendQueueItem` (SC/ChatPanel.tsx:4399-4433) also refuses an item that carries the claim, because the in-memory queue keeps the full metadata and SC/chatSendQueueStorage.ts sees only what is written to localStorage.

A blocked send is never re-routed to another engine. The `credentialsReady` and `outOfCredits` checks do not apply to a lane send, in either place that makes them: the send button (SC/chatComposerAffordances.ts:69-80) and the submit preflight, which otherwise opens the AI gate or the credits panel (SC/chatSubmitPreflight.ts:453-460, fed at SC/useChatSubmitFlow.ts:785-800). While an engine is chosen, the draft does not count as needing Instafy's AI (`resolveChatInputRequiresAi` with `turnEngineChosen`), so the AI gate neither checks Instafy's AI for it nor shows its card in the chat.

While the token is pending, nothing else sends the draft, and nothing reads it to a model:
- A dictated voice message stays in the composer instead of sending itself, and so does one that was already listening or transcribing when the engine was chosen. It goes out only through the composer's own Send, which routes or blocks it, so voice never sends to the lane by itself and never sends past the token on another engine. Once held, it never sends itself later, whether the person's own Send uses the choice or "Don't use Claude Code", a Stash or a lost offer drops it: only the person's own Send sends its words.
- "Use Instafy AI" in the AI wizard, and the send that follows connecting an AI there, leave the draft and the token in place.
- Inline completion asks no model for ghost text.

### 5.3 Readiness and setup

- **Status data.** `ControllerRuntimeStatusEntry` (FE/services/runtimeController/runtimes.ts:29-91) gains `claudeCode`, parsed as strictly as `skillPacks` is (103-126; mapping at 206-241). It reaches the composer through `RuntimeMenuOption` (FE/runtime/useRuntimeMenu.ts:22-42).
- **Your AI (Desktop on macOS only, in v1).** A status row, "Claude Code on this computer":
  - Like the Instafy AI row, it is not a credential (SC/CredentialsSettingsCard.tsx; docs/Settings-UI.md). Unlike that row, which can be the default (docs/Settings-UI.md:708-715), it is never the default and has no Make default action.
  - It shows "Found at …" or "Not found", with the actions Find, Locate…, **Use for my messages** (which opens the native consent dialog) and Turn off.
  - It shows "Found at …" also when the only problem is a login-shell setting Desktop can't use (`shell_setting_unusable`, 4.1), and names the setting: "Your login shell sets CLAUDE_CONFIG_DIR to something Instafy Desktop can't use. It must be the full path of a folder that only you can change. Fix it, then choose Find." (for `NODE_EXTRA_CA_CERTS`, "of a file").
  - While it is on, what the last Find or Locate turned up (4.1) shows as a second line: "Also found at …" with "Choose Use for my messages to use it instead." or the reason Desktop won't use that copy; "Find didn't turn up any other copy. Your messages keep using this one." when Find found nothing; or, when the copy in use needs login-shell settings Find read anew, "Find read new settings from your login shell that Instafy Desktop can use with this copy. Choose Use for my messages to use them." In that last case the row drops the recorded setting's sentence, which no longer describes the shell and whose "choose Find" is done, and shows the runtime's readiness instead. The new-settings line also shows for a copy the person located because their login shell's `claude` is an alias or a function, as long as Find turns up no other copy: a copy in the usual install folders shows as "Also found at …" instead, or with the reason Desktop won't use it. It never shows after a Find whose login shell gave no answer, and once the new settings are confirmed, the second line reads "Find didn't turn up any other copy. Your messages keep using this one." again. For a copy or settings Desktop can use, it offers Use for my messages beside Turn off, which confirms them through the consent dialog.
  - After an action Desktop refused, it reads the status again, so a change the person kept from being made never shows as made.
  - It shows the runtime's readiness, with a remedy when it is not ready.
  - It never appears in the credential connect modal. The smoke test at packages/frontend/tests/playwright/smoke/credential-device-auth-generic.spec.ts:179 stays as it is.
- **Disabled composer row.** The row is shown disabled, with a reason, when the space is not running on this computer (with the existing Start action), when the lane is not set up, when the capability says not ready, or in a thread (5.2).
- **First use.** A one-time note: "Sign in to Claude Code on this computer first: run claude in a terminal once."

### 5.4 Wording

- A lane surface says "Runs on your own Claude plan, under Anthropic's current terms." only when this computer's runtime status entry says `planSignIn: true` (2.10). Otherwise it says "Uses your own Claude Code sign-in, under Anthropic's current terms."
- No surface says "included", "free" or "unlimited", or mentions credits.
- There is no Anthropic logo. `AnthropicIcon` (FE/components/ProviderIcons.tsx:13) stays unused (D28).

### 5.5 Failure messages

Rules:
- Every sentence follows docs/Chat-Activity.md:95-98. None says "upstream", "provider", "credential", "runtime", "switch", "Codex", "workspace" or "request".
- Send refusals write no message (2.2), so they are keyed on the POST's error code. `sendControllerConversationMessage` (FE/services/runtimeController/conversations.ts:1067-1073) throws a `ControllerApiError` (FE/services/runtimeController/core.ts:104-118), which keeps the code and `details`, where today it throws a plain `Error` that holds only the text. Every `claude_code_*` code in 2.2 has a sentence. So does `dispatch_lane_busy`, which a send that carries the claim gets in place of a queue entry when this chat's @octo became busy after Studio checked (2.2; RC/dispatch.rs:1435-1445). Any other `claude_code_*` code, such as `claude_code_turn_engine_unknown`, reads "Claude Code couldn't take this message.", never its raw text (D-G). For these codes the dispatch error path (FE/conversations/useConversationControllerDispatch.ts:428-452) shows the sentence in place of its raw error row, removes the unsent message and puts its text back in the composer, with the token pending. A claimed send that fails with no refusal code, such as one that never reached the controller, fails as any send does.
- Failures of an admitted turn are keyed on `aiAccessMode: "claude-code"` together with `claudeCodeFailure`, which three writers put on the failure message: the controller, from the runtime's failure artifact (2.6); every sweep that fails a lane job as `start_by_passed` or `run_once_interrupted` (2.9), through `settle_failed_queued_jobs_with_message` (RC/runtime/sweeps.rs:760-830), which at 614d275c2 put neither key on the message it wrote (784-793) and now stamps a row whose `engine` is set; and, for a runtime stop, `record_failed_claude_code_turn`, once the stop has committed (or, if that write never commits, the idle sweep's `repair_stopped_claude_code_turns`), which records a failure message as `claude_code_machine_stopped` (2.9). The stop's own `fail_claude_code_jobs_for_unavailable_runtime` fails only the job, and its model `fail_browser_jobs_for_unavailable_runtime` (RC/runtime/stop.rs:2342-2447) records no message. This is a third branch, beside managed and byoc, in SC/RunFailureNotice.tsx:246-263 (the mode is read by `readAiAccessMode`, 73-81) and FE/conversations/runFailurePresentation.ts:273-299 and 770-790.
- That branch is taken only for a message that carries the controller's stamp. Every writer above stamps the failure message through `stamp_failure`: `claudeCode {version: 1}`, `aiAccessMode` and `managedAiUsed: false`, beside `claudeCodeFailure`. A message a member records keeps `aiAccessMode` but never the stamp (2.1), so it reads as an ordinary failure; it still offers no Try again, since the exclusions of 5.6 key on `aiAccessMode` alone and so fail safe. A runtime stop's message is written just after the stop commits (2.9). Only that message, with no author, on the turn's run and with the stamp, counts as the turn's written end: a message anyone records with the turn's `jobId` and kind never leaves its run unfinished, and one a member records loses that kind (2.1).
- There is no "Manage AI" action. The raw text stays in its sender's Details.
- Teammates see only: "Claude Code couldn't finish this turn on {Name}'s computer." Their Details keep the turn's steps but not the raw text, which can name the sender's own sign-in or plan. A viewer the chat cannot tell is the sender reads the same, with "the sender's" for the name. The controller still serves that text to every member through the message history (5.7), so this is presentation, not access.

| Code | Sentence shown to the author |
|---|---|
| `not_signed_in` | "Claude Code isn't signed in on this computer. Open a terminal, run claude and sign in, then send your message again." When the runtime's status entry says `verified: false` (2.10), it adds: "If you're signed in, this newer Claude Code may no longer let other apps use your sign-in." |
| `plan_limit` | "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets." It adds the reset time when the text gives one. |
| `binary_missing` | "Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI, then send your message again." |
| `binary_unsafe` | "Instafy Desktop won't start this copy of Claude Code because other accounts on this computer can change it, or a setting from your login shell (CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS) points somewhere it can't use. Set it up again in Your AI." The runtime gives this one code for both causes (3.2, D26); Your AI names the setting when Desktop finds it (5.3). |
| `unsupported_version`, `probe_failed` | "This version of Claude Code can't take turns from Instafy. Update Claude Code, then send your message again." |
| `bare_default` | "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet." |
| `session_unavailable` | "Claude Code couldn't continue its earlier session on this computer. Send your message again to start a new one." |
| `turn_timeout` | "Claude Code worked past its time limit for one turn, so it was stopped. Its changes stay on this computer and weren't saved to the space." |
| `stalled` | "Claude Code stopped responding, so this turn was stopped." |
| `crashed` | "Claude Code stopped unexpectedly, so this turn ended." |
| `unexpected_configuration` | "Claude Code started with settings Instafy didn't ask for, so Instafy stopped this turn." |
| `project_config` | "This space's folder on this computer holds Claude Code files, so Claude Code turns from Instafy can't run here. Move the files that Details names out of the folder, then send your message again." |
| `unsafe_import` | "A CLAUDE.md, CLAUDE.local.md or AGENTS.md file in this space's folder brings in files that aren't part of the space, so Claude Code turns from Instafy can't run here." |
| `unsafe_link` | "This space links to a file outside it, so Claude Code turns from Instafy can't run here." |
| `preflight_failed` | "Instafy couldn't check this space's folder on this computer, so Claude Code didn't start." The runtime gives this code when the pre-flight cannot decide (3.9): a folder with no repository (D-A), a git command that fails, a folder or file it cannot read, a memory file too large, too costly to read or with too long an `@` word, too many files or candidates to check, or a pre-flight past its 60 s deadline. The author's Details name which. |
| `claude_code_turn_not_allowed` | "Claude Code turns aren't on for your account yet." |
| `claude_code_turn_not_person` | "Claude Code takes only a message you send yourself." |
| `claude_code_turn_not_plain` | "Claude Code takes only a plain message to Octo, of at most 100,000 characters, without attachments or a command." |
| `claude_code_conversation_granted` | "In this chat, Octo takes turns only from the person who started the chat, so Claude Code can't run your message here." |
| `claude_code_turn_active` | "You already have a Claude Code turn running. Send this when it ends." When the refusal's `details` say that the earlier turn's start window has passed (G8): "Your last Claude Code turn didn't start in time. Send this again in a few seconds." |
| `claude_code_machine_busy` | "Your computer is busy with another turn. Send this when it's done." |
| `claude_code_runtime_not_ready` | By `details.reason` (2.2). For `capability_missing` and `capability_not_ready`, the computer is connected but its Claude Code can't take a turn (no capability, or one of 3.2's not-ready reasons): "Claude Code on this computer isn't ready to take turns. Check it in Your AI, then send your message again." For any other reason, or none: "Your computer isn't connected to this space. Open this space in Instafy Desktop, then send your message again." |
| `dispatch_lane_busy` | "Octo is still working on another message in this chat. Send this when it's done." |
| `claude_code_machine_stopped` | "Instafy Desktop stopped on your computer while Claude Code was working, so the turn ended. Send it again to run it." |
| `start_by_passed` | "This Claude Code turn didn't start in time, so it won't run. Send it again." |
| `run_once_interrupted` | "This Claude Code turn stopped because Instafy on your computer stopped, and it won't run again. Send it again to start over." |
| permission denials (a note, not a failure) | "Claude Code skipped N steps that need your OK, since nobody can give it here. You can allow them in your own Claude Code settings." |
| steer refused | "This Claude Code turn can't take more words while it runs. Queue your message instead." (a new case in SC/sendIntentErrorMessage.ts) |
| any other `claude_code_*` send refusal (D-G) | "Claude Code couldn't take this message." |
| anything else, the runtime's refusals that carry no code included (3.1, D-I) | "Claude Code stopped with an error." It adds the first line only when that line passes the Chat-Activity rule. |

### 5.6 What never carries the lane

- **Automatic resends.** `isRunFailurePromptAutoResendable` (FE/conversations/runFailurePresentation.ts:484-507) returns false for a prompt that carries the claim, and for a run whose `aiAccessMode` is `claude-code`. `useRunFailureAutoRetry` (SC/useRunFailureAutoRetry.ts:161) skips them.
- **Continue after Stop.** It is hidden. It goes out as an automatic send (SC/useChatRunStopContinuation.ts:298-304).
- **Retry.** The author gets "Send again with Claude Code", which refills the composer with the text and the token. It never sends a `retryOfMessageId` resend, which the gate would refuse anyway. The card's Try again shows for every viewer today (SC/RunFailureNotice.tsx:262-263) and resends without the claim (SC/useRunFailureRetryActions.ts:152-157). It is hidden on lane failures, so a teammate cannot rerun the author's words as a turn of their own.
  - As built, "Send again with Claude Code" shows only on a controller-stamped failure (5.5) and only where the composer offers a turn engine, which is in Desktop. It puts the words above the current draft and chooses Claude Code when that is still offered; otherwise the words still go back, with the notice "That choice for the next message isn't available here now. Your message is kept." It never sends anything.
  - Try again and Retried are hidden whenever the failure or its prompt carries a turn engine's `aiAccessMode`, stamped or not, and a retry asked for such a prompt is refused.
- **Builds without the engine.** These exclusions count any `aiAccessMode` other than `managed` or `byoc` as a turn engine's, also one the viewer's build does not have: the hosted Studio until phase 8 (5.1, D-E), or a tab opened before a deploy. In such a build a lane turn is still never resent, retried, offered Try again or taken as a title seed. Only the wording keys on the engines the build has.
- **Expired-credential prompt.** Its automatic opening (SC/useChatCredentialGate.ts:462-494) ignores lane runs.
- **Queue and stashes.** Their storage strips the claim (5.1).

### 5.7 How a lane turn looks

- **The turn row** is the same as for a Codex turn: steps from the mapped events, the streaming draft, the reply, the files card and the "kept on this computer" notes.
  - Until the first step arrives, the row, and the typing row before it, read "Starting Claude Code on this computer…" for the turn's sender, "Starting Claude Code on {Name}'s computer…" for everyone else, and "Starting Claude Code…" when the chat can't tell who sent it.
  - The turn's notes (3.7) show as plain lines under the reply and the files card once the turn is done, whether Details is open or not, but not while Instafy quietly sends a failed turn again. They stay out of Details and out of the flat message list, and never make the line read "Wrote a note". A turn that took no step still gets a row for them. Studio's core keys this on the generic hint `details.presentation.placement === "reply_note"` alone, which names no product.
- **Speaker.** The reply stays @octo's, with a plain-text line under the header. Teammates read "Ran on {Name}'s own Claude Code, on their computer", and the sender reads "Ran on your own Claude Code, on your computer" (D-H). It is text, not a badge or logo (D28). It comes only from the controller-written `claudeCode` and `aiAccessMode` metadata, shown in the header slots (SC/AgentJobThreadPreviewLayout.tsx:858-898; SC/AssistantSpeakerIdentityPill.tsx). See D20.
  - A stamped reply whose header is hidden, such as a quiet reply in a chat of one or the same speaker again, shows the line on its own, and the read-only run trace keeps a stamped reply's header and line at every width.
  - A failed turn shows no such line, since its failure sentence already names Claude Code.
- **Details** show the model (from `init`) and the token counts, never a cost. Message stats, Copy stats and the run trace's usage badges show the model too, and count as the controller's usage row does (2.6): input is every input token, cache writes and reads included, and cached is the cache reads.
- **Teammates** get run status from the live event stream while the turn runs, because an event that names another person's private runtime is reduced to that (RC/events.rs:623-644; docs/Self-Hosted-Runtime-Security.md:70-76). They also get the streaming reply draft: `run.reply_draft` names no runtime, so that reduction does not apply to it, as for a Codex turn on a person's own computer on `main`. Adding the runtime to the draft event would hide Codex drafts from teammates as well, so it stays as it is. The draft's text is the reply's, which they see anyway. The steps and the reply carry `leaseMetrics.leasedByRuntimeId`, so they reach teammates only through the message history (RC/conversations.rs:3073-3228), with the failure and its metadata, and Studio chooses the teammate wording by viewer.
  - They can press Stop.
  - Steer is refused.
  - Their messages never reach the session.

---

## 6. Credential guard

A new module, RC/claude_material.rs, defines what is refused:
- `is_claude_secret_value(s)`: `s` contains `claudeAiOauth` or `claude_ai_oauth`, or it contains `sk-ant-`, ignoring ASCII case, with no letter or digit directly before it, other than at the start of a Claude API key (`sk-ant-api…`) or an Admin API key (`sk-ant-admin…`). That it covers OAuth access, refresh and setup tokens is unverified: Claude Code's documentation does not give their format.
- `json_contains_claude_material(v)`: walks at most 8 levels and matches any `claudeAiOauth` or `claude_ai_oauth` key, or any string leaf for which `is_claude_secret_value` holds. A value nested deeper than 8 levels counts as Claude material, so the walk fails closed.
- `is_reserved_secret_name(n)`: after `normalize_secret_name` (RC/secrets.rs:128-155), which upper-cases the name and turns spaces and hyphens into `_` (138), the name is `CLAUDE_CODE_OAUTH_TOKEN`.

A refusal is 400 `claude_credential_refused`, with the message: "Instafy doesn't store Claude sign-ins. Claude Code turns use the Claude Code signed in on your own computer."

| Where | Rule |
|---|---|
| `insert_user_credential` (RC/credentials.rs:226-376), the one sink for stored model credentials: the Codex upload through `classify_auth_json` (2800-2846), and device login | Refuse when `authJson` holds Claude material, in two places: in `create_my_codex_credential` before `classify_auth_json` (2054), which would otherwise answer a `claudeAiOauth` body with its own 400 (2843-2845); and in `insert_user_credential` before sealing (248), which device login also reaches. Today `classify_auth_json` accepts any non-empty `OPENAI_API_KEY` and any `tokens.access_token`. A stored access token that is not a JWT and has no `last_refresh` is always due for refresh (2526-2537) against OpenAI's token endpoint (:50), so a Claude refresh token would be sent to OpenAI. |
| `decode_authoritative_credential_payload` (3065-3075), the decrypt that every lease, refresh and probe goes through (key rotation also opens every row, RC/credential_rotation.rs:366 and 542, but only to count it or seal it again, and stays unchanged) | Errors on Claude material. Rows stored before the guard are then never leased to the proxy (2291), refreshed or probed. An optional admin script revokes them. |
| Project secret create: `normalize_secret_name` (128-155, called only at 524). Create and update: `normalize_secret_value` (173-184, called at 526 and 680) | Refuse reserved names at create, and Claude values under any name at create and update. An update carries no name (`UpdateProjectSecretBody`, 76-83), so `update_project_secret` (657) also loads the row's name and refuses a new value for a secret whose name is reserved. |
| Secret delivery: `agent_secrets` grants by handle and by id (RC/secrets.rs:1364-1470) | Skip rows with a reserved name or a Claude value, logging only the secret's id and name. Lane jobs get nothing at all (2.5). |
| The GitHub import's project-token fallback (RC/imports.rs `load_project_secret_value_by_name`), which sends a stored `GITHUB_TOKEN` or `GH_TOKEN` to GitHub when the import has no other token | Treat a value that holds Claude sign-in material as absent, logging only the secret's id and name. The import then tries the next name, then public access, as `agent_secrets` skips rather than fails. Added as built: the design's first list missed this reader. |
| Device login providers (`start_device_auth` match, RC/device_auth.rs:1249-1290; routes at 232-237) | Stay `codex` and `github`. A test pins the list. |
| Publish (`is_secret_path`, packages/origin-http-server/src/publish_policy.rs:110-129) | `.credentials.json` joins the secret file names. Deleting such a file stays allowed (104-106). |
| Desktop and runtime sources | A static test checks that DA, DRA and RA never contain `.credentials.json`, `claudeAiOauth`, the keychain service name Claude Code uses, or `security find-generic-password`. |
| Runtime registration | `claudeCode` is rebuilt from known non-secret fields only (2.10). |

**Behaviour change.** As the owner decided on 2026-11-12 (D23), the guard refuses only Claude sign-in material. That is a narrow change, not a breaking one: a Claude API key or Admin API key stored as a project secret under any name but `CLAUDE_CODE_OAUTH_TOKEN`, for example `ANTHROPIC_API_KEY` for a chatbot preview, keeps working for every Codex job and app, as today. The guard does stop delivering Claude sign-in material that is already stored. Before the guard ships:
- A read-only admin script, run server-side with the credential key, counts per space the secrets the guard will stop delivering: reserved names, and values that `is_claude_secret_value` matches under any name. It prints space ids, secret names and counts only. As built it is a Cargo example, packages/runtime-controller/examples/claude-material-census.rs, which compiles RC/claude_material.rs itself so that it counts exactly what the guard refuses; its header says how to run it, and plain `cargo test` runs its own tests.
- The release notes say so.
- `list_project_secrets` (RC/secrets.rs:353-508), which today returns no value, decrypts each active row in the controller and adds `refused: true` when the name is reserved or the value is Claude material. The space's Secrets settings mark each such secret "Instafy no longer stores Claude sign-ins; remove it" instead of hiding it.

The rejected alternative, a broad guard, is recorded in D23.

---

## 7. CLAUDE.md and repository rules

The changes below are made. As built they landed together, in one change after the code of phases 1-6, rather than with each phase as section 9 planned. The documents they name are now the reference for their own wording, and they also carry later corrections, such as the sentences 5.5 and 5.7 changed while building.

### 7.1 AGENTS.md

Replace lines 18-19 with:

> - All model traffic goes through the configured Instafy proxy. Do not call model providers
>   directly from the browser or runtime agent. The one exception is a local-engine turn
>   ([docs/Local-Engine-Turns.md](docs/Local-Engine-Turns.md)): for one turn that a person starts
>   from their own message and chooses Claude Code for, runtime-agent on that person's own
>   computer starts their own signed-in, unmodified `claude`, and only that program's own
>   traffic leaves, under the sign-in the person made in it, for Anthropic or for the cloud
>   provider or gateway that sign-in uses. Instafy never reads, stores, refreshes, forwards or
>   proxies that sign-in, sets no `ANTHROPIC_*` or `CLAUDE_*` variable for it but the person's
>   own `CLAUDE_CONFIG_DIR`, gives it no Instafy token or project secret, sends it nothing but the
>   person's own message, and sends no other model traffic around the proxy. Claude Code's own
>   permission settings, not runtime-agent's folder containment, bound what its tools do. Do not
>   widen this exception.

Add under Security invariants, after lines 29-30:

> - Never accept, store, refresh, forward or deliver a Claude sign-in. The controller refuses
>   Claude sign-in material in credentials and project secrets (`claude_material.rs`): `sk-ant-`
>   values other than Claude API and Admin API keys, `claudeAiOauth` bodies and the secret name
>   `CLAUDE_CODE_OAUTH_TOKEN`; do not add a path around that refusal. A local-engine turn
>   starts only from its person's own message to their own computer, runs once in the
>   foreground, and never from an automation, plan, resend, queue, goal wake-up or hand-back:
>   keep every dispatch path behind `claude_code_lane::check_sender` and `claude_code_lane::admit`.

### 7.2 docs/Architecture.md

Line 9 becomes:

> - **AI proxy**: all model traffic must flow through the proxy (`PROXY_BASE_URL`), except a local-engine turn's own traffic, which goes from the person's own signed-in `claude` on their own computer to Anthropic, or to the cloud provider or gateway that sign-in uses ([Local-engine turns](Local-Engine-Turns.md)).

Line 470, the first paragraph of "AI Proxy" (its heading is line 469), becomes:

> All automation must route through the proxy. Do not call OpenAI/Anthropic directly. A local-engine turn is the one exception, and it is not automation: for one turn its person starts, runtime-agent on their own computer starts their own signed-in `claude`, which talks, under their own sign-in, to Anthropic or to the cloud provider or gateway that sign-in uses. Nothing Instafy runs for that turn calls a model, and the turn holds no proxy token ([Local-engine turns](Local-Engine-Turns.md)).

In "Agent Job Trigger", the bullet's first sentence (lines 231-233, ending "it keeps no such key.") becomes:

> Where device grants or local-engine turns are on for its sender, a user message also keeps its kind as `metadata.trigger`, over any value a client wrote; anywhere else, and for a send with no kind, it keeps no such key.

The same section adds that the lane is on for the users `CLAUDE_CODE_LANE_USER_IDS` lists, which is parsed like `DEVICE_GRANTS_USER_IDS`.

A new section, "Local-Engine Turns", goes after Device Grants (which ends at 322):

> A local-engine turn is one @octo turn whose sender chose, in Instafy Desktop, to have their own signed-in `claude` on their own computer carry it out ([Local-engine turns](Local-Engine-Turns.md)). It exists only for the users `CLAUDE_CODE_LANE_USER_IDS` lists.
> - Dispatch admits it only from its person's own session, for a plain message to their own @octo, on their own ready private runtime that carries the attested `claudeCode` capability (in v1 only Desktop on macOS asks for it; the controller cannot verify which client did), with no other lane turn of theirs running or waiting, and stamps the job `engine = 'claude-code'`. Nothing Instafy sends by itself, queues, resends or delegates is admitted.
> - The job holds no credential, device grant or plan role, is leased once and only within a minute of the send, by that runtime alone, and gets no proxy token, model-facing controller token, project secret or history. It costs no credits. Nobody can steer it; any member with write access may stop it.
> - Apply the migrations that add `agent_jobs.engine` before deploying the controller that reads them. Keep `CLAUDE_CODE_LANE_USER_IDS` empty until the previous controller pool is retired: an older controller would unpin and requeue such a job. To roll back, empty it first, then wait until no job with `engine = 'claude-code'` is queued or leased: queued ones start or fail within about 70 s, and a running turn keeps its lease until it ends, at most 3000 s after its one-minute start window. Stopping the runtime that runs one fails it at once. Then roll back.

### 7.3 README.md

Add after line 154:

> - Exception: local-engine turns in Instafy Desktop on macOS. A person can choose, for one message, to have their own Claude Code, signed in on their own computer, carry it out. It runs on their own Claude Code sign-in, under Anthropic's current terms, and that sign-in may bill their Claude plan or their own API or cloud account; its traffic goes from Claude Code to Anthropic, or to the cloud provider or gateway that sign-in uses, never through the Instafy proxy, and Instafy never reads, stores or forwards that sign-in ([Local-engine turns](docs/Local-Engine-Turns.md)). It is off unless `CLAUDE_CODE_LANE_USER_IDS` names the user. Anthropic's terms say that, unless Anthropic has agreed otherwise, running Claude Code in a product or service requires accepting Anthropic's Commercial Terms of Service, keeping Claude Code unmodified, with no sign-in method removed, disabled or restricted, and not paying for, reselling or intermediating Claude usage: each person signs in with their own credentials. Instafy meets that condition before it puts any user id in `CLAUDE_CODE_LANE_USER_IDS`, its own staff's included. An operator who puts any user id in it, their own included, takes on the same condition.

### 7.4 Other documents

- **docs/Self-Hosted-Runtime-Security.md:52-63.** Add: "A local-engine job is not a platform AI job, though it holds no credential: only its sender's own private runtime with the attested `claudeCode` capability leases it, once and within a minute of the send, and it gets no proxy token, model-facing controller token or project secrets ([Local-engine turns](Local-Engine-Turns.md))."
- **docs/Chat-Activity.md.** The lane failure sentences, under the rule at 91-101.
- **docs/Credits-Billing.md.** A lane turn costs no credits, and the usage it shows is Claude Code's own report.
- **docs/Settings-UI.md.** The "Claude Code on this computer" status row in Your AI.
- **docs/Runtime-Machines.md.** Lane saves leave out `.claude/`, `CLAUDE.local.md`, the `.mcp.json` at the folder's root and any file that holds an `sk-ant-` token (3.8).
- **claude-plugin/instafy/README.md:6-8.** Keep the text, and add: "Separately, Instafy Desktop can run your own Claude Code for one message you choose in an Instafy chat ([local-engine turns](../../docs/Local-Engine-Turns.md)). If you installed the plugin, its skill is available in such a turn, as in your own sessions, but its tools are not, and they still cannot start a turn."
- **docs/CLI.md:1139-1141.** Unchanged. "None starts an agent run" stays true of `instafy mcp`.
- **docs/Local-Engine-Turns.md.** This document. Every link in this section, and the 2.1 migration comment, points to it, and docs/README.md lists it. Before phase 8 it gains a short opening section for people and operators. That section covers:
  - the choice in Desktop (macOS only in v1);
  - `CLAUDE_CODE_LANE_USER_IDS`, and the condition from Anthropic's terms that comes before any user id goes into it (7.3);
  - the proxy-rule exception and the credential guard;
  - what a lane job holds and does not hold;
  - what the lane cannot prevent (1.2);
  - the failure codes.
- **No changeset.** Neither `@instafy/cli` nor `@instafy/provider-contract` changes, unless D9's alternative is chosen.

### 7.5 The seeded CLAUDE.md

The file is packages/runtime-agent/assets/instafy/CLAUDE.md, from ca048eab2. Lines 15-21 say the session is not an Instafy job, which is false for a lane turn.

A lane turn does not load the file. Claude Code's documentation says that project CLAUDE.md files, in the working directory and its parents, their imports and `.claude/rules/` load only through the `project` setting source, and CLAUDE.local.md only through `local`. Under `--setting-sources user` (3.3), a lane turn reads only the person's own `~/.claude/CLAUDE.md` and user rules. So no Instafy-written text reaches a lane turn through this file or the `AGENTS.md` and `INSTAFY.md` it imports (lines 1-2), and the lane does not depend on the file at all. Claude Code can still open it as an ordinary file, so lines 15-21 change to read true in both cases; the person's own sessions are the ones that load it.

Instafy writes nothing for a single turn: no per-turn note file, and no import of one. Such a note would be an Instafy-written instruction delivered with each turn, which is too close to the system prompt this lane must not add.

Lines 15-18 become:

> - **`instafy preview open … --start`.** `AGENTS.md` starts servers with it. In a Claude Code session, including one Instafy started from its chat, it opens a private Instafy preview as the signed-in person, with a tunnel and a card in Studio, and needs a conversation. Start a server in the background with your own shell instead, and do not open an Instafy preview unless the person asks for one.

Lines 19-21 become:

> - **`instafy web search`.** It answers only in turns Instafy's own agent runs, never in a Claude Code session, including one Instafy started from its chat. Find links with your own search, then read the pages with `instafy web read <address>`, as `AGENTS.md` says.

How existing spaces receive the change:
- **Desktop folders.** The runtime scaffold changes CLAUDE.md from write-if-missing (RA/jobs/learn.rs:862) to `upgrade_bundled_skill`, as AGENTS.md already uses (853-860). A new `LEGACY_CLAUDE_DOC_TEMPLATES` holds only this branch's current text. It leaves out origin/main's one-line `@AGENTS.md`: a repository can keep exactly that as its own CLAUDE.md, and `upgrade_bundled_skill` matches bytes only (RA/jobs/learn.rs:1127-1146), so it cannot tell Instafy's old seed from a team's file. A Desktop folder that still holds the one-line file keeps it and misses the new notes, which the lane does not depend on.
- **Canonical spaces.** They upgrade through the hash-guarded bootstrap (`plan_project_memory_writes`, RC/projects.rs:6177; template list at 1003-1018), which replaces a file only while it still matches the hash the bootstrap recorded for it (6244-6245). That record does not prove Instafy wrote the file: the bootstrap also records a file that already equals the template (6258-6265), and Studio asks for a bootstrap on every page load (FE/screens/useProjectMemoryBootstrap.ts). A space whose own CLAUDE.md was the one-line `@AGENTS.md` while that was the template is therefore recorded like Instafy's seed, and moving the template off that text would rewrite the team's file on `main`, and through the pre-turn refresh in the space's Desktop folders. So the bootstrap never replaces a CLAUDE.md whose recorded hash is the one-line file's: such a space keeps it, as a Desktop folder does, and an Instafy-seeded space that still holds it misses the new notes. This holds from the first release whose template is not the one-line file, which is ca048eab2's if that commit lands first.
- **New spaces** get the file through git-service's seed (packages/git-service/src/repo.rs:25-28, 410).
- **Pinned phrases** are updated in the same change: RA/jobs/learn.rs:2167-2230 and RC/projects.rs:6637-6690. packages/git-service/src/repo.rs:736 compares the seeded file with `CLAUDE_DOC_TEMPLATE` itself, so it follows the template and needs no change.

Phase 0 item 2 confirms on the floor version (3.2) that a lane turn loads neither this file nor its imports. It also checks that `AGENTS.md` does not load on its own: Claude Code reads it as project instructions (3.9), and its documentation does not say which setting source governs that. If the project CLAUDE.md, its imports or `AGENTS.md` load in a lane turn, stop and revisit before Phase 8. This file is guidance, not a control, and teammates can edit it.

---

## 8. Tests

No suite needs a Claude login, and public CI holds no Anthropic secret (AGENTS.md:33-34).

**The fake binary.** A script at packages/runtime-agent/tests/fixtures/fake-claude (new). It records its argv, stdin, environment and cwd to a file the test reads. It provides:
- `--version` and `--help` variants:
  - an old version;
  - missing flags;
  - help text saying bare is the default, with and without `--no-bare`;
  - help text saying bare "will become the default".
- `auth status` output: signed out, and signed in with each `authMethod`.
- `auth status` variants: signed in through claude.ai, signed in with an API key, and signed out.
- `-p` scenarios from canned stream-json:
  - success with tool calls and edits;
  - a sign-in failure, and a plan limit;
  - a resume miss that exits before `init`;
  - permission denials;
  - a hang, and a stall;
  - a `result` while only a background command or Monitor watch (`local_bash`), or an `ambient` task, is live, followed by more output;
  - a `result` while a background subagent is live, followed by a later `result`;
  - a `setsid` grandchild, and a double-forked daemon;
  - exit 143 on SIGTERM;
  - malformed lines;
  - an `init` event that reports a different cwd, a different mode or an MCP server, one that lacks a documented field, and one whose `session_id` is not a UUID.

**The live suite.** It is gated by `INSTAFY_CLAUDE_CODE_LIVE=1` and runs only on a developer machine with a signed-in `claude`. A person runs it by hand, on their own computer and Claude account, as for Phase 0 (9); no CI job or automated agent sets the variable.
- When the variable is unset, it reports "not run" and never passes.
- When the variable is set but no ready `claude` is found, it fails.
- It runs the Phase 0 checklist on the installed version and prints that version. A maintainer then raises `CLAUDE_CODE_LANE_VERIFIED_THROUGH`, a constant in runtime-contracts, in a reviewed change. runtime-agent compares the probed version with it and attests `verified` beside `cli` (2.10), and Studio reads that flag instead of keeping a copy of its own.

**runtime-controller** (`cargo test -p runtime-controller`, database-backed like RC/tests_device_grants.rs and RC/self_hosted_platform_lane_tests.rs):
- **Intake.**
  - The claim is stripped for every caller, the service role included. An unknown value is a 400.
  - The claim never persists on a message, payload or queue entry.
  - A client `claudeCode` stamp is stripped at dispatch. On `/messages/record` it, the `turnEngine` claim and `claudeCodeFailure` are stripped, for the service role too. A member's recorded message also loses the kind `claude_code_machine_stopped`; the service role's keeps it, without the stamp and with no run.
- **Gate: one negative test per condition in G1-G8.** The cases are: the service role; a job token; an automation; a goal wake-up; a hand-back; a site ask; a queue drain and Send now; `retryOfMessageId`; `goalContinuation`; `dispatchContent`; `displayContent`, `display_content`, `composerMessage` and `composer_message`; two targets; a teammate's runtime; a hosted, service-owned, Personal Browser, not-ready or busy runtime; a missing or unattested capability; attachments; `/` text; a terminal intent; a sender who is not allow-listed; a second active turn; a new conversation, including a claimed `POST /dispatch-prompt` that names a new conversation id, which Stage 2 refuses and whose conversation insert rolls back; a send with no `input`, and one with `input.kind: "device"`; an automatic-retry claim; `allow_internal_review`, `allow_silent_automation_decline` and `goal_parent_job_id`; `controllerDispatch`, `spaceReview` and each special-dispatch key; a request or conversation `thread_kind`; browser-transport and runtime-spread metadata, which turn `plain_turn` off (RC/dispatch.rs:1796-1801); one target that is not @octo; `workerInputRouting`; a message recorded earlier under the same client message id; an execution mode other than `apply`; `plan_seed`, `tool_limits`, `repo` and `requested_preview`; `writeIntent: false` and a read-only write scope; text over the prompt limit; a send with no `runtime_id`; a runtime row in another project, and a missing one; a chat whose device grants name someone else (409 `claude_code_conversation_granted`). Each refusal writes no prompt, run, message or job, and burns nothing.
- **Gate: one admitted turn.** It stamps the metadata, writes `engine`, clears the credential of a BYOC sender, sets no conversation runtime preference and creates no `ai_usage_jobs` row. Its payload's `prompt_text` is the recorded message text, with no preamble or segment; its metadata holds only the keys 2.5 allows, so a client `userId` is dropped; and the payload has no `bootstrap`.
- **Gate: group chats.** A claimed send in a group chat is never turned into an evaluation and gets no preamble (2.2).
- **JobTrigger.** Lane users get a kind. Resends and goal continuations get none. Grants stay off for users who are only on the lane list.
- **Lease.**
  - Only the pinned, owned, attested and ready runtime leases the job.
  - It is never leased by a hosted runtime that reports the capability, the person's other runtime or a Personal Browser runtime; never after 60 s; never twice; and never as a batch's second job.
  - The leased job has no envelope, metering bind, controller token or history, and does have a workspace token.
  - The lane job is leased first, and alone, even when a team plan's job and an ordinary job for the same computer have smaller priority numbers and older times; each of those follows (2.4, rule 7).
- **Moving and re-running.**
  - A runtime stop fails the job as `claude_code_machine_stopped` and requeues nothing. Its failure message, and the ones the sweeps write as `start_by_passed` and `run_once_interrupted`, carry the controller's stamps and `claudeCodeFailure` (5.5).
  - A stop through the real stop route publishes the failure message and `run.completed` with its failure code, each only after the job and the run are failed in the database.
  - A stop never waits on its turn's chat: with the chat held `for update` by another transaction, the stop commits, and the run's failure, one Home row and one failure message follow once the chat is free. A second write records nothing, and the sweep step writes the end of a stopped turn whose own write never committed (2.9).
  - A message a write member or the service role records with a stopped turn's `jobId` and kind never stands in for its end. Through the real stop route, and through the sweep step when the stop's own write was skipped, the run still fails, and one failure message with no author and the stamp is written on the run and published, with `run.completed`, once. A row that misses any one of the three marks (no author, the turn's run, the stamp) does not count either, and a write after the real end records nothing.
  - An expired lease, in a space that is still active, means the job is never leased again and ends as `run_once_interrupted`, and a heartbeat on it gets a 409.
  - Both stranded-platform queries, limit waits, the rate-limit requeue and upstream pacing ignore lane jobs.
- **Refusals.**
  - Steer is refused with a 409, for the author too. Stop still works for members.
  - These all refuse: `/agent/secrets`, `authorize_active_job`, proxy-token renewal, a plan from a lane parent, queue enqueue and restore, and automation create and update carrying the claim.
  - The busy-to-queue fallback refuses a claim.
  - A claim in a chat that device grants name for someone else gets 409 `claude_code_conversation_granted`, and nothing is recorded.
- **Completion.**
  - Only the computer that leased a lane turn ends it or posts to it: a token a write member mints with no runtime, a teammate's computer and the person's other computer each get 404, while the job is queued and while it is leased, and nothing is written (2.6).
  - The steps the runtime sends as notes keep `details.presentation` exactly as sent, for the author and for a teammate (3.7).
  - The provider is forced to `claude-code`.
  - A forged `codex/run-log` bills nothing, and the usage row is `billed: false`.
  - The failure code is validated and copied.
  - Lane state is saved only when well-formed, and a Codex job's `claude-code` state is dropped.
  - The lane loader resumes only for the same person, runtime, conversation and agent, skips a job that saved no state, such as a stopped turn, and honours reset. The Codex loader never returns lane state.
- **Schema.**
  - The CHECK rejects a lane row with a credential, grants, a parent, a plan group or a role.
  - The unique index fails the second of two concurrent admissions with 23505, mapped to 409.
  - G8 and the index agree for a queued job whose window has passed.
- **Capability.**
  - The token scope is issued only with `localEngine`, with the switch on, and to a person's own session: never to the service role, even when it names an allowed subject.
  - Attestation drops `claudeCode` for hosted, service-owned and unscoped runtimes, and rebuilds only the known fields.
  - Status shows it only to the owner, and only with the switch on. `claudeCodeLane` is present only for a viewer the switch covers.
- **Guard.** Every row of section 6, including a Claude body stored as `codex_auth_json`. A recorded refresh-URL override shows that no outbound refresh happens. Also covered: decoding a legacy row; secret create, update and delivery; the device-login provider list. The proposed narrow rule (D23) is tested both ways. A Claude API key (`sk-ant-api…`) or Admin API key (`sk-ant-admin…`), for example under `ANTHROPIC_API_KEY`, is still stored and delivered to Codex jobs, as today. Any other `sk-ant-` value in any letter case, a `claudeAiOauth` body, also as a project secret's value, and the name `CLAUDE_CODE_OAUTH_TOKEN`, also written `claude-code-oauth-token`, are refused. A value with a letter or digit right before `sk-ant-`, such as `risk-ant-…`, is not. The GitHub import passes over a `GITHUB_TOKEN` that holds Claude material for `GH_TOKEN`, and with only such a row imports with no token.
- **Payload.** A lane job's payload, built the way dispatch builds it, equals runtime-contracts' recorded `laneJobPayload` once its ids are placeholders, and a client's `workspaceMode` never changes its top-level `executionMode` (2.5).
- **Project memory.** The bootstrap never replaces a CLAUDE.md whose recorded hash is the one-line `@AGENTS.md` file's (7.5).
- **Migrations.** `node scripts/check-supabase-migrations.mjs` and `pnpm test:migrations:empty-db`.

**runtime-agent** (`cargo test -p runtime-agent`, hermetic, with the fake binary):
- **Capture.** A relative path, a file or directory that anyone but its owner and the `admin` group can write, a foreign owner, or a path under the workspace root or the project folder gives no capability. A target in a directory that only the `admin` group can also write, as Homebrew's `/opt/homebrew/bin` is, passes. The variables are scrubbed after capture.
- **Probe.**
  - Each `reason` is produced.
  - `planSignIn` is true only when `auth status` reports `claude.ai` or `oauth_token`, and false when it reports another method or exits 1.
  - A flag missing from `--help` is logged and does not fail the probe.
  - "Will become the default" wording is not `bare_default`.
  - `--no-bare` is passed only when listed.
  - A per-turn probe that disagrees with the capability registers again, and while the capability says not ready, a timed probe registers again once the result changes.
  - A value published before a renewal task starts registers again at once, for a fresh registration and an adopted renewal alike, and an unchanged value does not (3.2).
  - The startup probe's three commands share one deadline: a hung `auth status` gives `probe_failed` (3.2).
  - Where the lane is offered, a malformed grant makes a lane job fail with its own reason, and no grant with `binary_missing`; elsewhere, and on a Personal Browser runtime, it is always `binary_missing` (3.1).
  - A changed binary is probed again.
  - `verified` is true only for a version at most `CLAUDE_CODE_LANE_VERIFIED_THROUGH`.
- **Command.** The argv is exactly as in 3.3, with none of the forbidden flags and nothing in argv but flags. stdin is byte-for-byte equal to `prompt_text`.
- **Environment.**
  - The child gets exactly the allowlist, the D26 values Desktop granted, and `ENABLE_CLAUDEAI_MCP_SERVERS=false`. `CLAUDE_CONFIG_DIR` is the one `CLAUDE_*` name it can get, and only with the granted value.
  - A granted `CLAUDE_CONFIG_DIR` or CA file that fails the checks in 3.2 gives a not-ready capability (`binary_unsafe`). Any other name in `INSTAFY_CLAUDE_CODE_ENV_JSON` is left out.
  - This holds even when the process environment holds `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY`, `OPENAI_*`, `CODEX_*`, `CONTROLLER_ACCESS_TOKEN`, a project secret and a poisoned `HOME`.
  - PATH entries under the workspace are dropped.
- **Branch.** Tested with a mock controller, as in RA/jobs/granted_turn_tests.rs:
  - A lane job makes no `/agent/secrets` call, and gets no input task, proxy auth, `ProxyEnvGuard`, CodexClient or preflight.
  - `run_apply_job_observed` refuses a lane job.
  - A lane job that arrives in a batch fails.
- **Codex exec policy.** The embedded Codex's exec policy refuses a command that starts `claude` (D22), in each form D22 says it refuses, for every loader.
  - The lib tests look only at the harness rule's own matches, by its justification, so a host's own Codex policy (`/etc/codex` rules, `requirements.toml`, managed preferences) cannot change their result.
  - The end-to-end proxy test fails closed: its commands run without a login shell, so the test's PATH, with the stand-in first, is kept, and it asks for `claude` only after `command -v claude` printed exactly the stand-in's path. A rule that went missing therefore never starts a real `claude` on the maintainer's Mac.
- **Refusals.** Every check in 3.9, including project configuration, a root `.claude/` or `.mcp.json` that git does not track, a recursive import through `AGENTS.md`, an import in a root `CLAUDE.local.md` that git does not track, a tracked symlink that points outside, a folder with both `.git` and `.instafy/.git` (the pre-flight reads `.instafy/.git`), and a git command that fails. Also: a folder with no repository (D-A); untracked root `AGENTS.md` and `INSTAFY.md`, which pass, and a link or a nested file under those names, which do not (D-B); the memory files Instafy seeds, current and every earlier version, which pass, tracked or not, beside an untracked `.env`; a memory file that links to an untracked file or out of the folder; nested imports through a linked folder; and names a Mac opens as Claude Code's (`.mcp.jſon`, `AGENTſ.md`).
  - **The reading (D-L).** Beside an untracked `.env`, every way of writing an import that the reviews found Claude Code reads is refused end to end: in a list item's code span, after an HTML tag or a comment, on a fence line that ends the file, before an escaped character (`**Note**@.env\#`), cut at `#`, in a link's text with escaped brackets (`[@x\]/../.env](u)`) and with comments removed (`<!-- a -->@.e<!-- b -->nv`). So is one in another code span or a code block, which Claude Code skips. The refusal names each word's longest path that may not load.
  - **Paths outside the folder.** Beside an untracked `.env`, path aliases (`@/components/ui/button`), version ranges (`zod@~3.22.4`) and `@..` pass, in code or not, while `@/etc/hosts`, `@/../etc/hosts`, `@/components/../etc/hosts`, `@~/notes.md` and `@../README.md` are still refused. The root is asked for a name as written and in NFC.
  - **Cost and bounds.** A memory file of lines of `@` or `[@`, up to 1 MiB, and one with a word of more than 4,096 characters are refused at once as `preflight_failed`, also end to end, while a word of exactly 4,096 characters, and a short file of minified lines, are read. A memory file reached by several paths is read once; memory files with more than 20,000 candidates are refused; the seeded root files are found once per pre-flight, so a root of 6,000 entries and a memory file of 1,000 untracked imports are refused in moments; and a pre-flight past its deadline is refused, while work it abandoned stops at its next file.
  - A tracked link never makes the untracked file it points at tracked. The test gives the link a name that reads as the file's, as a teammate's `Credentials.json` link to `credentials.json` does on a case-sensitive folder; a Mac's usual folders cannot hold both names.
- **The turn's own refusals.** A pre-turn refresh that refuses saves, and a Stop before the spawn, start no `claude`, and an unreadable final status saves nothing and says so (3.1, 3.8). A Stop while the pre-flight's git command waits ends the turn at once, with no completion, no report and no probe, and the next turn on the computer runs (3.9).
- **Supervision.**
  - Stop: SIGTERM, then the kill path. A sleeping child and a `setsid` grandchild are gone. There is no completion, and the stopped report leaves out `.claude/`.
  - End of turn: a top-level `result` with nothing live but a background command, a Monitor watch or an `ambient` task ends the turn with SIGTERM and the kill path. Output after it is ignored, and the exit 143 that follows counts as exit 0. While a background subagent is live, a `result` does not end the turn, and the reply and success come from the latest one.
  - Wall and stall timeouts; a crash of the fake.
  - A reaper failure sets the latch: a process that outlives the kill sets the latch the turn was given and no other, and the turn still ends with its outcome.
  - Task events that leave out or do not name a live subagent never end the turn early (3.6).
  - stderr that never reaches end of file keeps what was read, and stderr whose end is cut inside the home folder's path shows no part of it, in the outcome or in the failure message (3.6).
  - Shutdown reports nothing, and still puts held pages back.
- **Events.**
  - The fixtures produce the expected JobMessages and drafts, including a command step for Monitor, tool steps for `Agent` and `Task`, and a plan step that carries the whole list TaskCreate and TaskUpdate have built, each time either runs.
  - Commentary clears the draft. Subagent events never draft. Thinking is ignored.
  - Labels pass the runtime-contracts fixtures. A Codex turn's own MCP server named `claude-code` keeps the generic tool label (3.7).
  - Every note carries the `reply_note` placement (3.7).
  - `sk-ant-` is redacted in steps, drafts, the reply, the failure text, the run log and the stopped-turn report. The folder prefix is made relative, and the home directory prefix becomes `~`. The pre-flight's failure text, git's own words about a broken repository included, names the folder only relative to itself.
- **Results.**
  - Success saves without `.claude/`, `CLAUDE.local.md`, the root `.mcp.json` and files whose name or content holds an `sk-ant-` token, with names matched as a Mac matches them (`.Claude/`, `claude.local.md`, `.mcp.jſon`); the not-saved step names each one, a token in a name replaced. A deeper `.mcp.json`, and a file that only names the `sk-ant-` prefix, still save. A failure saves nothing. Held pages are respected.
  - A save that fails after a good run delivers the reply with its note, the `origin/apply-error` artifact and an empty `apply/files`, and its error text has its token and the folder path replaced (D-C/D-V).
  - Failure codes are classified.
  - `--resume` is passed only with a matching runtime id. A resume miss fails with the reset state and starts no second process.
- **Assets.** The capability JSON shape and its absence off macOS (D18), and the seeded CLAUDE.md's pinned phrases (RA/jobs/learn.rs). The scaffold replaces only a CLAUDE.md that matches `LEGACY_CLAUDE_DOC_TEMPLATES`, and keeps the one-line `@AGENTS.md` file (7.5).

**origin-http-server:** `.credentials.json` is a secret path, and deleting one is still allowed (6).

**runtime-contracts:** the new labels in `chat_activity_fixtures.json`. The lane's lists (the five not-ready reasons, the 16 runtime failure codes and the three stop and sweep codes) equal those of `claude_code_lane_fixtures.json`, which also records one lane job's payload, `laneJobPayload` (2.5, 2.6). The controller, the runtime and Studio each test their own copies against that fixture: the controller's lists and payload builder, runtime-agent's `NotReadyReason` and `FailureCode` and `LaneJob::of` on the recorded payload, and Studio's status parser and sentence tables.

**desktop-runtime-agent** (vitest):
- Declared keys are stripped from both the inherited environment and `options.env` on every start, including one that gets no grant, and set only from the grant.
- The token body carries `localEngine` only when granted.
- A group whose root has already exited is still signalled until it is gone (`stopDesktopRuntimeChildWithEscalation`, DRA/index.ts:571-647), the existing path that covers a runtime-agent crash (3.6).

**desktop-app** (node tests):
- Detection parsing with fake shells and noisy rc output: an alias, a function, missing markers, and the five D26 values.
- Validation refuses: a relative path, a missing file, a file that is not executable, one writable by others apart from the `admin` group, one inside a workspace or project folder, a symlink to a writable target, and a symlink in a directory others can write. A target under `/opt/homebrew/bin`, which only the `admin` group can also write, passes.
- Consent is per controller and per user. A start bound to the visible session gets the grant for that session's user, also in an unpackaged build; a start that asked for fixed credentials gets none. A user switch drops the grant.
- Off macOS, `status` reports `supported: false` and no grant resolves (D18).
- The replace prompt appears when a runtime started with any launch grant, or one a consent change replaces, has active jobs.
- After `enable`, `disable` or `locate`, the running runtime is replaced only when its grant changes, and another Instafy user's change restarts nothing. **Keep working** puts the consent store back and reports the change as not made (4.3).
- The consent dialog acts for the host context's user, never for a user id in the payload (4.1).
- Extension methods return no secrets, and no login-shell value, only the name of one Desktop can't use.
- While the lane is on, every method answers with the record's path, and what Find or Locate turned up shows only as the candidate, including the same program with login-shell values that fix the recorded ones (4.1).
- New login-shell values for the program in use (4.1):
  - A Find whose login shell gave no answer (missing markers, a timeout, the output cap, a shell /etc/shells does not list) never offers them, and Use for my messages keeps the recorded values. A no-answer Locate beside a record that Keep working puts back offers nothing either.
  - After a Locate with an alias shell, a Find that turns up no program offers them, and Use for my messages records that program with the Find's PATH entries and values. Such a Find whose new values fail too, or whose shell gave no answer, shows `not_found` and asks nothing, and a Locate of the program in use drops a no-answer one. One that also turns up a copy in a usual install folder shows that copy, with its problem, instead.
  - While the recorded values pass, Use for my messages re-confirms the record beside a Find with other values, of the same program or of none, and the dialog lists only the program and the values.
- A relative `CLAUDE_CONFIG_DIR`, a config folder others can write and a deleted CA file each give `shell_setting_unusable` with the variable named, and `enable` refuses them without a dialog. Locate without a Find grants the login shell's PATH and D26 values.
- A status read waits for a consent change before it; the Keep-working refusal's text carries no class name; a replacement that fails after the change returns the method's answer; and a replacement uses a session token only of the runtime's bound user.
- A source-reading test pins main.ts's wiring: every runtime start passes its launch grants, a Personal Browser start gets none, the resume replays none, and the replacement resolves grants for the runtime's bound user.
- The static test that nothing reads Claude credentials.

**frontend** (lint, tsc, `test:unit`, build):
- `claudeCode` is parsed strictly.
- The row appears only in Desktop, and neither it nor the Your AI row appears without `claudeCodeLane`. It can be chosen only with a ready runtime, and otherwise shows disabled, with its reason. The token is used once.
- Submit metadata, `runtimeOverride` and `preferRuntime: false`; the blocked cases; the send gate ignores credits; a claimed send gets `groupParticipationPreflight: {status: "bypassed"}` and is never only recorded; no title request, at send or later, takes a lane message (5.2).
- Queue, Steer, auto-retry, Continue and stashes never carry the claim.
- Failure copy per code, checked against a banned-word fixture. A send refusal keeps its code through `ControllerApiError`, shows its 5.5 sentence, removes the unsent message and puts its text back in the composer with the token pending. Try again is hidden on a lane failure.
- The claim rule is one pure helper, tested for every caller: the composer's Send and a restored stash carry the choice; undo, the goal's help, selection replies, voice, Try again, site asks and Continue carry nothing (5.2). Voice, "Use Instafy AI" and inline completion never send or read a draft while the token is pending. A dictation that the choice catches while it is still listening or transcribing is held too, and neither using nor dropping the choice afterwards sends it by itself, also when the choice comes and goes before its words land.
- A lane failure card needs the controller's stamp; a recorded message with only `aiAccessMode` reads as an ordinary failure, without Try again. A teammate's Details keep the steps, not the raw text (5.5).
- Any `aiAccessMode` other than `managed` or `byoc` keeps a turn out of resends, auto-retry, Try again and title seeds, also when the build lacks its engine (5.6).
- The turn's notes, in the shape the controller stores them, show under the reply with Details closed, and never in Details or the flat list (5.7).
- The starting line and the speaker line follow the viewer (5.7). The `claude_code_runtime_not_ready` sentence follows `details.reason` (5.5).
- Studio parses Desktop's status fields and words exactly the problems and settings Desktop's own sources list, and the Your AI row shows a candidate and reads the status again after a refused action (5.3).
- The teammate label comes only from controller metadata.
- "Anthropic's current terms" is present and "included" is absent. The plan line shows only when the status entry's `planSignIn` is true.
- The credential-modal smoke test passes unchanged.

**Package checks:**
- `cargo fmt --check`;
- `cargo check --tests` for runtime-controller and runtime-agent;
- the frontend checks listed in AGENTS.md.

**Public CI.** The runtime-agent job in .github/workflows/build.yml, on Linux runners with no secret, runs the library tests and the lane's hermetic targets: `--test claude_code_lane --test claude_code_supervision --test claude_code_live`, whose real-`claude` test stays ignored, and `--test proxy_integration codex_never_starts_claude::`. scripts/check-rust-ci.test.mjs pins those command lines. The controller's own suite, as `pnpm test:controller` runs it, includes the census example's tests (6).

---

## 9. Phases

Each phase ships on its own. Only phase 1's guard, phase 4's exec-policy rule for Codex and phase 7's CLAUDE.md upgrade change behaviour before phase 8, and no lane turn runs until phase 8.

Phases 1 to 7 are built, and they land dark. Phase 0 is a maintainer's to run by hand, and phase 8 is the turn-on.

**Phase 0: verification and prerequisites (no product code).**
- A maintainer runs the following themselves, from a written script, on their own Mac (D18) and login, outside CI, using the floor version of Claude Code (3.2), and records the results with the CLI version in an appendix to this document. Phase 0 needs a signed-in `claude`, so no automated agent takes part: no agent runs `claude` or reads `~/.claude`.
  1. That every flag in 3.3's command is accepted, and the `--help` wording for `--bare` (plus any `--no-bare`) that the bare check reads (3.2).
  2. That `--setting-sources user` keeps all of these out of a lane turn, a gate for phase 8:
     - `.claude/settings.json` and `.claude/settings.local.json` (hooks, `env`, `apiKeyHelper`, `enabledPlugins`);
     - skills, agents, commands, output styles, and any hooks in their frontmatter;
     - the project `CLAUDE.md` files (in the folder and its parents), their imports, `.claude/rules/` and `CLAUDE.local.md`, as Claude Code documents (7.5);
     - `AGENTS.md`, also when the person's user settings set **Project instructions** to `claude-md-and-agents-md`, since the documentation does not say which source governs it (7.5).
  3. That `--strict-mcp-config` with an empty `--mcp-config` loads no MCP server: not `.mcp.json`, not the person's servers, not plugin servers, not claude.ai connectors. Also what `ENABLE_CLAUDEAI_MCP_SERVERS=false` changes.
  4. That `-p` with no prompt argument reads the prompt from stdin.
  5. The stream-json shapes:
     - the `init` fields (`session_id`, `cwd`, `model`, `permissionMode`, `mcp_servers`);
     - `stream_event` text deltas, content blocks and `parent_tool_use_id`;
     - the `system/task_started`, `system/task_notification` and `system/background_tasks_changed` events, their `task_type`, and how they mark `ambient` tasks, which the end-of-turn rule reads (3.6);
     - the `result` fields (`result`, `is_error`, `usage`, `permission_denials`, `total_cost_usd`).
  6. SIGTERM gives 143; what SIGINT does; what happens when stdout closes (EPIPE).
  7. `--resume` with a missing session: whether it exits before `init`, and with which code and text.
  8. The signed-out and plan-limit result texts, from a test OS account with no login.
  9. Whether the Bash tool starts commands in their own process group or session.
  10. What a `-p` run writes into the folder, `.claude/` included.
  11. That `acceptEdits` with `--permission-prompts none` declines edits outside the folder.
  12. That external `@~/…` imports in a project `CLAUDE.md` or `AGENTS.md` load nothing in a lane turn, as item 2 expects.
  13. Whether the macOS keychain shows a prompt naming Instafy when Claude Code, started by Desktop's runtime, reads its own sign-in.
  14. Whether a lane turn loads the person's auto memory for the folder, and whether it writes there (1.2).
- Tier 1, which adds `instafy mcp`, the Claude Code plugin and the seeded CLAUDE.md (instafy-dev/instafy pull request 1060; commits a4eb2684c, f25ac5083 and ca048eab2 on its branch), lands first, as the owner chose on 2026-11-13. Phase 7 edits the seeded CLAUDE.md's notes (7.5) and the plugin README (7.4) that they add; the lane itself depends on none of them.
- Start the release prerequisite, which phase 8 records: Instafy accepts Anthropic's Commercial Terms or makes another agreement with Anthropic. Run a brand and wording review. As built, the lane's strings landed before that review, so phase 8 runs it on every lane string.

**Phase 1: credential guard (controller; useful on its own).** Built, with the GitHub import's fallback and the census of section 6.
- D23 is decided: section 6's narrow guard, which refuses only Claude sign-in material.
- New: RC/claude_material.rs.
- Changed: RC/credentials.rs and RC/secrets.rs.
- The device-login provider test in RC/device_auth.rs.
- packages/origin-http-server/src/publish_policy.rs.
- The first two sentences of the AGENTS.md security bullet (7.1), which describe the guard this phase builds (what they refuse follows D23). Its last sentence names `claude_code_lane::admit`, which Phase 3 creates, so it lands in Phase 3.
- The notice for stored Claude sign-ins (section 6).

**Phase 2: schema.** Built. The first three migrations in 2.1. They are inert on their own. The fourth, the repair step's index, landed with the controller in phase 3. docs/Local-Engine-Turns.md, which the first migration's comment names, lands before them, and docs/README.md lists it (7.4).

**Phase 3: controller lane, dark (switch empty).** Built.
- New: RC/claude_code_lane.rs.
- Changed:
  - RC/config.rs, RC/job_trigger.rs, RC/device_grants.rs (the macro);
  - RC/dispatch.rs, which also skips goal binding for a lane send (2.2);
  - RC/agent.rs (lease, tokens, enrichment, completion, stamps) and RC/agent/proxy_token.rs;
  - RC/active_job_auth.rs, RC/secrets.rs;
  - RC/conversations.rs, RC/send_queue.rs, RC/send_intents.rs;
  - RC/multi_agent_plan.rs, RC/automations.rs;
  - RC/turn_rate_limit_retry.rs, RC/upstream_pacing.rs;
  - RC/runtime/stop.rs, RC/runtime/status.rs, RC/runtime/sweeps.rs, RC/runtime/limit_waits.rs, RC/runtime/register.rs and RC/runtime/token.rs.
- Docs: the last sentence of the AGENTS.md security bullet (7.1); the docs/Architecture.md trigger note and its new Local-Engine Turns section; docs/Self-Hosted-Runtime-Security.md.

**Phase 4: runtime lane, dark (no Desktop grant means no capability).** Built.
- New: RA/claude_code/{mod,command,supervise,events}.rs and RA/jobs/claude_code_turn.rs; as built also RA/claude_code/{job,preflight,saves}.rs (3.1), and runtime-contracts' `claude_code_lane` module and its fixture (2.6).
- Moved: RA/process_tree.rs.
- Changed: RA/main.rs, RA/config.rs, RA/controller.rs, RA/agent.rs, RA/agent_executor.rs, RA/isolated_tool_worker.rs, RA/jobs/mod.rs, RA/jobs/stopped_turn.rs, RA/jobs/activity_labels.rs and RA/jobs/reply_draft.rs.
- D22's exec-policy rule, which phase 8 requires, where each Codex run loads its config (RA/codex.rs:2027-2041). Unlike the rest of this phase, it changes Codex turns as soon as it ships.
- A measurement of the process tracking's CPU cost over a long turn (3.6). Done on a debug build: about 74% of one core with 770 processes, mostly system time (D-F). Phase 8 measures a release build.
- The runtime-contracts fixtures and the `CLAUDE_CODE_LANE_VERIFIED_THROUGH` constant (8), the fake binary and its tests, and the live suite gated by `INSTAFY_CLAUDE_CODE_LIVE` (8), which Phase 8 runs.
- The proxy-rule exception text in AGENTS.md, docs/Architecture.md:9 and 470, and README.md. It lands with the first code that starts `claude`.

**Phase 5: Desktop.** Built.
- New: DA/claudeCode/*.
- Changed: DA/desktopExtensionRegistry.ts, DA/publicDesktopFeatureManifest.ts, DA/main.ts, DA/codexCredentialBridge.ts and DRA/index.ts.
- Their tests.

**Phase 6: Studio.** Built, apart from the hosted Studio's manifest, which moved to phase 8 (D-E).
- FE/features/frontendFeatureModule.ts (the `turnEngines` slot), FE/features/claudeCode/* (new), FE/features/publicFrontendFeatureManifest.ts and the hosted Studio's manifest, packages/frontend/hosted/hostedFrontendFeatureManifest.ts (5.1).
- FE/services/runtimeController/runtimes.ts, FE/services/runtimeController/conversations.ts and FE/runtime/useRuntimeMenu.ts.
- SC: ComposerActionMenu.tsx, ChatComposerSurface.tsx, ChatPanel.tsx, composerTurnEngine.ts, useChatSubmitFlow.ts, chatComposerAffordances.ts, CredentialsSettingsCard.tsx, RunFailureNotice.tsx, useRunFailureAutoRetry.ts, useChatRunStopContinuation.ts, useChatCredentialGate.ts, sendIntentErrorMessage.ts, AgentJobThreadPreviewLayout.tsx, AssistantSpeakerIdentityPill.tsx, chatSendQueueStorage.ts and chatMessageStashEnvelope.ts.
- FE/conversations: runFailurePresentation.ts, useConversationSubmitFlow.ts, useConversationAutoTitle.ts, useConversation.tsx and useConversationControllerDispatch.ts.
- Tests.

**Phase 7: CLAUDE.md and documents.** Built. The documents of phases 1, 3 and 4 landed with these (section 7).
- The template, packages/runtime-agent/assets/instafy/CLAUDE.md, and the upgrade rules and pinned tests in RA/jobs/learn.rs and RC/projects.rs (7.5).
- docs/Chat-Activity.md, docs/Credits-Billing.md, docs/Settings-UI.md, docs/Runtime-Machines.md and the plugin README.

**Phase 8: turn it on.**
- Do this only after the previous controller pool is retired.
- Before any user id goes into `CLAUDE_CODE_LANE_USER_IDS`, internal ones included, these release gates must be met:
  - Instafy has recorded that it accepted Anthropic's Commercial Terms or has another agreement with Anthropic;
  - D22's exec-policy rule has shipped (phase 4), as it now has;
  - D22's direct forms are closed: every direct launch that 1.2 and D22 list as one the prefix rule misses is refused in every Codex session the runtime starts on the person's computer, and a test covers each form. One way is a managed `PreToolUse` hook in the same host-supplied requirements bundle, run by runtime-agent's own executable, which parses the command as Codex's shell parser does, walks every command in it (pipelines, redirections, substitutions, heredocs and nested `sh -c` scripts included), skips variable assignments, unquotes the name, expands a leading `~` or `$HOME`, and refuses any spelling of `claude`; that Codex accepts managed hooks from the bundle, and runs them for every command, is confirmed first. Codex turns hooks off for isolated tool workers (`Feature::CodexHooks` in RA/codex.rs), and a hook on commands does not see text written into a terminal session the turn opened (`write_stdin`), so the sign-off says how each of those is closed, or accepts it by name;
  - the hosted Studio whose manifest lists the module is deployed (5.1, D-E). packages/frontend/hosted/hostedFrontendFeatureManifest.ts lists it, the two release guard tests are changed to allow it (scripts/release/web/build-hosted-web.test.mjs and scripts/release/web/workflow-guard.test.mjs), and docs/Web-Release.md says what that manifest composes. Until then a packaged Desktop shows no lane, and a hosted page words a lane turn as an ordinary one, though it never resends, retries or titles it (5.6);
  - the brand review (D28) has checked every lane string as built, the speaker, starting and note lines included;
  - the short opening section that 7.4 asks for is written.

  The owner's decision of 2026-11-13 (1.2) takes the place of the written sign-off on 1.2's risks that earlier drafts listed here.
- Measure what process tracking costs on a release build of runtime-agent, with the ignored test of 3.6, and decide whether the cheaper tracker comes first (D-F).
- Set `CLAUDE_CODE_LANE_USER_IDS` to internal ids. Phase 0 items 1-3, 5, 11 and 12 must hold, item 6 must show that `claude` exits with code 143 on SIGTERM and is not killed by the signal, which a shell would also report as 143 (3.6), item 7 must show what 2.7's resume-miss handling expects (a non-zero exit before `init`, with a missing-session error that differs from other startup failures), and item 4 must hold or D30's fallback must be built. Item 10 must show that a `-p` run writes nothing under `.claude/`, or the pre-flight must first get a rule for those files (3.9); its result is also checked against the lane filter (3.8). Item 9 has no pass or fail; its result is recorded and checked against the kill path (3.6). If item 2 or 12 fails, do not enable; revisit the design. D5's alternative needs a phase of its own first, because it changes the never-passed list (`--add-dir`, 3.3), the working directory (3.3), the `cwd` launch check (3.6) and the argv test (8).
- On macOS, run runtime-agent's tests (8), which public CI runs only on Linux (.github/workflows/build.yml:1672-1697): the library suite, the lane's integration targets and `proxy_integration codex_never_starts_claude::`. Run the live suite on each Claude Code version you support (`INSTAFY_CLAUDE_CODE_LIVE=1 cargo test --manifest-path packages/runtime-agent/Cargo.toml --test claude_code_live -- --ignored --nocapture --test-threads=1`, by hand, on your own Mac and Claude account), record its results with the version in an appendix, and raise `CLAUDE_CODE_LANE_VERIFIED_THROUGH` in a reviewed change. It checks Phase 0 items 1-7 and 9-12 itself and prints the items a person checks by hand: item 2's Project-instructions variant, item 3's `ENABLE_CLAUDEAI_MCP_SERVERS` comparison, and items 8, 13 and 14. Its item 5 holds only when every task list it saw named its tasks and the reply came from a `result` after the task's notification.
- Then widen the switch.

---

## 10. Remaining decisions, with proposed defaults

- **D1. Which agent:** only the sender's own @octo.
- **D2. History in the prompt:** none. Continuity comes only from Claude Code's own session.
- **D3. Permission mode:** `acceptEdits` with permission prompts off.
  - Honouring the person's own `defaultMode` is rejected: Manual is useless here, and `bypassPermissions` is unsafe in a shared folder.
  - A per-turn read-only option (`plan` mode) can come later.
- **D4. Setting sources:** `user`. The alternative, no sources at all, is more locked down but drops the person's allow rules, so most Bash steps would be declined.
- **D5. Working directory:** the space's folder. Bash, git context and Claude Code's per-project sessions all depend on it.
  - The alternative is an empty, runtime-owned directory with `--add-dir <folder>`. By Claude Code's documentation, the working directory, not `--add-dir`, decides which project settings and hooks apply. That keeps the folder's settings hooks, `env` and `apiKeyHelper` out, but not everything: Claude Code still loads an added folder's `.claude/skills/`, `.claude/commands/`, `.claude/agents/` and the `enabledPlugins` and `extraKnownMarketplaces` keys of its settings. Skills, commands and subagents from an added folder load through the `project` setting source, so the alternative still needs `--setting-sources user` and the pre-flight.
  - Its costs: Bash starts outside the folder, and there is no git context.
  - Adopt the alternative if Phase 0 shows that `--setting-sources user` lets project settings in.
  - With either working directory, the project CLAUDE.md does not load under `--setting-sources user` (3.5). A lane turn therefore works without the space's CLAUDE.md conventions unless the person's message asks Claude to read them.
- **D6. A space with its own Claude Code configuration:** refused in v1 by the pre-flight in 3.9, which looks for `.mcp.json` only at the folder's root, where Claude Code reads it. A deeper tracked `.mcp.json`, such as this repository's `claude-plugin/instafy/.mcp.json`, belongs to a plugin, not to the space's configuration. Refusing it would keep the lane out of Instafy's own repository. Relax this later to "allowed when the installed version is at most `CLAUDE_CODE_LANE_VERIFIED_THROUGH`", once the live suite has shown across releases that the lane's flags keep project settings, hooks, MCP servers, skills, agents and commands out.
- **D7. MCP:** none. The lane passes a strict, empty MCP config plus `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Instafy cannot pass the person's own MCP servers without reading their config.
- **D8. Claude Code's own subagents (`Agent`, formerly `Task`):** allowed, inside the one supervised process tree. If the owner counts them as fan-out, pass `--disallowedTools Agent`, and move that one flag out of 3.3's never-passed list and its argv test. That restricts tools, not sign-in.
- **D9. The person's Instafy CLI session.**
  - Default: Claude Code's tools can reach it only as the person's own permission rules allow. Instafy gives the turn no instructions (3.5), so nothing asks Claude not to start turns or automations from it. The controller's fences refuse a second lane turn only while the first is queued or leased. After it ends, a process the turn left behind or set up (a helper that escaped it, D27, or a launchd or cron entry), or a teammate's script that the person's allow rules ran, can post a claimed message to the idle computer with the person's saved `instafy login` session, and the gate admits it as their own: a lane turn nobody typed. A signal the computer holds cannot tell that process from Instafy Desktop, since it runs on the same computer; D29 names the proof that would narrow this. Decided by the owner on 2026-11-13: v1 builds no such proof and accepts the gap, which 1.2 lists. A lane turn that something other than the person starts is a later feature, offered only for an API-key or cloud sign-in (1.2).
  - Alternative: put an `INSTAFY_CLAUDE_CODE_TURN` marker in the child's environment, which the CLI honours by refusing chat sends, turn starts and automation changes. This needs an `@instafy/cli` changeset, and it is defence in depth only, since a process can drop a variable.
- **D10. Model:** the person's default. No picker.
- **D11. Turn limits:** 45 minutes of wall-clock time (2700 s, configurable from 60 to 3000 s) and 15 minutes without an event. The cap keeps the end-of-turn save within the lifetime of the job's internal workspace token, which is minted once at lease and never renewed (3.6). A workspace-token renewal like the proxy-token renewal is the later way to allow longer turns.
- **D12. Start window:** 60 s, the same as the device-grant window. Because a busy computer is refused at send (G7), the window covers only lease latency.
- **D13. Concurrency:** one active lane turn per person, across all spaces. A busy computer is refused with 409, never queued.
- **D14. Stop and steer:** any member with write access may stop; nobody may steer.
- **D15. Resume:** same conversation, agent, person and runtime registration. Desktop never asks for an earlier runtime id, so the controller gives every runtime start a new one (RC/runtime/token.rs:442-451; DA/main.ts:3097-3107). Quitting Desktop, switching spaces or Instafy users, or turning the lane on or off therefore ends continuity, and the next lane turn starts a new session. A failed resume resets the session and runs nothing by itself. The lane never passes `--fork-session`, so `--resume` reuses the stored session id, and a resumed turn writes into that session. A stopped turn saves no state, so the next turn resumes the same session and continues from the stopped turn's partial work, as it would in the person's own terminal after an interrupt. A stopped first turn stores no id, so the next turn starts a new session (2.7).
- **D16. Usage shown:** tokens only, in Details. No cost.
- **D17. Attachments and `/` messages:** refused in v1.
- **D18. Platforms:** macOS Desktop only in v1; Linux and Windows advertise no capability (3.2). Linux Desktop can follow once the live suite has run there. Windows later, since it needs a per-job tree kill and handling of `.cmd` launchers.
- **D19. Where the choice is offered:** only in the Desktop composer. No sends from web or phone to the computer in v1. The controller cannot verify the client, so this is a UX limit.
- **D20. Speaker:** decided by the owner on 2026-11-12: the reply stays @octo's, with the plain-text line "Ran on {Name}'s own Claude Code, on their computer" (5.7). Its sender reads "Ran on your own Claude Code, on your computer" (D-H). The alternative, a "Claude Code" speaker identity, risks suggesting that Anthropic built or partners with Instafy, which Anthropic's terms forbid (D28).
- **D21. The `.claude/` exclusion:** lane saves only. No global publish rule, and no `.git/info/exclude` entry, which would also keep new `.claude/` files out of Codex turns.
- **D22. Codex on Desktop running `claude`.**
  - The embedded Codex runs with full access (RA/codex.rs:13630-13632) as the person's OS user, so an automated or Instafy-written Codex turn could already run their signed-in `claude` today.
  - Decided on 2026-11-13: a harness-level exec-policy rule in the embedded Codex that forbids `claude`. Only isolated workers and granted turns load their config through `load_hardened_codex_config`, whose overrides already set where exec-policy rules come from (RA/codex.rs:6798-6803). Every other Codex turn, automations and goal wake-ups included, loads through `load_runtime_codex_config` (6770-6784) or, after an error, a fallback (2047-2129), and none of these sets loader overrides. The rule must cover all of them.
  - This is a release gate in Phase 8, not an option. Without the rule, an automation, plan worker or goal wake-up that runs Codex on the person's computer can start their signed-in `claude` with text Instafy wrote, which limits 1-3 forbid (1.2). The owner decided on 2026-11-13 that Codex must not start `claude` in v1; what holds is what the rule covers, below.
  - As built, the rule is one forbidden `prefix_rule` whose first word is any of the 64 letter-case spellings of `claude`, since macOS folders ignore case. It lives in Codex's managed requirements, as the bundle the host supplies (`ConfigBuilder::cloud_config_bundle`), which every loader builds from. Requirements apply whatever the loader overrides say, an isolated session included; they outrank an `allow` rule in a user or project file; native subagents keep them; and the bundle adds to a system's own `requirements.toml` and managed preferences, replacing none.
  - **What it refuses.** `claude …` in any letter case; an absolute path to it, such as `/opt/homebrew/bin/claude …`, since Codex also checks an absolute program against the rules for its file name, unless a user or project rules file names that exact path or narrows the name with `host_executable`; and each such command inside a `bash -lc`, `zsh -lc` or `sh -c` script that Codex can split into plain commands, such as `cd app && claude -p …` or `claude -p … | tail`. The model is told: "This runtime does not let an agent start Claude Code. Do the work without it, and do not try another way to start it."
  - **Direct launches it misses.** A script Codex cannot split is checked as one shell command, `/bin/zsh -lc '…'`. That matches no rule, and since a runtime's Codex turns never ask for approval, it runs. A script cannot be split when it holds a redirection (`claude -p "Review the changes" 2>&1 | tail -n 80`, `claude -p … > review.md`), a command substitution (`claude -p "$(cat task.md)"`), a heredoc, a variable set before the name (`FOO=1 claude -p …`), a quoted name (`"claude" -p …`), or a word with a glob, `~` or `$` (`claude -p "fix" src/*.rs`, `~/.local/bin/claude -p …`, `$HOME/.local/bin/claude -p …`; `~/.local/bin` is where the native installer puts `claude`). Only one level is split, so `bash -c 'claude -p …'` inside a splittable script escapes too. Text a turn writes into a terminal session it opened (`write_stdin` into a `tty` shell) passes no exec policy at all. Closing these is a phase 8 gate, before any user id goes into the switch (section 9); the refusal text reaches the model only after a refusal, so a first try in one of these forms never sees it.
  - **Indirect launches, the accepted gap.** A relative path (`./claude`); another name for the same file, such as a link; a program that starts it (`env claude`, `npx @anthropic-ai/claude-code`, `node cli.js`); a script that builds the name; and a program Codex's own configuration starts without consulting the exec policy. A turn can write a stdio MCP server's `command`, `notify` or a hook naming `claude` into `<folder>/.codex/config.toml`, which is both the runtime's default `CODEX_HOME` and the trusted project configuration, and every later ordinary Codex turn there starts it, unattended ones included. `/.codex/` is in the space's `.instafy/.git/info/exclude`, so a save never carries such a file to teammates. A prefix rule cannot stop every indirect launch, and the owner accepted that remaining gap with the decision in 1.2.
  - The same access reaches the person's saved `instafy login` session. A Codex turn, an automation's included, can post a lane-claimed message with it, and G2 takes it as the person's. G7 refuses it only while a job is queued or leased on the target runtime, so a background process the turn leaves behind gets through, and so does a Codex turn on another computer that holds the session. Keeping the session out of Codex's environment would not help, because Codex can read the saved session wherever it is. Decided by the owner on 2026-11-13: v1 builds no per-send proof (D29), so this route stays open; 1.2 names it.
- **D23. `ANTHROPIC_API_KEY` as a project secret:** decided by the owner on 2026-11-12: allowed. The credential guard that ships in Phase 1 refuses only Claude sign-in material (section 6), so `ANTHROPIC_API_KEY` with an API-key value keeps working for every Codex job and app, as today. Limit 5 covers Claude sign-ins, and lane jobs get no secrets at all, whatever the guard does (2.5). The alternative is a broad guard that also refuses every `ANTHROPIC_*` and `CLAUDE_*` name, `CLAUDECODE` and every `sk-ant-` value. It goes further than the limits need and is a breaking change: spaces whose own app calls Anthropic's API with its own key lose that secret, including one already stored.
- **D24. Old Claude-shaped credential rows:** made inert at decode. An optional admin script revokes them.
- **D25. Binary authenticity:** not checked. Instafy runs only the path the person confirmed. A macOS code-signature check can come later.
- **D26. Network and configuration environment:** `detect` also captures `CLAUDE_CONFIG_DIR`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` from the person's login shell, shows them in the consent dialog, and grants them with the binary path. runtime-agent passes them only after validating `CLAUDE_CONFIG_DIR` and the CA file as it validates the binary (absolute; owned by the user or root; not group- or world-writable; not under the workspace root or the project folder), because `CLAUDE_CONFIG_DIR` decides which user settings and hooks load. As built, Desktop checks them the same way before it asks or grants, and names the variable it can't use (`shell_setting_unusable`, 4.1), since the runtime can only refuse the whole grant as `binary_unsafe`. Claude Code's user settings cannot set it, since they live inside it. A sign-in kept only in shell variables (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) is still never passed: that is the price of limit 5, and 3.4's heading says so instead of saying it works. 3.4's never-passed list, its environment test, and the summary's and 7.1's 'sets no `ANTHROPIC_*` or `CLAUDE_*` variable' name `CLAUDE_CONFIG_DIR` as the one exception, carrying the person's own value.
- **D27. Escaping processes:** no hardening in v1 beyond tracking every 50 ms, as the isolated worker polls (3.6). A possible later step is a random per-turn marker in the child's environment, plus a scan of the person's processes for it at turn end. It is not the default because the scan reads every same-user process's environment.
- **D28. Brand:** plain-text statements that a turn runs Claude Code, with no logo. Anthropic's terms for products that run Claude Code forbid using the Claude Code name as part of an Instafy product or feature name, or in a way that suggests Anthropic built, endorses or partners with Instafy. So the README and public docs call the feature "local-engine turns" and say in plain text that such a turn runs Claude Code. Code and configuration identifiers that name the integrated tool (`claude_code_*`, `claudeCode`, `CLAUDE_CODE_LANE_*`, `engine = 'claude-code'`) stay unless the brand review says otherwise, since they name the tool inside code rather than an Instafy feature. The Phase 0 brand review checks every lane string, the speaker line (D20) included, against that rule before any of them lands. As built, the strings landed first, so phase 8 runs that review on every lane string before any user id goes into the switch.
- **D29. Proof of a foreground send beyond the person's session:** decided by the owner on 2026-11-13: none in v1 (D9, D22). Anything stronger needs a signal that only that computer holds. One minted through its runtime's agent token would turn away sends from other computers only; a per-send proof minted by Desktop's main process would also narrow the routes on that computer. That is a follow-up.
- **D30. Prompt delivery:** stdin. If Phase 0 shows that `-p` does not read the prompt from stdin, pass it as the final argv element after `--`, and accept that `ps` then shows it on this computer.

### Decided while building

Decided on 2026-11-13, while the phases were built and reviewed. Code comments cite these ids.

- **D-A. A folder with no repository.** A space folder with neither `.instafy/.git` nor `.git` is refused before spawning as `preflight_failed`, since no turn there could save or say what it changed. The pre-flight refuses it at its start with a plain first line, and no longer walks such a folder (3.9).
- **D-B. Instafy's own seeded files and the import check.** The untracked-import rule does not apply to the root `AGENTS.md` and `INSTAFY.md`, which the Desktop scaffold commits only into `.instafy/.git`. They still follow every other import rule, and their own imports are walked with every rule (3.9).
- **D-C / D-V. A save that fails after a successful run.** The turn is not failed. The reply is delivered with the note "Claude Code's changes stayed on this computer and weren't saved to the space.", the redacted error goes in the `origin/apply-error` artifact, and `apply/files` lists nothing. A Stop that refused the save still ends as a stopped turn (3.8).
- **D-D. A runtime that registered with an older controller.** Accepted and documented, with no code change: such a controller keeps a runtime's self-reported `claudeCode` until the runtime registers again with a current one, so when the release is deployed again after a rollback, the switch stays empty until every runtime has registered again (2.11).
- **D-E. The hosted Studio's manifest.** Not changed while the lane is dark. Listing the module there needs two release guard tests changed, so it moves to phase 8, and a packaged Desktop shows no lane until then (5.1, 9).
- **D-F. What process tracking costs.** About 74% of one core on a debug build with 770 processes, mostly system time. Phase 8 measures a release build, and a cheaper tracker is a follow-up (3.6, 9).
- **D-G. Codes the build chose where the design named none.** 400 `claude_code_turn_engine_unknown` (2.1); 403 `claude_code_turn_starts_no_turns`, for a lane job's message that would start a turn (2.6); 403 `claude_code_turn_has_no_job_token` and `claude_code_turn_takes_no_secrets` (2.5); 403 `claude_code_turn_has_no_proxy` (2.9); 409 `claude_code_turn_takes_no_input`, for a steer (2.8); and 403 `claude_code_turn_not_person`, reason `queued` or `automation`, for the send queue and automations (2.9). Studio reads "Claude Code couldn't take this message." for any `claude_code_*` send refusal that 5.5 does not list.
- **D-H. The sender's own speaker line** reads "Ran on your own Claude Code, on your computer"; teammates read D20's (5.7).
- **D-I. Runtime refusals with no code of 5.5** (job shape, person, mode, markers, prompt, an unknown engine) fail uncoded, and Studio shows the "anything else" sentence. The controller's gate keeps them unreachable (3.1).
- **D-J. `bare_default`** follows 3.2 literally: a help line that says bare is the default gives it even when `--help` lists `--no-bare`. Phase 0 item 1 confirms the wording (3.2).
- **D-K. The build's other choices**, listed in appendix A, stand unless one causes a defect.
- **D-L. How the pre-flight reads a memory file's imports.** As raw text, never as Markdown: every `@` starts a word, and the word and each part of it that ends at ASCII punctuation is a candidate, as written, with its HTML comments removed, and with a link text's escaped brackets read as brackets (3.9). One linear pass, with a budget for each byte, a bounded word length and a bounded number of candidates, replaces the earlier line and CommonMark readings. The final review showed that those readings missed imports Claude Code's own Markdown makes (a code span in a list item, a fence line or an HTML tag that ends a paragraph in CommonMark but not in Claude Code's Markdown, an escaped character right after a word), and that a Markdown parser could be made to spend minutes, or gigabytes, on one memory file outside any budget. The raw reading finds every path Claude Code could import, and more.
  - The trade-off is false refusals. A word Claude Code never imports refuses every turn in the space when it names a path 3.9 refuses: a `@/tmp/…`, `@~/…` or `@../…` path in a code block, or `.env`, a part of `@.env.example`, for anyone with an untracked `.env`. A memory file with more than 4,096 characters after an `@` and no white space, and memory files whose candidates pass 20,000 in one pre-flight, as a few 1,000-character lines of minified JSON can, are refused as `preflight_failed`, also in code.
  - Cutting words only where Claude Code's Markdown can end a token would remove the `.env.example` case. That is a later choice.

Also decided that day, while fixing what the review of the build found:
- The D22 rule ships as it is, with no per-command hook yet: a hook would start a process before every Codex command of every turn, now, for a lane that is dark. Closing the forms it misses is a phase 8 gate (D22, section 9).
- A teammate's Details for a failed turn keep the steps, not the raw text (5.5).
- The startup probe has one deadline for its three commands (3.2).
- The lane's shared lists and one recorded lane job payload live in runtime-contracts, and every package tests against them (2.6, 8).
- Studio words `claude_code_runtime_not_ready` by its reason (5.5).
- Two behaviours are documented, not changed: teammates get a lane turn's streaming reply draft, as for any turn on `main` (5.7), and Desktop trusts Studio's session as the key of the local consent record (4.1).

---

## Appendix A. As built

Where the build chose a detail the design left open, or checked more than it asked. D-K accepts each. Sections 1-10 stay the reference; this list helps read the code.

### A.1 Controller

- **Intake.** The claim is read in both spellings. The controller's own keys (`claudeCode`, `claudeCodeFailure`, in both spellings) are stripped from a send's metadata and from its nested copies (`prompt_metadata`, `promptMetadata`, `details`). The person's message carries the lane stamps at the top of its metadata and inside `prompt_metadata`.
- **Stage 1 order.** G1; then G2's service-role, own-session and delegation checks; then every G3 key; then the rest of G2 (typed, received now, an existing chat). All of these are 403 `claude_code_turn_not_person`, so the order changes only `details.reason`.
- **G3 keys.** Wider than 2.2's list, failing closed: also `retryAutomatic`, `dispatch_content`, `browserHandBack` and `browser_hand_back`, `space_review`, and `browserRequestOf`, a browser card's continuation, which asks in Instafy's words. A key counts when present, null included, and its refusal names it in `details.key`.
- **G5 and G6.** `ui.requestedPreview: false` is refused too, since 2.2 asks for `requested_preview` to be absent. G6 also requires the canonical `_instafySelfHostedAccess` with `mode: "private"` and an `ownerUserId` equal to the sender, as the lease clause compares it, and compares the capability's version as a number, so `1.0` counts and the string `"1"` does not. The runtime row is loaded `for share` in Stage 2's `admit`, not where the Personal Browser check runs, and is then the dispatch's strict runtime record.
- **Payload and pin.** A lane payload that would carry the evaluation marker is a 500 that rolls back, which the gate makes unreachable. `target_runtime_for_agent_job` is unchanged; dispatch pins the job to `admission.runtime_id` where it calls it. `AgentJob` serializes `engine` only when it is set, so other jobs' lease answers are unchanged.
- **Reasons** (`details.reason`). G1: `not_allowed`. G2: `service_role`, `not_own_session`, `delegated`, `not_typed`, `received_earlier`, `new_conversation`. G3: `queued`, `goal_wakeup`, `goal_parent_job`, `automation`, `internal_review`, `site_intent`, `hand_back`, `automatic_retry`, `thread_kind`, `resend`, `goal_continuation`, `dispatch_content`, `display_content`, `special_dispatch`, `controller_dispatch`, `space_review`, `browser_card`. G4 and G5: `not_plain_turn`, `targets`, `not_octo`, `recorded_earlier`, `intent`, `execution_mode`, `plan_seed`, `tool_limits`, `repo`, `requested_preview`, `thread_kind`, `attachments`, `empty`, `too_long`, `command`, `write_intent`, `write_scope`. G6: `no_runtime`, `runtime_missing`, `not_private`, `not_owner`, `personal_browser`, `not_dispatch_ready`, `capability_missing`, `capability_not_ready`. G7: `machine_busy`. G8: `turn_active`, `start_window_passed`. Granted chat: `conversation_granted`. Unknown claim: `unknown_engine`. Steer: `steer`. Secrets, job token and proxy renewal: `local_engine`. A lane job's refused message: `plan`, `user_input_request`, `hand_back`, `action_request`, and `too_deep` for metadata nested past 12 levels.
- **A lane job's messages.** They are refused by message type (`multi_agent_plan`, `action_request`, `user_input_request`, `request_browser`) and by plan, question, browser-card and hand-back keys at any depth; past 12 levels the walk fails closed. A lane parent's plan gets a 403 rather than the browser-bound 400, so the job is never settled as a refused plan.
- **Runtime token.** Naming `claude_code.turns` without `localEngine: "claude-code"` is a 400, as for `personal_browser.control`; naming it with the flag but without the right to it is a 403. Sending `localEngine` without that right gets a token without the scope and no error, so Desktop's start works while the switch is empty. Any other `localEngine` value asks for nothing.
- **Attestation and status.** Besides the Personal Browser condition of 2.10, attestation strips a snake_case `claude_code`, keeps `reason` only while `ready` is false, and accepts `cli` as MAJOR.MINOR.PATCH with an optional short suffix. Status's viewer is a person's own interactive session, so a scoped token or the service role sees neither `claudeCode` nor `claudeCodeLane`.
- **Completion.** A lane conversation state is kept only when it names the runtime that leased the job, rebuilt from its known fields, and a state with extra keys is dropped; `load_session` also needs its `runtimeId` to be the admitted runtime. Codex run logs are dropped by a second update in the completion's transaction, and the planning-receipt path also drops a provider or state that names `claude-code`. The usage row is a `token_usage` message whose details are `{kind: "claude_code_turn_usage", billed: false, model, usage}`, with the model cut to 200 characters and the four raw counts.
- **Sweeps and stop.** The expired-lease step treats a leased lane job with no `lease_expires_at` as expired, as the idle release does, and locks rows in id order. A stop's failure message is stored as "Instafy Desktop stopped on this turn's computer, so the turn ended and won't run again. Send it again to run it.", and Studio words it from `claudeCodeFailure`. The stopped and quarantined runtime events list the lane jobs they failed. `record_job_end` reads only jobs with no engine, so a lane job teaches pacing nothing.
- **Guard.** `claudeAiOauth` and `claude_ai_oauth` match ignoring ASCII case, and the JSON walk checks object keys as well as strings. The letter or digit before `sk-ant-` is ASCII only. A value at depth 9 or deeper counts as material. A refused decode answers with the same 400 `claude_credential_refused`. `refused` is sent only when true, by the listing and by an update. The listing judges a row that no key opens by its name alone, and delivery skips a reserved name before decrypting it.

### A.2 Runtime agent

- **Capture.** A missing or empty `INSTAFY_CLAUDE_CODE_BIN`, a path that does not exist, one that is not a regular file and one with no execute bit give `binary_missing`. A relative path, a bad user id, a malformed `INSTAFY_CLAUDE_CODE_ENV_JSON`, a relative D26 path, a failed ownership, writability or folder check, and too many links give `binary_unsafe`. The capture runs the file checks, and a failure publishes the not-ready capability at once, with no probe. PATH entries are checked each time the environment is built. The `admin` allowance comes from the `admin` group on macOS only, and D26 values get none.
- **Probe.** The 256 KiB cap counts stdout and stderr together. A per-turn `auth status` that fails gives `planSignIn: false`, never a failed probe; only at startup does one that the shared deadline cuts short fail the probe (3.2). Probe folders and the MCP config file live in the launch snapshot's `TMPDIR`, mode 0700, and a `TMPDIR` inside the workspace roots fails the probe. `CLAUDE_CODE_LANE_VERIFIED_THROUGH` is `2.1.314`, so the floor version reports `verified: true` before the live suite has run on it.
- **Events.** The adapter sends a `draft.reset` event of its own after top-level commentary, and only the lane sends it, so Codex's drafts are unchanged. Commentary is recognized from the start of a `tool_use` block. A `result` whose subtype starts with `error` counts as an error. Only exit 143 after the runtime's own SIGTERM counts as 0, so a `claude` that must be killed after its result fails as `crashed`. Work before `system/init`, or a success with no `init`, is `unexpected_configuration`; exit 0 with no result is `crashed`. The fallbacks that classify from text are fixed phrase lists, for a sign-in, a plan limit and a resume miss, and the plan-limit reset time goes in the failure text as "The limit resets at <UTC time>." The run log leaves out `stream_event` lines, thinking, `total_cost_usd` and `modelUsage`. The quiet label reads "Looking through files" ("looked through files" once done), for Read, Grep, Glob, LS and NotebookRead.
- **Pre-flight.** Each `preflight_failed` refusal says why in its first line: "Instafy took too long to check this space's folder." past the deadline; "git took too long to list this space's files, so Instafy couldn't check them." after git's 30 s; "git couldn't list this space's files, so Instafy couldn't check them: …", with git's first line cut to 300 characters before the turn's redaction (3.6); "… is too large for Instafy to check what it brings in." over 1 MiB; "… has too many @ imports for Instafy to check what it brings in." over the reading budget; "… has an @ import too long for Instafy to check what it brings in." for a word past 4,096 characters; "This space's CLAUDE.md and AGENTS.md files bring in too many files for Instafy to check." past 512 files; and "This space's CLAUDE.md and AGENTS.md files have too many @ imports for Instafy to check what they bring in." past 20,000 candidates. When the folder or a memory file cannot be read, or git cannot be run, the line says so with the system's own error, through the same redaction.
- **Job checks.** Markers are refused by key presence with any value but null: 3.9's list, plus `spaceReview`, `controllerDispatch`, `workerInputRouting`, `multi_agent_plan`, the browser hand-back keys, `dispatch_content`, the payload's `plan_seed`, `planSeed` and `browser_hand_back_reads_note`, a group participation of `agent_evaluation`, and attachments under any of three keys.
- **Turn.** A failed turn sends no conversation state, except the reset after `session_unavailable`. A file whose content cannot be read stays off the save, named "Not saved: … (Instafy couldn't check it for a Claude key)". A link is checked by the path it holds, which is what git saves. Held pages, the origin's not-saved sentences, the lane filter and the stayed-on-this-computer line are each a note of their own.
- **Re-registration** is wired in agent.rs: each registration sends a copy of the configuration with the lane's published capability, and the lease loop adopts a renewal at its next idle point, which restarts the origin and tunnel as a token renewal already does.
- **D22.** Where Codex names a requirement's source, the rule's source reads "enterprise-managed requirements Instafy runtime (instafy-runtime-agent)". The three loaders build from one `runtime_codex_config_builder`, and the fallback is a named `load_fallback_codex_config`.
- **The live suite** is an ignored test whose reason starts "not run:". Run with `--ignored` but without its variable, it fails, and it refuses to run when `CI` is set. Without `INSTAFY_CLAUDE_CODE_BIN` it runs the first `claude` on `PATH`. An item the model did not show is marked unconfirmed, which fails the suite.

### A.3 Desktop

- **Ids.** The feature module is `instafy.claude-code`; its extension and launch grant are `claude-code`.
- **Host context.** It also carries native dialogs, with a file picker that keeps a picked link as a link, and the folders Desktop owns, for validation. The consent store is scoped to the module, the controller origin and the user, so a method reaches no other record, and a grant's `resolve` receives that record.
- **Controller origin.** The invoke request may carry `controllerUrl`, which the runtime-start trust policy checks. Without it, a packaged build uses its pinned controller and an unpackaged one its running runtime's.
- **Detection** prints PATH and the D26 values with `/usr/bin/printenv`, so they are the exported values in any shell, fish included, between markers that carry a nonce for each run. On a timeout the shell's whole process group is killed.
- **Grant keys** must start with `INSTAFY_`, and never with `INSTAFY_RUNTIME_` or `INSTAFY_PERSONAL_BROWSER_`. Both the registry, when it is built, and desktop-runtime-agent, on every start, check this, so a grant can never override the runtime's identity, controller or proxy values.

### A.4 Studio

- **The lane flag.** The bridge reads `claudeCodeLane` with a runtime-status request of its own, and only after Desktop's module answers `supported: true`: on mount, when the space changes, and on window focus at most every 5 minutes. An entry's `claudeCode` is kept only when the same answer carries `claudeCodeLane: true`. After a refused `status`, a page asks Desktop no more; a refused action does not stop status reads.
- **Desktop.** Studio invokes the extension `claude-code` and passes `controllerUrl`.
- **Sends.** A claimed send skips the whole send-time title call, the local first-line name included, so a chat with only lane messages keeps its default title. Beyond 5.2's list, a message over 100,000 characters is blocked in Studio, the private-chat invite check runs before routing, and the preflight skips its `/invite` and GitHub-import handling for a claimed send and never queues one once Studio's own busy check has passed. A routed send's metadata carries the participation bypass, never a participation decision. The claim helpers read both spellings and remove the key whatever its value.
- **Wording.** For a lane turn, the starting line takes the place of the notice that a cloud computer is busy. A lane failure's own first line is shown only when it also avoids "runtime", "switch" and ids. A `plan_limit` reset time is read only from text such as "resets 2pm", "reset at 5pm (TZ)" or "resets in 3 hours".
- **Your AI row.** It reads the lane flag and readiness for the space Desktop runs on this computer or, when none runs, the space open in Studio. The first-use note shows once the lane is on and is remembered per browser. Find and Locate… always show, and Use for my messages waits until Claude Code is found.

### A.5 Checked end to end

On 2026-11-13 the built controller and runtime ran against an isolated local stack, with the runtime started as Desktop starts it and the fake binary in place of `claude`. A covered send was admitted and ran once, with 3.3's exact argv, the allowlisted environment and the prompt on stdin byte for byte. It streamed its steps, stamped its reply and saved its session, and the next message resumed it. A second send while it ran got `claude_code_machine_busy`, a steer got `claude_code_turn_takes_no_input`, and a Stop killed the turn's background child and its `setsid` grandchild. Signed-out and plan-limit runs failed with their codes. An old version failed its turn as `unsupported_version`; the runtime registered again as not ready, the next send got `claude_code_runtime_not_ready`, and once the version was restored, the timed re-probe made the lane ready again in about 50 s. With the switch empty, as shipped, nothing was attested, the status route said nothing of the lane, and a claimed send got 403 `claude_code_turn_not_allowed` and recorded nothing. The drive found two defects, both fixed: the runtime read the payload's top-level `executionMode` as the execution mode (2.5, 3.9), and Studio worded every `claude_code_runtime_not_ready` as a computer that isn't connected (5.5).
