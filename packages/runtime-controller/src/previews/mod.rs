//! In-app previews: a private tunnel to one port of the space's runtime, a
//! "Ready to preview" card in the conversation, and a viewer session per Open.
//!
//! The site's bytes never pass through the controller. Rathole and Traefik
//! carry them; the controller records the grant and the card, mints viewer
//! capabilities, and answers the broker's `preview-auth` hook for every
//! hostname label the broker has not cached.
//!
//! Off unless configured: without `PREVIEW_DOMAIN` (or `PREVIEW_BASE_URL`),
//! or with a tunnel broker that does not say it serves private previews for
//! that same domain, every route here answers 503 `previews_unavailable`
//! before it writes anything. An older broker would otherwise publish the
//! site on a public tunnel host.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::error::SqlState;
use tokio_postgres::Row;
use tracing::{instrument, warn};
use uuid::Uuid;

use crate::active_job_auth::{authorize_active_job_if_scoped, ActiveJobProjectAccess};
use crate::agent::record_agent_conversation_message;
use crate::auth::{authenticate_request, claims_have_scopes, RequestContext};
use crate::config::PgPool;
use crate::conversations::{
    ensure_conversation_access, load_conversation_record, publish_conversation_message_event,
    ConversationRecord,
};
use crate::projects::ensure_project_access;
use crate::runtime::RUNTIME_TOKEN_REQUIRED_SCOPES;
use crate::tunnels::{
    authorize_active_job_tunnel, authorize_live_runtime_machine_tunnel,
    ensure_private_runtime_access, ensure_project_authorized, ensure_project_write_authorized,
    ensure_runtime_tunnel_generation_is_live, load_runtime_tunnel_grant_by_tunnel_id,
    mark_issuing_tunnel_active, parse_required_uuid, probe_saw_site, publish_grant_revoked,
    request_runtime_tunnel_with_overrides, resolve_canonical_tunnel_runtime_id,
    revoke_tunnel_record, runtime_tunnel_grant_from_row, tunnel_status_is_active,
    RuntimeTunnelGenerationState, RuntimeTunnelGrantRecord, TunnelProbe, TunnelRequestOverrides,
    ACTIVE_JOB_TUNNEL_METADATA_KEY, ACTIVE_JOB_TUNNEL_SOURCE, PREVIEW_TUNNEL_METADATA_KEY,
};
use crate::{
    bad_request, forbidden, internal_error, load_project_record, not_found, too_many_requests,
    unauthorized, ApiError, AppState,
};

mod follow;
#[cfg(test)]
mod follow_tests;
mod serve;
mod sessions;
#[cfg(test)]
mod site_intent_tests;
#[cfg(test)]
mod tests;
mod wake;

pub(crate) use follow::{FollowBusMessage, FollowEnvelope, FollowHub};
use serve::PreviewServe;
use sessions::PreviewOrigin;
pub(crate) use sessions::{
    check_preview_domain, prune_preview_sessions, revoke_preview_sessions_for_tunnel,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

const PREVIEW_KIND: &str = "preview";
const PREVIEW_VISIBILITY: &str = "private";
/// A preview tunnel lives as long as the lease could, not one billing
/// interval: the broker caps it at the same 12 h.
const PREVIEW_TUNNEL_TTL_SECONDS: i64 = 12 * 60 * 60;
/// Open previews one runtime may hold at once (one per port). Private
/// previews burn no credits and each is its own broker tunnel with its own
/// rathole port from a range every tenant shares, so they are capped here.
const PREVIEWS_PER_RUNTIME: i64 = 16;
/// Preview opens (new ports and re-opens) per runtime per minute.
const PREVIEW_OPENS_PER_MINUTE: usize = 30;
const PREVIEW_MIN_PORT: i64 = 1024;
/// The runtime's own services at their default ports: VNC (5900,
/// `INSTAFY_VNC_PORT`), the OpenAI proxy (8789), Chrome DevTools (9222 and
/// the Playwright CDP port 9223, `INSTAFY_PLAYWRIGHT_CDP_PORT`), the WebRTC
/// sender (9225), the browser egress proxy (9226,
/// `INSTAFY_BROWSER_EGRESS_PROXY_BIND`), personal-browser control (43127)
/// and the origin server (54332, `ORIGIN_BIND_PORT`). Instafy's browser on a
/// space's own machine uses fixed ports of its own: VNC (15900), Chrome
/// DevTools (19223), the WebRTC sender (19225) and the browser egress proxy
/// (19226). An operator who moves one of these adds its new port to
/// `PREVIEW_DENY_PORTS`, which adds to this list and never removes from it.
///
/// This list is an accident guard, not a boundary: the CLI inside the
/// runtime chooses the tunnel's local address itself, so code on the
/// machine can forward any port through an allowed preview. It stops a
/// mistaken or prompted `instafy preview open` of one of these ports.
const PREVIEW_DENIED_PORTS: [u16; 12] = [
    5900, 8789, 9222, 9223, 9225, 9226, 15900, 19223, 19225, 19226, 43127, 54332,
];
const PREVIEW_TITLE_MAX_CHARS: usize = 120;
const PREVIEW_PATH_MAX_CHARS: usize = 512;
const PREVIEW_SOURCE_MAX_CHARS: usize = 64;
/// The `messageIds` key prefix of a card written without a job run; the
/// conversation id follows, so each conversation gets its own card.
const PREVIEW_MANUAL_RUN_KEY: &str = "manual";
const PREVIEW_HEALTH_CACHE_TTL: Duration = Duration::from_secs(10);
/// `/ready` runs right after the CLI spawned the rathole client, which still
/// has to connect. Probe again after these pauses (about 3 s in all) before
/// calling the site not responding.
const PREVIEW_READY_PROBE_RETRIES: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1000),
    Duration::from_millis(1250),
];

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/previews",
            post(post_preview).get(get_previews),
        )
        .route(
            "/projects/:project_id/previews/:preview_id",
            get(get_preview),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/ready",
            post(post_preview_ready),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/view",
            post(sessions::post_preview_view),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/view/revoke",
            post(sessions::post_preview_view_revoke),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/view/heartbeat",
            post(sessions::post_preview_view_heartbeat),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/close",
            post(post_preview_close),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/follow",
            post(follow::post_preview_follow).get(follow::get_preview_follow),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/follow/stream",
            get(follow::get_preview_follow_stream),
        )
        .route(
            "/projects/:project_id/previews/:preview_id/wake",
            post(wake::post_preview_wake),
        )
        .route(
            "/agent/preview-restarts/claim",
            post(wake::post_agent_preview_restarts_claim),
        )
        .route(
            "/agent/preview-restarts/:wake_id/result",
            post(wake::post_agent_preview_restart_result),
        )
        .route(
            "/tunnel-broker/hooks/preview-auth",
            post(sessions::post_preview_auth_hook),
        )
}

fn previews_unavailable() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::with_details(
            "Previews are not available on this server",
            "previews_unavailable",
            json!({}),
        )),
    )
}

/// The viewer origin, once previews are configured here, the broker can ask
/// about viewers (`TUNNEL_BROKER_HOOK_SECRET`), and the tunnel broker says it
/// serves private previews for the same domain (its `GET /capabilities`,
/// cached). Anything else is 503 `previews_unavailable` before a route reads
/// or writes a grant: an older broker ignores the private labels and would
/// publish the site on a public tunnel host, and without the hook secret
/// every viewer would be refused.
async fn ensure_previews_available(state: &AppState) -> ApiResult<PreviewOrigin> {
    let origin =
        PreviewOrigin::from_settings(&state.config.previews).ok_or_else(previews_unavailable)?;
    let hook_secret_set = state
        .config
        .tunnel_broker_hook_secret
        .as_deref()
        .is_some_and(|secret| !secret.trim().is_empty());
    if !hook_secret_set {
        return Err(previews_unavailable());
    }
    let broker = state
        .tunnel_broker
        .as_ref()
        .ok_or_else(previews_unavailable)?;
    let capabilities = broker.capabilities().await;
    let same_domain = capabilities
        .preview_domain
        .as_deref()
        .and_then(sessions::normalize_preview_domain)
        .is_some_and(|domain| domain == origin.domain());
    if !capabilities.private_previews || !same_domain {
        return Err(previews_unavailable());
    }
    Ok(origin)
}

#[derive(Debug, Deserialize)]
struct PreviewProjectPath {
    project_id: String,
}

#[derive(Debug, Deserialize)]
struct PreviewPath {
    project_id: String,
    preview_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePreviewBody {
    #[serde(default, alias = "runtime_id")]
    runtime_id: Option<String>,
    #[serde(default, alias = "runtime_lease_id")]
    runtime_lease_id: Option<String>,
    #[serde(default, alias = "conversation_id")]
    conversation_id: Option<String>,
    port: i64,
    #[serde(default)]
    path: Option<String>,
    title: String,
    #[serde(default)]
    metadata: Option<JsonValue>,
    /// How the site was started (`instafy preview open` reads it from the
    /// process on the port or takes `--serve-cmd`). With it the preview can
    /// be woken after the runtime sleeps; without it, it cannot.
    #[serde(default)]
    serve: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatePreviewResponse {
    preview_id: String,
    status: String,
    credentials: Option<JsonValue>,
    /// Whether a wake can start the site again (a `serve` was recorded).
    restartable: bool,
    /// The Host suffix viewers reach this preview under (see
    /// `PreviewOrigin::host_suffix`), so a dev server that checks the Host
    /// header can allow it. Not a capability: it names the shared preview
    /// domain, never a label.
    viewer_host_suffix: String,
    /// The origin Studio frames previews from (`PUBLIC_APP_URL`), so a
    /// preview site that talks to its frame (a bound site's Ask Octo,
    /// location and follow mode) accepts messages from that origin only and
    /// can name it in `frame-ancestors`. Public: it is Studio's own address.
    studio_origin: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewReadyResponse {
    message_id: Uuid,
    health: Option<TunnelProbe>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewResponse {
    preview_id: String,
    title: String,
    port: u16,
    path: String,
    runtime_id: Option<Uuid>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<Option<TunnelProbe>>,
    message_id: Option<String>,
    /// Who may open it, as recorded when it was opened (today always
    /// `private`: only members who can see its runtime). Studio says so only
    /// when this says so.
    #[serde(skip_serializing_if = "Option::is_none")]
    visibility: Option<String>,
    created_at: String,
    /// A wake can start the site again: a `serve` command is recorded and no
    /// newer tunnel replaced the preview's. A preview someone closed on
    /// purpose stays restartable for people who may change the space.
    restartable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    wake: Option<wake::WakeView>,
    /// Whether a wake by the caller can go ahead: they may change the space
    /// (as starting a stopped machine requires), or its machine is up. Only
    /// on a person's `GET` of one preview, so Studio can disable Open with
    /// the reason before anyone presses it.
    #[serde(skip_serializing_if = "Option::is_none")]
    can_start: Option<bool>,
}

/// Who is calling a preview route. Job and machine tokens are bound on the
/// server to their runtime (and lease); a human is a project member.
enum PreviewCaller {
    Job {
        context: RequestContext,
        job_id: Uuid,
        run_id: Uuid,
        runtime_id: Uuid,
        runtime_lease_id: Option<Uuid>,
    },
    Machine {
        runtime_id: Uuid,
        runtime_lease_id: Option<Uuid>,
        /// The user the runtime token was minted for, when it names one.
        subject_user_id: Option<Uuid>,
    },
    Human(RequestContext),
}

impl PreviewCaller {
    /// Whose conversation access decides where a card may go: the person, or
    /// the user a runtime token acts for. A token without a user subject
    /// may only post into shared conversations.
    fn conversation_context(&self) -> Option<RequestContext> {
        match self {
            Self::Human(context) => Some(context.clone()),
            Self::Machine {
                subject_user_id: Some(user_id),
                ..
            } => Some(RequestContext {
                user_id: Some(*user_id),
                is_service_role: false,
                scoped_claims: None,
            }),
            _ => None,
        }
    }
}

/// The person a runtime token acts for, if any. A leased runtime's token
/// carries the controller's own service subject, which is no person: such a
/// token may only post into shared conversations.
fn machine_subject_user_id(subject: &str, service_runtime_user_id: Option<Uuid>) -> Option<Uuid> {
    if crate::runtime::runtime_token_subject_is_controller_service(subject, service_runtime_user_id)
    {
        return None;
    }
    Uuid::parse_str(subject.trim()).ok()
}

async fn identify_preview_caller(
    state: &AppState,
    headers: &HeaderMap,
    project_id: &Uuid,
) -> ApiResult<PreviewCaller> {
    let context = authenticate_request(&state.config, headers).await?;
    let Some(claims) = context.scoped_claims.as_ref() else {
        return Ok(PreviewCaller::Human(context));
    };
    if claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES) {
        let binding =
            authorize_live_runtime_machine_tunnel(state, claims, project_id, true).await?;
        return Ok(PreviewCaller::Machine {
            runtime_id: binding.runtime_id,
            runtime_lease_id: binding.runtime_lease_id,
            subject_user_id: machine_subject_user_id(
                &claims.sub,
                state.config.service_runtime_user_id,
            ),
        });
    }
    let binding = authorize_active_job_tunnel(state, &context, project_id).await?;
    Ok(PreviewCaller::Job {
        context,
        job_id: binding.job_id,
        run_id: binding.run_id,
        runtime_id: binding.runtime_id,
        runtime_lease_id: binding.runtime_lease_id,
    })
}

/// A preview grant as the preview routes read it.
#[derive(Clone, Debug)]
pub(crate) struct PreviewGrant {
    record: RuntimeTunnelGrantRecord,
    created_at: DateTime<Utc>,
}

impl PreviewGrant {
    fn from_row(row: &Row) -> Self {
        Self {
            record: runtime_tunnel_grant_from_row(row),
            created_at: row.get("created_at"),
        }
    }

    fn metadata(&self) -> Option<&JsonMap<String, JsonValue>> {
        self.record.metadata.as_ref().and_then(JsonValue::as_object)
    }

    /// The previews module's own object in the grant metadata.
    fn preview_metadata(&self) -> Option<&JsonMap<String, JsonValue>> {
        self.metadata()
            .and_then(|metadata| metadata.get(PREVIEW_TUNNEL_METADATA_KEY))
            .and_then(JsonValue::as_object)
    }

    fn preview_str(&self, key: &str) -> Option<&str> {
        self.preview_metadata()
            .and_then(|metadata| metadata.get(key))
            .and_then(JsonValue::as_str)
    }

    fn title(&self) -> String {
        self.preview_str("title").unwrap_or("Preview").to_string()
    }

    fn port(&self) -> u16 {
        self.metadata()
            .and_then(|metadata| metadata.get("localPort"))
            .and_then(JsonValue::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .unwrap_or(0)
    }

    fn path(&self) -> String {
        self.preview_str("path").unwrap_or("/").to_string()
    }

    /// The recorded start command, when it is still a valid one.
    fn serve(&self) -> Option<PreviewServe> {
        self.preview_metadata()
            .and_then(|metadata| metadata.get("serve"))
            .and_then(|serve| PreviewServe::from_json(serve).ok())
    }

    /// Closed on purpose (`instafy preview close`, the close route) or
    /// superseded. A runtime stop revokes the grant too, but does not close
    /// it. Starting a closed preview again changes the space, so only people
    /// who may change it can (see `wake::caller_may_start`).
    fn is_closed(&self) -> bool {
        self.preview_metadata()
            .is_some_and(|metadata| metadata.contains_key("closedAt"))
    }

    /// Closed because the broker replaced its tunnel
    /// ([`retire_superseded_previews`]): the successor is the preview now, and
    /// a wake would only get the successor's tunnel.
    fn is_superseded(&self) -> bool {
        self.preview_metadata()
            .is_some_and(|metadata| metadata.contains_key("supersededBy"))
    }

    /// A wake can start the site again: its start command is recorded and its
    /// tunnel is still its own. Closing it on purpose keeps the command, so
    /// Open on its card brings back a site someone stopped.
    fn restartable(&self) -> bool {
        self.is_private_preview()
            && !self.is_superseded()
            && self.serve().is_some()
            && self.tunnel_key().is_some()
    }

    /// The broker idempotency key this preview's tunnel was requested with,
    /// so a wake reconnects the same tunnel id (the preview id in cards).
    fn tunnel_key(&self) -> Option<&str> {
        self.preview_str("tunnelKey")
    }

    fn is_private_preview(&self) -> bool {
        grant_metadata_is_preview(self.record.metadata.as_ref())
            && self.preview_str("visibility") == Some(PREVIEW_VISIBILITY)
    }

    /// Active, not past its broker expiry.
    fn is_live(&self) -> bool {
        tunnel_status_is_active(&self.record.status) && self.record.expires_at > Utc::now()
    }

    fn status(&self) -> String {
        if tunnel_status_is_active(&self.record.status) && self.record.expires_at <= Utc::now() {
            return "expired".to_string();
        }
        self.record.status.clone()
    }

    fn job_marker(&self, key: &str) -> Option<Uuid> {
        self.metadata()
            .and_then(|metadata| metadata.get(ACTIVE_JOB_TUNNEL_METADATA_KEY))
            .and_then(|marker| marker.get(key))
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok())
    }

    /// The card of the run that last made this preview ready, else any card.
    fn message_id(&self) -> Option<String> {
        let metadata = self.preview_metadata()?;
        if let Some(message_id) = metadata.get("messageId").and_then(JsonValue::as_str) {
            return Some(message_id.to_string());
        }
        metadata
            .get("messageIds")
            .and_then(JsonValue::as_object)
            .and_then(|ids| ids.values().find_map(JsonValue::as_str))
            .map(str::to_string)
    }

    fn response(&self, health: Option<Option<TunnelProbe>>) -> PreviewResponse {
        PreviewResponse {
            preview_id: self.record.tunnel_id.clone(),
            title: self.title(),
            port: self.port(),
            path: self.path(),
            runtime_id: self.record.runtime_id,
            status: self.status(),
            health,
            message_id: self.message_id(),
            visibility: self.preview_str("visibility").map(str::to_string),
            created_at: self.created_at.to_rfc3339(),
            restartable: self.restartable(),
            wake: None,
            can_start: None,
        }
    }
}

/// Whether a newer preview holds this stopped preview's tunnel key, so a wake
/// may not reconnect it: the broker answers the key with the newer tunnel,
/// and the reconnect would write this preview's command and title over the
/// newer preview's. [`retire_superseded_previews`] marks a preview that was
/// still open as `supersededBy`, but skips one someone had closed, so for
/// that one a later grant of the same key is the record. A live preview's
/// tunnel is its key's current one.
pub(super) async fn preview_replaced(pool: &PgPool, grant: &PreviewGrant) -> ApiResult<bool> {
    if grant.is_superseded() {
        return Ok(true);
    }
    if grant.is_live() {
        return Ok(false);
    }
    let Some(tunnel_key) = grant.tunnel_key() else {
        return Ok(false);
    };
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let newer = connection
        .query_opt(
            "select 1 from runtime_tunnel_grants
             where project_id = $1
               and tunnel_id <> $2
               and jsonb_typeof(metadata->'_instafyPreview') = 'object'
               and metadata->'_instafyPreview'->>'tunnelKey' = $3
               and created_at > $4
             limit 1",
            &[
                &grant.record.project_id,
                &grant.record.tunnel_id,
                &tunnel_key,
                &grant.created_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check for a newer preview: {error}")))?;
    Ok(newer.is_some())
}

/// Whether grant metadata belongs to a preview: it holds the previews
/// module's own object, which only the controller writes.
pub(crate) fn grant_metadata_is_preview(metadata: Option<&JsonValue>) -> bool {
    metadata
        .and_then(|metadata| metadata.get(PREVIEW_TUNNEL_METADATA_KEY))
        .is_some_and(JsonValue::is_object)
}

async fn load_preview_grant(
    pool: &PgPool,
    project_id: &Uuid,
    preview_id: &str,
) -> ApiResult<PreviewGrant> {
    let preview_id = parse_preview_id(preview_id)?;
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = connection
        .query_opt(
            "select * from runtime_tunnel_grants
             where project_id = $1 and tunnel_id = $2
             limit 1",
            &[project_id, &preview_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load preview: {error}")))?;
    let grant = row
        .as_ref()
        .map(PreviewGrant::from_row)
        .filter(|grant| grant_metadata_is_preview(grant.record.metadata.as_ref()))
        .ok_or_else(|| not_found("preview not found"))?;
    Ok(grant)
}

/// Preview ids are tunnel uuids. Accept only the hyphenated spelling the
/// grant row stores, so the lookup cannot match another row's text.
fn parse_preview_id(raw: &str) -> ApiResult<String> {
    let parsed = Uuid::parse_str(raw.trim()).map_err(|_| not_found("preview not found"))?;
    Ok(parsed.hyphenated().to_string())
}

fn validate_preview_port(port: i64, extra_denied: &[u16]) -> ApiResult<u16> {
    let allowed = u16::try_from(port)
        .ok()
        .filter(|port| i64::from(*port) >= PREVIEW_MIN_PORT)
        .filter(|port| !PREVIEW_DENIED_PORTS.contains(port) && !extra_denied.contains(port));
    allowed.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError::with_details(
                format!("previews are not allowed on port {port}"),
                "port_not_allowed",
                json!({ "port": port }),
            )),
        )
    })
}

fn validate_preview_title(raw: &str) -> ApiResult<String> {
    let title = raw.trim();
    if title.is_empty() || title.chars().count() > PREVIEW_TITLE_MAX_CHARS {
        return Err(bad_request(format!(
            "title must be 1 to {PREVIEW_TITLE_MAX_CHARS} characters"
        )));
    }
    if title.chars().any(char::is_control) {
        return Err(bad_request("title must not contain control characters"));
    }
    Ok(title.to_string())
}

/// A site path: absolute, not protocol-relative, printable ASCII without
/// spaces, fragments or backslashes. It is appended to the viewer host.
fn validate_preview_path(raw: Option<&str>) -> ApiResult<String> {
    let path = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("/");
    let valid = path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= PREVIEW_PATH_MAX_CHARS
        && path
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'\\' | b'#'));
    if !valid {
        return Err(bad_request(
            "path must be an absolute site path such as / or /site/",
        ));
    }
    Ok(path.to_string())
}

fn preview_source(metadata: Option<&JsonValue>) -> String {
    metadata
        .and_then(|metadata| metadata.get("source"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|source| {
            !source.is_empty()
                && source.len() <= PREVIEW_SOURCE_MAX_CHARS
                && source
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .unwrap_or(ACTIVE_JOB_TUNNEL_SOURCE)
        .to_string()
}

fn optional_uuid(value: Option<&String>, field: &str) -> ApiResult<Option<Uuid>> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| parse_required_uuid(value, field))
        .transpose()
}

fn runtime_not_live() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(
            "the runtime is not running",
            "runtime_not_live",
            json!({}),
        )),
    )
}

/// A human names the runtime; it must be live, and the lease (when given)
/// must be its current one. Returns the lease the preview binds to.
async fn ensure_preview_runtime_live(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    requested_lease_id: Option<Uuid>,
) -> ApiResult<Option<Uuid>> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = connection
        .query_opt(
            "select r.provider, r.status, r.capabilities, r.active_lease_id,
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
        .map_err(|error| internal_error(format!("failed to load preview runtime: {error}")))?
        .ok_or_else(|| not_found("runtime not found for project"))?;
    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let capabilities: JsonValue = row.get("capabilities");
    let active_lease_id: Option<Uuid> = row.get("active_lease_id");
    let lease_status: Option<String> = row.get("lease_status");
    let lease_id = requested_lease_id.or(active_lease_id);
    ensure_runtime_tunnel_generation_is_live(
        project_id,
        runtime_id,
        lease_id,
        RuntimeTunnelGenerationState {
            private_self_hosted: crate::runtime::runtime_is_private_self_hosted(
                state,
                &provider,
                &capabilities,
            ),
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
    .map_err(|_| runtime_not_live())?;
    Ok(lease_id)
}

/// A conversation a non-job caller names for the card: in this project, and
/// one the caller's user may see (see [`PreviewCaller::conversation_context`]).
async fn ensure_preview_conversation(
    state: &AppState,
    project_id: &Uuid,
    conversation_id: &Uuid,
    viewer: Option<&RequestContext>,
) -> ApiResult<()> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start conversation check: {error}")))?;
    let conversation = load_conversation_record(&transaction, conversation_id).await?;
    ensure_preview_card_conversation(&transaction, project_id, &conversation, viewer).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finish conversation check: {error}")))?;
    Ok(())
}

/// End the viewer sessions of an earlier, stopped preview on this runtime
/// and port, whatever lease it had. The broker hands the same tunnel back for
/// that key (one key per runtime and port, so a preview keeps its id across
/// a sleep) and the grant upsert makes it active again, so a capability
/// minted before the preview stopped would otherwise work again after a
/// re-open. A stopped grant cannot mint, so nothing new is lost.
async fn revoke_sessions_of_stopped_previews(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
    port: u16,
) -> ApiResult<()> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    match connection
        .execute(
            "update runtime_preview_sessions
             set revoked_at = now()
             where revoked_at is null
               and tunnel_id in (
                 select tunnel_id
                 from runtime_tunnel_grants
                 where project_id = $1
                   and runtime_id = $2
                   and jsonb_typeof(metadata->'_instafyPreview') = 'object'
                   and metadata->'localPort' = to_jsonb($3::int)
                   and (lower(btrim(status)) in ('revoked', 'expired', 'failed')
                        or expires_at <= now())
               )",
            &[project_id, runtime_id, &i32::from(port)],
        )
        .await
    {
        Ok(_) => Ok(()),
        Err(error)
            if matches!(
                error.as_db_error().map(|db_error| db_error.code()),
                Some(&SqlState::UNDEFINED_TABLE)
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(internal_error(format!(
            "failed to end earlier preview sessions: {error}"
        ))),
    }
}

#[instrument(skip(state, headers, body))]
async fn post_preview(
    State(state): State<AppState>,
    Path(params): Path<PreviewProjectPath>,
    headers: HeaderMap,
    Json(body): Json<CreatePreviewBody>,
) -> ApiResult<(StatusCode, Json<CreatePreviewResponse>)> {
    let origin = ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let port = validate_preview_port(body.port, &state.config.previews.deny_ports)?;
    let title = validate_preview_title(&body.title)?;
    let path = validate_preview_path(body.path.as_deref())?;
    let serve = body
        .serve
        .as_ref()
        .filter(|serve| !serve.is_null())
        .map(PreviewServe::from_json)
        .transpose()
        .map_err(bad_request)?;
    let requested_runtime_id = optional_uuid(body.runtime_id.as_ref(), "runtimeId")?;
    let requested_lease_id = optional_uuid(body.runtime_lease_id.as_ref(), "runtimeLeaseId")?;
    let conversation_id = optional_uuid(body.conversation_id.as_ref(), "conversationId")?;

    let caller = identify_preview_caller(&state, &headers, &project_id).await?;
    let mut active_job_marker = None;
    let (runtime_id, runtime_lease_id, conversation_id) = match &caller {
        PreviewCaller::Job {
            job_id,
            run_id,
            runtime_id,
            runtime_lease_id,
            ..
        } => {
            // Client copies of the binding are only checked, never trusted.
            if requested_runtime_id.is_some_and(|id| id != *runtime_id)
                || requested_lease_id.is_some_and(|id| Some(id) != *runtime_lease_id)
            {
                return Err(forbidden(
                    "job token cannot open a preview on another runtime",
                ));
            }
            active_job_marker = Some(json!({
                "jobId": job_id,
                "runId": run_id,
                "runtimeId": runtime_id,
                "runtimeLeaseId": runtime_lease_id,
            }));
            // The card goes to the job's own conversation.
            (*runtime_id, *runtime_lease_id, None)
        }
        PreviewCaller::Machine {
            runtime_id,
            runtime_lease_id,
            ..
        } => {
            if requested_runtime_id.is_some_and(|id| id != *runtime_id)
                || requested_lease_id.is_some_and(|id| Some(id) != *runtime_lease_id)
            {
                return Err(forbidden(
                    "runtime token cannot open a preview on another runtime",
                ));
            }
            let conversation_id = conversation_id
                .ok_or_else(|| bad_request("conversationId is required without a job token"))?;
            ensure_preview_conversation(
                &state,
                &project_id,
                &conversation_id,
                caller.conversation_context().as_ref(),
            )
            .await?;
            (*runtime_id, *runtime_lease_id, Some(conversation_id))
        }
        PreviewCaller::Human(context) => {
            ensure_project_write_authorized(&state, &project_id, context).await?;
            let runtime_id = resolve_canonical_tunnel_runtime_id(
                &state,
                &project_id,
                requested_runtime_id,
                requested_lease_id,
            )
            .await?
            .ok_or_else(|| bad_request("runtimeId is required"))?;
            ensure_private_runtime_access(&state, &project_id, &runtime_id, context).await?;
            let lease_id =
                ensure_preview_runtime_live(&state, &project_id, &runtime_id, requested_lease_id)
                    .await?;
            let conversation_id = conversation_id
                .ok_or_else(|| bad_request("conversationId is required without a job token"))?;
            ensure_preview_conversation(&state, &project_id, &conversation_id, Some(context))
                .await?;
            (runtime_id, lease_id, Some(conversation_id))
        }
    };

    // One tunnel per runtime and port, whatever the lease: a preview keeps
    // its id (the one its cards name) when it is opened again on the
    // runtime's next lease.
    let tunnel_key = preview_tunnel_key(&runtime_id, port);
    ensure_preview_capacity(&state, &project_id, &runtime_id, &tunnel_key).await?;

    // What the preview routes trust lives in one controller-owned object
    // the generic tunnel routes can neither set nor drop.
    let mut preview = JsonMap::new();
    preview.insert("visibility".to_string(), json!(PREVIEW_VISIBILITY));
    preview.insert("path".to_string(), json!(path));
    preview.insert("title".to_string(), json!(title));
    // The grant upsert carries the cards of a still-live preview with the
    // same title and path over; anything else gets a card of its own.
    preview.insert("messageIds".to_string(), json!({}));
    if let Some(conversation_id) = conversation_id {
        preview.insert("conversationId".to_string(), json!(conversation_id));
    }
    preview.insert("tunnelKey".to_string(), json!(tunnel_key));
    // How the site was started, for a wake. Controller-owned like the rest,
    // so no tunnel route can swap in another command.
    let restartable = serve.is_some();
    if let Some(serve) = serve {
        preview.insert("serve".to_string(), serve.to_json());
    }
    let mut metadata = JsonMap::new();
    metadata.insert("localPort".to_string(), json!(port));
    metadata.insert(
        "source".to_string(),
        json!(preview_source(body.metadata.as_ref())),
    );
    metadata.insert(
        PREVIEW_TUNNEL_METADATA_KEY.to_string(),
        JsonValue::Object(preview),
    );
    if let Some(marker) = active_job_marker {
        metadata.insert(ACTIVE_JOB_TUNNEL_METADATA_KEY.to_string(), marker);
    }

    revoke_sessions_of_stopped_previews(&state.pool, &project_id, &runtime_id, port).await?;
    let grant = request_runtime_tunnel_with_overrides(
        &state,
        &project_id,
        Some(&runtime_id),
        runtime_lease_id.as_ref(),
        Some(JsonValue::Object(metadata)),
        preview_tunnel_overrides(tunnel_key.clone()),
    )
    .await?;
    retire_previews_superseded_by(&state, &project_id, &tunnel_key, &grant.tunnel_id).await;

    Ok((
        StatusCode::CREATED,
        Json(CreatePreviewResponse {
            preview_id: grant.tunnel_id,
            status: grant.status,
            credentials: grant.credentials,
            restartable,
            viewer_host_suffix: origin.host_suffix(),
            studio_origin: state.config.public_app_url.clone(),
        }),
    ))
}

/// Refuse a preview open past the runtime's rate or past
/// [`PREVIEWS_PER_RUNTIME`] other live previews (re-opening one of its own
/// ports is always allowed). Whoever asks (a member, a job, the runtime
/// machine token), the runtime is what holds the tunnels.
async fn ensure_preview_capacity(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
    tunnel_key: &str,
) -> ApiResult<()> {
    state
        .rate_limiter
        .enforce(
            format!("preview-open:{runtime_id}"),
            PREVIEW_OPENS_PER_MINUTE,
            Duration::from_secs(60),
        )
        .await
        .map_err(|limit| {
            let seconds = limit.retry_after.as_secs().max(1);
            too_many_requests(format!(
                "Too many previews opened on this runtime. Try again in {seconds}s."
            ))
        })?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let others: i64 = connection
        .query_one(
            "select count(*)
             from runtime_tunnel_grants
             where project_id = $1
               and runtime_id = $2
               and jsonb_typeof(metadata->'_instafyPreview') = 'object'
               and coalesce(metadata->'_instafyPreview'->>'tunnelKey', '') <> $3
               and lower(btrim(status)) not in ('revoked', 'expired', 'failed')
               and expires_at > now()",
            &[project_id, runtime_id, &tunnel_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to count previews: {error}")))?
        .get(0);
    if others >= PREVIEWS_PER_RUNTIME {
        return Err(too_many_requests(format!(
            "This runtime already has {PREVIEWS_PER_RUNTIME} previews open. Close one first."
        )));
    }
    Ok(())
}

fn preview_tunnel_key(runtime_id: &Uuid, port: u16) -> String {
    format!("preview:{runtime_id}:{port}")
}

fn preview_tunnel_overrides(idempotency_key: String) -> TunnelRequestOverrides {
    TunnelRequestOverrides {
        idempotency_key: Some(idempotency_key),
        expires_in_seconds: Some(PREVIEW_TUNNEL_TTL_SECONDS),
        labels: Some(json!({ "kind": PREVIEW_KIND, "visibility": PREVIEW_VISIBILITY })),
    }
}

/// Where the card goes and which run it belongs to.
struct PreviewCardTarget {
    conversation_id: Uuid,
    session_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    run_id: Option<Uuid>,
    job_id: Option<Uuid>,
}

impl PreviewCardTarget {
    fn run_key(&self) -> String {
        self.run_id
            .map(|run_id| run_id.to_string())
            .unwrap_or_else(|| format!("{PREVIEW_MANUAL_RUN_KEY}:{}", self.conversation_id))
    }
}

#[instrument(skip(state, headers))]
async fn post_preview_ready(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
) -> ApiResult<Json<PreviewReadyResponse>> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let caller = identify_preview_caller(&state, &headers, &project_id).await?;
    let mut grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    if !grant.is_live() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("this preview is closed")),
        ));
    }
    match &caller {
        PreviewCaller::Job { runtime_id, .. } | PreviewCaller::Machine { runtime_id, .. }
            if grant.record.runtime_id != Some(*runtime_id) =>
        {
            return Err(forbidden("preview belongs to another runtime"));
        }
        PreviewCaller::Machine {
            runtime_lease_id, ..
        } if grant.record.runtime_lease_id != *runtime_lease_id => {
            return Err(forbidden("preview belongs to another runtime lease"));
        }
        PreviewCaller::Human(context) => {
            ensure_project_write_authorized(&state, &project_id, context).await?;
            ensure_preview_runtime_access(&state, &project_id, &grant, context).await?;
        }
        _ => {}
    }

    // Probe before taking the row lock: the broker may take seconds. The
    // client was just (re)started, so an older cached answer does not count.
    let health = probe_preview_until_listening(&state, &grant).await;
    record_preview_serving(&state, &mut grant, health.as_ref()).await;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start preview card: {error}")))?;

    let target = match &caller {
        PreviewCaller::Job { context, .. } => {
            let active_job = authorize_active_job_if_scoped(
                &transaction,
                &state,
                context,
                ActiveJobProjectAccess::Write,
            )
            .await?
            .ok_or_else(|| unauthorized("active job token required"))?;
            active_job.ensure_project_id(&project_id)?;
            if grant.job_marker("jobId") != Some(active_job.job_id) {
                return Err(forbidden("preview was opened by another job"));
            }
            let conversation =
                load_conversation_record(&transaction, &active_job.conversation_id).await?;
            active_job
                .ensure_conversation_write(&transaction, &conversation)
                .await?;
            let row = transaction
                .query_one(
                    "select run_id, prompt_id, session_id, payload
                     from agent_jobs
                     where id = $1 and project_id = $2",
                    &[&active_job.job_id, &project_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load agent job: {error}")))?;
            let payload: JsonValue = row.get("payload");
            let payload_uuid = |key: &str| {
                payload
                    .get(key)
                    .and_then(JsonValue::as_str)
                    .and_then(|value| Uuid::parse_str(value.trim()).ok())
            };
            PreviewCardTarget {
                conversation_id: active_job.conversation_id,
                session_id: row
                    .get::<_, Option<Uuid>>("session_id")
                    .or_else(|| payload_uuid("session_id")),
                prompt_id: row
                    .get::<_, Option<Uuid>>("prompt_id")
                    .or_else(|| payload_uuid("prompt_id")),
                run_id: row.get("run_id"),
                job_id: Some(active_job.job_id),
            }
        }
        PreviewCaller::Machine { .. } | PreviewCaller::Human(_) => {
            let conversation_id = grant
                .preview_str("conversationId")
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| bad_request("preview has no conversation for its card"))?;
            let conversation = load_conversation_record(&transaction, &conversation_id).await?;
            ensure_preview_card_conversation(
                &transaction,
                &project_id,
                &conversation,
                caller.conversation_context().as_ref(),
            )
            .await?;
            PreviewCardTarget {
                conversation_id,
                session_id: conversation.session_id,
                prompt_id: None,
                run_id: None,
                job_id: None,
            }
        }
    };

    // One card per (preview, run): the row lock serializes concurrent calls.
    let locked = transaction
        .query_opt(
            "select metadata from runtime_tunnel_grants where id = $1 for update",
            &[&grant.record.id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock preview: {error}")))?
        .ok_or_else(|| not_found("preview not found"))?;
    let mut metadata = locked
        .get::<_, Option<JsonValue>>("metadata")
        .filter(JsonValue::is_object)
        .unwrap_or_else(|| json!({}));
    let run_key = target.run_key();
    let existing = metadata
        .get(PREVIEW_TUNNEL_METADATA_KEY)
        .and_then(|preview| preview.get("messageIds"))
        .and_then(|ids| ids.get(&run_key))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value).ok());
    if let Some(message_id) = existing {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to finish preview card: {error}")))?;
        return Ok(Json(PreviewReadyResponse { message_id, health }));
    }

    let title = grant.title();
    let message = record_agent_conversation_message(
        &transaction,
        &project_id,
        &target.conversation_id,
        target.session_id,
        target.prompt_id,
        target.run_id,
        format!("{title} is ready to preview."),
        build_preview_card_metadata(
            target.job_id.as_ref(),
            &grant.record.tunnel_id,
            &title,
            grant.port(),
            &grant.path(),
        ),
    )
    .await?;

    if let Some(map) = metadata
        .get_mut(PREVIEW_TUNNEL_METADATA_KEY)
        .and_then(JsonValue::as_object_mut)
    {
        let ids = map
            .entry("messageIds".to_string())
            .or_insert_with(|| json!({}));
        if !ids.is_object() {
            *ids = json!({});
        }
        if let Some(ids) = ids.as_object_mut() {
            ids.insert(run_key, json!(message.id));
        }
        map.insert("messageId".to_string(), json!(message.id));
    }
    transaction
        .execute(
            "update runtime_tunnel_grants
             set metadata = $2, updated_at = now()
             where id = $1",
            &[&grant.record.id, &metadata],
        )
        .await
        .map_err(|error| internal_error(format!("failed to record preview card: {error}")))?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit preview card: {error}")))?;

    publish_conversation_message_event(&state.events, &message);
    Ok(Json(PreviewReadyResponse {
        message_id: message.id,
        health,
    }))
}

async fn ensure_preview_card_conversation(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation: &ConversationRecord,
    viewer: Option<&RequestContext>,
) -> ApiResult<()> {
    if conversation.project_id != *project_id {
        return Err(forbidden("conversation does not belong to this project"));
    }
    match viewer {
        Some(context) => ensure_conversation_access(transaction, conversation, context).await,
        None if conversation.visibility == "private" => Err(forbidden(
            "a runtime token cannot post into a private conversation",
        )),
        None => Ok(()),
    }
}

/// The card: an `action_request` wrapped the way agent updates are, so the
/// frontend's `details.details` unwrap applies. It names the preview by id
/// only. No URL and no `href`: an `href` would make the generic action card
/// open a window, and the viewer URL is minted per Open, per user. No stored
/// actions either: Studio draws the card's Open from `preview` itself, so a
/// client that does not know `preview` shows a card with no button rather
/// than one that does nothing.
fn build_preview_card_metadata(
    job_id: Option<&Uuid>,
    preview_id: &str,
    title: &str,
    port: u16,
    path: &str,
) -> JsonValue {
    let mut metadata = JsonMap::new();
    metadata.insert("source".to_string(), json!("agent"));
    metadata.insert("kind".to_string(), json!("update"));
    if let Some(job_id) = job_id {
        metadata.insert("jobId".to_string(), json!(job_id.to_string()));
    }
    metadata.insert("messageType".to_string(), json!("action_request"));
    metadata.insert(
        "details".to_string(),
        json!({
            "messageType": "action_request",
            "details": {
                "testId": "preview-ready-card",
                "icon": "preview",
                "overline": "Ready to preview",
                "title": title,
                "preview": { "previewId": preview_id, "port": port, "path": path },
            },
        }),
    );
    JsonValue::Object(metadata)
}

/// The grant's runtime, when it is a private one, must be visible to the
/// caller, as `GET /tunnels` filters it.
async fn ensure_preview_runtime_access(
    state: &AppState,
    project_id: &Uuid,
    grant: &PreviewGrant,
    context: &RequestContext,
) -> ApiResult<()> {
    if let Some(runtime_id) = resolve_canonical_tunnel_runtime_id(
        state,
        project_id,
        grant.record.runtime_id,
        grant.record.runtime_lease_id,
    )
    .await?
    {
        ensure_private_runtime_access(state, project_id, &runtime_id, context).await?;
    }
    Ok(())
}

static PREVIEW_HEALTH_CACHE: Lazy<Mutex<HashMap<String, (Instant, Option<TunnelProbe>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The broker's view of the site, reused from the cache while younger than
/// `max_age` (at most the 10 s the cache keeps it). `None` means the broker
/// could not be asked, which is not the same as "not responding".
async fn probe_preview(
    state: &AppState,
    grant: &PreviewGrant,
    max_age: Duration,
) -> Option<TunnelProbe> {
    let tunnel_id = grant.record.tunnel_id.clone();
    if let Ok(cache) = PREVIEW_HEALTH_CACHE.lock() {
        if let Some((at, health)) = cache.get(&tunnel_id) {
            if at.elapsed() < max_age.min(PREVIEW_HEALTH_CACHE_TTL) {
                return health.clone();
            }
        }
    }
    let broker = state.tunnel_broker.clone()?;
    let health = match broker.probe_tunnel(&tunnel_id, &grant.path()).await {
        Ok(probe) => Some(probe),
        Err(error) => {
            warn!(tunnel_id = %tunnel_id, ?error, "preview probe failed");
            None
        }
    };
    if let Ok(mut cache) = PREVIEW_HEALTH_CACHE.lock() {
        cache.retain(|_, (at, _)| at.elapsed() < PREVIEW_HEALTH_CACHE_TTL);
        cache.insert(tunnel_id, (Instant::now(), health.clone()));
    }
    health
}

/// A preview whose probe saw the site is serving: an issuing grant becomes
/// active, so the record the card and pane read says so. Every path that
/// probes a preview goes through here, whether or not `ready` was ever called.
async fn record_preview_serving(
    state: &AppState,
    grant: &mut PreviewGrant,
    health: Option<&TunnelProbe>,
) {
    if !grant.record.status.trim().eq_ignore_ascii_case("issuing") || !probe_saw_site(health) {
        return;
    }
    match mark_issuing_tunnel_active(state, &grant.record).await {
        Ok(Some(updated)) => grant.record = updated,
        Ok(None) => {}
        Err((_, Json(error))) => warn!(
            tunnel_id = %grant.record.tunnel_id,
            error = %error.message,
            "could not record the preview as active"
        ),
    }
}

/// A fresh probe, repeated while the broker reaches the tunnel but nothing
/// answers yet, so a just-started client is not reported as not responding.
async fn probe_preview_until_listening(
    state: &AppState,
    grant: &PreviewGrant,
) -> Option<TunnelProbe> {
    let mut health = probe_preview(state, grant, Duration::ZERO).await;
    for pause in PREVIEW_READY_PROBE_RETRIES {
        if !matches!(
            health,
            Some(TunnelProbe {
                listening: false,
                ..
            })
        ) {
            break;
        }
        tokio::time::sleep(pause).await;
        health = probe_preview(state, grant, Duration::ZERO).await;
    }
    health
}

/// Who may read previews, and through which identity private runtimes are
/// filtered. A machine token sees only its own runtime's previews.
enum PreviewReader {
    Context(RequestContext),
    Machine { runtime_id: Uuid },
}

async fn authorize_preview_reader(
    state: &AppState,
    headers: &HeaderMap,
    project_id: &Uuid,
) -> ApiResult<PreviewReader> {
    let context = authenticate_request(&state.config, headers).await?;
    let Some(claims) = context.scoped_claims.as_ref() else {
        ensure_project_authorized(state, project_id, &context).await?;
        return Ok(PreviewReader::Context(context));
    };
    if claims_have_scopes(claims, RUNTIME_TOKEN_REQUIRED_SCOPES) {
        let binding =
            authorize_live_runtime_machine_tunnel(state, claims, project_id, true).await?;
        return Ok(PreviewReader::Machine {
            runtime_id: binding.runtime_id,
        });
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start job check: {error}")))?;
    let active_job =
        authorize_active_job_if_scoped(&transaction, state, &context, ActiveJobProjectAccess::Read)
            .await?
            .ok_or_else(|| unauthorized("active job token required"))?;
    active_job.ensure_project_id(project_id)?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finish job check: {error}")))?;
    Ok(PreviewReader::Context(active_job.subject_context()))
}

/// Whether the reader may see this preview: hidden like any tunnel on a
/// private runtime they cannot see.
async fn preview_visible_to(
    state: &AppState,
    project_id: &Uuid,
    grant: &PreviewGrant,
    reader: &PreviewReader,
) -> ApiResult<bool> {
    match reader {
        PreviewReader::Machine { runtime_id } => Ok(grant.record.runtime_id == Some(*runtime_id)),
        PreviewReader::Context(context) => {
            match ensure_preview_runtime_access(state, project_id, grant, context).await {
                Ok(()) => Ok(true),
                Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND, _)) => Ok(false),
                Err(error) => Err(error),
            }
        }
    }
}

#[instrument(skip(state, headers))]
async fn get_previews(
    State(state): State<AppState>,
    Path(params): Path<PreviewProjectPath>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<PreviewResponse>>> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let reader = authorize_preview_reader(&state, &headers, &project_id).await?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let rows = connection
        .query(
            "select * from runtime_tunnel_grants
             where project_id = $1
               and jsonb_typeof(metadata->'_instafyPreview') = 'object'
               and lower(btrim(status)) not in ('revoked', 'expired', 'failed')
               and expires_at > now()
             order by created_at desc
             limit 100",
            &[&project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list previews: {error}")))?;
    drop(connection);
    let mut previews = Vec::with_capacity(rows.len());
    for grant in rows.iter().map(PreviewGrant::from_row) {
        if preview_visible_to(&state, &project_id, &grant, &reader).await? {
            previews.push(grant.response(None));
        }
    }
    Ok(Json(previews))
}

#[derive(Debug, Default, Deserialize)]
struct PreviewQuery {
    /// `1` asks for a new probe instead of the cached one, for a person's Reload.
    #[serde(default)]
    fresh: Option<String>,
}

#[instrument(skip(state, headers))]
async fn get_preview(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    Query(query): Query<PreviewQuery>,
    headers: HeaderMap,
) -> ApiResult<Json<PreviewResponse>> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let reader = authorize_preview_reader(&state, &headers, &project_id).await?;
    let mut grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    if !preview_visible_to(&state, &project_id, &grant, &reader).await? {
        return Err(not_found("preview not found"));
    }
    let fresh = matches!(query.fresh.as_deref(), Some("1" | "true"));
    let health = if grant.is_live() {
        // A probe costs the broker one HEAD through the tunnel, no more than
        // loading the page, so a person's "check now" always gets a new one.
        let max_age = if fresh {
            Duration::ZERO
        } else {
            PREVIEW_HEALTH_CACHE_TTL
        };
        probe_preview(&state, &grant, max_age).await
    } else {
        None
    };
    record_preview_serving(&state, &mut grant, health.as_ref()).await;
    let listening = health.as_ref().map(|probe| probe.listening);
    let mut response = grant.response(Some(health));
    if response.restartable && preview_replaced(&state.pool, &grant).await? {
        response.restartable = false;
    }
    response.wake = Some(wake::load_wake_view(&state, &project_id, &grant, listening).await?);
    if let PreviewReader::Context(context) = &reader {
        response.can_start =
            Some(wake::caller_may_start(&state, &project_id, &grant, context).await);
    }
    Ok(Json(response))
}

#[instrument(skip(state, headers))]
async fn post_preview_close(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    ensure_previews_available(&state).await?;
    let project_id = parse_required_uuid(&params.project_id, "projectId")?;
    let caller = identify_preview_caller(&state, &headers, &project_id).await?;
    let grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    match &caller {
        // Any live job or the runtime itself may close a preview on its own
        // runtime generation, not only the job that opened it.
        PreviewCaller::Job {
            runtime_id,
            runtime_lease_id,
            ..
        }
        | PreviewCaller::Machine {
            runtime_id,
            runtime_lease_id,
            ..
        } => {
            if grant.record.runtime_id != Some(*runtime_id)
                || (grant.record.runtime_lease_id.is_some()
                    && grant.record.runtime_lease_id != *runtime_lease_id)
            {
                return Err(forbidden("preview belongs to another runtime"));
            }
        }
        PreviewCaller::Human(context) => {
            ensure_project_write_authorized(&state, &project_id, context).await?;
            ensure_preview_runtime_access(&state, &project_id, &grant, context).await?;
        }
    }
    if !tunnel_status_is_active(&grant.record.status) {
        // Already stopped (a runtime stop, say); make sure no viewer outlived
        // it, that only someone who may change the space starts it again,
        // and that nobody still presents it.
        revoke_preview_sessions_for_tunnel(&state.pool, &grant.record.tunnel_id).await;
        mark_preview_closed(&state.pool, &grant.record.id).await?;
        state
            .follow
            .end_preview(&grant.record.tunnel_id, follow::EndReason::Closed);
        return Ok(StatusCode::NO_CONTENT);
    }
    let record =
        load_runtime_tunnel_grant_by_tunnel_id(&state.pool, &project_id, &grant.record.tunnel_id)
            .await?
            .ok_or_else(|| not_found("preview not found"))?;
    revoke_tunnel_record(&state, record, None).await?;
    mark_preview_closed(&state.pool, &grant.record.id).await?;
    // A closed preview has nothing left to present.
    state
        .follow
        .end_preview(&grant.record.tunnel_id, follow::EndReason::Closed);
    Ok(StatusCode::NO_CONTENT)
}

/// What ends with a preview grant the broker revoked on its own: its viewer
/// sessions and any presentation of it.
pub(crate) async fn end_preview_of_revoked_grant(
    state: &AppState,
    grant: &RuntimeTunnelGrantRecord,
) {
    revoke_preview_sessions_for_tunnel(&state.pool, &grant.tunnel_id).await;
    state
        .follow
        .end_preview(&grant.tunnel_id, follow::EndReason::Closed);
}

/// The broker keeps one tunnel per idempotency key, and a preview's key is
/// its runtime and port. When an open hands back another tunnel than an
/// earlier grant of the same key holds (the broker retired that tunnel, as it
/// does one minted under a domain it no longer serves), the earlier grant is
/// a preview nobody can reach again: its tunnel is gone and a wake would get
/// the new one. Close each such grant as `POST /previews/{id}/close` does
/// (stopped, `closedAt`, sessions and presentation ended, Studio told with
/// `tunnel.grant_revoked`, so its card shows it ended), recording the
/// successor as `supersededBy`. The broker already revoked those tunnels and
/// is not asked again.
///
/// Only grants first recorded before the successor are closed: an open or a
/// wake that got an older issue of the key (its broker answer came before the
/// replacement, but its call ran late) must not close the newer preview.
///
/// Cards name a preview by its id, so they are not moved: the successor gets
/// its own card on its first `/ready`. A successor that copied the card ids
/// of a grant it superseded (a wake reconnects with the preview's stored
/// metadata, even after another open closed that grant) forgets them, so that
/// card is written. Closed grants are skipped, so running this again changes
/// nothing.
async fn retire_superseded_previews(
    state: &AppState,
    project_id: &Uuid,
    tunnel_key: &str,
    successor_tunnel_id: &str,
) -> ApiResult<()> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start preview retirement: {error}")))?;
    let rows = transaction
        .query(
            "update runtime_tunnel_grants
             set status = case
                   when lower(btrim(status)) in ('revoked', 'expired', 'failed') then status
                   else 'revoked'
                 end,
                 metadata = jsonb_set(
                   jsonb_set(metadata, '{_instafyPreview,closedAt}', to_jsonb(now())),
                   '{_instafyPreview,supersededBy}',
                   to_jsonb($3::text)
                 ),
                 updated_at = now()
             where project_id = $1
               and jsonb_typeof(metadata->'_instafyPreview') = 'object'
               and metadata->'_instafyPreview'->>'tunnelKey' = $2
               and tunnel_id <> $3
               and not (metadata->'_instafyPreview' ? 'closedAt')
               and created_at < (
                 select successor.created_at from runtime_tunnel_grants successor
                 where successor.project_id = $1 and successor.tunnel_id = $3
               )
             returning *",
            &[project_id, &tunnel_key, &successor_tunnel_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to retire superseded previews: {error}"))
        })?;
    let retired: Vec<RuntimeTunnelGrantRecord> =
        rows.iter().map(runtime_tunnel_grant_from_row).collect();
    // Every grant this successor superseded, not only the ones closed just
    // now: a wake that copied a grant's cards may land after another open
    // already closed that grant.
    let superseded = transaction
        .query(
            "select metadata from runtime_tunnel_grants
             where project_id = $1
               and jsonb_typeof(metadata->'_instafyPreview') = 'object'
               and metadata->'_instafyPreview'->>'supersededBy' = $2",
            &[project_id, &successor_tunnel_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load superseded previews: {error}")))?;
    let retired_cards: Vec<String> = superseded
        .iter()
        .flat_map(|row| preview_card_ids(row.get::<_, Option<JsonValue>>("metadata").as_ref()))
        .collect();
    if !retired_cards.is_empty() {
        let successor = transaction
            .query_opt(
                "select id, metadata from runtime_tunnel_grants
                 where project_id = $1 and tunnel_id = $2
                 for update",
                &[project_id, &successor_tunnel_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load the new preview: {error}")))?;
        if let Some(successor) = successor {
            let mut metadata: Option<JsonValue> = successor.get("metadata");
            if forget_preview_cards(metadata.as_mut(), &retired_cards) {
                let successor_id: Uuid = successor.get("id");
                transaction
                    .execute(
                        "update runtime_tunnel_grants
                         set metadata = $2, updated_at = now()
                         where id = $1",
                        &[&successor_id, &metadata],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to update the new preview's cards: {error}"))
                    })?;
            }
        }
    }
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to retire superseded previews: {error}"))
    })?;
    drop(connection);

    for grant in &retired {
        tracing::info!(
            %project_id,
            retired_tunnel_id = %grant.tunnel_id,
            %successor_tunnel_id,
            "closed a preview whose tunnel the broker replaced"
        );
        end_preview_of_revoked_grant(state, grant).await;
        publish_grant_revoked(state, grant);
    }
    Ok(())
}

/// [`retire_superseded_previews`] after an open or a wake got `tunnel_id` for
/// `tunnel_key`. The open itself succeeded, so a failure is only logged; the
/// next open of the same key tries again.
pub(super) async fn retire_previews_superseded_by(
    state: &AppState,
    project_id: &Uuid,
    tunnel_key: &str,
    tunnel_id: &str,
) {
    if let Err((status, Json(error))) =
        retire_superseded_previews(state, project_id, tunnel_key, tunnel_id).await
    {
        warn!(
            %project_id,
            %tunnel_id,
            status = status.as_u16(),
            error = %error.message,
            "failed to close previews whose tunnel the broker replaced"
        );
    }
}

/// The card message ids a preview grant records.
fn preview_card_ids(metadata: Option<&JsonValue>) -> Vec<String> {
    let Some(preview) = metadata.and_then(|metadata| metadata.get(PREVIEW_TUNNEL_METADATA_KEY))
    else {
        return Vec::new();
    };
    let mut ids: Vec<String> = preview
        .get("messageIds")
        .and_then(JsonValue::as_object)
        .map(|ids| {
            ids.values()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(id) = preview.get("messageId").and_then(JsonValue::as_str) {
        ids.push(id.to_string());
    }
    ids
}

/// Drop `cards` from a preview grant's card ids. Whether anything changed.
fn forget_preview_cards(metadata: Option<&mut JsonValue>, cards: &[String]) -> bool {
    let Some(preview) = metadata
        .and_then(|metadata| metadata.get_mut(PREVIEW_TUNNEL_METADATA_KEY))
        .and_then(JsonValue::as_object_mut)
    else {
        return false;
    };
    let names = |id: &JsonValue| {
        id.as_str()
            .is_some_and(|id| cards.iter().any(|card| card == id))
    };
    let mut changed = false;
    if let Some(ids) = preview
        .get_mut("messageIds")
        .and_then(JsonValue::as_object_mut)
    {
        let before = ids.len();
        ids.retain(|_, id| !names(id));
        changed |= ids.len() != before;
    }
    if preview.get("messageId").is_some_and(names) {
        preview.remove("messageId");
        changed = true;
    }
    changed
}

/// A closed preview stays down until someone who may change the space starts
/// it again: `closedAt` (in the controller-owned preview object, so only this
/// module sets it) keeps viewers' wakes and a viewer's Open from bringing it
/// back. A wake by a builder, or a later `instafy preview open` of the same
/// port, writes fresh metadata without it.
async fn mark_preview_closed(pool: &PgPool, grant_row_id: &Uuid) -> ApiResult<()> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    connection
        .execute(
            "update runtime_tunnel_grants
             set metadata = jsonb_set(
                   metadata,
                   '{_instafyPreview,closedAt}',
                   to_jsonb(now())
                 ),
                 updated_at = now()
             where id = $1
               and jsonb_typeof(metadata->'_instafyPreview') = 'object'",
            &[grant_row_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to close preview: {error}")))?;
    Ok(())
}

/// The preview an Ask Octo message names (`metadata.siteIntent.previewId`,
/// crate::site_intent): its title and port when it is an open private
/// preview in this project that `user_id` may see, else None. Needs no
/// broker: a preview that cannot be served has no grant left to find.
pub(crate) async fn site_intent_preview(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    preview_id: &Uuid,
) -> ApiResult<Option<crate::site_intent::SitePreviewFacts>> {
    let grant = match load_preview_grant(&state.pool, project_id, &preview_id.to_string()).await {
        Ok(grant) => grant,
        Err((StatusCode::NOT_FOUND, _)) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !grant.is_private_preview() || !grant.is_live() || grant.is_closed() {
        return Ok(None);
    }
    if !viewer_may_see_preview(state, project_id, user_id, &grant).await? {
        return Ok(None);
    }
    Ok(Some(crate::site_intent::SitePreviewFacts {
        title: grant.title(),
        port: grant.port(),
    }))
}

/// The broker hook's identity check of a viewer: still a member who may see
/// the preview's runtime. The 30 s cache bounds the database work per label;
/// the hook shortens its answer's TTL by the cache entry's age, so a removed
/// member still loses access within 30 s.
async fn viewer_may_see_preview(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    grant: &PreviewGrant,
) -> ApiResult<bool> {
    let context = RequestContext {
        user_id: Some(*user_id),
        is_service_role: false,
        scoped_claims: None,
    };
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start viewer check: {error}")))?;
    let project = match load_project_record(&transaction, project_id).await {
        Ok(project) => project,
        Err((StatusCode::NOT_FOUND, _)) => return Ok(false),
        Err(error) => return Err(error),
    };
    match ensure_project_access(&transaction, &project, &context, None).await {
        Ok(()) => {}
        Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::UNAUTHORIZED, _)) => {
            return Ok(false)
        }
        Err(error) => return Err(error),
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finish viewer check: {error}")))?;
    drop(connection);
    match ensure_preview_runtime_access(state, project_id, grant, &context).await {
        Ok(()) => Ok(true),
        Err((StatusCode::FORBIDDEN | StatusCode::NOT_FOUND, _)) => Ok(false),
        Err(error) => Err(error),
    }
}
