use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::time::Duration;

use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::sync::Mutex as TokioMutex;
use tokio::time::MissedTickBehavior;
use tokio_postgres::types::Json as PgJson;
use tracing::warn;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session, RequestContext};
use crate::conversations::{
    build_dispatch_request_from_conversation, ensure_conversation_access,
    inject_conversation_metadata, load_conversation_record, ConversationPromptBody,
};
use crate::dispatch::{
    ensure_project_prompt_access, normalize_dispatch_request, process_dispatch_prompt,
    DispatchPromptResponse,
};
use crate::state::ControllerEvent;
use crate::{bad_request, ensure_project_access, internal_error, not_found, ApiError, AppState};

const SEND_QUEUE_CLAIM_RECLAIM_AFTER: Duration = Duration::from_secs(10 * 60);
const SEND_QUEUE_RECOVERY_SWEEP_INTERVAL: Duration = Duration::from_secs(5);
const SEND_QUEUE_RECOVERY_BATCH_SIZE: i64 = 20;
const SEND_QUEUE_RETRY_GRACE: Duration = Duration::from_millis(100);

/// One expiry timer per conversation is enough inside a controller process.
/// Cross-process duplicate recovery remains fenced by the database advisory
/// claim lock.
static SCHEDULED_SEND_QUEUE_RETRIES: Lazy<TokioMutex<HashMap<Uuid, DateTime<Utc>>>> =
    Lazy::new(|| TokioMutex::new(HashMap::new()));

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/:conversation_id/send-queue",
            get(list_send_queue).post(enqueue_send_queue_entry),
        )
        .route(
            "/conversations/:conversation_id/send-queue/:entry_id",
            delete(cancel_send_queue_entry),
        )
        .route(
            "/conversations/:conversation_id/send-queue/:entry_id/dispatch",
            post(dispatch_send_queue_entry_now),
        )
        .route(
            "/conversations/:conversation_id/send-queue/:entry_id/reorder",
            post(reorder_send_queue_entry),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendQueueEnqueueBody {
    pub(crate) message: JsonValue,
    #[serde(default)]
    pub(crate) client_send_id: Option<String>,
    #[serde(default)]
    pub(crate) target_agent_handles: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendQueueReorderBody {
    #[serde(default)]
    before_entry_id: Option<String>,
}

fn normalize_agent_handle(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('@').trim().to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 20 {
        return None;
    }
    if !trimmed
        .chars()
        .next()
        .map(|ch| ch.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(trimmed)
}

fn normalize_handles(handles: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    handles
        .iter()
        .filter_map(|handle| normalize_agent_handle(handle))
        .filter(|handle| seen.insert(handle.clone()))
        .collect()
}

/// Derive the queue lane from the same stored agent-selection envelope that
/// dispatch consumes. Mentions take precedence over the active roster; a
/// plain prompt targets the default Octo lane. The client-provided lane is
/// presentation data only and can never override this canonical value.
fn canonical_target_handles(message: &ConversationPromptBody) -> Vec<String> {
    let selection = message
        .metadata
        .as_ref()
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("agentSelection"))
        .and_then(JsonValue::as_object);
    let handles_for = |key: &str| -> Vec<String> {
        selection
            .and_then(|value| value.get(key))
            .and_then(JsonValue::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .filter_map(normalize_agent_handle)
                    .collect()
            })
            .unwrap_or_default()
    };
    let mentions = handles_for("mentions");
    let active = handles_for("active");
    let mut handles = normalize_handles(if mentions.is_empty() {
        &active
    } else {
        &mentions
    });
    if handles.is_empty() {
        handles.push("octo".to_string());
    }
    handles
}

fn canonical_target_handles_from_value(
    message: &JsonValue,
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let message: ConversationPromptBody = serde_json::from_value(message.clone())
        .map_err(|error| bad_request(format!("message is not a valid prompt body: {error}")))?;
    Ok(canonical_target_handles(&message))
}

fn normalize_client_send_id(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(bad_request("clientSendId must not be empty"));
    }
    if normalized.chars().count() > 200 {
        return Err(bad_request("clientSendId must be at most 200 characters"));
    }
    Ok(normalized.to_string())
}

fn entry_row_to_json(row: &tokio_postgres::Row) -> JsonValue {
    let request = row.get::<_, PgJson<JsonValue>>("request").0;
    let target_agent_handles = canonical_target_handles_from_value(&request).unwrap_or_default();
    json!({
        "id": row.get::<_, Uuid>("id"),
        "conversationId": row.get::<_, Uuid>("conversation_id"),
        "clientSendId": row.get::<_, Option<String>>("client_send_id"),
        "status": row.get::<_, String>("status"),
        "targetAgentHandles": target_agent_handles,
        "message": request,
        "errorMessage": row.get::<_, Option<String>>("error_message"),
        "queuePosition": row.get::<_, i64>("queue_position"),
        "createdAt": row.get::<_, chrono::DateTime<chrono::Utc>>("created_at"),
        "dispatchedAt": row.get::<_, Option<chrono::DateTime<chrono::Utc>>>("dispatched_at"),
    })
}

const ENTRY_COLUMNS: &str = "id, conversation_id, user_id, client_send_id, status, \
                             target_agent_handles, request, error_message, created_at, \
                             dispatched_at, queue_position";

fn publish_send_queue_event(
    state: &AppState,
    project_id: Uuid,
    session_id: Option<Uuid>,
    conversation_id: Uuid,
    target_user_id: Option<Uuid>,
    action: &str,
    entry: JsonValue,
) {
    let Some(target_user_id) = target_user_id else {
        // Legacy service-authored entries have no human audience. Never turn
        // an absent owner into a project-wide leak of a private prompt.
        warn!(%conversation_id, action, "suppressing ownerless send-queue event");
        return;
    };
    let session_channel = session_id.map(|value| format!("session:{value}"));
    let conversation_channel = format!("conversation:{conversation_id}");
    let mut channels = Vec::new();
    if let Some(channel) = session_channel.as_ref() {
        channels.push(channel.clone());
    }
    channels.push(conversation_channel.clone());
    state.events.publish(ControllerEvent {
        kind: "conversation.sendQueue".to_string(),
        project_id: Some(project_id),
        session_id,
        conversation_id: Some(conversation_id),
        run_id: None,
        job_id: None,
        channel: session_channel.or(Some(conversation_channel)),
        channels,
        target_user_id: Some(target_user_id),
        data: json!({
            "action": action,
            "entry": entry,
        }),
        timestamp: Utc::now(),
    });
}

struct ConversationAccess {
    project_id: Uuid,
    session_id: Option<Uuid>,
}

async fn authorize_conversation(
    state: &AppState,
    headers: &HeaderMap,
    conversation_id_raw: &str,
    require_prompt_access: bool,
) -> Result<(RequestContext, Uuid, ConversationAccess), (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    require_user_session(&context)?;
    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;

    let access = authorize_conversation_with_context(
        state,
        &context,
        conversation_id,
        require_prompt_access,
    )
    .await?;

    Ok((context, conversation_id, access))
}

async fn authorize_conversation_with_context(
    state: &AppState,
    context: &RequestContext,
    conversation_id: Uuid,
    require_prompt_access: bool,
) -> Result<ConversationAccess, (StatusCode, Json<ApiError>)> {
    require_user_session(context)?;

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
    ensure_project_access(&transaction, &project, &context, conversation.session_id).await?;
    ensure_conversation_access(&transaction, &conversation, &context).await?;
    if require_prompt_access {
        // Queued messages become prompt dispatches later; enforce the same
        // read-only-member restriction the direct dispatch path applies.
        ensure_project_prompt_access(&transaction, &project, &context, conversation.session_id)
            .await?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize access check: {error}")))?;

    Ok(ConversationAccess {
        project_id: conversation.project_id,
        session_id: conversation.session_id,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendQueueEnqueueOutcome {
    pub(crate) entry: JsonValue,
    pub(crate) deduplicated: bool,
}

/// Enqueue a validated conversation prompt under an already-authenticated
/// human context. This is the controller-internal entry point used by typed
/// send-intent routing; it intentionally does not perform an HTTP self-call.
pub(crate) async fn enqueue_prompt_with_context(
    state: &AppState,
    context: &RequestContext,
    conversation_id: Uuid,
    client_send_id: &str,
    message: JsonValue,
) -> Result<SendQueueEnqueueOutcome, (StatusCode, Json<ApiError>)> {
    let client_send_id = normalize_client_send_id(client_send_id)?;
    enqueue_prompt_with_optional_client_id(
        state,
        context,
        conversation_id,
        Some(client_send_id),
        message,
        None,
    )
    .await
}

async fn enqueue_prompt_with_optional_client_id(
    state: &AppState,
    context: &RequestContext,
    conversation_id: Uuid,
    client_send_id: Option<String>,
    message_value: JsonValue,
    supplied_target_agent_handles: Option<&[String]>,
) -> Result<SendQueueEnqueueOutcome, (StatusCode, Json<ApiError>)> {
    let owner_user_id = require_user_session(context)?;
    let access = authorize_conversation_with_context(state, context, conversation_id, true).await?;
    let message: ConversationPromptBody = serde_json::from_value(message_value.clone())
        .map_err(|error| bad_request(format!("message is not a valid prompt body: {error}")))?;
    if message.prompt_text.trim().is_empty() {
        return Err(bad_request("message promptText must not be empty"));
    }
    let handles = canonical_target_handles(&message);
    if let Some(supplied) = supplied_target_agent_handles.filter(|values| !values.is_empty()) {
        if normalize_handles(supplied) != handles {
            return Err(bad_request(
                "targetAgentHandles must match message.metadata.agentSelection",
            ));
        }
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
    let request_param = PgJson(&message_value);

    if let Some(client_send_id) = client_send_id.as_deref() {
        let lock_key =
            format!("send-queue-idempotency:{conversation_id}:{owner_user_id}:{client_send_id}");
        transaction
            .query_one(
                "select pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&lock_key],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to lock queued message idempotency key: {error}"
                ))
            })?;
        if let Some(row) = transaction
            .query_opt(
                &format!(
                    "select {ENTRY_COLUMNS}
                     from conversation_send_queue
                     where conversation_id = $1
                       and user_id = $2
                       and client_send_id = $3"
                ),
                &[&conversation_id, &owner_user_id, &client_send_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load idempotent queued message: {error}"))
            })?
        {
            let existing_request = row.get::<_, PgJson<JsonValue>>("request").0;
            let existing_handles = canonical_target_handles_from_value(&existing_request)?;
            if existing_request != message_value || existing_handles != handles {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::new(
                        "clientSendId is already bound to a different queued message",
                    )),
                ));
            }
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize queued message lookup: {error}"))
            })?;
            // A retry can also recover an enqueue whose first response was
            // lost before its best-effort drain was scheduled.
            spawn_send_queue_drain(state.clone(), conversation_id);
            return Ok(SendQueueEnqueueOutcome {
                entry: entry_row_to_json(&row),
                deduplicated: true,
            });
        }
    }

    let row = transaction
        .query_one(
            &format!(
                "insert into conversation_send_queue (
                     project_id, conversation_id, session_id, user_id,
                     client_send_id, target_agent_handles, request
                 ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
                 returning {ENTRY_COLUMNS}"
            ),
            &[
                &access.project_id,
                &conversation_id,
                &access.session_id,
                &owner_user_id,
                &client_send_id,
                &handles,
                &request_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to enqueue message: {error}")))?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit queued message: {error}")))?;

    let entry = entry_row_to_json(&row);
    publish_send_queue_event(
        state,
        access.project_id,
        access.session_id,
        conversation_id,
        Some(owner_user_id),
        "enqueued",
        entry.clone(),
    );
    // Queue means "send after the lane is free", including the common case
    // where it is already free. Waking the drain here prevents an explicit
    // idle queue action from waiting forever for a later completion event.
    spawn_send_queue_drain(state.clone(), conversation_id);

    Ok(SendQueueEnqueueOutcome {
        entry,
        deduplicated: false,
    })
}

pub(crate) async fn enqueue_send_queue_entry(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<SendQueueEnqueueBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;
    let client_send_id = body
        .client_send_id
        .as_deref()
        .map(normalize_client_send_id)
        .transpose()?;
    let outcome = enqueue_prompt_with_optional_client_id(
        &state,
        &context,
        conversation_id,
        client_send_id,
        body.message,
        Some(&body.target_agent_handles),
    )
    .await?;
    Ok(Json(outcome.entry))
}

pub(crate) async fn list_send_queue(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
) -> Result<Json<Vec<JsonValue>>, (StatusCode, Json<ApiError>)> {
    let (context, conversation_id, _access) =
        authorize_conversation(&state, &headers, conversation_id_raw.as_str(), false).await?;
    let owner_user_id = require_user_session(&context)?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let rows = connection
        .query(
            &format!(
                "select {ENTRY_COLUMNS}
                 from conversation_send_queue
                 where conversation_id = $1
                   and user_id = $2
                   and status in ('queued','failed')
                 order by queue_position asc, id asc"
            ),
            &[&conversation_id, &owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list send queue: {error}")))?;

    Ok(Json(rows.iter().map(entry_row_to_json).collect()))
}

fn move_queue_entry_before(
    current_ids: &[Uuid],
    entry_id: Uuid,
    before_entry_id: Option<Uuid>,
) -> Option<Vec<Uuid>> {
    let entry_index = current_ids
        .iter()
        .position(|candidate| *candidate == entry_id)?;
    if before_entry_id == Some(entry_id) {
        return Some(current_ids.to_vec());
    }

    let mut reordered = current_ids.to_vec();
    reordered.remove(entry_index);
    let insert_at = match before_entry_id {
        Some(before_entry_id) => reordered
            .iter()
            .position(|candidate| *candidate == before_entry_id)?,
        None => reordered.len(),
    };
    reordered.insert(insert_at, entry_id);
    Some(reordered)
}

#[derive(Debug)]
struct SendQueueReorderOutcome {
    changed: bool,
    entry: JsonValue,
    entries: Vec<JsonValue>,
}

async fn reorder_owned_send_queue_entry(
    state: &AppState,
    conversation_id: Uuid,
    owner_user_id: Uuid,
    entry_id: Uuid,
    before_entry_id: Option<Uuid>,
) -> Result<SendQueueReorderOutcome, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start queue reorder: {error}")))?;

    // Serialize with the drain's claim transaction. Enqueues intentionally do
    // not take this lock: their sequence-backed positions append after every
    // existing slot and therefore cannot invalidate the permutation below.
    let lock_key = format!("send-queue-drain:{conversation_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to acquire queue reorder lock: {error}"))
        })?;

    // Lock only this owner's mutable entries. Reordering permutes their
    // existing global slots, preserving every other owner's relative place
    // and any slot already held by a claimed entry.
    let rows = transaction
        .query(
            "select id, queue_position
             from conversation_send_queue
             where conversation_id = $1
               and user_id = $2
               and status in ('queued','failed')
             order by queue_position asc, id asc
             for update",
            &[&conversation_id, &owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock send queue: {error}")))?;
    let current_ids = rows
        .iter()
        .map(|row| row.get::<_, Uuid>("id"))
        .collect::<Vec<_>>();
    let Some(reordered_ids) = move_queue_entry_before(&current_ids, entry_id, before_entry_id)
    else {
        // Use the same response for an absent target, a different owner's
        // entry, an immutable entry, and an inaccessible anchor.
        return Err(not_found("queued message not found"));
    };
    let changed = reordered_ids != current_ids;

    if changed {
        let queue_positions = rows
            .iter()
            .map(|row| row.get::<_, i64>("queue_position"))
            .collect::<Vec<_>>();
        let updated = transaction
            .execute(
                "update conversation_send_queue as queue
                 set queue_position = ordering.queue_position,
                     updated_at = now()
                 from unnest($1::uuid[], $2::bigint[])
                      as ordering(id, queue_position)
                 where queue.id = ordering.id
                   and queue.conversation_id = $3
                   and queue.user_id = $4
                   and queue.status in ('queued','failed')",
                &[
                    &reordered_ids,
                    &queue_positions,
                    &conversation_id,
                    &owner_user_id,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to reorder send queue: {error}")))?;
        if updated != rows.len() as u64 {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::new("send queue changed during reorder")),
            ));
        }
    }

    let rows = transaction
        .query(
            &format!(
                "select {ENTRY_COLUMNS}
                 from conversation_send_queue
                 where conversation_id = $1
                   and user_id = $2
                   and status in ('queued','failed')
                 order by queue_position asc, id asc"
            ),
            &[&conversation_id, &owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load reordered send queue: {error}")))?;
    let entry = rows
        .iter()
        .find(|row| row.get::<_, Uuid>("id") == entry_id)
        .map(entry_row_to_json)
        .ok_or_else(|| internal_error("reordered queued message disappeared"))?;
    let entries = rows.iter().map(entry_row_to_json).collect();

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit queue reorder: {error}")))?;
    Ok(SendQueueReorderOutcome {
        changed,
        entry,
        entries,
    })
}

async fn reorder_send_queue_entry(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath((conversation_id_raw, entry_id_raw)): AxumPath<(String, String)>,
    axum::Json(body): axum::Json<SendQueueReorderBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let (context, conversation_id, access) =
        authorize_conversation(&state, &headers, conversation_id_raw.as_str(), true).await?;
    let entry_id = Uuid::from_str(entry_id_raw.trim())
        .map_err(|_| bad_request("entryId must be a valid UUID"))?;
    let before_entry_id = body
        .before_entry_id
        .as_deref()
        .map(str::trim)
        .map(Uuid::from_str)
        .transpose()
        .map_err(|_| bad_request("beforeEntryId must be a valid UUID or null"))?;
    let owner_user_id = require_user_session(&context)?;
    let SendQueueReorderOutcome {
        changed,
        entry,
        entries,
    } = reorder_owned_send_queue_entry(
        &state,
        conversation_id,
        owner_user_id,
        entry_id,
        before_entry_id,
    )
    .await?;

    if changed {
        publish_send_queue_event(
            &state,
            access.project_id,
            access.session_id,
            conversation_id,
            Some(owner_user_id),
            "reordered",
            entry,
        );
        spawn_send_queue_drain(state.clone(), conversation_id);
    }

    Ok(Json(json!({
        "ok": true,
        "changed": changed,
        "entries": entries,
    })))
}

pub(crate) async fn cancel_send_queue_entry(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath((conversation_id_raw, entry_id_raw)): AxumPath<(String, String)>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let (context, conversation_id, access) =
        authorize_conversation(&state, &headers, conversation_id_raw.as_str(), true).await?;
    let entry_id = Uuid::from_str(entry_id_raw.trim())
        .map_err(|_| bad_request("entryId must be a valid UUID"))?;
    let actor_user_id = require_user_session(&context)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            &format!(
                "update conversation_send_queue
                 set status = 'canceled', updated_at = now()
                 where id = $1
                   and conversation_id = $2
                   and status in ('queued','failed')
                   and user_id = $3
                 returning {ENTRY_COLUMNS}"
            ),
            &[&entry_id, &conversation_id, &actor_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to cancel queued message: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("queued message not found"));
    };

    let entry = entry_row_to_json(&row);
    publish_send_queue_event(
        &state,
        access.project_id,
        access.session_id,
        conversation_id,
        Some(actor_user_id),
        "canceled",
        entry.clone(),
    );

    Ok(Json(json!({ "ok": true, "entry": entry })))
}

pub(crate) async fn dispatch_send_queue_entry_now(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath((conversation_id_raw, entry_id_raw)): AxumPath<(String, String)>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let (context, conversation_id, access) =
        authorize_conversation(&state, &headers, conversation_id_raw.as_str(), true).await?;
    let entry_id = Uuid::from_str(entry_id_raw.trim())
        .map_err(|_| bad_request("entryId must be a valid UUID"))?;
    let actor_user_id = require_user_session(&context)?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            &format!(
                "update conversation_send_queue
                 set status = 'dispatched', dispatched_at = now(), updated_at = now()
                 where id = $1
                   and conversation_id = $2
                   and status in ('queued','failed')
                   and user_id = $3
                 returning {ENTRY_COLUMNS}"
            ),
            &[&entry_id, &conversation_id, &actor_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to claim queued message: {error}")))?;
    let Some(row) = row else {
        // The claim can lose a race against the background drain (e.g. the
        // interrupt that preceded this send-now already freed the targets).
        // Treat an entry the drain already dispatched as success, not 404.
        let already = connection
            .query_opt(
                "select status from conversation_send_queue
                 where id = $1 and conversation_id = $2
                   and user_id = $3",
                &[&entry_id, &conversation_id, &actor_user_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load queued message: {error}")))?;
        if already
            .map(|row| {
                matches!(
                    row.get::<_, String>("status").as_str(),
                    "dispatched" | "recorded"
                )
            })
            .unwrap_or(false)
        {
            return Ok(Json(json!({ "ok": true, "alreadyDispatched": true })));
        }
        return Err(not_found("queued message not found"));
    };
    let message = row.get::<_, PgJson<JsonValue>>("request").0;
    let claim = ClaimedSendQueueEntry {
        project_id: access.project_id,
        session_id: access.session_id,
        entry_id,
        user_id: Some(actor_user_id),
        message: message.clone(),
        entry: entry_row_to_json(&row),
    };
    drop(connection);

    match dispatch_stored_message(
        &state,
        &context,
        access.project_id,
        conversation_id,
        access.session_id,
        entry_id,
        message,
        true,
    )
    .await
    {
        Ok(response) => {
            record_dispatch_outcome(&state, entry_id, &response).await;
            let entry = entry_row_to_json(&row);
            publish_send_queue_event(
                &state,
                access.project_id,
                access.session_id,
                conversation_id,
                Some(actor_user_id),
                "dispatched",
                entry,
            );
            let response = serde_json::to_value(&response).map_err(|error| {
                internal_error(format!("failed to serialize response: {error}"))
            })?;
            Ok(Json(response))
        }
        Err((StatusCode::CONFLICT, Json(api_error)))
            if api_error.code.as_deref() == Some("dispatch_lane_busy") =>
        {
            restore_queue_claim_after_busy(&state, &claim).await?;
            Ok(Json(json!({ "ok": false, "queued": true })))
        }
        Err(error) => {
            mark_entry_failed(&state, entry_id, &error).await;
            let connection = state.pool.get().await.ok();
            if let Some(connection) = connection {
                if let Ok(Some(row)) = connection
                    .query_opt(
                        &format!(
                            "select {ENTRY_COLUMNS} from conversation_send_queue where id = $1"
                        ),
                        &[&entry_id],
                    )
                    .await
                {
                    publish_send_queue_event(
                        &state,
                        access.project_id,
                        access.session_id,
                        conversation_id,
                        Some(actor_user_id),
                        "failed",
                        entry_row_to_json(&row),
                    );
                }
            }
            Err(error)
        }
    }
}

/// Stamp the run created by a successful dispatch, or mark a human-only turn
/// recorded. Either outcome distinguishes a completed claim from one stranded
/// by a crash (see the reclaim pass in the drain).
async fn record_dispatch_outcome(
    state: &AppState,
    entry_id: Uuid,
    response: &DispatchPromptResponse,
) {
    let Ok(connection) = state.pool.get().await else {
        warn!(entry_id = %entry_id, "failed to get connection to record dispatched run");
        return;
    };
    let result = if let Some(run_id) = response.run_id {
        connection
            .execute(
                "update conversation_send_queue
                 set dispatched_run_id = $2, updated_at = now()
                 where id = $1",
                &[&entry_id, &run_id],
            )
            .await
    } else if response.status == "recorded" {
        connection
            .execute(
                "update conversation_send_queue
                 set status = 'recorded', updated_at = now()
                 where id = $1",
                &[&entry_id],
            )
            .await
    } else {
        warn!(entry_id = %entry_id, status = %response.status, "dispatch response had no run id");
        return;
    };
    if let Err(db_error) = result {
        warn!(entry_id = %entry_id, error = %db_error, "failed to record dispatched run");
    }
}

async fn mark_entry_failed(state: &AppState, entry_id: Uuid, error: &(StatusCode, Json<ApiError>)) {
    let Ok(mut connection) = state.pool.get().await else {
        warn!(entry_id = %entry_id, "failed to get connection to mark send-queue entry failed");
        return;
    };
    mark_entry_failed_with(&mut *connection, entry_id, error).await;
}

async fn mark_entry_failed_with<C>(
    connection: &mut C,
    entry_id: Uuid,
    error: &(StatusCode, Json<ApiError>),
) where
    C: tokio_postgres::GenericClient + Send,
{
    let (status, Json(api_error)) = error;
    let message = format!("{} ({})", api_error.message, status.as_u16());
    if let Err(db_error) = connection
        .execute(
            "update conversation_send_queue
             set status = 'failed', error_message = $2, updated_at = now()
             where id = $1",
            &[&entry_id, &message],
        )
        .await
    {
        warn!(entry_id = %entry_id, error = %db_error, "failed to mark send-queue entry failed");
    }
}

fn stamp_queue_dispatch_idempotency(body: &mut ConversationPromptBody, queue_entry_id: Uuid) {
    // Queue status is recorded after dispatch commits. If the controller
    // crashes in that window, the reclaim pass retries this entry; preserve an
    // existing interactive message id or derive one from the immutable queue
    // id so that retry returns the existing run instead of duplicating a turn.
    let mut metadata = match body.metadata.take() {
        Some(JsonValue::Object(map)) => JsonValue::Object(map),
        _ => json!({}),
    };
    if crate::conversations::extract_client_message_id_from_metadata(&metadata).is_none() {
        metadata
            .as_object_mut()
            .unwrap_or_else(|| unreachable!())
            .insert(
                "clientMessageId".to_string(),
                JsonValue::String(format!("send-queue:{queue_entry_id}")),
            );
    }
    body.metadata = Some(metadata);
}

async fn dispatch_stored_message(
    state: &AppState,
    context: &RequestContext,
    project_id: Uuid,
    conversation_id: Uuid,
    conversation_session_id: Option<Uuid>,
    queue_entry_id: Uuid,
    message: JsonValue,
    require_lane_idle: bool,
) -> Result<DispatchPromptResponse, (StatusCode, Json<ApiError>)> {
    let mut body: ConversationPromptBody = serde_json::from_value(message)
        .map_err(|error| bad_request(format!("queued message is invalid: {error}")))?;
    stamp_queue_dispatch_idempotency(&mut body, queue_entry_id);
    if body.session_id.is_none() {
        body.session_id = conversation_session_id.map(|value| value.to_string());
    }
    if body.runtime_id.is_some() && body.prefer_runtime.is_none() {
        body.prefer_runtime = Some(true);
    }
    let dispatch_request =
        build_dispatch_request_from_conversation(&project_id, Some(&conversation_id), body);
    let mut request = normalize_dispatch_request(dispatch_request)?;
    if request.conversation_id.is_none() {
        request.conversation_id = Some(conversation_id);
        request.conversation_raw = Some(conversation_id.to_string());
    }
    request.conversation_is_new = false;
    request.expected_lane_idle = require_lane_idle;
    request.dispatch_queue_entry_id = Some(queue_entry_id);
    if let Some(conversation_id) = request.conversation_id {
        inject_conversation_metadata(&mut request.metadata, &conversation_id);
    }
    process_dispatch_prompt(state, context, request).await
}

/// Spawn a best-effort background drain of the conversation's send queue.
/// Called when agent activity in a conversation ends (job completion or
/// cancellation) so queued follow-ups are delivered without client help.
pub(crate) fn spawn_send_queue_drain(state: AppState, conversation_id: Uuid) {
    tokio::spawn(async move {
        if let Err((status, Json(api_error))) = drain_send_queue(&state, conversation_id).await {
            warn!(
                conversation_id = %conversation_id,
                status = status.as_u16(),
                error = %api_error.message,
                "send-queue drain failed"
            );
        }
    });
}

/// Recover durable queue work after controller restarts. The first interval
/// tick runs immediately, batches are cursor-bounded, and the database claim
/// lock remains authoritative when multiple controller processes scan the same
/// rows.
pub(crate) fn spawn_send_queue_recovery_sweep(state: AppState) {
    tokio::spawn(async move {
        let mut cursor = None;
        let mut ticker = tokio::time::interval(SEND_QUEUE_RECOVERY_SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            match recover_send_queue_batch(&state, cursor).await {
                Ok(next_cursor) => cursor = next_cursor,
                Err((status, Json(api_error))) => {
                    warn!(
                        status = status.as_u16(),
                        error = %api_error.message,
                        "send-queue recovery sweep failed"
                    );
                }
            }
        }
    });
}

async fn recover_send_queue_batch(
    state: &AppState,
    cursor: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!("failed to get queue recovery connection: {error}"))
    })?;
    let rows = connection
        .query(
            "select conversation_id
             from conversation_send_queue
             where (
                 status = 'queued'
                 or (status = 'dispatched' and dispatched_run_id is null)
             )
               and ($1::uuid is null or conversation_id > $1)
             group by conversation_id
             order by conversation_id asc
             limit $2",
            &[&cursor, &SEND_QUEUE_RECOVERY_BATCH_SIZE],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load send-queue recovery batch: {error}"))
        })?;
    drop(connection);

    let exhausted = rows.len() < SEND_QUEUE_RECOVERY_BATCH_SIZE as usize;
    let conversation_ids = rows
        .iter()
        .map(|row| row.get::<_, Uuid>("conversation_id"))
        .collect::<Vec<_>>();
    for conversation_id in &conversation_ids {
        if let Err((status, Json(api_error))) = drain_send_queue(state, *conversation_id).await {
            warn!(
                %conversation_id,
                status = status.as_u16(),
                error = %api_error.message,
                "send-queue recovery drain failed"
            );
        }
    }

    Ok(if exhausted {
        None
    } else {
        conversation_ids.last().copied()
    })
}

async fn drain_send_queue(
    state: &AppState,
    conversation_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    drain_send_queue_with_reclaim_after(state, conversation_id, SEND_QUEUE_CLAIM_RECLAIM_AFTER)
        .await
}

async fn drain_send_queue_with_reclaim_after(
    state: &AppState,
    conversation_id: Uuid,
    reclaim_after: Duration,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    loop {
        let claim = match claim_next_send_queue_entry_with_reclaim_after(
            state,
            conversation_id,
            reclaim_after,
        )
        .await?
        {
            QueueClaimAttempt::Done => return Ok(()),
            QueueClaimAttempt::Retry => continue,
            QueueClaimAttempt::RetryAt(retry_at) => {
                schedule_send_queue_retry(state.clone(), conversation_id, retry_at, reclaim_after);
                return Ok(());
            }
            QueueClaimAttempt::Claimed(claim) => claim,
        };
        // Dispatch under the enqueuer's authority so role changes between
        // enqueue and delivery are re-validated (a viewer demotion must not
        // be bypassable by queueing). Service role only when the enqueuer had
        // no user identity.
        let context = RequestContext {
            user_id: claim.user_id,
            is_service_role: claim.user_id.is_none(),
            scoped_claims: None,
        };

        match dispatch_stored_message(
            state,
            &context,
            claim.project_id,
            conversation_id,
            claim.session_id,
            claim.entry_id,
            claim.message.clone(),
            true,
        )
        .await
        {
            Ok(response) => {
                record_dispatch_outcome(state, claim.entry_id, &response).await;
                publish_send_queue_event(
                    state,
                    claim.project_id,
                    claim.session_id,
                    conversation_id,
                    claim.user_id,
                    "dispatched",
                    claim.entry,
                );
            }
            Err((StatusCode::CONFLICT, Json(api_error)))
                if api_error.code.as_deref() == Some("dispatch_lane_busy") =>
            {
                restore_queue_claim_after_busy(state, &claim).await?;
                return Ok(());
            }
            Err(error) => {
                mark_entry_failed(state, claim.entry_id, &error).await;
                if let Ok(connection) = state.pool.get().await {
                    if let Ok(Some(updated)) = connection
                        .query_opt(
                            &format!(
                                "select {ENTRY_COLUMNS} from conversation_send_queue where id = $1"
                            ),
                            &[&claim.entry_id],
                        )
                        .await
                    {
                        let owner_user_id: Option<Uuid> = updated.get("user_id");
                        publish_send_queue_event(
                            state,
                            claim.project_id,
                            claim.session_id,
                            conversation_id,
                            owner_user_id,
                            "failed",
                            entry_row_to_json(&updated),
                        );
                    }
                }
            }
        }
    }
}

fn schedule_send_queue_retry(
    state: AppState,
    conversation_id: Uuid,
    retry_at: DateTime<Utc>,
    reclaim_after: Duration,
) {
    tokio::spawn(async move {
        let scheduled = {
            let mut retries = SCHEDULED_SEND_QUEUE_RETRIES.lock().await;
            if retries
                .get(&conversation_id)
                .is_some_and(|existing| existing <= &retry_at)
            {
                false
            } else {
                retries.insert(conversation_id, retry_at);
                true
            }
        };
        if !scheduled {
            return;
        }

        let delay = retry_at
            .signed_duration_since(Utc::now())
            .to_std()
            .unwrap_or_default()
            .saturating_add(SEND_QUEUE_RETRY_GRACE);
        tokio::time::sleep(delay).await;

        let should_retry = {
            let mut retries = SCHEDULED_SEND_QUEUE_RETRIES.lock().await;
            if retries.get(&conversation_id) == Some(&retry_at) {
                retries.remove(&conversation_id);
                true
            } else {
                false
            }
        };
        if !should_retry {
            return;
        }
        if let Err((status, Json(api_error))) =
            drain_send_queue_with_reclaim_after(&state, conversation_id, reclaim_after).await
        {
            warn!(
                %conversation_id,
                status = status.as_u16(),
                error = %api_error.message,
                "scheduled send-queue recovery drain failed"
            );
        }
    });
}

struct ClaimedSendQueueEntry {
    project_id: Uuid,
    session_id: Option<Uuid>,
    entry_id: Uuid,
    user_id: Option<Uuid>,
    message: JsonValue,
    entry: JsonValue,
}

enum QueueClaimAttempt {
    Done,
    Retry,
    RetryAt(DateTime<Utc>),
    Claimed(ClaimedSendQueueEntry),
}

/// Select and reserve one eligible queue entry in a short transaction. The
/// transaction-scoped lock can safely have many waiters because no connection
/// is retained while dispatch acquires another pool connection.
async fn claim_next_send_queue_entry(
    state: &AppState,
    conversation_id: Uuid,
) -> Result<QueueClaimAttempt, (StatusCode, Json<ApiError>)> {
    claim_next_send_queue_entry_with_reclaim_after(
        state,
        conversation_id,
        SEND_QUEUE_CLAIM_RECLAIM_AFTER,
    )
    .await
}

async fn claim_next_send_queue_entry_with_reclaim_after(
    state: &AppState,
    conversation_id: Uuid,
    reclaim_after: Duration,
) -> Result<QueueClaimAttempt, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start queue claim: {error}")))?;
    let lock_key = format!("send-queue-drain:{conversation_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to acquire queue claim lock: {error}")))?;

    let conversation = transaction
        .query_opt(
            "select project_id, session_id from conversations where id = $1",
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load conversation: {error}")))?;
    let Some(conversation) = conversation else {
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to finalize empty queue claim: {error}"))
        })?;
        return Ok(QueueClaimAttempt::Done);
    };
    let project_id: Uuid = conversation.get("project_id");
    let session_id: Option<Uuid> = conversation.get("session_id");
    let reclaim_after_seconds = reclaim_after.as_secs_f64();
    let reclaim_after_millis = reclaim_after.as_millis().min(i64::MAX as u128) as i64;

    // A crash may leave a claim without an outcome stamp, including after the
    // dispatch itself committed. Return it to queued: the stable message id
    // makes replay either create the missing run once or recover the existing
    // run idempotently.
    let reclaimed = transaction
        .query(
            &format!(
                "update conversation_send_queue
                 set status = 'queued',
                     dispatched_at = null,
                     error_message = null,
                     updated_at = now()
                 where conversation_id = $1
                   and status = 'dispatched'
                   and dispatched_run_id is null
                   and (
                     dispatched_at is null
                     or dispatched_at < now() - ($2::double precision * interval '1 second')
                   )
                 returning {ENTRY_COLUMNS}"
            ),
            &[&conversation_id, &reclaim_after_seconds],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to reclaim stranded dispatches: {error}"))
        })?;

    let (mut lane_blocked, mut has_untargeted_active) =
        load_active_agent_handles(&transaction, conversation_id).await?;
    let reservations = transaction
        .query(
            "select request, dispatched_at
             from conversation_send_queue
             where conversation_id = $1
               and status = 'dispatched'
               and dispatched_run_id is null
               and dispatched_at >= now() - ($2::double precision * interval '1 second')",
            &[&conversation_id, &reclaim_after_seconds],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load queue reservations: {error}")))?;
    for row in &reservations {
        let request = row.get::<_, PgJson<JsonValue>>("request").0;
        match canonical_target_handles_from_value(&request) {
            Ok(targets) => lane_blocked.extend(targets),
            Err(_) => has_untargeted_active = true,
        }
    }
    let retry_at = reservations
        .iter()
        .filter_map(|row| row.get::<_, Option<DateTime<Utc>>>("dispatched_at"))
        .map(|dispatched_at| dispatched_at + chrono::Duration::milliseconds(reclaim_after_millis))
        .min();

    let mut candidate_id = None;
    if !has_untargeted_active {
        // Failed entries are owner-private dead letters and never invisible
        // lane locks. FIFO applies among queued entries per canonical target.
        let entries = transaction
            .query(
                &format!(
                    "select {ENTRY_COLUMNS}
                     from conversation_send_queue
                     where conversation_id = $1
                       and status = 'queued'
                     order by queue_position asc, id asc"
                ),
                &[&conversation_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load send queue: {error}")))?;
        for row in &entries {
            let request = row.get::<_, PgJson<JsonValue>>("request").0;
            let targets = canonical_target_handles_from_value(&request).unwrap_or_default();
            let eligible = if targets.is_empty() {
                lane_blocked.is_empty()
            } else {
                targets.iter().all(|handle| !lane_blocked.contains(handle))
            };
            if eligible {
                candidate_id = Some(row.get::<_, Uuid>("id"));
                break;
            }
            if targets.is_empty() {
                break;
            }
            lane_blocked.extend(targets);
        }
    }

    let claimed = if let Some(entry_id) = candidate_id {
        transaction
            .query_opt(
                &format!(
                    "update conversation_send_queue
                     set status = 'dispatched', dispatched_at = now(), updated_at = now()
                     where id = $1 and status = 'queued'
                     returning {ENTRY_COLUMNS}"
                ),
                &[&entry_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to claim queued message: {error}")))?
    } else {
        None
    };

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit queue claim: {error}")))?;
    for row in &reclaimed {
        let owner_user_id: Option<Uuid> = row.get("user_id");
        publish_send_queue_event(
            state,
            project_id,
            session_id,
            conversation_id,
            owner_user_id,
            "queued",
            entry_row_to_json(row),
        );
    }

    let Some(claimed) = claimed else {
        return Ok(if candidate_id.is_some() {
            QueueClaimAttempt::Retry
        } else if let Some(retry_at) = retry_at {
            QueueClaimAttempt::RetryAt(retry_at)
        } else {
            QueueClaimAttempt::Done
        });
    };
    let entry_id: Uuid = claimed.get("id");
    let user_id: Option<Uuid> = claimed.get("user_id");
    let message = claimed.get::<_, PgJson<JsonValue>>("request").0;
    Ok(QueueClaimAttempt::Claimed(ClaimedSendQueueEntry {
        project_id,
        session_id,
        entry_id,
        user_id,
        message,
        entry: entry_row_to_json(&claimed),
    }))
}

async fn restore_queue_claim_after_busy(
    state: &AppState,
    claim: &ClaimedSendQueueEntry,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let restored = connection
        .query_opt(
            &format!(
                "update conversation_send_queue
                 set status = 'queued', dispatched_at = null,
                     error_message = null, updated_at = now()
                 where id = $1
                   and status = 'dispatched'
                   and dispatched_run_id is null
                 returning {ENTRY_COLUMNS}"
            ),
            &[&claim.entry_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to restore busy queue claim: {error}")))?;
    if let Some(restored) = restored {
        publish_send_queue_event(
            state,
            claim.project_id,
            claim.session_id,
            restored.get("conversation_id"),
            claim.user_id,
            "queued",
            entry_row_to_json(&restored),
        );
    }

    Ok(())
}

fn active_agent_handle_from_job_payload(payload: &JsonValue) -> Option<String> {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("agent"))
        .and_then(JsonValue::as_object)
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .and_then(normalize_agent_handle)
}

/// Active per-job agent handles for a conversation, plus whether any active
/// job lacks its authoritative `metadata.agent.handle` (which conservatively
/// blocks the whole queue).
async fn load_active_agent_handles<C>(
    connection: &C,
    conversation_id: Uuid,
) -> Result<(HashSet<String>, bool), (StatusCode, Json<ApiError>)>
where
    C: tokio_postgres::GenericClient + Send,
{
    let rows = connection
        .query(
            "select payload from agent_jobs
             where conversation_id = $1
               and status in ('queued','leased')",
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load active jobs: {error}")))?;

    let mut handles = HashSet::new();
    let mut has_untargeted = false;
    for row in rows {
        let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
        if let Some(handle) = active_agent_handle_from_job_payload(&payload) {
            handles.insert(handle);
        } else {
            has_untargeted = true;
        }
    }
    Ok((handles, has_untargeted))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt_with_metadata(metadata: JsonValue) -> JsonValue {
        json!({
            "sessionId": null,
            "promptText": "Keep going",
            "intent": "feature",
            "metadata": metadata
        })
    }

    #[test]
    fn canonical_queue_lanes_prefer_mentions_and_match_dispatch_normalization() {
        let message = prompt_with_metadata(json!({
            "agentSelection": {
                "active": ["octo", "reviewer"],
                "mentions": ["@Reviewer", "reviewer", "bad handle"]
            }
        }));

        assert_eq!(
            canonical_target_handles_from_value(&message).expect("valid prompt"),
            vec!["reviewer".to_string()]
        );
    }

    #[test]
    fn canonical_queue_lanes_use_active_then_default_octo() {
        let active = prompt_with_metadata(json!({
            "agentSelection": { "active": ["Octo", "worker-1"], "mentions": [] }
        }));
        assert_eq!(
            canonical_target_handles_from_value(&active).expect("valid prompt"),
            vec!["octo".to_string(), "worker-1".to_string()]
        );

        let plain = prompt_with_metadata(json!({}));
        assert_eq!(
            canonical_target_handles_from_value(&plain).expect("valid prompt"),
            vec!["octo".to_string()]
        );
    }

    #[test]
    fn client_send_ids_are_trimmed_bounded_and_non_empty() {
        assert_eq!(
            normalize_client_send_id("  retry-1  ").expect("valid id"),
            "retry-1"
        );
        assert!(normalize_client_send_id("   ").is_err());
        assert!(normalize_client_send_id(&"x".repeat(201)).is_err());
        assert!(normalize_client_send_id(&"ø".repeat(200)).is_ok());
    }

    #[test]
    fn queue_reorder_moves_before_or_to_end_and_is_state_idempotent() {
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let third = Uuid::from_u128(3);
        let current = vec![first, second, third];

        let moved = move_queue_entry_before(&current, third, Some(first)).expect("valid move");
        assert_eq!(moved, vec![third, first, second]);
        assert_eq!(
            move_queue_entry_before(&moved, third, Some(first)),
            Some(moved.clone()),
            "replaying the same semantic move must be a no-op"
        );
        assert_eq!(
            move_queue_entry_before(&moved, third, None),
            Some(vec![first, second, third])
        );
        assert_eq!(
            move_queue_entry_before(&current, second, Some(second)),
            Some(current.clone())
        );
        assert_eq!(move_queue_entry_before(&current, Uuid::nil(), None), None);
        assert_eq!(
            move_queue_entry_before(&current, first, Some(Uuid::nil())),
            None
        );
    }

    #[test]
    fn queue_dispatch_retry_preserves_a_stable_client_message_id() {
        let mut body: ConversationPromptBody = serde_json::from_value(prompt_with_metadata(
            json!({ "clientMessageId": "interactive-send-1", "custom": true }),
        ))
        .expect("valid prompt");
        let entry_id = Uuid::new_v4();

        stamp_queue_dispatch_idempotency(&mut body, entry_id);

        let metadata = body.metadata.expect("metadata");
        assert_eq!(metadata["clientMessageId"], "interactive-send-1");
        assert_eq!(metadata["custom"], true);
    }

    #[test]
    fn queue_dispatch_retry_derives_an_id_when_the_client_has_none() {
        let mut body: ConversationPromptBody =
            serde_json::from_value(prompt_with_metadata(json!({ "custom": true })))
                .expect("valid prompt");
        let entry_id = Uuid::new_v4();

        stamp_queue_dispatch_idempotency(&mut body, entry_id);

        let metadata = body.metadata.expect("metadata");
        assert_eq!(
            metadata["clientMessageId"],
            format!("send-queue:{entry_id}")
        );
        assert_eq!(metadata["custom"], true);
    }

    #[test]
    fn active_queue_lane_comes_from_authoritative_per_job_agent_handle() {
        let payload = json!({
            "metadata": {
                "agent": { "handle": "@Reviewer" },
                "agentSelection": { "active": ["octo", "reviewer"] }
            }
        });
        assert_eq!(
            active_agent_handle_from_job_payload(&payload),
            Some("reviewer".to_string())
        );

        let selection_only = json!({
            "metadata": { "agentSelection": { "active": ["octo"] } }
        });
        assert_eq!(active_agent_handle_from_job_payload(&selection_only), None);
    }

    fn normalized_test_dispatch(
        project_id: Uuid,
        conversation_id: Uuid,
        prompt: &str,
        handle: &str,
        client_message_id: &str,
    ) -> crate::dispatch::DispatchPromptNormalized {
        crate::dispatch::normalize_dispatch_request(crate::dispatch::DispatchPromptRequest {
            project_id: Some(project_id.to_string()),
            session_id: None,
            prompt_text: Some(prompt.to_string()),
            intent: Some("feature".to_string()),
            plan_seed: None,
            metadata: Some(json!({
                "clientMessageId": client_message_id,
                "agentSelection": { "active": [handle], "mentions": [] }
            })),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: Some(conversation_id.to_string()),
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        })
        .expect("normalize queue admission test dispatch")
    }

    async fn insert_service_queue_fixture(
        pool: &crate::config::PgPool,
        project_id: Uuid,
        conversation_id: Uuid,
    ) -> anyhow::Result<()> {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status)
                 values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection
            .execute(
                "insert into conversations (id, project_id, metadata, visibility)
                 values ($1, $2, '{}'::jsonb, 'public')",
                &[&conversation_id, &project_id],
            )
            .await?;
        Ok(())
    }

    async fn insert_queue_test_user(
        pool: &crate::config::PgPool,
        user_id: Uuid,
    ) -> anyhow::Result<()> {
        pool.get()
            .await?
            .execute(
                "insert into auth.users (id) values ($1) on conflict (id) do nothing",
                &[&user_id],
            )
            .await?;
        Ok(())
    }

    async fn cleanup_owned_queue_fixture(
        pool: &crate::config::PgPool,
        project_id: Uuid,
        user_ids: &[Uuid],
    ) -> anyhow::Result<()> {
        let connection = pool.get().await?;
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        for user_id in user_ids {
            connection
                .execute("delete from auth.users where id = $1", &[user_id])
                .await?;
        }
        Ok(())
    }

    async fn claim_for_test(
        state: &AppState,
        conversation_id: Uuid,
    ) -> anyhow::Result<QueueClaimAttempt> {
        claim_next_send_queue_entry(state, conversation_id)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("queue claim failed ({status}): {}", error.message)
            })
    }

    #[tokio::test]
    async fn owner_reorder_preserves_foreign_slots_and_controls_claim_order() -> anyhow::Result<()>
    {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping queue reorder test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let other_user_id = Uuid::new_v4();
        let owner_first_id = Uuid::new_v4();
        let other_id = Uuid::new_v4();
        let owner_last_id = Uuid::new_v4();
        insert_queue_test_user(&pool, owner_user_id).await?;
        insert_queue_test_user(&pool, other_user_id).await?;
        insert_service_queue_fixture(&pool, project_id, conversation_id).await?;
        let message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["octo"], "mentions": [] }
        }));
        let connection = pool.get().await?;
        for (entry_id, user_id, client_send_id) in [
            (owner_first_id, owner_user_id, "owner-first"),
            (other_id, other_user_id, "other"),
            (owner_last_id, owner_user_id, "owner-last"),
        ] {
            connection
                .execute(
                    "insert into conversation_send_queue (
                         id, project_id, conversation_id, user_id,
                         client_send_id, status, request
                     ) values ($1, $2, $3, $4, $5, 'queued', $6)",
                    &[
                        &entry_id,
                        &project_id,
                        &conversation_id,
                        &user_id,
                        &client_send_id,
                        &PgJson(message.clone()),
                    ],
                )
                .await?;
        }
        let original_rows = connection
            .query(
                "select id, queue_position
                 from conversation_send_queue
                 where conversation_id = $1
                 order by queue_position asc, id asc",
                &[&conversation_id],
            )
            .await?;
        let original = original_rows
            .iter()
            .map(|row| {
                (
                    row.get::<_, Uuid>("id"),
                    row.get::<_, i64>("queue_position"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            original.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![owner_first_id, other_id, owner_last_id],
            "sequence defaults must append new queue entries"
        );
        drop(connection);

        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "queue-reorder",
            ),
        );

        let (status, _) = reorder_owned_send_queue_entry(
            &state,
            conversation_id,
            owner_user_id,
            owner_last_id,
            Some(other_id),
        )
        .await
        .expect_err("another owner's entry cannot be used as an anchor");
        assert_eq!(status, StatusCode::NOT_FOUND);

        let outcome = reorder_owned_send_queue_entry(
            &state,
            conversation_id,
            owner_user_id,
            owner_last_id,
            Some(owner_first_id),
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!("queue reorder failed ({status}): {}", error.message)
        })?;
        assert!(outcome.changed);
        assert_eq!(
            outcome
                .entries
                .iter()
                .map(|entry| entry["id"].as_str().expect("entry id"))
                .collect::<Vec<_>>(),
            vec![owner_last_id.to_string(), owner_first_id.to_string()]
        );
        assert!(
            outcome
                .entries
                .iter()
                .all(|entry| entry["queuePosition"].as_i64().is_some()),
            "reorder responses must expose persisted positions"
        );

        let reordered_rows = pool
            .get()
            .await?
            .query(
                "select id, queue_position
                 from conversation_send_queue
                 where conversation_id = $1
                 order by queue_position asc, id asc",
                &[&conversation_id],
            )
            .await?;
        let reordered = reordered_rows
            .iter()
            .map(|row| {
                (
                    row.get::<_, Uuid>("id"),
                    row.get::<_, i64>("queue_position"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            reordered.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            vec![owner_last_id, other_id, owner_first_id]
        );
        assert_eq!(
            reordered
                .iter()
                .find(|(id, _)| *id == other_id)
                .map(|(_, position)| *position),
            original
                .iter()
                .find(|(id, _)| *id == other_id)
                .map(|(_, position)| *position),
            "a reorder must not borrow or change another owner's slot"
        );

        let replay = reorder_owned_send_queue_entry(
            &state,
            conversation_id,
            owner_user_id,
            owner_last_id,
            Some(owner_first_id),
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!("queue reorder replay failed ({status}): {}", error.message)
        })?;
        assert!(!replay.changed);
        let replay_positions = replay
            .entries
            .iter()
            .map(|entry| entry["queuePosition"].as_i64().expect("queue position"))
            .collect::<Vec<_>>();
        assert_eq!(
            replay_positions,
            vec![reordered[0].1, reordered[2].1],
            "idempotent replay must retain the existing positions"
        );

        let claim = match claim_for_test(&state, conversation_id).await? {
            QueueClaimAttempt::Claimed(claim) => claim,
            _ => panic!("reordered first entry should be claimed first"),
        };
        assert_eq!(claim.entry_id, owner_last_id);
        let (status, _) = reorder_owned_send_queue_entry(
            &state,
            conversation_id,
            owner_user_id,
            owner_last_id,
            Some(owner_first_id),
        )
        .await
        .expect_err("a claimed entry is no longer mutable");
        assert_eq!(status, StatusCode::NOT_FOUND);

        cleanup_owned_queue_fixture(&pool, project_id, &[other_user_id, owner_user_id]).await?;
        Ok(())
    }

    #[tokio::test]
    async fn queued_entry_prevents_interactive_overtake_before_claim() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping queued FIFO admission test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let queue_entry_id = Uuid::new_v4();
        insert_service_queue_fixture(&pool, project_id, conversation_id).await?;
        let queued_message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["octo"], "mentions": [] }
        }));
        pool.get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, status, request
                 ) values ($1, $2, $3, 'queued', $4)",
                &[
                    &queue_entry_id,
                    &project_id,
                    &conversation_id,
                    &PgJson(queued_message),
                ],
            )
            .await?;

        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "queued-fifo-admission",
            ),
        );
        let context = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };

        let mut same_lane = normalized_test_dispatch(
            project_id,
            conversation_id,
            "later interactive same lane",
            "octo",
            "later-interactive-same-lane",
        );
        same_lane.expected_lane_idle = true;
        let (status, Json(error)) =
            crate::dispatch::process_dispatch_prompt(&state, &context, same_lane)
                .await
                .expect_err("an older queued message must block same-lane interactive dispatch");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some("dispatch_lane_busy"));

        let mut other_lane = normalized_test_dispatch(
            project_id,
            conversation_id,
            "later interactive disjoint lane",
            "reviewer",
            "later-interactive-disjoint-lane",
        );
        other_lane.expected_lane_idle = true;
        crate::dispatch::process_dispatch_prompt(&state, &context, other_lane)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!(
                    "disjoint-lane dispatch failed ({status}): {}",
                    error.message
                )
            })?;

        let claim = match claim_for_test(&state, conversation_id).await? {
            QueueClaimAttempt::Claimed(claim) => claim,
            _ => panic!("the oldest queued message should remain claimable"),
        };
        assert_eq!(claim.entry_id, queue_entry_id);
        let queue_response = dispatch_stored_message(
            &state,
            &context,
            project_id,
            conversation_id,
            None,
            claim.entry_id,
            claim.message,
            true,
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "oldest queue-owned dispatch failed ({status}): {}",
                error.message
            )
        })?;
        record_dispatch_outcome(&state, queue_entry_id, &queue_response).await;

        let connection = pool.get().await?;
        let job_count: i64 = connection
            .query_one(
                "select count(*) from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 2, "one disjoint direct job and one queued job");
        drop(connection);
        pool.get()
            .await?
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn queue_reservation_and_interactive_send_share_lane_admission() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping queue lane admission test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let queue_entry_id = Uuid::new_v4();
        insert_service_queue_fixture(&pool, project_id, conversation_id).await?;
        let queued_message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["octo"], "mentions": [] }
        }));
        pool.get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, status, request
                 ) values ($1, $2, $3, 'queued', $4)",
                &[
                    &queue_entry_id,
                    &project_id,
                    &conversation_id,
                    &PgJson(queued_message.clone()),
                ],
            )
            .await?;

        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "queue-lane-admission",
            ),
        );
        let claim = match claim_for_test(&state, conversation_id).await? {
            QueueClaimAttempt::Claimed(claim) => claim,
            _ => panic!("expected queue reservation"),
        };
        assert_eq!(claim.entry_id, queue_entry_id);
        let context = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };

        let mut same_lane = normalized_test_dispatch(
            project_id,
            conversation_id,
            "interactive same lane",
            "octo",
            "interactive-same-lane",
        );
        same_lane.expected_lane_idle = true;
        let (status, Json(error)) =
            crate::dispatch::process_dispatch_prompt(&state, &context, same_lane)
                .await
                .expect_err("queue reservation must block a stale same-lane send");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some("dispatch_lane_busy"));

        let mut other_lane = normalized_test_dispatch(
            project_id,
            conversation_id,
            "interactive other lane",
            "reviewer",
            "interactive-other-lane",
        );
        other_lane.expected_lane_idle = true;
        crate::dispatch::process_dispatch_prompt(&state, &context, other_lane)
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("other-lane dispatch failed ({status}): {}", error.message)
            })?;

        let queue_response = dispatch_stored_message(
            &state,
            &context,
            project_id,
            conversation_id,
            None,
            claim.entry_id,
            claim.message,
            true,
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "reserved queue dispatch failed ({status}): {}",
                error.message
            )
        })?;
        record_dispatch_outcome(&state, queue_entry_id, &queue_response).await;

        let blocked_entry_id = Uuid::new_v4();
        let blocked_message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["reviewer"], "mentions": [] }
        }));
        pool.get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, status, request
                 ) values ($1, $2, $3, 'queued', $4)",
                &[
                    &blocked_entry_id,
                    &project_id,
                    &conversation_id,
                    &PgJson(blocked_message),
                ],
            )
            .await?;
        assert!(matches!(
            claim_for_test(&state, conversation_id).await?,
            QueueClaimAttempt::Done
        ));
        let connection = pool.get().await?;
        let blocked_status: String = connection
            .query_one(
                "select status from conversation_send_queue where id = $1",
                &[&blocked_entry_id],
            )
            .await?
            .get(0);
        assert_eq!(blocked_status, "queued");
        let job_count: i64 = connection
            .query_one(
                "select count(*) from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 2, "one disjoint direct job and one queued job");
        drop(connection);
        pool.get()
            .await?
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn stale_queue_claim_replays_a_committed_dispatch_exactly_once() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping queue claim recovery test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let entry_id = Uuid::new_v4();
        insert_service_queue_fixture(&pool, project_id, conversation_id).await?;
        let message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["octo"], "mentions": [] }
        }));
        pool.get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, status, request, dispatched_at
                 ) values ($1, $2, $3, 'dispatched', $4, now() - interval '11 minutes')",
                &[&entry_id, &project_id, &conversation_id, &PgJson(message)],
            )
            .await?;
        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "queue-claim-recovery",
            ),
        );
        let context = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        let first_claim = match claim_for_test(&state, conversation_id).await? {
            QueueClaimAttempt::Claimed(claim) => claim,
            _ => panic!("stale claim should be reclaimed and selected"),
        };
        let first_response = dispatch_stored_message(
            &state,
            &context,
            project_id,
            conversation_id,
            None,
            entry_id,
            first_claim.message,
            true,
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "first recovered dispatch failed ({status}): {}",
                error.message
            )
        })?;
        let first_run_id = first_response.run_id.expect("first recovered run");

        let connection = pool.get().await?;
        connection
            .execute(
                "update agent_jobs set status = 'completed'
                 where conversation_id = $1",
                &[&conversation_id],
            )
            .await?;
        connection
            .execute(
                "update conversation_send_queue
                 set dispatched_at = now() - interval '11 minutes'
                 where id = $1",
                &[&entry_id],
            )
            .await?;
        drop(connection);

        let second_claim = match claim_for_test(&state, conversation_id).await? {
            QueueClaimAttempt::Claimed(claim) => claim,
            _ => panic!("committed dispatch without outcome should be replayed"),
        };
        let second_response = dispatch_stored_message(
            &state,
            &context,
            project_id,
            conversation_id,
            None,
            entry_id,
            second_claim.message,
            true,
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "idempotent recovered dispatch failed ({status}): {}",
                error.message
            )
        })?;
        assert_eq!(second_response.run_id, Some(first_run_id));
        record_dispatch_outcome(&state, entry_id, &second_response).await;

        let connection = pool.get().await?;
        let job_count: i64 = connection
            .query_one(
                "select count(*) from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        let message_count: i64 = connection
            .query_one(
                "select count(*) from conversation_messages
                 where conversation_id = $1 and role = 'user'",
                &[&conversation_id],
            )
            .await?
            .get(0);
        let dispatched_run_id: Option<Uuid> = connection
            .query_one(
                "select dispatched_run_id from conversation_send_queue where id = $1",
                &[&entry_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 1);
        assert_eq!(message_count, 1);
        assert_eq!(dispatched_run_id, Some(first_run_id));
        drop(connection);
        pool.get()
            .await?
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn recent_stranded_claim_self_wakes_and_dispatches_once() -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping queue expiry wakeup test: TEST_DATABASE_URL not set");
            return Ok(());
        };
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let entry_id = Uuid::new_v4();
        insert_service_queue_fixture(&pool, project_id, conversation_id).await?;
        let message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["octo"], "mentions": [] }
        }));
        pool.get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, status, request, dispatched_at
                 ) values ($1, $2, $3, 'dispatched', $4, now())",
                &[&entry_id, &project_id, &conversation_id, &PgJson(message)],
            )
            .await?;
        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "queue-expiry-wakeup",
            ),
        );

        // The initial drain sees a fresh reservation and must arrange its own
        // retry. Nothing below enqueues, completes a job, or manually drains
        // the queue again.
        drain_send_queue_with_reclaim_after(&state, conversation_id, Duration::from_millis(200))
            .await
            .map_err(|(status, Json(error))| {
                anyhow::anyhow!("initial drain failed ({status}): {}", error.message)
            })?;

        let dispatched_run_id = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let connection = pool.get().await?;
                let run_id: Option<Uuid> = connection
                    .query_one(
                        "select dispatched_run_id
                         from conversation_send_queue
                         where id = $1",
                        &[&entry_id],
                    )
                    .await?
                    .get(0);
                drop(connection);
                if let Some(run_id) = run_id {
                    break anyhow::Ok(run_id);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("stranded queue claim was not retried after expiry"))??;

        let connection = pool.get().await?;
        let job_count: i64 = connection
            .query_one(
                "select count(*) from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        let message_count: i64 = connection
            .query_one(
                "select count(*) from conversation_messages
                 where conversation_id = $1 and role = 'user'",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 1);
        assert_eq!(message_count, 1);
        assert_ne!(dispatched_run_id, Uuid::nil());
        drop(connection);
        pool.get()
            .await?
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        Ok(())
    }

    #[tokio::test]
    async fn duplicate_drains_complete_with_a_two_connection_pool() -> anyhow::Result<()> {
        if crate::tests::setup_origin_test_pool().await?.is_none() {
            eprintln!("skipping small-pool queue drain test: TEST_DATABASE_URL not set");
            return Ok(());
        }
        let database_url = std::env::var("TEST_DATABASE_URL")?;
        let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
            &database_url,
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder().max_size(2).build(manager).await?;
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let entry_id = Uuid::new_v4();
        insert_service_queue_fixture(&pool, project_id, conversation_id).await?;
        let message = prompt_with_metadata(json!({
            "agentSelection": { "active": ["octo"], "mentions": [] }
        }));
        pool.get()
            .await?
            .execute(
                "insert into conversation_send_queue (
                     id, project_id, conversation_id, status, request
                 ) values ($1, $2, $3, 'queued', $4)",
                &[&entry_id, &project_id, &conversation_id, &PgJson(message)],
            )
            .await?;
        let state = crate::tests::build_test_state(
            pool.clone(),
            crate::tests::build_app_config(
                crate::tests::test_origin_private_key(),
                crate::tests::test_origin_public_key(),
                "queue-small-pool",
            ),
        );

        let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                drain_send_queue(&state, conversation_id),
                drain_send_queue(&state, conversation_id)
            )
        })
        .await
        .map_err(|_| anyhow::anyhow!("duplicate drains exhausted the two-connection pool"))?;
        for result in [first, second] {
            result.map_err(|(status, Json(error))| {
                anyhow::anyhow!("duplicate drain failed ({status}): {}", error.message)
            })?;
        }

        let connection = pool.get().await?;
        let job_count: i64 = connection
            .query_one(
                "select count(*) from agent_jobs where conversation_id = $1",
                &[&conversation_id],
            )
            .await?
            .get(0);
        assert_eq!(job_count, 1);
        drop(connection);
        pool.get()
            .await?
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        Ok(())
    }
}
