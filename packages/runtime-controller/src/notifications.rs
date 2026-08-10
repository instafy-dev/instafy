use std::collections::HashSet;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes128Gcm, Nonce};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use p256::ecdh::EphemeralSecret;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::Signature;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::Sha256;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::types::ToSql;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::conversations::{load_conversation_record, ConversationMessageRow};
use crate::load_project_record;
use crate::projects::ensure_project_access;
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPushPublicKeyResponse {
    public_key: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/notifications/inbox", get(list_my_notification_inbox))
        .route(
            "/me/notifications/inbox/ack",
            post(acknowledge_my_notification_inbox_item),
        )
        .route(
            "/notifications/web-push/vapid-public-key",
            get(get_web_push_vapid_public_key),
        )
        .route(
            "/me/notifications/web-push/subscription",
            post(upsert_my_web_push_subscription),
        )
        .route(
            "/me/notifications/web-push/subscription/remove",
            post(remove_my_web_push_subscription),
        )
        .route(
            "/me/notifications/native-push/token",
            post(upsert_my_native_push_token),
        )
        .route(
            "/me/notifications/native-push/token/remove",
            post(remove_my_native_push_token),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInboxQuery {
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInboxItem {
    project_id: Uuid,
    project_name: Option<String>,
    org_id: Option<Uuid>,
    org_name: Option<String>,
    conversation_id: Uuid,
    conversation_title: Option<String>,
    last_message_id: Uuid,
    last_message_at: String,
    last_message_preview: Option<String>,
    last_message_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInboxResponse {
    ok: bool,
    items: Vec<NotificationInboxItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInboxAckBody {
    conversation_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInboxAckResponse {
    ok: bool,
}

async fn get_web_push_vapid_public_key(
    State(state): State<AppState>,
) -> Result<Json<WebPushPublicKeyResponse>, (StatusCode, Json<ApiError>)> {
    let Some(public_key) = state.config.web_push_vapid_public_key.clone() else {
        return Err(not_found("web push not configured"));
    };
    Ok(Json(WebPushPublicKeyResponse { public_key }))
}

const TIMELINE_MESSAGE_TYPES: &[&str] = &[
    "command_execution",
    "mcp_tool_call",
    "todo_list",
    "file_change",
    "web_search",
    "token_usage",
    "reasoning",
];

fn normalize_metadata_string(value: Option<&JsonValue>) -> Option<String> {
    value
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn extract_title_from_conversation_metadata(metadata: &JsonValue) -> Option<String> {
    let root = metadata.as_object()?;
    let candidate = root
        .get("title")
        .or_else(|| root.get("name"))
        .or_else(|| root.get("label"))
        .and_then(JsonValue::as_str)?;
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn extract_message_type_from_metadata(
    metadata: Option<&serde_json::Map<String, JsonValue>>,
) -> Option<String> {
    let value = metadata.and_then(|map| map.get("messageType").or_else(|| map.get("message_type")));
    normalize_metadata_string(value)
}

fn should_include_inbox_message(
    role: &str,
    metadata: Option<&serde_json::Map<String, JsonValue>>,
) -> bool {
    if !role.eq_ignore_ascii_case("assistant") {
        return false;
    }

    if let Some(kind) = metadata
        .and_then(|map| map.get("kind"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
    {
        if kind.eq_ignore_ascii_case("update") {
            return false;
        }
    }

    let message_type = extract_message_type_from_metadata(metadata);
    if let Some(message_type) = message_type.as_deref() {
        if TIMELINE_MESSAGE_TYPES
            .iter()
            .any(|value| value == &message_type)
        {
            return false;
        }
    }

    true
}

fn push_skip_reason_for_message(message: &ConversationMessageRow) -> Option<&'static str> {
    let role = message.role.trim();
    if !(role.eq_ignore_ascii_case("assistant") || role.eq_ignore_ascii_case("user")) {
        return Some("unsupported_role");
    }

    let metadata = message.metadata.as_object();
    if role.eq_ignore_ascii_case("assistant") {
        if let Some(kind) = metadata
            .and_then(|map| map.get("kind"))
            .and_then(JsonValue::as_str)
            .map(str::trim)
        {
            if kind.eq_ignore_ascii_case("update") {
                return Some("assistant_update_kind");
            }
        }
    }

    let message_type = normalize_metadata_string(
        metadata.and_then(|map| map.get("messageType").or_else(|| map.get("message_type"))),
    );
    if let Some(message_type) = message_type.as_deref() {
        if TIMELINE_MESSAGE_TYPES
            .iter()
            .any(|value| value == &message_type)
        {
            return Some("timeline_message_type");
        }
    }

    None
}

fn push_debug_enabled() -> bool {
    std::env::var("PUSH_NOTIFICATION_DEBUG")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

async fn list_my_notification_inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<NotificationInboxQuery>,
) -> Result<Json<NotificationInboxResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let limit = params.limit.unwrap_or(25).clamp(1, 100);
    let fetch_limit = limit.saturating_mul(6).clamp(25, 500);

    // Release the DB connection before post-processing rows so the inbox poller can't
    // starve other controller queries on small bb8 pools.
    let connection = match state.pool.get().await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(
                user_id = %user_id,
                %error,
                "failed to acquire notification inbox connection; returning empty inbox"
            );
            return Ok(Json(NotificationInboxResponse {
                ok: true,
                items: Vec::new(),
            }));
        }
    };

    let rows = match connection
        .query(
            "select c.id as conversation_id,
                        c.project_id,
                        c.metadata as conversation_metadata,
                        c.last_message_at,
                        c.last_message_preview,
                        p.name as project_name,
                        p.org_id as org_id,
                        o.name as org_name,
                        m.id as message_id,
                        m.role as message_role,
                        m.content as message_content,
                        m.metadata as message_metadata,
                        m.created_at as message_created_at
                 from conversations c
                 join projects p on p.id = c.project_id
                 left join organizations o on o.id = p.org_id
                 left join conversation_participants cp
                   on cp.conversation_id = c.id and cp.user_id = $1
                 join conversation_messages m on m.id = c.last_message_id
                 where c.last_message_id is not null
                   and lower(m.role) = 'assistant'
                   and p.status <> 'deleted'
                   and (cp.last_seen_message_id is null or cp.last_seen_message_id <> c.last_message_id)
                   and (
                     c.created_by = $1
                     or cp.user_id is not null
                   )
                   and (
                     p.owner_user_id = $1
                     or exists (
                       select 1
                       from project_memberships pm
                       where pm.project_id = p.id
                         and pm.user_id = $1
                         and lower(pm.role) in ('viewer', 'builder')
                     )
                     or exists (
                       select 1
                       from org_memberships om
                       where p.org_id is not null
                         and om.org_id = p.org_id
                         and om.user_id = $1
                         and lower(om.role) in ('viewer', 'builder', 'admin', 'owner')
                     )
                   )
                 order by c.last_message_at desc nulls last, c.id desc
                 limit $2",
            &[&user_id, &fetch_limit],
        )
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                user_id = %user_id,
                %error,
                "failed to load notification inbox; returning empty inbox"
            );
            return Ok(Json(NotificationInboxResponse {
                ok: true,
                items: Vec::new(),
            }));
        }
    };

    let mut items: Vec<NotificationInboxItem> = Vec::new();
    for row in rows {
        let conversation_id: Uuid = row.get("conversation_id");
        let project_id: Uuid = row.get("project_id");
        let project_name: Option<String> = row.get("project_name");
        let org_id: Option<Uuid> = row.get("org_id");
        let org_name: Option<String> = row.get("org_name");

        let conversation_metadata: Option<PgJson<JsonValue>> = row.get("conversation_metadata");
        let conversation_metadata = conversation_metadata
            .map(|value| value.0)
            .unwrap_or(JsonValue::Null);
        let conversation_title = extract_title_from_conversation_metadata(&conversation_metadata);

        let last_message_preview: Option<String> = row.get("last_message_preview");

        let last_message_at: Option<DateTime<Utc>> = row.get("last_message_at");
        let message_created_at: DateTime<Utc> = row.get("message_created_at");

        let last_message_id: Uuid = row.get("message_id");
        let message_role: String = row.get("message_role");
        let message_content: String = row.get("message_content");
        let message_metadata: Option<PgJson<JsonValue>> = row.get("message_metadata");
        let message_metadata = message_metadata
            .map(|value| value.0)
            .unwrap_or(JsonValue::Null);
        let message_metadata_object = message_metadata.as_object();

        if !should_include_inbox_message(&message_role, message_metadata_object) {
            continue;
        }

        let last_message_type = extract_message_type_from_metadata(message_metadata_object);
        let timestamp = last_message_at.unwrap_or(message_created_at);
        let resolved_preview = last_message_preview
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| format_notification_body(&message_content));

        items.push(NotificationInboxItem {
            project_id,
            project_name,
            org_id,
            org_name,
            conversation_id,
            conversation_title,
            last_message_id,
            last_message_at: timestamp.to_rfc3339(),
            last_message_preview: resolved_preview,
            last_message_type,
        });

        if items.len() as i64 >= limit {
            break;
        }
    }

    Ok(Json(NotificationInboxResponse { ok: true, items }))
}

async fn acknowledge_my_notification_inbox_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NotificationInboxAckBody>,
) -> Result<Json<NotificationInboxAckResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let conversation = load_conversation_record(&transaction, &body.conversation_id).await?;
    let project = load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_access(&transaction, &project, &context, conversation.session_id).await?;

    if !context.is_service_role && conversation.visibility.eq_ignore_ascii_case("private") {
        if conversation.created_by != Some(user_id) {
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
            if participant.is_none() {
                return Err(crate::forbidden(
                    "This conversation is private. Ask a participant to invite you.",
                ));
            }
        }
    }

    let role = if conversation.created_by == Some(user_id) {
        "owner"
    } else {
        "member"
    };

    transaction
        .execute(
            "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, $3, $4)
             on conflict (conversation_id, user_id) do nothing",
            &[&conversation.id, &user_id, &role, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to ensure participant row: {error}")))?;

    if let Some(last_message_id) = conversation.last_message_id {
        transaction
            .execute(
                "update conversation_participants
                 set last_seen_message_id = $3, last_seen_at = now()
                 where conversation_id = $1 and user_id = $2",
                &[&conversation.id, &user_id, &last_message_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to acknowledge notification inbox item: {error}"
                ))
            })?;
    } else {
        transaction
            .execute(
                "update conversation_participants
                 set last_seen_at = now()
                 where conversation_id = $1 and user_id = $2",
                &[&conversation.id, &user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to acknowledge notification inbox item: {error}"
                ))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize inbox acknowledgement: {error}"))
    })?;

    Ok(Json(NotificationInboxAckResponse { ok: true }))
}

#[derive(Debug, Clone, Serialize)]
struct PushNotificationPayload {
    title: String,
    body: String,
    url: String,
}

fn build_notification_title(project: &crate::ProjectRecord) -> String {
    let project_name = project
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(name) = project_name {
        return format!("Instafy · {name}");
    }
    "Instafy".to_string()
}

fn format_notification_body(content: &str) -> Option<String> {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }

    let max_length = 180usize;
    if normalized.len() <= max_length {
        return Some(normalized);
    }

    let mut truncated = normalized.chars().take(max_length - 1).collect::<String>();
    truncated.push('…');
    Some(truncated)
}

fn build_message_notification_body(message: &ConversationMessageRow) -> String {
    if let Some(body) = format_notification_body(&message.content) {
        return body;
    }

    if message.role.eq_ignore_ascii_case("assistant") {
        "New assistant message".to_string()
    } else {
        "New message".to_string()
    }
}

fn build_message_notification_url(project_id: &Uuid, conversation_id: &Uuid) -> String {
    format!("/studio?projectId={project_id}&conversationControllerId={conversation_id}")
}

pub(crate) fn enqueue_message_push_notifications(state: AppState, message: ConversationMessageRow) {
    let debug_enabled = push_debug_enabled();
    if let Some(reason) = push_skip_reason_for_message(&message) {
        if debug_enabled {
            tracing::info!(
                message_id = %message.id,
                conversation_id = %message.conversation_id,
                project_id = %message.project_id,
                role = %message.role,
                run_id = ?message.run_id,
                skip_reason = reason,
                "push dispatch skipped"
            );
        }
        return;
    }

    if state.config.web_push_vapid_private_key.is_none() && state.config.apns_private_key.is_none()
    {
        if debug_enabled {
            tracing::info!(
                message_id = %message.id,
                conversation_id = %message.conversation_id,
                project_id = %message.project_id,
                role = %message.role,
                run_id = ?message.run_id,
                "push dispatch skipped: no configured push providers"
            );
        }
        return;
    }

    if debug_enabled {
        tracing::info!(
            message_id = %message.id,
            conversation_id = %message.conversation_id,
            project_id = %message.project_id,
            role = %message.role,
            run_id = ?message.run_id,
            "push dispatch queued"
        );
    }

    tokio::spawn(async move {
        if let Err(error) = send_message_push_notifications(&state, &message).await {
            tracing::warn!(
                message_id = %message.id,
                conversation_id = %message.conversation_id,
                project_id = %message.project_id,
                %error,
                "push notification dispatch failed"
            );
        }
    });
}

async fn send_message_push_notifications(
    state: &AppState,
    message: &ConversationMessageRow,
) -> anyhow::Result<()> {
    let debug_enabled = push_debug_enabled();

    let mut connection = state.pool.get().await?;
    let transaction = connection.transaction().await?;

    let conversation = load_conversation_record(&transaction, &message.conversation_id)
        .await
        .map_err(|(status, Json(api_error))| {
            anyhow::anyhow!(
                "failed to load conversation {}: {} ({})",
                message.conversation_id,
                api_error.message,
                status.as_u16()
            )
        })?;
    let project = load_project_record(&transaction, &conversation.project_id)
        .await
        .map_err(|(status, Json(api_error))| {
            anyhow::anyhow!(
                "failed to load project {}: {} ({})",
                conversation.project_id,
                api_error.message,
                status.as_u16()
            )
        })?;
    let recipients =
        load_notification_recipients(&transaction, &conversation, message.created_by).await?;

    if debug_enabled {
        tracing::info!(
            message_id = %message.id,
            conversation_id = %message.conversation_id,
            project_id = %message.project_id,
            role = %message.role,
            run_id = ?message.run_id,
            recipient_count = recipients.len(),
            "push dispatch recipients resolved"
        );
    }

    if recipients.is_empty() {
        if debug_enabled {
            tracing::info!(
                message_id = %message.id,
                conversation_id = %message.conversation_id,
                project_id = %message.project_id,
                role = %message.role,
                run_id = ?message.run_id,
                "push dispatch skipped: no recipients"
            );
        }
        transaction.commit().await?;
        return Ok(());
    }

    let notification_payload = PushNotificationPayload {
        title: build_notification_title(&project),
        body: build_message_notification_body(message),
        url: build_message_notification_url(&project.id, &conversation.id),
    };

    if let Some(public_key) = state.config.web_push_vapid_public_key.as_deref() {
        if let Some(private_key) = state.config.web_push_vapid_private_key.as_deref() {
            let subject = state
                .config
                .web_push_vapid_subject
                .as_deref()
                .unwrap_or("mailto:notifications@instafy.dev");
            match send_web_push_notifications(
                state,
                &transaction,
                &recipients,
                &notification_payload,
                public_key,
                private_key,
                subject,
            )
            .await
            {
                Ok(summary) => {
                    if debug_enabled {
                        tracing::info!(
                            message_id = %message.id,
                            conversation_id = %message.conversation_id,
                            project_id = %message.project_id,
                            role = %message.role,
                            run_id = ?message.run_id,
                            endpoint_count = summary.endpoint_count,
                            delivered_count = summary.delivered_count,
                            expired_count = summary.expired_count,
                            failed_count = summary.failed_count,
                            "web push dispatch result"
                        );
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        message_id = %message.id,
                        conversation_id = %message.conversation_id,
                        project_id = %message.project_id,
                        %error,
                        "web push delivery failed"
                    );
                }
            }
        }
    } else if debug_enabled {
        tracing::info!(
            message_id = %message.id,
            conversation_id = %message.conversation_id,
            project_id = %message.project_id,
            role = %message.role,
            run_id = ?message.run_id,
            "web push skipped: missing WEB_PUSH_VAPID_PUBLIC_KEY"
        );
    }

    if state.config.web_push_vapid_public_key.is_some()
        && state.config.web_push_vapid_private_key.is_none()
        && debug_enabled
    {
        tracing::info!(
            message_id = %message.id,
            conversation_id = %message.conversation_id,
            project_id = %message.project_id,
            role = %message.role,
            run_id = ?message.run_id,
            "web push skipped: missing WEB_PUSH_VAPID_PRIVATE_KEY"
        );
    }

    // Native push (APNs) is dispatched in a separate pipeline so web-only deployments still work.
    if state.config.apns_private_key.is_some() {
        if let Err(error) = send_native_push_notifications(
            state,
            &transaction,
            &recipients,
            message,
            &notification_payload,
        )
        .await
        {
            tracing::warn!(
                message_id = %message.id,
                conversation_id = %message.conversation_id,
                project_id = %message.project_id,
                %error,
                "native push delivery failed"
            );
        }
    } else if debug_enabled {
        tracing::info!(
            message_id = %message.id,
            conversation_id = %message.conversation_id,
            project_id = %message.project_id,
            role = %message.role,
            run_id = ?message.run_id,
            "native push skipped: APNS not configured"
        );
    }

    if debug_enabled {
        tracing::info!(
            message_id = %message.id,
            conversation_id = %message.conversation_id,
            project_id = %message.project_id,
            role = %message.role,
            run_id = ?message.run_id,
            "push dispatch completed"
        );
    }

    transaction.commit().await?;
    Ok(())
}

pub(crate) async fn load_notification_recipients(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation: &crate::conversations::ConversationRecord,
    message_created_by: Option<Uuid>,
) -> anyhow::Result<Vec<Uuid>> {
    let mut candidates: HashSet<Uuid> = HashSet::new();
    if let Some(owner) = conversation.created_by {
        candidates.insert(owner);
    }
    let rows = transaction
        .query(
            "select user_id from conversation_participants where conversation_id = $1",
            &[&conversation.id],
        )
        .await?;
    for row in rows {
        let user_id: Uuid = row.get("user_id");
        candidates.insert(user_id);
    }

    if let Some(sender) = message_created_by {
        candidates.remove(&sender);
    }

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Conversation participation alone is not durable project access. A user
    // can remain in `conversation_participants` after their direct or
    // organization membership is revoked, so resolve push recipients against
    // the same current project grants used by controller authorization before
    // any private message content leaves the service.
    let candidate_ids: Vec<Uuid> = candidates.into_iter().collect();
    let rows = transaction
        .query(
            "select candidate.user_id
             from unnest($1::uuid[]) as candidate(user_id)
             join projects p on p.id = $2
             where p.status <> 'deleted'
               and (
                 p.owner_user_id = candidate.user_id
                 or exists (
                   select 1
                   from project_memberships pm
                   where pm.project_id = p.id
                     and pm.user_id = candidate.user_id
                     and lower(pm.role) in ('viewer', 'builder')
                 )
                 or exists (
                   select 1
                   from org_memberships om
                   where p.org_id is not null
                     and om.org_id = p.org_id
                     and om.user_id = candidate.user_id
                     and lower(om.role) in ('viewer', 'builder', 'admin', 'owner')
                 )
               )",
            &[&candidate_ids, &conversation.project_id],
        )
        .await?;

    let mut list: Vec<Uuid> = rows
        .into_iter()
        .map(|row| row.get::<_, Uuid>("user_id"))
        .collect();
    list.sort();
    Ok(list)
}

#[derive(Debug)]
struct WebPushEndpoint {
    id: Uuid,
    endpoint: String,
    p256dh: String,
    auth: String,
}

#[derive(Debug, Default, Clone, Copy)]
struct WebPushDispatchSummary {
    endpoint_count: usize,
    delivered_count: usize,
    expired_count: usize,
    failed_count: usize,
}

async fn send_web_push_notifications(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    recipients: &[Uuid],
    payload: &PushNotificationPayload,
    vapid_public_key: &str,
    vapid_private_key: &str,
    vapid_subject: &str,
) -> anyhow::Result<WebPushDispatchSummary> {
    let endpoints = load_web_push_endpoints(transaction, recipients).await?;
    if endpoints.is_empty() {
        return Ok(WebPushDispatchSummary::default());
    }

    let mut summary = WebPushDispatchSummary {
        endpoint_count: endpoints.len(),
        ..WebPushDispatchSummary::default()
    };
    let payload_bytes = serde_json::to_vec(payload)?;
    let signing_key = decode_vapid_signing_key(vapid_private_key)?;
    let mut expired: Vec<Uuid> = Vec::new();

    for endpoint in endpoints {
        match send_single_web_push(
            state,
            &signing_key,
            vapid_public_key,
            vapid_subject,
            &endpoint.endpoint,
            &endpoint.p256dh,
            &endpoint.auth,
            &payload_bytes,
        )
        .await
        {
            Ok(status) => {
                if status.as_u16() == 404 || status.as_u16() == 410 {
                    expired.push(endpoint.id);
                    summary.expired_count += 1;
                } else if status.is_success() {
                    summary.delivered_count += 1;
                } else {
                    summary.failed_count += 1;
                    tracing::debug!(
                        subscription_id = %endpoint.id,
                        endpoint = %endpoint.endpoint,
                        status = status.as_u16(),
                        "web push endpoint returned non-success status"
                    );
                }
            }
            Err(error) => {
                summary.failed_count += 1;
                tracing::debug!(
                    subscription_id = %endpoint.id,
                    endpoint = %endpoint.endpoint,
                    %error,
                    "failed to send web push notification"
                );
            }
        }
    }

    if !expired.is_empty() {
        transaction
            .execute(
                "delete from web_push_subscriptions where id = any($1)",
                &[&expired],
            )
            .await?;
    }

    Ok(summary)
}

async fn load_web_push_endpoints(
    transaction: &tokio_postgres::Transaction<'_>,
    recipients: &[Uuid],
) -> anyhow::Result<Vec<WebPushEndpoint>> {
    if recipients.is_empty() {
        return Ok(Vec::new());
    }

    let recipient_param: [&(dyn ToSql + Sync); 1] = [&recipients];
    let rows = transaction
        .query(
            "select id, endpoint, p256dh, auth
             from web_push_subscriptions
             where user_id = any($1)",
            &recipient_param,
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| WebPushEndpoint {
            id: row.get("id"),
            endpoint: row.get("endpoint"),
            p256dh: row.get("p256dh"),
            auth: row.get("auth"),
        })
        .collect())
}

fn decode_vapid_signing_key(raw: &str) -> anyhow::Result<SigningKey> {
    let decoded = BASE64URL.decode(raw.trim().as_bytes()).map_err(|error| {
        anyhow::anyhow!("WEB_PUSH_VAPID_PRIVATE_KEY must be base64url: {error}")
    })?;
    anyhow::ensure!(
        decoded.len() == 32,
        "WEB_PUSH_VAPID_PRIVATE_KEY must decode to 32 bytes"
    );
    let key_bytes: [u8; 32] = decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("WEB_PUSH_VAPID_PRIVATE_KEY must decode to 32 bytes"))?;
    Ok(SigningKey::from_bytes(&key_bytes.into())?)
}

fn derive_web_push_audience(endpoint: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(endpoint)?;
    let scheme = url.scheme();
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("push endpoint missing host"))?;
    let mut origin = format!("{scheme}://{host}");
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

fn build_vapid_jwt(
    signing_key: &SigningKey,
    audience: &str,
    subject: &str,
) -> anyhow::Result<String> {
    let issued_at = Utc::now();
    let expires_at = issued_at + ChronoDuration::minutes(30);
    let header = json!({ "typ": "JWT", "alg": "ES256" });
    let claims = json!({
        "aud": audience,
        "exp": expires_at.timestamp(),
        "sub": subject,
    });

    let header_raw = serde_json::to_vec(&header)?;
    let claims_raw = serde_json::to_vec(&claims)?;
    let header_b64 = BASE64URL.encode(&header_raw);
    let claims_b64 = BASE64URL.encode(&claims_raw);
    let signing_input = format!("{header_b64}.{claims_b64}");

    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let signature_b64 = BASE64URL.encode(signature.to_bytes());
    Ok(format!("{signing_input}.{signature_b64}"))
}

type HmacSha256 = Hmac<Sha256>;

fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> anyhow::Result<[u8; 32]> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(salt)
        .map_err(|_| anyhow::anyhow!("HKDF salt invalid"))?;
    mac.update(ikm);
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    Ok(out)
}

fn hkdf_expand(prk: &[u8], info: &[u8], len: usize) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        len <= 255usize * 32usize,
        "HKDF output too long: {} bytes",
        len
    );
    let mut okm: Vec<u8> = Vec::with_capacity(len);
    let mut previous: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;

    while okm.len() < len {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(prk)
            .map_err(|_| anyhow::anyhow!("HKDF PRK invalid"))?;
        mac.update(&previous);
        mac.update(info);
        mac.update(&[counter]);
        previous = mac.finalize().into_bytes().to_vec();
        okm.extend_from_slice(&previous);
        counter = counter
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("HKDF counter overflow"))?;
    }

    okm.truncate(len);
    Ok(okm)
}

#[derive(Debug)]
struct EncryptedWebPushPayload {
    salt: String,
    dh: String,
    ciphertext: Vec<u8>,
}

fn encrypt_web_push_payload(
    p256dh: &str,
    auth: &str,
    payload: &[u8],
) -> anyhow::Result<EncryptedWebPushPayload> {
    let client_public_key_bytes = BASE64URL
        .decode(p256dh.trim().as_bytes())
        .map_err(|error| anyhow::anyhow!("invalid web push p256dh key: {error}"))?;
    let client_auth_secret = BASE64URL
        .decode(auth.trim().as_bytes())
        .map_err(|error| anyhow::anyhow!("invalid web push auth secret: {error}"))?;
    anyhow::ensure!(
        client_auth_secret.len() == 16,
        "web push auth secret must decode to 16 bytes"
    );

    let client_public_key = PublicKey::from_sec1_bytes(&client_public_key_bytes)
        .map_err(|error| anyhow::anyhow!("invalid web push p256dh public key: {error}"))?;

    let sender_secret = EphemeralSecret::random(&mut OsRng);
    let sender_public_key = PublicKey::from(&sender_secret);
    let sender_public_key_bytes = sender_public_key.to_encoded_point(false);
    let sender_public_key_raw = sender_public_key_bytes.as_bytes();

    let shared = sender_secret.diffie_hellman(&client_public_key);
    let prk = hkdf_extract(&client_auth_secret, shared.raw_secret_bytes().as_slice())?;

    let mut info: Vec<u8> = Vec::with_capacity(
        "WebPush: info\0".as_bytes().len()
            + client_public_key_bytes.len()
            + sender_public_key_raw.len(),
    );
    info.extend_from_slice(b"WebPush: info\0");
    info.extend_from_slice(&client_public_key_bytes);
    info.extend_from_slice(sender_public_key_raw);

    let ikm = hkdf_expand(&prk, &info, 32)?;
    let salt: [u8; 16] = rand::random();
    let prk2 = hkdf_extract(&salt, &ikm)?;
    let cek = hkdf_expand(&prk2, b"Content-Encoding: aes128gcm\0", 16)?;
    let nonce = hkdf_expand(&prk2, b"Content-Encoding: nonce\0", 12)?;

    let cipher = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| anyhow::anyhow!("failed to construct web push cipher"))?;
    let nonce = Nonce::from_slice(&nonce);
    let mut plaintext = Vec::with_capacity(payload.len() + 1);
    plaintext.extend_from_slice(payload);
    plaintext.push(0x02);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|error| anyhow::anyhow!("failed to encrypt web push payload: {error}"))?;

    Ok(EncryptedWebPushPayload {
        salt: BASE64URL.encode(salt),
        dh: BASE64URL.encode(sender_public_key_raw),
        ciphertext,
    })
}

async fn send_single_web_push(
    state: &AppState,
    signing_key: &SigningKey,
    vapid_public_key: &str,
    vapid_subject: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &[u8],
) -> anyhow::Result<StatusCode> {
    let audience = derive_web_push_audience(endpoint)?;
    let jwt = build_vapid_jwt(signing_key, &audience, vapid_subject)?;

    let mut request = state
        .http_client
        .post(endpoint)
        .header("TTL", "3600")
        .header(
            "Authorization",
            format!("vapid t={jwt}, k={}", vapid_public_key.trim()),
        );

    match encrypt_web_push_payload(p256dh, auth, payload) {
        Ok(encrypted) => {
            request = request
                .header("Content-Encoding", "aes128gcm")
                .header("Content-Type", "application/octet-stream")
                .header("Encryption", format!("salt={}", encrypted.salt))
                .header(
                    "Crypto-Key",
                    format!("dh={}; p256ecdsa={}", encrypted.dh, vapid_public_key.trim()),
                )
                .body(encrypted.ciphertext);
        }
        Err(error) => {
            tracing::debug!(
                endpoint = %endpoint,
                %error,
                "unable to encrypt web push payload; sending without payload"
            );
            request = request
                .header(
                    "Crypto-Key",
                    format!("p256ecdsa={}", vapid_public_key.trim()),
                )
                .body(Vec::new());
        }
    }

    let response = request.send().await?;

    Ok(StatusCode::from_u16(response.status().as_u16())?)
}

async fn send_native_push_notifications(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    recipients: &[Uuid],
    message: &ConversationMessageRow,
    payload: &PushNotificationPayload,
) -> anyhow::Result<()> {
    let Some(private_key_pem) = state.config.apns_private_key.as_deref() else {
        return Ok(());
    };
    let Some(team_id) = state.config.apns_team_id.as_deref() else {
        return Ok(());
    };
    let Some(key_id) = state.config.apns_key_id.as_deref() else {
        return Ok(());
    };
    let Some(bundle_id) = state.config.apns_bundle_id.as_deref() else {
        return Ok(());
    };

    let devices = load_native_push_tokens(transaction, recipients).await?;
    if devices.is_empty() {
        return Ok(());
    }

    let jwt = build_apns_jwt(private_key_pem, team_id, key_id)?;
    let mut expired: Vec<Uuid> = Vec::new();

    for device in devices {
        let sandbox = if device.environment.eq_ignore_ascii_case("sandbox") {
            true
        } else {
            state.config.apns_use_sandbox
        };
        match send_single_apns(
            &state.http_client,
            sandbox,
            bundle_id,
            &jwt,
            &device.token,
            message,
            payload,
        )
        .await
        {
            Ok(status) => {
                if status.as_u16() == 404 || status.as_u16() == 410 {
                    expired.push(device.id);
                }
            }
            Err(error) => {
                tracing::debug!(
                    token_id = %device.id,
                    %error,
                    "failed to deliver APNs notification"
                );
            }
        }
    }

    if !expired.is_empty() {
        transaction
            .execute(
                "delete from native_push_tokens where id = any($1)",
                &[&expired],
            )
            .await?;
    }

    Ok(())
}

#[derive(Debug)]
struct NativePushTokenRow {
    id: Uuid,
    token: String,
    environment: String,
}

async fn load_native_push_tokens(
    transaction: &tokio_postgres::Transaction<'_>,
    recipients: &[Uuid],
) -> anyhow::Result<Vec<NativePushTokenRow>> {
    if recipients.is_empty() {
        return Ok(Vec::new());
    }

    let rows = transaction
        .query(
            "select id, token, environment
             from native_push_tokens
             where user_id = any($1)
               and platform = 'ios'",
            &[&recipients],
        )
        .await?;

    Ok(rows
        .into_iter()
        .map(|row| NativePushTokenRow {
            id: row.get("id"),
            token: row.get("token"),
            environment: row.get("environment"),
        })
        .collect())
}

#[derive(Debug, Serialize)]
struct ApnsJwtClaims<'a> {
    iss: &'a str,
    iat: usize,
}

fn build_apns_jwt(private_key_pem: &str, team_id: &str, key_id: &str) -> anyhow::Result<String> {
    let key = EncodingKey::from_ec_pem(private_key_pem.as_bytes())
        .map_err(|error| anyhow::anyhow!("APNS_PRIVATE_KEY is invalid: {error}"))?;
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(key_id.to_string());

    let now = Utc::now().timestamp();
    let claims = ApnsJwtClaims {
        iss: team_id,
        iat: now.max(0) as usize,
    };
    encode(&header, &claims, &key)
        .map_err(|error| anyhow::anyhow!("failed to sign APNs token: {error}"))
}

async fn send_single_apns(
    client: &reqwest::Client,
    sandbox: bool,
    bundle_id: &str,
    jwt: &str,
    device_token: &str,
    message: &ConversationMessageRow,
    payload: &PushNotificationPayload,
) -> anyhow::Result<StatusCode> {
    let host = if sandbox {
        "api.sandbox.push.apple.com"
    } else {
        "api.push.apple.com"
    };
    let url = format!("https://{host}/3/device/{}", device_token.trim());
    let apns_payload = json!({
        "aps": {
            "alert": {
                "title": payload.title.as_str(),
                "body": payload.body.as_str(),
            }
        },
        "url": payload.url.as_str(),
        "projectId": message.project_id,
        "conversationId": message.conversation_id,
        "messageId": message.id,
        "role": message.role.as_str(),
    });

    let response = client
        .post(url)
        .header("authorization", format!("bearer {jwt}"))
        .header("apns-topic", bundle_id.trim())
        .header("apns-push-type", "alert")
        .header("apns-priority", "10")
        .json(&apns_payload)
        .send()
        .await?;

    Ok(StatusCode::from_u16(response.status().as_u16())?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebPushSubscriptionKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebPushSubscriptionBody {
    endpoint: String,
    keys: WebPushSubscriptionKeys,
    user_agent: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPushSubscriptionResponse {
    ok: bool,
    subscription_id: String,
}

async fn upsert_my_web_push_subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WebPushSubscriptionBody>,
) -> Result<Json<WebPushSubscriptionResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let endpoint = body.endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err(bad_request("endpoint is required"));
    }
    let p256dh = body.keys.p256dh.trim().to_string();
    if p256dh.is_empty() {
        return Err(bad_request("keys.p256dh is required"));
    }
    let auth = body.keys.auth.trim().to_string();
    if auth.is_empty() {
        return Err(bad_request("keys.auth is required"));
    }

    let user_agent = body.user_agent.as_deref().unwrap_or("").trim().to_string();
    let user_agent = if user_agent.is_empty() {
        None
    } else {
        Some(user_agent)
    };

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let row = connection
        .query_one(
            "insert into web_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
             values ($1, $2, $3, $4, $5)
             on conflict (endpoint)
             do update set user_id = excluded.user_id,
                           p256dh = excluded.p256dh,
                           auth = excluded.auth,
                           user_agent = excluded.user_agent,
                           updated_at = now()
             returning id",
            &[&user_id, &endpoint, &p256dh, &auth, &user_agent],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to upsert web push subscription: {error}"))
        })?;
    let subscription_id: Uuid = row.get("id");

    Ok(Json(WebPushSubscriptionResponse {
        ok: true,
        subscription_id: subscription_id.to_string(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWebPushSubscriptionBody {
    endpoint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWebPushSubscriptionResponse {
    ok: bool,
}

async fn remove_my_web_push_subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RemoveWebPushSubscriptionBody>,
) -> Result<Json<RemoveWebPushSubscriptionResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let endpoint = body.endpoint.trim().to_string();
    if endpoint.is_empty() {
        return Err(bad_request("endpoint is required"));
    }

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    connection
        .execute(
            "delete from web_push_subscriptions where user_id = $1 and endpoint = $2",
            &[&user_id, &endpoint],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to remove web push subscription: {error}"))
        })?;

    Ok(Json(RemoveWebPushSubscriptionResponse { ok: true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePushTokenBody {
    token: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    environment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePushTokenResponse {
    ok: bool,
    token_id: String,
}

fn normalize_native_platform(value: Option<&str>) -> String {
    match value.unwrap_or("").trim().to_lowercase().as_str() {
        "android" => "android".to_string(),
        _ => "ios".to_string(),
    }
}

fn normalize_native_environment(value: Option<&str>) -> String {
    match value.unwrap_or("").trim().to_lowercase().as_str() {
        "sandbox" => "sandbox".to_string(),
        _ => "production".to_string(),
    }
}

async fn upsert_my_native_push_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NativePushTokenBody>,
) -> Result<Json<NativePushTokenResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let token = body.token.trim().to_string();
    if token.is_empty() {
        return Err(bad_request("token is required"));
    }
    let platform = normalize_native_platform(body.platform.as_deref());
    let environment = normalize_native_environment(body.environment.as_deref());

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let row = connection
        .query_one(
            "insert into native_push_tokens (user_id, platform, environment, token)
             values ($1, $2, $3, $4)
             on conflict (platform, token)
             do update set user_id = excluded.user_id,
                           environment = excluded.environment,
                           updated_at = now()
             returning id",
            &[&user_id, &platform, &environment, &token],
        )
        .await
        .map_err(|error| internal_error(format!("failed to upsert native push token: {error}")))?;
    let token_id: Uuid = row.get("id");

    Ok(Json(NativePushTokenResponse {
        ok: true,
        token_id: token_id.to_string(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveNativePushTokenBody {
    token: String,
    #[serde(default)]
    platform: Option<String>,
}

async fn remove_my_native_push_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RemoveNativePushTokenBody>,
) -> Result<Json<RemoveWebPushSubscriptionResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let token = body.token.trim().to_string();
    if token.is_empty() {
        return Err(bad_request("token is required"));
    }
    let platform = normalize_native_platform(body.platform.as_deref());

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    connection
        .execute(
            "delete from native_push_tokens where user_id = $1 and platform = $2 and token = $3",
            &[&user_id, &platform, &token],
        )
        .await
        .map_err(|error| internal_error(format!("failed to remove native push token: {error}")))?;

    Ok(Json(RemoveWebPushSubscriptionResponse { ok: true }))
}
