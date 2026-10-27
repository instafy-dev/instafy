//! Waking a preview whose runtime slept (or whose site stopped answering).
//!
//! `POST /projects/:id/previews/:pid/wake` (any member who may view the
//! preview) answers `200 {state:"live"}` when the runtime is up and the site
//! answers through the tunnel. Otherwise it leaves one wake row, starts the
//! runtime through the same ensure path a chat message uses when the runtime
//! is down, and answers `202 {state:"waking"}`. No agent job, run, chat
//! message or model call is involved.
//!
//! The runtime agent polls `POST /agent/preview-restarts/claim` with its agent
//! token. A claim reconnects the preview's tunnel (same broker key, so the
//! same preview id) on the runtime's current lease and hands the agent the
//! recorded start command and the tunnel client credentials. The agent starts
//! the command as argv in its workspace directory with a stripped environment,
//! waits for the port, starts the tunnel client and reports the outcome to
//! `POST /agent/preview-restarts/:wake_id/result`. `GET` on the preview shows
//! the wake as `{state: "idle"|"waking"|"failed", startedAt?, error?}`.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use super::{
    ensure_preview_runtime_access, ensure_previews_available, load_preview_grant,
    preview_tunnel_overrides, probe_preview, probe_preview_until_listening,
    revoke_preview_sessions_for_tunnel, ApiResult, PreviewGrant, PreviewPath, PreviewServe,
};
use crate::agent::{
    ensure_runtime_can_heartbeat, extract_agent_token, verify_agent_token_with_scopes,
};
use crate::auth::authenticate_request;
use crate::config::PgPool;
use crate::runtime::{ensure_runtime_for_dispatch_reconnect, RuntimeRecord};
use crate::state::publish_controller_event_with_conversation;
use crate::tunnels::{
    ensure_project_authorized, ensure_project_write_authorized,
    ensure_runtime_tunnel_generation_is_live, parse_required_uuid,
    request_runtime_tunnel_with_overrides, RuntimeTunnelGenerationState,
    ACTIVE_JOB_TUNNEL_METADATA_KEY, PREVIEW_TUNNEL_METADATA_KEY,
};
use crate::{bad_request, forbidden, internal_error, not_found, unauthorized, ApiError, AppState};

/// A wake the runtime has not claimed within this long failed: the runtime
/// did not come up (or its agent cannot restart previews).
pub(super) const WAKE_PENDING_TIMEOUT_SECONDS: i64 = 10 * 60;
/// A claimed wake without a result may be claimed again after this long (the
/// agent died mid-restart), at most [`WAKE_MAX_CLAIMS`] times in all. Well
/// past the agent's longest restart (`preview_restarts.rs`: 60 s for the port,
/// 30 s for the CLI's state lock, a few seconds of probes), so a slow restart
/// is not claimed again while it runs; an agent that does see a re-claim of a
/// preview it is restarting reports that restart's outcome for it.
pub(super) const WAKE_CLAIM_RETRY_SECONDS: i64 = 180;
pub(super) const WAKE_MAX_CLAIMS: i32 = 3;
/// How long `GET` keeps showing a failed wake.
pub(super) const WAKE_FAILED_VISIBLE_SECONDS: i64 = 15 * 60;
/// New wakes per preview in [`WAKES_PER_PREVIEW_WINDOW_SECONDS`].
pub(super) const WAKES_PER_PREVIEW: i64 = 6;
pub(super) const WAKES_PER_PREVIEW_WINDOW_SECONDS: i64 = 10 * 60;
/// New wakes one person may ask for in one space per hour.
pub(super) const WAKES_PER_USER: i64 = 30;
pub(super) const WAKES_PER_USER_WINDOW_SECONDS: i64 = 60 * 60;
/// Wakes handed to one claim call.
const WAKES_PER_CLAIM: i64 = 5;
const WAKE_ERROR_MAX_CHARS: usize = 300;
/// The scope a runtime's agent token leases jobs with; the same agent claims
/// preview restarts.
const AGENT_PREVIEW_RESTART_SCOPE: &str = "agent.lease";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WakeView {
    pub(super) state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
}

impl WakeView {
    fn idle() -> Self {
        Self {
            state: "idle",
            started_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WakeResponse {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
}

fn wake_conflict(message: &str, code: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(message, code, json!({}))),
    )
}

fn db_error(what: &str, error: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    internal_error(format!("failed to {what}: {error}"))
}

/// One line, no control characters, at most 300 characters: the agent's
/// error is shown to members.
pub(super) fn sanitize_wake_error(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = trimmed.chars().take(WAKE_ERROR_MAX_CHARS).collect();
    if out.is_empty() {
        out = "the preview could not be restarted".to_string();
    }
    out
}

/// Fail the open wakes of a preview that ran out of time.
async fn expire_stale_wakes(pool: &PgPool, tunnel_id: &str) -> ApiResult<()> {
    let connection = pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    connection
        .execute(
            "update runtime_preview_wakes
             set state = 'failed',
                 finished_at = now(),
                 error = case when state = 'pending'
                   then 'the space did not start in time'
                   else 'the space did not finish restarting the site in time' end
             where tunnel_id = $1
               and state in ('pending', 'claimed')
               and (created_at < now() - make_interval(secs => $2)
                    or (state = 'claimed'
                        and claim_count >= $3
                        and claimed_at < now() - make_interval(secs => $4)))",
            &[
                &tunnel_id,
                &(WAKE_PENDING_TIMEOUT_SECONDS as f64),
                &WAKE_MAX_CLAIMS,
                &(WAKE_CLAIM_RETRY_SECONDS as f64),
            ],
        )
        .await
        .map_err(|error| db_error("expire preview wakes", error))?;
    Ok(())
}

/// The preview's wake as `GET` shows it: an open wake is `waking`, a recent
/// failure (while the site still does not answer; `listening` is the probe's
/// answer, `None` when there is none) is `failed`, anything else is `idle`.
pub(super) async fn load_wake_view(
    state: &AppState,
    _project_id: &Uuid,
    grant: &PreviewGrant,
    listening: Option<bool>,
) -> ApiResult<WakeView> {
    let tunnel_id = &grant.record.tunnel_id;
    expire_stale_wakes(&state.pool, tunnel_id).await?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let row = connection
        .query_opt(
            "select state, created_at, finished_at, error, now() as checked_at
             from runtime_preview_wakes
             where tunnel_id = $1
             order by created_at desc
             limit 1",
            &[tunnel_id],
        )
        .await
        .map_err(|error| db_error("load preview wake", error))?;
    let Some(row) = row else {
        return Ok(WakeView::idle());
    };
    let wake_state: String = row.get("state");
    let created_at: DateTime<Utc> = row.get("created_at");
    let finished_at: Option<DateTime<Utc>> = row.get("finished_at");
    let now: DateTime<Utc> = row.get("checked_at");
    Ok(match wake_state.as_str() {
        "pending" | "claimed" => WakeView {
            state: "waking",
            started_at: Some(created_at.to_rfc3339()),
            error: None,
        },
        // A failed restart stays visible while the site does not answer: the
        // claim reconnected the tunnel, so a live grant alone says nothing.
        "failed"
            if (!grant.is_live() || listening != Some(true))
                && finished_at
                    .is_some_and(|at| (now - at).num_seconds() < WAKE_FAILED_VISIBLE_SECONDS) =>
        {
            WakeView {
                state: "failed",
                started_at: Some(created_at.to_rfc3339()),
                error: row.get::<_, Option<String>>("error"),
            }
        }
        _ => WakeView::idle(),
    })
}

/// The preview's runtime, and whether it is up on a live lease now.
struct WakeRuntime {
    record: RuntimeRecord,
    live: bool,
    private_self_hosted: bool,
}

async fn load_wake_runtime(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> ApiResult<WakeRuntime> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let row = connection
        .query_opt(
            "select r.id, r.project_id, r.provider, r.status, r.idle_ttl_seconds,
                    r.capabilities, r.display_name, r.active_lease_id,
                    rl.project_id as lease_project_id,
                    rl.runtime_id as lease_runtime_id,
                    rl.status as lease_status,
                    rl.released_at as lease_released_at
             from runtimes r
             left join runtime_leases rl on rl.id = r.active_lease_id
             where r.id = $1 and r.project_id = $2",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| db_error("load preview runtime", error))?
        .ok_or_else(|| not_found("runtime not found for project"))?;
    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let capabilities: JsonValue = row.get("capabilities");
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    let lease_status: Option<String> = row.get("lease_status");
    let private_self_hosted =
        crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities);
    let live = ensure_runtime_tunnel_generation_is_live(
        project_id,
        runtime_id,
        active_lease_id,
        RuntimeTunnelGenerationState {
            private_self_hosted,
            status: &status,
            active_lease_id,
            lease_project_id: row.get("lease_project_id"),
            lease_runtime_id: row.get("lease_runtime_id"),
            lease_status: lease_status.as_deref(),
            lease_released: row
                .get::<_, Option<DateTime<Utc>>>("lease_released_at")
                .is_some(),
            // A deleted space's grants and previews are revoked with it.
            space_deleted: false,
        },
    )
    .is_ok();
    Ok(WakeRuntime {
        record: RuntimeRecord {
            id: row.get("id"),
            project_id: row.get("project_id"),
            provider,
            status,
            idle_ttl_seconds: row.get("idle_ttl_seconds"),
            capabilities,
            display_name: row.get("display_name"),
            active_lease_id,
        },
        live,
        private_self_hosted,
    })
}

/// Whether a wake by `context` can go ahead for this preview: they may change
/// the space, or its machine is already up (restarting only the site costs
/// nothing) and nobody closed the preview on purpose (starting it again then
/// undoes a change to the space). `GET` reports it so Studio can disable Open
/// with the reason.
pub(super) async fn caller_may_start(
    state: &AppState,
    project_id: &Uuid,
    grant: &PreviewGrant,
    context: &crate::auth::RequestContext,
) -> bool {
    if ensure_project_write_authorized(state, project_id, context)
        .await
        .is_ok()
    {
        return true;
    }
    if grant.is_closed() {
        return false;
    }
    match grant.record.runtime_id {
        Some(runtime_id) => load_wake_runtime(state, project_id, &runtime_id)
            .await
            .is_ok_and(|runtime| runtime.live),
        None => false,
    }
}

/// `preview.wake` carries the preview's conversation (as the event's
/// conversation id) and runtime, so the private-conversation and
/// private-runtime filters on `/events` apply to it as to the preview itself.
fn wake_event_data(preview_id: &str, wake_state: &str, runtime_id: Option<Uuid>) -> JsonValue {
    let mut data = json!({ "previewId": preview_id, "state": wake_state });
    if let Some(runtime_id) = runtime_id {
        data["runtimeId"] = json!(runtime_id);
    }
    data
}

async fn publish_wake_event(
    state: &AppState,
    project_id: &Uuid,
    preview_id: &str,
    wake_state: &str,
) {
    let (conversation_id, runtime_id) =
        match load_preview_grant(&state.pool, project_id, preview_id).await {
            Ok(grant) => (
                grant
                    .preview_str("conversationId")
                    .and_then(|id| Uuid::parse_str(id).ok()),
                grant.record.runtime_id,
            ),
            Err(_) => (None, None),
        };
    publish_controller_event_with_conversation(
        &state.events,
        "preview.wake",
        Some(*project_id),
        None,
        conversation_id,
        None,
        None,
        wake_event_data(preview_id, wake_state, runtime_id),
    );
}

async fn fail_wake(state: &AppState, wake_id: &Uuid, error: &str) {
    let result = match state.pool.get().await {
        Ok(connection) => connection
            .query_opt(
                "update runtime_preview_wakes
                 set state = 'failed', finished_at = now(), error = $2
                 where id = $1 and state in ('pending', 'claimed')
                 returning project_id, tunnel_id",
                &[wake_id, &sanitize_wake_error(error)],
            )
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match result {
        Ok(Some(row)) => {
            let project_id: Uuid = row.get("project_id");
            let tunnel_id: String = row.get("tunnel_id");
            publish_wake_event(state, &project_id, &tunnel_id, "failed").await;
        }
        Ok(None) => {}
        Err(error) => warn!(%wake_id, %error, "failed to record a failed preview wake"),
    }
}

#[derive(Debug)]
struct OpenWake {
    created_at: DateTime<Utc>,
}

async fn load_open_wake(pool: &PgPool, tunnel_id: &str) -> ApiResult<Option<OpenWake>> {
    let connection = pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    Ok(connection
        .query_opt(
            "select created_at from runtime_preview_wakes
             where tunnel_id = $1 and state in ('pending', 'claimed')",
            &[&tunnel_id],
        )
        .await
        .map_err(|error| db_error("load preview wake", error))?
        .map(|row| OpenWake {
            created_at: row.get("created_at"),
        }))
}

fn waking(created_at: DateTime<Utc>) -> (StatusCode, Json<WakeResponse>) {
    (
        StatusCode::ACCEPTED,
        Json(WakeResponse {
            state: "waking",
            started_at: Some(created_at.to_rfc3339()),
        }),
    )
}

fn rate_limited(retry_after_seconds: i64) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiError::with_details(
            "this preview was woken too often; try again in a few minutes",
            "rate_limited",
            json!({ "retryAfterSeconds": retry_after_seconds }),
        )),
    )
}

/// Refuse a new wake past the per-preview or per-person budget.
async fn check_wake_rate(
    pool: &PgPool,
    tunnel_id: &str,
    project_id: &Uuid,
    user_id: &Uuid,
) -> ApiResult<()> {
    let connection = pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let row = connection
        .query_one(
            "select
               (select count(*) from runtime_preview_wakes
                 where tunnel_id = $1
                   and created_at > now() - make_interval(secs => $4)) as per_preview,
               (select count(*) from runtime_preview_wakes
                 where project_id = $2 and requested_by = $3
                   and created_at > now() - make_interval(secs => $5)) as per_user",
            &[
                &tunnel_id,
                project_id,
                user_id,
                &(WAKES_PER_PREVIEW_WINDOW_SECONDS as f64),
                &(WAKES_PER_USER_WINDOW_SECONDS as f64),
            ],
        )
        .await
        .map_err(|error| db_error("count preview wakes", error))?;
    if row.get::<_, i64>("per_preview") >= WAKES_PER_PREVIEW {
        return Err(rate_limited(WAKES_PER_PREVIEW_WINDOW_SECONDS));
    }
    if row.get::<_, i64>("per_user") >= WAKES_PER_USER {
        return Err(rate_limited(WAKES_PER_USER_WINDOW_SECONDS));
    }
    Ok(())
}

/// `POST /projects/:project_id/previews/:preview_id/wake`.
#[instrument(skip(state, headers))]
pub(super) async fn post_preview_wake(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, Json<WakeResponse>)> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("previews are woken from a Studio session"));
    }
    let user_id = context
        .user_id
        .ok_or_else(|| forbidden("previews are woken by a signed-in member"))?;
    // The same check as opening it: any member who may see the runtime.
    ensure_project_authorized(&state, &project_id, &context).await?;
    let grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    ensure_preview_runtime_access(&state, &project_id, &grant, &context).await?;
    if !grant.is_private_preview() {
        return Err(forbidden("only private previews open in Studio"));
    }
    if grant.is_superseded() {
        // Its tunnel was replaced: a wake would get the newer preview's.
        return Err(wake_conflict(
            "a newer preview replaced this one",
            "not_restartable",
        ));
    }
    let runtime_id = grant
        .record
        .runtime_id
        .ok_or_else(|| wake_conflict("this preview cannot be restarted", "not_restartable"))?;
    let runtime = load_wake_runtime(&state, &project_id, &runtime_id).await?;

    if grant.is_live() && runtime.live {
        let health = probe_preview(&state, &grant, std::time::Duration::ZERO).await;
        if health.as_ref().is_some_and(|probe| probe.listening) {
            return Ok((
                StatusCode::OK,
                Json(WakeResponse {
                    state: "live",
                    started_at: None,
                }),
            ));
        }
    }
    if !grant.restartable() {
        return Err(wake_conflict(
            "this preview has no recorded start command",
            "not_restartable",
        ));
    }

    let tunnel_id = grant.record.tunnel_id.clone();
    expire_stale_wakes(&state.pool, &tunnel_id).await?;
    if let Some(open) = load_open_wake(&state.pool, &tunnel_id).await? {
        return Ok(waking(open.created_at));
    }
    // Starting a stopped runtime costs the space credits: as with Studio's own
    // start, only members who may change the space do it. So does starting a
    // site someone closed on purpose. Anyone who may view joins a wake under
    // way (above) and restarts a site on a runtime that is up.
    if (!runtime.live || grant.is_closed())
        && ensure_project_write_authorized(&state, &project_id, &context)
            .await
            .is_err()
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError::with_details(
                "Only people who can edit this space can start it. Ask one of them to open it.",
                "start_needs_builder",
                json!({}),
            )),
        ));
    }
    check_wake_rate(&state.pool, &tunnel_id, &project_id, &user_id).await?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let inserted = connection
        .query_opt(
            "insert into runtime_preview_wakes (tunnel_id, project_id, runtime_id, requested_by)
             values ($1, $2, $3, $4)
             on conflict (tunnel_id) where state in ('pending', 'claimed') do nothing
             returning id, created_at",
            &[&tunnel_id, &project_id, &runtime_id, &user_id],
        )
        .await
        .map_err(|error| db_error("record preview wake", error))?;
    drop(connection);
    let Some(row) = inserted else {
        // A concurrent Open won the race; report its wake.
        let open = load_open_wake(&state.pool, &tunnel_id)
            .await?
            .ok_or_else(|| internal_error("preview wake vanished"))?;
        return Ok(waking(open.created_at));
    };
    let wake_id: Uuid = row.get("id");
    let created_at: DateTime<Utc> = row.get("created_at");
    info!(
        %project_id,
        %runtime_id,
        preview_id = %tunnel_id,
        %wake_id,
        requested_by = %user_id,
        runtime_live = runtime.live,
        "preview wake requested"
    );
    publish_wake_event(&state, &project_id, &tunnel_id, "waking").await;

    if !runtime.live {
        if runtime.private_self_hosted {
            // A machine someone else owns: nothing here can start it.
            fail_wake(
                &state,
                &wake_id,
                "the space runs on a computer that is offline; start it there",
            )
            .await;
            return Err(wake_conflict(
                "the space runs on a computer that is offline",
                "runtime_offline",
            ));
        }
        // Starting a runtime can take a while (the provider launches it);
        // the caller polls GET for the outcome.
        let background = state.clone();
        let record = runtime.record;
        tokio::spawn(async move {
            if let Err((status, Json(error))) =
                ensure_runtime_for_dispatch_reconnect(&background, &record, "preview_wake", false)
                    .await
            {
                warn!(
                    runtime_id = %record.id,
                    %wake_id,
                    status = status.as_u16(),
                    error = %error.message,
                    "preview wake could not start the runtime"
                );
                // Members see a plain line; the provider's own words (hosts,
                // paths) stay in this log.
                fail_wake(
                    &background,
                    &wake_id,
                    "the space could not start; try again in a few minutes",
                )
                .await;
            }
        });
    }
    Ok(waking(created_at))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewRestartItem {
    wake_id: Uuid,
    preview_id: String,
    title: String,
    port: u16,
    path: String,
    serve: PreviewServe,
    /// The tunnel client credentials for this lease (server, token, service).
    credentials: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewRestartClaimResponse {
    restarts: Vec<PreviewRestartItem>,
}

/// The agent token's project, runtime and lease, after checking that runtime
/// is still the live generation the token was minted for.
async fn authorize_restart_agent(
    state: &AppState,
    headers: &HeaderMap,
) -> ApiResult<(Uuid, Uuid, Option<Uuid>)> {
    let token = extract_agent_token(headers)?;
    let claims =
        verify_agent_token_with_scopes(&state.config, token, &[AGENT_PREVIEW_RESTART_SCOPE])?;
    let runtime_id = claims
        .runtime_id
        .ok_or_else(|| unauthorized("agent token missing runtime scope"))?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| db_error("start runtime check", error))?;
    ensure_runtime_can_heartbeat(
        state,
        &transaction,
        &claims.project_id,
        &runtime_id,
        claims.lease_id,
        claims.runtime_generation,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| db_error("finish runtime check", error))?;
    Ok((claims.project_id, runtime_id, claims.lease_id))
}

/// The grant metadata a wake reconnects with: what the preview had (its
/// controller-owned object, port, source and job marker), without the stop's
/// notes, the close mark, or anything the broker and entitlement add again.
fn wake_grant_metadata(grant: &PreviewGrant, tunnel_key: &str, wake_id: &Uuid) -> JsonValue {
    const KEPT: [&str; 3] = ["localPort", "source", ACTIVE_JOB_TUNNEL_METADATA_KEY];
    let mut metadata = JsonMap::new();
    if let Some(existing) = grant.metadata() {
        for key in KEPT {
            if let Some(value) = existing.get(key) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
    }
    let mut preview = grant.preview_metadata().cloned().unwrap_or_default();
    preview.remove("closedAt");
    preview.insert("tunnelKey".to_string(), json!(tunnel_key));
    preview.insert("wokeAt".to_string(), json!(Utc::now().to_rfc3339()));
    preview.insert("wakeId".to_string(), json!(wake_id));
    metadata.insert(
        PREVIEW_TUNNEL_METADATA_KEY.to_string(),
        JsonValue::Object(preview),
    );
    JsonValue::Object(metadata)
}

/// Reconnect one claimed preview's tunnel on the runtime's current lease.
async fn prepare_restart(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<Uuid>,
    wake_id: &Uuid,
    tunnel_id: &str,
) -> ApiResult<PreviewRestartItem> {
    let grant = load_preview_grant(&state.pool, project_id, tunnel_id).await?;
    if grant.record.runtime_id != Some(*runtime_id) {
        return Err(forbidden("preview belongs to another runtime"));
    }
    if !grant.restartable() {
        return Err(wake_conflict(
            "this preview can no longer be restarted",
            "not_restartable",
        ));
    }
    let (Some(serve), Some(tunnel_key)) = (grant.serve(), grant.tunnel_key()) else {
        return Err(wake_conflict(
            "this preview has no start command",
            "not_restartable",
        ));
    };
    // The port comes from stored metadata: check it as opening a preview does.
    super::validate_preview_port(i64::from(grant.port()), &state.config.previews.deny_ports)?;
    if !grant.is_live() {
        // An expired grant never revoked its sessions; a reconnect must not
        // bring a capability minted before it stopped back to life.
        revoke_preview_sessions_for_tunnel(&state.pool, tunnel_id).await;
    }
    let reopened = request_runtime_tunnel_with_overrides(
        state,
        project_id,
        Some(runtime_id),
        lease_id.as_ref(),
        Some(wake_grant_metadata(&grant, tunnel_key, wake_id)),
        preview_tunnel_overrides(tunnel_key.to_string()),
    )
    .await?;
    // A broker that replaced this preview's tunnel answers with another one:
    // this grant then closes (its card shows it ended) and the new one is the
    // preview from now on.
    super::retire_previews_superseded_by(state, project_id, tunnel_key, &reopened.tunnel_id).await;
    if reopened.tunnel_id != grant.record.tunnel_id {
        return Err(internal_error(
            "the tunnel broker handed back another tunnel for this preview",
        ));
    }
    Ok(PreviewRestartItem {
        wake_id: *wake_id,
        preview_id: grant.record.tunnel_id.clone(),
        title: grant.title(),
        port: grant.port(),
        path: grant.path(),
        serve,
        credentials: reopened.credentials,
    })
}

/// `POST /agent/preview-restarts/claim`: the open wakes of the caller's
/// runtime, each with its tunnel reconnected.
#[instrument(skip(state, headers))]
pub(super) async fn post_agent_preview_restarts_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<PreviewRestartClaimResponse>> {
    // Without previews configured there is nothing to restart; the agent
    // reads 404 as "not offered here" and asks far less often.
    if super::sessions::PreviewOrigin::from_settings(&state.config.previews).is_none() {
        return Err(not_found("preview restarts are not offered on this server"));
    }
    let (project_id, runtime_id, lease_id) = authorize_restart_agent(&state, &headers).await?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let rows = connection
        .query(
            "update runtime_preview_wakes w
             set state = 'claimed', claimed_at = now(), claim_count = w.claim_count + 1
             where w.id in (
               select id from runtime_preview_wakes
               where project_id = $1
                 and runtime_id = $2
                 and created_at > now() - make_interval(secs => $3)
                 and claim_count < $4
                 and (state = 'pending'
                      or (state = 'claimed'
                          and claimed_at < now() - make_interval(secs => $5)))
               order by created_at
               limit $6
               for update skip locked
             )
             returning w.id, w.tunnel_id",
            &[
                &project_id,
                &runtime_id,
                &(WAKE_PENDING_TIMEOUT_SECONDS as f64),
                &WAKE_MAX_CLAIMS,
                &(WAKE_CLAIM_RETRY_SECONDS as f64),
                &WAKES_PER_CLAIM,
            ],
        )
        .await
        .map_err(|error| db_error("claim preview wakes", error))?;
    drop(connection);

    let mut restarts = Vec::with_capacity(rows.len());
    for row in rows {
        let wake_id: Uuid = row.get("id");
        let tunnel_id: String = row.get("tunnel_id");
        match prepare_restart(
            &state,
            &project_id,
            &runtime_id,
            lease_id,
            &wake_id,
            &tunnel_id,
        )
        .await
        {
            Ok(item) => {
                info!(%project_id, %runtime_id, preview_id = %tunnel_id, %wake_id, "preview restart claimed");
                restarts.push(item);
            }
            Err((status, Json(error))) => {
                warn!(
                    preview_id = %tunnel_id,
                    %wake_id,
                    status = status.as_u16(),
                    error = %error.message,
                    "preview restart could not be prepared"
                );
                fail_wake(&state, &wake_id, &error.message).await;
            }
        }
    }
    Ok(Json(PreviewRestartClaimResponse { restarts }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewRestartResultBody {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PreviewRestartPath {
    wake_id: String,
}

/// `POST /agent/preview-restarts/:wake_id/result`: how the restart ended. On
/// success the controller probes the site through the tunnel itself before
/// it calls the wake done.
#[instrument(skip(state, headers, body))]
pub(super) async fn post_agent_preview_restart_result(
    State(state): State<AppState>,
    Path(params): Path<PreviewRestartPath>,
    headers: HeaderMap,
    Json(body): Json<PreviewRestartResultBody>,
) -> ApiResult<Json<WakeView>> {
    let wake_id = Uuid::parse_str(params.wake_id.trim())
        .map_err(|_| bad_request("wakeId must be a valid UUID"))?;
    let (project_id, runtime_id, _) = authorize_restart_agent(&state, &headers).await?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let row = connection
        .query_opt(
            "select state, tunnel_id from runtime_preview_wakes
             where id = $1 and project_id = $2 and runtime_id = $3",
            &[&wake_id, &project_id, &runtime_id],
        )
        .await
        .map_err(|error| db_error("load preview wake", error))?
        .ok_or_else(|| not_found("preview wake not found"))?;
    drop(connection);
    let wake_state: String = row.get("state");
    let tunnel_id: String = row.get("tunnel_id");
    if wake_state != "claimed" {
        // Already settled (a timeout, a repeated report): keep the outcome.
        let grant = load_preview_grant(&state.pool, &project_id, &tunnel_id).await?;
        return Ok(Json(
            load_wake_view(&state, &project_id, &grant, None).await?,
        ));
    }

    let grant = load_preview_grant(&state.pool, &project_id, &tunnel_id).await?;
    let mut verified = true;
    let failure = if !body.ok {
        Some(
            body.error
                .as_deref()
                .map(sanitize_wake_error)
                .unwrap_or_else(|| sanitize_wake_error("")),
        )
    } else {
        // Trust, but check: the site must answer through the tunnel. When the
        // broker cannot be asked, the agent's word ends the wake but the site
        // is not announced live: Studio's own GET decides what it shows.
        match probe_preview_until_listening(&state, &grant).await {
            Some(probe) if !probe.listening => {
                Some("the site started but does not answer through the preview tunnel".to_string())
            }
            Some(_) => None,
            None => {
                verified = false;
                None
            }
        }
    };
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| db_error("acquire connection", error))?;
    let next_state = if failure.is_some() { "failed" } else { "done" };
    connection
        .execute(
            "update runtime_preview_wakes
             set state = $2, finished_at = now(), error = $3
             where id = $1 and state = 'claimed'",
            &[&wake_id, &next_state, &failure],
        )
        .await
        .map_err(|error| db_error("record preview wake", error))?;
    drop(connection);
    info!(
        %project_id,
        %runtime_id,
        preview_id = %tunnel_id,
        %wake_id,
        state = next_state,
        "preview restart reported"
    );
    let published = match (&failure, verified) {
        (Some(_), _) => "failed",
        (None, true) => "live",
        (None, false) => "unverified",
    };
    publish_wake_event(&state, &project_id, &tunnel_id, published).await;
    Ok(Json(
        load_wake_view(
            &state,
            &project_id,
            &grant,
            if verified {
                Some(failure.is_none())
            } else {
                None
            },
        )
        .await?,
    ))
}
