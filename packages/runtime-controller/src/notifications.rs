#[cfg(test)]
use std::collections::HashMap;
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
#[cfg(test)]
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes128Gcm, Nonce};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
#[cfg(test)]
use once_cell::sync::Lazy;
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
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::conversations::{load_conversation_record, ConversationMessageRow};
use crate::load_project_record;
use crate::projects::ensure_project_access;
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

#[cfg(test)]
static TEST_PUSH_ENQUEUE_COUNTS: Lazy<StdMutex<HashMap<Uuid, usize>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

#[cfg(test)]
pub(crate) fn take_test_push_enqueue_count(conversation_id: Uuid) -> usize {
    TEST_PUSH_ENQUEUE_COUNTS
        .lock()
        .expect("test push enqueue counter lock")
        .remove(&conversation_id)
        .unwrap_or(0)
}

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
            "/me/notifications/inbox/ack-snapshot",
            post(acknowledge_my_notification_inbox_snapshot),
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
        .layer(DefaultBodyLimit::max(8 * 1024))
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
    /// Snapshot observed by Home. Omitted by older clients.
    expected_last_message_id: Option<Uuid>,
    /// Exact durable events represented by the displayed Home row.
    notification_ids: Option<Vec<Uuid>>,
    expected_user_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationInboxAckResponse {
    ok: bool,
    /// False when a newer message arrived, or this was a durable-only row.
    inbox_acknowledged: bool,
    acknowledged_notification_ids: Vec<Uuid>,
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

async fn acknowledge_my_notification_inbox_snapshot(
    state: State<AppState>,
    headers: HeaderMap,
    Json(mut body): Json<NotificationInboxAckBody>,
) -> Result<Json<NotificationInboxAckResponse>, (StatusCode, Json<ApiError>)> {
    if body.expected_user_id.is_none() {
        return Err(bad_request(
            "expectedUserId is required for a Home snapshot",
        ));
    }
    // This distinct route makes older controllers fail closed instead of
    // silently ignoring snapshot fields and acknowledging their latest row.
    body.notification_ids.get_or_insert_with(Vec::new);
    acknowledge_my_notification_inbox_item(state, headers, Json(body)).await
}

async fn acknowledge_my_notification_inbox_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<NotificationInboxAckBody>,
) -> Result<Json<NotificationInboxAckResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    if body
        .expected_user_id
        .is_some_and(|expected| expected != user_id)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Notification session changed; refresh and try again",
            )),
        ));
    }
    if body
        .notification_ids
        .as_ref()
        .is_some_and(|ids| ids.len() > 100)
    {
        return Err(bad_request("notificationIds permits at most 100 event IDs"));
    }
    let snapshot_ack = body.expected_last_message_id.is_some() || body.notification_ids.is_some();

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    // Acquire the conversation lock before reading its visibility or membership.
    // A shared-to-private change may have committed while this request waited;
    // authorization based on the pre-lock snapshot must not enroll its caller.
    let latest = transaction
        .query_opt(
            "select last_message_id from conversations where id=$1 for update",
            &[&body.conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock conversation: {error}")))?
        .ok_or_else(|| not_found("Conversation not found"))?
        .get::<_, Option<Uuid>>(0);
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
                     limit 1 for update",
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

    // Only this exact latest source may clear the legacy inbox.
    if let Some(expected) = body.expected_last_message_id {
        let belongs = transaction.query_opt(
            "select id from conversation_messages where id=$1 and conversation_id=$2 and project_id=$3",
            &[&expected, &conversation.id, &conversation.project_id],
        ).await.map_err(|error| internal_error(format!("failed to verify inbox snapshot: {error}")))?;
        if belongs.is_none() {
            return Err(bad_request(
                "expectedLastMessageId does not belong to this conversation",
            ));
        }
    }
    let inbox_acknowledged = !snapshot_ack
        || (body.expected_last_message_id.is_some() && body.expected_last_message_id == latest);
    if inbox_acknowledged {
        let role = if conversation.created_by == Some(user_id) {
            "owner"
        } else {
            "member"
        };
        if !snapshot_ack || conversation.created_by == Some(user_id) {
            transaction
            .execute(
                "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, $3, $4)
             on conflict (conversation_id, user_id) do nothing",
                &[&conversation.id, &user_id, &role, &user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to ensure participant row: {error}"))
            })?;
        }
        // Snapshot reads never enroll a non-owner who lost participation.
        transaction
            .execute(
                "update conversation_participants
                set last_seen_message_id = coalesce($3, last_seen_message_id), last_seen_at = now()
              where conversation_id = $1 and user_id = $2",
                &[&conversation.id, &user_id, &latest],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to acknowledge notification inbox item: {error}"
                ))
            })?;
    }
    let acknowledged_notification_ids = if let Some(ids) = body.notification_ids {
        transaction
            .query(
                "update notification_recipients r
                set seen_at=coalesce(r.seen_at,clock_timestamp()),
                    read_at=coalesce(r.read_at,clock_timestamp())
               from notification_events e
              where r.event_id=e.id and r.user_id=$1 and e.id=any($2::uuid[])
                and e.conversation_id=$3 and e.project_id=$4
                and notification_recipient_authorized(e.id,$1)
              returning r.event_id",
                &[&user_id, &ids, &conversation.id, &conversation.project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to acknowledge Home notifications: {error}"))
            })?
            .iter()
            .map(|row| row.get::<_, Uuid>(0))
            .collect()
    } else {
        Vec::new()
    };

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize inbox acknowledgement: {error}"))
    })?;

    Ok(Json(NotificationInboxAckResponse {
        ok: true,
        inbox_acknowledged,
        acknowledged_notification_ids,
    }))
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

// Product producers write the durable notification outbox in their database transaction.
// This legacy hook remains solely for existing producer suppression regression assertions.
pub(crate) fn enqueue_message_push_notifications(
    _state: AppState,
    _message: ConversationMessageRow,
) {
    #[cfg(test)]
    {
        *TEST_PUSH_ENQUEUE_COUNTS
            .lock()
            .expect("test push enqueue counter lock")
            .entry(_message.conversation_id)
            .or_default() += 1;
    }
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

/// Only registry-generated display text and canonical resource links belong in this envelope.
/// Raw conversation/support content is deliberately absent from the transport interface.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushNotificationPayload {
    pub(crate) event_id: Uuid,
    pub(crate) account_id: Uuid,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliveryDisposition {
    Success,
    Transient,
    Terminal,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeliveryResult {
    pub(crate) disposition: DeliveryDisposition,
    // Fixed internal codes only: never store provider response text, URLs, or tokens.
    pub(crate) code: &'static str,
}

impl DeliveryResult {
    fn new(disposition: DeliveryDisposition, code: &'static str) -> Self {
        Self { disposition, code }
    }
}

const MAX_PUSH_ENDPOINT_BYTES: usize = 2048;
const MAX_PUSH_PAYLOAD_BYTES: usize = 3072;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024;

fn validate_push_payload(payload: &PushNotificationPayload, user_id: Uuid) -> bool {
    if payload.account_id != user_id
        || payload.event_id.is_nil()
        || payload.title.is_empty()
        || payload.title.len() > 160
        || payload.body.len() > 512
        || payload.title.chars().any(char::is_control)
        || payload.body.chars().any(char::is_control)
        || payload.url.len() > 1024
        || !payload.url.starts_with("/studio?")
        || payload.url.contains('\\')
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(&format!("https://notification.invalid{}", payload.url))
    else {
        return false;
    };
    if url.path() != "/studio" || url.fragment().is_some() {
        return false;
    }
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "projectId" | "conversationControllerId" | "supportReportId" | "notificationEventId"
        ) || !seen.insert(key.into_owned())
            || Uuid::parse_str(&value).is_err()
        {
            return false;
        }
    }
    let support = seen.contains("supportReportId");
    let project = seen.contains("projectId");
    let conversation = seen.contains("conversationControllerId");
    (support && !project && !conversation) || (!support && project)
}

fn is_public_push_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 168)
                || (a == 198 && (18..=19).contains(&b))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            // Accept global unicast only. This excludes mapped IPv4, NAT64, local,
            // multicast and unspecified ranges; also exclude special/tunnel/doc ranges.
            let [a, b, ..] = ip.segments();
            (a & 0xe000) == 0x2000
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
                && a != 0x2002
                && !(a == 0x3fff && b < 0x1000)
        }
    }
}

fn parse_web_push_endpoint(endpoint: &str) -> Result<reqwest::Url, &'static str> {
    if endpoint.is_empty()
        || endpoint.len() > MAX_PUSH_ENDPOINT_BYTES
        || endpoint.chars().any(char::is_control)
        || endpoint.contains('\\')
    {
        return Err("invalid_endpoint");
    }
    let url = reqwest::Url::parse(endpoint).map_err(|_| "invalid_endpoint")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("invalid_endpoint");
    }
    let host = url.host_str().ok_or("invalid_endpoint")?;
    let host = host.trim_matches(['[', ']']);
    if let Ok(address) = host.parse::<IpAddr>() {
        if !is_public_push_address(address) {
            return Err("unsafe_endpoint");
        }
    } else if !host.contains('.')
        || host.ends_with('.')
        || host.eq_ignore_ascii_case("localhost")
        || [".localhost", ".local", ".internal", ".home", ".lan"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
    {
        return Err("unsafe_endpoint");
    }
    Ok(url)
}

fn validate_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), &'static str> {
    if addresses.is_empty() {
        return Err("endpoint_dns_failed");
    }
    if addresses
        .iter()
        .any(|address| !is_public_push_address(address.ip()))
    {
        return Err("unsafe_endpoint");
    }
    Ok(())
}

async fn resolve_push_endpoint(url: &reqwest::Url) -> Result<Vec<SocketAddr>, &'static str> {
    let host = url
        .host_str()
        .ok_or("invalid_endpoint")?
        .trim_matches(['[', ']']);
    let addresses = if let Ok(address) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(address, 443)]
    } else {
        tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| "endpoint_dns_failed")?
            .map_err(|_| "endpoint_dns_failed")?
            .collect::<Vec<_>>()
    };
    validate_resolved_addresses(&addresses)?;
    Ok(addresses)
}

fn secure_push_client(
    url: &reqwest::Url,
    addresses: &[SocketAddr],
) -> Result<reqwest::Client, &'static str> {
    validate_resolved_addresses(addresses)?;
    // Resolve once, reject any private result, then pin that exact set for this attempt.
    // No connection pool survives between attempts, so DNS changes are revalidated.
    reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .resolve_to_addrs(url.host_str().ok_or("invalid_endpoint")?, addresses)
        .build()
        .map_err(|_| "provider_client_failed")
}

fn validate_web_push_keys(p256dh: &str, auth: &str) -> Result<(), &'static str> {
    if p256dh.len() != 87 || auth.len() != 22 {
        return Err("invalid_subscription_keys");
    }
    let public_key = BASE64URL
        .decode(p256dh)
        .map_err(|_| "invalid_subscription_keys")?;
    let auth = BASE64URL
        .decode(auth)
        .map_err(|_| "invalid_subscription_keys")?;
    if public_key.len() != 65 || public_key.first() != Some(&4) || auth.len() != 16 {
        return Err("invalid_subscription_keys");
    }
    PublicKey::from_sec1_bytes(&public_key).map_err(|_| "invalid_subscription_keys")?;
    Ok(())
}

fn validate_native_token(token: &str, platform: &str) -> Result<(), &'static str> {
    if token.is_empty() || token.len() > 512 || token.chars().any(char::is_control) {
        return Err("invalid_device_token");
    }
    // APNs tokens are variable-length opaque bytes represented as hexadecimal.
    if platform == "ios"
        && (token.len() % 2 != 0 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("invalid_device_token");
    }
    Ok(())
}

fn provider_response_result(
    channel: &str,
    status: u16,
    apns_reason: Option<&str>,
) -> DeliveryResult {
    use DeliveryDisposition::*;
    if (200..300).contains(&status) {
        DeliveryResult::new(Success, "accepted")
    } else if status == 410
        || (channel == "web_push" && status == 404)
        || (channel == "apns" && status == 400 && apns_reason == Some("BadDeviceToken"))
    {
        DeliveryResult::new(Expired, "endpoint_expired")
    } else if status == 408 || status == 425 || status == 429 || (500..600).contains(&status) {
        DeliveryResult::new(
            Transient,
            if status == 429 {
                "provider_rate_limited"
            } else {
                "provider_unavailable"
            },
        )
    } else if status == 401 || status == 403 {
        DeliveryResult::new(Terminal, "provider_auth_rejected")
    } else {
        DeliveryResult::new(Terminal, "provider_rejected")
    }
}

async fn execute_push_request(request: reqwest::RequestBuilder, channel: &str) -> DeliveryResult {
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            return DeliveryResult::new(DeliveryDisposition::Transient, "provider_network_error")
        }
    };
    let status = response.status().as_u16();
    if channel != "apns" || (200..300).contains(&status) {
        return provider_response_result(channel, status, None);
    }
    // Only the bounded APNs reason is used for classification; response text is never persisted.
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= MAX_PROVIDER_RESPONSE_BYTES => {
                body.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return provider_response_result(channel, status, None),
        }
    }
    let value = serde_json::from_slice::<JsonValue>(&body).ok();
    provider_response_result(
        channel,
        status,
        value
            .as_ref()
            .and_then(|value| value.get("reason"))
            .and_then(JsonValue::as_str),
    )
}

fn web_push_request(
    client: &reqwest::Client,
    url: &reqwest::Url,
    jwt: &str,
    public_key: &str,
    payload: Vec<u8>,
    event_id: Uuid,
) -> reqwest::RequestBuilder {
    client
        .post(url.clone())
        .header("TTL", "3600")
        .header("Topic", event_id.simple().to_string())
        .header("Authorization", format!("vapid t={jwt}, k={public_key}"))
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .body(payload)
}

fn apns_request(
    client: &reqwest::Client,
    url: &reqwest::Url,
    jwt: &str,
    bundle_id: &str,
    payload: &PushNotificationPayload,
) -> reqwest::RequestBuilder {
    client
        .post(url.clone())
        .header("authorization", format!("bearer {jwt}"))
        .header("apns-topic", bundle_id.trim())
        .header("apns-push-type", "alert")
        .header("apns-priority", "10")
        .header("apns-id", payload.event_id.to_string())
        .header("apns-collapse-id", payload.event_id.to_string())
        .json(&json!({
            "aps": { "alert": { "title": payload.title, "body": payload.body } },
            "eventId": payload.event_id,
            "accountId": payload.account_id,
            "url": payload.url,
        }))
}

// Recheck after DNS, client preparation and encryption. The snapshot also fences
// a token re-registration/account switch while the attempt was being prepared.
async fn revalidate_delivery_endpoint(
    state: &AppState,
    channel: &str,
    endpoint_id: Uuid,
    lease_token: Uuid,
    payload: &PushNotificationPayload,
    endpoint_updated_at: DateTime<Utc>,
) -> Result<(), DeliveryResult> {
    let connection = state.pool.get().await.map_err(|_| {
        DeliveryResult::new(DeliveryDisposition::Transient, "endpoint_lookup_failed")
    })?;
    let generic_preview =
        payload.title == "Instafy" && payload.body == "You have a new notification.";
    let authorized: bool = connection.query_one(
        "select exists(select 1 from notification_delivery_jobs j
           where j.event_id=$1 and j.user_id=$2 and j.channel=$3 and j.endpoint_id=$4
             and j.status='leased' and j.lease_until>clock_timestamp() and j.lease_token=$7
             and notification_delivery_authorized(j.id)
             and ($6 or not coalesce((select hide_previews from notification_settings where user_id=$2), true))
             and case j.channel
               when 'web_push' then exists(select 1 from web_push_subscriptions w where w.id=$4 and w.user_id=$2 and w.updated_at=$5)
               when 'apns' then exists(select 1 from native_push_tokens n where n.id=$4 and n.user_id=$2 and n.platform='ios' and n.updated_at=$5)
               else false end)",
        &[&payload.event_id, &payload.account_id, &channel, &endpoint_id, &endpoint_updated_at, &generic_preview, &lease_token],
    ).await.map_err(|_| DeliveryResult::new(DeliveryDisposition::Transient, "endpoint_lookup_failed"))?.get(0);
    if authorized {
        Ok(())
    } else {
        Err(DeliveryResult::new(
            DeliveryDisposition::Terminal,
            "delivery_eligibility_changed",
        ))
    }
}

/// Loads only the claimed account's endpoint, releases the database connection, then sends.
/// The worker owns leasing, authorization, retry policy, and conditional expired-endpoint cleanup.
pub(crate) async fn deliver_notification(
    state: &AppState,
    channel: &str,
    endpoint_id: Uuid,
    user_id: Uuid,
    lease_token: Uuid,
    payload: &PushNotificationPayload,
) -> DeliveryResult {
    use DeliveryDisposition::*;
    if !validate_push_payload(payload, user_id) {
        return DeliveryResult::new(Terminal, "invalid_payload");
    }
    let payload_bytes = match serde_json::to_vec(payload) {
        Ok(bytes) if bytes.len() <= MAX_PUSH_PAYLOAD_BYTES => bytes,
        _ => return DeliveryResult::new(Terminal, "invalid_payload"),
    };
    let query = match channel {
        "web_push" => "select endpoint, p256dh, auth, updated_at from web_push_subscriptions where id = $1 and user_id = $2",
        "apns" => "select token, environment, updated_at from native_push_tokens where id = $1 and user_id = $2 and platform = 'ios'",
        _ => return DeliveryResult::new(Terminal, "unsupported_channel"),
    };
    let row = {
        let connection = match state.pool.get().await {
            Ok(connection) => connection,
            Err(_) => return DeliveryResult::new(Transient, "endpoint_lookup_failed"),
        };
        match connection.query_opt(query, &[&endpoint_id, &user_id]).await {
            Ok(Some(row)) => row,
            Ok(None) => return DeliveryResult::new(Expired, "endpoint_missing"),
            Err(_) => return DeliveryResult::new(Transient, "endpoint_lookup_failed"),
        }
    };
    let endpoint_updated_at: DateTime<Utc> = row.get("updated_at");
    if channel == "web_push" {
        let (Some(private_key), Some(public_key)) = (
            state.config.web_push_vapid_private_key.as_deref(),
            state.config.web_push_vapid_public_key.as_deref(),
        ) else {
            return DeliveryResult::new(Terminal, "provider_not_configured");
        };
        let endpoint: String = row.get("endpoint");
        let p256dh: String = row.get("p256dh");
        let auth: String = row.get("auth");
        if validate_web_push_keys(&p256dh, &auth).is_err() {
            return DeliveryResult::new(Expired, "invalid_subscription_keys");
        }
        let url = match parse_web_push_endpoint(&endpoint) {
            Ok(url) => url,
            Err(code) => return DeliveryResult::new(Terminal, code),
        };
        let addresses = match resolve_push_endpoint(&url).await {
            Ok(addresses) => addresses,
            Err(code) => {
                return DeliveryResult::new(
                    if code == "endpoint_dns_failed" {
                        Transient
                    } else {
                        Terminal
                    },
                    code,
                )
            }
        };
        let client = match secure_push_client(&url, &addresses) {
            Ok(client) => client,
            Err(code) => return DeliveryResult::new(Terminal, code),
        };
        let signing_key = match decode_vapid_signing_key(private_key) {
            Ok(key)
                if BASE64URL.encode(key.verifying_key().to_encoded_point(false).as_bytes())
                    == public_key.trim() =>
            {
                key
            }
            _ => return DeliveryResult::new(Terminal, "provider_configuration_invalid"),
        };
        let subject = state
            .config
            .web_push_vapid_subject
            .as_deref()
            .unwrap_or("mailto:notifications@instafy.dev");
        let jwt = match build_vapid_jwt(&signing_key, &url.origin().ascii_serialization(), subject)
        {
            Ok(jwt) => jwt,
            Err(_) => return DeliveryResult::new(Terminal, "provider_configuration_invalid"),
        };
        let encrypted = match encrypt_web_push_payload(&p256dh, &auth, &payload_bytes) {
            Ok(encrypted) => encrypted,
            Err(_) => return DeliveryResult::new(Terminal, "payload_encryption_failed"),
        };
        if let Err(result) = revalidate_delivery_endpoint(
            state,
            channel,
            endpoint_id,
            lease_token,
            payload,
            endpoint_updated_at,
        )
        .await
        {
            return result;
        }
        execute_push_request(
            web_push_request(
                &client,
                &url,
                &jwt,
                public_key.trim(),
                encrypted,
                payload.event_id,
            ),
            channel,
        )
        .await
    } else {
        let (Some(private_key), Some(team_id), Some(key_id), Some(bundle_id)) = (
            state.config.apns_private_key.as_deref(),
            state.config.apns_team_id.as_deref(),
            state.config.apns_key_id.as_deref(),
            state.config.apns_bundle_id.as_deref(),
        ) else {
            return DeliveryResult::new(Terminal, "provider_not_configured");
        };
        let token: String = row.get("token");
        let environment: String = row.get("environment");
        if validate_native_token(&token, "ios").is_err() {
            return DeliveryResult::new(Expired, "invalid_device_token");
        }
        let host = if environment == "sandbox" {
            "api.sandbox.push.apple.com"
        } else if environment == "production" {
            "api.push.apple.com"
        } else {
            return DeliveryResult::new(Terminal, "invalid_device_environment");
        };
        let url = reqwest::Url::parse(&format!("https://{host}/3/device/{token}"))
            .expect("fixed APNs endpoint and validated token");
        let addresses = match resolve_push_endpoint(&url).await {
            Ok(addresses) => addresses,
            Err(code) => {
                return DeliveryResult::new(
                    if code == "endpoint_dns_failed" {
                        Transient
                    } else {
                        Terminal
                    },
                    code,
                )
            }
        };
        let client = match secure_push_client(&url, &addresses) {
            Ok(client) => client,
            Err(code) => return DeliveryResult::new(Terminal, code),
        };
        let jwt = match build_apns_jwt(private_key, team_id, key_id) {
            Ok(jwt) => jwt,
            Err(_) => return DeliveryResult::new(Terminal, "provider_configuration_invalid"),
        };
        if let Err(result) = revalidate_delivery_endpoint(
            state,
            channel,
            endpoint_id,
            lease_token,
            payload,
            endpoint_updated_at,
        )
        .await
        {
            return result;
        }
        execute_push_request(
            apns_request(&client, &url, &jwt, bundle_id, payload),
            channel,
        )
        .await
    }
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

fn encrypt_web_push_payload(p256dh: &str, auth: &str, payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    validate_web_push_keys(p256dh, auth).map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        payload.len() <= MAX_PUSH_PAYLOAD_BYTES,
        "push payload too large"
    );
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
    encrypt_web_push_record(
        &client_public_key_bytes,
        &client_auth_secret,
        shared.raw_secret_bytes().as_ref(),
        sender_public_key_raw,
        &rand::random(),
        payload,
    )
}

fn encrypt_web_push_record(
    client_public_key_bytes: &[u8],
    client_auth_secret: &[u8],
    shared_secret: &[u8],
    sender_public_key_raw: &[u8],
    salt: &[u8; 16],
    payload: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let prk = hkdf_extract(client_auth_secret, shared_secret)?;
    let mut info: Vec<u8> = Vec::with_capacity(
        "WebPush: info\0".as_bytes().len()
            + client_public_key_bytes.len()
            + sender_public_key_raw.len(),
    );
    info.extend_from_slice(b"WebPush: info\0");
    info.extend_from_slice(&client_public_key_bytes);
    info.extend_from_slice(sender_public_key_raw);

    let ikm = hkdf_expand(&prk, &info, 32)?;
    let prk2 = hkdf_extract(salt, &ikm)?;
    let cek = hkdf_expand(&prk2, b"Content-Encoding: aes128gcm\0", 16)?;
    let nonce = hkdf_expand(&prk2, b"Content-Encoding: nonce\0", 12)?;

    let cipher = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| anyhow::anyhow!("failed to construct web push cipher"))?;
    let nonce: [u8; 12] = nonce
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid nonce length"))?;
    let nonce = Nonce::from(nonce);
    let mut plaintext = Vec::with_capacity(payload.len() + 1);
    plaintext.extend_from_slice(payload);
    plaintext.push(0x02);

    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_ref())
        .map_err(|error| anyhow::anyhow!("failed to encrypt web push payload: {error}"))?;

    // RFC 8188 section 2.1: aes128gcm uses a binary body header, not the legacy
    // Encryption/Crypto-Key HTTP headers. One record, with the final 0x02 delimiter.
    let mut encoded = Vec::with_capacity(86 + ciphertext.len());
    encoded.extend_from_slice(salt);
    encoded.extend_from_slice(&4096u32.to_be_bytes());
    encoded.push(65);
    encoded.extend_from_slice(sender_public_key_raw);
    encoded.extend_from_slice(&ciphertext);
    Ok(encoded)
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

// Serialize each account's registration updates so concurrent clients cannot
// exceed the cap. The lock and count live only in the short database transaction,
// after endpoint DNS/key validation and before registration commit.
async fn check_registration_capacity(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: Uuid,
    channel: &str,
    endpoint: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let lock_key = format!("notification-endpoints:{user_id}");
    transaction
        .execute(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|_| internal_error("Unable to register notification device"))?;
    let query = match channel {
        "web_push" => "select count(*) < 32 or coalesce(bool_or(endpoint = $2), false) from web_push_subscriptions where user_id = $1",
        "apns" => "select count(*) < 32 or coalesce(bool_or(token = $2), false) from native_push_tokens where user_id = $1 and platform = 'ios'",
        _ => return Err(bad_request("Unsupported notification channel")),
    };
    let allowed: bool = transaction
        .query_one(query, &[&user_id, &endpoint])
        .await
        .map_err(|_| internal_error("Unable to register notification device"))?
        .get(0);
    if !allowed {
        return Err(bad_request(
            "At most 32 notification devices can be registered per channel",
        ));
    }
    Ok(())
}

async fn upsert_my_web_push_subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WebPushSubscriptionBody>,
) -> Result<Json<WebPushSubscriptionResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let endpoint = body.endpoint.trim().to_string();
    let endpoint_url = parse_web_push_endpoint(&endpoint)
        .map_err(|_| bad_request("endpoint must be a public HTTPS URL on port 443"))?;
    let endpoint = endpoint_url.as_str().to_owned();
    let p256dh = body.keys.p256dh.trim().to_string();
    let auth = body.keys.auth.trim().to_string();
    validate_web_push_keys(&p256dh, &auth)
        .map_err(|_| bad_request("invalid Web Push subscription keys"))?;

    let user_agent = body.user_agent.as_deref().unwrap_or("").trim().to_string();
    if user_agent.len() > 512 || user_agent.chars().any(char::is_control) {
        return Err(bad_request(
            "userAgent must be at most 512 bytes without control characters",
        ));
    }
    resolve_push_endpoint(&endpoint_url)
        .await
        .map_err(|_| bad_request("endpoint must resolve only to public addresses"))?;
    let user_agent = if user_agent.is_empty() {
        None
    } else {
        Some(user_agent)
    };

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let transaction = connection
        .transaction()
        .await
        .map_err(|_| internal_error("Unable to register notification device"))?;
    check_registration_capacity(&transaction, user_id, "web_push", &endpoint).await?;
    let row = transaction
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

    transaction
        .commit()
        .await
        .map_err(|_| internal_error("Unable to register notification device"))?;

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
    if endpoint.is_empty() || endpoint.len() > MAX_PUSH_ENDPOINT_BYTES {
        return Err(bad_request("endpoint must be between 1 and 2048 bytes"));
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

fn normalize_native_platform(value: Option<&str>) -> Result<&'static str, &'static str> {
    match value.unwrap_or("ios").trim().to_ascii_lowercase().as_str() {
        "ios" => Ok("ios"),
        "android" => Ok("android"),
        _ => Err("platform must be ios or android"),
    }
}

fn normalize_native_environment(
    value: Option<&str>,
    default_sandbox: bool,
) -> Result<&'static str, &'static str> {
    match value
        .unwrap_or(if default_sandbox {
            "sandbox"
        } else {
            "production"
        })
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "sandbox" => Ok("sandbox"),
        "production" => Ok("production"),
        _ => Err("environment must be sandbox or production"),
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
    let platform = normalize_native_platform(body.platform.as_deref()).map_err(bad_request)?;
    if platform == "android" {
        return Err(bad_request(
            "Android push registration is disabled because delivery is not yet supported",
        ));
    }
    validate_native_token(&token, platform).map_err(bad_request)?;
    let environment =
        normalize_native_environment(body.environment.as_deref(), state.config.apns_use_sandbox)
            .map_err(bad_request)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let transaction = connection
        .transaction()
        .await
        .map_err(|_| internal_error("Unable to register notification device"))?;
    check_registration_capacity(&transaction, user_id, "apns", &token).await?;
    let row = transaction
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

    transaction
        .commit()
        .await
        .map_err(|_| internal_error("Unable to register notification device"))?;

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
    let platform = normalize_native_platform(body.platform.as_deref()).map_err(bad_request)?;
    validate_native_token(&token, platform).map_err(bad_request)?;

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

#[cfg(test)]
#[path = "notification_transport_tests.rs"]
mod notification_transport_tests;
