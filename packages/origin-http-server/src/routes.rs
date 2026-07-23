use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use axum::body::{to_bytes, Body};
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State};
use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{Json, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde::Serialize;
use std::fs::Metadata;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};
use tracing::warn;
use uuid::Uuid;

use crate::apply::{
    apply_changes_transactional, apply_changes_transactional_file, normalize_relative_path,
    ApplyManifest, ApplySummary,
};
use crate::apply_idempotency::{
    abort_apply_idempotency_claim, claim_apply_idempotency, complete_apply_idempotency_claim,
    lookup_apply_idempotency, normalize_apply_idempotency_key, normalize_apply_request_fingerprint,
    ApplyIdempotencyClaimOutcome, ApplyIdempotencyLookup, ApplyIdempotencySuccess,
};
use crate::auth::{OriginClaims, TokenValidator};
use crate::browser;
use crate::config::{ServerConfig, MAX_APPLY_MANIFEST_BYTES};
use crate::error::OriginError;
use crate::git;
use crate::git_tokens;
use crate::paths::is_reserved_path;
use crate::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};
use crate::workspace_lock::try_acquire_workspace_apply_lock;

const GIT_WORKSPACE_SYNC_TTL_SECONDS: u64 = 120;
const MAX_APPLY_JSON_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_APPLY_JSON_REQUEST_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Debug)]
struct OriginAccessToken {
    token: String,
}

#[derive(Debug, Deserialize)]
struct ActiveWorkspaceLeaseEnvelope {
    lease: Option<ActiveWorkspaceLease>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveWorkspaceLease {
    lease_id: Uuid,
    project_id: Uuid,
    user_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<ServerConfig>,
    pub token_validator: TokenValidator,
    pub http_client: reqwest::Client,
    pub workspace_root: Arc<PathBuf>,
    pub workspace_fs: WorkspaceDir,
    pub browser_collaboration: crate::browser_collaboration::BrowserCollaborationHub,
    pub commit_receipt_url: Option<reqwest::Url>,
    pub apply_locks: Arc<Mutex<std::collections::HashMap<Uuid, Arc<Mutex<()>>>>>,
    pub git_last_sync: Arc<Mutex<std::collections::HashMap<Uuid, Instant>>>,
    pub apply_slots: Arc<Semaphore>,
}

impl AppState {
    pub fn new(
        config: Arc<ServerConfig>,
        token_validator: TokenValidator,
        http_client: reqwest::Client,
        workspace_root: PathBuf,
        commit_receipt_url: Option<reqwest::Url>,
    ) -> std::io::Result<Self> {
        let workspace_fs = WorkspaceDir::open(&workspace_root)?;
        Ok(Self {
            config,
            token_validator,
            http_client,
            workspace_root: Arc::new(workspace_root),
            workspace_fs,
            browser_collaboration: crate::browser_collaboration::BrowserCollaborationHub::new(),
            commit_receipt_url,
            apply_locks: Arc::new(Mutex::new(std::collections::HashMap::new())),
            git_last_sync: Arc::new(Mutex::new(std::collections::HashMap::new())),
            // Archive parsing/staging can be memory and I/O intensive. Keep a
            // single bounded admission point across all projects served by a
            // multi-tenant origin process.
            apply_slots: Arc::new(Semaphore::new(1)),
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct EntriesQuery {
    pub path: Option<String>,
    pub sync: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FileEntryResponse {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified: Option<String>,
    pub extension: Option<String>,
    #[serde(rename = "hasChildren")]
    pub has_children: bool,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FileContentResponse {
    pub path: String,
    pub encoding: String,
    pub content_base64: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub modified: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkspaceSyncBehavior {
    BlockingForced,
    RefreshInBackground,
}

pub fn router(state: AppState) -> Router {
    let cors_layer = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    let health_routes = Router::new().route("/healthz", get(|| async { "ok" }));

    let read_routes = Router::new()
        .route("/entries", get(handle_entries))
        .route("/files/*path", get(handle_file))
        .route("/raw/*path", get(handle_raw))
        .route("/git/status", get(handle_git_status))
        .route("/git/diff", get(handle_git_diff))
        .route("/git/history", get(handle_git_history))
        .route("/git/history/review", get(handle_git_history_review))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_read,
        ));

    let apply_routes = Router::new()
        // Multipart uploads use the server-level RequestBodyLimitLayer cap.
        // Disable Axum's small default extractor cap for this route.
        .route(
            "/apply",
            post(handle_apply).layer(DefaultBodyLimit::disable()),
        )
        .route("/apply-json", post(handle_apply_json))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            limit_apply_concurrency,
        ));

    let write_routes = Router::new()
        .merge(apply_routes)
        .route("/apply/status", post(handle_apply_status))
        .route("/git/revert", post(handle_git_revert))
        .route("/git/revert-commit", post(handle_git_revert_commit))
        .route("/git/sync", post(handle_git_sync))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_write,
        ));

    let browser_view_routes = browser::view_routes().route_layer(
        axum::middleware::from_fn_with_state(state.clone(), require_browser_view),
    );

    let browser_control_routes = browser::control_routes().route_layer(
        axum::middleware::from_fn_with_state(state.clone(), require_browser_control),
    );

    let browser_interactive_transport_routes = browser::interactive_transport_routes().route_layer(
        axum::middleware::from_fn_with_state(state.clone(), require_browser_view_and_control),
    );

    Router::new()
        .merge(health_routes)
        .merge(read_routes)
        .merge(write_routes)
        .merge(browser_view_routes)
        .merge(browser_control_routes)
        .merge(browser_interactive_transport_routes)
        // Multipart uses Axum's limited-body extractor path by default (2MB).
        // Keep the effective cap controlled by RequestBodyLimitLayer in server.rs.
        .layer(DefaultBodyLimit::disable())
        .layer(cors_layer)
        .with_state(state)
}

async fn limit_apply_concurrency(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    let _permit = state
        .apply_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| OriginError::unavailable("apply admission is unavailable"))?;
    Ok(next.run(request).await)
}

async fn require_read(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    authorize_and_continue(state, request, next, &["fs.read"]).await
}

async fn require_write(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    authorize_and_continue(state, request, next, &["fs.write"]).await
}

async fn require_browser_view(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    authorize_and_continue(state, request, next, &["browser.view"]).await
}

async fn require_browser_control(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    authorize_and_continue(state, request, next, &["browser.control"]).await
}

async fn require_browser_view_and_control(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OriginError> {
    authorize_and_continue(state, request, next, &["browser.view", "browser.control"]).await
}

async fn authorize_and_continue(
    state: AppState,
    mut request: Request,
    next: Next,
    required_scopes: &[&str],
) -> Result<Response, OriginError> {
    let mut headers = request.headers().clone();
    let mut authenticated_from_query = false;

    if !state.config.skip_auth && !headers.contains_key(header::AUTHORIZATION) {
        if request.method() == Method::GET || request.method() == Method::HEAD {
            if let Some(token) = token_from_query(request.uri().query()) {
                if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    headers.insert(header::AUTHORIZATION, value);
                    authenticated_from_query = true;
                }
            }
        }
    }

    let claims = state
        .token_validator
        .authorize(&state.config, &headers, required_scopes)
        .await?;

    let token = bearer_token_from_headers(&headers).unwrap_or_default();

    // `fs.write` is a live-lease capability, not merely a signed bearer
    // capability. Check the controller immediately before dispatching to any
    // mutating handler so apply, JSON apply, Git sync, and both revert routes
    // all fail closed through one authorization gate.
    if required_scopes.contains(&"fs.write") {
        authorize_active_write_lease(&state, &claims, &token).await?;
    }

    request.extensions_mut().insert(claims);
    request.extensions_mut().insert(OriginAccessToken { token });
    let mut response = next.run(request).await;
    if authenticated_from_query {
        response.headers_mut().insert(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        );
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store, max-age=0"),
        );
    }
    Ok(response)
}

fn bearer_token_from_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let mut parts = value.split_whitespace();
            match (parts.next(), parts.next(), parts.next()) {
                (Some(scheme), Some(token), None) if scheme.eq_ignore_ascii_case("bearer") => {
                    Some(token.trim().to_string())
                }
                _ => None,
            }
        })
        .filter(|token| !token.is_empty())
}

async fn authorize_active_write_lease(
    state: &AppState,
    claims: &OriginClaims,
    access_token: &str,
) -> Result<(), OriginError> {
    // Explicitly preserve the documented local-development escape hatch.
    if state.config.skip_auth {
        return Ok(());
    }

    let token = access_token.trim();
    if token.is_empty() {
        return Err(OriginError::unauthorized(
            "origin write authorization token is required",
        ));
    }

    let project_id = project_id_for_request(state, claims)?;
    let claimed_lease_id = claims
        .lease_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| OriginError::unauthorized("origin write token is missing its lease"))
        .and_then(|value| {
            Uuid::parse_str(value)
                .map_err(|_| OriginError::unauthorized("origin write token lease is invalid"))
        })?;

    let claimed_runtime_id = claims
        .runtime_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value)
                .map_err(|_| OriginError::unauthorized("origin write token runtime is invalid"))
        })
        .transpose()?;

    let mut url = state.config.controller_base_url.clone();
    url.path_segments_mut()
        .map_err(|_| OriginError::internal("controller base url missing path segments"))?
        .extend(["projects", &project_id.to_string(), "lease"]);

    let response = state
        .http_client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| {
            OriginError::unavailable(format!(
                "workspace lease authorization is unavailable: {error}"
            ))
        })?;
    if !response.status().is_success() {
        return Err(OriginError::unauthorized(format!(
            "controller rejected workspace lease authorization (status {})",
            response.status()
        )));
    }

    let payload = response
        .json::<ActiveWorkspaceLeaseEnvelope>()
        .await
        .map_err(|error| {
            OriginError::unavailable(format!(
                "workspace lease authorization response is invalid: {error}"
            ))
        })?;
    let lease = payload
        .lease
        .ok_or_else(|| OriginError::unauthorized("an active workspace lease is required"))?;

    if lease.lease_id != claimed_lease_id || lease.project_id != project_id {
        return Err(OriginError::unauthorized(
            "workspace lease does not match the origin write token",
        ));
    }
    if lease.expires_at <= Utc::now() {
        return Err(OriginError::unauthorized(
            "workspace lease is no longer active",
        ));
    }

    // When the controller minted a runtime-scoped origin token, preserve that
    // exact runtime binding. User-driven hosted-origin calls may intentionally
    // omit a runtime claim even though the UI recorded its runtime hint on the
    // workspace lease, so absence is not upgraded into a runtime assertion.
    if let Some(claimed_runtime_id) = claimed_runtime_id {
        if lease.runtime_id != Some(claimed_runtime_id) {
            return Err(OriginError::unauthorized(
                "workspace lease runtime does not match the origin write token",
            ));
        }
    }

    let lease_user_id = lease.user_id.ok_or_else(|| {
        OriginError::unauthorized("active workspace lease is missing its user binding")
    })?;
    let claimed_user_id = Uuid::parse_str(claims.sub.trim()).map_err(|_| {
        OriginError::unauthorized("origin write token subject is not a workspace lease user")
    })?;
    if claimed_user_id != lease_user_id {
        return Err(OriginError::unauthorized(
            "workspace lease user does not match the origin write token",
        ));
    }

    Ok(())
}

fn token_from_query(query: Option<&str>) -> Option<String> {
    let query = query?.trim();
    if query.is_empty() {
        return None;
    }

    let parsed = reqwest::Url::parse(&format!("http://localhost/?{query}")).ok()?;
    for (key, value) in parsed.query_pairs() {
        if key == "token" || key == "access_token" {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

async fn handle_entries(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Query(query): Query<EntriesQuery>,
) -> Result<Json<Vec<FileEntryResponse>>, OriginError> {
    let EntriesQuery { path, sync } = query;
    let sync_behavior = match sync
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) if value.eq_ignore_ascii_case("blocking") => {
            WorkspaceSyncBehavior::BlockingForced
        }
        _ => WorkspaceSyncBehavior::RefreshInBackground,
    };
    let project_id = project_id_for_request(&state, &claims)?;
    ensure_workspace_ready(
        &state,
        project_id,
        &["git.read"],
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
        sync_behavior,
    )
    .await?;

    let relative = path.unwrap_or_default();
    let normalized = if relative.trim().is_empty() {
        None
    } else {
        Some(
            normalize_relative_path(&relative)
                .ok_or_else(|| OriginError::bad_request("invalid path"))?,
        )
    };

    if let Some(path) = normalized.as_deref() {
        if is_reserved_path(path) {
            return Err(OriginError::not_found("path not found"));
        }
    }

    let workspace = workspace_dir_for_project(&state, project_id)?;
    if let Some(relative) = normalized.as_deref() {
        match workspace
            .entry_kind(relative)
            .map_err(|_| OriginError::not_found("path not found"))?
        {
            WorkspaceEntryKind::File => {
                let entry = build_file_entry(&workspace, relative)?;
                return Ok(Json(entry));
            }
            WorkspaceEntryKind::Directory => {}
        }
    }

    let entries = list_directory(&workspace, normalized.as_deref())?;
    Ok(Json(entries))
}

async fn handle_file(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    AxumPath(path): AxumPath<String>,
) -> Result<Json<FileContentResponse>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    ensure_workspace_ready(
        &state,
        project_id,
        &["git.read"],
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
        WorkspaceSyncBehavior::RefreshInBackground,
    )
    .await?;

    let normalized = normalize_relative_path(&path)
        .ok_or_else(|| OriginError::bad_request("invalid file path"))?;

    if is_reserved_path(&normalized) {
        return Err(OriginError::not_found("file not found"));
    }

    let workspace = workspace_dir_for_project(&state, project_id)?;
    let file = workspace
        .open_file(&normalized)
        .map_err(|_| OriginError::not_found("file not found"))?;
    let metadata = file
        .metadata()
        .map_err(|_| OriginError::not_found("file not found"))?;
    let mut file = tokio::fs::File::from_std(file);
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .await
        .map_err(|error| OriginError::internal(format!("failed to read file: {error}")))?;

    let base64 = BASE64_STANDARD.encode(&data);
    let mime = mime_type_for_path(&normalized);
    let modified = metadata.modified().ok().map(format_system_time);

    Ok(Json(FileContentResponse {
        path: normalized,
        encoding: "base64".to_string(),
        content_base64: base64,
        size: data.len() as u64,
        mime_type: mime,
        modified,
    }))
}

async fn handle_raw(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    AxumPath(path): AxumPath<String>,
) -> Result<Response, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    ensure_workspace_ready(
        &state,
        project_id,
        &["git.read"],
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
        WorkspaceSyncBehavior::RefreshInBackground,
    )
    .await?;

    let normalized = normalize_relative_path(&path)
        .ok_or_else(|| OriginError::bad_request("invalid file path"))?;

    if is_reserved_path(&normalized) {
        return Err(OriginError::not_found("file not found"));
    }

    let workspace = workspace_dir_for_project(&state, project_id)?;
    let file = workspace
        .open_file(&normalized)
        .map_err(|_| OriginError::not_found("file not found"))?;
    let file = tokio::fs::File::from_std(file);

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let mut response = Response::new(body);
    let mime = mime_type_for_path(&normalized);
    if let Some(mime) = mime.as_deref() {
        if let Ok(value) = mime.parse() {
            response
                .headers_mut()
                .insert(axum::http::header::CONTENT_TYPE, value);
        }
    }
    apply_raw_security_headers(&mut response, &normalized, mime.as_deref());

    Ok(response)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatusResponse {
    supported: bool,
    dirty_count: usize,
    dirty_paths: Vec<git::DirtyPathEntry>,
    dirty_groups: Vec<git::DirtyPathGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_prefix: Option<String>,
    page_offset: usize,
    page_limit: usize,
    has_more_files: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitStatusQuery {
    scope: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GitDiffQuery {
    path: Option<String>,
    commit: Option<String>,
    base: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHistoryQuery {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GitHistoryReviewQuery {
    commit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffResponse {
    supported: bool,
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    diff: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHistoryResponse {
    supported: bool,
    entries: Vec<git::GitHistoryEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    head_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHistoryReviewResponse {
    supported: bool,
    commit: Option<String>,
    entries: Vec<git::DirtyPathEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn handle_git_status(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Query(query): Query<GitStatusQuery>,
) -> Result<Json<GitStatusResponse>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;

    if state
        .config
        .git_remote_url_for_project(project_id)
        .is_none()
    {
        return Ok(Json(GitStatusResponse {
            supported: false,
            dirty_count: 0,
            dirty_paths: Vec::new(),
            dirty_groups: Vec::new(),
            scope_prefix: None,
            page_offset: 0,
            page_limit: query.limit.unwrap_or(100).clamp(1, 200),
            has_more_files: false,
            error: None,
        }));
    }

    let needs_checkout = !has_git_checkout(&state, project_id);

    if needs_checkout {
        let _ = ensure_workspace_ready(
            &state,
            project_id,
            &["git.read"],
            (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
            WorkspaceSyncBehavior::RefreshInBackground,
        )
        .await?;
    }

    // `git status` touches the repo index; ensure we never run it concurrently with a sync
    // (rebase/merge) operation for the same project.
    let apply_lock = project_apply_lock(&state, project_id).await;
    let _guard = match apply_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(Json(GitStatusResponse {
                supported: true,
                dirty_count: 0,
                dirty_paths: Vec::new(),
                dirty_groups: Vec::new(),
                scope_prefix: query.scope.clone(),
                page_offset: query.offset.unwrap_or(0),
                page_limit: query.limit.unwrap_or(100).clamp(1, 200),
                has_more_files: false,
                error: Some(
                    "Workspace is busy applying/syncing changes. Try Refresh in a moment."
                        .to_string(),
                ),
            }));
        }
    };

    let canonical_root = Arc::new(workspace_root);
    let dirty = tokio::task::spawn_blocking(move || {
        let _workspace_guard = try_acquire_workspace_apply_lock(canonical_root.as_path())?
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;
        git::list_dirty_files(canonical_root.as_path(), None)
    })
    .await
    .map_err(|error| OriginError::internal(format!("git status task failed: {error}")));

    match dirty {
        Ok(Ok(entries)) => {
            let view = git::summarize_dirty_files(
                &entries,
                query.scope.as_deref(),
                query.offset.unwrap_or(0),
                query.limit.unwrap_or(100),
            );
            Ok(Json(GitStatusResponse {
                supported: true,
                dirty_count: view.dirty_count,
                dirty_paths: view.dirty_paths,
                dirty_groups: view.dirty_groups,
                scope_prefix: view.scope_prefix,
                page_offset: view.page_offset,
                page_limit: view.page_limit,
                has_more_files: view.has_more_files,
                error: None,
            }))
        }
        Ok(Err(error)) => Ok(Json(GitStatusResponse {
            supported: true,
            dirty_count: 0,
            dirty_paths: Vec::new(),
            dirty_groups: Vec::new(),
            scope_prefix: query.scope.clone(),
            page_offset: query.offset.unwrap_or(0),
            page_limit: query.limit.unwrap_or(100).clamp(1, 200),
            has_more_files: false,
            error: Some(error.to_string()),
        })),
        Err(error) => Err(error),
    }
}

async fn handle_git_diff(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiffResponse>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;

    if state
        .config
        .git_remote_url_for_project(project_id)
        .is_none()
    {
        return Ok(Json(GitDiffResponse {
            supported: false,
            path: None,
            commit: query.commit.clone(),
            diff: String::new(),
            truncated: None,
            error: None,
        }));
    }

    let normalized = match query.path.as_deref().map(str::trim) {
        Some(path) if !path.is_empty() => {
            let normalized = normalize_relative_path(path)
                .ok_or_else(|| OriginError::bad_request("invalid git diff path"))?;
            if is_reserved_path(&normalized) {
                return Err(OriginError::not_found("path not found"));
            }
            Some(normalized)
        }
        _ => None,
    };

    let needs_checkout = !has_git_checkout(&state, project_id);
    if needs_checkout {
        let _ = ensure_workspace_ready(
            &state,
            project_id,
            &["git.read"],
            (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
            WorkspaceSyncBehavior::RefreshInBackground,
        )
        .await?;
    }

    let apply_lock = project_apply_lock(&state, project_id).await;
    let _guard = match apply_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(Json(GitDiffResponse {
                supported: true,
                path: normalized,
                commit: query.commit.clone(),
                diff: String::new(),
                truncated: None,
                error: Some(
                    "Workspace is busy applying/syncing changes. Try again in a moment."
                        .to_string(),
                ),
            }));
        }
    };

    let canonical_root = Arc::new(workspace_root);
    let commit = query.commit.clone();
    let base = query.base.clone();
    let path = normalized.clone();
    let diff_result = tokio::task::spawn_blocking(move || {
        let _workspace_guard = try_acquire_workspace_apply_lock(canonical_root.as_path())?
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;
        match path.as_deref() {
            Some(value) => {
                let commit = commit
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let base = base
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                // A caller-supplied base pins the diff to that run's change (tree-to-tree,
                // correct on snapshot-history origins). When both revs resolve, an empty
                // diff is the truth — the run made no net change to this path — so return
                // it rather than falling back to a parent-based diff that can fabricate a
                // wholly-added rendering. Only invalid/unknown/GC'd revs fall back to the
                // legacy chain so the card still shows something on re-created workspaces.
                if let Some(base) = base {
                    match git::diff_for_path_between(
                        canonical_root.as_path(),
                        base,
                        commit,
                        value,
                        None,
                    ) {
                        Ok(output) => return Ok(output),
                        Err(_) => {}
                    }
                }
                if let Some(commit) = commit {
                    git::diff_for_path_at_commit(canonical_root.as_path(), commit, value, None)
                } else {
                    git::diff_for_path(canonical_root.as_path(), value, None)
                }
            }
            None => Ok(git::GitDiffOutput {
                diff: String::new(),
                truncated: false,
            }),
        }
    })
    .await
    .map_err(|error| OriginError::internal(format!("git diff task failed: {error}")))?;

    match diff_result {
        Ok(output) => Ok(Json(GitDiffResponse {
            supported: true,
            path: normalized,
            commit: query.commit.clone(),
            diff: output.diff,
            truncated: output.truncated.then_some(true),
            error: None,
        })),
        Err(error) => Ok(Json(GitDiffResponse {
            supported: true,
            path: normalized,
            commit: query.commit.clone(),
            diff: String::new(),
            truncated: None,
            error: Some(error.to_string()),
        })),
    }
}

async fn handle_git_history_review(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Query(query): Query<GitHistoryReviewQuery>,
) -> Result<Json<GitHistoryReviewResponse>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;

    let normalized_commit = query.commit.as_deref().map(str::trim).unwrap_or("");
    if normalized_commit.is_empty() {
        return Ok(Json(GitHistoryReviewResponse {
            supported: true,
            commit: None,
            entries: Vec::new(),
            error: Some("missing commit".to_string()),
        }));
    }

    if state
        .config
        .git_remote_url_for_project(project_id)
        .is_none()
    {
        return Ok(Json(GitHistoryReviewResponse {
            supported: false,
            commit: Some(normalized_commit.to_string()),
            entries: Vec::new(),
            error: None,
        }));
    }

    let needs_checkout = !has_git_checkout(&state, project_id);
    if needs_checkout {
        let _ = ensure_workspace_ready(
            &state,
            project_id,
            &["git.read"],
            (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
            WorkspaceSyncBehavior::RefreshInBackground,
        )
        .await?;
    }

    let apply_lock = project_apply_lock(&state, project_id).await;
    let _guard = match apply_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(Json(GitHistoryReviewResponse {
                supported: true,
                commit: Some(normalized_commit.to_string()),
                entries: Vec::new(),
                error: Some(
                    "Workspace is busy applying/syncing changes. Try Refresh in a moment."
                        .to_string(),
                ),
            }));
        }
    };

    let canonical_root = Arc::new(workspace_root);
    let commit = normalized_commit.to_string();
    let review = tokio::task::spawn_blocking(move || {
        let _workspace_guard = try_acquire_workspace_apply_lock(canonical_root.as_path())?
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;
        git::list_commit_files(canonical_root.as_path(), &commit, None)
    })
    .await
    .map_err(|error| OriginError::internal(format!("git history review task failed: {error}")))?;

    match review {
        Ok(entries) => Ok(Json(GitHistoryReviewResponse {
            supported: true,
            commit: Some(normalized_commit.to_string()),
            entries,
            error: None,
        })),
        Err(error) => Ok(Json(GitHistoryReviewResponse {
            supported: true,
            commit: Some(normalized_commit.to_string()),
            entries: Vec::new(),
            error: Some(error.to_string()),
        })),
    }
}

async fn handle_git_history(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Query(query): Query<GitHistoryQuery>,
) -> Result<Json<GitHistoryResponse>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;

    if state
        .config
        .git_remote_url_for_project(project_id)
        .is_none()
    {
        return Ok(Json(GitHistoryResponse {
            supported: false,
            entries: Vec::new(),
            branch: None,
            head_ref: None,
            error: None,
        }));
    }

    let needs_checkout = !has_git_checkout(&state, project_id);
    if needs_checkout {
        let _ = ensure_workspace_ready(
            &state,
            project_id,
            &["git.read"],
            (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
            WorkspaceSyncBehavior::RefreshInBackground,
        )
        .await?;
    }

    let apply_lock = project_apply_lock(&state, project_id).await;
    let _guard = match apply_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(Json(GitHistoryResponse {
                supported: true,
                entries: Vec::new(),
                branch: None,
                head_ref: None,
                error: Some(
                    "Workspace is busy applying/syncing changes. Try Refresh in a moment."
                        .to_string(),
                ),
            }));
        }
    };

    let canonical_root = Arc::new(workspace_root);
    let limit = query.limit.unwrap_or(8).clamp(1, 12);
    let history = tokio::task::spawn_blocking(move || {
        let _workspace_guard = try_acquire_workspace_apply_lock(canonical_root.as_path())?
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;
        let head = git::resolve_history_head_ref(canonical_root.as_path(), None)?;
        let entries = git::list_recent_commits(canonical_root.as_path(), limit, None)?;
        Ok::<_, OriginError>((head, entries))
    })
    .await
    .map_err(|error| OriginError::internal(format!("git history task failed: {error}")))?;

    match history {
        Ok((head, entries)) => Ok(Json(GitHistoryResponse {
            supported: true,
            entries,
            branch: head.branch,
            head_ref: head.head_ref,
            error: None,
        })),
        Err(error) => Ok(Json(GitHistoryResponse {
            supported: true,
            entries: Vec::new(),
            branch: None,
            head_ref: None,
            error: Some(error.to_string()),
        })),
    }
}

async fn handle_apply(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, OriginError> {
    let mut manifest: Option<ApplyManifest> = None;
    let mut archive: Option<ApplyArchive> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| OriginError::bad_request(format!("invalid multipart payload: {error}")))?
    {
        let name = field
            .name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        if name == "manifest" {
            if manifest.is_some() {
                return Err(OriginError::bad_request("duplicate manifest part"));
            }
            let mut field = field;
            let mut bytes = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|error| {
                OriginError::bad_request(format!("manifest read failed: {error}"))
            })? {
                let next_len = bytes
                    .len()
                    .checked_add(chunk.len())
                    .ok_or_else(|| OriginError::bad_request("manifest size overflow"))?;
                if next_len > MAX_APPLY_MANIFEST_BYTES {
                    return Err(OriginError::bad_request("manifest exceeds size limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let parsed: ApplyManifest = serde_json::from_slice(&bytes).map_err(|error| {
                OriginError::bad_request(format!("manifest parse failed: {error}"))
            })?;
            manifest = Some(parsed);
        } else if name == "archive" {
            if archive.is_some() {
                return Err(OriginError::bad_request("duplicate archive part"));
            }
            let std_file = tempfile::tempfile().map_err(|error| {
                OriginError::internal(format!("failed to create archive staging file: {error}"))
            })?;
            let mut staged_file = tokio::fs::File::from_std(std_file);
            let mut field = field;
            let mut archive_size = 0u64;
            while let Some(chunk) = field.chunk().await.map_err(|error| {
                OriginError::bad_request(format!("archive read failed: {error}"))
            })? {
                archive_size = archive_size
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| OriginError::bad_request("archive size overflow"))?;
                if archive_size > state.config.max_archive_bytes {
                    return Err(OriginError::bad_request("archive exceeds size limit"));
                }
                staged_file.write_all(&chunk).await.map_err(|error| {
                    OriginError::internal(format!("archive staging write failed: {error}"))
                })?;
            }
            staged_file.flush().await.map_err(|error| {
                OriginError::internal(format!("archive staging flush failed: {error}"))
            })?;
            staged_file.sync_all().await.map_err(|error| {
                OriginError::internal(format!("archive staging sync failed: {error}"))
            })?;
            archive = Some(ApplyArchive::TempFile {
                file: staged_file.into_std().await,
                size: archive_size,
            });
        } else {
            return Err(OriginError::bad_request(format!(
                "unexpected multipart part {name:?}"
            )));
        }
    }

    let manifest = manifest.ok_or_else(|| OriginError::bad_request("manifest part missing"))?;
    let archive = archive.ok_or_else(|| OriginError::bad_request("archive part missing"))?;

    apply_manifest_archive(state, claims, access_token, manifest, archive).await
}

enum ApplyArchive {
    InMemory(Vec<u8>),
    TempFile { file: std::fs::File, size: u64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyJsonRequest {
    manifest: ApplyManifest,
    archive_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyStatusRequest {
    idempotency_key: String,
    request_fingerprint: Option<String>,
}

async fn handle_apply_status(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Json(payload): Json<ApplyStatusRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let idempotency_key = normalize_apply_idempotency_key(Some(&payload.idempotency_key))?
        .ok_or_else(|| OriginError::bad_request("idempotencyKey is required"))?;
    let request_fingerprint =
        normalize_apply_request_fingerprint(payload.request_fingerprint.as_deref())?;
    let workspace_root = workspace_root_for_project(&state, project_id);
    tokio::fs::create_dir_all(&workspace_root)
        .await
        .map_err(|error| {
            OriginError::internal(format!("failed to create workspace directory: {error}"))
        })?;
    let lookup = tokio::task::spawn_blocking(move || {
        lookup_apply_idempotency(
            &workspace_root,
            &idempotency_key,
            request_fingerprint.as_deref(),
        )
    })
    .await
    .map_err(|error| OriginError::internal(format!("apply status task failed: {error}")))??;

    match lookup {
        None => Err(OriginError::not_found("apply receipt not found")),
        Some(ApplyIdempotencyLookup::Pending) => {
            Ok(Json(serde_json::json!({ "status": "pending" })))
        }
        Some(ApplyIdempotencyLookup::Succeeded(success)) => Ok(Json(serde_json::json!({
            "status": "succeeded",
            "rev": success.rev,
            "baseRev": success.base_rev,
            "fileCount": success.file_count,
            "bytesWritten": success.bytes_written,
        }))),
    }
}

async fn handle_apply_json(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    request: Request,
) -> Result<Json<serde_json::Value>, OriginError> {
    let body = to_bytes(request.into_body(), MAX_APPLY_JSON_REQUEST_BYTES)
        .await
        .map_err(|error| {
            OriginError::bad_request(format!("apply JSON body exceeds size limit: {error}"))
        })?;
    let payload: ApplyJsonRequest = serde_json::from_slice(&body)
        .map_err(|error| OriginError::bad_request(format!("invalid apply JSON: {error}")))?;
    let archive_raw = payload.archive_base64.trim();
    if archive_raw.is_empty() {
        return Err(OriginError::bad_request("archiveBase64 is required"));
    }
    let max_archive_bytes = state
        .config
        .max_archive_bytes
        .min(MAX_APPLY_JSON_ARCHIVE_BYTES);
    let max_encoded_len = max_archive_bytes
        .saturating_add(2)
        .saturating_div(3)
        .saturating_mul(4);
    if archive_raw.len() as u64 > max_encoded_len {
        return Err(OriginError::bad_request("archiveBase64 exceeds size limit"));
    }
    let archive_bytes = BASE64_STANDARD
        .decode(archive_raw)
        .map_err(|error| OriginError::bad_request(format!("archive decode failed: {error}")))?;
    if archive_bytes.len() as u64 > max_archive_bytes {
        return Err(OriginError::bad_request("archive exceeds size limit"));
    }
    apply_manifest_archive(
        state,
        claims,
        access_token,
        payload.manifest,
        ApplyArchive::InMemory(archive_bytes),
    )
    .await
}

async fn apply_manifest_archive(
    state: AppState,
    claims: OriginClaims,
    access_token: OriginAccessToken,
    mut manifest: ApplyManifest,
    archive: ApplyArchive,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let origin_id = origin_id_for_receipt(&state, &claims);
    let config = state.config.clone();
    if let Some(manifest_project) = manifest.project_id.as_deref() {
        if manifest_project.trim() != claims.project_id.trim() {
            return Err(OriginError::bad_request("manifest project mismatch"));
        }
    }
    validate_apply_lease(manifest.lease_id.as_deref(), claims.lease_id.as_deref())?;
    // Everything downstream, including commit receipts, uses the authenticated
    // lease claim rather than caller-controlled manifest metadata.
    manifest.lease_id = claims.lease_id.clone();

    let idempotency_key = normalize_apply_idempotency_key(manifest.idempotency_key.as_deref())?;
    let request_fingerprint =
        normalize_apply_request_fingerprint(manifest.request_fingerprint.as_deref())?;
    if idempotency_key.is_none() && request_fingerprint.is_some() {
        return Err(OriginError::bad_request(
            "requestFingerprint requires idempotencyKey",
        ));
    }

    // Establish only the workspace directory itself before the write-ahead
    // claim. Git fetch/checkout/reset is intentionally deferred into the same
    // guarded blocking closure as apply and commit.
    let workspace_path = workspace_root_for_project(&state, project_id);
    tokio::fs::create_dir_all(&workspace_path)
        .await
        .map_err(|error| {
            OriginError::internal(format!("failed to create workspace directory: {error}"))
        })?;
    let workspace_root = Arc::new(workspace_path);

    let apply_lock = project_apply_lock(&state, project_id).await;
    let apply_guard = apply_lock.lock_owned().await;

    let lock_workspace = workspace_root.clone();
    let workspace_apply_guard = tokio::task::spawn_blocking(move || {
        try_acquire_workspace_apply_lock(lock_workspace.as_path())
    })
    .await
    .map_err(|error| OriginError::internal(format!("workspace lock task failed: {error}")))??
    .ok_or_else(|| OriginError::conflict("workspace is already applying changes"))?;

    let idempotency_claim = if let Some(key) = idempotency_key.as_deref() {
        let receipt_workspace = workspace_root.clone();
        let receipt_key = key.to_string();
        let receipt_fingerprint = request_fingerprint.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            claim_apply_idempotency(
                receipt_workspace.as_path(),
                &receipt_key,
                receipt_fingerprint.as_deref(),
            )
        })
        .await
        .map_err(|error| {
            OriginError::internal(format!("apply idempotency claim task failed: {error}"))
        })??;
        match outcome {
            ApplyIdempotencyClaimOutcome::Acquired(claim) => Some(claim),
            ApplyIdempotencyClaimOutcome::Pending => {
                return Err(OriginError::conflict(
                    "an apply with this idempotencyKey is still pending",
                ));
            }
            ApplyIdempotencyClaimOutcome::Succeeded(success) => {
                return Ok(Json(serde_json::json!({
                    "rev": success.rev,
                    "baseRev": success.base_rev,
                    "fileCount": success.file_count,
                    "bytesWritten": success.bytes_written,
                })));
            }
        }
    } else {
        None
    };

    // Cached success above is deliberately resolved before any controller/Git
    // network dependency. If token minting now fails, the failure is known and
    // the owned pending claim is removed immediately for a clean retry.
    let checkout = if let Some(remote_url) = config.git_remote_url_for_project(project_id) {
        let minted_token = git_tokens::mint_git_access_token(
            &state.http_client,
            config.as_ref(),
            project_id,
            &["git.read"],
            (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
        )
        .await;
        let token = match minted_token {
            Ok(token) => token.map(|minted| minted.token),
            Err(error) => {
                if let Some(claim) = idempotency_claim.as_ref() {
                    if let Err(abort_error) =
                        abort_apply_idempotency_claim(workspace_root.as_path(), claim)
                    {
                        warn!(?abort_error, "failed to abort token-failed apply claim");
                    }
                }
                return Err(error);
            }
        };
        let has_checkout =
            tokio::fs::symlink_metadata(workspace_root.join(".instafy").join(".git"))
                .await
                .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                .unwrap_or(false);
        let mut checkout_config = (*config).clone();
        checkout_config.workspace_root = workspace_root.as_ref().clone();
        checkout_config.git_remote_url = Some(remote_url);
        Some((checkout_config, token, has_checkout))
    } else {
        None
    };

    let auto_commit_after_apply = manifest.auto_commit_after_apply;
    let commit_message = manifest
        .commit_message
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "instafy: apply imported files".to_string());

    let token_for_commit =
        (!access_token.token.trim().is_empty()).then_some(access_token.token.clone());
    let blocking_workspace = workspace_root.clone();
    let (apply_result, apply_base_rev) = tokio::task::spawn_blocking(move || {
        // Both guards live inside the blocking task. Dropping/cancelling the
        // request's JoinHandle detaches this closure but cannot release either
        // lock until apply, commit, and receipt completion have all finished.
        let _apply_guard = apply_guard;
        let _workspace_apply_guard = workspace_apply_guard;
        let operation = (|| -> Result<_, OriginError> {
            // Clear artifacts left by an interrupted earlier apply only while
            // the cross-process workspace lock is held and before this apply
            // creates its rollback snapshot. Cleaning from the commit path
            // would delete the live snapshot needed if that commit fails.
            let _ = git::cleanup_origin_staging(blocking_workspace.as_path());
            if let Some((checkout_config, checkout_token, has_checkout)) = checkout {
                if let Err(error) =
                    git::ensure_git_checkout(&checkout_config, checkout_token.as_deref())
                {
                    if has_checkout {
                        warn!(
                            ?error,
                            "git checkout refresh failed; continuing with existing workspace"
                        );
                    } else {
                        return Err(error);
                    }
                }
            }
            let (mut apply_result, mut apply_transaction) = match archive {
                ApplyArchive::InMemory(archive_bytes) => apply_changes_transactional(
                    &config,
                    blocking_workspace.as_path(),
                    manifest,
                    &archive_bytes,
                )?,
                ApplyArchive::TempFile { file, size } => apply_changes_transactional_file(
                    &config,
                    blocking_workspace.as_path(),
                    manifest,
                    file,
                    size,
                )?,
            };
            let mut apply_base_rev = None;
            if auto_commit_after_apply {
                // HEAD before this apply's own commit: the base for rendering this
                // run's change as a tree-to-tree diff later.
                let base =
                    git::head_rev(blocking_workspace.as_path(), token_for_commit.as_deref());
                let baseline_commit = match git::commit_apply_locally(
                    blocking_workspace.as_path(),
                    &apply_result.applied_paths,
                    &apply_result.deleted_paths,
                    &commit_message,
                    token_for_commit.as_deref(),
                ) {
                    Ok(commit) => commit,
                    Err(error) => {
                        if let Err(rollback_error) = apply_transaction.rollback() {
                            return Err(OriginError::internal(format!(
                                "local apply commit failed ({error}); workspace rollback also failed ({rollback_error})"
                            )));
                        }
                        return Err(error);
                    }
                };
                if let Some(commit_hash) = baseline_commit {
                    apply_base_rev = base.filter(|base| *base != commit_hash);
                    apply_result.rev = commit_hash;
                }
            }
            Ok((apply_result, apply_base_rev, apply_transaction))
        })();
        let (apply_result, apply_base_rev, apply_transaction) = match operation {
            Ok(result) => result,
            Err(error) => {
                if let Some(claim) = idempotency_claim.as_ref() {
                    if let Err(abort_error) =
                        abort_apply_idempotency_claim(blocking_workspace.as_path(), claim)
                    {
                        warn!(?abort_error, "failed to abort known-failed apply claim");
                    }
                }
                return Err(error);
            }
        };
        if let Some(idempotency_claim) = idempotency_claim {
            let success = ApplyIdempotencySuccess {
                rev: apply_result.rev.clone(),
                base_rev: apply_base_rev.clone(),
                file_count: Some(apply_result.file_count),
                bytes_written: Some(apply_result.bytes_written),
            };
            if let Err(error) = complete_apply_idempotency_claim(
                blocking_workspace.as_path(),
                &idempotency_claim,
                &success,
            ) {
                // Receipt replacement can fail after the atomic rename but
                // before its directory fsync. Treat that as ambiguous: retain
                // the committed workspace and pending/succeeded receipt for
                // status/TTL recovery rather than rolling back a possibly
                // published revision or deleting the claim.
                apply_transaction.finish();
                return Err(error);
            }
        }
        apply_transaction.finish();
        Ok::<_, OriginError>((apply_result, apply_base_rev))
    })
    .await
    .map_err(|error| OriginError::internal(format!("apply task failed: {error}")))??;

    if let (Some(url), Some(origin_id)) = (state.commit_receipt_url.clone(), origin_id) {
        let lease_id = claims.lease_id.clone();
        tokio::spawn(post_commit_receipt(
            state.http_client.clone(),
            url,
            state.config.clone(),
            project_id,
            origin_id,
            lease_id,
            Some(claims.sub.clone()),
            apply_result.clone(),
        ));
    }

    Ok(Json(serde_json::json!({
        "rev": apply_result.rev,
        "baseRev": apply_base_rev,
        "fileCount": apply_result.file_count,
        "bytesWritten": apply_result.bytes_written,
    })))
}

fn validate_apply_lease(
    manifest_lease_id: Option<&str>,
    claims_lease_id: Option<&str>,
) -> Result<(), OriginError> {
    let manifest = manifest_lease_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let trusted = claims_lease_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if manifest != trusted {
        return Err(OriginError::unauthorized(
            "manifest leaseId does not match the authenticated lease",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitSyncRequest {
    message: Option<String>,
    paths: Option<Vec<String>>,
    expected_rev: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitRevertRequest {
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitRevertCommitRequest {
    commit: String,
}

/// Check the controller for an active workspace lease held by someone other
/// than this caller. Returns a human-readable reason when the sync should be
/// rejected. Fails open (None) when the controller is unreachable or no
/// credentials are available — the git service's fast-forward-only rule
/// remains the hard backstop.
async fn active_lease_blocks_sync(
    state: &AppState,
    project_id: uuid::Uuid,
    claims_lease_id: Option<&str>,
    fallback_token: Option<&str>,
) -> Option<String> {
    let token = state
        .config
        .controller_internal_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            fallback_token
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })?;

    let mut url = state.config.controller_base_url.clone();
    url.path_segments_mut()
        .ok()?
        .extend(["projects", &project_id.to_string(), "lease"]);

    let response = state
        .http_client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload = response.json::<serde_json::Value>().await.ok()?;
    let lease = payload.get("lease")?;
    if lease.is_null() {
        return None;
    }
    let lease_id = lease.get("leaseId").and_then(|value| value.as_str())?;
    if let Some(claimed) = claims_lease_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if claimed.eq_ignore_ascii_case(lease_id) {
            return None;
        }
    }
    let expires_at = lease
        .get("expiresAt")
        .and_then(|value| value.as_str())
        .unwrap_or("soon");
    Some(format!(
        "workspace is locked by another active session (lease {lease_id}, expires {expires_at}); retry shortly or save from that session"
    ))
}

/// Forward-revert a commit that already landed on canonical `main` and push
/// the revert. Never rewrites history; mirrors /git/sync semantics (409 on
/// conflict, commit receipt on success).
async fn handle_git_revert_commit(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Json(payload): Json<GitRevertCommitRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let origin_id = origin_id_for_receipt(&state, &claims);
    let apply_lock = project_apply_lock(&state, project_id).await;
    let apply_guard = apply_lock.lock_owned().await;

    let config = state.config.clone();
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;
    let lock_workspace = workspace_root.clone();
    let workspace_apply_guard =
        tokio::task::spawn_blocking(move || try_acquire_workspace_apply_lock(&lock_workspace))
            .await
            .map_err(|error| {
                OriginError::internal(format!("workspace lock task failed: {error}"))
            })??
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;

    let remote_url = config
        .git_remote_url_for_project(project_id)
        .ok_or_else(|| OriginError::bad_request("git remote is not configured for this project"))?;

    if let Some(reason) = active_lease_blocks_sync(
        &state,
        project_id,
        claims.lease_id.as_deref(),
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
    )
    .await
    {
        return Err(OriginError::conflict(reason));
    }

    let token = git_tokens::mint_git_access_token(
        &state.http_client,
        config.as_ref(),
        project_id,
        &["git.read", "git.write"],
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
    )
    .await?
    .map(|minted| minted.token);

    let mut config_clone = (*config).clone();
    config_clone.workspace_root = workspace_root.clone();
    config_clone.git_remote_url = Some(remote_url);

    let canonical_root = Arc::new(workspace_root);
    let target_commit = payload.commit.clone();
    let commit_hash = tokio::task::spawn_blocking(move || {
        let _apply_guard = apply_guard;
        let _workspace_apply_guard = workspace_apply_guard;
        git::ensure_git_checkout(&config_clone, token.as_deref())?;
        git::revert_commit_and_push(
            &config_clone,
            canonical_root.as_path(),
            &target_commit,
            token.as_deref(),
        )
    })
    .await
    .map_err(|error| OriginError::internal(format!("git revert task failed: {error}")))??;

    let summary = ApplySummary {
        rev: commit_hash.clone(),
        bytes_written: 0,
        file_count: 0,
        lease_id: claims.lease_id.clone(),
        applied_paths: Vec::new(),
        deleted_paths: Vec::new(),
    };

    if let (Some(url), Some(origin_id)) = (state.commit_receipt_url.clone(), origin_id) {
        tokio::spawn(post_commit_receipt(
            state.http_client.clone(),
            url,
            state.config.clone(),
            project_id,
            origin_id,
            claims.lease_id.clone(),
            Some(claims.sub.clone()),
            summary,
        ));
    }

    Ok(Json(serde_json::json!({
        "rev": commit_hash,
    })))
}

async fn handle_git_revert(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Json(payload): Json<GitRevertRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;

    let config = state.config.clone();
    let remote_url = config
        .git_remote_url_for_project(project_id)
        .ok_or_else(|| OriginError::bad_request("git remote is not configured for this project"))?;

    let mut paths = Vec::new();
    for path in payload.paths {
        let normalized_path = normalize_relative_path(&path)
            .ok_or_else(|| OriginError::bad_request("invalid git revert path"))?;
        if normalized_path == ".instafy"
            || normalized_path.starts_with(".instafy/")
            || is_reserved_path(&normalized_path)
        {
            return Err(OriginError::not_found("path not found"));
        }
        paths.push(normalized_path);
    }

    let apply_lock = project_apply_lock(&state, project_id).await;
    let apply_guard = apply_lock.lock_owned().await;
    let lock_workspace = workspace_root.clone();
    let workspace_apply_guard =
        tokio::task::spawn_blocking(move || try_acquire_workspace_apply_lock(&lock_workspace))
            .await
            .map_err(|error| {
                OriginError::internal(format!("workspace lock task failed: {error}"))
            })??
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;

    let token = git_tokens::mint_git_access_token(
        &state.http_client,
        config.as_ref(),
        project_id,
        &["git.read"],
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
    )
    .await?
    .map(|minted| minted.token);
    let mut config_clone = (*config).clone();
    config_clone.workspace_root = workspace_root.clone();
    config_clone.git_remote_url = Some(remote_url);

    let canonical_root = Arc::new(workspace_root);
    let revert_paths = paths.clone();
    let revert_result = tokio::task::spawn_blocking(move || {
        let _apply_guard = apply_guard;
        let _workspace_apply_guard = workspace_apply_guard;
        git::ensure_git_checkout(&config_clone, token.as_deref())?;
        git::revert_paths(canonical_root.as_path(), &revert_paths, token.as_deref())
    })
    .await
    .map_err(|error| OriginError::internal(format!("git revert task failed: {error}")))?;

    match revert_result {
        Ok(summary) => Ok(Json(serde_json::json!({
            "ok": true,
            "reverted": summary.reverted,
            "removed": summary.removed,
        }))),
        Err(error) => Err(error),
    }
}

async fn handle_git_sync(
    State(state): State<AppState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(access_token): Extension<OriginAccessToken>,
    Json(payload): Json<GitSyncRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project_id = project_id_for_request(&state, &claims)?;
    let origin_id = origin_id_for_receipt(&state, &claims);
    let apply_lock = project_apply_lock(&state, project_id).await;
    let apply_guard = apply_lock.lock_owned().await;

    let config = state.config.clone();
    let workspace_root = workspace_root_for_project(&state, project_id);
    ensure_workspace_dir_for_project(&state, project_id)?;
    let lock_workspace = workspace_root.clone();
    let workspace_apply_guard =
        tokio::task::spawn_blocking(move || try_acquire_workspace_apply_lock(&lock_workspace))
            .await
            .map_err(|error| {
                OriginError::internal(format!("workspace lock task failed: {error}"))
            })??
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;

    let remote_url = config
        .git_remote_url_for_project(project_id)
        .ok_or_else(|| OriginError::bad_request("git remote is not configured for this project"))?;

    if let Some(reason) = active_lease_blocks_sync(
        &state,
        project_id,
        claims.lease_id.as_deref(),
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
    )
    .await
    {
        return Err(OriginError::conflict(reason));
    }

    let token = git_tokens::mint_git_access_token(
        &state.http_client,
        config.as_ref(),
        project_id,
        &["git.read", "git.write"],
        (!access_token.token.trim().is_empty()).then_some(access_token.token.as_str()),
    )
    .await?
    .map(|minted| minted.token);

    let GitSyncRequest {
        message: message_override,
        paths,
        expected_rev,
    } = payload;

    if expected_rev.is_some() && paths.is_some() {
        return Err(OriginError::bad_request(
            "expectedRev cannot be combined with paths",
        ));
    }

    let selected_paths = if let Some(paths) = paths {
        let mut normalized = Vec::new();
        for path in paths {
            let normalized_path = normalize_relative_path(&path)
                .ok_or_else(|| OriginError::bad_request("invalid git sync path"))?;
            normalized.push(normalized_path);
        }
        Some(normalized)
    } else {
        None
    };

    let message =
        message_override.unwrap_or_else(|| format!("instafy: sync (user {})", claims.sub));

    let mut config_clone = (*config).clone();
    config_clone.workspace_root = workspace_root.clone();
    config_clone.git_remote_url = Some(remote_url);

    let canonical_root = Arc::new(workspace_root);
    let (base_rev, commit_hash) = tokio::task::spawn_blocking(move || {
        let _apply_guard = apply_guard;
        let _workspace_apply_guard = workspace_apply_guard;
        if let Some(expected_rev) = expected_rev {
            let base = git::head_rev(canonical_root.as_path(), token.as_deref());
            let commit = git::push_existing_head(
                &config_clone,
                canonical_root.as_path(),
                &expected_rev,
                token.as_deref(),
            )?;
            Ok::<_, OriginError>((base, commit))
        } else {
            git::ensure_git_checkout(&config_clone, token.as_deref())?;
            // HEAD before this sync's own commit: the base for rendering the synced
            // change as a tree-to-tree diff later.
            let base = git::head_rev(canonical_root.as_path(), token.as_deref());
            let commit = match selected_paths {
                Some(paths) => git::commit_and_push_paths(
                    &config_clone,
                    canonical_root.as_path(),
                    &paths,
                    &message,
                    token.as_deref(),
                ),
                None => git::commit_and_push_dirty(
                    &config_clone,
                    canonical_root.as_path(),
                    &message,
                    token.as_deref(),
                ),
            }?;
            Ok::<_, OriginError>((base, commit))
        }
    })
    .await
    .map_err(|error| OriginError::internal(format!("git sync task failed: {error}")))??;
    let base_rev = base_rev.filter(|base| *base != commit_hash);

    let summary = ApplySummary {
        rev: commit_hash.clone(),
        bytes_written: 0,
        file_count: 0,
        lease_id: claims.lease_id.clone(),
        applied_paths: Vec::new(),
        deleted_paths: Vec::new(),
    };

    if let (Some(url), Some(origin_id)) = (state.commit_receipt_url.clone(), origin_id) {
        tokio::spawn(post_commit_receipt(
            state.http_client.clone(),
            url,
            state.config.clone(),
            project_id,
            origin_id,
            claims.lease_id.clone(),
            Some(claims.sub.clone()),
            summary,
        ));
    }

    Ok(Json(serde_json::json!({
        "rev": commit_hash,
        "baseRev": base_rev,
    })))
}

async fn post_commit_receipt(
    client: reqwest::Client,
    url: reqwest::Url,
    config: Arc<ServerConfig>,
    project_id: Uuid,
    origin_id: Uuid,
    lease_id: Option<String>,
    user_id: Option<String>,
    summary: ApplySummary,
) {
    let Some(token) = config.controller_internal_token.clone() else {
        return;
    };

    let payload = serde_json::json!({
        "projectId": project_id,
        "originId": origin_id,
        "leaseId": lease_id,
        "userId": user_id,
        "rev": summary.rev,
        "bytesWritten": summary.bytes_written,
        "fileCount": summary.file_count,
        "durationMs": null,
        "metadata": null,
    });

    let request = client.post(url).bearer_auth(token).json(&payload);

    if let Err(error) = request.send().await {
        warn!(?error, "commit receipt request failed");
    }
}

fn project_id_for_request(state: &AppState, claims: &OriginClaims) -> Result<Uuid, OriginError> {
    if state.config.multi_tenant {
        return Uuid::parse_str(claims.project_id.trim())
            .map_err(|_| OriginError::unauthorized("invalid project id"));
    }
    Ok(state.config.project_id)
}

fn origin_id_for_receipt(state: &AppState, claims: &OriginClaims) -> Option<Uuid> {
    if !state.config.multi_tenant {
        return Some(state.config.origin_id);
    }
    let raw = claims.origin_id.as_deref()?.trim();
    Uuid::parse_str(raw).ok()
}

fn workspace_root_for_project(state: &AppState, project_id: Uuid) -> PathBuf {
    if state.config.multi_tenant {
        state.workspace_root.join(project_id.to_string())
    } else {
        state.workspace_root.as_ref().clone()
    }
}

fn workspace_dir_for_project(
    state: &AppState,
    project_id: Uuid,
) -> Result<WorkspaceDir, OriginError> {
    if state.config.multi_tenant {
        state
            .workspace_fs
            .open_dir(&project_id.to_string())
            .map_err(|_| OriginError::not_found("workspace not found"))
    } else {
        Ok(state.workspace_fs.clone())
    }
}

fn ensure_workspace_dir_for_project(
    state: &AppState,
    project_id: Uuid,
) -> Result<WorkspaceDir, OriginError> {
    if state.config.multi_tenant {
        state
            .workspace_fs
            .create_dir_all(&project_id.to_string())
            .map_err(|error| {
                OriginError::internal(format!("failed to create workspace directory: {error}"))
            })
    } else {
        Ok(state.workspace_fs.clone())
    }
}

fn has_git_checkout(state: &AppState, project_id: Uuid) -> bool {
    workspace_dir_for_project(state, project_id)
        .and_then(|workspace| {
            workspace
                .entry_kind(".instafy/.git")
                .map_err(|_| OriginError::not_found("git checkout not found"))
        })
        .is_ok_and(|kind| kind == WorkspaceEntryKind::Directory)
}

async fn project_apply_lock(state: &AppState, project_id: Uuid) -> Arc<Mutex<()>> {
    let mut locks = state.apply_locks.lock().await;
    locks
        .entry(project_id)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

async fn ensure_workspace_ready(
    state: &AppState,
    project_id: Uuid,
    git_scopes: &[&str],
    origin_access_token: Option<&str>,
    sync_behavior: WorkspaceSyncBehavior,
) -> Result<PathBuf, OriginError> {
    let workspace_root = workspace_root_for_project(state, project_id);

    ensure_workspace_dir_for_project(state, project_id)?;

    let Some(remote_url) = state.config.git_remote_url_for_project(project_id) else {
        return Ok(workspace_root);
    };

    let sync_ttl = Duration::from_secs(GIT_WORKSPACE_SYNC_TTL_SECONDS);
    let now = Instant::now();
    let git_scopes_owned: Vec<String> = git_scopes
        .iter()
        .map(|scope| (*scope).to_string())
        .collect();

    let force_sync = matches!(sync_behavior, WorkspaceSyncBehavior::BlockingForced);
    let needs_sync = {
        let guard = state.git_last_sync.lock().await;
        match guard.get(&project_id) {
            Some(last) => now.duration_since(*last) >= sync_ttl,
            None => true,
        }
    };

    if !needs_sync && !force_sync {
        return Ok(workspace_root);
    }

    let has_checkout = has_git_checkout(state, project_id);

    if has_checkout && matches!(sync_behavior, WorkspaceSyncBehavior::RefreshInBackground) {
        let apply_lock = project_apply_lock(state, project_id).await;
        if apply_lock.try_lock().is_ok() {
            {
                let mut guard = state.git_last_sync.lock().await;
                guard.insert(project_id, now);
            }

            let state_clone = state.clone();
            let workspace_root_clone = workspace_root.clone();
            let remote_url_clone = remote_url.clone();
            let token_clone = origin_access_token.map(|token| token.to_string());
            let scopes_clone = git_scopes_owned.clone();

            tokio::spawn(async move {
                let _guard = apply_lock.lock().await;
                if let Err(error) = refresh_git_checkout(
                    &state_clone,
                    project_id,
                    workspace_root_clone,
                    remote_url_clone,
                    scopes_clone,
                    token_clone,
                    true,
                    Instant::now(),
                )
                .await
                {
                    warn!(?error, %project_id, "background workspace git refresh failed");
                }
            });
        }

        return Ok(workspace_root);
    }

    let apply_lock = project_apply_lock(state, project_id).await;
    let _guard = apply_lock.lock().await;

    let needs_sync = {
        let guard = state.git_last_sync.lock().await;
        match guard.get(&project_id) {
            Some(last) => now.duration_since(*last) >= sync_ttl,
            None => true,
        }
    };

    if !needs_sync && !force_sync {
        return Ok(workspace_root);
    }

    refresh_git_checkout(
        state,
        project_id,
        workspace_root.clone(),
        remote_url,
        git_scopes_owned,
        origin_access_token.map(|token| token.to_string()),
        has_checkout,
        now,
    )
    .await?;

    Ok(workspace_root)
}

async fn refresh_git_checkout(
    state: &AppState,
    project_id: Uuid,
    workspace_root: PathBuf,
    remote_url: String,
    git_scopes: Vec<String>,
    origin_access_token: Option<String>,
    has_checkout: bool,
    now: Instant,
) -> Result<(), OriginError> {
    if has_checkout {
        let workspace = workspace_dir_for_project(state, project_id)?;
        let operation_in_progress = [
            ".instafy/.git/rebase-apply",
            ".instafy/.git/rebase-merge",
            ".instafy/.git/MERGE_HEAD",
            ".instafy/.git/CHERRY_PICK_HEAD",
            ".instafy/.git/REVERT_HEAD",
        ]
        .iter()
        .any(|path| workspace.entry_kind(path).is_ok());
        if operation_in_progress {
            let mut guard = state.git_last_sync.lock().await;
            guard.insert(project_id, now);
            return Ok(());
        }
    }

    let git_scope_refs: Vec<&str> = git_scopes.iter().map(String::as_str).collect();
    let token = git_tokens::mint_git_access_token(
        &state.http_client,
        state.config.as_ref(),
        project_id,
        &git_scope_refs,
        origin_access_token.as_deref(),
    )
    .await?
    .map(|minted| minted.token);

    let mut config_clone = (*state.config).clone();
    config_clone.workspace_root = workspace_root.clone();
    config_clone.git_remote_url = Some(remote_url);

    let checkout_result = tokio::task::spawn_blocking(move || {
        let _workspace_guard = try_acquire_workspace_apply_lock(&workspace_root)?
            .ok_or_else(|| OriginError::conflict("workspace is already mutating"))?;
        git::ensure_git_checkout(&config_clone, token.as_deref())
    })
    .await
    .map_err(|error| OriginError::internal(format!("git checkout task failed: {error}")))?;

    if let Err(error) = checkout_result {
        if has_checkout {
            warn!(
                ?error,
                "git checkout refresh failed; continuing with existing workspace"
            );
            let mut guard = state.git_last_sync.lock().await;
            guard.insert(project_id, now);
            return Ok(());
        }
        return Err(error);
    }

    let mut guard = state.git_last_sync.lock().await;
    guard.insert(project_id, now);
    Ok(())
}

fn list_directory(
    workspace: &WorkspaceDir,
    relative: Option<&str>,
) -> Result<Vec<FileEntryResponse>, OriginError> {
    let mut entries = Vec::new();
    let listed = workspace
        .list(relative)
        .map_err(|error| OriginError::internal(format!("failed to list directory: {error}")))?;

    for child in listed {
        let name = child.name;
        let name_str = name.to_string_lossy().to_string();

        let child_relative = if let Some(rel) = relative {
            format!("{}/{}", rel, name_str)
        } else {
            name_str.clone()
        };

        if is_reserved_path(&child_relative) {
            continue;
        }

        if child.kind == WorkspaceEntryKind::Directory {
            entries.push(FileEntryResponse {
                name: name_str,
                path: child_relative,
                kind: "directory".to_string(),
                size: None,
                modified: None,
                extension: None,
                has_children: child.has_children,
                mime_type: None,
            });
        } else if let Some(metadata) = child.metadata {
            entries.push(file_entry_from_metadata(name_str, child_relative, metadata));
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

fn build_file_entry(
    workspace: &WorkspaceDir,
    relative: &str,
) -> Result<Vec<FileEntryResponse>, OriginError> {
    let file = workspace
        .open_file(relative)
        .map_err(|_| OriginError::not_found("file not found"))?;
    let metadata = file
        .metadata()
        .map_err(|_| OriginError::not_found("file not found"))?;

    Ok(vec![file_entry_from_metadata(
        Path::new(relative)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| relative.to_string()),
        relative.to_string(),
        metadata,
    )])
}

fn file_entry_from_metadata(
    name: String,
    relative: String,
    metadata: Metadata,
) -> FileEntryResponse {
    let extension = Path::new(&relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_string());
    let modified = metadata.modified().ok().map(format_system_time);

    FileEntryResponse {
        name,
        path: relative,
        kind: "file".to_string(),
        size: Some(metadata.len()),
        modified,
        extension: extension.clone(),
        has_children: false,
        mime_type: extension.and_then(|ext| mime_type_for_extension(&ext)),
    }
}

fn apply_raw_security_headers(response: &mut Response, relative: &str, mime: Option<&str>) {
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    if is_active_raw_content(relative, mime) {
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
    }
}

fn is_active_raw_content(relative: &str, mime: Option<&str>) -> bool {
    let active_mime = matches!(
        mime.unwrap_or_default(),
        "text/html"
            | "image/svg+xml"
            | "text/javascript"
            | "application/javascript"
            | "text/css"
            | "application/xml"
            | "text/xml"
            | "application/xhtml+xml"
            | "application/pdf"
    );
    let active_extension = Path::new(relative)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "html" | "htm" | "xhtml" | "svg" | "xml" | "js" | "mjs" | "cjs" | "css" | "pdf"
            )
        });
    active_mime || active_extension
}

fn mime_type_for_path(relative: &str) -> Option<String> {
    let ext = Path::new(relative)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_string());
    ext.and_then(|e| mime_type_for_extension(&e))
}

fn mime_type_for_extension(ext: &str) -> Option<String> {
    let mime = match ext.to_ascii_lowercase().as_str() {
        "txt" => "text/plain",
        "md" | "mdx" => "text/markdown",
        "json" => "application/json",
        "ts" | "tsx" => "text/typescript",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "html" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Some(mime.to_string())
}

fn format_system_time(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::process::Command;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use axum::http::{HeaderMap, StatusCode as AxumStatusCode};
    use axum::routing::get;
    use axum::{Json, Router};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    use reqwest::StatusCode;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::json;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use uuid::Uuid;
    use zip::write::{FileOptions, ZipWriter};

    use super::{
        apply_raw_security_headers, authorize_active_write_lease, mime_type_for_extension,
        mime_type_for_path, validate_apply_lease, AppState, GitSyncRequest,
    };
    use crate::apply_idempotency::{
        claim_apply_idempotency, complete_apply_idempotency_claim, ApplyIdempotencyClaimOutcome,
        ApplyIdempotencySuccess,
    };
    use crate::auth::{OriginClaims, TokenValidator};
    use crate::config::ServerConfig;

    fn run_test_git(workspace: &std::path::Path, args: &[&str]) -> std::process::Output {
        let output = Command::new("git")
            .current_dir(workspace)
            .args(args)
            .output()
            .expect("run test git command");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    fn run_test_instafy_git(workspace: &std::path::Path, args: &[&str]) -> std::process::Output {
        let mut command = Command::new("git");
        command
            .current_dir(workspace)
            .arg("--git-dir")
            .arg(workspace.join(".instafy/.git"))
            .arg("--work-tree")
            .arg(workspace)
            .args(args);
        let output = command.output().expect("run test Instafy git command");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    #[test]
    fn git_sync_request_parses_optional_expected_rev_in_camel_case() {
        let legacy: GitSyncRequest = serde_json::from_value(json!({
            "message": "sync",
            "paths": ["README.md"]
        }))
        .unwrap();
        assert_eq!(legacy.expected_rev, None);

        let exact: GitSyncRequest = serde_json::from_value(json!({
            "expectedRev": "0123456789abcdef0123456789abcdef01234567"
        }))
        .unwrap();
        assert_eq!(
            exact.expected_rev.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
    }

    #[test]
    fn apply_lease_must_match_authenticated_claim_exactly() {
        assert!(validate_apply_lease(None, None).is_ok());
        assert!(validate_apply_lease(Some("lease-1"), Some("lease-1")).is_ok());
        assert!(validate_apply_lease(Some("lease-1"), Some("lease-2")).is_err());
        assert!(validate_apply_lease(Some("lease-1"), None).is_err());
        assert!(validate_apply_lease(None, Some("lease-1")).is_err());
    }

    #[tokio::test]
    async fn cached_apply_replay_does_not_require_git_or_controller_network() {
        let workspace = TempDir::new().unwrap();
        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let key = "github-import-v1:cached-before-network";
        let fingerprint = "sha256:cached-before-network";
        let ApplyIdempotencyClaimOutcome::Acquired(claim) =
            claim_apply_idempotency(workspace.path(), key, Some(fingerprint)).unwrap()
        else {
            panic!("seed claim should be acquired");
        };
        complete_apply_idempotency_claim(
            workspace.path(),
            &claim,
            &ApplyIdempotencySuccess {
                rev: "cached-rev".to_string(),
                base_rev: Some("cached-base".to_string()),
                file_count: Some(1),
                bytes_written: Some(10),
            },
        )
        .unwrap();
        drop(claim);

        let config = Arc::new(ServerConfig {
            project_id,
            origin_id,
            workspace_root: workspace.path().to_path_buf(),
            git_remote_url: Some("https://example.invalid/private.git".to_string()),
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "test@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1".parse().unwrap(),
            controller_internal_token: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().unwrap(),
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 1024,
            staging_base: None,
            multi_tenant: false,
        });
        let client = reqwest::Client::new();
        let state = AppState::new(
            config.clone(),
            TokenValidator::new(client.clone(), config.jwks_url.clone()),
            client,
            workspace.path().to_path_buf(),
            None,
        )
        .expect("open workspace root");
        let claims = crate::auth::OriginClaims {
            aud: origin_id.to_string(),
            sub: "cached-user".to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: None,
            protocol: Some("http".to_string()),
            scopes: vec!["fs.write".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            iat: None,
            exp: None,
            jti: None,
            actor_label: None,
            browser_session_id: None,
        };
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            super::apply_manifest_archive(
                state,
                claims,
                super::OriginAccessToken {
                    token: "unreachable-controller-token".to_string(),
                },
                super::ApplyManifest {
                    project_id: Some(project_id.to_string()),
                    lease_id: None,
                    files: Vec::new(),
                    deletes: Vec::new(),
                    generated_at: None,
                    source_device_id: None,
                    auto_commit_after_apply: true,
                    commit_message: None,
                    idempotency_key: Some(key.to_string()),
                    request_fingerprint: Some(fingerprint.to_string()),
                },
                super::ApplyArchive::InMemory(Vec::new()),
            ),
        )
        .await
        .expect("cached replay should not wait on network")
        .expect("cached replay should succeed");
        assert_eq!(response.0["rev"], "cached-rev");
    }

    #[tokio::test]
    async fn apply_route_restores_existing_file_when_local_commit_fails() {
        let workspace = TempDir::new().expect("workspace");
        let workspace_path = workspace.path();
        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let original = b"original\0private bytes\n";
        let replacement = b"replacement bytes that must be rolled back\n";

        run_test_git(workspace_path, &["init", "-b", "main"]);
        run_test_git(
            workspace_path,
            &["config", "user.name", "Instafy Route Test"],
        );
        run_test_git(
            workspace_path,
            &["config", "user.email", "route-test@instafy.dev"],
        );
        std::fs::write(workspace_path.join("existing.bin"), original).expect("seed existing file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                workspace_path.join("existing.bin"),
                std::fs::Permissions::from_mode(0o640),
            )
            .expect("set seed permissions");
        }
        run_test_git(workspace_path, &["add", "existing.bin"]);
        run_test_git(workspace_path, &["commit", "-m", "seed existing file"]);
        std::fs::create_dir_all(workspace_path.join(".instafy")).expect("create Instafy dir");
        std::fs::rename(
            workspace_path.join(".git"),
            workspace_path.join(".instafy/.git"),
        )
        .expect("move git metadata");

        let head_before = run_test_instafy_git(workspace_path, &["rev-parse", "HEAD"]).stdout;
        #[cfg(unix)]
        let mode_before = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(workspace_path.join("existing.bin"))
                .expect("seed metadata")
                .permissions()
                .mode()
        };

        // A held index lock deterministically injects a local commit failure
        // after the route has installed the replacement over an existing file.
        std::fs::write(workspace_path.join(".instafy/.git/index.lock"), b"held")
            .expect("inject commit failure");

        let mut archive_writer = ZipWriter::new(Cursor::new(Vec::new()));
        archive_writer
            .start_file("existing.bin", FileOptions::<()>::default())
            .expect("start replacement archive entry");
        archive_writer
            .write_all(replacement)
            .expect("write replacement archive entry");
        let archive = archive_writer
            .finish()
            .expect("finish archive")
            .into_inner();

        let config = Arc::new(ServerConfig {
            project_id,
            origin_id,
            workspace_root: workspace_path.to_path_buf(),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "test@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1".parse().expect("controller url"),
            controller_internal_token: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().expect("jwks url"),
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 16 * 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        });
        let client = reqwest::Client::new();
        let state = AppState::new(
            config.clone(),
            TokenValidator::new(client.clone(), config.jwks_url.clone()),
            client.clone(),
            workspace_path.to_path_buf(),
            None,
        )
        .expect("open workspace root");
        let app = super::router(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind origin route test");
        let address = listener.local_addr().expect("origin route test address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve origin route test");
        });

        let response = client
            .post(format!("http://{address}/apply-json"))
            .json(&json!({
                "manifest": {
                    "projectId": project_id,
                    "files": [{ "path": "existing.bin", "size": replacement.len() }],
                    "deletes": [],
                    "autoCommitAfterApply": true,
                    "commitMessage": "test: injected route commit failure",
                },
                "archiveBase64": base64::engine::general_purpose::STANDARD.encode(archive),
            }))
            .send()
            .await
            .expect("apply route request");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        assert_eq!(
            std::fs::read(workspace_path.join("existing.bin")).expect("restored existing file"),
            original
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(workspace_path.join("existing.bin"))
                    .expect("restored metadata")
                    .permissions()
                    .mode(),
                mode_before
            );
        }

        std::fs::remove_file(workspace_path.join(".instafy/.git/index.lock"))
            .expect("release injected index lock");
        assert_eq!(
            run_test_instafy_git(workspace_path, &["rev-parse", "HEAD"]).stdout,
            head_before
        );
        assert!(
            run_test_instafy_git(
                workspace_path,
                &["status", "--porcelain", "--untracked-files=no"]
            )
            .stdout
            .is_empty(),
            "failed apply must leave the original worktree and index clean"
        );

        server.abort();
    }

    #[test]
    fn mime_type_for_extension_matches_known_types() {
        assert_eq!(
            mime_type_for_extension("ts").as_deref(),
            Some("text/typescript")
        );
        assert_eq!(
            mime_type_for_extension("json").as_deref(),
            Some("application/json")
        );
        assert_eq!(mime_type_for_extension("png").as_deref(), Some("image/png"));
    }

    #[test]
    fn mime_type_for_path_falls_back_to_octet_stream() {
        assert_eq!(
            mime_type_for_path("assets/logo.svg"),
            Some("image/svg+xml".to_string())
        );
        assert_eq!(
            mime_type_for_path("downloads/archive.bin"),
            Some("application/octet-stream".to_string())
        );
        assert_eq!(mime_type_for_path("LICENSE"), None);
    }

    #[test]
    fn raw_responses_apply_browser_isolation_headers() {
        let mut active = axum::response::Response::new(axum::body::Body::empty());
        apply_raw_security_headers(&mut active, "preview/index.html", Some("text/html"));
        let headers = active.headers();
        assert_eq!(
            headers
                .get("content-security-policy")
                .and_then(|value| value.to_str().ok()),
            Some("sandbox; default-src 'none'; base-uri 'none'; form-action 'none'")
        );
        assert_eq!(
            headers
                .get("x-content-type-options")
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            headers
                .get("referrer-policy")
                .and_then(|value| value.to_str().ok()),
            Some("no-referrer")
        );
        assert!(headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("no-store")));
        assert_eq!(
            headers
                .get("content-disposition")
                .and_then(|value| value.to_str().ok()),
            Some("attachment")
        );

        let mut passive = axum::response::Response::new(axum::body::Body::empty());
        apply_raw_security_headers(&mut passive, "assets/logo.png", Some("image/png"));
        assert!(passive.headers().get("content-disposition").is_none());
        assert_eq!(
            passive
                .headers()
                .get("x-content-type-options")
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
    }

    fn origin_token(
        private_key_der: &[u8],
        project_id: Uuid,
        origin_id: Uuid,
        scopes: &[&str],
    ) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after unix epoch")
            .as_secs();
        let header = Header {
            kid: Some("browser-scope-test".to_string()),
            alg: Algorithm::EdDSA,
            ..Header::default()
        };
        let claims = json!({
            "aud": origin_id.to_string(),
            "sub": "browser-scope-test-user",
            "project_id": project_id.to_string(),
            "origin_id": origin_id.to_string(),
            "protocol": "http",
            "scopes": scopes,
            "iat": now,
            "exp": now + 600,
            "jti": Uuid::new_v4().to_string(),
        });
        let private_pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(private_key_der)
        );
        let key = EncodingKey::from_ed_pem(private_pem.as_bytes()).expect("encoding key");
        jsonwebtoken::encode(&header, &claims, &key).expect("sign origin token")
    }

    fn origin_write_token(
        private_key_der: &[u8],
        project_id: Uuid,
        origin_id: Uuid,
        user_id: Uuid,
        lease_id: Uuid,
        runtime_id: Option<Uuid>,
    ) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after unix epoch")
            .as_secs();
        let header = Header {
            kid: Some("browser-scope-test".to_string()),
            alg: Algorithm::EdDSA,
            ..Header::default()
        };
        let claims = json!({
            "aud": origin_id.to_string(),
            "sub": user_id.to_string(),
            "project_id": project_id.to_string(),
            "origin_id": origin_id.to_string(),
            "runtime_id": runtime_id.map(|value| value.to_string()),
            "protocol": "http",
            "scopes": ["fs.write"],
            "lease_id": lease_id.to_string(),
            "iat": now,
            "exp": now + 600,
            "jti": Uuid::new_v4().to_string(),
        });
        let private_pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(private_key_der)
        );
        let key = EncodingKey::from_ed_pem(private_pem.as_bytes()).expect("encoding key");
        jsonwebtoken::encode(&header, &claims, &key).expect("sign origin write token")
    }

    fn test_app_state(
        project_id: Uuid,
        origin_id: Uuid,
        workspace: &TempDir,
        controller_base_url: reqwest::Url,
        skip_auth: bool,
    ) -> AppState {
        let client = reqwest::Client::new();
        let config = Arc::new(ServerConfig {
            project_id,
            origin_id,
            workspace_root: workspace.path().to_path_buf(),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "test@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: controller_base_url.clone(),
            controller_internal_token: None,
            jwks_url: controller_base_url,
            skip_auth,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 16 * 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        });
        let validator = TokenValidator::new(client.clone(), config.jwks_url.clone());
        AppState::new(
            config,
            validator,
            client,
            workspace.path().to_path_buf(),
            None,
        )
        .expect("open workspace root")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_routes_never_follow_outbound_workspace_symlinks() {
        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let workspace = TempDir::new().expect("workspace");
        let outside = TempDir::new().expect("outside");
        std::fs::write(outside.path().join("secret.txt"), b"outside-secret")
            .expect("outside secret");
        symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("file-link"),
        )
        .expect("file link");
        symlink(outside.path(), workspace.path().join("dir-link")).expect("directory link");

        let state = test_app_state(
            project_id,
            origin_id,
            &workspace,
            "http://127.0.0.1:1".parse().expect("controller url"),
            true,
        );
        let app = super::router(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind origin");
        let address = listener.local_addr().expect("origin address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve origin");
        });
        let client = reqwest::Client::new();
        let base = format!("http://{address}");

        for path in [
            "/files/file-link",
            "/raw/file-link",
            "/files/dir-link/secret.txt",
            "/raw/dir-link/secret.txt",
            "/entries?path=dir-link",
        ] {
            let response = client
                .get(format!("{base}{path}"))
                .send()
                .await
                .expect("origin request");
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "path {path}");
        }

        let entries = client
            .get(format!("{base}/entries"))
            .send()
            .await
            .expect("root entries")
            .json::<serde_json::Value>()
            .await
            .expect("entries json");
        let entries = entries.as_array().expect("entry array");
        assert!(entries.iter().all(|entry| {
            !matches!(
                entry.get("name").and_then(serde_json::Value::as_str),
                Some("file-link" | "dir-link")
            )
        }));

        assert_eq!(
            std::fs::read(outside.path().join("secret.txt")).unwrap(),
            b"outside-secret"
        );
        server.abort();
    }

    #[tokio::test]
    async fn write_lease_authorization_fails_closed_and_requires_exact_claim_bindings() {
        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let payload = json!({
            "lease": {
                "leaseId": lease_id,
                "projectId": project_id,
                "userId": user_id,
                "runtimeId": runtime_id,
                "expiresAt": (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
            }
        });
        let controller = Router::new().route(
            "/projects/:project_id/lease",
            get(move |headers: HeaderMap| {
                let payload = payload.clone();
                async move {
                    let authorized = headers
                        .get(axum::http::header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        == Some("Bearer origin-write-token");
                    if authorized {
                        (AxumStatusCode::OK, Json(payload))
                    } else {
                        (
                            AxumStatusCode::UNAUTHORIZED,
                            Json(json!({ "error": "missing token" })),
                        )
                    }
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind controller");
        let address = listener.local_addr().expect("controller address");
        let controller_server = tokio::spawn(async move {
            axum::serve(listener, controller)
                .await
                .expect("serve controller");
        });

        let workspace = TempDir::new().expect("workspace");
        let state = test_app_state(
            project_id,
            origin_id,
            &workspace,
            format!("http://{address}").parse().expect("controller url"),
            false,
        );
        let claims = OriginClaims {
            aud: origin_id.to_string(),
            sub: user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: Some(runtime_id.to_string()),
            protocol: Some("http".to_string()),
            scopes: vec!["fs.write".to_string()],
            lease_id: Some(lease_id.to_string()),
            run_id: Some(Uuid::new_v4().to_string()),
            prefer_runtime: Some(runtime_id.to_string()),
            iat: None,
            exp: None,
            jti: None,
            actor_label: None,
            browser_session_id: None,
        };

        authorize_active_write_lease(&state, &claims, "origin-write-token")
            .await
            .expect("exact active lease must authorize");

        let mut mismatched = claims.clone();
        mismatched.lease_id = Some(Uuid::new_v4().to_string());
        assert!(
            authorize_active_write_lease(&state, &mismatched, "origin-write-token")
                .await
                .is_err()
        );

        let mut mismatched = claims.clone();
        mismatched.runtime_id = Some(Uuid::new_v4().to_string());
        assert!(
            authorize_active_write_lease(&state, &mismatched, "origin-write-token")
                .await
                .is_err()
        );

        let mut mismatched = claims.clone();
        mismatched.sub = Uuid::new_v4().to_string();
        assert!(
            authorize_active_write_lease(&state, &mismatched, "origin-write-token")
                .await
                .is_err()
        );

        assert!(authorize_active_write_lease(&state, &claims, "")
            .await
            .is_err());

        let unavailable_state = test_app_state(
            project_id,
            origin_id,
            &workspace,
            "http://127.0.0.1:1".parse().expect("unavailable url"),
            false,
        );
        assert!(
            authorize_active_write_lease(&unavailable_state, &claims, "origin-write-token")
                .await
                .is_err()
        );

        controller_server.abort();
    }

    #[tokio::test]
    async fn write_route_rejects_missing_controller_lease_before_mutating_workspace() {
        let rng = SystemRandom::new();
        let private_key = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate keypair");
        let key_pair = Ed25519KeyPair::from_pkcs8(private_key.as_ref()).expect("construct keypair");
        let jwks = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": "browser-scope-test",
                "x": URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref()),
            }]
        });
        let controller = Router::new()
            .route(
                "/jwks",
                get(move || {
                    let jwks = jwks.clone();
                    async move { Json(jwks) }
                }),
            )
            .route(
                "/projects/:project_id/lease",
                get(|| async { Json(json!({ "lease": null })) }),
            );
        let controller_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind controller");
        let controller_address = controller_listener
            .local_addr()
            .expect("controller address");
        let controller_server = tokio::spawn(async move {
            axum::serve(controller_listener, controller)
                .await
                .expect("serve controller");
        });

        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let workspace = TempDir::new().expect("workspace");
        let protected_path = workspace.path().join("protected.txt");
        std::fs::write(&protected_path, b"must remain").expect("write protected file");
        let controller_base_url: reqwest::Url = format!("http://{controller_address}")
            .parse()
            .expect("controller url");
        let client = reqwest::Client::new();
        let config = Arc::new(ServerConfig {
            project_id,
            origin_id,
            workspace_root: workspace.path().to_path_buf(),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "test@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: controller_base_url.clone(),
            controller_internal_token: None,
            jwks_url: controller_base_url.join("jwks").expect("jwks url"),
            skip_auth: false,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 16 * 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        });
        let validator = TokenValidator::new(client.clone(), config.jwks_url.clone());
        let app = super::router(
            AppState::new(
                config,
                validator,
                client.clone(),
                workspace.path().to_path_buf(),
                None,
            )
            .expect("open workspace root"),
        );
        let origin_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind origin");
        let origin_address = origin_listener.local_addr().expect("origin address");
        let origin_server = tokio::spawn(async move {
            axum::serve(origin_listener, app)
                .await
                .expect("serve origin");
        });

        let archive = ZipWriter::new(Cursor::new(Vec::new()))
            .finish()
            .expect("finish empty zip")
            .into_inner();
        let token = origin_write_token(
            private_key.as_ref(),
            project_id,
            origin_id,
            user_id,
            lease_id,
            None,
        );
        let response = client
            .post(format!("http://{origin_address}/apply-json"))
            .bearer_auth(token)
            .json(&json!({
                "manifest": {
                    "projectId": project_id,
                    "leaseId": lease_id,
                    "files": [],
                    "deletes": ["protected.txt"],
                },
                "archiveBase64": base64::engine::general_purpose::STANDARD.encode(archive),
            }))
            .send()
            .await
            .expect("write request");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            std::fs::read(&protected_path).expect("protected file remains"),
            b"must remain"
        );

        origin_server.abort();
        controller_server.abort();
    }

    #[tokio::test]
    async fn browser_routes_enforce_dedicated_scope_matrix() {
        let rng = SystemRandom::new();
        let private_key = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate keypair");
        let key_pair = Ed25519KeyPair::from_pkcs8(private_key.as_ref()).expect("construct keypair");
        let project_id = Uuid::new_v4();
        let origin_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let jwks = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": "browser-scope-test",
                "x": URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref()),
            }]
        });
        // The controller mock serves both the JWKS and an active workspace
        // lease so write-scoped routes pass the live-lease authorization gate.
        let lease_payload = json!({
            "lease": {
                "leaseId": lease_id,
                "projectId": project_id,
                "userId": user_id,
                "runtimeId": null,
                "expiresAt": (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
            }
        });
        let jwks_app = Router::new()
            .route(
                "/jwks",
                get(move || {
                    let jwks = jwks.clone();
                    async move { Json(jwks) }
                }),
            )
            .route(
                "/projects/:project_id/lease",
                get(move || {
                    let lease_payload = lease_payload.clone();
                    async move { Json(lease_payload) }
                }),
            );
        let jwks_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind jwks");
        let jwks_address = jwks_listener.local_addr().expect("jwks address");
        let jwks_server = tokio::spawn(async move {
            axum::serve(jwks_listener, jwks_app)
                .await
                .expect("serve jwks");
        });

        let workspace = TempDir::new().expect("workspace");
        let client = reqwest::Client::new();
        let config = Arc::new(ServerConfig {
            project_id,
            origin_id,
            workspace_root: workspace.path().to_path_buf(),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "Instafy Test".to_string(),
            git_author_email: "test@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: format!("http://{jwks_address}")
                .parse()
                .expect("controller url"),
            controller_internal_token: None,
            jwks_url: format!("http://{jwks_address}/jwks")
                .parse()
                .expect("jwks url"),
            skip_auth: false,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 16 * 1024 * 1024,
            staging_base: None,
            multi_tenant: false,
        });
        let validator = TokenValidator::new(client.clone(), config.jwks_url.clone());
        let status_key = "github-import-v1:status-route";
        let status_fingerprint = "sha256:status-route";
        let ApplyIdempotencyClaimOutcome::Acquired(status_claim) =
            claim_apply_idempotency(workspace.path(), status_key, Some(status_fingerprint))
                .expect("seed status receipt")
        else {
            panic!("status receipt claim should be acquired");
        };
        complete_apply_idempotency_claim(
            workspace.path(),
            &status_claim,
            &ApplyIdempotencySuccess {
                rev: "status-rev".to_string(),
                base_rev: Some("status-base".to_string()),
                file_count: Some(16),
                bytes_written: Some(2048),
            },
        )
        .expect("complete status receipt");
        drop(status_claim);
        let app = super::router(
            AppState::new(
                config,
                validator,
                client.clone(),
                workspace.path().to_path_buf(),
                None,
            )
            .expect("open workspace root"),
        );
        let origin_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind origin");
        let origin_address = origin_listener.local_addr().expect("origin address");
        let origin_server = tokio::spawn(async move {
            axum::serve(origin_listener, app)
                .await
                .expect("serve origin");
        });
        let base = format!("http://{origin_address}");
        let token =
            |scopes: &[&str]| origin_token(private_key.as_ref(), project_id, origin_id, scopes);
        // Write-scoped routes additionally require an active workspace lease
        // binding, so writes use a lease-bound token.
        let write_token = origin_write_token(
            private_key.as_ref(),
            project_id,
            origin_id,
            user_id,
            lease_id,
            None,
        );

        let fs_read = token(&["fs.read"]);
        assert_eq!(
            client
                .get(format!("{base}/browser/capabilities"))
                .bearer_auth(fs_read)
                .send()
                .await
                .expect("fs token request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!("{base}/apply/status"))
                .bearer_auth(token(&["fs.read"]))
                .json(&json!({ "idempotencyKey": status_key }))
                .send()
                .await
                .expect("read-only apply status request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let status_response = client
            .post(format!("{base}/apply/status"))
            .bearer_auth(&write_token)
            .json(&json!({
                "idempotencyKey": status_key,
                "requestFingerprint": status_fingerprint,
            }))
            .send()
            .await
            .expect("write-scoped apply status request");
        assert_eq!(status_response.status(), StatusCode::OK);
        assert_eq!(
            status_response.json::<serde_json::Value>().await.unwrap(),
            json!({
                "status": "succeeded",
                "rev": "status-rev",
                "baseRev": "status-base",
                "fileCount": 16,
                "bytesWritten": 2048,
            })
        );

        let view = token(&["browser.view"]);
        assert_eq!(
            client
                .get(format!("{base}/browser/capabilities"))
                .bearer_auth(&view)
                .send()
                .await
                .expect("view request")
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            client
                .get(format!("{base}/browser/input"))
                .bearer_auth(&view)
                .send()
                .await
                .expect("view control request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/browser/approval/pending"))
                .bearer_auth(&view)
                .send()
                .await
                .expect("view approval route request")
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .post(format!("{base}/browser/approval/decision"))
                .bearer_auth(&view)
                .json(&json!({}))
                .send()
                .await
                .expect("view-only approval decision request")
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let control = token(&["browser.control"]);
        assert_eq!(
            client
                .get(format!("{base}/browser/capabilities"))
                .bearer_auth(&control)
                .send()
                .await
                .expect("control view request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/browser/input"))
                .bearer_auth(&control)
                .send()
                .await
                .expect("control request")
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .get(format!("{base}/browser/screencast"))
                .bearer_auth(&control)
                .send()
                .await
                .expect("single-scope transport request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/browser/approval/pending"))
                .bearer_auth(&control)
                .send()
                .await
                .expect("control-only approval observation request")
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!("{base}/browser/approval/decision"))
                .bearer_auth(&control)
                .json(&json!({}))
                .send()
                .await
                .expect("control approval route request")
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            client
                .post(format!("{base}/browser/approval/decision"))
                .bearer_auth(&control)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body("x".repeat(4 * 1024 + 1))
                .send()
                .await
                .expect("oversized approval decision request")
                .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );

        let interactive = token(&["browser.view", "browser.control"]);
        assert_eq!(
            client
                .get(format!("{base}/browser/screencast"))
                .bearer_auth(interactive)
                .send()
                .await
                .expect("interactive transport request")
                .status(),
            StatusCode::BAD_REQUEST
        );

        let mut archive_writer = ZipWriter::new(Cursor::new(Vec::new()));
        archive_writer
            .start_file("streamed.txt", FileOptions::<()>::default())
            .unwrap();
        archive_writer.write_all(b"streamed archive").unwrap();
        let streamed_archive = archive_writer.finish().unwrap().into_inner();
        let streamed_manifest = serde_json::to_vec(&json!({
            "projectId": project_id,
            "leaseId": lease_id,
            "files": [{ "path": "streamed.txt", "size": 16 }],
            "deletes": [],
        }))
        .unwrap();
        let boundary = "instafy-origin-stream-test";
        let mut multipart_body = Vec::new();
        multipart_body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n"
            )
            .as_bytes(),
        );
        multipart_body.extend_from_slice(&streamed_manifest);
        multipart_body.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"archive\"; filename=\"workspace.zip\"\r\nContent-Type: application/zip\r\n\r\n"
            )
            .as_bytes(),
        );
        multipart_body.extend_from_slice(&streamed_archive);
        multipart_body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let apply_response = client
            .post(format!("{base}/apply"))
            .bearer_auth(&write_token)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart_body)
            .send()
            .await
            .expect("streaming multipart apply request");
        assert_eq!(apply_response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read(workspace.path().join("streamed.txt")).unwrap(),
            b"streamed archive"
        );

        origin_server.abort();
        jwks_server.abort();
    }
}
