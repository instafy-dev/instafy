//! Durable inbox and leased delivery worker. Product transactions enqueue in
//! database triggers; presentation never owns delivery or customer support cursors.
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::notifications::{
    deliver_notification, DeliveryDisposition, DeliveryResult, PushNotificationPayload,
};
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

const CATEGORIES: &[&str] = &["support", "conversations", "runs", "automations"];
const CHANNELS: &[&str] = &["web_push", "apns", "local"];
const MAX_ATTEMPTS: i32 = 8;
type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

/// Deliberately has no arbitrary content input. Even opted-in previews only
/// reveal the kind of event, never conversation or support message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventKind {
    SupportReply,
    SupportResolved,
    ConversationReply,
    RunFailed,
    AutomationCompleted,
    AutomationFailed,
}

impl EventKind {
    fn parse(name: &str, version: i32) -> Option<Self> {
        if version != 1 {
            return None;
        }
        Some(match name {
            "support.reply" => Self::SupportReply,
            "support.resolved" => Self::SupportResolved,
            "conversation.reply" => Self::ConversationReply,
            "run.failed" => Self::RunFailed,
            "automation.completed" => Self::AutomationCompleted,
            "automation.failed" => Self::AutomationFailed,
            _ => return None,
        })
    }

    fn text(self) -> (&'static str, &'static str) {
        match self {
            Self::SupportReply => (
                "Support replied",
                "There is a new reply to your support report.",
            ),
            Self::SupportResolved => (
                "Support report resolved",
                "Your support report has been resolved.",
            ),
            Self::ConversationReply => (
                "New conversation reply",
                "There is a new reply in your conversation.",
            ),
            Self::RunFailed => ("Run needs attention", "A run could not finish."),
            Self::AutomationCompleted => ("Automation completed", "Your automation has finished."),
            Self::AutomationFailed => (
                "Automation needs attention",
                "Your automation could not finish.",
            ),
        }
    }

    fn url(self, resource_id: Uuid, project: Option<Uuid>, conversation: Option<Uuid>) -> String {
        match self {
            Self::SupportReply | Self::SupportResolved => {
                format!("/studio?supportReportId={resource_id}")
            }
            _ => match (project, conversation) {
                (Some(project), Some(conversation)) => {
                    format!("/studio?projectId={project}&conversationControllerId={conversation}")
                }
                (Some(project), None) => format!("/studio?projectId={project}"),
                _ => "/studio".to_owned(),
            },
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/notifications", get(list))
        .route("/me/notifications/state", post(change_state))
        .route("/me/notifications/read-all", post(read_all))
        .route(
            "/me/notifications/conversation-read",
            post(read_conversation_messages),
        )
        .route(
            "/me/notifications/preferences",
            get(preferences).post(save_preferences),
        )
        .layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    view: Option<String>,
    limit: Option<i64>,
    before: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: Uuid,
    event_name: String,
    version: i32,
    category: String,
    resource_type: String,
    resource_id: Uuid,
    occurred_at: DateTime<Utc>,
    title: String,
    body: String,
    url: String,
    seen_at: Option<DateTime<Utc>>,
    read_at: Option<DateTime<Utc>>,
    archived_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    ok: bool,
    items: Vec<Item>,
    next_cursor: Option<String>,
    unread_count: i64,
    as_of: DateTime<Utc>,
}

fn decode_cursor(value: &str) -> Option<(DateTime<Utc>, Uuid)> {
    if value.len() > 160 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let (date, id) = text.split_once('|')?;
    Some((
        DateTime::parse_from_rfc3339(date).ok()?.with_timezone(&Utc),
        Uuid::parse_str(id).ok()?,
    ))
}

fn encode_cursor(date: DateTime<Utc>, id: Uuid) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{id}", date.to_rfc3339()))
}

fn item(row: &Row) -> Item {
    let event_name: String = row.get("event_name");
    let version = row.get("version");
    let kind = EventKind::parse(&event_name, version);
    let resource_id = row.get("resource_id");
    let (title, body) = kind
        .map(EventKind::text)
        .unwrap_or(("Instafy", "You have a new notification."));
    let url = kind
        .map(|kind| {
            kind.url(
                resource_id,
                row.get("project_id"),
                row.get("conversation_id"),
            )
        })
        .unwrap_or_else(|| "/studio".to_owned());
    Item {
        id: row.get("id"),
        event_name,
        version,
        category: row.get("category"),
        resource_type: row.get("resource_type"),
        resource_id,
        occurred_at: row.get("occurred_at"),
        title: title.to_owned(),
        body: body.to_owned(),
        url,
        seen_at: row.get("seen_at"),
        read_at: row.get("read_at"),
        archived_at: row.get("archived_at"),
    }
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> ApiResult<Page> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user = require_user_session(&context)?;
    let unread = match query.view.as_deref().unwrap_or("all") {
        "all" => false,
        "unread" => true,
        _ => return Err(bad_request("Unknown notification view")),
    };
    let cursor = query
        .before
        .as_deref()
        .map(|value| decode_cursor(value).ok_or_else(|| bad_request("Invalid notification cursor")))
        .transpose()?;
    let limit = query.limit.unwrap_or(25).clamp(1, 100);
    let connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Notification database unavailable"))?;
    let as_of: DateTime<Utc> = connection
        .query_one("select clock_timestamp()", &[])
        .await
        .map_err(|_| internal_error("Unable to read notification time"))?
        .get(0);
    let before_time = cursor.map(|cursor| cursor.0);
    let before_id = cursor.map(|cursor| cursor.1);
    let rows = connection
        .query(
            "select e.*, r.seen_at, r.read_at, r.archived_at from notification_recipients r
         join notification_events e on e.id = r.event_id
         where r.user_id = $1 and r.archived_at is null and (not $2 or r.read_at is null)
           and notification_recipient_authorized(e.id, $1)
           and ($3::timestamptz is null or (e.occurred_at, e.id) < ($3, $4::uuid))
         order by e.occurred_at desc, e.id desc limit $5",
            &[&user, &unread, &before_time, &before_id, &(limit + 1)],
        )
        .await
        .map_err(|_| internal_error("Unable to load notifications"))?;
    let unread_count = connection.query_one(
        "select count(*) from notification_recipients r where r.user_id = $1
         and r.read_at is null and r.archived_at is null and notification_recipient_authorized(r.event_id, $1)",
        &[&user],
    ).await.map_err(|_| internal_error("Unable to count notifications"))?.get(0);
    let has_more = rows.len() as i64 > limit;
    let items: Vec<Item> = rows.iter().take(limit as usize).map(item).collect();
    let next_cursor = if has_more {
        items
            .last()
            .map(|item| encode_cursor(item.occurred_at, item.id))
    } else {
        None
    };
    Ok(Json(Page {
        ok: true,
        items,
        next_cursor,
        unread_count,
        as_of,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum StateAction {
    Seen,
    Read,
    Archive,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StateBody {
    id: Uuid,
    action: StateAction,
    #[serde(rename = "expectedUserId")]
    expected_user_id: Option<Uuid>,
}
#[derive(Serialize)]
struct OkBody {
    ok: bool,
}

async fn change_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StateBody>,
) -> ApiResult<OkBody> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user = require_user_session(&context)?;
    if body
        .expected_user_id
        .is_some_and(|expected| expected != user)
    {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Notification session changed; refresh and try again",
            )),
        ));
    }
    let (read, archive) = (
        matches!(body.action, StateAction::Read | StateAction::Archive),
        matches!(body.action, StateAction::Archive),
    );
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Notification database unavailable"))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|_| internal_error("Unable to start notification acknowledgement"))?;
    // A Home support row acknowledges its source only when the explicitly
    // selected event is still the report's current activity. Lock in the same
    // order as support producers; concurrent replies retain their source badge.
    let support = if read {
        transaction
            .query_opt(
                "select b.id, b.support_last_message_at, e.occurred_at
               from bug_reports b join notification_events e on e.resource_id=b.id
              where e.id=$1 and e.resource_type='support_report' and b.user_id=$2
                and (e.event_name<>'support.resolved' or e.producer_key='support.resolved:'||b.id::text||':'||b.notification_resolution_sequence::text)
                and notification_recipient_authorized(e.id,$2)
              for update of b",
                &[&body.id, &user],
            )
            .await
            .map_err(|_| internal_error("Unable to inspect support notification"))?
    } else {
        None
    };
    let conversation = if read {
        transaction
            .query_opt(
                "select c.id, c.created_by, c.last_message_id, m.id as source_message_id
               from notification_events e
               join conversation_messages m on e.producer_key='conversation.reply:'||m.id::text
               join conversations c on c.id=m.conversation_id and c.project_id=m.project_id
              where e.id=$1 and e.event_name='conversation.reply' and e.resource_type='conversation'
                and e.resource_id=c.id and e.conversation_id=c.id and e.project_id=c.project_id
                and notification_recipient_authorized(e.id,$2)
              for update of c",
                &[&body.id, &user],
            )
            .await
            .map_err(|_| internal_error("Unable to inspect conversation notification"))?
    } else {
        None
    };
    let changed = transaction.execute(
        "update notification_recipients set seen_at = coalesce(seen_at, clock_timestamp()),
          read_at = case when $3 then coalesce(read_at, clock_timestamp()) else read_at end,
          archived_at = case when $4 then coalesce(archived_at, clock_timestamp()) else archived_at end
         where event_id = $1 and user_id = $2 and notification_recipient_authorized(event_id, user_id)",
        &[&body.id, &user, &read, &archive],
    ).await.map_err(|_| internal_error("Unable to update notification"))?;
    if changed == 0 {
        return Err(not_found("Notification not found"));
    }
    if let Some(conversation) = conversation {
        let message_id: Uuid = conversation.get("source_message_id");
        if conversation.get::<_, Option<Uuid>>("last_message_id") == Some(message_id) {
            let conversation_id: Uuid = conversation.get("id");
            // A one-off mention does not subscribe its recipient to later replies.
            if conversation.get::<_, Option<Uuid>>("created_by") == Some(user) {
                transaction.execute(
                    "insert into conversation_participants(conversation_id,user_id,role,added_by)
                     values($1,$2,'owner',$2) on conflict(conversation_id,user_id) do nothing",
                    &[&conversation_id, &user],
                ).await.map_err(|_| internal_error("Unable to acknowledge conversation owner"))?;
            }
            transaction.execute(
                "update conversation_participants set last_seen_message_id=$3,last_seen_at=now()
                  where conversation_id=$1 and user_id=$2",
                &[&conversation_id, &user, &message_id],
            ).await.map_err(|_| internal_error("Unable to acknowledge conversation activity"))?;
        }
    }
    if let Some(support) = support {
        let occurred_at: DateTime<Utc> = support.get("occurred_at");
        if support.get::<_, Option<DateTime<Utc>>>("support_last_message_at") == Some(occurred_at) {
            let report_id: Uuid = support.get("id");
            transaction
                .execute(
                    "update bug_reports
                    set customer_last_seen_support_at=greatest(customer_last_seen_support_at,$2)
                  where id=$1",
                    &[&report_id, &occurred_at],
                )
                .await
                .map_err(|_| internal_error("Unable to acknowledge support activity"))?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|_| internal_error("Unable to finalize notification acknowledgement"))?;
    Ok(Json(OkBody { ok: true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversationReadBody {
    conversation_id: Uuid,
    message_ids: Vec<Uuid>,
    expected_user_id: Uuid,
}

async fn read_conversation_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ConversationReadBody>,
) -> ApiResult<OkBody> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user = require_user_session(&context)?;
    if user != body.expected_user_id {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Notification session changed; refresh and try again",
            )),
        ));
    }
    if body.message_ids.len() > 100 {
        return Err(bad_request("messageIds permits at most 100 message IDs"));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Notification database unavailable"))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|_| internal_error("Unable to start conversation acknowledgement"))?;
    // Serialize the source cursor with new messages and other readers. An old
    // viewport retry can acknowledge its own events but cannot regress a newer
    // legacy cursor. Reading never enrolls a one-off mentioned recipient.
    let source = transaction
        .query_opt(
            "select last_message_id from conversations where id=$1
           and notification_conversation_authorized($1,$2) for update",
            &[&body.conversation_id, &user],
        )
        .await
        .map_err(|_| internal_error("Unable to inspect conversation activity"))?
        .ok_or_else(|| not_found("Conversation not found"))?;
    let latest: Option<Uuid> = source.get("last_message_id");
    // Only exact persisted messages from the client's visible snapshot qualify.
    // A server-latest or timestamp cutoff could swallow an unseen message that
    // arrived during loading, including a late commit with an older timestamp.
    // Authorization and mutation share one statement snapshot. Neither support
    // cursors nor another recipient's notification state are modified here.
    let result = transaction
        .query_one(
            "with access as materialized (
           select notification_conversation_authorized($1, $2) as allowed
         ), marked as (
           update notification_recipients r
              set seen_at = coalesce(r.seen_at, clock_timestamp()),
                  read_at = coalesce(r.read_at, clock_timestamp())
             from notification_events e
             join conversation_messages m on e.producer_key = 'conversation.reply:' || m.id::text
             join conversations c on c.id = m.conversation_id and c.project_id = m.project_id
            where (select allowed from access)
              and r.user_id = $2 and r.event_id = e.id
              and e.event_name = 'conversation.reply' and e.version = 1
              and e.resource_type = 'conversation' and e.resource_id = $1
              and e.conversation_id = $1 and e.project_id = m.project_id
              and m.conversation_id = $1 and m.id = any($3::uuid[])
           returning r.event_id
         )
         select allowed, (select count(*) from marked) as marked_count from access",
            &[&body.conversation_id, &user, &body.message_ids],
        )
        .await
        .map_err(|_| internal_error("Unable to mark conversation notifications read"))?;
    if !result.get::<_, bool>("allowed") {
        return Err(not_found("Conversation not found"));
    }
    if latest.is_some_and(|id| body.message_ids.contains(&id)) {
        transaction
            .execute(
                "update conversation_participants set last_seen_message_id=$3,last_seen_at=now()
              where conversation_id=$1 and user_id=$2",
                &[&body.conversation_id, &user, &latest],
            )
            .await
            .map_err(|_| internal_error("Unable to acknowledge conversation activity"))?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| internal_error("Unable to finalize conversation acknowledgement"))?;
    Ok(Json(OkBody { ok: true }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadAllBody {
    before: DateTime<Utc>,
}

async fn read_all(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ReadAllBody>,
) -> ApiResult<OkBody> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user = require_user_session(&context)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Notification database unavailable"))?;
    // The page watermark prevents a delayed click from acknowledging newer events.
    connection.execute(
        "update notification_recipients set seen_at = coalesce(seen_at, clock_timestamp()), read_at = coalesce(read_at, clock_timestamp())
         where user_id = $1 and created_at <= least($2, clock_timestamp()) and read_at is null
           and notification_recipient_authorized(event_id, user_id)",
        &[&user, &body.before],
    ).await.map_err(|_| internal_error("Unable to mark notifications read"))?;
    Ok(Json(OkBody { ok: true }))
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
struct Preference {
    category: String,
    channel: String,
    enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    ok: bool,
    hide_previews: bool,
    preferences: Vec<Preference>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreferencesBody {
    hide_previews: Option<bool>,
    preferences: Option<Vec<Preference>>,
}

fn validate_preferences(body: &PreferencesBody) -> bool {
    let Some(preferences) = body.preferences.as_ref() else {
        return true;
    };
    if preferences.len() > CATEGORIES.len() * CHANNELS.len() {
        return false;
    }
    let mut keys = std::collections::HashSet::new();
    preferences.iter().all(|preference| {
        CATEGORIES.contains(&preference.category.as_str())
            && CHANNELS.contains(&preference.channel.as_str())
            && keys.insert((&preference.category, &preference.channel))
    })
}

async fn load_preferences(state: &AppState, user: Uuid) -> ApiResult<Preferences> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|_| internal_error("Notification database unavailable"))?;
    let hide_previews = connection
        .query_opt(
            "select hide_previews from notification_settings where user_id = $1",
            &[&user],
        )
        .await
        .map_err(|_| internal_error("Unable to load notification settings"))?
        .map(|row| row.get(0))
        .unwrap_or(true);
    let rows = connection
        .query(
            "select category, channel, enabled from notification_preferences where user_id = $1",
            &[&user],
        )
        .await
        .map_err(|_| internal_error("Unable to load notification preferences"))?;
    let mut preferences = Vec::new();
    for category in CATEGORIES {
        for channel in CHANNELS {
            let enabled = rows
                .iter()
                .find(|row| {
                    row.get::<_, String>("category") == *category
                        && row.get::<_, String>("channel") == *channel
                })
                .map(|row| row.get("enabled"))
                .unwrap_or(true);
            preferences.push(Preference {
                category: (*category).to_owned(),
                channel: (*channel).to_owned(),
                enabled,
            });
        }
    }
    Ok(Json(Preferences {
        ok: true,
        hide_previews,
        preferences,
    }))
}

async fn preferences(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Preferences> {
    let context = authenticate_request(&state.config, &headers).await?;
    load_preferences(&state, require_user_session(&context)?).await
}

async fn save_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PreferencesBody>,
) -> ApiResult<Preferences> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user = require_user_session(&context)?;
    if !validate_preferences(&body) {
        return Err(bad_request("Invalid notification preferences"));
    }
    {
        let mut connection = state
            .pool
            .get()
            .await
            .map_err(|_| internal_error("Notification database unavailable"))?;
        let transaction = connection
            .transaction()
            .await
            .map_err(|_| internal_error("Unable to save notification preferences"))?;
        if let Some(hide) = body.hide_previews {
            transaction.execute("insert into notification_settings(user_id, hide_previews) values ($1, $2)
                 on conflict (user_id) do update set hide_previews = excluded.hide_previews, updated_at = clock_timestamp()", &[&user, &hide]).await
                .map_err(|_| internal_error("Unable to save notification settings"))?;
        }
        for preference in body.preferences.unwrap_or_default() {
            transaction.execute("insert into notification_preferences(user_id, category, channel, enabled) values ($1, $2, $3, $4)
                 on conflict (user_id, category, channel) do update set enabled = excluded.enabled, updated_at = clock_timestamp()",
                 &[&user, &preference.category, &preference.channel, &preference.enabled]).await
                .map_err(|_| internal_error("Unable to save notification preferences"))?;
        }
        transaction
            .commit()
            .await
            .map_err(|_| internal_error("Unable to save notification preferences"))?;
    }
    load_preferences(&state, user).await
}

pub(crate) fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(Duration::from_secs(5));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            if dispatch_batch(&state).await.is_err() {
                // Database errors can include source values: never log the error body.
                tracing::warn!("Notification delivery sweep failed; durable jobs will retry");
            }
        }
    });
}

pub(crate) async fn dispatch_batch(state: &AppState) -> anyhow::Result<()> {
    dispatch_batch_with_transport(state, &RegisteredTransport).await
}

/// Provider implementations consume only the typed, privacy-safe envelope.
/// The worker retains responsibility for leases, authorization, and retries.
#[async_trait::async_trait]
pub(crate) trait NotificationTransport: Sync {
    async fn deliver(
        &self,
        state: &AppState,
        channel: &str,
        endpoint: Uuid,
        user: Uuid,
        lease_token: Uuid,
        payload: &PushNotificationPayload,
    ) -> DeliveryResult;
}

struct RegisteredTransport;
#[async_trait::async_trait]
impl NotificationTransport for RegisteredTransport {
    async fn deliver(
        &self,
        state: &AppState,
        channel: &str,
        endpoint: Uuid,
        user: Uuid,
        lease_token: Uuid,
        payload: &PushNotificationPayload,
    ) -> DeliveryResult {
        deliver_notification(state, channel, endpoint, user, lease_token, payload).await
    }
}

pub(crate) async fn dispatch_batch_with_transport(
    state: &AppState,
    transport: &dyn NotificationTransport,
) -> anyhow::Result<()> {
    let rows = {
        let connection = state.pool.get().await?;
        connection
            .query("select * from notification_lease_jobs(8, 90)", &[])
            .await?
    };
    let results = stream::iter(rows.into_iter().map(|row| async move {
        // Bound the whole attempt, including pool acquisition. A stalled task
        // cannot send after another controller has reclaimed its lease.
        tokio::time::timeout(Duration::from_secs(60), dispatch_job(state, row, transport)).await?
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    for result in results {
        result?;
    }
    Ok(())
}

fn retry_delay(attempt: i32, jitter: f64) -> i64 {
    let base = (5_i64 * 2_i64.pow((attempt.max(1) - 1).min(10) as u32)).min(3600);
    (base as f64 * (0.75 + jitter.clamp(0.0, 1.0) * 0.5)).ceil() as i64
}

async fn dispatch_job(
    state: &AppState,
    job: Row,
    transport: &dyn NotificationTransport,
) -> anyhow::Result<()> {
    let id: Uuid = job.get("id");
    let event_id: Uuid = job.get("event_id");
    let user: Uuid = job.get("user_id");
    let endpoint: Uuid = job.get("endpoint_id");
    let channel: String = job.get("channel");
    let lease: Uuid = job.get("lease_token");
    let attempt: i32 = job.get("attempt_count");
    let row = {
        let connection = state.pool.get().await?;
        connection.query_opt(
            "select e.*, coalesce(s.hide_previews, true) as hide_previews,
               case $3 when 'web_push' then (select w.xmin::text from web_push_subscriptions w where w.id=$6 and w.user_id=$2)
                 when 'apns' then (select n.xmin::text from native_push_tokens n where n.id=$6 and n.user_id=$2) end as endpoint_version,
               notification_recipient_authorized(e.id, $2) as authorized,
               coalesce(p.enabled, true) as enabled, r.seen_at is null and r.read_at is null and r.archived_at is null as unread
             from notification_events e join notification_recipients r on r.event_id = e.id and r.user_id = $2
             left join notification_settings s on s.user_id = $2
             left join notification_preferences p on p.user_id = $2 and p.category = e.category and p.channel = $3
             where e.id = $1 and exists(select 1 from notification_delivery_jobs j
               where j.id = $4 and j.status = 'leased' and j.lease_token = $5 and j.lease_until > clock_timestamp())",
            &[&event_id, &user, &channel, &id, &lease, &endpoint],
        ).await?
    };
    let endpoint_version = row
        .as_ref()
        .and_then(|row| row.get::<_, Option<String>>("endpoint_version"));
    let (status, code, expired) = if let Some(row) = row {
        if !row.get::<_, bool>("authorized")
            || !row.get::<_, bool>("enabled")
            || !row.get::<_, bool>("unread")
        {
            ("cancelled", "recipient_ineligible", false)
        } else if let Some(kind) =
            EventKind::parse(&row.get::<_, String>("event_name"), row.get("version"))
        {
            let (title, body) = if row.get::<_, bool>("hide_previews") {
                ("Instafy", "You have a new notification.")
            } else {
                kind.text()
            };
            let payload = PushNotificationPayload {
                event_id,
                account_id: user,
                title: title.to_owned(),
                body: body.to_owned(),
                url: kind.url(
                    row.get("resource_id"),
                    row.get("project_id"),
                    row.get("conversation_id"),
                ),
            };
            let result = transport
                .deliver(state, &channel, endpoint, user, lease, &payload)
                .await;
            match result.disposition {
                DeliveryDisposition::Success => ("succeeded", result.code, false),
                DeliveryDisposition::Transient if attempt < MAX_ATTEMPTS => {
                    ("pending", result.code, false)
                }
                DeliveryDisposition::Expired => ("failed", result.code, true),
                _ => ("failed", result.code, false),
            }
        } else {
            ("failed", "unsupported_event_version", false)
        }
    } else {
        return Ok(());
    };
    let delay = retry_delay(attempt, rand::thread_rng().gen());
    let mut connection = state.pool.get().await?;
    let transaction = connection.transaction().await?;
    // Fence late workers. A timeout after provider acceptance is deliberately
    // at-least-once; every retry carries the same event ID for client dedupe.
    let changed = transaction.execute(
        "update notification_delivery_jobs set status = $3, last_code = $4, lease_token = null, lease_until = null,
            next_attempt_at = clock_timestamp() + make_interval(secs => $5::double precision), updated_at = clock_timestamp()
         where id = $1 and lease_token = $2 and status = 'leased' and lease_until > clock_timestamp()",
        &[&id, &lease, &status, &code, &(delay as f64)],
    ).await?;
    if changed > 0 {
        let attempt_status = if status == "pending" { "retry" } else { status };
        transaction.execute("update notification_delivery_attempts set status = $3, code = $4 where job_id = $1 and attempt_no = $2", &[&id, &attempt, &attempt_status, &code]).await?;
        if expired {
            // Compare PostgreSQL row versions, not wall-clock timestamps: a
            // registration transaction may have started before this attempt but
            // updated the endpoint while the provider request was in flight.
            let sql = match channel.as_str() {
                "web_push" => "delete from web_push_subscriptions where id = $1 and user_id = $2 and xmin::text = $3",
                "apns" => "delete from native_push_tokens where id = $1 and user_id = $2 and xmin::text = $3",
                _ => "",
            };
            if !sql.is_empty() {
                transaction
                    .execute(sql, &[&endpoint, &user, &endpoint_version])
                    .await?;
            }
        }
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_versioned_and_never_accepts_arbitrary_content() {
        for name in [
            "support.reply",
            "support.resolved",
            "conversation.reply",
            "run.failed",
            "automation.completed",
            "automation.failed",
        ] {
            let kind = EventKind::parse(name, 1).unwrap();
            let (title, body) = kind.text();
            assert!(title.len() < 80 && body.len() < 120);
            assert_eq!(EventKind::parse(name, 2), None);
        }
        assert_eq!(EventKind::parse("support.internal_note", 1), None);
    }

    #[test]
    fn deep_links_use_only_typed_resource_ids() {
        let id = Uuid::new_v4();
        assert_eq!(
            EventKind::SupportReply.url(id, None, None),
            format!("/studio?supportReportId={id}")
        );
        assert_eq!(EventKind::RunFailed.url(id, None, None), "/studio");
        assert!(!EventKind::SupportResolved
            .url(id, Some(Uuid::new_v4()), None)
            .contains("projectId"));
    }

    #[test]
    fn cursor_round_trips_and_rejects_oversized_or_invalid_input() {
        let value = (Utc::now(), Uuid::new_v4());
        assert_eq!(decode_cursor(&encode_cursor(value.0, value.1)), Some(value));
        assert!(decode_cursor(&"a".repeat(161)).is_none());
        assert!(decode_cursor("garbage").is_none());
    }

    #[test]
    fn retry_backoff_is_bounded_and_jittered() {
        assert!(retry_delay(4, 0.0) < retry_delay(4, 1.0));
        assert!(retry_delay(3, 0.0) > retry_delay(2, 1.0));
        assert!(retry_delay(i32::MAX, 1.0) <= 4500);
        assert!(retry_delay(0, 0.0) > 0);
    }

    #[test]
    fn preferences_reject_unknown_channels_categories_and_duplicates() {
        let mut body = PreferencesBody {
            hide_previews: Some(true),
            preferences: Some(vec![Preference {
                category: "support".into(),
                channel: "web_push".into(),
                enabled: false,
            }]),
        };
        assert!(validate_preferences(&body));
        let duplicate = body.preferences.as_ref().unwrap()[0].clone();
        body.preferences.as_mut().unwrap().push(duplicate);
        assert!(!validate_preferences(&body));
        body.preferences.as_mut().unwrap().remove(0);
        body.preferences.as_mut().unwrap()[0].channel = "email".into();
        assert!(!validate_preferences(&body));
        body.preferences.as_mut().unwrap()[0].channel = "local".into();
        body.preferences.as_mut().unwrap()[0].category = "internal".into();
        assert!(!validate_preferences(&body));
    }
}
