//! Viewer sessions: the capability in a preview's hostname.
//!
//! Each Open mints `p-<label>--<tunnel hex>.<preview domain>`, where the label
//! is 26 base32 characters (130 random bits) bound to one user and one
//! preview. Only `sha256(label)` is stored. The broker asks
//! `POST /tunnel-broker/hooks/preview-auth` about a label it has not cached and
//! caches the answer for the `ttlSeconds` it gets back (at most 30 s).
//!
//! The label is in the page's origin, and browsers send the origin to every
//! third party a site calls (CDNs, APIs, WebSockets), so proxied traffic
//! must not keep a label alive: a session the Studio pane opened lives on the
//! pane's authenticated heartbeat alone, and the hook only checks it. A
//! session opened for a separate browser tab has no heartbeat; its own traffic
//! extends it (`extended_by_use`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use once_cell::sync::Lazy;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_postgres::error::SqlState;
use tracing::{instrument, warn};
use uuid::Uuid;

use super::{
    ensure_previews_available, load_preview_grant, validate_preview_path, viewer_may_see_preview,
    ApiResult, PreviewGrant, PreviewPath,
};
use crate::auth::authenticate_request;
use crate::config::{PgPool, PreviewSettings};
use crate::tunnels::{
    authorize_hook, ensure_private_runtime_access, ensure_project_authorized,
    resolve_canonical_tunnel_runtime_id,
};
use crate::{bad_request, forbidden, internal_error, too_many_requests, ApiError, AppState};

const LABEL_LENGTH: usize = 26;
const LABEL_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
pub(super) const SESSION_IDLE_SECONDS: i64 = 30 * 60;
pub(super) const SESSION_MAX_AGE_SECONDS: i64 = 12 * 60 * 60;
/// Live sessions per user and preview; minting one more revokes the oldest.
pub(super) const SESSIONS_PER_VIEWER: i64 = 5;
const HOOK_MAX_TTL_SECONDS: i64 = 30;
/// `last_used_at` is written at most this often per session.
const SESSION_TOUCH_INTERVAL_SECONDS: i64 = 60;
const VIEWER_ACCESS_CACHE_TTL: Duration = Duration::from_secs(30);
/// Viewer URLs one person may mint for one preview per minute. The pane mints
/// on Open, on a 410 and for "Open in new tab"; a loop is not a viewer.
const VIEW_MINTS_PER_MINUTE: usize = 20;
/// Sessions are useless after [`SESSION_MAX_AGE_SECONDS`]; their rows go a
/// little after that, and revoked ones once no broker cache can hold them.
const SESSION_ROW_RETENTION_SECONDS: i64 = SESSION_MAX_AGE_SECONDS + 60 * 60;
const REVOKED_SESSION_RETENTION_SECONDS: i64 = 60 * 60;

/// Where viewer hosts live: `PREVIEW_BASE_URL` (for example
/// `http://preview.localhost:8083`), else `https://<PREVIEW_DOMAIN>`. Unset
/// means previews are off, and every preview route fails closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PreviewOrigin {
    scheme: String,
    domain: String,
    port: Option<u16>,
}

impl PreviewOrigin {
    pub(super) fn from_settings(settings: &PreviewSettings) -> Option<Self> {
        Self::parse(settings.base_url.as_deref(), settings.domain.as_deref())
    }

    pub(super) fn domain(&self) -> &str {
        &self.domain
    }

    /// `None` for anything but a bare origin. Plain `http` is only for a
    /// loopback host: the label in a viewer host is a capability, and Studio
    /// refuses a non-local `http` viewer URL anyway.
    pub(super) fn parse(base_url: Option<&str>, domain: Option<&str>) -> Option<Self> {
        if let Some(raw) = base_url.map(str::trim).filter(|value| !value.is_empty()) {
            let url = url::Url::parse(raw).ok()?;
            let bare_origin = url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty()
                && url.password().is_none();
            if !matches!(url.scheme(), "http" | "https") || !bare_origin {
                return None;
            }
            let domain = normalize_preview_domain(url.host_str()?)?;
            if url.scheme() == "http" && !is_loopback_host(&domain) {
                return None;
            }
            return Some(Self {
                scheme: url.scheme().to_string(),
                domain,
                port: url.port(),
            });
        }
        Some(Self {
            scheme: "https".to_string(),
            domain: normalize_preview_domain(domain?)?,
            port: None,
        })
    }

    /// Everything after `p-<label>--<tunnel hex>.` in a viewer Host header:
    /// the domain, plus the port when it is not the scheme's default. A dev
    /// server that checks the Host header (Vite's `allowedHosts`, say) can
    /// allow exactly this suffix. The tunnel hex alone is not a secret, so a
    /// site should pin the domain, not just a host that looks like a viewer's.
    pub(super) fn host_suffix(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.domain),
            None => self.domain.clone(),
        }
    }

    pub(super) fn viewer_url(&self, label: &str, tunnel_id: &Uuid, path: &str) -> String {
        let port = self.port.map(|port| format!(":{port}")).unwrap_or_default();
        format!(
            "{}://p-{label}--{}.{}{port}{path}",
            self.scheme,
            tunnel_id.simple(),
            self.domain
        )
    }
}

/// Refuse to start with a preview domain that shares a cookie scope with
/// Studio, the API or public tunnels: equal to one of their hosts, under or
/// above it, or a sibling under the same registrable domain (by the Public
/// Suffix List). A viewer host runs whatever site the space serves, so it
/// must not be able to set cookies those hosts receive. Hosted deployments
/// want a registrable domain of their own, best listed on the Public Suffix
/// List itself. Loopback development hosts (`localhost`) are only checked
/// for equality: `preview.localhost` next to a Studio on `localhost:5173` is
/// the local stack's own layout.
pub(crate) fn check_preview_domain(config: &crate::config::AppConfig) -> anyhow::Result<()> {
    let settings = &config.previews;
    let configured = settings
        .base_url
        .as_deref()
        .or(settings.domain.as_deref())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !configured {
        return Ok(());
    }
    let origin = PreviewOrigin::from_settings(settings).ok_or_else(|| {
        anyhow::anyhow!(
            "PREVIEW_BASE_URL or PREVIEW_DOMAIN is set but is not a valid origin or domain"
        )
    })?;
    let url_host = |raw: &str| {
        url::Url::parse(raw.trim())
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
    };
    let mut others: Vec<(&str, String)> = Vec::new();
    if let Some(host) = url_host(&config.public_app_url) {
        others.push(("PUBLIC_APP_URL", host));
    }
    if let Some(host) = config
        ._controller_external_url
        .as_deref()
        .and_then(url_host)
    {
        others.push(("CONTROLLER_EXTERNAL_URL", host));
    }
    if let Some(domain) = settings.tunnel_domain.as_deref() {
        others.push(("TUNNEL_DOMAIN", domain.to_string()));
    }
    for (name, host) in others {
        let Some(host) = normalize_preview_domain(&host) else {
            continue;
        };
        if preview_domain_overlaps(origin.domain(), &host) {
            anyhow::bail!(
                "the preview domain {} shares a cookie scope with {name} ({host}); \
                 use a separate domain for previews",
                origin.domain()
            );
        }
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .trim_matches(|ch| ch == '[' || ch == ']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// Whether two hosts share a cookie scope: equal, one under the other on a
/// label boundary, or both under the same registrable domain, so a site on
/// one could set `Domain=` cookies the other receives. Loopback hosts only
/// count when equal.
pub(super) fn preview_domain_overlaps(preview: &str, other: &str) -> bool {
    if preview == other {
        return true;
    }
    if is_loopback_host(preview) || is_loopback_host(other) {
        return false;
    }
    let under = |child: &str, parent: &str| {
        child.len() > parent.len()
            && child.ends_with(parent)
            && child.as_bytes()[child.len() - parent.len() - 1] == b'.'
    };
    if under(preview, other) || under(other, preview) {
        return true;
    }
    // An IP address has no registrable domain and takes no `Domain=` cookie.
    let registrable = |host: &str| {
        host.parse::<std::net::IpAddr>()
            .is_err()
            .then(|| psl::domain_str(host).map(str::to_ascii_lowercase))
            .flatten()
    };
    matches!(
        (registrable(preview), registrable(other)),
        (Some(a), Some(b)) if a == b
    )
}

pub(super) fn normalize_preview_domain(raw: &str) -> Option<String> {
    let domain = raw
        .trim()
        .trim_start_matches("*.")
        .trim_matches('.')
        .to_ascii_lowercase();
    let valid = !domain.is_empty()
        && domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
    valid.then_some(domain)
}

pub(super) fn mint_capability_label() -> String {
    let mut bytes = [0u8; LABEL_LENGTH];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    // 256 is a multiple of 32, so the low five bits are uniform.
    bytes
        .iter()
        .map(|byte| LABEL_ALPHABET[usize::from(byte & 31)] as char)
        .collect()
}

pub(super) fn capability_hash(label: &str) -> String {
    hex::encode(Sha256::digest(label.as_bytes()))
}

/// The label and tunnel of a viewer host `p-<label>--<32 hex>.<domain>`.
pub(super) fn parse_viewer_host(host: &str) -> Option<(String, Uuid)> {
    let first = host.split('.').next()?;
    let rest = first.strip_prefix("p-")?;
    let (label, tunnel_hex) = rest.split_once("--")?;
    let label_valid =
        label.len() == LABEL_LENGTH && label.bytes().all(|byte| LABEL_ALPHABET.contains(&byte));
    let hex_valid = tunnel_hex.len() == 32
        && tunnel_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if !label_valid || !hex_valid {
        return None;
    }
    Some((label.to_string(), Uuid::parse_str(tunnel_hex).ok()?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewViewResponse {
    viewer_url: String,
    idle_timeout_seconds: i64,
    expires_at: String,
}

/// `POST …/view?tab=true`: a viewer URL for a separate browser tab.
#[derive(Debug, Default, Deserialize)]
pub(super) struct PreviewViewQuery {
    #[serde(default)]
    tab: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewViewRevokeBody {
    viewer_url: String,
}

/// The caller's own viewer session named by its URL: the session's label and
/// the preview id, after checking the URL belongs to this preview.
fn viewer_session_of(preview_id_raw: &str, viewer_url: &str) -> ApiResult<(String, Uuid)> {
    let preview_id = Uuid::parse_str(preview_id_raw.trim())
        .map_err(|_| bad_request("previewId must be a valid UUID"))?;
    let (label, tunnel_id) = url::Url::parse(viewer_url.trim())
        .ok()
        .and_then(|url| url.host_str().and_then(parse_viewer_host))
        .ok_or_else(|| bad_request("viewerUrl is not a preview address"))?;
    if tunnel_id != preview_id {
        return Err(bad_request("viewerUrl belongs to another preview"));
    }
    Ok((label, preview_id))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewAuthHookBody {
    tunnel_id: String,
    capability_hash: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewAuthHookResponse {
    allow: bool,
    ttl_seconds: i64,
}

impl PreviewAuthHookResponse {
    fn deny() -> Json<Self> {
        Json(Self {
            allow: false,
            ttl_seconds: 0,
        })
    }
}

/// Mint a viewer URL for the signed-in user (`POST …/:pid/view`). With
/// `?tab=true` the session is for a separate browser tab, which has no
/// heartbeat, so requests through it keep it alive instead.
#[instrument(skip(state, headers))]
pub(super) async fn post_preview_view(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    Query(query): Query<PreviewViewQuery>,
    headers: HeaderMap,
) -> ApiResult<Json<PreviewViewResponse>> {
    let origin = ensure_previews_available(&state).await?;
    let project_id = crate::tunnels::parse_required_uuid(&params.project_id, "projectId")?;
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("previews are opened from a Studio session"));
    }
    let user_id = context
        .user_id
        .ok_or_else(|| forbidden("previews are opened by a signed-in member"))?;
    // Key the budget on the parsed id, so another spelling of the same uuid
    // shares it.
    let preview_key = super::parse_preview_id(&params.preview_id)?;
    state
        .rate_limiter
        .enforce(
            format!("preview-view:{user_id}:{preview_key}"),
            VIEW_MINTS_PER_MINUTE,
            Duration::from_secs(60),
        )
        .await
        .map_err(|limit| {
            let seconds = limit.retry_after.as_secs().max(1);
            too_many_requests(format!("Too many preview opens. Try again in {seconds}s."))
        })?;
    ensure_project_authorized(&state, &project_id, &context).await?;
    let grant = load_preview_grant(&state.pool, &project_id, &params.preview_id).await?;
    if let Some(runtime_id) = resolve_canonical_tunnel_runtime_id(
        &state,
        &project_id,
        grant.record.runtime_id,
        grant.record.runtime_lease_id,
    )
    .await?
    {
        ensure_private_runtime_access(&state, &project_id, &runtime_id, &context).await?;
    }
    if !grant.is_private_preview() {
        return Err(forbidden("only private previews open in Studio"));
    }
    if !grant.is_live() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new("this preview has stopped")),
        ));
    }
    let tunnel_id = uuid_of(&grant)?;
    // The path is appended to the viewer host; check it again rather than
    // trust the stored metadata.
    let path = validate_preview_path(Some(&grant.path()))
        .map_err(|_| forbidden("this preview has an unusable path"))?;

    let label = mint_capability_label();
    let created_at = insert_preview_session(
        &state.pool,
        &capability_hash(&label),
        &grant.record.tunnel_id,
        &project_id,
        &user_id,
        query.tab.unwrap_or(false),
    )
    .await?;
    let expires_at = (created_at + ChronoDuration::seconds(SESSION_MAX_AGE_SECONDS))
        .min(grant.record.expires_at);
    Ok(Json(PreviewViewResponse {
        viewer_url: origin.viewer_url(&label, &tunnel_id, &path),
        idle_timeout_seconds: SESSION_IDLE_SECONDS,
        expires_at: expires_at.to_rfc3339(),
    }))
}

fn uuid_of(grant: &PreviewGrant) -> ApiResult<Uuid> {
    Uuid::parse_str(&grant.record.tunnel_id)
        .map_err(|_| internal_error("preview tunnel id is not a uuid"))
}

/// Store a new session and keep at most [`SESSIONS_PER_VIEWER`] live for this
/// user and preview, revoking the oldest. The advisory lock makes two
/// concurrent Opens count each other.
async fn insert_preview_session(
    pool: &PgPool,
    hash: &str,
    tunnel_id: &str,
    project_id: &Uuid,
    user_id: &Uuid,
    extended_by_use: bool,
) -> ApiResult<DateTime<Utc>> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start preview session: {error}")))?;
    let lock_key = format!("runtime_preview_sessions:{user_id}:{tunnel_id}");
    transaction
        .execute("select pg_advisory_xact_lock(hashtext($1))", &[&lock_key])
        .await
        .map_err(|error| internal_error(format!("failed to lock preview sessions: {error}")))?;
    transaction
        .execute(
            "update runtime_preview_sessions
             set revoked_at = now()
             where capability_hash in (
               select capability_hash
               from runtime_preview_sessions
               where user_id = $1
                 and tunnel_id = $2
                 and revoked_at is null
                 and last_used_at > now() - make_interval(secs => $3)
                 and created_at > now() - make_interval(secs => $4)
               order by created_at desc, capability_hash
               offset $5
             )",
            &[
                user_id,
                &tunnel_id,
                &(SESSION_IDLE_SECONDS as f64),
                &(SESSION_MAX_AGE_SECONDS as f64),
                &(SESSIONS_PER_VIEWER - 1),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to trim preview sessions: {error}")))?;
    let row = transaction
        .query_one(
            "insert into runtime_preview_sessions
               (capability_hash, tunnel_id, project_id, user_id, extended_by_use)
             values ($1, $2, $3, $4, $5)
             returning created_at",
            &[&hash, &tunnel_id, project_id, user_id, &extended_by_use],
        )
        .await
        .map_err(|error| internal_error(format!("failed to store preview session: {error}")))?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit preview session: {error}")))?;
    Ok(row.get("created_at"))
}

/// End the caller's own session (`POST …/:pid/view/revoke`). The pane calls
/// it when its tab closes. Unknown or foreign URLs change nothing and still
/// answer 204, so the call cannot probe for other users' sessions.
#[instrument(skip(state, headers, body))]
pub(super) async fn post_preview_view_revoke(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
    Json(body): Json<PreviewViewRevokeBody>,
) -> ApiResult<StatusCode> {
    ensure_previews_available(&state).await?;
    crate::tunnels::parse_required_uuid(&params.project_id, "projectId")?;
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("previews are closed from a Studio session"));
    }
    let user_id = context
        .user_id
        .ok_or_else(|| forbidden("previews are closed by a signed-in member"))?;
    let (label, preview_id) = viewer_session_of(&params.preview_id, &body.viewer_url)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    connection
        .execute(
            "update runtime_preview_sessions
             set revoked_at = coalesce(revoked_at, now())
             where capability_hash = $1 and user_id = $2 and tunnel_id = $3",
            &[
                &capability_hash(&label),
                &user_id,
                &preview_id.hyphenated().to_string(),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to revoke preview session: {error}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Keep the caller's open pane alive (`POST …/:pid/view/heartbeat`). The
/// pane calls it about once a minute while it shows the preview. It is what
/// keeps a pane's session from the 30-minute idle limit (the hook does not:
/// see the module comment). `204` while the session is live and its holder
/// may still see the preview; `410` once not (revoked, idle, too old,
/// removed from the space), so the pane mints a new one. Another user's URL
/// is treated like a dead one. Calls within the same minute change nothing.
#[instrument(skip(state, headers, body))]
pub(super) async fn post_preview_view_heartbeat(
    State(state): State<AppState>,
    Path(params): Path<PreviewPath>,
    headers: HeaderMap,
    Json(body): Json<PreviewViewRevokeBody>,
) -> ApiResult<StatusCode> {
    ensure_previews_available(&state).await?;
    crate::tunnels::parse_required_uuid(&params.project_id, "projectId")?;
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("previews are viewed from a Studio session"));
    }
    let user_id = context
        .user_id
        .ok_or_else(|| forbidden("previews are viewed by a signed-in member"))?;
    let (label, preview_id) = viewer_session_of(&params.preview_id, &body.viewer_url)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let row = connection
        .query_opt(
            "select s.project_id, s.last_used_at < now() - make_interval(secs => $6) as stale
             from runtime_preview_sessions s
             join runtime_tunnel_grants g on g.tunnel_id = s.tunnel_id
             where s.capability_hash = $1
               and s.user_id = $2
               and s.tunnel_id = $3
               and s.revoked_at is null
               and s.last_used_at > now() - make_interval(secs => $4)
               and s.created_at > now() - make_interval(secs => $5)
               and lower(btrim(g.status)) not in ('revoked', 'expired', 'failed')
               and g.expires_at > now()",
            &[
                &capability_hash(&label),
                &user_id,
                &preview_id.hyphenated().to_string(),
                &(SESSION_IDLE_SECONDS as f64),
                &(SESSION_MAX_AGE_SECONDS as f64),
                &(SESSION_TOUCH_INTERVAL_SECONDS as f64),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load preview session: {error}")))?;
    drop(connection);
    let Some(row) = row else {
        return Ok(StatusCode::GONE);
    };
    if !row.get::<_, bool>("stale") {
        return Ok(StatusCode::NO_CONTENT);
    }
    // A person removed from the space (or from a private runtime) since the
    // Open must not keep the session alive.
    let project_id: Uuid = row.get("project_id");
    let tunnel = preview_id.hyphenated().to_string();
    let grant = match load_preview_grant(&state.pool, &project_id, &tunnel).await {
        Ok(grant) => grant,
        Err((StatusCode::NOT_FOUND, _)) => return Ok(StatusCode::GONE),
        Err(error) => return Err(error),
    };
    if !viewer_still_allowed(&state, &project_id, &user_id, &grant).await? {
        revoke_preview_session(&state.pool, &capability_hash(&label)).await;
        return Ok(StatusCode::GONE);
    }
    touch_preview_session(&state.pool, &capability_hash(&label)).await;
    Ok(StatusCode::NO_CONTENT)
}

/// End every viewer session of a preview tunnel. Best effort: a failure is
/// logged, and the hook still denies, because it requires an active grant.
pub(crate) async fn revoke_preview_sessions_for_tunnel(pool: &PgPool, tunnel_id: &str) {
    let connection = match pool.get().await {
        Ok(connection) => connection,
        Err(error) => {
            warn!(tunnel_id, %error, "failed to revoke preview sessions");
            return;
        }
    };
    if let Err(error) = connection
        .execute(
            "update runtime_preview_sessions
             set revoked_at = now()
             where tunnel_id = $1 and revoked_at is null",
            &[&tunnel_id],
        )
        .await
    {
        let code = error.as_db_error().map(|db_error| db_error.code());
        if !matches!(code, Some(&SqlState::UNDEFINED_TABLE)) {
            warn!(tunnel_id, %error, "failed to revoke preview sessions");
        }
    }
}

/// `(user, project, runtime)` → when that viewer last passed the membership
/// and private-runtime check.
static VIEWER_ACCESS_CACHE: Lazy<Mutex<HashMap<(Uuid, Uuid, Option<Uuid>), Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cached_viewer_access(key: &(Uuid, Uuid, Option<Uuid>)) -> Option<Duration> {
    let cache = VIEWER_ACCESS_CACHE.lock().ok()?;
    let age = cache.get(key)?.elapsed();
    VIEWER_ACCESS_CACHE_TTL
        .checked_sub(age)
        .filter(|left| !left.is_zero())
}

fn remember_viewer_access(key: (Uuid, Uuid, Option<Uuid>)) {
    if let Ok(mut cache) = VIEWER_ACCESS_CACHE.lock() {
        if cache.len() > 4096 {
            cache.retain(|_, at| at.elapsed() < VIEWER_ACCESS_CACHE_TTL);
        }
        cache.insert(key, Instant::now());
    }
}

#[cfg(test)]
pub(super) fn forget_viewer_access(user_id: &Uuid, project_id: &Uuid) {
    if let Ok(mut cache) = VIEWER_ACCESS_CACHE.lock() {
        cache.retain(|(user, project, _), _| user != user_id || project != project_id);
    }
}

/// How long the viewer's membership check stays good (cached per node for
/// [`VIEWER_ACCESS_CACHE_TTL`]), or `None` when they may no longer see it.
async fn viewer_access_left(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    grant: &PreviewGrant,
) -> ApiResult<Option<Duration>> {
    let cache_key = (*user_id, *project_id, grant.record.runtime_id);
    if let Some(left) = cached_viewer_access(&cache_key) {
        return Ok(Some(left));
    }
    if !viewer_may_see_preview(state, project_id, user_id, grant).await? {
        return Ok(None);
    }
    remember_viewer_access(cache_key);
    Ok(Some(VIEWER_ACCESS_CACHE_TTL))
}

async fn viewer_still_allowed(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    grant: &PreviewGrant,
) -> ApiResult<bool> {
    Ok(viewer_access_left(state, project_id, user_id, grant)
        .await?
        .is_some())
}

async fn revoke_preview_session(pool: &PgPool, hash: &str) {
    match pool.get().await {
        Ok(connection) => {
            if let Err(error) = connection
                .execute(
                    "update runtime_preview_sessions set revoked_at = coalesce(revoked_at, now())
                     where capability_hash = $1",
                    &[&hash],
                )
                .await
            {
                warn!(%error, "failed to revoke preview session");
            }
        }
        Err(error) => warn!(%error, "failed to revoke preview session"),
    }
}

/// Delete viewer-session rows nobody can use any more (older than the max
/// age plus an hour, or revoked for an hour). Rows are who-viewed-what
/// history; they are not kept forever.
pub(crate) async fn prune_preview_sessions(pool: &PgPool) -> anyhow::Result<u64> {
    let connection = pool.get().await?;
    let sessions = connection
        .execute(
            "delete from runtime_preview_sessions
             where created_at < now() - make_interval(secs => $1)
                or revoked_at < now() - make_interval(secs => $2)",
            &[
                &(SESSION_ROW_RETENTION_SECONDS as f64),
                &(REVOKED_SESSION_RETENTION_SECONDS as f64),
            ],
        )
        .await?;
    Ok(sessions)
}

/// The broker's per-label check (`POST /tunnel-broker/hooks/preview-auth`).
/// Allows only a session that is not revoked, idle under 30 min and under
/// 12 h old, on an active private preview grant for the same tunnel, held by
/// a user who is still a member allowed to see that runtime.
#[instrument(skip(state, headers, body))]
pub(super) async fn post_preview_auth_hook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PreviewAuthHookBody>,
) -> ApiResult<Json<PreviewAuthHookResponse>> {
    authorize_hook(&headers, state.config.tunnel_broker_hook_secret.as_ref())?;
    ensure_previews_available(&state).await?;
    let hash = body.capability_hash.trim().to_ascii_lowercase();
    let Ok(tunnel_id) = Uuid::parse_str(body.tunnel_id.trim()) else {
        return Ok(PreviewAuthHookResponse::deny());
    };
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(PreviewAuthHookResponse::deny());
    }

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let Some(row) = connection
        .query_opt(
            "select s.tunnel_id, s.project_id, s.user_id, s.created_at, s.last_used_at,
                    s.revoked_at, s.extended_by_use, now() as checked_at
             from runtime_preview_sessions s
             where s.capability_hash = $1",
            &[&hash],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load preview session: {error}")))?
    else {
        return Ok(PreviewAuthHookResponse::deny());
    };
    drop(connection);
    let session_tunnel: String = row.get("tunnel_id");
    let project_id: Uuid = row.get("project_id");
    let user_id: Uuid = row.get("user_id");
    let created_at: DateTime<Utc> = row.get("created_at");
    let last_used_at: DateTime<Utc> = row.get("last_used_at");
    let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
    let extended_by_use: bool = row.get("extended_by_use");
    let now: DateTime<Utc> = row.get("checked_at");

    let idle_left = SESSION_IDLE_SECONDS - (now - last_used_at).num_seconds();
    let age_left = SESSION_MAX_AGE_SECONDS - (now - created_at).num_seconds();
    if revoked_at.is_some()
        || idle_left <= 0
        || age_left <= 0
        || Uuid::parse_str(&session_tunnel).ok() != Some(tunnel_id)
    {
        return Ok(PreviewAuthHookResponse::deny());
    }

    let grant = match load_preview_grant(&state.pool, &project_id, &session_tunnel).await {
        Ok(grant) => grant,
        Err((StatusCode::NOT_FOUND, _)) => return Ok(PreviewAuthHookResponse::deny()),
        Err(error) => return Err(error),
    };
    let grant_left = (grant.record.expires_at - now).num_seconds();
    if !grant.is_private_preview()
        || !crate::tunnels::tunnel_status_is_active(&grant.record.status)
        || grant_left <= 0
    {
        return Ok(PreviewAuthHookResponse::deny());
    }

    let Some(access_left) = viewer_access_left(&state, &project_id, &user_id, &grant).await? else {
        return Ok(PreviewAuthHookResponse::deny());
    };

    // Check only for a pane's session; see the module comment.
    if extended_by_use {
        touch_preview_session(&state.pool, &hash).await;
    }
    let ttl_seconds = [
        HOOK_MAX_TTL_SECONDS,
        idle_left,
        age_left,
        grant_left,
        access_left.as_secs() as i64,
    ]
    .into_iter()
    .min()
    .unwrap_or(0)
    .max(1);
    Ok(Json(PreviewAuthHookResponse {
        allow: true,
        ttl_seconds,
    }))
}

/// Mark a session used, at most once a minute, so idle expiry tracks use
/// without a write per proxied request (a pane's heartbeat, or a tab
/// session's own traffic).
async fn touch_preview_session(pool: &PgPool, hash: &str) {
    let result = match pool.get().await {
        Ok(connection) => connection
            .execute(
                "update runtime_preview_sessions
                 set last_used_at = now()
                 where capability_hash = $1
                   and last_used_at < now() - make_interval(secs => $2)",
                &[&hash, &(SESSION_TOUCH_INTERVAL_SECONDS as f64)],
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = result {
        warn!(%error, "failed to touch preview session");
    }
}
