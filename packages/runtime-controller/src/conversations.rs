use std::str::FromStr;

use axum::extract::{Path as AxumPath, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::Json;
use axum::Router;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::active_job_auth::{
    authorize_active_job_if_scoped, payload_plan_group_id, ActiveJobAuthorization,
    ActiveJobProjectAccess,
};
use crate::auth::{authenticate_request, RequestContext};
use crate::dispatch::{
    process_dispatch_prompt, DispatchPromptNormalized, DispatchPromptRequest,
    DispatchPromptResponse,
};
use crate::workspace::{endpoint_matches_local, runtime_is_recent, status_is_viable};
use crate::{
    bad_request, ensure_project_access, ensure_project_write_access, internal_error, not_found,
    publish_controller_event_with_conversation, runs, ApiError, AppState, EventHub,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationPromptBody {
    pub(crate) session_id: Option<String>,
    pub(crate) prompt_text: String,
    pub(crate) intent: Option<String>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) plan_seed: Option<JsonValue>,
    #[serde(rename = "conversationMetadata", alias = "conversation_metadata")]
    pub(crate) conversation_metadata: Option<JsonValue>,
    #[serde(rename = "parentConversationId", alias = "parent_conversation_id")]
    pub(crate) parent_conversation_id: Option<String>,
    #[serde(rename = "threadKind", alias = "thread_kind")]
    pub(crate) thread_kind: Option<String>,
    #[serde(default)]
    pub(crate) tool_limits: Option<JsonValue>,
    pub(crate) repo: Option<crate::dispatch::DispatchPromptRepo>,
    pub(crate) ui: Option<crate::dispatch::DispatchPromptUi>,
    pub(crate) priority: Option<i32>,
    pub(crate) runtime_type: Option<String>,
    pub(crate) idle_ttl_seconds: Option<u32>,
    #[serde(rename = "runtimeId", alias = "runtime_id")]
    pub(crate) runtime_id: Option<String>,
    #[serde(rename = "runtimeDisplayName", alias = "runtime_display_name")]
    pub(crate) runtime_display_name: Option<String>,
    #[serde(rename = "preferRuntime", alias = "prefer_runtime")]
    pub(crate) prefer_runtime: Option<bool>,
    #[serde(rename = "expectedLaneIdle", alias = "expected_lane_idle")]
    pub(crate) expected_lane_idle: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationCreateBody {
    pub(crate) session_id: Option<String>,
    pub(crate) metadata: Option<JsonValue>,
    #[serde(rename = "parentConversationId", alias = "parent_conversation_id")]
    pub(crate) parent_conversation_id: Option<String>,
    #[serde(rename = "threadKind", alias = "thread_kind")]
    pub(crate) thread_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationCreateResponse {
    pub(crate) conversation_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationRecordMessageBody {
    pub(crate) project_id: Option<Uuid>,
    pub(crate) content: String,
    pub(crate) role: Option<String>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) client_message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationInterruptBody {
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationInterruptResponse {
    pub(crate) ok: bool,
    pub(crate) canceled_run_ids: Vec<String>,
    pub(crate) canceled_job_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationUpdateBody {
    pub(crate) metadata: Option<JsonValue>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationRunsQuery {
    #[serde(default)]
    pub(crate) limit: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectConversationsQuery {
    #[serde(default)]
    pub(crate) limit: Option<i64>,
    #[serde(default, alias = "rootOnly")]
    pub(crate) roots_only: Option<bool>,
    #[serde(default, alias = "parent_conversation_id")]
    pub(crate) parent_conversation_id: Option<String>,
    #[serde(default, alias = "root_conversation_id")]
    pub(crate) root_conversation_id: Option<String>,
    #[serde(default, alias = "thread_kind")]
    pub(crate) thread_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectConversationPayload {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) created_by: Option<Uuid>,
    pub(crate) metadata: JsonValue,
    pub(crate) visibility: String,
    pub(crate) parent_conversation_id: Option<Uuid>,
    pub(crate) root_conversation_id: Option<Uuid>,
    pub(crate) thread_kind: Option<String>,
    pub(crate) last_message_id: Option<Uuid>,
    #[serde(rename = "lastMessageAt")]
    pub(crate) last_message_at: Option<String>,
    pub(crate) last_message_preview: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationMessagesQuery {
    #[serde(default)]
    pub(crate) limit: Option<i64>,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationMessagesPage {
    pub(crate) messages: Vec<ConversationMessagePayload>,
    #[serde(rename = "nextCursor")]
    pub(crate) next_cursor: Option<String>,
    #[serde(rename = "hasMore")]
    pub(crate) has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationMessagePayload {
    pub(crate) id: Uuid,
    pub(crate) conversation_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) created_by: Option<Uuid>,
    pub(crate) prompt_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) metadata: JsonValue,
    pub(crate) created_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct ConversationRecord {
    pub(crate) id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) created_by: Option<Uuid>,
    pub(crate) metadata: Option<JsonValue>,
    pub(crate) visibility: String,
    pub(crate) parent_conversation_id: Option<Uuid>,
    pub(crate) root_conversation_id: Option<Uuid>,
    pub(crate) thread_kind: Option<String>,
    pub(crate) last_message_id: Option<Uuid>,
    pub(crate) last_message_at: Option<DateTime<Utc>>,
    pub(crate) last_message_preview: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) updated_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct ConversationMessageRow {
    pub(crate) id: Uuid,
    pub(crate) conversation_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) created_by: Option<Uuid>,
    pub(crate) prompt_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) metadata: JsonValue,
    pub(crate) created_at: DateTime<Utc>,
}

const CONVERSATION_VISIBILITY_PUBLIC: &str = "public";
const CONVERSATION_VISIBILITY_PRIVATE: &str = "private";

fn parse_conversation_visibility(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case(CONVERSATION_VISIBILITY_PRIVATE) {
        return Some(CONVERSATION_VISIBILITY_PRIVATE);
    }
    if trimmed.eq_ignore_ascii_case(CONVERSATION_VISIBILITY_PUBLIC) {
        return Some(CONVERSATION_VISIBILITY_PUBLIC);
    }
    None
}

fn resolve_conversation_visibility(metadata: &JsonValue) -> &'static str {
    metadata
        .as_object()
        .and_then(|map| map.get("visibility"))
        .and_then(|value| value.as_str())
        .and_then(parse_conversation_visibility)
        .unwrap_or(CONVERSATION_VISIBILITY_PUBLIC)
}

const THREAD_KIND_MAX_LEN: usize = 64;
const LAST_MESSAGE_PREVIEW_MAX_LEN: usize = 240;

pub(crate) fn normalize_thread_kind(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.to_lowercase();
    if normalized.len() > THREAD_KIND_MAX_LEN {
        return Some(normalized.chars().take(THREAD_KIND_MAX_LEN).collect());
    }
    Some(normalized)
}

pub(crate) fn build_conversation_last_message_preview(content: &str) -> String {
    let max_body_len = LAST_MESSAGE_PREVIEW_MAX_LEN.saturating_sub(1);
    let mut output = String::new();
    let mut count = 0usize;
    let mut last_was_space = true;
    let mut truncated = false;

    for ch in content.chars() {
        if ch.is_whitespace() {
            if last_was_space {
                continue;
            }
            if count >= max_body_len {
                truncated = true;
                break;
            }
            output.push(' ');
            count += 1;
            last_was_space = true;
            continue;
        }

        if count >= max_body_len {
            truncated = true;
            break;
        }
        output.push(ch);
        count += 1;
        last_was_space = false;
    }

    let trimmed = output.trim().to_string();
    if trimmed.is_empty() {
        return "".to_string();
    }
    if truncated && trimmed.chars().count() < LAST_MESSAGE_PREVIEW_MAX_LEN {
        return format!("{trimmed}…");
    }
    trimmed
}

async fn resolve_thread_columns(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    parent_conversation_id: Option<Uuid>,
    thread_kind: Option<String>,
    context: &RequestContext,
) -> Result<(Option<Uuid>, Uuid, Option<String>), (StatusCode, Json<ApiError>)> {
    let Some(parent_conversation_id) = parent_conversation_id else {
        if thread_kind.is_some() {
            return Err(bad_request("threadKind requires parentConversationId"));
        }
        return Ok((None, *conversation_id, None));
    };

    if parent_conversation_id == *conversation_id {
        return Err(bad_request(
            "parentConversationId cannot reference the conversation itself",
        ));
    }

    let parent = load_conversation_record(transaction, &parent_conversation_id).await?;
    if parent.project_id != *project_id {
        return Err(crate::forbidden(
            "parent conversation does not belong to this project",
        ));
    }
    ensure_conversation_access(transaction, &parent, context).await?;

    let root_conversation_id = parent.root_conversation_id.unwrap_or(parent.id);
    Ok((
        Some(parent_conversation_id),
        root_conversation_id,
        thread_kind,
    ))
}

pub(crate) async fn ensure_conversation_access(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation: &ConversationRecord,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(());
    }

    if conversation.visibility != CONVERSATION_VISIBILITY_PRIVATE {
        return Ok(());
    }

    let user_id = context
        .user_id
        .ok_or_else(|| crate::unauthorized("authentication required for private conversations"))?;

    if conversation.created_by == Some(user_id) {
        return Ok(());
    }

    let participant = transaction
        .query_opt(
            "select user_id
             from conversation_participants
             where conversation_id = $1 and user_id = $2
             limit 1",
            &[&conversation.id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to verify conversation access: {error}"))
        })?;

    if participant.is_some() {
        return Ok(());
    }

    Err(crate::forbidden(
        "This conversation is private. Ask a participant to invite you.",
    ))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/conversations",
            get(list_project_conversations).post(create_project_conversation),
        )
        .route(
            "/projects/:project_id/conversations/blank",
            post(create_blank_project_conversation),
        )
        .route(
            "/conversations/:conversation_id",
            patch(update_conversation_metadata),
        )
        .route(
            "/conversations/:conversation_id/messages",
            get(list_conversation_messages).post(post_conversation_message),
        )
        .route(
            "/conversations/:conversation_id/interrupt",
            post(interrupt_conversation_runs),
        )
        .route("/jobs/:job_id/cancel", post(cancel_agent_job))
        .route(
            "/jobs/plan-groups/:group_id/cancel",
            post(cancel_plan_group_jobs),
        )
        .route(
            "/conversations/:conversation_id/messages/record",
            post(record_conversation_message_only),
        )
        .route(
            "/conversations/:conversation_id/participation/resolve",
            post(crate::group_participation::resolve_group_participation),
        )
        .route(
            "/conversations/:conversation_id/runs",
            get(list_conversation_runs),
        )
        .route(
            "/conversations/:conversation_id/participants",
            get(list_conversation_participants).post(add_conversation_participant),
        )
}

pub(crate) async fn list_project_conversations(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Query(params): Query<ProjectConversationsQuery>,
) -> Result<Json<Vec<ProjectConversationPayload>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());

    let project = crate::load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &access_context, None).await?;

    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let roots_only = params.roots_only.unwrap_or(false);

    let parent_conversation_id = match params.parent_conversation_id.as_ref() {
        Some(raw) if !raw.trim().is_empty() => Some(
            Uuid::from_str(raw.trim())
                .map_err(|_| bad_request("parentConversationId must be a valid UUID"))?,
        ),
        _ => None,
    };

    let root_conversation_id = match params.root_conversation_id.as_ref() {
        Some(raw) if !raw.trim().is_empty() => Some(
            Uuid::from_str(raw.trim())
                .map_err(|_| bad_request("rootConversationId must be a valid UUID"))?,
        ),
        _ => None,
    };

    let thread_kind = params
        .thread_kind
        .as_deref()
        .and_then(normalize_thread_kind);

    if let Some(parent_id) = parent_conversation_id {
        let parent = load_conversation_record(&transaction, &parent_id).await?;
        if parent.project_id != project_id {
            return Err(crate::forbidden(
                "parent conversation does not belong to this project",
            ));
        }
        if let Some(active_job) = active_job.as_ref() {
            active_job
                .ensure_conversation_read(&transaction, &parent)
                .await?;
        } else {
            ensure_conversation_access(&transaction, &parent, &access_context).await?;
        }
    }

    let root_conversation_id = if let Some(root_id) = root_conversation_id {
        let root = load_conversation_record(&transaction, &root_id).await?;
        if root.project_id != project_id {
            return Err(crate::forbidden(
                "root conversation does not belong to this project",
            ));
        }
        if let Some(active_job) = active_job.as_ref() {
            active_job
                .ensure_conversation_read(&transaction, &root)
                .await?;
        } else {
            ensure_conversation_access(&transaction, &root, &access_context).await?;
        }
        Some(root.root_conversation_id.unwrap_or(root.id))
    } else {
        None
    };

    let select = "select c.id,
                         c.project_id,
                         c.session_id,
                         c.created_by,
                         c.metadata,
                         c.visibility,
                         c.parent_conversation_id,
                         c.root_conversation_id,
                         c.thread_kind,
                         c.last_message_id,
                         c.last_message_at,
                         c.last_message_preview,
                         c.created_at,
                         c.updated_at
                  from conversations c";

    let mut query_params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
    query_params.push(&project_id);
    let mut param_index = 2;

    let mut where_clauses: Vec<String> = Vec::new();
    where_clauses.push("c.project_id = $1".to_string());

    let user_id = access_context.user_id;
    if !access_context.is_service_role {
        if user_id.is_some() {
            let user_param = param_index;
            param_index += 1;
            query_params.push(&user_id);
            where_clauses.push(format!(
                "(c.visibility <> 'private'
                  or c.created_by = ${user_param}
                  or exists (
                    select 1
                    from conversation_participants p
                    where p.conversation_id = c.id and p.user_id = ${user_param}
                  ))"
            ));
        } else {
            where_clauses.push("c.visibility <> 'private'".to_string());
        }
    }

    if let Some(active_job) = active_job.as_ref() {
        let root_param = param_index;
        param_index += 1;
        query_params.push(&active_job.root_conversation_id);
        where_clauses.push(format!(
            "(c.visibility <> 'private' or coalesce(c.root_conversation_id, c.id) = ${root_param})"
        ));
    }

    if parent_conversation_id.is_some() {
        where_clauses.push(format!("c.parent_conversation_id = ${param_index}"));
        query_params.push(&parent_conversation_id);
        param_index += 1;
    } else if roots_only {
        where_clauses.push("c.parent_conversation_id is null".to_string());
    }

    if root_conversation_id.is_some() {
        where_clauses.push(format!("c.root_conversation_id = ${param_index}"));
        query_params.push(&root_conversation_id);
        param_index += 1;
    }

    if let Some(thread_kind) = thread_kind.as_ref() {
        where_clauses.push(format!("c.thread_kind = ${param_index}"));
        query_params.push(thread_kind);
        param_index += 1;
    }

    let limit_param = param_index;
    query_params.push(&limit);
    let query = format!(
        "{select}
         where {}
         order by c.updated_at desc, c.id desc
         limit ${limit_param}",
        where_clauses.join(" and ")
    );

    let rows = transaction
        .query(&query, &query_params)
        .await
        .map_err(|error| internal_error(format!("failed to list conversations: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit project conversation query: {error}"
        ))
    })?;

    let payload = rows
        .into_iter()
        .map(|row| map_conversation_row(&row))
        .filter(|conversation| {
            active_job
                .as_ref()
                .map(|job| job.can_list_conversation(conversation))
                .unwrap_or(true)
        })
        .map(|conversation| ProjectConversationPayload {
            id: conversation.id,
            project_id: conversation.project_id,
            session_id: conversation.session_id,
            created_by: conversation.created_by,
            metadata: conversation.metadata.unwrap_or_else(|| json!({})),
            visibility: conversation.visibility,
            parent_conversation_id: conversation.parent_conversation_id,
            root_conversation_id: conversation.root_conversation_id,
            thread_kind: conversation.thread_kind,
            last_message_id: conversation.last_message_id,
            last_message_at: conversation.last_message_at.map(|value| value.to_rfc3339()),
            last_message_preview: conversation.last_message_preview,
            created_at: conversation.created_at.to_rfc3339(),
            updated_at: conversation.updated_at.to_rfc3339(),
        })
        .collect();

    Ok(Json(payload))
}

pub(crate) async fn create_project_conversation(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    axum::Json(mut body): axum::Json<ConversationPromptBody>,
) -> Result<Json<DispatchPromptResponse>, (StatusCode, Json<ApiError>)> {
    let has_auth = headers.contains_key(axum::http::header::AUTHORIZATION);
    tracing::info!(
        ?project_id_raw,
        has_auth,
        "create_project_conversation received"
    );
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    if body.runtime_id.is_some() && body.prefer_runtime.is_none() {
        body.prefer_runtime = Some(true);
    }

    let conversation_id = Uuid::new_v4();
    let dispatch_request =
        build_dispatch_request_from_conversation(&project_id, Some(&conversation_id), body);
    let mut request = crate::dispatch::normalize_dispatch_request(dispatch_request)?;

    if request.conversation_id.is_none() {
        request.conversation_id = Some(conversation_id);
        request.conversation_raw = Some(conversation_id.to_string());
    }

    request.conversation_is_new = true;

    if let Some(conversation_id) = request.conversation_id {
        inject_conversation_metadata(&mut request.metadata, &conversation_id);
    }

    let response = process_dispatch_prompt(&state, &context, request).await?;
    Ok(Json(response))
}

pub(crate) async fn create_blank_project_conversation(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<ConversationCreateBody>,
) -> Result<Json<ConversationCreateResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let session_id = if let Some(raw) = body.session_id.as_ref() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(
                Uuid::from_str(trimmed)
                    .map_err(|_| bad_request("sessionId must be a valid UUID"))?,
            )
        }
    } else {
        None
    };

    let mut metadata_value = match body.metadata {
        Some(JsonValue::Object(map)) => JsonValue::Object(map),
        _ => json!({}),
    };
    let thread_parent_id = match body.parent_conversation_id.as_ref() {
        Some(raw) if !raw.trim().is_empty() => Some(
            Uuid::from_str(raw.trim())
                .map_err(|_| bad_request("parentConversationId must be a valid UUID"))?,
        ),
        _ => None,
    };
    let thread_kind = body.thread_kind.as_deref().and_then(normalize_thread_kind);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());

    let project = crate::load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &access_context, session_id).await?;

    if let Some(active_job) = active_job.as_ref() {
        let parent_id = thread_parent_id.ok_or_else(|| {
            crate::forbidden("job token can only create a root-linked child conversation")
        })?;
        let parent = load_conversation_record(&transaction, &parent_id).await?;
        active_job
            .ensure_conversation_write(&transaction, &parent)
            .await?;
        if active_job.requires_private_child(&parent) {
            if let JsonValue::Object(metadata) = &mut metadata_value {
                metadata.insert(
                    "visibility".to_string(),
                    JsonValue::String(CONVERSATION_VISIBILITY_PRIVATE.to_string()),
                );
            }
        }
    }

    let visibility_value = resolve_conversation_visibility(&metadata_value).to_string();
    let metadata_param = PgJson(&metadata_value);
    if visibility_value == CONVERSATION_VISIBILITY_PRIVATE
        && !access_context.is_service_role
        && access_context.user_id.is_none()
    {
        return Err(crate::unauthorized(
            "authentication required for private conversations",
        ));
    }

    let conversation_id = Uuid::new_v4();
    let (parent_conversation_id, root_conversation_id, thread_kind) = resolve_thread_columns(
        &transaction,
        &project_id,
        &conversation_id,
        thread_parent_id,
        thread_kind,
        &access_context,
    )
    .await?;
    let inserted = transaction
        .query_one(
            "insert into conversations (
                 id,
                 project_id,
                 session_id,
                 created_by,
                 metadata,
                 visibility,
                 parent_conversation_id,
                 root_conversation_id,
                 thread_kind
             ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
             returning id,
                       project_id,
                       session_id,
                       created_by,
                       metadata,
                       visibility,
                       parent_conversation_id,
                       root_conversation_id,
                       thread_kind,
                       last_message_id,
                       last_message_at,
                       last_message_preview,
                       created_at,
                       updated_at",
            &[
                &conversation_id,
                &project_id,
                &session_id,
                &access_context.user_id,
                &metadata_param,
                &visibility_value,
                &parent_conversation_id,
                &root_conversation_id,
                &thread_kind,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert conversation: {error}")))?;
    let conversation = map_conversation_row(&inserted);

    if let Some(user_id) = access_context.user_id {
        transaction
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'owner', $3)
                 on conflict (conversation_id, user_id) do nothing",
                &[&conversation.id, &user_id, &access_context.user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to add conversation participant: {error}"))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize conversation insert: {error}"))
    })?;

    let payload = json!({
        "conversationId": conversation.id,
        "projectId": conversation.project_id,
        "sessionId": conversation.session_id,
        "createdBy": conversation.created_by,
        "metadata": conversation.metadata.clone().unwrap_or_else(|| json!({})),
        "visibility": conversation.visibility,
        "parentConversationId": conversation.parent_conversation_id,
        "rootConversationId": conversation.root_conversation_id,
        "threadKind": conversation.thread_kind,
        "lastMessageId": conversation.last_message_id,
        "lastMessageAt": conversation.last_message_at.map(|value| value.to_rfc3339()),
        "lastMessagePreview": conversation.last_message_preview,
        "createdAt": conversation.created_at.to_rfc3339(),
        "updatedAt": conversation.updated_at.to_rfc3339(),
    });
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.created",
        Some(conversation.project_id),
        conversation.session_id,
        Some(conversation.id),
        None,
        None,
        payload,
    );

    Ok(Json(ConversationCreateResponse { conversation_id }))
}

pub(crate) async fn update_conversation_metadata(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<ConversationUpdateBody>,
) -> Result<Json<ProjectConversationPayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;

    let metadata_value = match body.metadata {
        Some(JsonValue::Object(map)) => JsonValue::Object(map),
        Some(_) => return Err(bad_request("metadata must be a JSON object")),
        None => return Err(bad_request("metadata is required")),
    };

    let metadata_param = PgJson(&metadata_value);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let existing = transaction
        .query_opt(
            "select id,
                    project_id,
                    session_id,
                    created_by,
                    metadata,
                    visibility,
                    parent_conversation_id,
                    root_conversation_id,
                    thread_kind,
                    last_message_id,
                    last_message_at,
                    last_message_preview,
                    created_at,
                    updated_at
             from conversations
             where id = $1
             for update",
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load conversation: {error}")))?;

    let Some(existing) = existing else {
        return Err(not_found("conversation not found"));
    };

    let existing = map_conversation_row(&existing);
    let project = crate::load_project_record(&transaction, &existing.project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, existing.session_id).await?;
    ensure_conversation_access(&transaction, &existing, &context).await?;

    if let Some(map) = metadata_value.as_object() {
        if let Some(raw) = map.get("visibility").and_then(|value| value.as_str()) {
            if let Some(parsed) = parse_conversation_visibility(raw) {
                if parsed != existing.visibility {
                    return Err(bad_request("visibility cannot be changed after creation"));
                }
            }
        }
    }

    let updated = transaction
        .query_one(
            "update conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
                 updated_at = now()
             where id = $1
             returning id,
                       project_id,
                       session_id,
                       created_by,
                       metadata,
                       visibility,
                       parent_conversation_id,
                       root_conversation_id,
                       thread_kind,
                       last_message_id,
                       last_message_at,
                       last_message_preview,
                       created_at,
                       updated_at",
            &[&conversation_id, &metadata_param],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update conversation: {error}")))?;
    let updated = map_conversation_row(&updated);

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize conversation update: {error}"))
    })?;

    let payload = json!({
        "conversationId": updated.id,
        "projectId": updated.project_id,
        "sessionId": updated.session_id,
        "createdBy": updated.created_by,
        "metadata": updated.metadata.clone().unwrap_or_else(|| json!({})),
        "visibility": updated.visibility,
        "parentConversationId": updated.parent_conversation_id,
        "rootConversationId": updated.root_conversation_id,
        "threadKind": updated.thread_kind,
        "lastMessageId": updated.last_message_id,
        "lastMessageAt": updated.last_message_at.map(|value| value.to_rfc3339()),
        "lastMessagePreview": updated.last_message_preview,
        "createdAt": updated.created_at.to_rfc3339(),
        "updatedAt": updated.updated_at.to_rfc3339(),
    });
    publish_controller_event_with_conversation(
        &state.events,
        "conversation.updated",
        Some(updated.project_id),
        updated.session_id,
        Some(updated.id),
        None,
        None,
        payload,
    );

    Ok(Json(ProjectConversationPayload {
        id: updated.id,
        project_id: updated.project_id,
        session_id: updated.session_id,
        created_by: updated.created_by,
        metadata: updated.metadata.unwrap_or_else(|| json!({})),
        visibility: updated.visibility,
        parent_conversation_id: updated.parent_conversation_id,
        root_conversation_id: updated.root_conversation_id,
        thread_kind: updated.thread_kind,
        last_message_id: updated.last_message_id,
        last_message_at: updated.last_message_at.map(|value| value.to_rfc3339()),
        last_message_preview: updated.last_message_preview,
        created_at: updated.created_at.to_rfc3339(),
        updated_at: updated.updated_at.to_rfc3339(),
    }))
}

fn strip_reserved_controller_notice_claims(value: &mut JsonValue) -> bool {
    let Some(map) = value.as_object_mut() else {
        return false;
    };
    let normalized = |value: Option<&JsonValue>| {
        value
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
    };
    let source_is_controller = normalized(map.get("source")).as_deref() == Some("controller");
    let reserved_kind = normalized(map.get("kind"))
        .is_some_and(|value| matches!(value.as_str(), "runtime_alert" | "run_cancellation"));
    let reserved_message_type =
        normalized(map.get("messageType").or_else(|| map.get("message_type")))
            .is_some_and(|value| matches!(value.as_str(), "runtime_alert" | "run_cancellation"));
    let mut nested_reserved = false;
    for key in ["details", "prompt_metadata", "promptMetadata"] {
        nested_reserved |= map
            .get_mut(key)
            .is_some_and(strip_reserved_controller_notice_claims);
    }
    let reserved_group_participation = map.remove("groupParticipation").is_some()
        | map.remove("group_participation").is_some()
        | map.remove("groupAiParticipants").is_some()
        | map.remove("group_ai_participants").is_some();
    let reserved = source_is_controller
        || reserved_kind
        || reserved_message_type
        || reserved_group_participation
        || nested_reserved;
    if source_is_controller || reserved_kind || reserved_message_type {
        map.remove("source");
        map.remove("kind");
        map.remove("messageType");
        map.remove("message_type");
        map.remove("agent");
    }
    reserved
}

// Dispatch-path parity with `sanitize_client_recorded_message_metadata`:
// gate-bypassing dispatches (e.g. explicit @octo) must not smuggle a forged
// controller participation marker into persisted prompt/message metadata. The
// controller re-stamps its own resolution for ambient turns after this strip.
pub(crate) fn strip_client_group_participation_claims(value: &mut JsonValue) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.remove("groupParticipation");
    map.remove("group_participation");
    // The AI-participant roster delivered with ambient evaluations is
    // controller-authored: dispatch re-stamps it per evaluation job, and a
    // client-supplied copy must not ride a direct dispatch into job payloads.
    map.remove("groupAiParticipants");
    map.remove("group_ai_participants");
    for key in ["details", "prompt_metadata", "promptMetadata"] {
        if let Some(nested) = map.get_mut(key) {
            strip_client_group_participation_claims(nested);
        }
    }
}

pub(crate) fn sanitize_client_recorded_message_metadata(
    mut metadata: JsonValue,
    trusted_service_role: bool,
) -> JsonValue {
    if trusted_service_role {
        return metadata;
    }
    let reserved = strip_reserved_controller_notice_claims(&mut metadata);
    if reserved {
        let Some(map) = metadata.as_object_mut() else {
            return json!({});
        };
        map.remove("source");
        map.remove("kind");
        map.remove("messageType");
        map.remove("message_type");
        map.remove("agent");
    }
    metadata
}

pub(crate) async fn record_conversation_message_only(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<ConversationRecordMessageBody>,
) -> Result<Json<ConversationMessagePayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;

    let content = body.content.trim().to_string();
    if content.is_empty() {
        return Err(bad_request("content is required"));
    }

    let role = match body
        .role
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
    {
        Some(value) if value == "assistant" => "assistant".to_string(),
        Some(value) if value == "user" || value.is_empty() => "user".to_string(),
        Some(_) => return Err(bad_request("role must be `user` or `assistant`")),
        None => "user".to_string(),
    };

    let metadata_value = match body.metadata {
        Some(JsonValue::Object(map)) => JsonValue::Object(map),
        _ => json!({}),
    };
    let metadata_value =
        sanitize_client_recorded_message_metadata(metadata_value, context.is_service_role);
    let client_message_id = body
        .client_message_id
        .as_deref()
        .and_then(normalize_client_message_id)
        .or_else(|| extract_client_message_id_from_metadata(&metadata_value));
    let metadata_value = match client_message_id.as_deref() {
        Some(value) => with_client_message_id_metadata(metadata_value, value),
        None => metadata_value,
    };
    let metadata_param = PgJson(&metadata_value);

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
    ensure_conversation_access(&transaction, &conversation, &context).await?;
    if body
        .project_id
        .is_some_and(|expected_project_id| expected_project_id != conversation.project_id)
    {
        return Err(bad_request(
            "conversation does not belong to the requested project",
        ));
    }

    if let Some(client_message_id) = client_message_id.as_deref() {
        let advisory_lock_key =
            conversation_message_idempotency_lock_key(&conversation_id, client_message_id);
        transaction
            .query_one("select pg_advisory_xact_lock($1)", &[&advisory_lock_key])
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to acquire conversation message idempotency lock: {error}"
                ))
            })?;

        if let Some(existing) = find_conversation_message_by_client_message_id(
            &transaction,
            &conversation_id,
            client_message_id,
        )
        .await?
        {
            ensure_conversation_message_idempotency_match(
                &existing,
                context.user_id,
                &role,
                &content,
            )?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize conversation message lookup: {error}"
                ))
            })?;
            return Ok(Json(message_row_to_payload(&existing)));
        }
    }

    let message_id = Uuid::new_v4();
    let row = transaction
        .query_one(
            "insert into conversation_messages (
                 id,
                 conversation_id,
                 project_id,
                 session_id,
                 prompt_id,
                 run_id,
                 role,
                 content,
                 metadata,
                 created_by
             ) values ($1, $2, $3, $4, null, null, $5, $6, $7::jsonb, $8)
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
            &[
                &message_id,
                &conversation_id,
                &project.id,
                &conversation.session_id,
                &role,
                &content,
                &metadata_param,
                &context.user_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to insert conversation message: {error}"))
        })?;

    let last_message_preview = build_conversation_last_message_preview(&content);
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
            internal_error(format!("failed to bump conversation timestamp: {error}"))
        })?;

    if let Some(root_id) = conversation
        .root_conversation_id
        .filter(|value| value != &conversation.id)
    {
        transaction
            .execute(
                "update conversations set updated_at = now() where id = $1",
                &[&root_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to bump root conversation timestamp: {error}"
                ))
            })?;
    }

    if let Some(user_id) = context.user_id {
        transaction
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'member', $3)
                 on conflict (conversation_id, user_id) do nothing",
                &[&conversation_id, &user_id, &context.user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to add conversation participant: {error}"))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize conversation message insert: {error}"
        ))
    })?;

    let message = map_conversation_message_row(&row);
    publish_conversation_message_event(&state.events, &message);
    crate::notifications::enqueue_message_push_notifications(state.clone(), message.clone());
    Ok(Json(message_row_to_payload(&message)))
}

fn normalize_client_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn extract_client_message_id_from_metadata(metadata: &JsonValue) -> Option<String> {
    let JsonValue::Object(map) = metadata else {
        return None;
    };

    let direct = ["clientMessageId", "client_message_id"]
        .iter()
        .find_map(|key| map.get(*key).and_then(JsonValue::as_str));
    if let Some(value) = direct.and_then(normalize_client_message_id) {
        return Some(value);
    }

    ["prompt_metadata", "promptMetadata"]
        .iter()
        .filter_map(|key| map.get(*key))
        .find_map(extract_client_message_id_from_metadata)
}

fn controller_enforced_silent_group_participation(metadata: &JsonValue) -> Option<&JsonValue> {
    let participation = metadata.get("groupParticipation")?;
    let is_silent = participation.get("decision").and_then(JsonValue::as_str) == Some("silent");
    let is_controller_enforced =
        participation.get("enforcedBy").and_then(JsonValue::as_str) == Some("runtime-controller");
    (is_silent && is_controller_enforced).then_some(participation)
}

/// Controller-stamped participation markers that must surface at the top level
/// of the persisted user message: record-only silences and skill-mode
/// agent-evaluation dispatches (the latter lets clients render the turn as
/// silent-until-speaking).
fn controller_enforced_group_participation_marker(metadata: &JsonValue) -> Option<&JsonValue> {
    let participation = metadata.get("groupParticipation")?;
    let is_controller_enforced =
        participation.get("enforcedBy").and_then(JsonValue::as_str) == Some("runtime-controller");
    let decision = participation.get("decision").and_then(JsonValue::as_str);
    (is_controller_enforced
        && matches!(
            decision,
            Some("silent") | Some(crate::group_participation::AGENT_EVALUATION_DECISION)
        ))
    .then_some(participation)
}

pub(crate) fn is_controller_enforced_silent_group_message(metadata: &JsonValue) -> bool {
    controller_enforced_silent_group_participation(metadata).is_some()
}

pub(crate) async fn persist_controller_enforced_group_participation(
    transaction: &tokio_postgres::Transaction<'_>,
    message: &ConversationMessageRow,
    request_metadata: &JsonValue,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    let Some(participation) =
        controller_enforced_silent_group_participation(request_metadata).cloned()
    else {
        return Err(internal_error(
            "ambient human-only result omitted its controller participation marker",
        ));
    };
    let participation = PgJson(participation);
    let row = transaction
        .query_opt(
            "update conversation_messages
             set metadata = jsonb_set(
                   coalesce(metadata, '{}'::jsonb),
                   '{groupParticipation}',
                   $4::jsonb,
                   true
                 )
             where id = $1
               and conversation_id = $2
               and project_id = $3
               and run_id is null
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
            &[
                &message.id,
                &message.conversation_id,
                &message.project_id,
                &participation,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to persist controller participation marker: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(internal_error(
            "ambient human-only message was not available for idempotency marking",
        ));
    };
    Ok(map_conversation_message_row(&row))
}

fn with_client_message_id_metadata(metadata: JsonValue, client_message_id: &str) -> JsonValue {
    let mut map = match metadata {
        JsonValue::Object(map) => map,
        _ => JsonMap::new(),
    };
    map.insert(
        "clientMessageId".to_string(),
        JsonValue::String(client_message_id.to_string()),
    );
    JsonValue::Object(map)
}

pub(crate) fn conversation_message_idempotency_lock_key(
    conversation_id: &Uuid,
    client_message_id: &str,
) -> i64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in conversation_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for byte in client_message_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    i64::from_ne_bytes(hash.to_ne_bytes())
}

pub(crate) async fn find_conversation_message_by_client_message_id(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    client_message_id: &str,
) -> Result<Option<ConversationMessageRow>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id,
                    conversation_id,
                    project_id,
                    session_id,
                    created_by,
                    prompt_id,
                    run_id,
                    role,
                    content,
                    metadata,
                    created_at
             from conversation_messages
             where conversation_id = $1
               and coalesce(
                     metadata->>'clientMessageId',
                     metadata->>'client_message_id',
                     metadata#>>'{prompt_metadata,clientMessageId}',
                     metadata#>>'{prompt_metadata,client_message_id}',
                     metadata#>>'{promptMetadata,clientMessageId}',
                     metadata#>>'{promptMetadata,client_message_id}'
                   ) = $2
             order by created_at desc
             limit 1",
            &[conversation_id, &client_message_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to look up conversation message by client id: {error}"
            ))
        })?;

    Ok(row.map(|value| map_conversation_message_row(&value)))
}

pub(crate) fn ensure_conversation_message_idempotency_match(
    existing: &ConversationMessageRow,
    expected_created_by: Option<Uuid>,
    expected_role: &str,
    expected_content: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    // Service-role messages are authored with `created_by = null`; human
    // requests carry their authenticated user id. A client id is reusable only
    // for the exact same author's exact same logical message.
    if existing.created_by == expected_created_by
        && existing.role == expected_role
        && existing.content == expected_content
    {
        return Ok(());
    }
    Err((
        StatusCode::CONFLICT,
        Json(ApiError::new(
            "clientMessageId is already bound to a different message",
        )),
    ))
}

pub(crate) async fn interrupt_conversation_runs(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<ConversationInterruptBody>,
) -> Result<Json<ConversationInterruptResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;

    let reason = body
        .reason
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("Canceled");

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
    ensure_conversation_access(&transaction, &conversation, &context).await?;

    let conversation_raw = conversation.id.to_string();
    let rows = transaction
        .query(
            "select id, run_id
             from agent_jobs
             where project_id = $1
               and (
                     conversation_id = $2
                     or payload->>'conversation_id' = $3
                   )
               and status in ('queued','leased')
             order by created_at desc",
            &[
                &conversation.project_id,
                &conversation.id,
                &conversation_raw,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load active agent jobs: {error}")))?;

    if rows.is_empty() {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finalize interruption transaction: {error}"
            ))
        })?;
        return Ok(Json(ConversationInterruptResponse {
            ok: true,
            canceled_run_ids: Vec::new(),
            canceled_job_ids: Vec::new(),
        }));
    }

    let jobs: Vec<(Uuid, Option<Uuid>)> = rows
        .iter()
        .map(|row| (row.get("id"), row.get("run_id")))
        .collect();

    let cancellation = cancel_jobs_within_transaction(
        &transaction,
        &conversation.project_id,
        &conversation.id,
        conversation.session_id,
        &jobs,
        reason,
    )
    .await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize interruption transaction: {error}"
        ))
    })?;

    let canceled_run_ids = publish_job_cancellation_events(
        &state,
        &mut *connection,
        conversation.project_id,
        conversation.id,
        &cancellation,
        reason,
    )
    .await;

    crate::send_queue::spawn_send_queue_drain(state.clone(), conversation.id);
    crate::multi_agent_plan::spawn_plan_group_checkpoints_after_cancellation(
        state.clone(),
        cancellation.job_ids.clone(),
    );

    Ok(Json(ConversationInterruptResponse {
        ok: true,
        canceled_run_ids,
        canceled_job_ids: cancellation.job_ids.iter().map(Uuid::to_string).collect(),
    }))
}

pub(crate) struct JobCancellationSet {
    pub(crate) job_ids: Vec<Uuid>,
    pub(crate) pairs: Vec<(Uuid, Uuid)>,
    pub(crate) notice: ConversationMessageRow,
    pub(crate) job_input_state_updates: Vec<crate::send_intents::JobInputStateUpdate>,
}

pub(crate) async fn cancel_jobs_within_transaction(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    session_id: Option<Uuid>,
    jobs: &[(Uuid, Option<Uuid>)],
    reason: &str,
) -> Result<JobCancellationSet, (StatusCode, Json<ApiError>)> {
    let mut job_ids: Vec<Uuid> = Vec::new();
    let mut run_ids: Vec<Uuid> = Vec::new();
    let mut pairs: Vec<(Uuid, Uuid)> = Vec::new();
    for (job_id, run_id) in jobs {
        job_ids.push(*job_id);
        if let Some(run_id) = run_id {
            run_ids.push(*run_id);
            pairs.push((*job_id, *run_id));
        }
    }

    let summary_ref: Option<&str> = Some(reason);

    transaction
        .execute(
            "update agent_jobs
             set status = 'canceled',
                 outcome = 'canceled',
                 summary = coalesce(summary, $2),
                 completed_at = now(),
                 lease_expires_at = null,
                 active_input_ready_runtime_id = null,
                 active_input_ready_expires_at = null,
                 active_input_ready_turn_id = null,
                 heartbeat_at = now()
             where id = any($1)",
            &[&job_ids, &summary_ref],
        )
        .await
        .map_err(|error| internal_error(format!("failed to cancel agent jobs: {error}")))?;

    let mut job_input_state_updates = Vec::new();
    for job_id in &job_ids {
        job_input_state_updates.extend(
            crate::send_intents::reject_unacknowledged_inputs_for_job(
                transaction,
                job_id,
                "agent job was canceled before input acknowledgement",
            )
            .await?,
        );
    }

    if !run_ids.is_empty() {
        transaction
            .execute(
                "update runs
                 set status = 'canceled',
                     last_message = $2,
                     updated_at = now()
                 where id = any($1)",
                &[&run_ids, &reason],
            )
            .await
            .map_err(|error| internal_error(format!("failed to cancel runs: {error}")))?;
        persist_canceled_run_metadata(transaction, &run_ids, reason).await?;
    }

    let interruption_notice = build_interruption_notice(reason, &job_ids, &run_ids);
    let notice = record_controller_assistant_message(
        transaction,
        project_id,
        conversation_id,
        session_id,
        None,
        run_ids.first().copied(),
        interruption_notice.content.as_str(),
        &interruption_notice.metadata,
    )
    .await?;

    Ok(JobCancellationSet {
        job_ids,
        pairs,
        notice,
        job_input_state_updates,
    })
}

pub(crate) async fn publish_job_cancellation_events<C>(
    state: &AppState,
    connection: &mut C,
    project_id: Uuid,
    conversation_id: Uuid,
    cancellation: &JobCancellationSet,
    reason: &str,
) -> Vec<String>
where
    C: tokio_postgres::GenericClient + Send,
{
    let canceled_run_ids = publish_job_run_cancellation_events(
        state,
        connection,
        project_id,
        conversation_id,
        &cancellation.pairs,
        reason,
    )
    .await;

    publish_conversation_message_event(&state.events, &cancellation.notice);
    crate::notifications::enqueue_message_push_notifications(
        state.clone(),
        cancellation.notice.clone(),
    );
    crate::send_intents::publish_job_input_state_updates(
        state,
        &cancellation.job_input_state_updates,
    );

    canceled_run_ids
}

/// Publish the standard terminal run events for a narrowly selected set of
/// canceled jobs without creating a controller interruption message.
pub(crate) async fn publish_job_run_cancellation_events<C>(
    state: &AppState,
    connection: &mut C,
    project_id: Uuid,
    conversation_id: Uuid,
    pairs: &[(Uuid, Uuid)],
    reason: &str,
) -> Vec<String>
where
    C: tokio_postgres::GenericClient + Send,
{
    let mut canceled_run_ids: Vec<String> = Vec::new();
    for (job_id, run_id) in pairs.iter().copied() {
        canceled_run_ids.push(run_id.to_string());

        let (event_session, run_payload) = match runs::load_run_snapshot(connection, &run_id).await
        {
            Ok(Some(snapshot)) => (snapshot.session_id, runs::run_snapshot_to_json(&snapshot)),
            Ok(None) => (None, JsonValue::Null),
            Err((status, Json(api_error))) => {
                tracing::warn!(
                    run_id = %run_id,
                    status = status.as_u16(),
                    error = %api_error.message,
                    "failed to load run snapshot after cancellation"
                );
                (None, JsonValue::Null)
            }
        };

        publish_controller_event_with_conversation(
            &state.events,
            "run.completed",
            Some(project_id),
            event_session,
            Some(conversation_id),
            Some(run_id),
            Some(job_id),
            json!({
                "outcome": "canceled",
                "finalStatus": "canceled",
                "runStatus": "canceled",
                "summary": reason,
                "errorMessage": null,
                "artifactsCount": null,
                "provider": null,
                "creditSnapshot": null,
                "run": run_payload,
            }),
        );
    }

    canceled_run_ids
}

pub(crate) async fn cancel_agent_job(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(job_id_raw): AxumPath<String>,
    body: Option<axum::Json<ConversationInterruptBody>>,
) -> Result<Json<ConversationInterruptResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let job_id =
        Uuid::from_str(job_id_raw.trim()).map_err(|_| bad_request("jobId must be a valid UUID"))?;
    let reason = body
        .as_ref()
        .and_then(|body| body.reason.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Canceled")
        .to_string();

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());

    let row = transaction
        .query_opt(
            "select id, project_id, run_id, status, conversation_id, payload, plan_group_id
             from agent_jobs
             where id = $1",
            &[&job_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent job: {error}")))?;
    let Some(row) = row else {
        return Err(not_found("agent job not found"));
    };

    let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
    let conversation_id = row
        .get::<_, Option<Uuid>>("conversation_id")
        .or_else(|| {
            payload
                .get("conversation_id")
                .and_then(JsonValue::as_str)
                .and_then(|value| Uuid::from_str(value.trim()).ok())
        })
        .ok_or_else(|| bad_request("agent job is not bound to a conversation"))?;

    if let Some(active_job) = active_job.as_ref() {
        let target_project_id: Uuid = row.get("project_id");
        let target_plan_group_id = row
            .get::<_, Option<Uuid>>("plan_group_id")
            .or_else(|| payload_plan_group_id(&payload));
        active_job.ensure_cancel_target(
            &job_id,
            &target_project_id,
            Some(conversation_id),
            target_plan_group_id,
        )?;
    }

    let conversation = load_conversation_record(&transaction, &conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_write_access(
        &transaction,
        &project,
        &access_context,
        conversation.session_id,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job
            .ensure_conversation_write(&transaction, &conversation)
            .await?;
    } else {
        ensure_conversation_access(&transaction, &conversation, &access_context).await?;
    }

    let status: String = row.get("status");
    if !matches!(status.as_str(), "queued" | "leased") {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to finalize cancel: {error}")))?;
        return Ok(Json(ConversationInterruptResponse {
            ok: true,
            canceled_run_ids: Vec::new(),
            canceled_job_ids: Vec::new(),
        }));
    }

    let run_id: Option<Uuid> = row.get("run_id");
    let cancellation = cancel_jobs_within_transaction(
        &transaction,
        &conversation.project_id,
        &conversation.id,
        conversation.session_id,
        &[(job_id, run_id)],
        reason.as_str(),
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize cancel: {error}")))?;

    let canceled_run_ids = publish_job_cancellation_events(
        &state,
        &mut *connection,
        conversation.project_id,
        conversation.id,
        &cancellation,
        reason.as_str(),
    )
    .await;

    crate::send_queue::spawn_send_queue_drain(state.clone(), conversation.id);
    crate::multi_agent_plan::spawn_plan_group_checkpoints_after_cancellation(
        state.clone(),
        cancellation.job_ids.clone(),
    );

    Ok(Json(ConversationInterruptResponse {
        ok: true,
        canceled_run_ids,
        canceled_job_ids: cancellation.job_ids.iter().map(Uuid::to_string).collect(),
    }))
}

pub(crate) async fn cancel_plan_group_jobs(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(group_id_raw): AxumPath<String>,
    body: Option<axum::Json<ConversationInterruptBody>>,
) -> Result<Json<ConversationInterruptResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let group_id_raw = group_id_raw.trim().to_string();
    let group_id = Uuid::from_str(group_id_raw.as_str())
        .map_err(|_| bad_request("groupId must be a valid UUID"))?;
    let reason = body
        .as_ref()
        .and_then(|body| body.reason.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Canceled")
        .to_string();

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_plan_group(&group_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());

    // Prefer the indexed column; only fall back to the payload path for rows
    // that predate the hierarchy columns.
    let mut rows = transaction
        .query(
            "select id, project_id, run_id, conversation_id
             from agent_jobs
             where plan_group_id = $1
               and status in ('queued','leased')
             order by created_at asc",
            &[&group_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load plan-group jobs: {error}")))?;
    if rows.is_empty() {
        rows = transaction
            .query(
                "select id, project_id, run_id, conversation_id
                 from agent_jobs
                 where (
                       payload #>> '{metadata,multiAgentPlan,groupId}' = $1
                    or payload #>> '{metadata,multiAgentPlan,group_id}' = $1
                    or payload #>> '{metadata,multi_agent_plan,groupId}' = $1
                    or payload #>> '{metadata,multi_agent_plan,group_id}' = $1
                 )
                   and status in ('queued','leased')
                 order by created_at asc",
                &[&group_id_raw],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load plan-group jobs: {error}")))?;
    }

    if let Some(active_job) = active_job.as_ref() {
        rows.retain(|row| {
            row.get::<_, Uuid>("project_id") == active_job.project_id
                && row.get::<_, Option<Uuid>>("conversation_id") == Some(active_job.conversation_id)
        });
    }

    if rows.is_empty() {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to finalize cancel: {error}")))?;
        return Ok(Json(ConversationInterruptResponse {
            ok: true,
            canceled_run_ids: Vec::new(),
            canceled_job_ids: Vec::new(),
        }));
    }

    let conversation_id = rows
        .iter()
        .find_map(|row| row.get::<_, Option<Uuid>>("conversation_id"))
        .ok_or_else(|| bad_request("plan-group jobs are not bound to a conversation"))?;

    let conversation = load_conversation_record(&transaction, &conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_write_access(
        &transaction,
        &project,
        &access_context,
        conversation.session_id,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job
            .ensure_conversation_write(&transaction, &conversation)
            .await?;
    } else {
        ensure_conversation_access(&transaction, &conversation, &access_context).await?;
    }

    let jobs: Vec<(Uuid, Option<Uuid>)> = rows
        .iter()
        .filter(|row| row.get::<_, Option<Uuid>>("conversation_id") == Some(conversation.id))
        .map(|row| (row.get("id"), row.get("run_id")))
        .collect();

    if jobs.is_empty() {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to finalize cancel: {error}")))?;
        return Ok(Json(ConversationInterruptResponse {
            ok: true,
            canceled_run_ids: Vec::new(),
            canceled_job_ids: Vec::new(),
        }));
    }

    let cancellation = cancel_jobs_within_transaction(
        &transaction,
        &conversation.project_id,
        &conversation.id,
        conversation.session_id,
        &jobs,
        reason.as_str(),
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize cancel: {error}")))?;

    let canceled_run_ids = publish_job_cancellation_events(
        &state,
        &mut *connection,
        conversation.project_id,
        conversation.id,
        &cancellation,
        reason.as_str(),
    )
    .await;

    crate::send_queue::spawn_send_queue_drain(state.clone(), conversation.id);
    crate::multi_agent_plan::spawn_plan_group_checkpoints_after_cancellation(
        state.clone(),
        cancellation.job_ids.clone(),
    );

    Ok(Json(ConversationInterruptResponse {
        ok: true,
        canceled_run_ids,
        canceled_job_ids: cancellation.job_ids.iter().map(Uuid::to_string).collect(),
    }))
}

pub(crate) struct InterruptionNotice {
    pub(crate) content: String,
    pub(crate) metadata: JsonValue,
}

pub(crate) fn build_interruption_notice(
    reason: &str,
    job_ids: &[Uuid],
    run_ids: &[Uuid],
) -> InterruptionNotice {
    let trimmed_reason = reason.trim();
    let run_count = run_ids.len();
    let content = if run_count > 0 {
        if trimmed_reason.eq_ignore_ascii_case("Canceled") {
            if run_count == 1 {
                "Canceled 1 run.".to_string()
            } else {
                format!("Canceled {run_count} runs.")
            }
        } else if run_count == 1 {
            format!("{trimmed_reason} (1 run canceled.)")
        } else {
            format!("{trimmed_reason} ({run_count} runs canceled.)")
        }
    } else if trimmed_reason.eq_ignore_ascii_case("Canceled") {
        "Canceled pending work.".to_string()
    } else {
        format!("{trimmed_reason} (pending work canceled.)")
    };

    let job_id_values: Vec<String> = job_ids.iter().map(Uuid::to_string).collect();
    let run_id_values: Vec<String> = run_ids.iter().map(Uuid::to_string).collect();
    let metadata = json!({
        "source": "controller",
        "kind": "run_cancellation",
        "details": {
            "reason": trimmed_reason,
            "jobIds": job_id_values,
            "runIds": run_id_values,
            "runCount": run_count,
            "jobCount": job_ids.len(),
            "outcome": "canceled",
            "finalStatus": "canceled",
            "runStatus": "canceled",
        }
    });

    InterruptionNotice { content, metadata }
}

pub(crate) async fn persist_canceled_run_metadata(
    transaction: &tokio_postgres::Transaction<'_>,
    run_ids: &[Uuid],
    reason: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    for run_id in run_ids {
        let row = transaction
            .query_opt(
                "select metadata from runs where id = $1 for update",
                &[run_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load run metadata for cancellation persistence: {error}"
                ))
            })?;

        let Some(row) = row else {
            continue;
        };

        let existing = row
            .get::<_, Option<PgJson<JsonValue>>>("metadata")
            .map(|json| json.0);
        let merged = merge_canceled_run_metadata(existing.as_ref(), reason);
        let merged_param = PgJson(&merged);
        transaction
            .execute(
                "update runs set metadata = $2::jsonb where id = $1",
                &[run_id, &merged_param],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to persist canceled run metadata: {error}"))
            })?;
    }

    Ok(())
}

fn merge_canceled_run_metadata(existing: Option<&JsonValue>, reason: &str) -> JsonValue {
    let mut root = match existing.cloned() {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };

    root.insert("summary".to_string(), JsonValue::String(reason.to_string()));
    root.insert(
        "cancellation".to_string(),
        json!({
            "outcome": "canceled",
            "finalStatus": "canceled",
            "runStatus": "canceled",
            "summary": reason,
            "errorMessage": JsonValue::Null,
            "artifactsCount": JsonValue::Null,
            "provider": JsonValue::Null,
            "creditSnapshot": JsonValue::Null,
        }),
    );

    JsonValue::Object(root)
}

pub(crate) async fn post_conversation_message(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(mut body): axum::Json<ConversationPromptBody>,
) -> Result<Json<DispatchPromptResponse>, (StatusCode, Json<ApiError>)> {
    let has_auth = headers.contains_key(axum::http::header::AUTHORIZATION);
    tracing::info!(
        ?conversation_id_raw,
        has_auth,
        "post_conversation_message received"
    );
    let context = authenticate_request(&state.config, &headers).await?;

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
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_write_access(
        &transaction,
        &project,
        &access_context,
        conversation.session_id,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job
            .ensure_conversation_write(&transaction, &conversation)
            .await?;
    } else {
        ensure_conversation_access(&transaction, &conversation, &access_context).await?;
    }
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize conversation lookup: {error}"))
    })?;
    // Dispatch acquires its own connection. Release the completed lookup before
    // entering that path so this handler remains viable with a one-slot pool.
    drop(connection);

    if body.session_id.is_none() {
        body.session_id = conversation.session_id.map(|value| value.to_string());
    }

    if body.runtime_id.is_some() && body.prefer_runtime.is_none() {
        body.prefer_runtime = Some(true);
    }

    let expected_lane_idle = body.expected_lane_idle.unwrap_or(false);
    let queued_message = if expected_lane_idle {
        Some(serde_json::to_value(&body).map_err(|error| {
            internal_error(format!(
                "failed to preserve interactive message for lane admission: {error}"
            ))
        })?)
    } else {
        None
    };
    let client_send_id = body
        .metadata
        .as_ref()
        .and_then(extract_client_message_id_from_metadata)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let dispatch_request = build_dispatch_request_from_conversation(
        &conversation.project_id,
        Some(&conversation_id),
        body,
    );
    let mut request = crate::dispatch::normalize_dispatch_request(dispatch_request)?;

    if request.conversation_id.is_none() {
        request.conversation_id = Some(conversation_id);
        request.conversation_raw = Some(conversation_id.to_string());
    }

    request.conversation_is_new = false;
    request.expected_lane_idle = expected_lane_idle;

    if let Some(conversation_id) = request.conversation_id {
        inject_conversation_metadata(&mut request.metadata, &conversation_id);
    }

    match process_dispatch_prompt(&state, &access_context, request).await {
        Ok(response) => Ok(Json(response)),
        Err((StatusCode::CONFLICT, Json(api_error)))
            if expected_lane_idle && api_error.code.as_deref() == Some("dispatch_lane_busy") =>
        {
            // The composer observed an idle lane, but another linearized
            // dispatch won the shared fence. Preserve the user's message in
            // the durable queue instead of either losing it or creating a
            // concurrent same-agent run.
            let message = queued_message.unwrap_or_else(|| unreachable!());
            crate::send_queue::enqueue_prompt_with_context(
                &state,
                &context,
                conversation_id,
                &client_send_id,
                message,
            )
            .await?;
            Ok(Json(DispatchPromptResponse {
                run_id: None,
                run_ids: None,
                prompt_id: None,
                job_id: None,
                job_ids: None,
                status: "queued".to_string(),
                conversation_id: Some(conversation_id),
            }))
        }
        Err(error) => Err(error),
    }
}

pub(crate) async fn list_conversation_runs(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    Query(params): Query<ConversationRunsQuery>,
) -> Result<Json<Vec<runs::RunSnapshot>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

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
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_access(
        &transaction,
        &project,
        &access_context,
        conversation.session_id,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job
            .ensure_conversation_read(&transaction, &conversation)
            .await?;
    } else {
        ensure_conversation_access(&transaction, &conversation, &access_context).await?;
    }

    let limit = params.limit.unwrap_or(50).clamp(1, 200);

    let query = format!(
        "{} where conversation_id = $1 order by created_at desc limit $2",
        runs::RUN_SELECT_BASE
    );
    let rows = transaction
        .query(&query, &[&conversation_id, &limit])
        .await
        .map_err(|error| internal_error(format!("failed to list conversation runs: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit conversation runs query: {error}"))
    })?;

    let runs = rows
        .into_iter()
        .map(|row| runs::map_run_row(&row))
        .collect();
    Ok(Json(runs))
}

pub(crate) async fn list_conversation_messages(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    Query(params): Query<ConversationMessagesQuery>,
) -> Result<Json<ConversationMessagesPage>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

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
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_access(
        &transaction,
        &project,
        &access_context,
        conversation.session_id,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job
            .ensure_conversation_read(&transaction, &conversation)
            .await?;
    } else {
        ensure_conversation_access(&transaction, &conversation, &access_context).await?;
    }

    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let fetch_limit = limit + 1;

    let (rows, has_more) = if let Some(cursor_raw) = params.cursor.as_ref() {
        let cursor_id = Uuid::from_str(cursor_raw.trim())
            .map_err(|_| bad_request("cursor must be a valid UUID"))?;
        let cursor_row = transaction
            .query_opt(
                "select created_at from conversation_messages where id = $1 and conversation_id = $2",
                &[&cursor_id, &conversation_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to resolve cursor: {error}")))?;
        let Some(row) = cursor_row else {
            return Err(not_found("cursor message not found"));
        };
        let cursor_created_at: DateTime<Utc> = row.get("created_at");
        let query = "select id,
                            conversation_id,
                            project_id,
                            session_id,
                            created_by,
                            prompt_id,
                            run_id,
                            role,
                            content,
                            metadata,
                            created_at
                     from conversation_messages
                     where conversation_id = $1
                       and (created_at < $2 or (created_at = $2 and id < $3))
                     order by created_at desc, id desc
                     limit $4";
        let rows = transaction
            .query(
                query,
                &[
                    &conversation_id,
                    &cursor_created_at,
                    &cursor_id,
                    &fetch_limit,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to list conversation messages: {error}"))
            })?;
        let has_more = rows.len() as i64 > limit;
        (rows, has_more)
    } else {
        let query = "select id,
                            conversation_id,
                            project_id,
                            session_id,
                            created_by,
                            prompt_id,
                            run_id,
                            role,
                            content,
                            metadata,
                            created_at
                     from conversation_messages
                     where conversation_id = $1
                     order by created_at desc, id desc
                     limit $2";
        let rows = transaction
            .query(query, &[&conversation_id, &fetch_limit])
            .await
            .map_err(|error| {
                internal_error(format!("failed to list conversation messages: {error}"))
            })?;
        let has_more = rows.len() as i64 > limit;
        (rows, has_more)
    };

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit conversation messages query: {error}"
        ))
    })?;

    let mut message_rows: Vec<ConversationMessageRow> = rows
        .into_iter()
        .map(|row| map_conversation_message_row(&row))
        .collect();

    if has_more {
        message_rows.truncate(limit as usize);
    }

    let next_cursor = if has_more {
        message_rows.last().map(|message| message.id.to_string())
    } else {
        None
    };

    let payload_messages = message_rows
        .into_iter()
        .map(|row| message_row_to_payload(&row))
        .collect();

    Ok(Json(ConversationMessagesPage {
        messages: payload_messages,
        next_cursor,
        has_more,
    }))
}

pub(crate) async fn ensure_conversation_record(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &crate::ProjectRecord,
    request: &mut DispatchPromptNormalized,
    context: &RequestContext,
) -> Result<ConversationRecord, (StatusCode, Json<ApiError>)> {
    let Some(conversation_id) = request.conversation_id else {
        return Err(bad_request("conversationId is required"));
    };

    let existing = transaction
        .query_opt(
            "select id,
                    project_id,
                    session_id,
                    created_by,
                    metadata,
                    visibility,
                    parent_conversation_id,
                    root_conversation_id,
                    thread_kind,
                    last_message_id,
                    last_message_at,
                    last_message_preview,
                    created_at,
                    updated_at
             from conversations
             where id = $1
             for update",
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load conversation: {error}")))?;

    let metadata_param = request.conversation_metadata.as_ref().map(PgJson);

    if let Some(row) = existing {
        let mut conversation = map_conversation_row(&row);
        ensure_conversation_access(transaction, &conversation, context).await?;
        if request.runtime_id.is_none() {
            match resolve_conversation_runtime_preference(
                transaction,
                &conversation.project_id,
                &conversation.metadata,
            )
            .await?
            {
                ConversationRuntimePreferenceResolution::Viable(pref) => {
                    request.runtime_id = Some(pref.runtime_id);
                    request.runtime_source = pref.source;
                    request.runtime_updated_at = pref.updated_at;
                    request.runtime_display_name = pref.display_name;
                }
                ConversationRuntimePreferenceResolution::Stale => {
                    clear_conversation_runtime_preference(transaction, &conversation.id).await?;
                    conversation.metadata =
                        remove_runtime_preference_from_metadata(conversation.metadata.take());
                }
                ConversationRuntimePreferenceResolution::Missing => {}
            }
        }
        if conversation.project_id != project.id {
            return Err(crate::forbidden(
                "conversation does not belong to this project",
            ));
        }

        let mut requires_reload = false;

        if let Some(session_id) = request.session_id {
            if conversation.session_id.is_none() || conversation.session_id != Some(session_id) {
                transaction
                    .execute(
                        "update conversations set session_id = $2, updated_at = now() where id = $1",
                        &[&conversation_id, &session_id],
                    )
                    .await
                    .map_err(|error| internal_error(format!("failed to update conversation session: {error}")))?;
                requires_reload = true;
            }
        }

        if let Some(metadata) = metadata_param.as_ref() {
            transaction
                .execute(
                    "update conversations
                     set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
                         updated_at = now()
                     where id = $1",
                    &[&conversation_id, metadata],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to update conversation metadata: {error}"))
                })?;
            requires_reload = true;
        }

        if requires_reload {
            let refreshed = transaction
                .query_one(
                    "select id,
                            project_id,
                            session_id,
                            created_by,
                            metadata,
                            visibility,
                            parent_conversation_id,
                            root_conversation_id,
                            thread_kind,
                            last_message_id,
                            last_message_at,
                            last_message_preview,
                            created_at,
                            updated_at
                     from conversations
                     where id = $1",
                    &[&conversation_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to reload conversation: {error}"))
                })?;
            conversation = map_conversation_row(&refreshed);
        }

        if let Some(parent_id) = request.parent_conversation_id {
            if conversation.parent_conversation_id != Some(parent_id) {
                return Err(bad_request(
                    "parentConversationId cannot be changed after creation",
                ));
            }
        }

        if let Some(thread_kind) = request.thread_kind.as_ref() {
            if conversation.thread_kind.as_ref() != Some(thread_kind) {
                return Err(bad_request("threadKind cannot be changed after creation"));
            }
        }

        Ok(conversation)
    } else {
        let visibility_value = metadata_param
            .as_ref()
            .map(|value| resolve_conversation_visibility(&value.0))
            .unwrap_or(CONVERSATION_VISIBILITY_PUBLIC)
            .to_string();
        if visibility_value == CONVERSATION_VISIBILITY_PRIVATE
            && !context.is_service_role
            && context.user_id.is_none()
        {
            return Err(crate::unauthorized(
                "authentication required for private conversations",
            ));
        }

        let (parent_conversation_id, root_conversation_id, thread_kind) = resolve_thread_columns(
            transaction,
            &project.id,
            &conversation_id,
            request.parent_conversation_id,
            request.thread_kind.clone(),
            context,
        )
        .await?;

        let inserted = transaction
            .query_one(
                "insert into conversations (
                     id,
                     project_id,
                     session_id,
                     created_by,
                     metadata,
                     visibility,
                     parent_conversation_id,
                     root_conversation_id,
                     thread_kind
                 ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                 returning id,
                           project_id,
                           session_id,
                           created_by,
                           metadata,
                           visibility,
                           parent_conversation_id,
                           root_conversation_id,
                           thread_kind,
                           last_message_id,
                           last_message_at,
                           last_message_preview,
                           created_at,
                           updated_at",
                &[
                    &conversation_id,
                    &project.id,
                    &request.session_id,
                    &context.user_id,
                    &metadata_param,
                    &visibility_value,
                    &parent_conversation_id,
                    &root_conversation_id,
                    &thread_kind,
                ],
            )
            .await
            .map_err(|error| internal_error(format!("failed to insert conversation: {error}")))?;

        request.conversation_is_new = true;

        let inserted_conversation = map_conversation_row(&inserted);
        if let Some(user_id) = context.user_id {
            transaction
                .execute(
                    "insert into conversation_participants (conversation_id, user_id, role, added_by)
                     values ($1, $2, 'owner', $3)
                     on conflict (conversation_id, user_id) do nothing",
                    &[&conversation_id, &user_id, &context.user_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to add conversation participant: {error}"
                    ))
                })?;
        }

        Ok(inserted_conversation)
    }
}

pub(crate) async fn load_conversation_record(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
) -> Result<ConversationRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id,
                    project_id,
                    session_id,
                    created_by,
                    metadata,
                    visibility,
                    parent_conversation_id,
                    root_conversation_id,
                    thread_kind,
                    last_message_id,
                    last_message_at,
                    last_message_preview,
                    created_at,
                    updated_at
             from conversations
             where id = $1",
            &[conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load conversation: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("conversation not found"));
    };

    Ok(map_conversation_row(&row))
}

pub(crate) fn publish_conversation_message_event(hub: &EventHub, message: &ConversationMessageRow) {
    let payload = json!({
        "id": message.id,
        "conversationId": message.conversation_id,
        "projectId": message.project_id,
        "sessionId": message.session_id,
        "createdBy": message.created_by,
        "promptId": message.prompt_id,
        "runId": message.run_id,
        "role": message.role,
        "content": message.content,
        "metadata": message.metadata,
        "createdAt": message.created_at.to_rfc3339(),
    });
    publish_controller_event_with_conversation(
        hub,
        "conversation.message_created",
        Some(message.project_id),
        message.session_id,
        Some(message.conversation_id),
        message.run_id,
        None,
        payload,
    );
}

pub(crate) async fn record_conversation_message(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &crate::ProjectRecord,
    conversation: &ConversationRecord,
    request: &DispatchPromptNormalized,
    prompt_id: &Uuid,
    run_id: &Uuid,
    context: &RequestContext,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    record_conversation_user_message(
        transaction,
        project,
        conversation,
        request,
        Some(*prompt_id),
        Some(*run_id),
        context,
    )
    .await
}

// Record-then-dispatch reuse: the record endpoint already inserted this user
// message row, so a non-silent dispatch for the same clientMessageId must
// attach its prompt/run to that row instead of inserting a duplicate. The
// dispatch-built metadata is merged over the recorded metadata so record-path
// keys (e.g. top-level clientMessageId) survive.
pub(crate) async fn attach_dispatch_to_recorded_message(
    transaction: &tokio_postgres::Transaction<'_>,
    existing: &ConversationMessageRow,
    request: &DispatchPromptNormalized,
    prompt_id: &Uuid,
    run_id: &Uuid,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    let dispatch_metadata = build_conversation_message_metadata(request);
    let metadata_param = PgJson(&dispatch_metadata);
    let row = transaction
        .query_opt(
            "update conversation_messages
             set prompt_id = $4,
                 run_id = $5,
                 metadata = coalesce(metadata, '{}'::jsonb) || $6::jsonb
             where id = $1
               and conversation_id = $2
               and project_id = $3
               and run_id is null
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
            &[
                &existing.id,
                &existing.conversation_id,
                &existing.project_id,
                prompt_id,
                run_id,
                &metadata_param,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to attach dispatch to recorded conversation message: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Err(internal_error(
            "recorded conversation message was not available for dispatch reuse",
        ));
    };
    Ok(map_conversation_message_row(&row))
}

pub(crate) async fn record_conversation_message_without_dispatch(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &crate::ProjectRecord,
    conversation: &ConversationRecord,
    request: &DispatchPromptNormalized,
    context: &RequestContext,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    record_conversation_user_message(
        transaction,
        project,
        conversation,
        request,
        None,
        None,
        context,
    )
    .await
}

async fn record_conversation_user_message(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &crate::ProjectRecord,
    conversation: &ConversationRecord,
    request: &DispatchPromptNormalized,
    prompt_id: Option<Uuid>,
    run_id: Option<Uuid>,
    context: &RequestContext,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    let message_metadata = build_conversation_message_metadata(request);
    let metadata_param = PgJson(&message_metadata);
    let role = "user".to_string();
    let message_id = Uuid::new_v4();

    let row = transaction
        .query_one(
            "insert into conversation_messages (
                 id,
                 conversation_id,
                 project_id,
                 session_id,
                 prompt_id,
                 run_id,
                 role,
                 content,
                 metadata,
                 created_by
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
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
            &[
                &message_id,
                &conversation.id,
                &project.id,
                &request.session_id,
                &prompt_id,
                &run_id,
                &role,
                &request.prompt_text,
                &metadata_param,
                &context.user_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to insert conversation message: {error}"))
        })?;

    let last_message_preview = build_conversation_last_message_preview(&request.prompt_text);
    transaction
        .execute(
            "update conversations
             set updated_at = now(),
                 last_message_id = $2,
                 last_message_at = now(),
                 last_message_preview = $3
             where id = $1",
            &[&conversation.id, &message_id, &last_message_preview],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to bump conversation timestamp: {error}"))
        })?;

    if let Some(root_id) = conversation
        .root_conversation_id
        .filter(|value| value != &conversation.id)
    {
        transaction
            .execute(
                "update conversations set updated_at = now() where id = $1",
                &[&root_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to bump root conversation timestamp: {error}"
                ))
            })?;
    }

    if let Some(user_id) = context.user_id {
        transaction
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
                 values ($1, $2, 'member', $3)
                 on conflict (conversation_id, user_id) do nothing",
                &[&conversation.id, &user_id, &context.user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to add conversation participant: {error}"))
            })?;
    }

    Ok(map_conversation_message_row(&row))
}

pub(crate) async fn record_controller_assistant_message(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    session_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    run_id: Option<Uuid>,
    content: &str,
    metadata: &JsonValue,
) -> Result<ConversationMessageRow, (StatusCode, Json<ApiError>)> {
    let message_id = Uuid::new_v4();
    let metadata_param = PgJson(metadata);
    let content_string = content.to_string();

    let row = transaction
        .query_one(
            "insert into conversation_messages (
                 id,
                 conversation_id,
                 project_id,
                 session_id,
                 prompt_id,
                 run_id,
                 role,
                 content,
                 metadata,
                 created_by
             ) values ($1, $2, $3, $4, $5, $6, 'assistant', $7, $8::jsonb, null)
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
            &[
                &message_id,
                conversation_id,
                project_id,
                &session_id,
                &prompt_id,
                &run_id,
                &content_string,
                &metadata_param,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to insert controller assistant conversation message: {error}"
            ))
        })?;

    let last_message_preview = build_conversation_last_message_preview(content);
    transaction
        .execute(
            "update conversations
             set updated_at = now(),
                 last_message_id = $2,
                 last_message_at = now(),
                 last_message_preview = $3
             where id = $1",
            &[conversation_id, &message_id, &last_message_preview],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to bump conversation timestamp for controller message: {error}"
            ))
        })?;

    transaction
        .execute(
            "update conversations
             set updated_at = now()
             where id = (select root_conversation_id from conversations where id = $1)
               and id <> $1",
            &[conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to bump root conversation timestamp for controller message: {error}"
            ))
        })?;

    Ok(map_conversation_message_row(&row))
}

pub(crate) fn build_dispatch_request_from_conversation(
    project_id: &Uuid,
    conversation_id: Option<&Uuid>,
    body: ConversationPromptBody,
) -> DispatchPromptRequest {
    DispatchPromptRequest {
        project_id: Some(project_id.to_string()),
        session_id: body.session_id,
        prompt_text: Some(body.prompt_text),
        intent: body.intent,
        plan_seed: body.plan_seed,
        metadata: body.metadata,
        conversation_metadata: body.conversation_metadata,
        parent_conversation_id: body.parent_conversation_id,
        thread_kind: body.thread_kind,
        tool_limits: body.tool_limits,
        repo: body.repo,
        ui: body.ui,
        priority: body.priority,
        runtime_type: body.runtime_type,
        idle_ttl_seconds: body.idle_ttl_seconds,
        conversation_id: conversation_id.map(|value| value.to_string()),
        runtime_id: body.runtime_id,
        runtime_display_name: body.runtime_display_name,
        prefer_runtime: body.prefer_runtime,
    }
}

pub(crate) fn inject_conversation_metadata(metadata: &mut JsonValue, conversation_id: &Uuid) {
    let conversation_string = conversation_id.to_string();
    set_metadata_string(metadata, "conversation_id", conversation_string.clone());
    set_metadata_string(metadata, "conversationId", conversation_string);
}

pub(crate) fn map_conversation_message_row(row: &tokio_postgres::Row) -> ConversationMessageRow {
    let metadata: Option<PgJson<JsonValue>> = row.get("metadata");
    ConversationMessageRow {
        id: row.get("id"),
        conversation_id: row.get("conversation_id"),
        project_id: row.get("project_id"),
        session_id: row.get("session_id"),
        created_by: row.get("created_by"),
        prompt_id: row.get("prompt_id"),
        run_id: row.get("run_id"),
        role: row.get("role"),
        content: row.get("content"),
        metadata: metadata.map(|value| value.0).unwrap_or(JsonValue::Null),
        created_at: row.get("created_at"),
    }
}

pub(crate) fn map_conversation_row(row: &tokio_postgres::Row) -> ConversationRecord {
    let last_message_at: Option<DateTime<Utc>> = row.get("last_message_at");
    ConversationRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        session_id: row.get("session_id"),
        created_by: row.get("created_by"),
        metadata: row.get("metadata"),
        visibility: row.get("visibility"),
        parent_conversation_id: row.get("parent_conversation_id"),
        root_conversation_id: row.get("root_conversation_id"),
        thread_kind: row.get("thread_kind"),
        last_message_id: row.get("last_message_id"),
        last_message_at,
        last_message_preview: row.get("last_message_preview"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationParticipantPayload {
    user_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    role: String,
    added_by: Option<Uuid>,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationParticipantsResponse {
    participants: Vec<ConversationParticipantPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationParticipantCreateBody {
    #[serde(rename = "userId", alias = "user_id")]
    user_id: String,
    role: Option<String>,
}

async fn load_conversation_participants(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
) -> Result<Vec<ConversationParticipantPayload>, (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .query(
            "select cp.user_id,
                    case when cp.user_id = conversation.created_by then 'owner' else 'member' end as role,
                    cp.added_by,
                    cp.created_at,
                    coalesce(
                      nullif(btrim(p.full_name), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                    ) as display_name
             from conversation_participants cp
             join conversations conversation on conversation.id = cp.conversation_id
             left join profiles p on p.user_id = cp.user_id
             left join auth.users u on u.id = cp.user_id
             where cp.conversation_id = $1
             order by cp.created_at asc, cp.user_id asc",
            &[conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load conversation participants: {error}"))
        })?;

    Ok(rows
        .into_iter()
        .map(|row| ConversationParticipantPayload {
            user_id: row.get("user_id"),
            display_name: row.get("display_name"),
            role: row.get::<_, String>("role"),
            added_by: row.get("added_by"),
            created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
        })
        .collect())
}

async fn list_conversation_participants(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
) -> Result<Json<ConversationParticipantsResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
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

    let participants = load_conversation_participants(&transaction, &conversation_id).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize participant list: {error}")))?;

    Ok(Json(ConversationParticipantsResponse { participants }))
}

async fn add_conversation_participant(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    axum::Json(body): axum::Json<ConversationParticipantCreateBody>,
) -> Result<Json<ConversationParticipantsResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;
    let target_user_id = Uuid::from_str(body.user_id.trim())
        .map_err(|_| bad_request("userId must be a valid UUID"))?;

    let role = body
        .role
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "member".to_string());
    if role != "member" {
        return Err(bad_request(
            "conversation participant role must be `member`",
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

    let conversation = load_conversation_record(&transaction, &conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, conversation.session_id).await?;
    ensure_conversation_access(&transaction, &conversation, &context).await?;

    if conversation.visibility != CONVERSATION_VISIBILITY_PRIVATE {
        return Err(bad_request("conversation is not private"));
    }

    if !context.is_service_role {
        let Some(actor_id) = context.user_id else {
            return Err(crate::unauthorized("authentication required"));
        };

        if conversation.created_by != Some(actor_id) {
            let is_participant = transaction
                .query_opt(
                    "select user_id
                     from conversation_participants
                     where conversation_id = $1 and user_id = $2
                     limit 1",
                    &[&conversation.id, &actor_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to verify participant role: {error}"))
                })?;
            if is_participant.is_none() {
                return Err(crate::forbidden(
                    "Only conversation participants can invite others.",
                ));
            }
        }

        if project.org_id.is_some() && project.owner_user_id != Some(target_user_id) {
            let project_member = transaction
                .query_opt(
                    "select user_id from project_memberships where project_id = $1 and user_id = $2 limit 1",
                    &[&project.id, &target_user_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to verify project membership: {error}"))
                })?;
            if project_member.is_none() {
                let org_member = transaction
                    .query_opt(
                        "select user_id from org_memberships where org_id = $1 and user_id = $2 limit 1",
                        &[&project.org_id, &target_user_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to verify org membership: {error}"))
                    })?;
                if org_member.is_none() {
                    return Err(bad_request(
                        "user must be a member of this project or organization",
                    ));
                }
            }
        }
    }

    transaction
        .execute(
            "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, $3, $4)
             on conflict (conversation_id, user_id) do nothing",
            &[&conversation_id, &target_user_id, &role, &context.user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to add participant: {error}")))?;

    let participants = load_conversation_participants(&transaction, &conversation_id).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize participant update: {error}"))
    })?;

    Ok(Json(ConversationParticipantsResponse { participants }))
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimePreferenceMetadata {
    pub(crate) runtime_id: Uuid,
    pub(crate) source: Option<String>,
    pub(crate) updated_at: Option<DateTime<Utc>>,
    pub(crate) display_name: Option<String>,
}

pub(crate) fn extract_runtime_preference_metadata(
    metadata: &Option<JsonValue>,
) -> Option<RuntimePreferenceMetadata> {
    metadata
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|map| map.get("runtimePreference"))
        .and_then(|value| parse_runtime_preference_value(value))
}

fn parse_runtime_preference_value(value: &JsonValue) -> Option<RuntimePreferenceMetadata> {
    let map = value.as_object()?;
    let runtime_id_raw = map.get("runtimeId")?.as_str()?;
    let runtime_id = Uuid::from_str(runtime_id_raw).ok()?;
    let source = map
        .get("source")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let updated_at = map
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|dt| dt.with_timezone(&Utc));
    let display_name = map
        .get("displayName")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    Some(RuntimePreferenceMetadata {
        runtime_id,
        source,
        updated_at,
        display_name,
    })
}

#[derive(Debug, Clone)]
enum ConversationRuntimePreferenceResolution {
    Missing,
    Stale,
    Viable(RuntimePreferenceMetadata),
}

async fn resolve_conversation_runtime_preference(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    metadata: &Option<JsonValue>,
) -> Result<ConversationRuntimePreferenceResolution, (StatusCode, Json<ApiError>)> {
    let Some(preference) = extract_runtime_preference_metadata(metadata) else {
        return Ok(ConversationRuntimePreferenceResolution::Missing);
    };

    let runtime_row = transaction
        .query_opt(
            "select status, endpoint_url, last_seen_at, idle_ttl_seconds, display_name
             from runtimes
             where id = $1
               and project_id = $2",
            &[&preference.runtime_id, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate conversation runtime preference: {error}"
            ))
        })?;

    let Some(runtime_row) = runtime_row else {
        return Ok(ConversationRuntimePreferenceResolution::Stale);
    };

    let status: String = runtime_row.get("status");
    if !status_is_viable(status.as_str()) {
        return Ok(ConversationRuntimePreferenceResolution::Stale);
    }

    let endpoint_url: Option<String> = runtime_row.get("endpoint_url");
    let last_seen_at: Option<DateTime<Utc>> = runtime_row.get("last_seen_at");
    let idle_ttl_seconds = runtime_row
        .get::<_, Option<i32>>("idle_ttl_seconds")
        .unwrap_or(crate::workspace::LOCAL_WORKSPACE_IDLE_TTL_SECONDS as i32);
    let is_local = endpoint_matches_local(endpoint_url.as_deref());
    if !runtime_is_recent(last_seen_at, idle_ttl_seconds, is_local) {
        return Ok(ConversationRuntimePreferenceResolution::Stale);
    }

    let mut resolved = preference;
    if resolved.display_name.is_none() {
        let runtime_display_name: Option<String> = runtime_row.get("display_name");
        resolved.display_name = runtime_display_name;
    }
    Ok(ConversationRuntimePreferenceResolution::Viable(resolved))
}

fn remove_runtime_preference_from_metadata(metadata: Option<JsonValue>) -> Option<JsonValue> {
    let Some(mut metadata_value) = metadata else {
        return None;
    };
    let Some(metadata_map) = metadata_value.as_object_mut() else {
        return Some(metadata_value);
    };
    metadata_map.remove("runtimePreference");
    Some(metadata_value)
}

async fn clear_conversation_runtime_preference(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "update conversations
             set metadata = coalesce(metadata, '{}'::jsonb) - 'runtimePreference',
                 updated_at = now()
             where id = $1",
            &[conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to clear stale conversation runtime preference: {error}"
            ))
        })?;
    Ok(())
}

pub(crate) fn runtime_preference_wrapper_json(
    runtime_id: &Uuid,
    source: Option<&str>,
    updated_at: DateTime<Utc>,
    display_name: Option<&str>,
) -> JsonValue {
    let mut preference_map = JsonMap::new();
    preference_map.insert(
        "runtimeId".to_string(),
        JsonValue::String(runtime_id.to_string()),
    );
    if let Some(source_value) = source {
        preference_map.insert(
            "source".to_string(),
            JsonValue::String(source_value.to_string()),
        );
    }
    preference_map.insert(
        "updatedAt".to_string(),
        JsonValue::String(updated_at.to_rfc3339()),
    );
    if let Some(name) = display_name {
        preference_map.insert(
            "displayName".to_string(),
            JsonValue::String(name.to_string()),
        );
    }

    let mut wrapper = JsonMap::new();
    wrapper.insert(
        "runtimePreference".to_string(),
        JsonValue::Object(preference_map),
    );
    JsonValue::Object(wrapper)
}

fn message_row_to_payload(row: &ConversationMessageRow) -> ConversationMessagePayload {
    ConversationMessagePayload {
        id: row.id,
        conversation_id: row.conversation_id,
        project_id: row.project_id,
        session_id: row.session_id,
        created_by: row.created_by,
        prompt_id: row.prompt_id,
        run_id: row.run_id,
        role: row.role.clone(),
        content: row.content.clone(),
        metadata: row.metadata.clone(),
        created_at: row.created_at.to_rfc3339(),
    }
}

pub(crate) async fn upsert_conversation_runtime_preference(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    runtime_id: &Uuid,
    source: Option<&str>,
    updated_at: DateTime<Utc>,
    display_name: Option<&str>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let wrapper = runtime_preference_wrapper_json(runtime_id, source, updated_at, display_name);
    let wrapper_param = PgJson(&wrapper);

    transaction
        .execute(
            "update conversations
             set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
                 updated_at = now()
             where id = $1",
            &[conversation_id, &wrapper_param],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to update conversation runtime preference: {error}"
            ))
        })?;

    Ok(())
}

fn build_conversation_message_metadata(request: &DispatchPromptNormalized) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert(
        "intent".to_string(),
        JsonValue::String(request.intent.clone()),
    );
    map.insert(
        "execution_mode".to_string(),
        JsonValue::String(request.execution_mode.clone()),
    );
    map.insert("priority".to_string(), JsonValue::from(request.priority));
    if let Some(runtime_type) = request.runtime_type.as_ref() {
        map.insert(
            "runtime_type".to_string(),
            JsonValue::String(runtime_type.clone()),
        );
    }
    if let Some(plan_seed) = request.plan_seed.as_ref() {
        map.insert("plan_seed".to_string(), plan_seed.clone());
    }
    if let Some(conversation_id) = request.conversation_id {
        map.insert(
            "agentThreadId".to_string(),
            JsonValue::String(conversation_id.to_string()),
        );
    }
    if let Some(tool_limits) = request.tool_limits.as_ref() {
        map.insert("tool_limits".to_string(), tool_limits.clone());
    }
    if let Some(metadata) = request.conversation_metadata.as_ref() {
        map.insert("conversation_metadata".to_string(), metadata.clone());
    }
    map.insert("prompt_metadata".to_string(), request.metadata.clone());
    if let Some(group_participation) =
        controller_enforced_group_participation_marker(&request.metadata)
    {
        map.insert(
            "groupParticipation".to_string(),
            group_participation.clone(),
        );
    }
    if let Some(agent) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("agent"))
        .cloned()
    {
        map.insert("agent".to_string(), agent.clone());
        if let Some(agent_id) = agent
            .as_object()
            .and_then(|value| value.get("id"))
            .and_then(JsonValue::as_str)
        {
            map.insert(
                "sourceAgentId".to_string(),
                JsonValue::String(agent_id.to_string()),
            );
        }
    }
    map.insert(
        "executionMode".to_string(),
        JsonValue::String(request.workspace_mode.clone()),
    );
    map.insert(
        "workspaceMode".to_string(),
        JsonValue::String(request.workspace_mode.clone()),
    );
    if let Some(write_intent) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("writeIntent"))
        .cloned()
    {
        map.insert("writeIntent".to_string(), write_intent);
    }
    if let Some(linked_thread_id) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("linkedThreadId"))
        .cloned()
    {
        map.insert("linkedThreadId".to_string(), linked_thread_id);
    }
    if let Some(advisory_scope_claims) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("advisoryScopeClaims"))
        .cloned()
    {
        map.insert("advisoryScopeClaims".to_string(), advisory_scope_claims);
    }
    if let Some(agent_collaboration) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("agentCollaboration"))
        .cloned()
    {
        map.insert("agentCollaboration".to_string(), agent_collaboration);
    }
    if let Some(write_scope) = request
        .metadata
        .as_object()
        .and_then(|metadata| metadata.get("writeScope"))
        .cloned()
    {
        map.insert("writeScope".to_string(), write_scope);
    }
    if let Some(runtime_id) = request.runtime_id {
        let updated_at_value = request.runtime_updated_at.unwrap_or_else(Utc::now);
        let mut details = JsonMap::new();
        details.insert(
            "kind".to_string(),
            JsonValue::String("runtime_selection".to_string()),
        );
        details.insert(
            "runtimeId".to_string(),
            JsonValue::String(runtime_id.to_string()),
        );
        if let Some(source) = request.runtime_source.as_ref() {
            details.insert("source".to_string(), JsonValue::String(source.clone()));
        }
        if let Some(display_name) = request.runtime_display_name.as_ref() {
            details.insert(
                "displayName".to_string(),
                JsonValue::String(display_name.clone()),
            );
        }
        map.insert("details".to_string(), JsonValue::Object(details));
        let mut preference_map = JsonMap::new();
        preference_map.insert(
            "runtimeId".to_string(),
            JsonValue::String(runtime_id.to_string()),
        );
        if let Some(source) = request.runtime_source.as_ref() {
            preference_map.insert("source".to_string(), JsonValue::String(source.clone()));
        }
        preference_map.insert(
            "updatedAt".to_string(),
            JsonValue::String(updated_at_value.to_rfc3339()),
        );
        if let Some(display_name) = request.runtime_display_name.as_ref() {
            preference_map.insert(
                "displayName".to_string(),
                JsonValue::String(display_name.clone()),
            );
        }
        map.insert(
            "runtimePreference".to_string(),
            JsonValue::Object(preference_map),
        );
    }
    if let Some(preview) = request.requested_preview {
        map.insert("requested_preview".to_string(), JsonValue::Bool(preview));
    }
    if let Some(repo) = request.repo.as_ref() {
        let mut repo_map = JsonMap::new();
        if let Some(owner) = repo.owner.as_ref() {
            repo_map.insert("owner".to_string(), JsonValue::String(owner.clone()));
        }
        if let Some(name) = repo.name.as_ref() {
            repo_map.insert("name".to_string(), JsonValue::String(name.clone()));
        }
        if let Some(installation) = repo.installation_id {
            repo_map.insert("installation_id".to_string(), JsonValue::from(installation));
        }
        if !repo_map.is_empty() {
            map.insert("repo".to_string(), JsonValue::Object(repo_map));
        }
    }

    JsonValue::Object(map)
}

fn metadata_object_mut(value: &mut JsonValue) -> &mut JsonMap<String, JsonValue> {
    if !value.is_object() {
        *value = JsonValue::Object(JsonMap::new());
    }
    value.as_object_mut().unwrap()
}

fn set_metadata_string(value: &mut JsonValue, key: &str, content: String) {
    let map = metadata_object_mut(value);
    map.insert(key.to_string(), JsonValue::String(content));
}
