//! Home activity feed: one append-only ledger of what happened across every
//! team a user belongs to.
//!
//! Rows are written by the controller inside the transaction that mutates
//! the source (a message, a run) — one row per event, never one per
//! recipient. Who may see a row is decided at read time with the same
//! project and conversation grant checks the inbox and the events stream
//! use, so a revoked membership hides history instantly.
//!
//! Writers never fail their caller: a missing table (migration lag) or an
//! insert error is logged and swallowed behind a savepoint.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::types::ToSql;
use tokio_postgres::GenericClient;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::conversations::{build_conversation_last_message_preview, ConversationRecord};
use crate::{bad_request, internal_error, ApiError, AppState};

pub(crate) const KIND_CONVERSATION_REPLY: &str = "conversation.reply";
pub(crate) const KIND_CONVERSATION_CREATED: &str = "conversation.created";
pub(crate) const KIND_RUN_STARTED: &str = "run.started";
pub(crate) const KIND_RUN_FINISHED: &str = "run.finished";
pub(crate) const KIND_RUN_FAILED: &str = "run.failed";

const VISIBILITY_PROJECT: &str = "project";
const VISIBILITY_CONVERSATION: &str = "conversation";

const ACTOR_USER: &str = "user";
const ACTOR_AGENT: &str = "agent";
const ACTOR_SYSTEM: &str = "system";

/// Previews are bounded so a row never carries a whole message.
const PREVIEW_MAX_CHARS: usize = 240;
/// `since=` catch-up reads a little behind the cursor: identity ids are
/// assigned at insert time, so a lower id can commit after a higher one was
/// already served. Clients dedupe by id.
const SINCE_OVERLAP: i64 = 200;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/activity", get(list_my_activity))
        .route("/me/activity/seen", post(mark_my_activity_seen))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct ActivityActor {
    kind: &'static str,
    user_id: Option<Uuid>,
    /// `{handle, displayName, avatarSeed}` — nothing else is ever stored.
    agent: Option<JsonValue>,
}

impl ActivityActor {
    fn system() -> Self {
        Self {
            kind: ACTOR_SYSTEM,
            user_id: None,
            agent: None,
        }
    }

    fn user(user_id: Uuid) -> Self {
        Self {
            kind: ACTOR_USER,
            user_id: Some(user_id),
            agent: None,
        }
    }

    fn agent(agent: JsonValue) -> Self {
        Self {
            kind: ACTOR_AGENT,
            user_id: None,
            agent: Some(agent),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ActivityRow {
    pub(crate) kind: &'static str,
    pub(crate) org_id: Option<Uuid>,
    pub(crate) project_id: Option<Uuid>,
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) prompt_id: Option<Uuid>,
    pub(crate) visibility: &'static str,
    pub(crate) actor: ActivityActor,
    pub(crate) owner_user_id: Option<Uuid>,
    pub(crate) target_user_id: Option<Uuid>,
    pub(crate) title: Option<String>,
    pub(crate) preview: Option<String>,
    pub(crate) data: JsonValue,
}

/// The agent identity a dispatch stamps on messages and job payloads
/// (`metadata.agent`), reduced to the three fields a feed row may carry.
pub(crate) fn agent_actor_from_metadata(metadata: &JsonValue) -> Option<JsonValue> {
    let agent = metadata.get("agent")?.as_object()?;
    let handle = agent
        .get("handle")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let mut allowed = JsonMap::new();
    allowed.insert("handle".to_string(), JsonValue::String(handle.to_string()));
    if let Some(display_name) = agent
        .get("displayName")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        allowed.insert(
            "displayName".to_string(),
            JsonValue::String(display_name.to_string()),
        );
    }
    if let Some(avatar_seed) = agent
        .get("avatarSeed")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        allowed.insert(
            "avatarSeed".to_string(),
            JsonValue::String(avatar_seed.to_string()),
        );
    }
    Some(JsonValue::Object(allowed))
}

fn json_uuid(value: Option<&JsonValue>) -> Option<Uuid> {
    value
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

fn bounded_preview(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let preview = build_conversation_last_message_preview(trimmed);
    Some(preview.chars().take(PREVIEW_MAX_CHARS).collect())
}

fn message_type(metadata: &JsonValue) -> String {
    metadata
        .get("messageType")
        .or_else(|| metadata.get("message_type"))
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Is this assistant message the agent conversationally speaking? Mirrors
/// the SQL predicate the run ledger uses (`run_has_visible_assistant_message`)
/// so the feed and the transcript agree on what a reply is: tool/status
/// telemetry and controller notices (runtime alerts, cancellations) are not.
pub(crate) fn is_visible_reply(
    role: &str,
    created_by: Option<Uuid>,
    content: &str,
    metadata: &JsonValue,
) -> bool {
    if !role.eq_ignore_ascii_case("assistant") || created_by.is_some() || content.trim().is_empty() {
        return false;
    }
    let message_type = message_type(metadata);
    let timeline_type = matches!(
        message_type.as_str(),
        "command_execution"
            | "mcp_tool_call"
            | "web_search"
            | "file_change"
            | "status"
            | "runtime_alert"
            | "run_cancellation"
            | "runtime_switch"
            | "agent_job_thread"
            | "token_usage"
            | "reasoning"
    );
    let status_agent_message = message_type == "status"
        && metadata
            .pointer("/details/kind")
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case("agent_message"))
            .unwrap_or(false);
    if timeline_type && !status_agent_message {
        return false;
    }
    let kind = metadata
        .get("kind")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    !matches!(
        kind.as_str(),
        "runtime_alert" | "run_cancellation" | "runtime_switch" | "agent_job_thread"
    )
}

/// Phase 1 only writes rows for root conversations: a child thread does not
/// inherit its parent's visibility server-side yet, so a public child under a
/// private root must not surface cross-team.
async fn conversation_is_root(client: &impl GenericClient, conversation_id: &Uuid) -> bool {
    match client
        .query_opt(
            "select parent_conversation_id is null as is_root from conversations where id = $1",
            &[conversation_id],
        )
        .await
    {
        Ok(Some(row)) => row.get::<_, bool>("is_root"),
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(%conversation_id, %error, "activity: failed to check conversation root");
            false
        }
    }
}

/// Insert one row. Never fails the caller: errors (including a missing table
/// while the migration lags) roll back to a savepoint and return `None`.
pub(crate) async fn append(client: &impl GenericClient, row: &ActivityRow) -> Option<i64> {
    let savepoint_created = client
        .execute("savepoint activity_append", &[])
        .await
        .is_ok();
    let actor_agent = row.actor.agent.as_ref().map(PgJson);
    let data = PgJson(&row.data);
    let result = client
        .query_one(
            "insert into activity_events (
                 kind, org_id, project_id, conversation_id, run_id, prompt_id,
                 visibility, actor_kind, actor_user_id, actor_agent,
                 owner_user_id, target_user_id, title, preview, data
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15::jsonb)
             returning id",
            &[
                &row.kind,
                &row.org_id,
                &row.project_id,
                &row.conversation_id,
                &row.run_id,
                &row.prompt_id,
                &row.visibility,
                &row.actor.kind,
                &row.actor.user_id,
                &actor_agent,
                &row.owner_user_id,
                &row.target_user_id,
                &row.title,
                &row.preview,
                &data,
            ],
        )
        .await;
    match result {
        Ok(inserted) => {
            if savepoint_created {
                let _ = client.execute("release savepoint activity_append", &[]).await;
            }
            Some(inserted.get::<_, i64>("id"))
        }
        Err(error) => {
            tracing::warn!(kind = row.kind, %error, "activity: append failed; row dropped");
            if savepoint_created {
                let _ = client
                    .execute("rollback to savepoint activity_append", &[])
                    .await;
                let _ = client.execute("release savepoint activity_append", &[]).await;
            }
            None
        }
    }
}

/// An agent message just landed in a conversation.
pub(crate) async fn record_reply_if_visible(
    client: &impl GenericClient,
    project_id: &Uuid,
    conversation_id: &Uuid,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    content: &str,
    metadata: &JsonValue,
) -> Option<i64> {
    if !is_visible_reply("assistant", None, content, metadata) {
        return None;
    }
    if !conversation_is_root(client, conversation_id).await {
        return None;
    }
    let actor = agent_actor_from_metadata(metadata)
        .map(ActivityActor::agent)
        .unwrap_or_else(ActivityActor::system);
    append(
        client,
        &ActivityRow {
            kind: KIND_CONVERSATION_REPLY,
            org_id: None,
            project_id: Some(*project_id),
            conversation_id: Some(*conversation_id),
            run_id,
            prompt_id,
            visibility: VISIBILITY_CONVERSATION,
            actor,
            owner_user_id: None,
            target_user_id: None,
            title: None,
            preview: bounded_preview(content),
            data: json!({}),
        },
    )
    .await
}

/// A root conversation was created (blank, or by a first send).
pub(crate) async fn record_conversation_created(
    client: &impl GenericClient,
    conversation: &ConversationRecord,
) -> Option<i64> {
    if conversation.parent_conversation_id.is_some() {
        return None;
    }
    let title = conversation
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("title"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(PREVIEW_MAX_CHARS).collect());
    let actor = conversation
        .created_by
        .map(ActivityActor::user)
        .unwrap_or_else(ActivityActor::system);
    append(
        client,
        &ActivityRow {
            kind: KIND_CONVERSATION_CREATED,
            org_id: None,
            project_id: Some(conversation.project_id),
            conversation_id: Some(conversation.id),
            run_id: None,
            prompt_id: None,
            visibility: VISIBILITY_CONVERSATION,
            actor,
            owner_user_id: None,
            target_user_id: None,
            title,
            preview: None,
            data: json!({ "threadKind": conversation.thread_kind }),
        },
    )
    .await
}

fn run_actor(job_payload: &JsonValue) -> ActivityActor {
    job_payload
        .get("metadata")
        .and_then(agent_actor_from_metadata)
        .map(ActivityActor::agent)
        .unwrap_or_else(ActivityActor::system)
}

fn run_trigger_user(job_payload: &JsonValue) -> Option<Uuid> {
    json_uuid(job_payload.get("user_id"))
}

async fn run_scope(
    client: &impl GenericClient,
    conversation_id: Option<Uuid>,
) -> Option<(Option<Uuid>, &'static str)> {
    match conversation_id {
        Some(conversation) => {
            if conversation_is_root(client, &conversation).await {
                Some((Some(conversation), VISIBILITY_CONVERSATION))
            } else {
                None
            }
        }
        None => Some((None, VISIBILITY_PROJECT)),
    }
}

/// A job was leased: its run is now in progress.
pub(crate) async fn record_run_started(
    client: &impl GenericClient,
    project_id: &Uuid,
    run_id: &Uuid,
    conversation_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    job_payload: &JsonValue,
) -> Option<i64> {
    let (conversation_id, visibility) = run_scope(client, conversation_id).await?;
    append(
        client,
        &ActivityRow {
            kind: KIND_RUN_STARTED,
            org_id: None,
            project_id: Some(*project_id),
            conversation_id,
            run_id: Some(*run_id),
            prompt_id,
            visibility,
            actor: run_actor(job_payload),
            owner_user_id: None,
            target_user_id: run_trigger_user(job_payload),
            title: None,
            preview: None,
            data: json!({ "promptId": prompt_id }),
        },
    )
    .await
}

/// A run reached a terminal state.
pub(crate) async fn record_run_completed(
    client: &impl GenericClient,
    project_id: &Uuid,
    run_id: &Uuid,
    conversation_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    job_payload: &JsonValue,
    succeeded: bool,
    summary: Option<&str>,
    error_message: Option<&str>,
) -> Option<i64> {
    let (conversation_id, visibility) = run_scope(client, conversation_id).await?;
    let preview = if succeeded {
        summary.and_then(bounded_preview)
    } else {
        error_message.or(summary).and_then(bounded_preview)
    };
    append(
        client,
        &ActivityRow {
            kind: if succeeded {
                KIND_RUN_FINISHED
            } else {
                KIND_RUN_FAILED
            },
            org_id: None,
            project_id: Some(*project_id),
            conversation_id,
            run_id: Some(*run_id),
            prompt_id,
            visibility,
            actor: run_actor(job_payload),
            owner_user_id: None,
            target_user_id: run_trigger_user(job_payload),
            title: None,
            preview,
            data: json!({
                "promptId": prompt_id,
                "outcome": if succeeded { "success" } else { "failed" },
            }),
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ActivityListQuery {
    /// History page: rows with id < before, newest first.
    before: Option<String>,
    /// Catch-up: rows with id > since (minus an overlap window), oldest first.
    since: Option<String>,
    limit: Option<i64>,
    /// `all` (default), `needs`, or `activity`.
    lane: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityRef {
    id: Uuid,
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityConversationRef {
    id: Uuid,
    title: Option<String>,
    visibility: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityRunRef {
    id: Uuid,
    status: Option<String>,
    prompt_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityActorView {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_seed: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityItem {
    /// The cursor, serialized as a string so JavaScript never rounds it.
    id: String,
    kind: String,
    at: String,
    project: Option<ActivityRef>,
    org: Option<ActivityRef>,
    conversation: Option<ActivityConversationRef>,
    run: Option<ActivityRunRef>,
    actor: ActivityActorView,
    title: Option<String>,
    preview: Option<String>,
    needs_you: bool,
    /// Work still in flight (a started run whose run is queued or running).
    live: bool,
    seen: bool,
    data: JsonValue,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityListResponse {
    ok: bool,
    items: Vec<ActivityItem>,
    next_before: Option<String>,
    has_more: bool,
    last_seen_event_id: String,
    server_time: String,
}

fn parse_cursor(raw: Option<&String>, name: &str) -> Result<Option<i64>, (StatusCode, Json<ApiError>)> {
    match raw.map(|value| value.trim()).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => value
            .parse::<i64>()
            .map(Some)
            .map_err(|_| bad_request(format!("{name} must be an integer cursor"))),
    }
}

/// The viewer's current grants, computed once so the scan is bounded to the
/// projects and teams they belong to (the same rule the inbox applies).
const ACCESS_CTE: &str = "with accessible as (
        select p.id, p.org_id, p.name
        from projects p
        where p.status <> 'deleted'
          and (
            p.owner_user_id = $1
            or exists (
              select 1 from project_memberships pm
              where pm.project_id = p.id and pm.user_id = $1
                and lower(pm.role) in ('viewer', 'builder')
            )
            or exists (
              select 1 from org_memberships om
              where p.org_id is not null and om.org_id = p.org_id and om.user_id = $1
                and lower(om.role) in ('viewer', 'builder', 'admin', 'owner')
            )
          )
    ),
    member_orgs as (
        select om.org_id from org_memberships om where om.user_id = $1
    )";

/// One predicate, in one place: project grant, private-conversation access,
/// owner-only rows, and superseded run.started rows.
const VISIBLE_WHERE: &str = "(
        (e.project_id is not null and e.project_id in (select id from accessible))
        or (e.project_id is null and e.org_id in (select org_id from member_orgs))
      )
      and (
        e.conversation_id is null
        or (
          c.id is not null
          and (c.visibility <> 'private' or c.created_by = $1 or cp.user_id is not null)
        )
      )
      and (e.visibility <> 'owner' or e.owner_user_id = $1 or e.target_user_id = $1)
      and not (
        e.kind = 'run.started'
        and (r.id is null or r.status not in ('queued', 'in_progress'))
      )";

// Both booleans are coalesced: a null created_by or a missing run must read
// as "no", never as a null the row mapper cannot decode.
const NEEDS_YOU_EXPR: &str = "coalesce(case
        when e.kind = 'conversation.reply' then
          (c.created_by = $1 or cp.user_id is not null)
          and e.created_at > coalesce(cp.last_seen_at, '-infinity'::timestamptz)
        when e.kind in ('run.failed', 'automation.failed', 'credit.exhausted') then
          (e.target_user_id = $1 or e.owner_user_id = $1) and a.event_id is null
        else false
      end, false)";

const LIVE_EXPR: &str =
    "coalesce(e.kind = 'run.started' and r.status in ('queued', 'in_progress'), false)";

async fn list_my_activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ActivityListQuery>,
) -> Result<Json<ActivityListResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let before = parse_cursor(params.before.as_ref(), "before")?;
    let since = parse_cursor(params.since.as_ref(), "since")?;
    if before.is_some() && since.is_some() {
        return Err(bad_request("pass either before or since, not both"));
    }
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let lane = params
        .lane
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("all")
        .to_ascii_lowercase();
    if !matches!(lane.as_str(), "all" | "needs" | "activity") {
        return Err(bad_request("lane must be all, needs or activity"));
    }

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let last_seen_event_id: i64 = connection
        .query_opt(
            "select last_seen_event_id from activity_seen where user_id = $1",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load activity cut: {error}")))?
        .map(|row| row.get::<_, i64>("last_seen_event_id"))
        .unwrap_or(0);

    let fetch_limit = limit + 1;
    let mut query_params: Vec<&(dyn ToSql + Sync)> = vec![&user_id, &fetch_limit];
    let mut cursor_clause = String::new();
    let since_floor = since.map(|value| (value - SINCE_OVERLAP).max(0));
    if let Some(before_id) = before.as_ref() {
        query_params.push(before_id);
        cursor_clause = format!("and e.id < ${}", query_params.len());
    } else if let Some(floor) = since_floor.as_ref() {
        query_params.push(floor);
        cursor_clause = format!("and e.id > ${}", query_params.len());
    }
    let lane_clause = match lane.as_str() {
        "needs" => format!("and ({NEEDS_YOU_EXPR})"),
        _ => String::new(),
    };
    let order = if since.is_some() { "asc" } else { "desc" };

    let sql = format!(
        "{ACCESS_CTE}
         select e.id, e.kind, e.created_at, e.project_id, e.conversation_id, e.run_id,
                e.prompt_id, e.actor_kind, e.actor_user_id, e.actor_agent,
                e.title as row_title, e.preview, e.data,
                ap.name as project_name,
                o.id as org_id, o.name as org_name,
                c.visibility as conversation_visibility,
                nullif(btrim(c.metadata ->> 'title'), '') as conversation_title,
                r.status as run_status,
                coalesce(
                  nullif(btrim(pr.full_name), ''),
                  nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                  nullif(btrim(u.raw_user_meta_data ->> 'name'), '')
                ) as actor_display_name,
                ({NEEDS_YOU_EXPR}) as needs_you,
                {LIVE_EXPR} as live
         from activity_events e
         left join accessible ap on ap.id = e.project_id
         left join organizations o on o.id = coalesce(e.org_id, ap.org_id)
         left join conversations c on c.id = e.conversation_id
         left join conversation_participants cp
           on cp.conversation_id = e.conversation_id and cp.user_id = $1
         left join runs r on r.id = e.run_id
         left join activity_acks a on a.event_id = e.id and a.user_id = $1
         left join profiles pr on pr.user_id = e.actor_user_id
         left join auth.users u on u.id = e.actor_user_id
         where {VISIBLE_WHERE}
           {cursor_clause}
           {lane_clause}
         order by e.id {order}
         limit $2"
    );

    let rows = connection
        .query(sql.as_str(), &query_params)
        .await
        .map_err(|error| internal_error(format!("failed to load activity: {error}")))?;

    let has_more = rows.len() as i64 > limit;
    let mut items: Vec<ActivityItem> = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.iter().take(limit as usize) {
        let id: i64 = row.get("id");
        let created_at: DateTime<Utc> = row.get("created_at");
        let actor_kind: String = row.get("actor_kind");
        let actor_agent: Option<PgJson<JsonValue>> = row.get("actor_agent");
        let actor_agent = actor_agent.map(|value| value.0);
        let actor = ActivityActorView {
            kind: actor_kind,
            user_id: row.get("actor_user_id"),
            display_name: row
                .get::<_, Option<String>>("actor_display_name")
                .or_else(|| {
                    actor_agent
                        .as_ref()
                        .and_then(|agent| agent.get("displayName"))
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                }),
            handle: actor_agent
                .as_ref()
                .and_then(|agent| agent.get("handle"))
                .and_then(JsonValue::as_str)
                .map(str::to_string),
            avatar_seed: actor_agent
                .as_ref()
                .and_then(|agent| agent.get("avatarSeed"))
                .and_then(JsonValue::as_str)
                .map(str::to_string),
        };
        let project_id: Option<Uuid> = row.get("project_id");
        let org_id: Option<Uuid> = row.get("org_id");
        let conversation_id: Option<Uuid> = row.get("conversation_id");
        let run_id: Option<Uuid> = row.get("run_id");
        let conversation_title: Option<String> = row.get("conversation_title");
        let row_title: Option<String> = row.get("row_title");
        items.push(ActivityItem {
            id: id.to_string(),
            kind: row.get("kind"),
            at: created_at.to_rfc3339(),
            project: project_id.map(|id| ActivityRef {
                id,
                name: row.get("project_name"),
            }),
            org: org_id.map(|id| ActivityRef {
                id,
                name: row.get("org_name"),
            }),
            conversation: conversation_id.map(|id| ActivityConversationRef {
                id,
                title: conversation_title.clone(),
                visibility: row.get("conversation_visibility"),
            }),
            run: run_id.map(|id| ActivityRunRef {
                id,
                status: row.get("run_status"),
                prompt_id: row.get("prompt_id"),
            }),
            actor,
            title: conversation_title.or(row_title),
            preview: row.get("preview"),
            needs_you: row.get("needs_you"),
            live: row.get("live"),
            seen: id <= last_seen_event_id,
            data: row.get::<_, PgJson<JsonValue>>("data").0,
        });
    }

    let next_before = if before.is_some() || since.is_none() {
        items.last().map(|item| item.id.clone()).filter(|_| has_more)
    } else {
        None
    };

    Ok(Json(ActivityListResponse {
        ok: true,
        items,
        next_before,
        has_more,
        last_seen_event_id: last_seen_event_id.to_string(),
        server_time: Utc::now().to_rfc3339(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivitySeenBody {
    last_seen_event_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivitySeenResponse {
    ok: bool,
    last_seen_event_id: String,
}

async fn mark_my_activity_seen(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ActivitySeenBody>,
) -> Result<Json<ActivitySeenResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let requested = body
        .last_seen_event_id
        .trim()
        .parse::<i64>()
        .map_err(|_| bad_request("lastSeenEventId must be an integer cursor"))?
        .max(0);

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    // The cut only moves forward; a stale tab cannot rewind another device.
    let row = connection
        .query_one(
            "insert into activity_seen (user_id, last_seen_event_id, updated_at)
             values ($1, $2, now())
             on conflict (user_id) do update
               set last_seen_event_id = greatest(activity_seen.last_seen_event_id, excluded.last_seen_event_id),
                   updated_at = now()
             returning last_seen_event_id",
            &[&user_id, &requested],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record activity cut: {error}")))?;
    let stored: i64 = row.get("last_seen_event_id");
    Ok(Json(ActivitySeenResponse {
        ok: true,
        last_seen_event_id: stored.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_reply_excludes_telemetry_and_notices() {
        let plain = json!({ "agent": { "handle": "octo" } });
        assert!(is_visible_reply("assistant", None, "done", &plain));
        assert!(!is_visible_reply("user", None, "done", &plain));
        assert!(!is_visible_reply("assistant", Some(Uuid::new_v4()), "done", &plain));
        assert!(!is_visible_reply("assistant", None, "   ", &plain));
        for message_type in [
            "command_execution",
            "token_usage",
            "reasoning",
            "runtime_alert",
            "run_cancellation",
        ] {
            let metadata = json!({ "messageType": message_type });
            assert!(!is_visible_reply("assistant", None, "x", &metadata), "{message_type}");
        }
        let status_agent = json!({ "messageType": "status", "details": { "kind": "agent_message" } });
        assert!(is_visible_reply("assistant", None, "x", &status_agent));
        let cancelled = json!({ "kind": "run_cancellation" });
        assert!(!is_visible_reply("assistant", None, "Agent job cancelled", &cancelled));
    }

    #[test]
    fn agent_actor_is_allow_listed() {
        let metadata = json!({
            "agent": {
                "handle": "@Octo ",
                "id": "11111111-1111-1111-1111-111111111111",
                "displayName": "Octo",
                "description": "secret-ish free text",
                "avatarSeed": "seed"
            }
        });
        let actor = agent_actor_from_metadata(&metadata).expect("actor");
        assert_eq!(
            actor,
            json!({ "handle": "@Octo", "displayName": "Octo", "avatarSeed": "seed" })
        );
        assert!(agent_actor_from_metadata(&json!({})).is_none());
        assert!(agent_actor_from_metadata(&json!({ "agent": { "handle": " " } })).is_none());
    }

    #[test]
    fn previews_are_bounded() {
        let long = "x".repeat(2_000);
        let preview = bounded_preview(&long).expect("preview");
        assert!(preview.chars().count() <= PREVIEW_MAX_CHARS);
        assert!(bounded_preview("   ").is_none());
    }

    #[test]
    fn cursors_must_be_integers() {
        assert_eq!(parse_cursor(Some(&"42".to_string()), "before").unwrap(), Some(42));
        assert_eq!(parse_cursor(Some(&"  ".to_string()), "before").unwrap(), None);
        assert!(parse_cursor(Some(&"abc".to_string()), "before").is_err());
    }
}
