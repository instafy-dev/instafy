use std::collections::HashSet;
use std::str::FromStr;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::agent::{
    ensure_agent_token_matches_runtime_lease, extract_agent_token, verify_agent_token_with_scopes,
};
use crate::auth::authenticate_request;
use crate::conversations::{
    build_conversation_last_message_preview, conversation_message_idempotency_lock_key,
    ensure_conversation_access, load_conversation_record, map_conversation_message_row,
    publish_conversation_message_event, sanitize_client_recorded_message_metadata,
    ConversationMessageRow, ConversationPromptBody,
};
use crate::dispatch::ensure_project_prompt_access;
use crate::state::EventHub;
use crate::{
    bad_request, ensure_project_write_access, internal_error,
    publish_controller_event_with_conversation, unauthorized, ApiError, AppState,
};

const ACTIVE_TURN_INPUT_KIND: &str = "active_turn_input";
const MAX_CLIENT_SEND_ID_CHARS: usize = 200;
const MAX_TARGET_AGENT_HANDLES: usize = 16;
const MAX_TARGET_AGENT_HANDLE_CHARS: usize = 64;
const MAX_STEER_PROMPT_CHARS: usize = 64_000;
const CLAIM_NEXT_AGENT_JOB_INPUT_SQL: &str = "with candidate as (
         select id
         from agent_job_inputs
         where job_id = $1
           and lease_attempt = $3
           and target_turn_id = $4
           and (
             status = 'pending'
             or (status = 'delivering' and claimed_by_runtime_id = $2)
           )
         order by sequence asc
         limit 1
         for update skip locked
     )
     update agent_job_inputs inputs
     set status = 'delivering',
         claimed_by_runtime_id = $2,
         claimed_at = coalesce(claimed_at, now()),
         error_message = null,
         updated_at = now()
     from candidate
     where inputs.id = candidate.id
     returning inputs.id,
               inputs.project_id,
               inputs.conversation_id,
               inputs.job_id,
               inputs.run_id,
               inputs.message_id,
               inputs.sequence,
               inputs.target_turn_id,
               inputs.status,
               inputs.request #>> '{message,promptText}' as content,
               inputs.created_at";

const COMPLETION_REJECTION: &str = "active turn completed before input acknowledgement";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/:conversation_id/send-intents",
            post(post_conversation_send_intent),
        )
        .route(
            "/agent/jobs/:job_id/inputs",
            post(claim_next_agent_job_input).delete(clear_agent_job_input_readiness),
        )
        .route(
            "/agent/jobs/:job_id/inputs/:command_id/ack",
            post(acknowledge_agent_job_input),
        )
}

/// Shared request shape for all composer send modes. `request` is the canonical
/// field; `message` remains accepted so the existing send-queue payload can be
/// moved to this endpoint without a client-side data migration.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendIntentRequest {
    pub(crate) client_send_id: String,
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) request: Option<JsonValue>,
    #[serde(default)]
    pub(crate) message: Option<JsonValue>,
    #[serde(default)]
    pub(crate) expected_active_job_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) target_agent_handles: Vec<String>,
}

impl SendIntentRequest {
    pub(crate) fn message_value(&self) -> Result<&JsonValue, (StatusCode, Json<ApiError>)> {
        match (&self.request, &self.message) {
            (Some(request), None) | (None, Some(request)) => Ok(request),
            (Some(_), Some(_)) => Err(send_intent_error(
                StatusCode::BAD_REQUEST,
                "send intent must contain either `request` or `message`, not both",
                "invalid_send_intent",
                None,
            )),
            (None, None) => Err(send_intent_error(
                StatusCode::BAD_REQUEST,
                "send intent request is required",
                "invalid_send_intent",
                None,
            )),
        }
    }

    pub(crate) fn normalized_mode(&self) -> String {
        self.mode.trim().to_ascii_lowercase().replace('-', "_")
    }
}

/// Normalized response shared by steer and the queue/stash extension arms.
/// Fields that do not apply to a mode are omitted rather than filled with
/// synthetic identifiers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendIntentResponse {
    pub(crate) requested_mode: String,
    pub(crate) applied_mode: String,
    pub(crate) state: String,
    pub(crate) client_send_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) deduplicated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) queue_entry: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) job_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) run_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sequence: Option<i64>,
}

impl SendIntentResponse {
    fn steer(command: &StoredJobInput, client_send_id: String, deduplicated: bool) -> Self {
        Self {
            requested_mode: "steer".to_string(),
            applied_mode: "steer".to_string(),
            state: command.status.clone(),
            client_send_id,
            deduplicated: Some(deduplicated),
            queue_entry: None,
            command_id: Some(command.id),
            job_id: Some(command.job_id),
            run_id: command.run_id,
            message_id: command.message_id,
            sequence: Some(command.sequence),
        }
    }

    pub(crate) fn queue(
        client_send_id: String,
        state: impl Into<String>,
        queue_entry: JsonValue,
        deduplicated: bool,
    ) -> Self {
        Self {
            requested_mode: "queue".to_string(),
            applied_mode: "queue".to_string(),
            state: state.into(),
            client_send_id,
            deduplicated: Some(deduplicated),
            queue_entry: Some(queue_entry),
            command_id: None,
            job_id: None,
            run_id: None,
            message_id: None,
            sequence: None,
        }
    }
}

#[derive(Debug)]
struct ActiveJobTarget {
    id: Uuid,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    lease_attempt: i32,
    runtime_id: Uuid,
    turn_id: String,
    payload: JsonValue,
    capabilities: JsonValue,
}

#[derive(Debug, PartialEq, Eq)]
enum ActiveJobSelection {
    Target(usize),
    ExpectedConflict(Vec<Uuid>),
    None,
    Ambiguous(Vec<Uuid>),
}

#[derive(Debug)]
struct StoredJobInput {
    id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    message_id: Option<Uuid>,
    sequence: i64,
    status: String,
    request: JsonValue,
}

#[derive(Debug, Clone)]
pub(crate) struct JobInputStateUpdate {
    command_id: Uuid,
    project_id: Uuid,
    conversation_id: Uuid,
    session_id: Option<Uuid>,
    job_id: Uuid,
    run_id: Option<Uuid>,
    message_id: Option<Uuid>,
    sequence: i64,
    state: String,
    error_message: Option<String>,
    message: Option<ConversationMessageRow>,
}

fn stored_job_input(row: &tokio_postgres::Row) -> StoredJobInput {
    StoredJobInput {
        id: row.get("id"),
        job_id: row.get("job_id"),
        run_id: row.get("run_id"),
        message_id: row.get("message_id"),
        sequence: row.get("sequence"),
        status: row.get("status"),
        request: row.get::<_, PgJson<JsonValue>>("request").0,
    }
}

async fn set_send_intent_message_state(
    transaction: &tokio_postgres::Transaction<'_>,
    message_id: &Uuid,
    state: &str,
    error_message: Option<&str>,
) -> Result<Option<ConversationMessageRow>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "update conversation_messages
             set metadata = jsonb_set(
                   jsonb_set(
                     coalesce(metadata, '{}'::jsonb),
                     '{sendIntent,state}',
                     to_jsonb($2::text),
                     true
                   ),
                   '{sendIntent,errorMessage}',
                   coalesce(to_jsonb($3::text), 'null'::jsonb),
                   true
                 )
             where id = $1
             returning id,
                       conversation_id,
                       project_id,
                       session_id,
                       created_by,
                       prompt_id,
                       run_id,
                       role,
                       content,
                       metadata,
                       created_at",
            &[message_id, &state, &error_message],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to update send-intent message state: {error}"
            ))
        })?;
    Ok(row.as_ref().map(map_conversation_message_row))
}

fn send_intent_error(
    status: StatusCode,
    message: impl Into<String>,
    code: impl Into<String>,
    details: Option<JsonValue>,
) -> (StatusCode, Json<ApiError>) {
    let message = message.into();
    let code = code.into();
    (
        status,
        Json(match details {
            Some(details) => ApiError::with_details(message, code, details),
            None => ApiError {
                message,
                code: Some(code),
                details: None,
            },
        }),
    )
}

fn normalize_client_send_id(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(send_intent_error(
            StatusCode::BAD_REQUEST,
            "clientSendId is required",
            "invalid_send_intent",
            None,
        ));
    }
    if normalized.chars().count() > MAX_CLIENT_SEND_ID_CHARS {
        return Err(send_intent_error(
            StatusCode::BAD_REQUEST,
            format!("clientSendId must be at most {MAX_CLIENT_SEND_ID_CHARS} characters"),
            "invalid_send_intent",
            None,
        ));
    }
    Ok(normalized.to_string())
}

pub(crate) fn normalize_target_agent_handles(
    handles: &[String],
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    if handles.len() > MAX_TARGET_AGENT_HANDLES {
        return Err(send_intent_error(
            StatusCode::BAD_REQUEST,
            format!("at most {MAX_TARGET_AGENT_HANDLES} targetAgentHandles are allowed"),
            "invalid_send_intent",
            None,
        ));
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in handles {
        let handle = raw.trim().trim_start_matches('@').to_ascii_lowercase();
        if handle.is_empty() {
            continue;
        }
        if handle.chars().count() > MAX_TARGET_AGENT_HANDLE_CHARS {
            return Err(send_intent_error(
                StatusCode::BAD_REQUEST,
                format!(
                    "target agent handles must be at most {MAX_TARGET_AGENT_HANDLE_CHARS} characters"
                ),
                "invalid_send_intent",
                None,
            ));
        }
        if seen.insert(handle.clone()) {
            normalized.push(handle);
        }
    }
    normalized.sort();
    Ok(normalized)
}

fn active_job_agent_handle(payload: &JsonValue) -> Option<String> {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("agent"))
        .and_then(JsonValue::as_object)
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .map(|value| value.trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
}

pub(crate) fn runtime_supports_active_turn_input(capabilities: &JsonValue) -> bool {
    capabilities
        .get("activeTurnInput")
        .or_else(|| capabilities.get("active_turn_input"))
        .and_then(JsonValue::as_bool)
        == Some(true)
        || capabilities
            .get("conversations")
            .and_then(JsonValue::as_object)
            .and_then(|value| {
                value
                    .get("activeTurnInput")
                    .or_else(|| value.get("active_turn_input"))
            })
            .and_then(JsonValue::as_bool)
            == Some(true)
}

fn normalized_steer_envelope(
    message: &JsonValue,
    expected_active_job_id: Option<Uuid>,
    target_agent_handles: &[String],
) -> JsonValue {
    json!({
        "mode": "steer",
        "message": message,
        "expectedActiveJobId": expected_active_job_id,
        "targetAgentHandles": target_agent_handles,
    })
}

fn idempotency_envelope_matches(stored: &JsonValue, incoming: &JsonValue) -> bool {
    stored == incoming
}

fn require_expected_active_job_id(
    expected_active_job_id: Option<Uuid>,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    expected_active_job_id.ok_or_else(|| {
        send_intent_error(
            StatusCode::CONFLICT,
            "steer requires the exact active job observed by the client",
            "active_job_conflict",
            Some(json!({ "expectedActiveJobId": null })),
        )
    })
}

fn select_active_job(
    active_jobs: &[ActiveJobTarget],
    expected_job_id: Option<Uuid>,
    target_agent_handles: &[String],
) -> ActiveJobSelection {
    if let Some(expected_job_id) = expected_job_id {
        if !active_jobs.iter().any(|job| job.id == expected_job_id) {
            return ActiveJobSelection::ExpectedConflict(
                active_jobs.iter().map(|job| job.id).collect(),
            );
        }
    }

    let matching = active_jobs
        .iter()
        .enumerate()
        .filter(|(_, job)| expected_job_id.map_or(true, |expected| job.id == expected))
        .filter(|(_, job)| {
            target_agent_handles.is_empty()
                || active_job_agent_handle(&job.payload).is_some_and(|handle| {
                    target_agent_handles.iter().any(|target| target == &handle)
                })
        })
        .collect::<Vec<_>>();
    match matching.as_slice() {
        [] => ActiveJobSelection::None,
        [(index, _)] => ActiveJobSelection::Target(*index),
        candidates => {
            ActiveJobSelection::Ambiguous(candidates.iter().map(|(_, job)| job.id).collect())
        }
    }
}

fn permits_late_applied_ack(
    existing_status: &str,
    next_status: &str,
    rejected_by: Option<&str>,
    was_claimed: bool,
    claimed_by_runtime_id: Option<Uuid>,
    acknowledging_runtime_id: Uuid,
    command_lease_attempt: i32,
    current_lease_attempt: i32,
) -> bool {
    existing_status == "rejected"
        && next_status == "applied"
        && rejected_by == Some("controller")
        && was_claimed
        && claimed_by_runtime_id == Some(acknowledging_runtime_id)
        && command_lease_attempt == current_lease_attempt
}

pub(crate) async fn post_conversation_send_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    Json(body): Json<SendIntentRequest>,
) -> Result<Json<SendIntentResponse>, (StatusCode, Json<ApiError>)> {
    let mode = body.normalized_mode();
    match mode.as_str() {
        "steer" => apply_steer_send_intent(&state, &headers, &conversation_id_raw, &body)
            .await
            .map(Json),
        "queue" => {
            let context = authenticate_request(&state.config, &headers).await?;
            let conversation_id = Uuid::from_str(conversation_id_raw.trim())
                .map_err(|_| bad_request("conversationId must be a valid UUID"))?;
            let message = body.message_value()?.clone();
            let outcome = crate::send_queue::enqueue_prompt_with_context(
                &state,
                &context,
                conversation_id,
                &body.client_send_id,
                message,
            )
            .await?;
            let queue_state = outcome
                .entry
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("queued")
                .to_string();
            Ok(Json(SendIntentResponse::queue(
                body.client_send_id.trim().to_string(),
                queue_state,
                outcome.entry,
                outcome.deduplicated,
            )))
        }
        _ => Err(send_intent_error(
            StatusCode::BAD_REQUEST,
            "mode must be `steer` or `queue`",
            "invalid_send_intent_mode",
            Some(json!({ "requestedMode": mode })),
        )),
    }
}

/// Genuine same-turn steering. This helper is intentionally separate from the
/// route dispatcher so queue/stash modes can share the wire contract without
/// coupling their persistence to the active-turn implementation.
pub(crate) async fn apply_steer_send_intent(
    state: &AppState,
    headers: &HeaderMap,
    conversation_id_raw: &str,
    body: &SendIntentRequest,
) -> Result<SendIntentResponse, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    if context.scoped_claims.is_some() {
        return Err(unauthorized(
            "send intents require a user session or trusted service authorization",
        ));
    }

    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;
    let expected_active_job_id = require_expected_active_job_id(body.expected_active_job_id)?;
    let client_send_id = normalize_client_send_id(&body.client_send_id)?;
    let target_agent_handles = normalize_target_agent_handles(&body.target_agent_handles)?;
    let message_value = body.message_value()?.clone();
    let message: ConversationPromptBody =
        serde_json::from_value(message_value.clone()).map_err(|error| {
            send_intent_error(
                StatusCode::BAD_REQUEST,
                format!("request is not a valid conversation prompt: {error}"),
                "invalid_send_intent",
                None,
            )
        })?;
    let prompt_text = message.prompt_text.trim().to_string();
    if prompt_text.is_empty() {
        return Err(send_intent_error(
            StatusCode::BAD_REQUEST,
            "request promptText must not be empty",
            "invalid_send_intent",
            None,
        ));
    }
    if prompt_text.chars().count() > MAX_STEER_PROMPT_CHARS {
        return Err(send_intent_error(
            StatusCode::BAD_REQUEST,
            format!("request promptText must be at most {MAX_STEER_PROMPT_CHARS} characters"),
            "invalid_send_intent",
            None,
        ));
    }

    let envelope = normalized_steer_envelope(
        &message_value,
        Some(expected_active_job_id),
        &target_agent_handles,
    );

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let conversation = load_conversation_record(&transaction, &conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, conversation.session_id).await?;
    ensure_project_prompt_access(&transaction, &project, &context, conversation.session_id).await?;
    ensure_conversation_access(&transaction, &conversation, &context).await?;

    let advisory_lock_key =
        conversation_message_idempotency_lock_key(&conversation_id, &client_send_id);
    transaction
        .query_one("select pg_advisory_xact_lock($1)", &[&advisory_lock_key])
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to acquire send intent idempotency lock: {error}"
            ))
        })?;

    if let Some(row) = transaction
        .query_opt(
            "select id, job_id, run_id, message_id, sequence, status, request
             from agent_job_inputs
             where conversation_id = $1
               and created_by is not distinct from $2
               and client_send_id = $3
             limit 1",
            &[&conversation_id, &context.user_id, &client_send_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to look up existing send intent: {error}"))
        })?
    {
        let existing = stored_job_input(&row);
        if !idempotency_envelope_matches(&existing.request, &envelope) {
            return Err(send_intent_error(
                StatusCode::CONFLICT,
                "clientSendId is already bound to a different send intent",
                "send_intent_idempotency_conflict",
                Some(json!({ "clientSendId": client_send_id })),
            ));
        }
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to finalize send intent lookup: {error}"))
        })?;
        return Ok(SendIntentResponse::steer(&existing, client_send_id, true));
    }

    let rows = transaction
        .query(
            "select jobs.id,
                    jobs.run_id,
                    jobs.prompt_id,
                    jobs.lease_attempts,
                    jobs.leased_by_runtime_id,
                    jobs.active_input_ready_turn_id,
                    jobs.payload,
                    runtimes.capabilities
             from agent_jobs jobs
             join runtimes on runtimes.id = jobs.leased_by_runtime_id
             where jobs.project_id = $1
               and jobs.conversation_id = $2
               and jobs.status = 'leased'
               and jobs.lease_expires_at > now()
               and jobs.active_input_ready_runtime_id = jobs.leased_by_runtime_id
               and jobs.active_input_ready_expires_at > now()
               and nullif(btrim(jobs.active_input_ready_turn_id), '') is not null
               and runtimes.status in ('ready', 'running', 'draining')
             order by jobs.created_at asc, jobs.id asc
             for update of jobs",
            &[&conversation.project_id, &conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to resolve active agent jobs: {error}")))?;

    let active_jobs = rows
        .into_iter()
        .map(|row| ActiveJobTarget {
            id: row.get("id"),
            run_id: row.get("run_id"),
            prompt_id: row.get("prompt_id"),
            lease_attempt: row.get("lease_attempts"),
            runtime_id: row.get("leased_by_runtime_id"),
            turn_id: row.get("active_input_ready_turn_id"),
            payload: row.get::<_, PgJson<JsonValue>>("payload").0,
            capabilities: row.get::<_, PgJson<JsonValue>>("capabilities").0,
        })
        .collect::<Vec<_>>();

    let target_index = match select_active_job(
        &active_jobs,
        Some(expected_active_job_id),
        &target_agent_handles,
    ) {
        ActiveJobSelection::Target(index) => index,
        ActiveJobSelection::ExpectedConflict(active_job_ids) => {
            return Err(send_intent_error(
                StatusCode::CONFLICT,
                "the expected active job is no longer available",
                "active_job_conflict",
                Some(json!({
                    "expectedActiveJobId": expected_active_job_id,
                    "activeJobIds": active_job_ids,
                })),
            ));
        }
        ActiveJobSelection::None => {
            return Err(send_intent_error(
                StatusCode::CONFLICT,
                "there is no matching active agent turn to steer",
                "no_active_job",
                Some(json!({ "targetAgentHandles": target_agent_handles })),
            ));
        }
        ActiveJobSelection::Ambiguous(active_job_ids) => {
            return Err(send_intent_error(
                StatusCode::CONFLICT,
                "more than one active agent turn matches this steer request",
                "ambiguous_active_job",
                Some(json!({
                    "activeJobIds": active_job_ids,
                    "targetAgentHandles": target_agent_handles,
                })),
            ));
        }
    };
    let target = &active_jobs[target_index];

    if !runtime_supports_active_turn_input(&target.capabilities) {
        return Err(send_intent_error(
            StatusCode::CONFLICT,
            "the active runtime does not support same-turn input",
            "active_turn_input_unavailable",
            Some(json!({ "jobId": target.id, "runtimeId": target.runtime_id })),
        ));
    }

    let command_id = Uuid::new_v4();
    let message_id = Uuid::new_v4();
    let sequence = transaction
        .query_one(
            "select coalesce(max(sequence), 0)::bigint + 1
             from agent_job_inputs
             where job_id = $1",
            &[&target.id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to allocate job input sequence: {error}")))?
        .get::<_, i64>(0);

    let mut metadata = match message.metadata.clone() {
        Some(JsonValue::Object(map)) => JsonValue::Object(map),
        _ => json!({}),
    };
    metadata = sanitize_client_recorded_message_metadata(metadata, context.is_service_role);
    let metadata_map = metadata.as_object_mut().unwrap_or_else(|| unreachable!());
    metadata_map.insert(
        "clientMessageId".to_string(),
        JsonValue::String(client_send_id.clone()),
    );
    metadata_map.insert(
        "sendIntent".to_string(),
        json!({
            "mode": "steer",
            "commandId": command_id,
            "jobId": target.id,
            "sequence": sequence,
            "state": "pending",
        }),
    );
    let metadata_param = PgJson(&metadata);

    let message_row = transaction
        .query_one(
            "insert into conversation_messages (
                 id, conversation_id, project_id, session_id, prompt_id, run_id,
                 role, content, metadata, created_by
             ) values ($1, $2, $3, $4, $5, $6, 'user', $7, $8::jsonb, $9)
             returning id, conversation_id, project_id, session_id, created_by,
                       prompt_id, run_id, role, content, metadata, created_at",
            &[
                &message_id,
                &conversation_id,
                &conversation.project_id,
                &conversation.session_id,
                &target.prompt_id,
                &target.run_id,
                &prompt_text,
                &metadata_param,
                &context.user_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to persist steer conversation message: {error}"
            ))
        })?;

    let last_message_preview = build_conversation_last_message_preview(&prompt_text);
    transaction
        .execute(
            "update conversations
             set updated_at = now(),
                 last_message_id = $2,
                 last_message_at = now(),
                 last_message_preview = $3
             where id = $1",
            &[&conversation_id, &message_id, &last_message_preview],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to update steered conversation: {error}"))
        })?;
    if let Some(root_id) = conversation
        .root_conversation_id
        .filter(|root_id| root_id != &conversation.id)
    {
        transaction
            .execute(
                "update conversations set updated_at = now() where id = $1",
                &[&root_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to update root conversation: {error}"))
            })?;
    }
    if let Some(user_id) = context.user_id {
        transaction
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'member', $2)
                 on conflict (conversation_id, user_id) do nothing",
                &[&conversation_id, &user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to add steer message participant: {error}"))
            })?;
    }

    let envelope_param = PgJson(&envelope);
    let command_row = transaction
        .query_one(
            "insert into agent_job_inputs (
                 id, project_id, conversation_id, job_id, run_id, message_id,
                 created_by, client_send_id, lease_attempt, target_turn_id, sequence, kind, request
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
             returning id, job_id, run_id, message_id, sequence, status, request",
            &[
                &command_id,
                &conversation.project_id,
                &conversation_id,
                &target.id,
                &target.run_id,
                &message_id,
                &context.user_id,
                &client_send_id,
                &target.lease_attempt,
                &target.turn_id,
                &sequence,
                &ACTIVE_TURN_INPUT_KIND,
                &envelope_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to enqueue active-turn input: {error}")))?;
    let command = stored_job_input(&command_row);
    let persisted_message = map_conversation_message_row(&message_row);

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit steer send intent: {error}")))?;

    publish_conversation_message_event(&state.events, &persisted_message);
    crate::notifications::enqueue_message_push_notifications(
        state.clone(),
        persisted_message.clone(),
    );
    publish_job_input_event(
        state,
        conversation.project_id,
        conversation.session_id,
        conversation_id,
        target.run_id,
        &command,
        false,
    );

    Ok(SendIntentResponse::steer(&command, client_send_id, false))
}

fn publish_job_input_event(
    state: &AppState,
    project_id: Uuid,
    session_id: Option<Uuid>,
    conversation_id: Uuid,
    run_id: Option<Uuid>,
    command: &StoredJobInput,
    deduplicated: bool,
) {
    publish_job_input_state_event(
        &state.events,
        project_id,
        session_id,
        conversation_id,
        run_id,
        command.id,
        command.job_id,
        command.message_id,
        command.sequence,
        &command.status,
        None,
        deduplicated,
    );
}

#[allow(clippy::too_many_arguments)]
fn publish_job_input_state_event(
    events: &EventHub,
    project_id: Uuid,
    session_id: Option<Uuid>,
    conversation_id: Uuid,
    run_id: Option<Uuid>,
    command_id: Uuid,
    job_id: Uuid,
    message_id: Option<Uuid>,
    sequence: i64,
    command_state: &str,
    error_message: Option<&str>,
    deduplicated: bool,
) {
    publish_controller_event_with_conversation(
        events,
        "agent.jobInput",
        Some(project_id),
        session_id,
        Some(conversation_id),
        run_id,
        None,
        json!({
            "commandId": command_id,
            "jobId": job_id,
            "runId": run_id,
            "messageId": message_id,
            "sequence": sequence,
            "state": command_state,
            "errorMessage": error_message,
            "deduplicated": deduplicated,
        }),
    );
}

pub(crate) fn publish_job_input_state_updates(state: &AppState, updates: &[JobInputStateUpdate]) {
    publish_job_input_state_updates_to_hub(&state.events, updates);
}

fn publish_job_input_state_updates_to_hub(events: &EventHub, updates: &[JobInputStateUpdate]) {
    for update in updates {
        if let Some(message) = update.message.as_ref() {
            // `conversation.message_created` is an idempotent upsert in the
            // frontend. Reusing it makes sendIntent metadata transitions
            // visible without introducing a provider-specific browser event
            // or duplicating push notifications.
            publish_conversation_message_event(events, message);
        }
        publish_job_input_state_event(
            events,
            update.project_id,
            update.session_id,
            update.conversation_id,
            update.run_id,
            update.command_id,
            update.job_id,
            update.message_id,
            update.sequence,
            &update.state,
            update.error_message.as_deref(),
            false,
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputDelivery {
    command_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    message_id: Option<Uuid>,
    sequence: i64,
    target_turn_id: String,
    content: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputPollResponse {
    commands: Vec<AgentJobInputDelivery>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputPollBody {
    active_turn_id: String,
}

async fn claim_next_agent_job_input(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(job_id_raw): AxumPath<String>,
    Json(body): Json<AgentJobInputPollBody>,
) -> Result<Json<AgentJobInputPollResponse>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.input"])?;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent input token is missing its runtime scope"))?;
    let job_id =
        Uuid::from_str(job_id_raw.trim()).map_err(|_| bad_request("jobId must be a valid UUID"))?;
    let active_turn_id = body.active_turn_id.trim();
    if active_turn_id.is_empty() || active_turn_id.chars().count() > 200 {
        return Err(bad_request(
            "activeTurnId must contain between 1 and 200 characters",
        ));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, &runtime_id).await?;

    let job = transaction
        .query_opt(
            "update agent_jobs jobs
             set active_input_ready_runtime_id = $3,
                 active_input_ready_expires_at = now() + interval '2 seconds',
                 active_input_ready_turn_id = $4,
                 updated_at = now()
             from runtimes
             where jobs.id = $1
               and jobs.project_id = $2
               and jobs.status = 'leased'
               and jobs.lease_expires_at > now()
               and jobs.leased_by_runtime_id = $3
               and runtimes.id = $3
             returning jobs.lease_attempts, runtimes.capabilities",
            &[&job_id, &claims.project_id, &runtime_id, &active_turn_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to authorize job input poll: {error}")))?;
    let Some(job) = job else {
        return Err(send_intent_error(
            StatusCode::CONFLICT,
            "agent job lease is no longer active",
            "agent_job_input_lease_lost",
            Some(json!({ "jobId": job_id })),
        ));
    };
    let capabilities = job.get::<_, PgJson<JsonValue>>("capabilities").0;
    let lease_attempt: i32 = job.get("lease_attempts");
    if !runtime_supports_active_turn_input(&capabilities) {
        return Err(send_intent_error(
            StatusCode::FORBIDDEN,
            "runtime is not registered for active-turn input",
            "active_turn_input_unavailable",
            Some(json!({ "runtimeId": runtime_id })),
        ));
    }

    let row = transaction
        .query_opt(
            CLAIM_NEXT_AGENT_JOB_INPUT_SQL,
            &[&job_id, &runtime_id, &lease_attempt, &active_turn_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to claim active-turn input: {error}")))?;

    let delivery_update = if let Some(row) = row.as_ref() {
        let message_id: Option<Uuid> = row.get("message_id");
        let message = match message_id {
            Some(message_id) => {
                set_send_intent_message_state(&transaction, &message_id, "delivering", None).await?
            }
            None => None,
        };
        let conversation_id: Uuid = row.get("conversation_id");
        let session_id = transaction
            .query_opt(
                "select session_id from conversations where id = $1",
                &[&conversation_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load input delivery conversation: {error}"
                ))
            })?
            .and_then(|row| row.get("session_id"));
        Some(JobInputStateUpdate {
            command_id: row.get("id"),
            project_id: row.get("project_id"),
            conversation_id,
            session_id,
            job_id: row.get("job_id"),
            run_id: row.get("run_id"),
            message_id,
            sequence: row.get("sequence"),
            state: row.get("status"),
            error_message: None,
            message,
        })
    } else {
        None
    };

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit active-turn input claim: {error}"))
    })?;
    if let Some(update) = delivery_update.as_ref() {
        publish_job_input_state_updates(&state, std::slice::from_ref(update));
    }

    let commands = row
        .map(|row| AgentJobInputDelivery {
            command_id: row.get("id"),
            job_id: row.get("job_id"),
            run_id: row.get("run_id"),
            message_id: row.get("message_id"),
            sequence: row.get("sequence"),
            target_turn_id: row.get("target_turn_id"),
            content: row.get::<_, Option<String>>("content").unwrap_or_default(),
            created_at: row.get("created_at"),
        })
        .into_iter()
        .collect();
    Ok(Json(AgentJobInputPollResponse { commands }))
}

#[derive(Debug, Serialize)]
struct AgentJobInputReadinessResponse {
    ok: bool,
}

async fn clear_agent_job_input_readiness(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(job_id_raw): AxumPath<String>,
) -> Result<Json<AgentJobInputReadinessResponse>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.input"])?;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent input token is missing its runtime scope"))?;
    let job_id =
        Uuid::from_str(job_id_raw.trim()).map_err(|_| bad_request("jobId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, &runtime_id).await?;
    let cleared_job = transaction
        .query_opt(
            "update agent_jobs
             set active_input_ready_runtime_id = null,
                 active_input_ready_expires_at = null,
                 active_input_ready_turn_id = null,
                 updated_at = now()
             where id = $1
               and project_id = $2
               and status = 'leased'
               and lease_expires_at > now()
               and leased_by_runtime_id = $3
               and active_input_ready_runtime_id = $3
             returning id",
            &[&job_id, &claims.project_id, &runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to clear active-turn input readiness: {error}"
            ))
        })?;
    if cleared_job.is_none() {
        return Err(send_intent_error(
            StatusCode::CONFLICT,
            "agent job is not an active input turn owned by this runtime",
            "agent_job_input_lease_lost",
            Some(json!({ "jobId": job_id })),
        ));
    }
    let updates = reject_unacknowledged_inputs_for_job(
        &transaction,
        &job_id,
        "active turn ended before input acknowledgement",
    )
    .await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit active-turn readiness clear: {error}"
        ))
    })?;
    publish_job_input_state_updates(&state, &updates);
    Ok(Json(AgentJobInputReadinessResponse { ok: true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputAckBody {
    outcome: String,
    #[serde(default)]
    codex_turn_id: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentJobInputAckResponse {
    ok: bool,
    state: String,
}

async fn acknowledge_agent_job_input(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((job_id_raw, command_id_raw)): AxumPath<(String, String)>,
    Json(body): Json<AgentJobInputAckBody>,
) -> Result<Json<AgentJobInputAckResponse>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.input"])?;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent input token is missing its runtime scope"))?;
    let job_id =
        Uuid::from_str(job_id_raw.trim()).map_err(|_| bad_request("jobId must be a valid UUID"))?;
    let command_id = Uuid::from_str(command_id_raw.trim())
        .map_err(|_| bad_request("commandId must be a valid UUID"))?;
    let outcome = body.outcome.trim().to_ascii_lowercase();
    let next_status = match outcome.as_str() {
        "applied" => "applied",
        "rejected" => "rejected",
        _ => return Err(bad_request("outcome must be `applied` or `rejected`")),
    };
    let codex_turn_id = body
        .codex_turn_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(200).collect::<String>());
    let error_message = body
        .error_message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(2_000).collect::<String>());

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    ensure_agent_token_matches_runtime_lease(&state, &transaction, &claims, &runtime_id).await?;

    let existing = transaction
        .query_opt(
            "select inputs.id,
                    inputs.project_id,
                    inputs.conversation_id,
                    inputs.job_id,
                    inputs.run_id,
                    inputs.message_id,
                    inputs.sequence,
                    inputs.status,
                    inputs.request,
                    inputs.rejected_by,
                    inputs.claimed_at,
                    inputs.claimed_by_runtime_id,
                    inputs.lease_attempt,
                    inputs.target_turn_id,
                    jobs.lease_attempts as current_lease_attempt,
                    conversations.session_id
             from agent_job_inputs inputs
             join conversations on conversations.id = inputs.conversation_id
             join agent_jobs jobs on jobs.id = inputs.job_id
             where inputs.id = $1
               and inputs.job_id = $2
               and inputs.project_id = $3
               and inputs.claimed_by_runtime_id = $4
             for update of inputs",
            &[&command_id, &job_id, &claims.project_id, &runtime_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load active-turn input: {error}")))?;
    let Some(existing) = existing else {
        return Err(send_intent_error(
            StatusCode::NOT_FOUND,
            "active-turn input command was not found for this runtime",
            "agent_job_input_not_found",
            None,
        ));
    };
    let target_turn_id: String = existing.get("target_turn_id");
    if next_status == "applied" && codex_turn_id.as_deref() != Some(target_turn_id.as_str()) {
        return Err(send_intent_error(
            StatusCode::CONFLICT,
            "applied acknowledgement does not match the command's active turn",
            "agent_job_input_turn_conflict",
            Some(json!({ "targetTurnId": target_turn_id })),
        ));
    }
    let existing_status: String = existing.get("status");
    let late_applied_ack = permits_late_applied_ack(
        &existing_status,
        next_status,
        existing.get::<_, Option<String>>("rejected_by").as_deref(),
        existing
            .get::<_, Option<DateTime<Utc>>>("claimed_at")
            .is_some(),
        existing.get("claimed_by_runtime_id"),
        runtime_id,
        existing.get("lease_attempt"),
        existing.get("current_lease_attempt"),
    );
    if matches!(existing_status.as_str(), "applied" | "rejected") {
        if existing_status != next_status && !late_applied_ack {
            return Err(send_intent_error(
                StatusCode::CONFLICT,
                "active-turn input was already acknowledged with a different outcome",
                "agent_job_input_ack_conflict",
                Some(json!({ "state": existing_status })),
            ));
        }
        if !late_applied_ack {
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize input acknowledgement: {error}"))
            })?;
            return Ok(Json(AgentJobInputAckResponse {
                ok: true,
                state: existing_status,
            }));
        }
    }
    if existing_status != "delivering" && !late_applied_ack {
        return Err(send_intent_error(
            StatusCode::CONFLICT,
            "active-turn input has not been claimed for delivery",
            "agent_job_input_ack_conflict",
            Some(json!({ "state": existing_status })),
        ));
    }

    let row = transaction
        .query_one(
            "update agent_job_inputs
             set status = $2,
                 applied_at = case when $2 = 'applied' then now() else applied_at end,
                 rejected_at = case when $2 = 'rejected' then now() else null end,
                 rejected_by = case when $2 = 'rejected' then 'runtime' else null end,
                 codex_turn_id = $3,
                 error_message = case when $2 = 'rejected' then $4 else null end,
                 updated_at = now()
             where id = $1
             returning id, job_id, run_id, message_id, sequence, status, request",
            &[&command_id, &next_status, &codex_turn_id, &error_message],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to acknowledge active-turn input: {error}"))
        })?;
    let command = stored_job_input(&row);
    let updated_message = match command.message_id {
        Some(message_id) => {
            set_send_intent_message_state(
                &transaction,
                &message_id,
                &command.status,
                error_message.as_deref(),
            )
            .await?
        }
        None => None,
    };
    let project_id: Uuid = existing.get("project_id");
    let conversation_id: Uuid = existing.get("conversation_id");
    let session_id: Option<Uuid> = existing.get("session_id");
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit active-turn input acknowledgement: {error}"
        ))
    })?;

    if let Some(message) = updated_message.as_ref() {
        publish_conversation_message_event(&state.events, message);
    }

    publish_job_input_state_event(
        &state.events,
        project_id,
        session_id,
        conversation_id,
        command.run_id,
        command.id,
        command.job_id,
        command.message_id,
        command.sequence,
        &command.status,
        error_message.as_deref(),
        false,
    );
    Ok(Json(AgentJobInputAckResponse {
        ok: true,
        state: command.status,
    }))
}

/// Called while the completion transaction still owns the job row. Commands
/// not yet acknowledged by the runtime deterministically become rejected. A
/// late `applied` acknowledgement may still override this system rejection:
/// Codex can accept the input immediately before the completion transaction.
pub(crate) async fn reject_unclaimed_inputs_for_completed_job(
    transaction: &tokio_postgres::Transaction<'_>,
    job_id: &Uuid,
) -> Result<Vec<JobInputStateUpdate>, (StatusCode, Json<ApiError>)> {
    reject_unacknowledged_inputs_for_job(transaction, job_id, COMPLETION_REJECTION).await
}

pub(crate) async fn reject_unacknowledged_inputs_for_job(
    transaction: &tokio_postgres::Transaction<'_>,
    job_id: &Uuid,
    reason: &str,
) -> Result<Vec<JobInputStateUpdate>, (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .query(
            "update agent_job_inputs
             set status = 'rejected',
                 rejected_at = now(),
                 rejected_by = 'controller',
                 error_message = $2,
                 updated_at = now()
             where job_id = $1 and status in ('pending', 'delivering')
             returning id,
                       project_id,
                       conversation_id,
                       job_id,
                       run_id,
                       message_id,
                       sequence,
                       status",
            &[job_id, &reason],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to reject unacknowledged active-turn inputs: {error}"
            ))
        })?;

    let mut updates = Vec::with_capacity(rows.len());
    for row in rows {
        let message_id: Option<Uuid> = row.get("message_id");
        let message = match message_id {
            Some(message_id) => {
                set_send_intent_message_state(transaction, &message_id, "rejected", Some(reason))
                    .await?
            }
            None => None,
        };
        let conversation_id: Uuid = row.get("conversation_id");
        let session_id = transaction
            .query_opt(
                "select session_id from conversations where id = $1",
                &[&conversation_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load job-input conversation: {error}"))
            })?
            .and_then(|row| row.get("session_id"));
        updates.push(JobInputStateUpdate {
            command_id: row.get("id"),
            project_id: row.get("project_id"),
            conversation_id,
            session_id,
            job_id: row.get("job_id"),
            run_id: row.get("run_id"),
            message_id,
            sequence: row.get("sequence"),
            state: row.get("status"),
            error_message: Some(reason.to_string()),
            message,
        });
    }
    Ok(updates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_handles_are_normalized_ordered_and_deduplicated() {
        let handles = normalize_target_agent_handles(&[
            " @Octo ".to_string(),
            "worker".to_string(),
            "octo".to_string(),
        ])
        .expect("valid handles");
        assert_eq!(handles, vec!["octo", "worker"]);
    }

    #[test]
    fn active_turn_input_capability_accepts_typed_and_legacy_spellings() {
        assert!(runtime_supports_active_turn_input(&json!({
            "activeTurnInput": true
        })));
        assert!(runtime_supports_active_turn_input(&json!({
            "conversations": { "active_turn_input": true }
        })));
        assert!(!runtime_supports_active_turn_input(&json!({
            "activeTurnInput": false
        })));
        assert!(!runtime_supports_active_turn_input(&json!({})));
    }

    #[test]
    fn steer_idempotency_envelope_is_stable_after_handle_normalization() {
        let message = json!({ "promptText": "please also check tests" });
        let first = normalized_steer_envelope(
            &message,
            None,
            &normalize_target_agent_handles(&["@Octo".to_string()]).unwrap(),
        );
        let retry = normalized_steer_envelope(
            &message,
            None,
            &normalize_target_agent_handles(&[" octo ".to_string()]).unwrap(),
        );
        assert_eq!(first, retry);
        assert!(idempotency_envelope_matches(&first, &retry));
        assert!(!idempotency_envelope_matches(
            &first,
            &json!({ "mode": "steer", "message": { "promptText": "different" } })
        ));
    }

    fn active_job(id: Uuid, handle: &str) -> ActiveJobTarget {
        ActiveJobTarget {
            id,
            run_id: None,
            prompt_id: None,
            lease_attempt: 1,
            runtime_id: Uuid::new_v4(),
            turn_id: "turn-1".to_string(),
            payload: json!({ "metadata": { "agent": { "handle": handle } } }),
            capabilities: json!({ "activeTurnInput": true }),
        }
    }

    #[test]
    fn expected_job_conflict_is_distinct_from_no_matching_handle() {
        let active_id = Uuid::new_v4();
        let stale_id = Uuid::new_v4();
        let jobs = vec![active_job(active_id, "octo")];
        assert_eq!(
            select_active_job(&jobs, Some(stale_id), &[]),
            ActiveJobSelection::ExpectedConflict(vec![active_id])
        );
        assert_eq!(
            select_active_job(&jobs, Some(active_id), &["other".to_string()]),
            ActiveJobSelection::None
        );
    }

    #[test]
    fn steer_requires_observed_job_id_and_rejects_a_to_b_rollover() {
        assert!(require_expected_active_job_id(None).is_err());
        let observed_a = Uuid::new_v4();
        let now_active_b = Uuid::new_v4();
        let jobs = vec![active_job(now_active_b, "octo")];
        assert_eq!(
            select_active_job(&jobs, Some(observed_a), &["octo".to_string()]),
            ActiveJobSelection::ExpectedConflict(vec![now_active_b])
        );
    }

    #[test]
    fn multiple_matching_active_jobs_require_an_unambiguous_target() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let jobs = vec![active_job(first, "octo"), active_job(second, "worker")];
        assert_eq!(
            select_active_job(&jobs, None, &[]),
            ActiveJobSelection::Ambiguous(vec![first, second])
        );
        assert_eq!(
            select_active_job(&jobs, None, &["worker".to_string()]),
            ActiveJobSelection::Target(1)
        );
    }

    #[test]
    fn command_claim_is_ordered_and_bound_to_the_current_lease_attempt() {
        assert!(CLAIM_NEXT_AGENT_JOB_INPUT_SQL.contains("order by sequence asc"));
        assert!(CLAIM_NEXT_AGENT_JOB_INPUT_SQL.contains("lease_attempt = $3"));
        assert!(CLAIM_NEXT_AGENT_JOB_INPUT_SQL.contains("target_turn_id = $4"));
        assert!(CLAIM_NEXT_AGENT_JOB_INPUT_SQL.contains("for update skip locked"));
        assert!(CLAIM_NEXT_AGENT_JOB_INPUT_SQL.contains("status = 'delivering' and"));
    }

    #[test]
    fn completion_race_requires_the_same_claiming_runtime_and_lease() {
        let runtime_id = Uuid::new_v4();
        assert!(permits_late_applied_ack(
            "rejected",
            "applied",
            Some("controller"),
            true,
            Some(runtime_id),
            runtime_id,
            3,
            3,
        ));
        assert!(!permits_late_applied_ack(
            "rejected",
            "applied",
            Some("controller"),
            false,
            Some(runtime_id),
            runtime_id,
            3,
            3,
        ));
        assert!(!permits_late_applied_ack(
            "rejected",
            "applied",
            Some("controller"),
            true,
            Some(runtime_id),
            runtime_id,
            3,
            4,
        ));
        assert!(!permits_late_applied_ack(
            "delivering",
            "applied",
            None,
            true,
            Some(runtime_id),
            runtime_id,
            3,
            3,
        ));
        assert!(!permits_late_applied_ack(
            "rejected",
            "applied",
            Some("runtime"),
            true,
            Some(runtime_id),
            runtime_id,
            3,
            3,
        ));
    }

    #[test]
    fn normalized_response_keeps_delivery_state_separate_from_applied_mode() {
        let command = StoredJobInput {
            id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            run_id: Some(Uuid::new_v4()),
            message_id: Some(Uuid::new_v4()),
            sequence: 2,
            status: "pending".to_string(),
            request: json!({}),
        };
        let response = SendIntentResponse::steer(&command, "client-1".to_string(), false);
        assert_eq!(response.requested_mode, "steer");
        assert_eq!(response.applied_mode, "steer");
        assert_eq!(response.state, "pending");
        assert_eq!(response.sequence, Some(2));
    }

    #[tokio::test]
    async fn command_state_updates_publish_the_updated_message_upsert() {
        let events = EventHub::new();
        let mut receiver = events.subscribe();
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let command_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let message_id = Uuid::new_v4();
        let message = ConversationMessageRow {
            id: message_id,
            conversation_id,
            project_id,
            session_id: None,
            created_by: Some(Uuid::new_v4()),
            prompt_id: None,
            run_id: None,
            role: "user".to_string(),
            content: "steer this turn".to_string(),
            metadata: json!({
                "sendIntent": {
                    "commandId": command_id,
                    "state": "rejected",
                    "errorMessage": "turn ended"
                }
            }),
            created_at: Utc::now(),
        };
        let update = JobInputStateUpdate {
            command_id,
            project_id,
            conversation_id,
            session_id: None,
            job_id,
            run_id: None,
            message_id: Some(message_id),
            sequence: 1,
            state: "rejected".to_string(),
            error_message: Some("turn ended".to_string()),
            message: Some(message),
        };

        publish_job_input_state_updates_to_hub(&events, &[update]);

        let message_event = receiver.recv().await.expect("message upsert event");
        assert_eq!(message_event.kind, "conversation.message_created");
        assert_eq!(message_event.data["id"], json!(message_id));
        assert_eq!(
            message_event.data["metadata"]["sendIntent"]["state"],
            "rejected"
        );

        let command_event = receiver.recv().await.expect("command state event");
        assert_eq!(command_event.kind, "agent.jobInput");
        assert_eq!(command_event.data["commandId"], json!(command_id));
        assert_eq!(command_event.data["state"], "rejected");
    }
}
