//! Local-engine turns: one @octo turn that a person sends from Instafy Desktop
//! and that their own Claude Code, signed in on their own computer, carries
//! out. docs/Local-Engine-Turns.md calls the mechanism "the lane".
//!
//! Dispatch marks and admits such a turn here, inside its one funnel
//! (`dispatch::process_dispatch_prompt_timed`):
//! - [`take_claim`] takes the client's claim, `metadata.turnEngine:
//!   "claude-code"`, from every caller, the service role included, and drops
//!   any client copy of the controller's own stamps;
//! - [`check_sender`] (Stage 1: G1-G3) runs right after it: the lane is on for
//!   the sender, their own session sent the message now, and it carries no
//!   mark of anything Instafy wrote, queued, resent or delegated;
//! - [`admit`] (Stage 2: G4-G8) runs once the turn's targets are known: one
//!   plain turn to the sender's own @octo, on their own ready and idle
//!   computer, with no other lane turn of theirs running or waiting to start.
//!
//! Every refusal comes before dispatch writes a prompt, run, message or job,
//! so it writes nothing and burns no credit. Each is a 4xx with a
//! `claude_code_*` code and a `details.reason`. Nothing here falls back to
//! another engine. An admitted job is stamped `agent_jobs.engine =
//! 'claude-code'` ([`ENGINE`]), whose CHECK forbids a credential, grants and a
//! plan role, and whose partial unique index ([`ONE_ACTIVE_TURN_INDEX`]) allows
//! one active lane turn per person.
//!
//! The rest of an admitted job's life reads that column, never payload
//! metadata (docs/Local-Engine-Turns.md 2.4-2.9):
//! - it is leased once, within a minute, only by its pinned, attested runtime,
//!   with no proxy envelope, model-facing token, history or extras
//!   (`agent::lease_next_agent_job`, `device_grants::run_once_job_cannot_start`);
//! - it gets no secrets, proxy renewal, job token, steer, plan, question or
//!   hand-back ([`takes_no_secrets`], [`has_no_proxy`], [`has_no_job_token`],
//!   [`takes_no_input`], [`refuse_message_that_starts_a_turn`],
//!   [`plans_nothing`]);
//! - its completion keeps only what the lane writes ([`completion_provider`],
//!   [`completion_conversation_state`], [`drop_codex_run_logs`],
//!   [`reported_usage`], [`reported_failure_code`]) and bills nothing;
//! - nothing retries, requeues or moves it: a runtime stop, an expired lease
//!   and the run-once sweep fail it with a message its author's Studio words
//!   ([`stamp_failure`]);
//! - its next turn resumes only its own session ([`load_session`]).

use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::error::SqlState;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::config::{AppConfig, CLAUDE_CODE_LANE_MAX_PROMPT_CHARS};
use crate::conversations::ConversationRecord;
use crate::dispatch::DispatchPromptNormalized;
use crate::job_trigger::TriggerKind;
use crate::{internal_error, runtime, workspace, ApiError, AppState};

type Refusal = (StatusCode, Json<ApiError>);

/// `agent_jobs.engine` of a lane job. Only [`admit`]'s admission writes it,
/// through `agent::enqueue_agent_job_record`.
pub(crate) const ENGINE: &str = "claude-code";
/// The `aiAccessMode` of a lane turn's run, messages and job.
pub(crate) const AI_ACCESS_MODE: &str = "claude-code";
/// The client's claim on a send, and the one value it may have. Both
/// spellings are read, as the controller reads its other metadata, so a send
/// can never carry the claim past the gate under the other one.
const CLAIM_KEYS: [&str; 2] = ["turnEngine", "turn_engine"];
/// The controller's stamp on a lane turn's run, messages, job and reply:
/// `{"version": 1}`. A client's copy never survives intake.
pub(crate) const STAMP_KEY: &str = "claudeCode";
const STAMP_VERSION: u64 = 1;
/// The failure code the controller copies onto a lane turn's failure message.
/// Only the controller writes it.
pub(crate) const FAILURE_KEY: &str = "claudeCodeFailure";
/// The lane keys of a send's or a recorded message's metadata that only the
/// controller writes, in both spellings: a client's copy is never kept.
const CONTROLLER_KEYS: [&str; 4] = [STAMP_KEY, "claude_code", FAILURE_KEY, "claude_code_failure"];
/// Nested copies of a message's metadata a client could also fill in.
const NESTED_METADATA_KEYS: [&str; 3] = ["prompt_metadata", "promptMetadata", "details"];
/// The partial unique index that allows one active lane turn per person
/// (supabase/migrations/20261113113604).
pub(crate) const ONE_ACTIVE_TURN_INDEX: &str = "agent_jobs_one_active_claude_code_turn_idx";
/// The runtime capability that registration attests for a lane-capable
/// runtime, and its one version.
const CAPABILITY_KEY: &str = "claudeCode";
const CAPABILITY_VERSION: f64 = 1.0;
/// The controller's attestation of a private self-hosted runtime's owner, as
/// registration writes it (`runtime::set_self_hosted_access_attestation`) and
/// the lease reads it.
const SELF_HOSTED_ACCESS_KEY: &str = "_instafySelfHostedAccess";

/// G1: the lane is not on for the sender.
pub(crate) const TURN_NOT_ALLOWED: &str = "claude_code_turn_not_allowed";
/// G2, G3: not the person's own message, sent now.
pub(crate) const TURN_NOT_PERSON: &str = "claude_code_turn_not_person";
/// G4, G5: not one plain turn to the sender's own @octo.
pub(crate) const TURN_NOT_PLAIN: &str = "claude_code_turn_not_plain";
/// G6: not the sender's own computer, ready for a lane turn.
pub(crate) const RUNTIME_NOT_READY: &str = "claude_code_runtime_not_ready";
/// G7: the computer has another job queued or running.
pub(crate) const MACHINE_BUSY: &str = "claude_code_machine_busy";
/// G8: the sender already has a lane turn running or waiting to start.
pub(crate) const TURN_ACTIVE: &str = "claude_code_turn_active";
/// A chat whose device grants name someone else.
pub(crate) const CONVERSATION_GRANTED: &str = "claude_code_conversation_granted";
/// A claim naming an engine that is not [`ENGINE`].
pub(crate) const TURN_ENGINE_UNKNOWN: &str = "claude_code_turn_engine_unknown";
/// G8's `details.reason` when the blocking turn can no longer start: the run
/// once sweep is about to mark it as not run.
pub(crate) const START_WINDOW_PASSED: &str = "start_window_passed";

/// A steer into a running lane turn: nothing can deliver words into a running
/// `claude -p` (docs/Local-Engine-Turns.md 2.8).
pub(crate) const TURN_TAKES_NO_INPUT: &str = "claude_code_turn_takes_no_input";
/// A proxy-token renewal for a lane job, which never had an envelope.
pub(crate) const TURN_HAS_NO_PROXY: &str = "claude_code_turn_has_no_proxy";
/// `/agent/secrets` for a lane job, which gets no project secrets.
pub(crate) const TURN_TAKES_NO_SECRETS: &str = "claude_code_turn_takes_no_secrets";
/// A job token whose job is a lane job, which is never minted one.
pub(crate) const TURN_HAS_NO_JOB_TOKEN: &str = "claude_code_turn_has_no_job_token";
/// A lane job's message or plan that would start a turn: a team's plan, a
/// question that waits for an answer, or a browser card and its hand-back.
pub(crate) const TURN_STARTS_NO_TURNS: &str = "claude_code_turn_starts_no_turns";

/// The provider id a lane job's completion stores, and the `provider` of its
/// conversation state.
pub(crate) const PROVIDER: &str = "claude-code";
/// The version of a lane conversation state.
const CONVERSATION_STATE_VERSION: u64 = 1;
/// The artifact a lane job's runtime fails it with: `{"kind":
/// "claude-code/failure", "code": "<code>"}`.
pub(crate) const FAILURE_ARTIFACT_KIND: &str = "claude-code/failure";
/// The artifact with what Claude Code reported a lane turn used: `{"kind":
/// "claude-code/usage", "model": "<model>", "usage": {"input_tokens",
/// "cache_creation_input_tokens", "cache_read_input_tokens",
/// "output_tokens"}}`, as its `result.usage` reads.
pub(crate) const USAGE_ARTIFACT_KIND: &str = "claude-code/usage";
/// The only artifact billing reads (`agent::extract_turn_usage_from_artifacts`).
/// No lane turn writes one, and a lane job's completion drops any.
const CODEX_RUN_LOG_KIND: &str = "codex/run-log";
/// The `details.kind` of a lane turn's Details-only usage row.
pub(crate) const USAGE_DETAILS_KIND: &str = "claude_code_turn_usage";
/// The longest model name the usage row keeps.
const USAGE_MODEL_MAX_CHARS: usize = 200;
/// The failure codes a lane job's runtime reports that the controller copies
/// onto its failure message as [`FAILURE_KEY`]: the rows of the failure
/// table above `claude_code_turn_not_allowed` (docs/Local-Engine-Turns.md
/// 5.5). Any other code is left off, and Studio words the failure as one with
/// no code.
pub(crate) const RUNTIME_FAILURE_CODES: [&str; 16] = [
    "not_signed_in",
    "plan_limit",
    "binary_missing",
    "binary_unsafe",
    "unsupported_version",
    "probe_failed",
    "bare_default",
    "session_unavailable",
    "turn_timeout",
    "stalled",
    "crashed",
    "unexpected_configuration",
    "project_config",
    "unsafe_import",
    "unsafe_link",
    "preflight_failed",
];
/// The failure code of a lane job a runtime stop failed: the computer's
/// Instafy stopped while the turn ran or before it started.
pub(crate) const MACHINE_STOPPED: &str = "claude_code_machine_stopped";
/// What the failure message of a lane job a runtime stop failed says, before
/// Studio words it from [`FAILURE_KEY`].
pub(crate) const MACHINE_STOPPED_MESSAGE: &str = "Instafy Desktop stopped on this turn's \
     computer, so the turn ended and won't run again. Send it again to run it.";

/// A send's metadata keys that mark something Instafy wrote, queued, resent or
/// delegated (G3), with the `details.reason` of the refusal. A key counts
/// whatever its value, null included.
const NOT_A_PERSON_KEYS: [(&str, &str); 22] = [
    // Studio's marks on a resend, by hand or by itself (crate::job_trigger,
    // crate::system_turns).
    ("retryOfMessageId", "resend"),
    ("retryAutomatic", "resend"),
    // A goal's next turn.
    ("goalContinuation", "goal_continuation"),
    ("goal_continuation", "goal_continuation"),
    // What the app dispatches in place of the text it shows.
    ("dispatchContent", "dispatch_content"),
    ("dispatch_content", "dispatch_content"),
    // What Studio shows in place of the stored text, so everyone would not
    // see the words the turn ran.
    ("displayContent", "display_content"),
    ("display_content", "display_content"),
    ("composerMessage", "display_content"),
    ("composer_message", "display_content"),
    // Every key `dispatch::metadata_marks_special_dispatch` reads.
    ("browserTransport", "special_dispatch"),
    ("browser_transport", "special_dispatch"),
    ("agentThread", "special_dispatch"),
    ("agent_thread", "special_dispatch"),
    ("automation", "special_dispatch"),
    ("command", "special_dispatch"),
    ("linkedThreadId", "special_dispatch"),
    ("linked_thread_id", "special_dispatch"),
    ("multiAgentPlan", "special_dispatch"),
    ("multi_agent_plan", "special_dispatch"),
    // Any controller dispatch, and a space review.
    ("controllerDispatch", "controller_dispatch"),
    ("controller_dispatch", "controller_dispatch"),
];
/// More G3 keys: a hand-back's own stamp, a space review, and a browser
/// card's continuation (crate::system_turns), which asks the card's task in
/// Instafy's words.
const MORE_NOT_A_PERSON_KEYS: [(&str, &str); 5] = [
    (crate::browser_hand_back::HAND_BACK_KEY, "hand_back"),
    ("browser_hand_back", "hand_back"),
    ("spaceReview", "space_review"),
    ("space_review", "space_review"),
    ("browserRequestOf", "browser_card"),
];
/// Metadata keys the write-scope plan reads (crate::agent_write_scopes), at
/// the top level, in either spelling and with any value, null included. Any
/// of them can make the turn's scope `coordination_required`, which refuses
/// workspace writes; without them a single-agent write is `unscoped`.
const WRITE_SCOPE_KEYS: [&str; 6] = [
    "writeScope",
    "write_scope",
    "writeScopes",
    "write_scopes",
    "agentWriteScopes",
    "agent_write_scopes",
];
/// The same plan's keys under `agentSelection`.
const SELECTION_WRITE_SCOPE_KEYS: [&str; 2] = ["writeScopes", "write_scopes"];
/// The keys a lane job's payload metadata keeps from dispatch's own
/// (docs/Local-Engine-Turns.md 2.5), beside the stamps: the controller's
/// `agent`, `writeScope`, `conversationVisibility` and `runtimePreference`,
/// and the client's `input` and `writeIntent`. Nothing else a client sent,
/// such as a `userId` of its choosing, reaches the runtime.
const PAYLOAD_METADATA_KEYS: [&str; 6] = [
    "agent",
    "writeScope",
    crate::dispatch::CONVERSATION_VISIBILITY_KEY,
    "runtimePreference",
    "input",
    "writeIntent",
];

/// What dispatch already took out of a send's metadata before Stage 1, so
/// Stage 1 can refuse a send that carried any of them.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TakenClaims {
    /// "Via a site" (crate::site_intent).
    pub(crate) site_intent: bool,
    /// "This continues a browser turn" (crate::browser_hand_back).
    pub(crate) hand_back: bool,
    /// "Instafy sent this again by itself" (crate::system_turns).
    pub(crate) automatic_retry: bool,
}

/// A claimed send that passed Stage 1 ([`check_sender`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LaneSend {
    /// The person whose own session sent it.
    pub(crate) sender: Uuid,
    /// The runtime the request itself named, if any, recorded before the
    /// conversation's stored preference can fill a missing one.
    pub(crate) runtime_id: Option<Uuid>,
}

/// An admitted lane turn ([`admit`]): its one job runs on this runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LaneAdmission {
    pub(crate) runtime_id: Uuid,
}

/// One agent a turn goes to, as dispatch resolved it against the sender's own
/// agents.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Target<'a> {
    pub(crate) handle: &'a str,
    pub(crate) agent_id: Option<Uuid>,
}

/// What dispatch knows of a claimed turn when Stage 2 runs.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Turn<'a> {
    /// Dispatch's `plain_turn`: no browser target or transport, no runtime
    /// spread, no evaluation and no plan seed.
    pub(crate) plain_turn: bool,
    pub(crate) skill_mode_ambient_evaluation: bool,
    pub(crate) targets: &'a [Target<'a>],
    /// A message was recorded earlier under the send's client message id.
    pub(crate) recorded_earlier: bool,
}

fn refusal(status: StatusCode, code: &str, message: &str, details: JsonValue) -> Refusal {
    (status, Json(ApiError::with_details(message, code, details)))
}

fn not_allowed(reason: &str) -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_NOT_ALLOWED,
        "Claude Code turns aren't on for your account yet.",
        json!({ "reason": reason }),
    )
}

fn not_person(reason: &str) -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_NOT_PERSON,
        "Claude Code takes only a message you send yourself.",
        json!({ "reason": reason }),
    )
}

fn not_person_key(reason: &str, key: &str) -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_NOT_PERSON,
        "Claude Code takes only a message you send yourself.",
        json!({ "reason": reason, "key": key }),
    )
}

fn not_plain(reason: &str) -> Refusal {
    refusal(
        StatusCode::UNPROCESSABLE_ENTITY,
        TURN_NOT_PLAIN,
        "Claude Code takes only a plain message to Octo, of at most 100,000 characters, \
         without attachments or a command.",
        json!({ "reason": reason }),
    )
}

fn not_plain_key(reason: &str, key: &str) -> Refusal {
    refusal(
        StatusCode::UNPROCESSABLE_ENTITY,
        TURN_NOT_PLAIN,
        "Claude Code takes only a plain message to Octo, of at most 100,000 characters, \
         without attachments or a command.",
        json!({ "reason": reason, "key": key }),
    )
}

fn runtime_not_ready(reason: &str) -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        RUNTIME_NOT_READY,
        "Your computer isn't connected to this space. Open this space in Instafy Desktop, \
         then send your message again.",
        json!({ "reason": reason }),
    )
}

fn machine_busy() -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        MACHINE_BUSY,
        "Your computer is busy with another turn. Send this when it's done.",
        json!({ "reason": "machine_busy" }),
    )
}

/// G8's refusal, and the one-active-turn index's (`agent::enqueue_agent_job_record`).
/// `start_window_passed`: the blocking turn can no longer start, and the
/// sweep, every 10 s, is about to mark it as not run.
pub(crate) fn turn_active(start_window_passed: bool) -> Refusal {
    if start_window_passed {
        refusal(
            StatusCode::CONFLICT,
            TURN_ACTIVE,
            "Your last Claude Code turn didn't start in time and is about to be marked as \
             not run. Send this again in a few seconds.",
            json!({ "reason": START_WINDOW_PASSED }),
        )
    } else {
        refusal(
            StatusCode::CONFLICT,
            TURN_ACTIVE,
            "You already have a Claude Code turn running. Send this when it ends.",
            json!({ "reason": "turn_active" }),
        )
    }
}

/// The refusal of a claimed send in a chat whose device grants name someone
/// else, where dispatch would only record it (`device_grants::starts_agent_turns`):
/// it is refused before anything is recorded.
pub(crate) fn conversation_granted() -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        CONVERSATION_GRANTED,
        "In this chat, Octo takes turns only from the person who started the chat, so \
         Claude Code can't run your message here.",
        json!({ "reason": "conversation_granted" }),
    )
}

fn engine_unknown() -> Refusal {
    refusal(
        StatusCode::BAD_REQUEST,
        TURN_ENGINE_UNKNOWN,
        "turnEngine must be \"claude-code\".",
        json!({ "reason": "unknown_engine" }),
    )
}

/// Whether `metadata` carries the claim, whatever its value: what the send
/// queue, automations and the busy chat's queue fallback refuse or skip,
/// since none of them may ever hold a lane turn.
pub(crate) fn carries_claim(metadata: Option<&JsonValue>) -> bool {
    metadata
        .and_then(JsonValue::as_object)
        .is_some_and(|map| CLAIM_KEYS.iter().any(|key| map.contains_key(*key)))
}

/// The refusal of a claim outside a send: a send-queue entry, its edit, or an
/// automation's prompt. None of them may ever start a lane turn.
pub(crate) fn refuse_claim_outside_a_send(
    metadata: Option<&JsonValue>,
    reason: &str,
) -> Result<(), Refusal> {
    if carries_claim(metadata) {
        return Err(not_person(reason));
    }
    Ok(())
}

/// Removes every key only the controller may write from a client's
/// `metadata`: the claim, the `claudeCode` stamp and the failure code, at the
/// top level and in its nested copies. Recorded messages go through this for
/// every caller, the service role included
/// (`conversations::sanitize_client_recorded_message_metadata`).
pub(crate) fn strip_client_marks(metadata: &mut JsonValue) {
    let Some(map) = metadata.as_object_mut() else {
        return;
    };
    for key in CLAIM_KEYS.iter().chain(CONTROLLER_KEYS.iter()) {
        map.remove(*key);
    }
    for nested_key in NESTED_METADATA_KEYS {
        if let Some(nested) = map.get_mut(nested_key).and_then(JsonValue::as_object_mut) {
            for key in CLAIM_KEYS.iter().chain(CONTROLLER_KEYS.iter()) {
                nested.remove(*key);
            }
        }
    }
}

/// Takes the claim out of a send's `metadata`, for every caller, the service
/// role included, and drops the client's copies of the controller's own
/// marks ([`strip_client_marks`]). `true` when the send claims the lane:
/// `turnEngine` is `"claude-code"`. Any other value, null included, is a 400:
/// the send never runs on another engine instead. The claim is never
/// persisted anywhere.
pub(crate) fn take_claim(metadata: &mut JsonValue) -> Result<bool, Refusal> {
    let mut claimed = false;
    let mut unknown = false;
    if let Some(map) = metadata.as_object_mut() {
        for key in CLAIM_KEYS {
            match map.remove(key) {
                Some(value) if value.as_str() == Some(ENGINE) => claimed = true,
                Some(_) => unknown = true,
                None => {}
            }
        }
    }
    strip_client_marks(metadata);
    if unknown {
        return Err(engine_unknown());
    }
    Ok(claimed)
}

/// Stage 1, for a claimed send, directly after the claims are taken
/// (docs/Local-Engine-Turns.md 2.2):
/// - G1: the lane is on for the sender;
/// - G2: the person's own session sent it, now, to a conversation that
///   already existed, and no job delegated it;
/// - G3: it carries no mark of anything Instafy wrote, queued or resent.
///
/// It records the runtime the request named, before the conversation's
/// stored preference can fill a missing one, and makes the busy chat check
/// refuse rather than overlap (`expected_lane_idle`). Dispatch reads the
/// returned [`LaneSend`] for Stage 1's other effects: a granted chat's 409, no
/// goal binding, no evaluation and no worker-input routing.
pub(crate) fn check_sender(
    config: &AppConfig,
    context: &RequestContext,
    request: &mut DispatchPromptNormalized,
    taken: TakenClaims,
) -> Result<LaneSend, Refusal> {
    // G1.
    let Some(sender) = context
        .user_id
        .filter(|user_id| config.claude_code_lane.allow(*user_id))
    else {
        return Err(not_allowed("not_allowed"));
    };
    // G2. Only authenticated ingress sets a trigger, from the caller's own
    // credential; a job token's send names the job that delegated it.
    if context.is_service_role {
        return Err(not_person("service_role"));
    }
    let Some(trigger) = request.trigger.as_ref() else {
        return Err(not_person("not_own_session"));
    };
    if trigger.user_id != sender {
        return Err(not_person("not_own_session"));
    }
    if request.delegating_job_id.is_some() {
        return Err(not_person("delegated"));
    }
    // G3 before the rest of G2, which shares its code: a resend's or a goal
    // turn's trigger has no kind, and the refusal names the mark instead.
    let instafy_marks = [
        (request.dispatch_queue_entry_id.is_some(), "queued"),
        (request.goal_wakeup.is_some(), "goal_wakeup"),
        (request.goal_parent_job_id.is_some(), "goal_parent_job"),
        (request.allow_silent_automation_decline, "automation"),
        (request.allow_internal_review, "internal_review"),
        (taken.site_intent, "site_intent"),
        (taken.hand_back, "hand_back"),
        (taken.automatic_retry, "automatic_retry"),
        (request.thread_kind.is_some(), "thread_kind"),
    ];
    if let Some((_, reason)) = instafy_marks.iter().find(|(marked, _)| *marked) {
        return Err(not_person(reason));
    }
    if let Some((key, reason)) = instafy_mark_key(&request.metadata) {
        return Err(not_person_key(reason, key));
    }
    // The rest of G2: typed by the person, received now, in a conversation
    // that already existed. `ensure_conversation_record` may still insert one
    // a `POST /dispatch-prompt` names; Stage 2 checks again.
    if trigger.kind != Some(TriggerKind::Person) {
        return Err(not_person("not_typed"));
    }
    if trigger.received_at.is_some() {
        return Err(not_person("received_earlier"));
    }
    if request.conversation_is_new {
        return Err(not_person("new_conversation"));
    }
    // Stage 1's effect on the busy chat check: a lane send is refused when
    // this chat's @octo is busy, never queued behind it.
    request.expected_lane_idle = true;
    Ok(LaneSend {
        sender,
        runtime_id: request.runtime_id,
    })
}

/// The first G3 key `metadata` carries, with its refusal's reason.
fn instafy_mark_key(metadata: &JsonValue) -> Option<(&'static str, &'static str)> {
    let map = metadata.as_object()?;
    NOT_A_PERSON_KEYS
        .iter()
        .chain(MORE_NOT_A_PERSON_KEYS.iter())
        .find(|(key, _)| map.contains_key(*key))
        .copied()
}

/// G4 and G5 over what dispatch already holds: one plain turn to the
/// sender's own @octo, of a plain shape.
fn check_turn_shape(
    request: &DispatchPromptNormalized,
    conversation_thread_kind: Option<&str>,
    turn: &Turn<'_>,
) -> Result<(), Refusal> {
    // G4. Handles resolve only against the sender's own agents.
    if !turn.plain_turn || turn.skill_mode_ambient_evaluation {
        return Err(not_plain("not_plain_turn"));
    }
    let [target] = turn.targets else {
        return Err(not_plain("targets"));
    };
    if target.handle != "octo" || target.agent_id.is_none() {
        return Err(not_plain("not_octo"));
    }
    if turn.recorded_earlier {
        return Err(not_plain("recorded_earlier"));
    }
    // G5.
    if request.intent != crate::dispatch::DEFAULT_PROMPT_INTENT {
        return Err(not_plain("intent"));
    }
    if request.execution_mode != crate::dispatch::EXECUTION_MODE_APPLY {
        return Err(not_plain("execution_mode"));
    }
    let request_extras = [
        (request.plan_seed.is_some(), "plan_seed"),
        (request.tool_limits.is_some(), "tool_limits"),
        (request.repo.is_some(), "repo"),
        (request.requested_preview.is_some(), "requested_preview"),
        (
            request.thread_kind.is_some() || conversation_thread_kind.is_some(),
            "thread_kind",
        ),
        (
            crate::system_turns::carries_attachments(&request.metadata),
            "attachments",
        ),
    ];
    if let Some((_, reason)) = request_extras.iter().find(|(present, _)| *present) {
        return Err(not_plain(reason));
    }
    check_prompt_text(&request.prompt_text)?;
    if request.metadata.get("writeIntent") != Some(&JsonValue::Bool(true)) {
        return Err(not_plain("write_intent"));
    }
    if let Some(key) = write_scope_key(&request.metadata) {
        return Err(not_plain_key("write_scope", key));
    }
    Ok(())
}

/// G5's words: not empty, at most [`CLAUDE_CODE_LANE_MAX_PROMPT_CHARS`]
/// characters (Unicode scalar values), and not a `/` command once leading
/// whitespace is removed.
fn check_prompt_text(prompt_text: &str) -> Result<(), Refusal> {
    if prompt_text.trim().is_empty() {
        return Err(not_plain("empty"));
    }
    if prompt_text.chars().count() > CLAUDE_CODE_LANE_MAX_PROMPT_CHARS {
        return Err(not_plain("too_long"));
    }
    if prompt_text.trim_start().starts_with('/') {
        return Err(not_plain("command"));
    }
    Ok(())
}

/// The first key of the write-scope plan's that `metadata` carries.
fn write_scope_key(metadata: &JsonValue) -> Option<&'static str> {
    let map = metadata.as_object()?;
    if let Some(key) = WRITE_SCOPE_KEYS.iter().find(|key| map.contains_key(**key)) {
        return Some(key);
    }
    let selection = map.get("agentSelection").and_then(JsonValue::as_object)?;
    SELECTION_WRITE_SCOPE_KEYS
        .iter()
        .find(|key| selection.contains_key(**key))
        .copied()
}

/// Stage 2, for a send that passed [`check_sender`], right after dispatch
/// computed `plain_turn` and before device grants
/// (docs/Local-Engine-Turns.md 2.2), in the dispatch's own transaction:
/// - G2 again: the conversation was not inserted by this send, whose insert
///   the refusal rolls back;
/// - G4: one plain turn to the sender's own @octo, not recorded earlier;
/// - G5: of a plain shape;
/// - G6: on the runtime the send named, which is the sender's own private
///   self-hosted runtime in this project, dispatch-ready, without a Personal
///   Browser, and with the `claudeCode` capability the controller attested;
/// - G7: that runtime has no other job of this project queued or leased;
/// - G8: the sender has no other lane turn running or waiting to start.
///
/// The runtime row is loaded `for share`, and dispatch uses it as its strict
/// runtime record.
pub(crate) async fn admit(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    conversation: &ConversationRecord,
    request: &DispatchPromptNormalized,
    send: &LaneSend,
    turn: Turn<'_>,
) -> Result<(LaneAdmission, runtime::RuntimeRecord), Refusal> {
    if request.conversation_is_new {
        return Err(not_person("new_conversation"));
    }
    check_turn_shape(request, conversation.thread_kind.as_deref(), &turn)?;
    // G6. `ensure_conversation_record` may since have filled a missing
    // runtime from the chat's stored preference: only the one the request
    // named counts.
    let Some(runtime_id) = send.runtime_id else {
        return Err(runtime_not_ready("no_runtime"));
    };
    let record = load_own_ready_runtime(state, transaction, project_id, &runtime_id, send).await?;
    // G7.
    let busy = transaction
        .query_one(
            "select exists (
                 select 1 from agent_jobs
                  where project_id = $1
                    and status in ('queued', 'leased')
                    and (target_runtime_id = $2 or leased_by_runtime_id = $2)
             )",
            &[project_id, &runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to check the computer's other jobs: {error}"
            ))
        })?
        .get::<_, bool>(0);
    if busy {
        return Err(machine_busy());
    }
    // G8: the one-active-turn index's own predicate, so the two never
    // disagree. Two concurrent admissions both pass here; the index fails the
    // second insert, which `agent::enqueue_agent_job_record` answers the same.
    let active = transaction
        .query_opt(
            "select status = 'queued'
                    and trigger_received_at + $2::int * interval '1 second'
                        <= statement_timestamp() as start_window_passed
               from agent_jobs
              where engine = 'claude-code'
                and (payload ->> 'user_id') = $1
                and (status = 'leased' or (status = 'queued' and lease_attempts = 0))
              limit 1",
            &[
                &send.sender.to_string(),
                &crate::device_grants::GRANTED_TURN_START_WITHIN_SECONDS,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to check the person's other Claude Code turns: {error}"
            ))
        })?;
    if let Some(row) = active {
        let start_window_passed = row
            .get::<_, Option<bool>>("start_window_passed")
            .unwrap_or(false);
        return Err(turn_active(start_window_passed));
    }
    Ok((LaneAdmission { runtime_id }, record))
}

/// G6: `runtime_id`'s row in this project, loaded `for share`, when it is
/// the sender's own private self-hosted runtime, dispatch-ready, without a
/// Personal Browser, and with an attested, ready `claudeCode` capability.
async fn load_own_ready_runtime(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    send: &LaneSend,
) -> Result<runtime::RuntimeRecord, Refusal> {
    let row = transaction
        .query_opt(
            "select id, project_id, provider, status, idle_ttl_seconds, last_seen_at,
                    endpoint_url, capabilities, display_name, active_lease_id
               from runtimes
              where project_id = $1 and id = $2
              for share",
            &[project_id, runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load the computer for a Claude Code turn: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(runtime_not_ready("runtime_missing"));
    };
    let record = runtime::RuntimeRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider: row.get("provider"),
        status: row.get("status"),
        idle_ttl_seconds: row.get("idle_ttl_seconds"),
        capabilities: row.get("capabilities"),
        display_name: row.get("display_name"),
        active_lease_id: row.get("active_lease_id"),
    };
    let candidate = workspace::RuntimeCandidate {
        id: record.id,
        provider: record.provider.clone(),
        capabilities: record.capabilities.clone(),
        status: record.status.clone(),
        endpoint_url: row.get("endpoint_url"),
        last_seen_at: row.get("last_seen_at"),
        idle_ttl_seconds: record.idle_ttl_seconds,
        display_name: record.display_name.clone(),
    };
    check_own_ready_runtime(state, &record, &candidate, send.sender)?;
    Ok(record)
}

/// G6 over a runtime row: see [`load_own_ready_runtime`].
fn check_own_ready_runtime(
    state: &AppState,
    record: &runtime::RuntimeRecord,
    candidate: &workspace::RuntimeCandidate,
    sender: Uuid,
) -> Result<(), Refusal> {
    let capabilities = &record.capabilities;
    if !runtime::runtime_is_private_self_hosted(state, &record.provider, capabilities) {
        return Err(runtime_not_ready("not_private"));
    }
    // The owner the controller attested at registration, as the lease reads
    // it, and never the service runtime user.
    let sender_text = sender.to_string();
    let attested_owner = capabilities
        .get(SELF_HOSTED_ACCESS_KEY)
        .filter(|access| access.get("mode").and_then(JsonValue::as_str) == Some("private"))
        .and_then(|access| access.get("ownerUserId"))
        .and_then(JsonValue::as_str);
    if attested_owner != Some(sender_text.as_str())
        || runtime::self_hosted_owner_user_id(capabilities) != Some(sender)
        || state.config.service_runtime_user_id == Some(sender)
    {
        return Err(runtime_not_ready("not_owner"));
    }
    // A Personal Browser runtime leases only browser jobs.
    if capabilities.get("personalBrowser").is_some()
        || capabilities.get("personal_browser").is_some()
    {
        return Err(runtime_not_ready("personal_browser"));
    }
    if crate::dispatch::runtime_not_dispatch_ready_detail(record, Some(candidate), Utc::now())
        .is_some()
    {
        return Err(runtime_not_ready("not_dispatch_ready"));
    }
    // The capability registration attests for a lane-capable runtime, read
    // as the lease reads it: version 1 (as a number) and ready true.
    let capability = capabilities.get(CAPABILITY_KEY);
    if !capability
        .and_then(|capability| capability.get("version"))
        .and_then(JsonValue::as_f64)
        .is_some_and(|version| version == CAPABILITY_VERSION)
    {
        return Err(runtime_not_ready("capability_missing"));
    }
    if capability.and_then(|capability| capability.get("ready")) != Some(&JsonValue::Bool(true)) {
        return Err(runtime_not_ready("capability_not_ready"));
    }
    Ok(())
}

/// Stamps a lane turn's metadata as only the controller does:
/// `claudeCode: {"version": 1}`, `aiAccessMode: "claude-code"` and
/// `managedAiUsed: false`. Dispatch stamps the request at admission, so its
/// prompt, runs and the person's message carry it; the job payload
/// ([`payload_metadata`]) and the reply
/// (`agent::stamp_ai_access_mode_from_job_payload`) are stamped again by their
/// own builders.
pub(crate) fn stamp(map: &mut JsonMap<String, JsonValue>) {
    map.insert(STAMP_KEY.to_string(), json!({ "version": STAMP_VERSION }));
    map.insert(
        "aiAccessMode".to_string(),
        JsonValue::String(AI_ACCESS_MODE.to_string()),
    );
    map.insert("managedAiUsed".to_string(), JsonValue::Bool(false));
}

/// A lane job's payload metadata (docs/Local-Engine-Turns.md 2.5): only
/// [`PAYLOAD_METADATA_KEYS`] of dispatch's `metadata`, and the stamps.
pub(crate) fn payload_metadata(metadata: &JsonValue) -> JsonMap<String, JsonValue> {
    let mut map = JsonMap::new();
    for key in PAYLOAD_METADATA_KEYS {
        if let Some(value) = metadata.get(key) {
            map.insert(key.to_string(), value.clone());
        }
    }
    stamp(&mut map);
    map
}

/// Whether `error`, from inserting a job, is the one-active-turn index
/// refusing a person's second lane turn: 23505 on
/// [`ONE_ACTIVE_TURN_INDEX`].
pub(crate) fn is_second_active_turn(error: &tokio_postgres::Error) -> bool {
    error.code() == Some(&SqlState::UNIQUE_VIOLATION)
        && error
            .as_db_error()
            .and_then(|error| error.constraint())
            .is_some_and(|constraint| constraint == ONE_ACTIVE_TURN_INDEX)
}

/// The refusal of a steer into a running lane turn, for everyone, its author
/// included: nothing can deliver words into a running `claude -p`. Queueing a
/// message behind the turn still works.
pub(crate) fn takes_no_input() -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        TURN_TAKES_NO_INPUT,
        "This Claude Code turn can't take more words while it runs. Queue your message instead.",
        json!({ "reason": "steer" }),
    )
}

/// The refusal of a proxy-token renewal for a lane job: its traffic never
/// goes through the Instafy proxy, so it never had an envelope to renew.
pub(crate) fn has_no_proxy() -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_HAS_NO_PROXY,
        "A Claude Code turn has no Instafy proxy grant.",
        json!({ "reason": "local_engine" }),
    )
}

/// The refusal of `/agent/secrets` for a lane job: it gets no project
/// secrets, no Codex model settings and no research budget token.
pub(crate) fn takes_no_secrets() -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_TAKES_NO_SECRETS,
        "A Claude Code turn takes no project secrets.",
        json!({ "reason": "local_engine" }),
    )
}

/// The refusal of a job token whose job is a lane job. The lease never mints
/// one for it, so any such token is refused rather than acting for its job.
pub(crate) fn has_no_job_token() -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_HAS_NO_JOB_TOKEN,
        "A Claude Code turn has no job token.",
        json!({ "reason": "local_engine" }),
    )
}

/// The refusal of a team's plan whose parent is a lane job: a plan would
/// start turns whose words Instafy wrote.
pub(crate) fn plans_nothing() -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_STARTS_NO_TURNS,
        "A Claude Code turn cannot start a team's plan.",
        json!({ "reason": "plan" }),
    )
}

/// Message types a lane job may not post, with the refusal's reason: a
/// team's plan, and the card that asks a person something or opens a browser
/// turn that hands back.
const MESSAGE_TYPES_THAT_START_A_TURN: [(&str, &str); 4] = [
    ("multi_agent_plan", "plan"),
    ("action_request", "action_request"),
    ("user_input_request", "user_input_request"),
    ("request_browser", "hand_back"),
];
/// Metadata keys a lane job's message may not carry anywhere in it, with the
/// refusal's reason: a team's plan, a question that waits for an answer, and
/// a browser card or a hand-back (crate::browser_hand_back,
/// crate::system_turns).
const KEYS_THAT_START_A_TURN: [(&str, &str); 17] = [
    ("multiAgentPlan", "plan"),
    ("multi_agent_plan", "plan"),
    ("userInputRequestId", "user_input_request"),
    ("user_input_request_id", "user_input_request"),
    ("userInputRequest", "user_input_request"),
    ("user_input_request", "user_input_request"),
    ("browserRequest", "hand_back"),
    ("browser_request", "hand_back"),
    (
        crate::browser_hand_back::BUILD_REQUEST_NOTE_KEY,
        "hand_back",
    ),
    (crate::browser_hand_back::HAND_BACK_KEY, "hand_back"),
    ("browser_hand_back", "hand_back"),
    (crate::browser_hand_back::HAND_BACK_CLAIM_KEY, "hand_back"),
    ("continues_from_browser_job", "hand_back"),
    ("browserRequestOf", "hand_back"),
    ("browser_request_of", "hand_back"),
    (crate::system_turns::BROWSER_CARD_TURN_KEY, "hand_back"),
    ("browser_card_turn", "hand_back"),
];
/// How deep [`refuse_message_that_starts_a_turn`] looks: a message's own
/// metadata wraps the runtime's under `details`, which nests its step's
/// event (`details.event.item.items[]` is five levels down). Anything deeper
/// is refused, so the walk fails closed.
const MESSAGE_METADATA_MAX_DEPTH: usize = 12;

/// Refuses an agent message of a lane job whose metadata would start another
/// turn (docs/Local-Engine-Turns.md 2.6): a team's plan, a question that waits
/// for a person's answer, or a browser card or hand-back. `metadata` is the
/// message's metadata as the controller built it, the runtime's own under
/// `details`.
pub(crate) fn refuse_message_that_starts_a_turn(metadata: &JsonValue) -> Result<(), Refusal> {
    match turn_starting_mark(metadata, 0) {
        Some(reason) => Err(refusal(
            StatusCode::FORBIDDEN,
            TURN_STARTS_NO_TURNS,
            "A Claude Code turn cannot start a plan, ask a question or open a browser turn.",
            json!({ "reason": reason }),
        )),
        None => Ok(()),
    }
}

/// The reason of the first mark of a turn-starting message in `value`.
fn turn_starting_mark(value: &JsonValue, depth: usize) -> Option<&'static str> {
    match value {
        JsonValue::Object(map) => {
            if depth > MESSAGE_METADATA_MAX_DEPTH {
                return Some("too_deep");
            }
            for key in ["messageType", "message_type", "type"] {
                let kind = map
                    .get(key)
                    .and_then(JsonValue::as_str)
                    .map(|kind| kind.trim().to_ascii_lowercase().replace('-', "_"));
                if let Some((_, reason)) = kind.and_then(|kind| {
                    MESSAGE_TYPES_THAT_START_A_TURN
                        .iter()
                        .find(|(starting, _)| *starting == kind)
                }) {
                    return Some(reason);
                }
            }
            if let Some((_, reason)) = KEYS_THAT_START_A_TURN
                .iter()
                .find(|(key, _)| map.contains_key(*key))
            {
                return Some(reason);
            }
            map.values()
                .find_map(|nested| turn_starting_mark(nested, depth + 1))
        }
        JsonValue::Array(items) => {
            if depth > MESSAGE_METADATA_MAX_DEPTH {
                return Some("too_deep");
            }
            items
                .iter()
                .find_map(|item| turn_starting_mark(item, depth + 1))
        }
        _ => None,
    }
}

/// The provider id a completion stores (docs/Local-Engine-Turns.md 2.6):
/// [`PROVIDER`] for a lane job, whatever its runtime reports. Any other job
/// that reports [`PROVIDER`] stores none, so neither engine is ever taken for
/// the other.
pub(crate) fn completion_provider(
    job_id: &Uuid,
    lane: bool,
    reported: Option<String>,
) -> Option<String> {
    if lane {
        return Some(PROVIDER.to_string());
    }
    match reported {
        Some(provider) if names_lane_provider(&provider) => {
            tracing::warn!(
                %job_id,
                "a job that is not a Claude Code turn reported Claude Code as its provider; \
                 no provider id is stored"
            );
            None
        }
        other => other,
    }
}

fn names_lane_provider(provider: &str) -> bool {
    provider.trim().to_ascii_lowercase().replace('_', "-") == PROVIDER
}

/// A completion's `proxy_metadata` as a job that is not a lane job keeps it:
/// without a `provider` or a `conversation` state that names the lane's
/// provider ([`completion_provider`], [`completion_conversation_state`]).
///
/// It runs on every completion before the job's engine is read, so it logs
/// nothing: a lane job's own metadata names the lane by right.
pub(crate) fn without_lane_claims(proxy_metadata: &Option<JsonValue>) -> Option<JsonValue> {
    let mut metadata = proxy_metadata.clone()?;
    if let Some(map) = metadata.as_object_mut() {
        if map
            .get("provider")
            .and_then(JsonValue::as_str)
            .is_some_and(names_lane_provider)
        {
            map.remove("provider");
        }
        if map
            .get("conversation")
            .and_then(|state| state.get("provider"))
            .and_then(JsonValue::as_str)
            .is_some_and(names_lane_provider)
        {
            map.remove("conversation");
        }
    }
    Some(metadata)
}

/// The conversation state a completion keeps (docs/Local-Engine-Turns.md
/// 2.6). For a lane job, only the lane's two shapes, rebuilt from their known
/// fields: a session `{"provider": "claude-code", "version": 1, "sessionId":
/// <uuid>, "runtimeId": <uuid>}` on the runtime that ran it
/// (`leased_runtime`), or the reset `{"provider": "claude-code", "version": 1,
/// "reset": true}`. For any other job, everything but a state that names the
/// lane's provider: Codex writes a `provider` of its own and never checks it
/// on resume, so the controller is where the engines are kept apart.
pub(crate) fn completion_conversation_state(
    job_id: &Uuid,
    lane: bool,
    state: Option<JsonValue>,
    leased_runtime: Option<Uuid>,
) -> Option<JsonValue> {
    let state = state?;
    if lane {
        let kept = lane_state(&state).and_then(|state| match state {
            LaneState::Session {
                session_id,
                runtime_id,
            } if Some(runtime_id) == leased_runtime => Some(LaneState::Session {
                session_id,
                runtime_id,
            }),
            LaneState::Session { .. } => None,
            LaneState::Reset => Some(LaneState::Reset),
        });
        if kept.is_none() && !state.is_null() {
            tracing::warn!(%job_id, "dropped a Claude Code turn's malformed conversation state");
        }
        return kept.map(LaneState::to_json);
    }
    let names_lane = state
        .get("provider")
        .and_then(JsonValue::as_str)
        .is_some_and(names_lane_provider);
    if names_lane {
        tracing::warn!(
            %job_id,
            "dropped a conversation state naming Claude Code from a job that is not a Claude Code turn"
        );
        return None;
    }
    Some(state)
}

/// A lane conversation state, as [`completion_conversation_state`] keeps it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaneState {
    Session { session_id: Uuid, runtime_id: Uuid },
    Reset,
}

impl LaneState {
    fn to_json(self) -> JsonValue {
        match self {
            Self::Session {
                session_id,
                runtime_id,
            } => json!({
                "provider": PROVIDER,
                "version": CONVERSATION_STATE_VERSION,
                "sessionId": session_id.to_string(),
                "runtimeId": runtime_id.to_string(),
            }),
            Self::Reset => json!({
                "provider": PROVIDER,
                "version": CONVERSATION_STATE_VERSION,
                "reset": true,
            }),
        }
    }
}

/// `state` when it is exactly one of the lane's two shapes: no other key, the
/// lane's provider, version 1, and either two UUIDs or `reset: true`.
fn lane_state(state: &JsonValue) -> Option<LaneState> {
    let map = state.as_object()?;
    if map.get("provider").and_then(JsonValue::as_str) != Some(PROVIDER)
        || map.get("version").and_then(JsonValue::as_u64) != Some(CONVERSATION_STATE_VERSION)
    {
        return None;
    }
    let uuid = |key: &str| {
        map.get(key)
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
    };
    match map.len() {
        3 if map.get("reset") == Some(&JsonValue::Bool(true)) => Some(LaneState::Reset),
        4 => Some(LaneState::Session {
            session_id: uuid("sessionId")?,
            runtime_id: uuid("runtimeId")?,
        }),
        _ => None,
    }
}

/// Drops every Codex run log from a lane job's `artifacts`, the only artifact
/// billing reads: no lane turn writes one, so one there is forged. Returns
/// whether any was dropped. An `artifacts` that is not a list, such as the
/// marker of one too large to store, is left as it is.
pub(crate) fn drop_codex_run_logs(artifacts: &mut JsonValue) -> bool {
    let Some(list) = artifacts.as_array_mut() else {
        return false;
    };
    let before = list.len();
    list.retain(|artifact| artifact_kind(artifact) != Some(CODEX_RUN_LOG_KIND));
    list.len() != before
}

fn artifact_kind(artifact: &JsonValue) -> Option<&str> {
    artifact.get("kind").and_then(JsonValue::as_str)
}

/// The last artifact of `kind` in `artifacts`.
fn last_artifact<'a>(artifacts: &'a JsonValue, kind: &str) -> Option<&'a JsonValue> {
    artifacts
        .as_array()?
        .iter()
        .rev()
        .find(|artifact| artifact_kind(artifact) == Some(kind))
}

/// What Claude Code reported a lane turn used ([`USAGE_ARTIFACT_KIND`]):
/// shown in Details, never billed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReportedUsage {
    pub(crate) model: Option<String>,
    pub(crate) input_tokens: u64,
    pub(crate) cache_creation_input_tokens: u64,
    pub(crate) cache_read_input_tokens: u64,
    pub(crate) output_tokens: u64,
}

impl ReportedUsage {
    /// Every input token the model read, cached or not, as the Codex usage
    /// row counts its input.
    fn all_input_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.cache_creation_input_tokens)
            .saturating_add(self.cache_read_input_tokens)
    }

    /// The usage row's words: "Claude Code reported: input N, cached M,
    /// output K", where N counts every input token and M those read from the
    /// cache. There is no cost: Claude Code's estimate is an API price, not
    /// what a plan costs.
    pub(crate) fn content(&self) -> String {
        format!(
            "Claude Code reported: input {}, cached {}, output {}",
            self.all_input_tokens(),
            self.cache_read_input_tokens,
            self.output_tokens
        )
    }

    /// The usage row's `details`: Details-only, `billed: false`.
    pub(crate) fn details(&self) -> JsonValue {
        let mut details = json!({
            "kind": USAGE_DETAILS_KIND,
            "billed": false,
            "usage": {
                "input_tokens": self.input_tokens,
                "cache_creation_input_tokens": self.cache_creation_input_tokens,
                "cache_read_input_tokens": self.cache_read_input_tokens,
                "output_tokens": self.output_tokens,
            },
        });
        if let Some(model) = self.model.as_ref() {
            details["model"] = JsonValue::String(model.clone());
        }
        details
    }
}

/// The usage the last [`USAGE_ARTIFACT_KIND`] artifact reports: its counts
/// under `usage` (or, failing that, beside `kind`), and its model. None
/// without such an artifact.
pub(crate) fn reported_usage(artifacts: &JsonValue) -> Option<ReportedUsage> {
    let artifact = last_artifact(artifacts, USAGE_ARTIFACT_KIND)?;
    let counts = artifact
        .get("usage")
        .filter(|usage| usage.is_object())
        .unwrap_or(artifact);
    let count = |key: &str| counts.get(key).and_then(JsonValue::as_u64).unwrap_or(0);
    let model = artifact
        .get("model")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(|model| model.chars().take(USAGE_MODEL_MAX_CHARS).collect());
    Some(ReportedUsage {
        model,
        input_tokens: count("input_tokens"),
        cache_creation_input_tokens: count("cache_creation_input_tokens"),
        cache_read_input_tokens: count("cache_read_input_tokens"),
        output_tokens: count("output_tokens"),
    })
}

/// The failure code the last [`FAILURE_ARTIFACT_KIND`] artifact reports,
/// when it is one of [`RUNTIME_FAILURE_CODES`].
pub(crate) fn reported_failure_code(artifacts: &JsonValue) -> Option<&'static str> {
    let code = last_artifact(artifacts, FAILURE_ARTIFACT_KIND)?
        .get("code")
        .and_then(JsonValue::as_str)?;
    RUNTIME_FAILURE_CODES
        .iter()
        .find(|known| **known == code)
        .copied()
}

/// Stamps the failure message of a lane turn with what its author's Studio
/// words it by (docs/Local-Engine-Turns.md 5.5): `aiAccessMode:
/// "claude-code"` and the failure code as [`FAILURE_KEY`].
pub(crate) fn stamp_failure(map: &mut JsonMap<String, JsonValue>, code: &str) {
    map.insert(
        "aiAccessMode".to_string(),
        JsonValue::String(AI_ACCESS_MODE.to_string()),
    );
    map.insert(FAILURE_KEY.to_string(), JsonValue::String(code.to_string()));
}

/// The conversation state the next lane turn resumes
/// (docs/Local-Engine-Turns.md 2.7): that of the latest lane job, of those
/// that saved a lane-shaped one, in `conversation_id` of `project_id`, for
/// `agent_id`, of `sender` (`payload.user_id`) and targeted at `runtime_id`.
/// A job that saved none, such as a stopped turn or one a sweep or runtime
/// stop failed, is passed over. None when there is no such job, or when its
/// state is the reset: the next turn then starts a new session.
pub(crate) async fn load_session(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    sender: &Uuid,
    agent_id: Option<&Uuid>,
    runtime_id: &Uuid,
) -> Result<Option<JsonValue>, Refusal> {
    let Some(agent_id) = agent_id else {
        return Ok(None);
    };
    let row = transaction
        .query_opt(
            "select j.proxy_metadata -> 'conversation' as conversation_state
               from agent_jobs j
              where j.project_id = $1
                and j.conversation_id = $2
                and j.engine = 'claude-code'
                and (j.payload ->> 'user_id') = $3
                and (j.payload #>> '{metadata,agent,id}') = $4
                and j.target_runtime_id = $5
                and j.proxy_metadata -> 'conversation' is not null
                and j.proxy_metadata -> 'conversation' <> 'null'::jsonb
                and (j.proxy_metadata #>> '{conversation,provider}') = $6
              order by j.created_at desc, j.id desc
              limit 1",
            &[
                project_id,
                conversation_id,
                &sender.to_string(),
                &agent_id.to_string(),
                runtime_id,
                &PROVIDER,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load the Claude Code session to resume: {error}"
            ))
        })?;
    let Some(state) = row.and_then(|row| row.get::<_, Option<JsonValue>>("conversation_state"))
    else {
        return Ok(None);
    };
    Ok(match lane_state(&state) {
        Some(LaneState::Session {
            session_id,
            runtime_id: state_runtime,
        }) if state_runtime == *runtime_id => Some(
            LaneState::Session {
                session_id,
                runtime_id: state_runtime,
            }
            .to_json(),
        ),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_and_reason(refusal: &Refusal) -> (StatusCode, String, String) {
        let error = &refusal.1 .0;
        (
            refusal.0,
            error.code.clone().unwrap_or_default(),
            error
                .details
                .as_ref()
                .and_then(|details| details.get("reason"))
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string(),
        )
    }

    /// The claim is taken from every send, its value decides, and a client's
    /// copies of the controller's own marks never survive, nested ones
    /// included.
    #[test]
    fn the_claim_is_taken_and_only_claude_code_claims_the_lane() {
        let mut metadata = json!({
            "turnEngine": "claude-code",
            "claudeCode": { "version": 1 },
            "claudeCodeFailure": "plan_limit",
            "prompt_metadata": { "turnEngine": "claude-code", "claudeCode": { "version": 1 } },
            "details": { "claudeCodeFailure": "not_signed_in" },
            "keep": true,
        });
        assert_eq!(take_claim(&mut metadata).expect("claim"), true);
        assert_eq!(
            metadata,
            json!({ "prompt_metadata": {}, "details": {}, "keep": true })
        );

        let mut snake = json!({ "turn_engine": "claude-code" });
        assert_eq!(take_claim(&mut snake).expect("claim"), true);
        assert_eq!(snake, json!({}));

        let mut unclaimed = json!({ "claude_code": {}, "claude_code_failure": "x" });
        assert_eq!(take_claim(&mut unclaimed).expect("no claim"), false);
        assert_eq!(unclaimed, json!({}));
        assert_eq!(take_claim(&mut JsonValue::Null).expect("no claim"), false);

        for value in [
            json!("codex"),
            json!("Claude-Code"),
            json!(" claude-code"),
            json!(null),
            json!(true),
            json!({ "engine": "claude-code" }),
        ] {
            let mut metadata = json!({ "turnEngine": value.clone() });
            let refusal = take_claim(&mut metadata).expect_err("unknown engine");
            assert_eq!(
                code_and_reason(&refusal),
                (
                    StatusCode::BAD_REQUEST,
                    TURN_ENGINE_UNKNOWN.to_string(),
                    "unknown_engine".to_string()
                ),
                "{value}"
            );
            assert_eq!(metadata, json!({}), "{value}");
        }
        // Two spellings that disagree are refused too.
        let mut both = json!({ "turnEngine": "claude-code", "turn_engine": "codex" });
        assert!(take_claim(&mut both).is_err());
    }

    #[test]
    fn a_claim_anywhere_outside_a_send_is_refused() {
        assert!(!carries_claim(None));
        assert!(!carries_claim(Some(&json!({ "claudeCode": {} }))));
        for metadata in [
            json!({ "turnEngine": "claude-code" }),
            json!({ "turnEngine": null }),
            json!({ "turn_engine": "codex" }),
        ] {
            assert!(carries_claim(Some(&metadata)), "{metadata}");
            let refusal =
                refuse_claim_outside_a_send(Some(&metadata), "queued").expect_err("refused");
            assert_eq!(
                code_and_reason(&refusal),
                (
                    StatusCode::FORBIDDEN,
                    TURN_NOT_PERSON.to_string(),
                    "queued".to_string()
                )
            );
        }
        assert!(refuse_claim_outside_a_send(Some(&json!({})), "queued").is_ok());
    }

    #[test]
    fn every_mark_of_instafy_names_its_key() {
        assert_eq!(
            instafy_mark_key(&json!({ "input": { "kind": "person" } })),
            None
        );
        for (key, reason) in NOT_A_PERSON_KEYS
            .iter()
            .chain(MORE_NOT_A_PERSON_KEYS.iter())
        {
            for value in [json!(null), json!(false), json!("x"), json!({})] {
                let mut metadata = json!({ "input": { "kind": "person" } });
                metadata[*key] = value.clone();
                assert_eq!(
                    instafy_mark_key(&metadata),
                    Some((*key, *reason)),
                    "{key}: {value}"
                );
            }
        }
    }

    #[test]
    fn the_prompt_is_a_bounded_message_and_not_a_command() {
        assert!(check_prompt_text("fix the build").is_ok());
        assert!(check_prompt_text(&"é".repeat(CLAUDE_CODE_LANE_MAX_PROMPT_CHARS)).is_ok());
        for (text, reason) in [
            ("   ".to_string(), "empty"),
            ("/review".to_string(), "command"),
            ("  \n /compact now".to_string(), "command"),
            (
                "a".repeat(CLAUDE_CODE_LANE_MAX_PROMPT_CHARS + 1),
                "too_long",
            ),
            (
                "é".repeat(CLAUDE_CODE_LANE_MAX_PROMPT_CHARS + 1),
                "too_long",
            ),
        ] {
            let refusal = check_prompt_text(&text).expect_err("refused");
            assert_eq!(
                code_and_reason(&refusal),
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    TURN_NOT_PLAIN.to_string(),
                    reason.to_string()
                )
            );
        }
    }

    #[test]
    fn any_write_scope_key_is_found_with_any_value() {
        assert_eq!(write_scope_key(&json!({ "writeIntent": true })), None);
        assert_eq!(
            write_scope_key(&json!({ "agentSelection": { "active": ["octo"] } })),
            None
        );
        for key in WRITE_SCOPE_KEYS {
            assert_eq!(write_scope_key(&json!({ key: null })), Some(key), "{key}");
        }
        for key in SELECTION_WRITE_SCOPE_KEYS {
            assert_eq!(
                write_scope_key(&json!({ "agentSelection": { key: {} } })),
                Some(key),
                "{key}"
            );
        }
    }

    /// Each refusal of the rest of a lane job's life has its status and code.
    #[test]
    fn a_lane_jobs_refusals_carry_their_codes() {
        for (refusal, status, code) in [
            (takes_no_input(), StatusCode::CONFLICT, TURN_TAKES_NO_INPUT),
            (has_no_proxy(), StatusCode::FORBIDDEN, TURN_HAS_NO_PROXY),
            (
                takes_no_secrets(),
                StatusCode::FORBIDDEN,
                TURN_TAKES_NO_SECRETS,
            ),
            (
                has_no_job_token(),
                StatusCode::FORBIDDEN,
                TURN_HAS_NO_JOB_TOKEN,
            ),
            (plans_nothing(), StatusCode::FORBIDDEN, TURN_STARTS_NO_TURNS),
        ] {
            let (actual_status, actual_code, reason) = code_and_reason(&refusal);
            assert_eq!((actual_status, actual_code.as_str()), (status, code));
            assert!(!reason.is_empty(), "{code}");
        }
    }

    /// A lane job's message that would start another turn is refused, by its
    /// type or by any of its keys, at any depth the runtime's metadata nests;
    /// the steps the lane posts are not.
    #[test]
    fn a_lane_message_that_would_start_a_turn_is_refused() {
        let reason = |metadata: JsonValue| {
            refuse_message_that_starts_a_turn(&metadata)
                .err()
                .map(|refusal| code_and_reason(&refusal))
        };
        for (metadata, expected) in [
            (json!({ "messageType": "multi_agent_plan" }), "plan"),
            (json!({ "message_type": "Multi-Agent-Plan" }), "plan"),
            (
                json!({ "details": { "multiAgentPlan": { "agents": [] } } }),
                "plan",
            ),
            (
                json!({ "details": { "details": { "multi_agent_plan": {} } } }),
                "plan",
            ),
            (json!({ "messageType": "action_request" }), "action_request"),
            (
                json!({ "details": { "userInputRequestId": Uuid::new_v4().to_string() } }),
                "user_input_request",
            ),
            (
                json!({ "details": { "browserRequest": { "task": "Open a page" } } }),
                "hand_back",
            ),
            (
                json!({ "details": { "details": { "browserBuildRequest": true } } }),
                "hand_back",
            ),
            (json!({ "browserHandBack": {} }), "hand_back"),
            (
                json!({ "details": { "continuesFromBrowserJob": "x" } }),
                "hand_back",
            ),
            (
                json!({ "details": { "actions": [{ "type": "request_browser" }] } }),
                "hand_back",
            ),
        ] {
            assert_eq!(
                reason(metadata.clone()),
                Some((
                    StatusCode::FORBIDDEN,
                    TURN_STARTS_NO_TURNS.to_string(),
                    expected.to_string()
                )),
                "{metadata}"
            );
        }
        let mut deep = json!({ "x": 1 });
        for _ in 0..=MESSAGE_METADATA_MAX_DEPTH {
            deep = json!({ "details": deep });
        }
        assert_eq!(
            reason(deep).map(|(_, _, reason)| reason),
            Some("too_deep".to_string())
        );
        // The lane's own steps: a command, a file change, a plan step, a
        // status step and its reply draft's commentary.
        for metadata in [
            json!({
                "source": "agent",
                "kind": "update",
                "messageType": "command_execution",
                "details": { "event": { "type": "item.completed", "item": {
                    "type": "command_execution", "command": "npm test",
                    "aggregated_output": "ok", "exit_code": null, "status": "completed",
                } } },
            }),
            json!({ "messageType": "file_change", "details": { "event": { "item": {
                "type": "file_change", "paths": ["src/app.ts"], "status": "completed",
            } } } }),
            json!({ "messageType": "todo_list", "details": { "event": { "item": {
                "type": "todo_list", "items": [{ "text": "Run the tests", "completed": false }],
            } } } }),
            json!({ "messageType": "status", "details": { "text": "Starting" } }),
        ] {
            assert_eq!(reason(metadata.clone()), None, "{metadata}");
        }
    }

    /// The completion keeps `claude-code` as a lane job's provider whatever
    /// its runtime reports, and stores none for another job that reports it.
    #[test]
    fn only_a_lane_job_stores_the_lanes_provider() {
        let job = Uuid::new_v4();
        assert_eq!(
            completion_provider(&job, true, Some("codex".to_string())),
            Some(PROVIDER.to_string())
        );
        assert_eq!(
            completion_provider(&job, true, None),
            Some(PROVIDER.to_string())
        );
        for reported in ["claude-code", " Claude_Code ", "CLAUDE-CODE"] {
            assert_eq!(
                completion_provider(&job, false, Some(reported.to_string())),
                None,
                "{reported}"
            );
        }
        assert_eq!(
            completion_provider(&job, false, Some("codex-embedded".to_string())),
            Some("codex-embedded".to_string())
        );
        assert_eq!(completion_provider(&job, false, None), None);
    }

    /// A lane job keeps only a well-formed session on the runtime that ran
    /// it, or the reset, rebuilt from its known fields; any other job keeps
    /// its state unless it names the lane's provider.
    #[test]
    fn only_well_formed_lane_states_are_kept() {
        let (job, runtime, session) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let lane_session = json!({
            "provider": "claude-code",
            "version": 1,
            "sessionId": session.to_string(),
            "runtimeId": runtime.to_string(),
        });
        let reset = json!({ "provider": "claude-code", "version": 1, "reset": true });
        let keep = |lane: bool, state: JsonValue| {
            completion_conversation_state(&job, lane, Some(state), Some(runtime))
        };
        assert_eq!(keep(true, lane_session.clone()), Some(lane_session.clone()));
        assert_eq!(keep(true, reset.clone()), Some(reset.clone()));
        for malformed in [
            with_key(&lane_session, "extra", json!(true)),
            with_key(&lane_session, "sessionId", json!("not-a-uuid")),
            with_key(
                &lane_session,
                "runtimeId",
                json!(Uuid::new_v4().to_string()),
            ),
            with_key(&lane_session, "version", json!(2)),
            with_key(&lane_session, "provider", json!("codex")),
            with_key(&reset, "reset", json!(false)),
            with_key(&reset, "sessionId", json!(session.to_string())),
            json!({ "provider": "codex", "threadId": "t" }),
            json!("claude-code"),
            JsonValue::Null,
        ] {
            assert_eq!(keep(true, malformed.clone()), None, "{malformed}");
        }
        assert_eq!(
            completion_conversation_state(&job, true, Some(lane_session.clone()), None),
            None,
            "a session on no runtime"
        );
        assert_eq!(
            completion_conversation_state(&job, true, None, Some(runtime)),
            None
        );

        let codex = json!({ "provider": "codex", "threadId": "thread-1" });
        assert_eq!(keep(false, codex.clone()), Some(codex));
        assert_eq!(keep(false, JsonValue::Null), Some(JsonValue::Null));
        assert_eq!(keep(false, lane_session.clone()), None);
        assert_eq!(keep(false, reset), None);
        assert_eq!(
            keep(false, json!({ "provider": "Claude_Code", "threadId": "t" })),
            None
        );

        let proxy_metadata = Some(json!({
            "provider": "claude-code",
            "conversation": lane_session,
            "creditSnapshot": { "balance": 1 },
        }));
        assert_eq!(
            without_lane_claims(&proxy_metadata),
            Some(json!({ "creditSnapshot": { "balance": 1 } }))
        );
        let codex_metadata = Some(json!({
            "provider": "codex",
            "conversation": { "provider": "codex", "threadId": "t" },
        }));
        assert_eq!(without_lane_claims(&codex_metadata), codex_metadata);
        assert_eq!(without_lane_claims(&None), None);
    }

    fn with_key(value: &JsonValue, key: &str, item: JsonValue) -> JsonValue {
        let mut value = value.clone();
        value[key] = item;
        value
    }

    /// A forged Codex run log is dropped from a lane job's artifacts, and the
    /// usage Claude Code reported reads as a Details row with no cost.
    #[test]
    fn a_lane_turns_usage_is_reported_and_never_billed() {
        let mut artifacts = json!([
            { "kind": "apply/files", "files": [] },
            { "kind": "codex/run-log", "events": [{ "type": "turn.completed", "usage": {
                "input_tokens": 9_000_000, "output_tokens": 9_000_000 } }] },
            { "kind": "claude-code/usage", "model": "claude-test-model", "usage": {
                "input_tokens": 120,
                "cache_creation_input_tokens": 30,
                "cache_read_input_tokens": 850,
                "output_tokens": 40,
                "total_cost_usd": 12.5,
            } },
        ]);
        assert!(drop_codex_run_logs(&mut artifacts));
        assert!(!drop_codex_run_logs(&mut artifacts));
        assert_eq!(
            artifacts
                .as_array()
                .expect("artifacts")
                .iter()
                .filter_map(artifact_kind)
                .collect::<Vec<_>>(),
            ["apply/files", "claude-code/usage"]
        );
        let mut capped = json!({ "truncated": true });
        assert!(!drop_codex_run_logs(&mut capped));

        let usage = reported_usage(&artifacts).expect("usage");
        assert_eq!(
            usage.content(),
            "Claude Code reported: input 1000, cached 850, output 40"
        );
        let details = usage.details();
        assert_eq!(details["kind"], json!(USAGE_DETAILS_KIND));
        assert_eq!(details["billed"], json!(false));
        assert_eq!(details["model"], json!("claude-test-model"));
        assert_eq!(
            details["usage"],
            json!({
                "input_tokens": 120,
                "cache_creation_input_tokens": 30,
                "cache_read_input_tokens": 850,
                "output_tokens": 40,
            })
        );
        assert!(!details.to_string().contains("cost"), "{details}");

        // Counts beside the kind are read too; a missing count is zero.
        let flat = reported_usage(&json!([
            { "kind": "claude-code/usage", "input_tokens": 5, "output_tokens": 2 },
        ]))
        .expect("usage");
        assert_eq!(
            flat.content(),
            "Claude Code reported: input 5, cached 0, output 2"
        );
        assert_eq!(flat.details().get("model"), None);
        assert_eq!(reported_usage(&json!([{ "kind": "codex/run-log" }])), None);
        assert_eq!(
            reported_usage(&json!({ "kind": "claude-code/usage" })),
            None
        );
    }

    /// Only a failure code Studio words is copied from the runtime's failure
    /// artifact, the last one when there are several.
    #[test]
    fn only_known_failure_codes_are_copied() {
        for code in RUNTIME_FAILURE_CODES {
            assert_eq!(
                reported_failure_code(&json!([{ "kind": FAILURE_ARTIFACT_KIND, "code": code }])),
                Some(code)
            );
        }
        for artifacts in [
            json!([{ "kind": FAILURE_ARTIFACT_KIND, "code": "rm -rf" }]),
            json!([{ "kind": FAILURE_ARTIFACT_KIND, "code": "Plan_Limit" }]),
            json!([{ "kind": FAILURE_ARTIFACT_KIND, "code": MACHINE_STOPPED }]),
            json!([{ "kind": FAILURE_ARTIFACT_KIND }]),
            json!([{ "kind": "codex/failure", "code": "plan_limit" }]),
            json!({ "kind": FAILURE_ARTIFACT_KIND, "code": "plan_limit" }),
        ] {
            assert_eq!(reported_failure_code(&artifacts), None, "{artifacts}");
        }
        assert_eq!(
            reported_failure_code(&json!([
                { "kind": FAILURE_ARTIFACT_KIND, "code": "stalled" },
                { "kind": FAILURE_ARTIFACT_KIND, "code": "plan_limit" },
            ])),
            Some("plan_limit")
        );

        let mut map = JsonMap::new();
        stamp_failure(&mut map, MACHINE_STOPPED);
        assert_eq!(
            JsonValue::Object(map),
            json!({ "aiAccessMode": "claude-code", "claudeCodeFailure": MACHINE_STOPPED })
        );
    }

    /// A lane job's metadata keeps only the controller's keys and the
    /// client's `input` and `writeIntent`, stamped, whatever else the
    /// client's metadata held.
    #[test]
    fn a_lane_payload_keeps_only_the_allowed_keys() {
        let metadata = json!({
            "agent": { "handle": "octo" },
            "writeScope": { "mode": "unscoped" },
            "conversationVisibility": "public",
            "runtimePreference": { "runtimeId": "r" },
            "input": { "kind": "person" },
            "writeIntent": true,
            "userId": "someone-else",
            "bootstrap": { "repo": "x" },
            "aiAccessMode": "managed",
            "managedAiUsed": true,
            "claudeCode": { "version": 2 },
            "goal": { "text": "x" },
        });
        assert_eq!(
            JsonValue::Object(payload_metadata(&metadata)),
            json!({
                "agent": { "handle": "octo" },
                "writeScope": { "mode": "unscoped" },
                "conversationVisibility": "public",
                "runtimePreference": { "runtimeId": "r" },
                "input": { "kind": "person" },
                "writeIntent": true,
                "claudeCode": { "version": 1 },
                "aiAccessMode": "claude-code",
                "managedAiUsed": false,
            })
        );
    }
}
