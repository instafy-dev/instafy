//! Local-engine turns: the turns of an agent whose owner chose Claude Code as
//! its AI, which the owner's own Claude Code, signed in on their own computer,
//! carries out. docs/Local-Engine-Turns.md calls the mechanism "the lane";
//! section 11 is version 2, which this module builds.
//!
//! An agent is a Claude Code agent when its provider is [`PROVIDER`] and it has
//! no credential (`ai_agents`). Dispatch resolves every handle against the
//! agents of its own person, so a lane turn is always its person's own: a
//! teammate's message never reaches another person's agent (11.5). For each
//! target that is a Claude Code agent, [`check_target`] runs before dispatch
//! writes anything:
//! - L1: the rollout switch covers the agent's owner;
//! - L2: the owner rule: the agent is the dispatch's own person's;
//! - L3: the turn is one Claude Code can take (11.4).
//!
//! A refusal writes nothing and burns no credit. Nothing here falls back to
//! another engine. An admitted target's job is stamped `agent_jobs.engine =
//! 'claude-code'` ([`ENGINE`]), whose CHECK forbids a credential, grants and a
//! plan role. It has no runtime pin: it waits, queued, until one of its
//! person's own runtimes in its space with Claude Code ready leases it, and one
//! runs at a time for each person ([`ONE_RUNNING_TURN_INDEX`]).
//!
//! The rest of an admitted job's life reads that column, never payload
//! metadata (docs/Local-Engine-Turns.md 2.4-2.9, 11.7):
//! - it is leased once, only by such a runtime, with no proxy envelope,
//!   model-facing token, history or extras (`agent::lease_next_agent_job`);
//! - it gets no secrets, proxy renewal, job token, steer, plan, question or
//!   hand-back ([`takes_no_secrets`], [`has_no_proxy`], [`has_no_job_token`],
//!   [`takes_no_input`], [`refuse_message_that_starts_a_turn`],
//!   [`plans_nothing`]);
//! - its completion keeps only what the lane writes ([`completion_provider`],
//!   [`completion_conversation_state`], [`drop_codex_run_logs`],
//!   [`reported_usage`], [`reported_failure_code`]) and bills nothing;
//! - once it started, nothing runs it again: a runtime stop and an expired
//!   lease fail it with a message its person's Studio words
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
use crate::dispatch::DispatchPromptNormalized;
use crate::{internal_error, runtime, workspace, ApiError, AppState};

type Refusal = (StatusCode, Json<ApiError>);

/// `agent_jobs.engine` of a lane job. Only dispatch writes it, for a Claude
/// Code agent's target, through `agent::enqueue_agent_job_record`.
pub(crate) const ENGINE: &str = "claude-code";
/// The `aiAccessMode` of a lane turn's run, messages and job.
pub(crate) const AI_ACCESS_MODE: &str = "claude-code";
/// The workspace mode a lane job's payload names as its top-level
/// `executionMode`, whatever a client's metadata asked for: a lane turn works
/// in its space's own folder, and the runtime reads the key as written
/// (docs/Local-Engine-Turns.md 2.5). A read-only turn's is
/// [`READ_ONLY_WORKSPACE_MODE`].
pub(crate) const WORKSPACE_MODE: &str = crate::dispatch::WORKSPACE_MODE_SHARED_WRITE;
/// The workspace mode of a lane job in the `plan_only` execution mode (11.12).
pub(crate) const READ_ONLY_WORKSPACE_MODE: &str = crate::dispatch::WORKSPACE_MODE_SHARED_READ;
/// The execution modes a lane turn takes (11.4): `apply`, and an
/// automation's read-only `plan_only`.
const EXECUTION_MODE_PLAN_ONLY: &str = "plan_only";
/// The controller's stamp on a lane turn's run, messages, job and reply:
/// `{"version": 1}`. A client's copy never survives intake.
pub(crate) const STAMP_KEY: &str = "claudeCode";
const STAMP_VERSION: u64 = 1;
/// The failure code the controller copies onto a lane turn's failure message.
/// Only the controller writes it.
pub(crate) const FAILURE_KEY: &str = "claudeCodeFailure";
/// The lane keys of a send's or a recorded message's metadata that only the
/// controller writes, in both spellings: a client's copy is never kept.
const CONTROLLER_KEYS: [&str; 6] = [
    STAMP_KEY,
    "claude_code",
    FAILURE_KEY,
    "claude_code_failure",
    SKIPPED_KEY,
    "claude_code_skipped",
];
/// Nested copies of a message's metadata a client could also fill in.
const NESTED_METADATA_KEYS: [&str; 3] = ["prompt_metadata", "promptMetadata", "details"];
/// The partial unique index that lets one lane turn run at a time for each
/// person (11.7): any number may wait.
pub(crate) const ONE_RUNNING_TURN_INDEX: &str = "agent_jobs_one_running_claude_code_turn_idx";
/// The runtime capability that registration attests for a lane-capable
/// runtime, and its one version.
const CAPABILITY_KEY: &str = "claudeCode";
const CAPABILITY_VERSION: f64 = 1.0;
/// The controller's attestation of a private self-hosted runtime's owner, as
/// registration writes it (`runtime::set_self_hosted_access_attestation`) and
/// the lease reads it.
const SELF_HOSTED_ACCESS_KEY: &str = "_instafySelfHostedAccess";

/// L1: the lane is not on for the agent's owner.
pub(crate) const TURN_NOT_ALLOWED: &str = "claude_code_turn_not_allowed";
/// L2, L3: a turn a Claude Code agent cannot take (11.4, 11.6).
pub(crate) const TURN_UNSUPPORTED: &str = "claude_code_turn_unsupported";
/// The run metadata key of an ambient evaluation that no computer of its
/// person's could take when it was sent (11.7): `{"reason": "computer_away"}`.
pub(crate) const SKIPPED_KEY: &str = "claudeCodeSkipped";
/// [`SKIPPED_KEY`]'s one reason.
pub(crate) const COMPUTER_AWAY: &str = "computer_away";

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

/// The provider id of a Claude Code agent (`user_agents.provider`), the one a
/// lane job's completion stores, and the `provider` of its conversation state.
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
/// no code. It is runtime-contracts' list, which the runtime and Studio are
/// tested against too.
pub(crate) const RUNTIME_FAILURE_CODES: [&str;
    runtime_contracts::claude_code_lane::RUNTIME_FAILURE_CODES.len()] =
    runtime_contracts::claude_code_lane::RUNTIME_FAILURE_CODES;
/// The failure code of a lane job a runtime stop failed: the computer's
/// Instafy stopped while the turn ran.
pub(crate) const MACHINE_STOPPED: &str = runtime_contracts::claude_code_lane::MACHINE_STOPPED;
/// What the failure message of a lane job a runtime stop failed says, before
/// Studio words it from [`FAILURE_KEY`].
pub(crate) const MACHINE_STOPPED_MESSAGE: &str = "Instafy Desktop stopped on this turn's \
     computer, so the turn ended and won't run again. Send it again to run it.";

/// The keys a lane job's payload metadata keeps from dispatch's own
/// (docs/Local-Engine-Turns.md 2.5, 11.12), beside the stamps and the turn's
/// execution mode: the controller's `agent`, `writeScope`,
/// `conversationVisibility`, `runtimePreference` and `groupParticipation` (an
/// evaluation's marker, which completion reads to take a decline), and the
/// client's `input` and `writeIntent`. Nothing else a client sent, such as a
/// `userId` of its choosing, reaches the runtime.
const PAYLOAD_METADATA_KEYS: [&str; 7] = [
    "agent",
    "writeScope",
    crate::dispatch::CONVERSATION_VISIBILITY_KEY,
    "runtimePreference",
    "groupParticipation",
    "input",
    "writeIntent",
];

/// Marks a dispatch request, or one target's copy of it, whose job runs on
/// its person's own Claude Code (`agent_jobs.engine`, 11.6). Only dispatch
/// sets it: on a target's copy when that target is a Claude Code agent, and
/// on the dispatch's own request when every target is one. Never from a
/// request body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LaneAdmission;

/// What dispatch knows of a target that is a Claude Code agent when
/// [`check_target`] runs.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Target<'a> {
    /// The agent's saved id; a target with none is never a Claude Code agent.
    pub(crate) agent_id: Option<Uuid>,
    /// The turn needs Instafy's browser: a strict browser target, or a
    /// Personal or Shared Browser request.
    pub(crate) uses_browser: bool,
    /// The words this target's job gets: its own part of a message to several
    /// agents (`dispatch::apply_agent_prompt_segment`), or the whole text.
    pub(crate) prompt_text: &'a str,
}

fn refusal(status: StatusCode, code: &str, message: &str, details: JsonValue) -> Refusal {
    (status, Json(ApiError::with_details(message, code, details)))
}

/// L1's refusal, and an agent update's that chooses Claude Code for an owner
/// the switch does not cover (`ai_agents`).
pub(crate) fn not_allowed() -> Refusal {
    refusal(
        StatusCode::FORBIDDEN,
        TURN_NOT_ALLOWED,
        "Claude Code turns aren't on for your account. Choose another AI for this agent in \
         Your AI.",
        json!({ "reason": "not_allowed" }),
    )
}

fn unsupported(reason: &str, message: &str) -> Refusal {
    refusal(
        StatusCode::UNPROCESSABLE_ENTITY,
        TURN_UNSUPPORTED,
        message,
        json!({ "reason": reason }),
    )
}

/// Removes every key only the controller may write from a client's
/// `metadata`: the `claudeCode` stamp, the failure code and the skip marker,
/// at the top level and in its nested copies. Sends and recorded messages go
/// through this for every caller, the service role included
/// (`conversations::sanitize_client_recorded_message_metadata`).
pub(crate) fn strip_client_marks(metadata: &mut JsonValue) {
    let Some(map) = metadata.as_object_mut() else {
        return;
    };
    for key in CONTROLLER_KEYS {
        map.remove(key);
    }
    for nested_key in NESTED_METADATA_KEYS {
        if let Some(nested) = map.get_mut(nested_key).and_then(JsonValue::as_object_mut) {
            for key in CONTROLLER_KEYS {
                nested.remove(key);
            }
        }
    }
}

/// L1-L3 for one target of `request` that is a Claude Code agent, before
/// dispatch writes anything (docs/Local-Engine-Turns.md 11.6):
/// - L1: the rollout switch covers the agent's owner, the dispatch's person;
/// - L2: the agent is that person's own, as `dispatch::resolve_agent_targets`
///   resolves it, and has a saved id;
/// - L3: the turn is one Claude Code can take (11.4).
pub(crate) fn check_target(
    config: &AppConfig,
    context: &RequestContext,
    request: &DispatchPromptNormalized,
    target: Target<'_>,
) -> Result<(), Refusal> {
    // L2 first: without a person there is no owner for L1 to look up.
    let Some(owner) = context.user_id else {
        return Err(unsupported(
            "no_owner",
            "Claude Code takes only its own person's turns.",
        ));
    };
    if target.agent_id.is_none() {
        return Err(unsupported(
            "no_owner",
            "Claude Code takes only its own person's turns.",
        ));
    }
    // L1.
    if !config.claude_code_lane.allow(owner) {
        return Err(not_allowed());
    }
    // L3.
    check_turn_shape(request, target.uses_browser)?;
    check_prompt_text(target.prompt_text)
}

/// L3 (11.4): what a Claude Code agent's turn cannot ask for. Each refusal
/// names its reason; Studio words it by that reason.
fn check_turn_shape(request: &DispatchPromptNormalized, uses_browser: bool) -> Result<(), Refusal> {
    let metadata = &request.metadata;
    let has_key = |keys: &[&str]| {
        metadata
            .as_object()
            .is_some_and(|map| keys.iter().any(|key| map.contains_key(*key)))
    };
    if uses_browser
        || has_key(&[
            "browserTransport",
            "browser_transport",
            crate::browser_hand_back::HAND_BACK_KEY,
            "browser_hand_back",
        ])
    {
        return Err(unsupported(
            "browser",
            "Claude Code can't use Instafy's browser. Ask an agent that uses another AI.",
        ));
    }
    if request.intent == "multi_agent_plan"
        || request.plan_seed.is_some()
        || has_key(&["multiAgentPlan", "multi_agent_plan"])
    {
        return Err(unsupported(
            "team_plan",
            "Claude Code agents can't take part in a team plan yet.",
        ));
    }
    if crate::system_turns::carries_attachments(metadata) {
        return Err(unsupported(
            "attachments",
            "Claude Code can't take attachments yet. Send your message without them.",
        ));
    }
    if request.intent != crate::dispatch::DEFAULT_PROMPT_INTENT
        || request.allow_internal_review
        || request.tool_limits.is_some()
        || request.repo.is_some()
        || request.requested_preview.is_some()
        || has_key(&["spaceReview", "space_review"])
    {
        return Err(unsupported(
            "instafy_feature",
            "Claude Code can't do this: it needs one of Instafy's own tools.",
        ));
    }
    if request.execution_mode != crate::dispatch::EXECUTION_MODE_APPLY
        && request.execution_mode != EXECUTION_MODE_PLAN_ONLY
    {
        return Err(unsupported(
            "execution_mode",
            "Claude Code can't take a turn that waits for your approval.",
        ));
    }
    Ok(())
}

/// The refusal of a Claude Code turn an agent's job would start: a send its
/// job token makes, or an automation it makes (docs/Local-Engine-Turns.md
/// 11.5). An agent's job reads what teammates
/// wrote in a shared chat, so its words could be theirs, and a Claude Code
/// turn runs only its own person's: their own messages, their own
/// automations and goals, and what dispatch starts for those.
pub(crate) fn not_from_an_agents_job() -> Refusal {
    unsupported(
        "delegated",
        "Claude Code takes turns only from its own person, never from another agent's job.",
    )
}

/// Whether any agent a dispatch with `metadata` reaches, for `person`, is a
/// Claude Code agent: its handles as dispatch resolves them, against that
/// person's own saved agents.
pub(crate) async fn selects_a_claude_code_agent(
    client: &(impl tokio_postgres::GenericClient + Sync),
    person: Uuid,
    metadata: &JsonValue,
) -> Result<bool, Refusal> {
    let handles = crate::dispatch::agent_selection_handles(metadata);
    client
        .query_one(
            "select exists (
                 select 1 from user_agents
                  where user_id = $1
                    and lower(handle) = any($2::text[])
                    and deleted_at is null
                    and provider = $3
                    and credential_id is null
             )",
            &[&person, &handles, &PROVIDER],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| {
            internal_error(format!(
                "failed to read the person's Claude Code agents: {error}"
            ))
        })
}

/// L3's refusal of a write scope a Claude Code agent's turn cannot be held
/// to: part of the space's files, or writes coordinated with other agents
/// writing at once. Only the whole space, or a read-only turn, is.
pub(crate) fn cannot_share_a_write_scope() -> Refusal {
    unsupported(
        "write_scope",
        "Claude Code can't be held to part of the space's files while other agents write, so it \
         can't take this turn. Send it the message on its own.",
    )
}

/// L3's words: not empty, at most [`CLAUDE_CODE_LANE_MAX_PROMPT_CHARS`]
/// characters (Unicode scalar values), and not a `/` command once leading
/// whitespace is removed, which Claude Code would read as its own.
fn check_prompt_text(prompt_text: &str) -> Result<(), Refusal> {
    if prompt_text.trim().is_empty() {
        return Err(unsupported("empty", "There's nothing to send."));
    }
    if prompt_text.chars().count() > CLAUDE_CODE_LANE_MAX_PROMPT_CHARS {
        return Err(unsupported(
            "too_long",
            "Claude Code takes messages of at most 100,000 characters.",
        ));
    }
    if prompt_text.trim_start().starts_with('/') {
        return Err(unsupported(
            "command",
            "Claude Code reads a message that starts with / as its own command, so it wasn't \
             sent. Start your message another way.",
        ));
    }
    Ok(())
}

/// Whether one of `person`'s own runtimes in `project_id` could take a lane
/// turn now, by the lease clause's runtime conditions: private self-hosted,
/// attested as theirs, without a Personal Browser, dispatch-ready, and with
/// an attested `claudeCode` capability that is ready. An ambient evaluation
/// that none could take is never queued (11.7).
pub(crate) async fn a_computer_is_ready(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    person: Uuid,
) -> Result<bool, Refusal> {
    let rows = transaction
        .query(
            "select id, project_id, provider, status, idle_ttl_seconds, last_seen_at,
                    endpoint_url, capabilities, display_name, active_lease_id
               from runtimes
              where project_id = $1
                and capabilities #>> '{_instafySelfHostedAccess,mode}' = 'private'
                and capabilities #>> '{_instafySelfHostedAccess,ownerUserId}' = $2
                and capabilities #> '{claudeCode,ready}' = 'true'::jsonb",
            &[project_id, &person.to_string()],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to look for a computer that runs Claude Code: {error}"
            ))
        })?;
    let now = Utc::now();
    Ok(rows.iter().any(|row| {
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
        runtime_takes_lane_turns(state, &record, person)
            && crate::dispatch::runtime_not_dispatch_ready_detail(&record, Some(&candidate), now)
                .is_none()
    }))
}

/// The lease clause's runtime conditions over a runtime row, apart from
/// readiness to take jobs: private self-hosted, its attested owner `person`
/// and never the service runtime user, no Personal Browser, and an attested
/// `claudeCode` capability of version 1 that is ready.
fn runtime_takes_lane_turns(
    state: &AppState,
    record: &runtime::RuntimeRecord,
    person: Uuid,
) -> bool {
    let capabilities = &record.capabilities;
    if !runtime::runtime_is_private_self_hosted(state, &record.provider, capabilities) {
        return false;
    }
    let person_text = person.to_string();
    let attested_owner = capabilities
        .get(SELF_HOSTED_ACCESS_KEY)
        .filter(|access| access.get("mode").and_then(JsonValue::as_str) == Some("private"))
        .and_then(|access| access.get("ownerUserId"))
        .and_then(JsonValue::as_str);
    if attested_owner != Some(person_text.as_str())
        || runtime::self_hosted_owner_user_id(capabilities) != Some(person)
        || state.config.service_runtime_user_id == Some(person)
    {
        return false;
    }
    if capabilities.get("personalBrowser").is_some()
        || capabilities.get("personal_browser").is_some()
    {
        return false;
    }
    let capability = capabilities.get(CAPABILITY_KEY);
    capability
        .and_then(|capability| capability.get("version"))
        .and_then(JsonValue::as_f64)
        .is_some_and(|version| version == CAPABILITY_VERSION)
        && capability.and_then(|capability| capability.get("ready")) == Some(&JsonValue::Bool(true))
}

/// Stamps a lane turn's metadata as only the controller does:
/// `claudeCode: {"version": 1}`, `aiAccessMode: "claude-code"` and
/// `managedAiUsed: false`. Dispatch stamps each Claude Code target's run, and
/// the person's message and prompt when every target is one; the job payload
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

/// A lane job's payload metadata (docs/Local-Engine-Turns.md 2.5, 11.12):
/// only [`PAYLOAD_METADATA_KEYS`] of dispatch's `metadata`, the stamps, and,
/// for a read-only turn, its `execution_mode`, where the runtime reads it
/// for any job. An `apply` turn names none, which the runtime reads as
/// `apply`.
pub(crate) fn payload_metadata(
    metadata: &JsonValue,
    execution_mode: &str,
) -> JsonMap<String, JsonValue> {
    let mut map = JsonMap::new();
    for key in PAYLOAD_METADATA_KEYS {
        if let Some(value) = metadata.get(key) {
            map.insert(key.to_string(), value.clone());
        }
    }
    if execution_mode == EXECUTION_MODE_PLAN_ONLY {
        map.insert(
            "execution_mode".to_string(),
            JsonValue::String(EXECUTION_MODE_PLAN_ONLY.to_string()),
        );
    }
    stamp(&mut map);
    map
}

/// The workspace mode a lane job's payload names (2.5, 11.12): read-only for
/// the `plan_only` execution mode, else a write in the space's folder.
pub(crate) fn workspace_mode(execution_mode: &str) -> &'static str {
    if execution_mode == EXECUTION_MODE_PLAN_ONLY {
        READ_ONLY_WORKSPACE_MODE
    } else {
        WORKSPACE_MODE
    }
}

/// The run metadata of an ambient evaluation no computer of its person's
/// could take (11.7), which dispatch closes without a job.
pub(crate) fn skipped_run_metadata() -> JsonValue {
    json!({ SKIPPED_KEY: { "reason": COMPUTER_AWAY } })
}

/// Whether a lane turn of `person`'s waits in `conversation_id`, queued for
/// their computer: an automation whose thread holds one of its owner's skips
/// its due run rather than pile another up behind it (11.7). A teammate's
/// waiting turn there never makes it skip.
pub(crate) async fn a_turn_waits_in(
    state: &AppState,
    conversation_id: &Uuid,
    person: &Uuid,
) -> anyhow::Result<bool> {
    Ok(state
        .pool
        .get()
        .await?
        .query_one(
            "select exists (
                 select 1 from agent_jobs
                  where conversation_id = $1
                    and engine is not null
                    and status = 'queued'
                    and (payload ->> 'user_id') = $2
             )",
            &[conversation_id, &person.to_string()],
        )
        .await?
        .get(0))
}

/// Whether `error`, from leasing a lane job, is the one-running-turn index
/// refusing a person's second running turn: 23505 on
/// [`ONE_RUNNING_TURN_INDEX`]. That lease takes nothing.
pub(crate) fn is_second_running_turn(error: &tokio_postgres::Error) -> bool {
    error.code() == Some(&SqlState::UNIQUE_VIOLATION)
        && error
            .as_db_error()
            .and_then(|error| error.constraint())
            .is_some_and(|constraint| constraint == ONE_RUNNING_TURN_INDEX)
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
/// words it by (docs/Local-Engine-Turns.md 5.5): the controller's own stamps
/// ([`stamp`]: `claudeCode`, `aiAccessMode: "claude-code"` and
/// `managedAiUsed: false`) and the failure code as [`FAILURE_KEY`]. Every
/// writer of such a message stamps it so, the sweeps and a runtime stop
/// included: a message a member records keeps only `aiAccessMode`, so
/// Studio, which shows a lane failure only for a message with the
/// controller's stamp, never takes one for a turn's failure.
pub(crate) fn stamp_failure(map: &mut JsonMap<String, JsonValue>, code: &str) {
    stamp(map);
    map.insert(FAILURE_KEY.to_string(), JsonValue::String(code.to_string()));
}

/// The conversation state the next lane turn resumes
/// (docs/Local-Engine-Turns.md 2.7, 11.9): that of the latest lane job, of
/// those that saved a lane-shaped one, in `conversation_id` of `project_id`,
/// for `agent_id` and of `person` (`payload.user_id`), whichever computer ran
/// it. A job that saved none, such as a stopped turn or one a sweep or runtime
/// stop failed, is passed over. None when there is no such job, or when its
/// state is the reset: the next turn then starts a new session. The runtime
/// resumes the session where its computer holds it, and starts a new one in
/// the same turn where it does not.
pub(crate) async fn load_session(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    person: &Uuid,
    agent_id: Option<&Uuid>,
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
                and j.proxy_metadata -> 'conversation' is not null
                and j.proxy_metadata -> 'conversation' <> 'null'::jsonb
                and (j.proxy_metadata #>> '{conversation,provider}') = $5
              order by j.created_at desc, j.id desc
              limit 1",
            &[
                project_id,
                conversation_id,
                &person.to_string(),
                &agent_id.to_string(),
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
        Some(session @ LaneState::Session { .. }) => Some(session.to_json()),
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

    /// A dispatch request as `POST /dispatch-prompt` would normalize it, with
    /// `extra` merged into its body.
    fn request(extra: JsonValue) -> DispatchPromptNormalized {
        let mut body = json!({
            "projectId": Uuid::new_v4().to_string(),
            "promptText": "fix the build",
            "metadata": { "input": { "kind": "person" }, "writeIntent": true },
        });
        for (key, value) in extra.as_object().expect("an object") {
            body[key] = value.clone();
        }
        crate::dispatch::normalize_dispatch_request(
            serde_json::from_value(body).expect("a dispatch request"),
        )
        .expect("a normalized request")
    }

    /// Whatever started a turn, it passes L3 when Claude Code can take it: a
    /// typed message, an automation's (also read-only), a goal's next step, a
    /// resend, a queued message and an evaluation alike (11.4).
    #[test]
    fn any_turn_claude_code_can_take_passes_whoever_started_it() {
        for (what, extra) in [
            ("a typed message", json!({})),
            (
                "an automation's run",
                json!({
                    "threadKind": "automation",
                    "metadata": { "execution_mode": "plan_only", "writeIntent": false },
                }),
            ),
            (
                "a goal's next step and a resend",
                json!({
                    "metadata": {
                        "goalContinuation": true,
                        "retryOfMessageId": Uuid::new_v4().to_string(),
                        "dispatchContent": "Continue toward the goal.",
                    },
                }),
            ),
            (
                "an evaluation",
                json!({ "metadata": { "groupParticipation": { "reason": "skill_mode_ambient" } } }),
            ),
            ("no person's input at all", json!({ "metadata": {} })),
        ] {
            let mut request = request(extra);
            if what == "an automation's run" {
                request.execution_mode = EXECUTION_MODE_PLAN_ONLY.to_string();
            }
            assert!(check_turn_shape(&request, false).is_ok(), "{what}");
        }
    }

    /// What Claude Code cannot give refuses the turn with its reason, and
    /// never moves it to another engine (11.4).
    #[test]
    fn a_turn_claude_code_cannot_take_is_refused_with_its_reason() {
        let cases: Vec<(&str, DispatchPromptNormalized, bool)> = vec![
            ("browser", request(json!({})), true),
            (
                "browser",
                request(json!({ "metadata": { "browserTransport": "shared" } })),
                false,
            ),
            (
                "team_plan",
                request(json!({ "intent": "multi_agent_plan" })),
                false,
            ),
            (
                "team_plan",
                request(json!({ "metadata": { "multiAgentPlan": { "role": "worker" } } })),
                false,
            ),
            ("team_plan", request(json!({ "planSeed": {} })), false),
            (
                "attachments",
                request(json!({ "metadata": { "attachments": [{ "id": "a" }] } })),
                false,
            ),
            // Empty tool limits are none (`dispatch::normalize_tool_limits`).
            (
                "instafy_feature",
                request(json!({ "toolLimits": { "maxSteps": 3 } })),
                false,
            ),
            (
                "instafy_feature",
                request(json!({ "metadata": { "spaceReview": {} } })),
                false,
            ),
        ];
        for (reason, request, uses_browser) in cases {
            let refusal = check_turn_shape(&request, uses_browser).expect_err(reason);
            assert_eq!(
                code_and_reason(&refusal),
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    TURN_UNSUPPORTED.to_string(),
                    reason.to_string()
                ),
                "{reason}"
            );
        }
        let mut approval = request(json!({}));
        approval.execution_mode = "approval_required".to_string();
        assert_eq!(
            code_and_reason(&check_turn_shape(&approval, false).expect_err("mode")).2,
            "execution_mode"
        );
        let mut internal_review = request(json!({}));
        internal_review.allow_internal_review = true;
        assert_eq!(
            code_and_reason(&check_turn_shape(&internal_review, false).expect_err("review")).2,
            "instafy_feature"
        );
    }

    /// L3 reads the words the target's job gets, its own part of a message
    /// to several agents included, not only the whole message's text.
    #[test]
    fn a_targets_own_words_are_checked() {
        let owner = Uuid::new_v4();
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "lane-target-words",
        );
        config.claude_code_lane =
            crate::config::ClaudeCodeLaneUsers(crate::config::DeviceGrantUsers::Only(vec![owner]));
        let context = RequestContext {
            user_id: Some(owner),
            is_service_role: false,
            scoped_claims: None,
        };
        let request = request(json!({ "promptText": "hi" }));
        fn target(prompt_text: &str) -> Target<'_> {
            Target {
                agent_id: Some(Uuid::new_v4()),
                uses_browser: false,
                prompt_text,
            }
        }
        assert!(check_target(&config, &context, &request, target("fix the build")).is_ok());
        for (words, reason) in [
            ("/init".to_string(), "command"),
            (
                "a".repeat(CLAUDE_CODE_LANE_MAX_PROMPT_CHARS + 1),
                "too_long",
            ),
        ] {
            let refusal =
                check_target(&config, &context, &request, target(&words)).expect_err(reason);
            assert_eq!(code_and_reason(&refusal).2, reason);
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
                    TURN_UNSUPPORTED.to_string(),
                    reason.to_string()
                )
            );
        }
    }

    /// A client's copies of the controller's own marks never survive, nested
    /// ones included; everything else stays.
    #[test]
    fn a_clients_copies_of_the_controllers_marks_are_stripped() {
        let mut metadata = json!({
            "claudeCode": { "version": 1 },
            "claudeCodeFailure": "plan_limit",
            "claudeCodeSkipped": { "reason": "computer_away" },
            "claude_code": {},
            "claude_code_failure": "x",
            "claude_code_skipped": {},
            "prompt_metadata": { "claudeCode": { "version": 1 }, "keep": 1 },
            "details": { "claudeCodeFailure": "not_signed_in" },
            "keep": true,
        });
        strip_client_marks(&mut metadata);
        assert_eq!(
            metadata,
            json!({ "prompt_metadata": { "keep": 1 }, "details": {}, "keep": true })
        );
        strip_client_marks(&mut JsonValue::Null);
    }

    /// The not-allowed refusal tells the person what to do instead.
    #[test]
    fn not_allowed_names_the_switch_and_what_to_do() {
        let refusal = not_allowed();
        assert_eq!(
            code_and_reason(&refusal),
            (
                StatusCode::FORBIDDEN,
                TURN_NOT_ALLOWED.to_string(),
                "not_allowed".to_string()
            )
        );
        assert!(refusal.1 .0.message.contains("Your AI"));
    }

    /// A read-only turn's payload says so where the runtime reads it, and
    /// names the read-only workspace mode; an apply turn names neither.
    #[test]
    fn a_read_only_turn_says_its_mode() {
        assert_eq!(workspace_mode("apply"), WORKSPACE_MODE);
        assert_eq!(
            workspace_mode(EXECUTION_MODE_PLAN_ONLY),
            READ_ONLY_WORKSPACE_MODE
        );
        let metadata = json!({ "execution_mode": "apply", "input": { "kind": "person" } });
        let apply = payload_metadata(&metadata, "apply");
        assert!(!apply.contains_key("execution_mode"));
        let read_only = payload_metadata(&metadata, EXECUTION_MODE_PLAN_ONLY);
        assert_eq!(read_only["execution_mode"], json!(EXECUTION_MODE_PLAN_ONLY));
    }

    #[test]
    fn a_skipped_evaluations_run_names_its_reason() {
        assert_eq!(
            skipped_run_metadata(),
            json!({ "claudeCodeSkipped": { "reason": "computer_away" } })
        );
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
            "ui": { "suggestedReplies": ["Run the tests"] },
        }));
        assert_eq!(
            without_lane_claims(&proxy_metadata),
            Some(json!({ "ui": { "suggestedReplies": ["Run the tests"] } }))
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

        // A failure message carries the controller's stamps beside its code,
        // over anything the message's own metadata said.
        let mut map = JsonMap::new();
        map.insert("source".to_string(), json!("controller"));
        map.insert("aiAccessMode".to_string(), json!("managed"));
        map.insert("managedAiUsed".to_string(), json!(true));
        stamp_failure(&mut map, MACHINE_STOPPED);
        assert_eq!(
            JsonValue::Object(map),
            json!({
                "source": "controller",
                "claudeCode": { "version": 1 },
                "aiAccessMode": "claude-code",
                "managedAiUsed": false,
                "claudeCodeFailure": MACHINE_STOPPED,
            })
        );
    }

    /// The codes only the controller writes, a runtime stop's and the
    /// sweeps' (runtime-contracts' list, which Studio words), are never
    /// copied from a runtime's failure artifact: a runtime cannot make its
    /// failure read as one of them. [`MACHINE_STOPPED`] is in that list.
    #[test]
    fn a_runtime_never_reports_a_stop_or_sweep_code() {
        use runtime_contracts::claude_code_lane::STOP_AND_SWEEP_FAILURE_CODES;
        for code in STOP_AND_SWEEP_FAILURE_CODES {
            assert_eq!(
                reported_failure_code(&json!([{ "kind": FAILURE_ARTIFACT_KIND, "code": code }])),
                None,
                "{code}"
            );
        }
        assert!(STOP_AND_SWEEP_FAILURE_CODES.contains(&MACHINE_STOPPED));
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
            "groupParticipation": { "reason": "skill_mode_ambient" },
            "groupAiParticipants": [{ "handle": "helper" }],
            "managedAiBillingDeferred": true,
        });
        assert_eq!(
            JsonValue::Object(payload_metadata(&metadata, "apply")),
            json!({
                "agent": { "handle": "octo" },
                "writeScope": { "mode": "unscoped" },
                "conversationVisibility": "public",
                "runtimePreference": { "runtimeId": "r" },
                "groupParticipation": { "reason": "skill_mode_ambient" },
                "input": { "kind": "person" },
                "writeIntent": true,
                "claudeCode": { "version": 1 },
                "aiAccessMode": "claude-code",
                "managedAiUsed": false,
            })
        );
    }
}
