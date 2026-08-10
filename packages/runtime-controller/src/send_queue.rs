use std::collections::HashSet;
use std::str::FromStr;

use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tracing::warn;
use uuid::Uuid;

use crate::auth::{authenticate_request, RequestContext};
use crate::conversations::{
    build_dispatch_request_from_conversation, ensure_conversation_access,
    inject_conversation_metadata, load_conversation_record, ConversationPromptBody,
};
use crate::dispatch::{
    ensure_project_prompt_access, normalize_dispatch_request, process_dispatch_prompt,
    DispatchPromptResponse,
};
use crate::{
    bad_request, ensure_project_access, internal_error, not_found,
    publish_controller_event_with_conversation, ApiError, AppState,
};

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendQueueEnqueueBody {
    pub(crate) message: JsonValue,
    #[serde(default)]
    pub(crate) target_agent_handles: Vec<String>,
}

fn normalize_handles(handles: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    handles
        .iter()
        .map(|handle| handle.trim().to_ascii_lowercase())
        .filter(|handle| !handle.is_empty())
        .filter(|handle| seen.insert(handle.clone()))
        .collect()
}

fn entry_row_to_json(row: &tokio_postgres::Row) -> JsonValue {
    json!({
        "id": row.get::<_, Uuid>("id"),
        "conversationId": row.get::<_, Uuid>("conversation_id"),
        "status": row.get::<_, String>("status"),
        "targetAgentHandles": row.get::<_, Vec<String>>("target_agent_handles"),
        "message": row.get::<_, PgJson<JsonValue>>("request").0,
        "errorMessage": row.get::<_, Option<String>>("error_message"),
        "createdAt": row.get::<_, chrono::DateTime<chrono::Utc>>("created_at"),
        "dispatchedAt": row.get::<_, Option<chrono::DateTime<chrono::Utc>>>("dispatched_at"),
    })
}

const ENTRY_COLUMNS: &str = "id, conversation_id, status, target_agent_handles, request, \
                             error_message, created_at, dispatched_at";

fn publish_send_queue_event(
    state: &AppState,
    project_id: Uuid,
    session_id: Option<Uuid>,
    conversation_id: Uuid,
    action: &str,
    entry: JsonValue,
) {
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.sendQueue",
        Some(project_id),
        session_id,
        Some(conversation_id),
        None,
        None,
        json!({
            "action": action,
            "entry": entry,
        }),
    );
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
    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;

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

    Ok((
        context,
        conversation_id,
        ConversationAccess {
            project_id: conversation.project_id,
            session_id: conversation.session_id,
        },
    ))
}

pub(crate) async fn enqueue_send_queue_entry(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<SendQueueEnqueueBody>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let (context, conversation_id, access) =
        authorize_conversation(&state, &headers, conversation_id_raw.as_str(), true).await?;

    let message: ConversationPromptBody = serde_json::from_value(body.message.clone())
        .map_err(|error| bad_request(format!("message is not a valid prompt body: {error}")))?;
    if message.prompt_text.trim().is_empty() {
        return Err(bad_request("message promptText must not be empty"));
    }
    let handles = normalize_handles(&body.target_agent_handles);

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let request_param = PgJson(&body.message);
    let row = connection
        .query_one(
            &format!(
                "insert into conversation_send_queue (
                     project_id, conversation_id, session_id, user_id,
                     target_agent_handles, request
                 ) values ($1, $2, $3, $4, $5, $6::jsonb)
                 returning {ENTRY_COLUMNS}"
            ),
            &[
                &access.project_id,
                &conversation_id,
                &access.session_id,
                &context.user_id,
                &handles,
                &request_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to enqueue message: {error}")))?;

    let entry = entry_row_to_json(&row);
    publish_send_queue_event(
        &state,
        access.project_id,
        access.session_id,
        conversation_id,
        "enqueued",
        entry.clone(),
    );

    Ok(Json(entry))
}

pub(crate) async fn list_send_queue(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
) -> Result<Json<Vec<JsonValue>>, (StatusCode, Json<ApiError>)> {
    let (_context, conversation_id, _access) =
        authorize_conversation(&state, &headers, conversation_id_raw.as_str(), false).await?;

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
                   and status in ('queued','failed')
                 order by created_at asc"
            ),
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list send queue: {error}")))?;

    Ok(Json(rows.iter().map(entry_row_to_json).collect()))
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
    let actor_user_id = if context.is_service_role {
        None
    } else {
        Some(
            context
                .user_id
                .ok_or_else(|| crate::unauthorized("user session required"))?,
        )
    };
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
                   and ($3::boolean or user_id = $4)
                 returning {ENTRY_COLUMNS}"
            ),
            &[
                &entry_id,
                &conversation_id,
                &context.is_service_role,
                &actor_user_id,
            ],
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
    let actor_user_id = if context.is_service_role {
        None
    } else {
        Some(
            context
                .user_id
                .ok_or_else(|| crate::unauthorized("user session required"))?,
        )
    };

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
                   and ($3::boolean or user_id = $4)
                 returning {ENTRY_COLUMNS}"
            ),
            &[
                &entry_id,
                &conversation_id,
                &context.is_service_role,
                &actor_user_id,
            ],
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
                   and ($3::boolean or user_id = $4)",
                &[
                    &entry_id,
                    &conversation_id,
                    &context.is_service_role,
                    &actor_user_id,
                ],
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
    drop(connection);

    match dispatch_stored_message(
        &state,
        &context,
        access.project_id,
        conversation_id,
        access.session_id,
        message,
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
                "dispatched",
                entry,
            );
            let response = serde_json::to_value(&response).map_err(|error| {
                internal_error(format!("failed to serialize response: {error}"))
            })?;
            Ok(Json(response))
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

async fn dispatch_stored_message(
    state: &AppState,
    context: &RequestContext,
    project_id: Uuid,
    conversation_id: Uuid,
    conversation_session_id: Option<Uuid>,
    message: JsonValue,
) -> Result<DispatchPromptResponse, (StatusCode, Json<ApiError>)> {
    let mut body: ConversationPromptBody = serde_json::from_value(message)
        .map_err(|error| bad_request(format!("queued message is invalid: {error}")))?;
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

async fn drain_send_queue(
    state: &AppState,
    conversation_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    // Serialize drains per conversation. Every job completion and cancellation
    // spawns a drain, so two drains for the same conversation routinely race;
    // without exclusion they each work from a stale active-handle snapshot and
    // can dispatch two entries to the same agent concurrently. The lock is a
    // session-level advisory lock held on this pooled connection; if another
    // drain holds it we simply return — the holder recomputes the queue every
    // iteration, and the next completion/cancel spawns a fresh drain anyway.
    let lock_key = format!("send-queue-drain:{conversation_id}");
    let locked: bool = connection
        .query_one(
            "select pg_try_advisory_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to acquire drain lock: {error}")))?
        .get(0);
    if !locked {
        return Ok(());
    }

    let result = drain_send_queue_locked(state, &mut *connection, conversation_id).await;

    if let Err(error) = connection
        .execute(
            "select pg_advisory_unlock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
    {
        // The lock is session-scoped: if the unlock fails the connection is
        // broken and the pool will discard it, releasing the lock with it.
        warn!(
            conversation_id = %conversation_id,
            error = %error,
            "failed to release send-queue drain lock"
        );
    }

    result
}

async fn drain_send_queue_locked<C>(
    state: &AppState,
    connection: &mut C,
    conversation_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)>
where
    C: tokio_postgres::GenericClient + Send,
{
    let conversation = connection
        .query_opt(
            "select project_id, session_id from conversations where id = $1",
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load conversation: {error}")))?;
    let Some(conversation) = conversation else {
        return Ok(());
    };
    let project_id: Uuid = conversation.get("project_id");
    let session_id: Option<Uuid> = conversation.get("session_id");

    // Reclaim entries stranded 'dispatched' by a crash between the claim and
    // the dispatch commit (a completed dispatch stamps dispatched_run_id).
    // Surfacing them as failed puts them back in the user's queue UI.
    let reclaimed = connection
        .query(
            &format!(
                "update conversation_send_queue
                 set status = 'failed',
                     error_message = coalesce(error_message, 'dispatch was interrupted before it completed'),
                     updated_at = now()
                 where conversation_id = $1
                   and status = 'dispatched'
                   and dispatched_run_id is null
                   and dispatched_at < now() - interval '10 minutes'
                 returning {ENTRY_COLUMNS}"
            ),
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to reclaim stranded dispatches: {error}")))?;
    for row in &reclaimed {
        publish_send_queue_event(
            state,
            project_id,
            session_id,
            conversation_id,
            "failed",
            entry_row_to_json(row),
        );
    }

    // Dispatch at most one entry per iteration, recomputing the active-job
    // picture each time so the job created by the previous dispatch (targeted
    // or untargeted) participates in the next eligibility decision.
    loop {
        let (active_handles, has_untargeted_active) =
            load_active_agent_handles(&mut *connection, conversation_id).await?;
        if has_untargeted_active {
            // An active job with unknown agent targeting blocks everything:
            // we cannot prove any queued message is safe to interleave.
            break;
        }

        // Failed entries block their lane until the user retries or removes
        // them — dispatching a younger message past a failed older one would
        // invert per-agent ordering.
        let entries = connection
            .query(
                &format!(
                    "select {ENTRY_COLUMNS}, user_id
                     from conversation_send_queue
                     where conversation_id = $1
                       and status in ('queued','failed')
                     order by created_at asc"
                ),
                &[&conversation_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load send queue: {error}")))?;

        let mut lane_blocked = active_handles;
        let mut candidate: Option<&tokio_postgres::Row> = None;
        for row in &entries {
            let status: String = row.get("status");
            let targets: Vec<String> = row.get("target_agent_handles");
            if status == "failed" {
                if targets.is_empty() {
                    // An untargeted failed entry blocks the whole queue.
                    break;
                }
                for handle in targets {
                    lane_blocked.insert(handle);
                }
                continue;
            }
            let eligible = if targets.is_empty() {
                lane_blocked.is_empty()
            } else {
                targets.iter().all(|handle| !lane_blocked.contains(handle))
            };
            if eligible {
                candidate = Some(row);
                break;
            }
            if targets.is_empty() {
                // A blocked untargeted entry: nothing after it can be proven
                // safe to reorder past it.
                break;
            }
            // A skipped queued entry blocks its lane to preserve FIFO per
            // target.
            for handle in targets {
                lane_blocked.insert(handle);
            }
        }
        let Some(row) = candidate else {
            break;
        };

        let entry_id: Uuid = row.get("id");
        let user_id: Option<Uuid> = row.get("user_id");
        let claimed = connection
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
            .map_err(|error| internal_error(format!("failed to claim queued message: {error}")))?;
        let Some(claimed) = claimed else {
            // Claimed elsewhere (send-now); recompute and continue.
            continue;
        };

        let message = claimed.get::<_, PgJson<JsonValue>>("request").0;
        // Dispatch under the enqueuer's authority so role changes between
        // enqueue and delivery are re-validated (a viewer demotion must not
        // be bypassable by queueing). Service role only when the enqueuer had
        // no user identity.
        let context = RequestContext {
            user_id,
            is_service_role: user_id.is_none(),
            scoped_claims: None,
        };

        match dispatch_stored_message(
            state,
            &context,
            project_id,
            conversation_id,
            session_id,
            message,
        )
        .await
        {
            Ok(response) => {
                let update_result = if let Some(run_id) = response.run_id {
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
                    Ok(0)
                };
                if let Err(error) = update_result {
                    warn!(entry_id = %entry_id, error = %error, "failed to record dispatched run");
                }
                publish_send_queue_event(
                    state,
                    project_id,
                    session_id,
                    conversation_id,
                    "dispatched",
                    entry_row_to_json(&claimed),
                );
            }
            Err(error) => {
                mark_entry_failed_with(&mut *connection, entry_id, &error).await;
                if let Ok(Some(updated)) = connection
                    .query_opt(
                        &format!(
                            "select {ENTRY_COLUMNS} from conversation_send_queue where id = $1"
                        ),
                        &[&entry_id],
                    )
                    .await
                {
                    publish_send_queue_event(
                        state,
                        project_id,
                        session_id,
                        conversation_id,
                        "failed",
                        entry_row_to_json(&updated),
                    );
                }
            }
        }
    }

    Ok(())
}

/// Active agent handles for a conversation (lowercased), plus whether any
/// active job has no explicit agent targeting (which conservatively blocks
/// the whole queue).
async fn load_active_agent_handles<C>(
    connection: &mut C,
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
        let active = payload
            .get("metadata")
            .and_then(JsonValue::as_object)
            .and_then(|metadata| metadata.get("agentSelection"))
            .and_then(JsonValue::as_object)
            .and_then(|selection| selection.get("active"))
            .and_then(JsonValue::as_array);
        match active {
            Some(values) if !values.is_empty() => {
                for value in values {
                    if let Some(handle) = value.as_str() {
                        let handle = handle.trim().to_ascii_lowercase();
                        if !handle.is_empty() {
                            handles.insert(handle);
                        }
                    }
                }
            }
            _ => {
                has_untargeted = true;
            }
        }
    }
    Ok((handles, has_untargeted))
}
