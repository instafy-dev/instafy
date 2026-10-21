//! Octo's reply while the model writes it: `POST /agent/reply-draft`.
//!
//! The reply of a chat turn is persisted only with the job's completion, often
//! many seconds after the model started writing it. While it runs, the runtime
//! sends the latest text of that reply here, at most a few times a second.
//!
//! The call is checked like `/agent/message`: the agent token's
//! `agent.message` scope, the runtime's current lease, and a job of the
//! token's space that this runtime has leased and that belongs to a
//! conversation. The controller then publishes `run.reply_draft` to the
//! conversation's viewers, who pass the same access checks as for its
//! messages, and keeps nothing: no row, no Home entry, no notification. The
//! completion's message replaces the draft. A runtime that sends no drafts, or
//! a client that ignores them, sees the reply arrive whole, as before.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::*;

/// The longest draft text taken, in characters: the bound of a streamed
/// agent message.
const MAX_REPLY_DRAFT_CHARS: usize = 32_000;

/// Past this many remembered checks, expired ones are dropped.
const ROUTE_CACHE_SOFT_LIMIT: usize = 1024;

/// The shortest gap between two published drafts of one job. A runtime sends
/// one every 200 ms at most, so it never meets this; a faster sender loses its
/// extra drafts instead of flooding the event bus every stream on this node
/// shares.
const MIN_PUBLISH_GAP: Duration = Duration::from_millis(100);

#[derive(Debug, Deserialize)]
pub(crate) struct AgentReplyDraftPayload {
    #[serde(rename = "job_id")]
    job_id: Uuid,
    /// Changes when the text starts over, rather than growing.
    segment: u64,
    /// Orders one job's drafts.
    seq: u64,
    text: String,
}

/// Who may send drafts for a job: the token's space, runtime and lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct RouteKey {
    job_id: Uuid,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    runtime_generation: Option<Uuid>,
}

/// Where a job's drafts go, as last checked.
#[derive(Debug, Clone, Copy)]
struct DraftRoute {
    conversation_id: Uuid,
    session_id: Option<Uuid>,
    run_id: Option<Uuid>,
    checked_at: Instant,
}

/// Checks that passed recently. A draft arrives several times a second, and
/// one database check per job per `event_access_recheck_after` is enough for
/// text no one stores, just as an event stream rechecks its viewer's access.
static ROUTES: Lazy<Mutex<HashMap<RouteKey, DraftRoute>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// When each job's last draft was published.
static LAST_PUBLISHED: Lazy<Mutex<HashMap<Uuid, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Whether a draft of `job_id` may be published now, and if so, notes it.
fn claim_publish_slot(job_id: Uuid) -> bool {
    let Ok(mut published) = LAST_PUBLISHED.lock() else {
        return true;
    };
    let now = Instant::now();
    if published
        .get(&job_id)
        .is_some_and(|last| now.duration_since(*last) < MIN_PUBLISH_GAP)
    {
        return false;
    }
    if published.len() >= ROUTE_CACHE_SOFT_LIMIT {
        published.retain(|_, last| now.duration_since(*last) < Duration::from_secs(60));
    }
    published.insert(job_id, now);
    true
}

fn remembered_route(key: &RouteKey, fresh_for: Duration) -> Option<DraftRoute> {
    let routes = ROUTES.lock().ok()?;
    routes
        .get(key)
        .filter(|route| route.checked_at.elapsed() < fresh_for)
        .copied()
}

fn remember_route(key: RouteKey, route: DraftRoute, fresh_for: Duration) {
    let Ok(mut routes) = ROUTES.lock() else {
        return;
    };
    if routes.len() >= ROUTE_CACHE_SOFT_LIMIT {
        routes.retain(|_, route| route.checked_at.elapsed() < fresh_for);
    }
    routes.insert(key, route);
}

#[instrument(skip(state, headers, payload))]
pub(crate) async fn agent_reply_draft(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    axum::Json(payload): axum::Json<AgentReplyDraftPayload>,
) -> Result<Json<AgentMessageResponseBody>, (StatusCode, Json<ApiError>)> {
    let token = extract_agent_token(&headers)?;
    let claims = verify_agent_token_with_scopes(&state.config, token, &["agent.message"])?;
    let AgentReplyDraftPayload {
        job_id,
        segment,
        seq,
        text,
    } = payload;
    if text.chars().count() > MAX_REPLY_DRAFT_CHARS {
        return Err(bad_request("text is too long for a reply draft"));
    }
    let runtime_scope = if state.config.strict_mode {
        Some(claims.runtime_id.ok_or_else(|| {
            unauthorized("agent token missing runtime scope while strict mode is enabled")
        })?)
    } else {
        claims.runtime_id
    };

    let key = RouteKey {
        job_id,
        project_id: claims.project_id,
        runtime_id: runtime_scope,
        lease_id: claims.lease_id,
        runtime_generation: claims.runtime_generation,
    };
    let fresh_for = state.config.event_access_recheck_after;
    let route = match remembered_route(&key, fresh_for) {
        Some(route) => route,
        None => {
            let route = check_draft_route(&state, &claims, runtime_scope, job_id).await?;
            remember_route(key, route, fresh_for);
            route
        }
    };

    if !claim_publish_slot(job_id) {
        return Ok(Json(AgentMessageResponseBody { ok: true }));
    }
    publish_controller_event_with_conversation(
        &state.events,
        "run.reply_draft",
        Some(claims.project_id),
        route.session_id,
        Some(route.conversation_id),
        route.run_id,
        Some(job_id),
        json!({
            "jobId": job_id,
            "runId": route.run_id,
            "conversationId": route.conversation_id,
            "segment": segment,
            "seq": seq,
            "text": text,
        }),
    );
    Ok(Json(AgentMessageResponseBody { ok: true }))
}

/// The job's conversation, once the token is known to hold the runtime's
/// current lease and the runtime to hold the job. Nothing is locked: a draft
/// writes nothing, and a cancel that lands in between only means the turn's
/// last draft is shown to its viewers until its run ends.
async fn check_draft_route(
    state: &AppState,
    claims: &TokenContext,
    runtime_scope: Option<Uuid>,
    job_id: Uuid,
) -> Result<DraftRoute, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    if let Some(runtime_id) = runtime_scope.as_ref() {
        ensure_agent_token_matches_runtime_lease_for_job(state, &transaction, claims, runtime_id)
            .await?;
    }
    let row = transaction
        .query_opt(
            "select run_id,
                    session_id,
                    conversation_id,
                    payload ->> 'session_id' as payload_session_id,
                    payload ->> 'conversation_id' as payload_conversation_id
             from agent_jobs
             where id = $1
               and project_id = $2
               and status = 'leased'
               and ($3::uuid is null or coalesce(leased_by_runtime_id, $3) = $3)",
            &[&job_id, &claims.project_id, &runtime_scope],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load agent job: {error}")))?;
    let Some(row) = row else {
        if state.config.strict_mode {
            return Err(forbidden(
                "job must be leased by the same runtime that posts drafts while strict mode is enabled",
            ));
        }
        return Err(not_found("agent job not found or not leased"));
    };
    // Like `/agent/message`, a job row without the ids takes them from its payload.
    let payload_id = |column: &str| {
        row.get::<_, Option<String>>(column)
            .and_then(|value| Uuid::from_str(&value).ok())
    };
    let session_id = row
        .get::<_, Option<Uuid>>("session_id")
        .or_else(|| payload_id("payload_session_id"));
    let conversation_id = row
        .get::<_, Option<Uuid>>("conversation_id")
        .or_else(|| payload_id("payload_conversation_id"));
    let Some(conversation_id) = conversation_id else {
        return Err(bad_request(
            "agent job is not associated with a conversation",
        ));
    };
    // An internal conversation's messages never reach a viewer's chat.
    if crate::conversations::is_internal_conversation(&transaction, &conversation_id).await? {
        return Err(forbidden("internal conversations take no reply drafts"));
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finish draft check: {error}")))?;
    Ok(DraftRoute {
        conversation_id,
        session_id,
        run_id: row.get("run_id"),
        checked_at: Instant::now(),
    })
}
