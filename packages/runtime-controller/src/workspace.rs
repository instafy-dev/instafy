use std::collections::HashSet;
use std::path::{Component, Path as StdPath, PathBuf};
use std::str::FromStr;
use std::{io::ErrorKind, thread};

use anyhow::{anyhow, Context, Error as AnyhowError};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{
        header::{CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::Response,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use notify::event::ModifyKind;
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio::fs;
use tokio::sync::mpsc;
use tokio::time::Duration as TokioDuration;
use tokio_postgres::Row;
use tokio_util::io::ReaderStream;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::config::PgPool;
use crate::state::{
    publish_controller_event_to_user, EventHub, LocalWorkspaceEntry, RuntimePreferenceRegistry,
};
use crate::{
    bad_request, database_unavailable, ensure_project_access, ensure_project_write_access,
    internal_error, load_project_record, not_found, publish_controller_event, unauthorized,
    ApiError, AppConfig, AppState,
};

pub(crate) const LOCAL_WORKSPACE_IDLE_TTL_SECONDS: i64 = 120;

pub(crate) static LOCAL_RUNTIME_RECENCY_SECONDS: Lazy<i64> = Lazy::new(|| {
    std::env::var("LOCAL_RUNTIME_OFFLINE_GRACE_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value >= 10)
        .unwrap_or(60)
});

pub(crate) static REMOTE_RUNTIME_RECENCY_SECONDS: Lazy<i64> = Lazy::new(|| {
    std::env::var("REMOTE_RUNTIME_OFFLINE_GRACE_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value >= 60)
        .unwrap_or(300)
});

pub(crate) fn local_workspace_ttl() -> ChronoDuration {
    let seconds = LOCAL_WORKSPACE_IDLE_TTL_SECONDS.max(30);
    ChronoDuration::seconds(seconds)
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/workspaces/local",
            get(get_local_workspace)
                .put(register_local_workspace)
                .delete(unregister_local_workspace),
        )
        .route(
            "/projects/:project_id/workspaces/local/heartbeat",
            post(heartbeat_local_workspace),
        )
}

pub(crate) fn spawn_workspace_watchers(state: &AppState) {
    if let Some(root) = state.config.workspace_root.clone() {
        let state_clone = state.clone();
        tokio::spawn(async move {
            if let Err(error) = watch_workspace_changes(state_clone.events.clone(), root).await {
                warn!(?error, "workspace watcher terminated");
            }
        });
    } else {
        info!("workspace watcher not started (no workspace_root configured)");
    }
}

pub(crate) fn spawn_local_workspace_housekeeping(state: &AppState) {
    let state_clone = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TokioDuration::from_secs(30));
        let ttl = local_workspace_ttl();
        loop {
            interval.tick().await;
            let expired = state_clone.local_workspaces.prune_expired(ttl).await;
            if expired.is_empty() {
                continue;
            }
            for (project_id, owner_user_id, entry) in expired {
                publish_controller_event_to_user(
                    &state_clone.events,
                    "local_workspace.expired",
                    Some(project_id),
                    owner_user_id,
                    local_workspace_event_payload(&entry, Some("expired")),
                );
            }
        }
    });
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceListQuery {
    project_id: Option<String>,
    path: Option<String>,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileEntry {
    name: String,
    path: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    has_children: Option<bool>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceReadQuery {
    project_id: Option<String>,
    path: Option<String>,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceReadResponse {
    path: String,
    encoding: &'static str,
    content_base64: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
}

// write endpoints have been removed; keep read-only types above

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDeleteBody {
    project_id: Option<String>,
    path: Option<String>,
    #[serde(default)]
    recursive: Option<bool>,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDeleteResponse {
    ok: bool,
    path: String,
    deleted: bool,
}

#[derive(Debug, Deserialize)]
struct LocalWorkspacePathParams {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterLocalWorkspaceBody {
    path: String,
    device_id: String,
    hostname: Option<String>,
    platform: Option<String>,
    release: Option<String>,
    arch: Option<String>,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
    #[serde(rename = "runtimeId", alias = "runtime_id")]
    runtime_id: Option<String>,
    #[serde(rename = "presenceStatus", alias = "presence_status")]
    presence_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalWorkspaceHeartbeatBody {
    device_id: String,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
    #[serde(rename = "runtimeId", alias = "runtime_id")]
    runtime_id: Option<String>,
    #[serde(rename = "presenceStatus", alias = "presence_status")]
    presence_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalWorkspaceDeleteBody {
    #[serde(default)]
    device_id: Option<String>,
    #[serde(rename = "accessToken", alias = "access_token")]
    access_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalWorkspaceResponse {
    ok: bool,
    project_id: String,
    workspace: Option<LocalWorkspaceEntry>,
}

#[instrument(skip(state, headers, body))]
async fn register_local_workspace(
    State(state): State<AppState>,
    Path(params): Path<LocalWorkspacePathParams>,
    headers: HeaderMap,
    Json(body): Json<RegisterLocalWorkspaceBody>,
) -> Result<Json<LocalWorkspaceResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_project_id(&params.project_id)?;

    let context = ensure_project_authorized(
        &state,
        &headers,
        &project_id,
        body.access_token.as_deref(),
        true,
    )
    .await?;
    let owner_user_id = context
        .user_id
        .ok_or_else(|| unauthorized("local workspace requires an authenticated user"))?;

    let path = body.path.trim().to_string();
    if path.is_empty() {
        return Err(bad_request("path is required"));
    }
    let device_id = body.device_id.trim();
    if device_id.is_empty() {
        return Err(bad_request("deviceId is required"));
    }

    let requested_runtime_id = parse_optional_runtime_id(body.runtime_id.as_ref(), "runtimeId")?;
    let preferred_runtime_id = resolve_local_runtime_preference(
        &state,
        &project_id,
        requested_runtime_id,
        true,
        context.user_id,
        context.is_service_role,
    )
    .await?;

    let entry = LocalWorkspaceEntry {
        owner_user_id,
        device_id: device_id.to_string(),
        path,
        hostname: body.hostname.clone(),
        platform: body.platform.clone(),
        release: body.release.clone(),
        arch: body.arch.clone(),
        last_heartbeat: Utc::now(),
        expires_at: None,
        preferred_runtime_id,
        presence_status: body
            .presence_status
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| ["online", "offline", "degraded", "expired"].contains(&s.as_str())),
    };

    let ttl = local_workspace_ttl();
    let registered = state
        .local_workspaces
        .register(project_id, entry, ttl)
        .await;

    publish_controller_event_to_user(
        &state.events,
        "local_workspace.registered",
        Some(project_id),
        owner_user_id,
        local_workspace_event_payload(&registered, Some("online")),
    );

    Ok(Json(LocalWorkspaceResponse {
        ok: true,
        project_id: project_id.to_string(),
        workspace: Some(registered),
    }))
}

#[instrument(skip(state, headers, body))]
async fn heartbeat_local_workspace(
    State(state): State<AppState>,
    Path(params): Path<LocalWorkspacePathParams>,
    headers: HeaderMap,
    Json(body): Json<LocalWorkspaceHeartbeatBody>,
) -> Result<Json<LocalWorkspaceResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_project_id(&params.project_id)?;
    let context = ensure_project_authorized(
        &state,
        &headers,
        &project_id,
        body.access_token.as_deref(),
        true,
    )
    .await?;
    let owner_user_id = context
        .user_id
        .ok_or_else(|| unauthorized("local workspace requires an authenticated user"))?;

    let device_id = body.device_id.trim();
    if device_id.is_empty() {
        return Err(bad_request("deviceId is required"));
    }

    let requested_runtime_id = parse_optional_runtime_id(body.runtime_id.as_ref(), "runtimeId")?;
    let preferred_runtime_id = if requested_runtime_id.is_some() {
        resolve_local_runtime_preference(
            &state,
            &project_id,
            requested_runtime_id,
            false,
            context.user_id,
            context.is_service_role,
        )
        .await?
    } else {
        None
    };

    let entry = state
        .local_workspaces
        .heartbeat(
            project_id,
            owner_user_id,
            device_id,
            preferred_runtime_id,
            local_workspace_ttl(),
        )
        .await
        .ok_or_else(|| {
            bad_request("no local workspace registered for this project or device mismatch")
        })?;

    // Reflect presenceStatus hint from heartbeat (useful in harness and companions)
    let mut entry = entry;
    if let Some(status) = body.presence_status.as_deref() {
        let normalized = status.trim().to_ascii_lowercase();
        if ["online", "offline", "degraded", "expired"].contains(&normalized.as_str()) {
            entry.presence_status = Some(normalized);
        }
    }

    publish_controller_event_to_user(
        &state.events,
        "local_workspace.heartbeat",
        Some(project_id),
        owner_user_id,
        local_workspace_event_payload(&entry, Some("online")),
    );

    // Persist presenceStatus hint for subsequent GET callers.
    if entry.presence_status.is_some() {
        let _ = state
            .local_workspaces
            .register(project_id, entry.clone(), local_workspace_ttl())
            .await;
    }

    Ok(Json(LocalWorkspaceResponse {
        ok: true,
        project_id: project_id.to_string(),
        workspace: Some(entry),
    }))
}

#[instrument(skip(state, headers, body))]
async fn unregister_local_workspace(
    State(state): State<AppState>,
    Path(params): Path<LocalWorkspacePathParams>,
    headers: HeaderMap,
    Json(body): Json<LocalWorkspaceDeleteBody>,
) -> Result<Json<LocalWorkspaceResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_project_id(&params.project_id)?;
    let context = ensure_project_authorized(
        &state,
        &headers,
        &project_id,
        body.access_token.as_deref(),
        true,
    )
    .await?;
    let owner_user_id = context
        .user_id
        .ok_or_else(|| unauthorized("local workspace requires an authenticated user"))?;

    let removed = state
        .local_workspaces
        .unregister(&project_id, &owner_user_id, body.device_id.as_deref())
        .await;
    if !removed {
        return Err(bad_request(
            "no local workspace registered for this project or device mismatch",
        ));
    }

    publish_controller_event_to_user(
        &state.events,
        "local_workspace.unregistered",
        Some(project_id),
        owner_user_id,
        {
            let mut data = JsonMap::new();
            data.insert(
                "deviceId".to_string(),
                body.device_id
                    .as_ref()
                    .map(|value| json!(value.trim()))
                    .unwrap_or(JsonValue::Null),
            );
            data.insert("status".to_string(), json!("offline"));
            JsonValue::Object(data)
        },
    );

    Ok(Json(LocalWorkspaceResponse {
        ok: true,
        project_id: project_id.to_string(),
        workspace: None,
    }))
}

#[instrument(skip(state, headers))]
async fn get_local_workspace(
    State(state): State<AppState>,
    Path(params): Path<LocalWorkspacePathParams>,
    headers: HeaderMap,
) -> Result<Json<LocalWorkspaceResponse>, (StatusCode, Json<ApiError>)> {
    let project_id = parse_project_id(&params.project_id)?;
    let context = ensure_project_authorized(&state, &headers, &project_id, None, false).await?;
    let owner_user_id = context
        .user_id
        .ok_or_else(|| unauthorized("local workspace requires an authenticated user"))?;

    let workspace = state
        .local_workspaces
        .get_active(&project_id, &owner_user_id, local_workspace_ttl())
        .await;

    Ok(Json(LocalWorkspaceResponse {
        ok: true,
        project_id: project_id.to_string(),
        workspace,
    }))
}

fn parse_project_id(raw: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(bad_request("projectId is required"));
    }
    Uuid::from_str(trimmed).map_err(|_| bad_request("projectId must be a valid UUID"))
}

fn parse_optional_runtime_id(
    raw: Option<&String>,
    field: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    match raw
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(value) => Uuid::from_str(value)
            .map(Some)
            .map_err(|_| bad_request(format!("{field} must be a valid UUID"))),
        None => Ok(None),
    }
}

fn local_workspace_event_payload(entry: &LocalWorkspaceEntry, status: Option<&str>) -> JsonValue {
    let mut data = JsonMap::new();
    data.insert("deviceId".to_string(), json!(entry.device_id));
    data.insert("path".to_string(), json!(entry.path));
    if let Some(hostname) = entry.hostname.as_ref() {
        data.insert("hostname".to_string(), json!(hostname));
    }
    if let Some(platform) = entry.platform.as_ref() {
        data.insert("platform".to_string(), json!(platform));
    }
    if let Some(release) = entry.release.as_ref() {
        data.insert("release".to_string(), json!(release));
    }
    if let Some(arch) = entry.arch.as_ref() {
        data.insert("arch".to_string(), json!(arch));
    }
    data.insert("lastHeartbeat".to_string(), json!(entry.last_heartbeat));
    if let Some(expires_at) = entry.expires_at {
        data.insert("expiresAt".to_string(), json!(expires_at));
    }
    if let Some(runtime_id) = entry.preferred_runtime_id {
        data.insert("runtimeId".to_string(), json!(runtime_id));
    }
    if let Some(presence) = entry.presence_status.as_deref() {
        data.insert("presenceStatus".to_string(), json!(presence));
    }
    if let Some(status_value) = status {
        data.insert("status".to_string(), json!(status_value));
    }
    JsonValue::Object(data)
}

async fn ensure_project_authorized(
    state: &AppState,
    headers: &HeaderMap,
    project_id: &Uuid,
    token_override: Option<&str>,
    require_write: bool,
) -> Result<crate::auth::RequestContext, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers, token_override).await?;

    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Local workspace status", error))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| database_unavailable("Local workspace status", error))?;
    let project = load_project_record(&transaction, project_id).await?;
    if require_write {
        ensure_project_write_access(&transaction, &project, &context, None).await?;
    } else {
        ensure_project_access(&transaction, &project, &context, None).await?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit workspace check: {error}")))?;
    Ok(context)
}

#[derive(Debug)]
struct WorkspacePaths {
    project_root: PathBuf,
    target_path: PathBuf,
}

#[allow(dead_code)]
#[instrument(skip(state, headers, params))]
pub(crate) async fn list_workspace_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<WorkspaceListQuery>,
) -> Result<Json<Vec<WorkspaceFileEntry>>, (StatusCode, Json<ApiError>)> {
    let project_id_raw = params
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let token_override = params.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, None).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit workspace check: {error}")))?;

    let paths = resolve_workspace_paths(&state.config, &project_id, params.path.as_deref())?;
    let metadata = match fs::metadata(&paths.target_path).await {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && paths.target_path == paths.project_root =>
        {
            // A read-only request must not create a workspace merely by listing
            // it. Treat an absent project root as an empty workspace instead.
            return Ok(Json(Vec::new()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(not_found("workspace path not found"));
        }
        Err(error) => {
            return Err(internal_error(format!("failed to inspect path: {error}")));
        }
    };

    if metadata.is_file() {
        let relative = relative_path_string(&paths.project_root, &paths.target_path)?;
        let modified = metadata
            .modified()
            .ok()
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339());
        let extension = paths
            .target_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
        let mime_type = mime_guess::from_path(&paths.target_path)
            .first_raw()
            .map(|value| value.to_string());
        return Ok(Json(vec![WorkspaceFileEntry {
            name: paths
                .target_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            path: relative,
            kind: "file".to_string(),
            size: Some(metadata.len()),
            modified,
            mime_type,
            extension,
            has_children: None,
        }]));
    }

    if !metadata.is_dir() {
        return Err(bad_request("path is not a directory"));
    }

    let mut entries = fs::read_dir(&paths.target_path)
        .await
        .map_err(|error| internal_error(format!("failed to read directory: {error}")))?;
    let mut items: Vec<WorkspaceFileEntry> = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| internal_error(format!("failed to iterate directory: {error}")))?
    {
        let entry_path = entry.path();
        let file_metadata = entry
            .metadata()
            .await
            .map_err(|error| internal_error(format!("failed to inspect path: {error}")))?;
        let relative = relative_path_string(&paths.project_root, &entry_path)?;
        let name = entry.file_name().to_str().unwrap_or_default().to_string();
        let kind = if file_metadata.is_dir() {
            "directory"
        } else if file_metadata.is_file() {
            "file"
        } else {
            "other"
        };
        let modified = file_metadata
            .modified()
            .ok()
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339());

        let extension = if file_metadata.is_file() {
            entry_path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_string())
        } else {
            None
        };
        let mime_type = if file_metadata.is_file() {
            mime_guess::from_path(&entry_path)
                .first_raw()
                .map(|value| value.to_string())
        } else {
            None
        };
        let has_children = if file_metadata.is_dir() {
            match directory_has_children(&entry_path).await {
                Ok(result) => Some(result),
                Err(error) => {
                    warn!(
                        path = ?entry_path,
                        %error,
                        "failed to inspect directory children"
                    );
                    Some(false)
                }
            }
        } else {
            None
        };

        items.push(WorkspaceFileEntry {
            name,
            path: relative,
            kind: kind.to_string(),
            size: file_metadata.is_file().then(|| file_metadata.len()),
            modified,
            mime_type,
            extension,
            has_children,
        });
    }

    items.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(items))
}

async fn directory_has_children(path: &StdPath) -> Result<bool, AnyhowError> {
    let mut entries = fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let name_str = name.to_str().unwrap_or_default();
        if name_str != "." && name_str != ".." {
            return Ok(true);
        }
    }
    Ok(false)
}

#[instrument(skip(state, headers, params))]
#[allow(dead_code)]
pub(crate) async fn read_workspace_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<WorkspaceReadQuery>,
) -> Result<Json<WorkspaceReadResponse>, (StatusCode, Json<ApiError>)> {
    let project_id_raw = params
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let token_override = params.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, None).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit workspace check: {error}")))?;

    let paths = resolve_workspace_paths(&state.config, &project_id, params.path.as_deref())?;
    let relative = relative_path_string(&paths.project_root, &paths.target_path)?;
    let metadata = match fs::metadata(&paths.target_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(not_found("workspace file not found"));
        }
        Err(error) => {
            return Err(internal_error(format!("failed to inspect path: {error}")));
        }
    };
    if !metadata.is_file() {
        return Err(bad_request("path is not a file"));
    }

    let bytes = fs::read(&paths.target_path)
        .await
        .map_err(|error| internal_error(format!("failed to read file: {error}")))?;
    let encoded = BASE64_STANDARD.encode(&bytes);
    let mime_type = mime_guess::from_path(&paths.target_path)
        .first_raw()
        .map(|value| value.to_string());

    Ok(Json(WorkspaceReadResponse {
        path: relative,
        encoding: "base64",
        content_base64: encoded,
        size: metadata.len(),
        mime_type,
    }))
}

#[instrument(skip(state, headers, params))]
#[allow(dead_code)]
pub(crate) async fn raw_workspace_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<WorkspaceReadQuery>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let project_id_raw = params
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let token_override = params.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, &context, None).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit workspace check: {error}")))?;

    let paths = resolve_workspace_paths(&state.config, &project_id, params.path.as_deref())?;
    let metadata = fs::metadata(&paths.target_path)
        .await
        .map_err(|error| internal_error(format!("failed to inspect path: {error}")))?;
    if !metadata.is_file() {
        return Err(bad_request("path is not a file"));
    }

    let file = fs::File::open(&paths.target_path)
        .await
        .map_err(|error| internal_error(format!("failed to open file: {error}")))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    let mut response = Response::new(body);

    let mime = mime_guess::from_path(&paths.target_path)
        .first_or_octet_stream()
        .to_string();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&mime).map_err(|_| internal_error("invalid mime type"))?,
    );

    let filename = paths
        .target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let disposition = format!("inline; filename=\"{}\"", filename.replace('"', ""));
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .map_err(|_| internal_error("invalid content disposition"))?,
    );

    Ok(response)
}

// write_workspace_file endpoint removed — writes must go through origin /apply.

#[allow(dead_code)]
pub(crate) async fn delete_workspace_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WorkspaceDeleteBody>,
) -> Result<Json<WorkspaceDeleteResponse>, (StatusCode, Json<ApiError>)> {
    let project_id_raw = body
        .project_id
        .as_ref()
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let path = body
        .path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("path is required"))?;

    let token_override = body.access_token.clone();
    let context = authenticate_request(&state.config, &headers, token_override.as_deref()).await?;

    let mut conn = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = conn
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit workspace check: {error}")))?;

    let paths = resolve_workspace_paths(&state.config, &project_id, Some(path))?;
    let relative = relative_path_string(&paths.project_root, &paths.target_path)?;
    if relative.is_empty() {
        return Err(bad_request(
            "path must reference a file or directory within the project",
        ));
    }

    let metadata = match fs::metadata(&paths.target_path).await {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(internal_error(format!(
                "failed to inspect workspace path: {error}"
            )))
        }
    };

    let mut deleted = false;

    if let Some(metadata) = metadata {
        if metadata.is_file() {
            fs::remove_file(&paths.target_path)
                .await
                .map_err(|error| internal_error(format!("failed to delete file: {error}")))?;
            deleted = true;
        } else if metadata.is_dir() {
            if body.recursive.unwrap_or(false) {
                fs::remove_dir_all(&paths.target_path)
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to delete directory: {error}"))
                    })?;
                deleted = true;
            } else {
                return Err(bad_request(
                    "path is a directory; specify recursive: true to delete directories",
                ));
            }
        } else {
            return Err(bad_request("path is not a file or directory"));
        }
    }

    Ok(Json(WorkspaceDeleteResponse {
        ok: true,
        path: relative,
        deleted,
    }))
}

#[allow(dead_code)]
pub(crate) async fn load_workspace_file_content(
    config: &AppConfig,
    project_id: &Uuid,
    path: &str,
) -> anyhow::Result<String> {
    let paths = resolve_workspace_paths(config, project_id, Some(path)).map_err(
        |(status, Json(api_error))| {
            anyhow!(
                "failed to resolve workspace path {} (status {}): {}",
                path,
                status.as_u16(),
                api_error.message
            )
        },
    )?;

    let bytes = match fs::read(&paths.target_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let workspace_root =
                require_workspace_root(config).map_err(|(status, Json(api_error))| {
                    anyhow!(
                        "failed to resolve workspace root (status {}): {}",
                        status.as_u16(),
                        api_error.message
                    )
                })?;
            let fallback_relative = relative_path_string(&paths.project_root, &paths.target_path)
                .map_err(|(status, Json(api_error))| {
                anyhow!(
                    "failed to determine relative path (status {}): {}",
                    status.as_u16(),
                    api_error.message
                )
            })?;
            let fallback_path = if fallback_relative.is_empty() {
                workspace_root.to_path_buf()
            } else {
                workspace_root.join(&fallback_relative)
            };

            fs::read(&fallback_path).await.with_context(|| {
                format!(
                    "failed to read fallback workspace file {}",
                    fallback_path.display()
                )
            })?
        }
        Err(error) => {
            return Err(anyhow!(error))
                .with_context(|| format!("failed to read workspace file {}", path));
        }
    };

    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn require_workspace_root(config: &AppConfig) -> Result<&StdPath, (StatusCode, Json<ApiError>)> {
    config
        .workspace_root
        .as_deref()
        .ok_or_else(|| internal_error("WORKSPACE_ROOT is not configured"))
}

fn sanitize_relative_path(path: Option<&str>) -> Result<PathBuf, (StatusCode, Json<ApiError>)> {
    let relative = match path {
        Some(raw) => raw.trim(),
        None => "",
    };
    let mut buf = PathBuf::new();
    if relative.is_empty() {
        return Ok(buf);
    }
    let relative_path = StdPath::new(relative);
    for component in relative_path.components() {
        match component {
            Component::Normal(part) => buf.push(part),
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) | Component::ParentDir => {
                return Err(bad_request("path must be relative"));
            }
        }
    }
    Ok(buf)
}

fn resolve_workspace_paths(
    config: &AppConfig,
    project_id: &Uuid,
    path: Option<&str>,
) -> Result<WorkspacePaths, (StatusCode, Json<ApiError>)> {
    let root = require_workspace_root(config)?;
    let mut project_root = PathBuf::from(root);
    project_root.push(project_id.to_string());

    let relative = sanitize_relative_path(path)?;
    let target_path = if relative.as_os_str().is_empty() {
        project_root.clone()
    } else {
        project_root.join(&relative)
    };

    Ok(WorkspacePaths {
        project_root,
        target_path,
    })
}

// write-path guard removed with write endpoints; not needed for read-only surface

#[allow(dead_code)]
fn relative_path_string(
    project_root: &StdPath,
    target: &StdPath,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let relative = target
        .strip_prefix(project_root)
        .unwrap_or(target)
        .to_path_buf();
    Ok(relative
        .to_str()
        .map(|value| value.trim_start_matches('/').to_string())
        .unwrap_or_default())
}

async fn watch_workspace_changes(events: EventHub, root: PathBuf) -> Result<(), AnyhowError> {
    let (tx, mut rx) = mpsc::channel::<NotifyEvent>(128);

    tokio::task::spawn_blocking({
        let watcher_root = root.clone();
        let sender = tx.clone();
        move || {
            if let Err(error) = run_blocking_watcher(watcher_root, sender) {
                warn!(?error, "workspace watcher terminated unexpectedly");
            }
        }
    });

    drop(tx);

    info!(root = %root.display(), "workspace watcher started");
    while let Some(event) = rx.recv().await {
        if let Err(error) = handle_notify_event(&events, &root, event).await {
            warn!(?error, "failed to handle filesystem event");
        }
    }

    Ok(())
}

fn run_blocking_watcher(root: PathBuf, sender: mpsc::Sender<NotifyEvent>) -> notify::Result<()> {
    let mut watcher = RecommendedWatcher::new(
        move |res| match res {
            Ok(event) => {
                if let Err(error) = sender.blocking_send(event) {
                    warn!(?error, "workspace watcher channel send failed");
                }
            }
            Err(error) => warn!(?error, "workspace watcher notify error"),
        },
        NotifyConfig::default(),
    )?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    info!(root = %root.display(), "workspace watcher listening for changes");
    loop {
        thread::park();
    }
}

async fn handle_notify_event(
    events: &EventHub,
    root: &StdPath,
    event: NotifyEvent,
) -> Result<(), AnyhowError> {
    if event.paths.is_empty() {
        return Ok(());
    }

    let is_relevant = matches!(
        event.kind,
        EventKind::Modify(
            ModifyKind::Data(_) | ModifyKind::Any | ModifyKind::Name(_) | ModifyKind::Metadata(_)
        ) | EventKind::Create(_)
            | EventKind::Remove(_)
    );
    if !is_relevant {
        return Ok(());
    }

    let mut seen = HashSet::new();

    for path in event.paths {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };

        let mut components = relative.components();
        let project_component = match components.next() {
            Some(Component::Normal(value)) => value.to_string_lossy().to_string(),
            _ => continue,
        };

        let project_id = match Uuid::from_str(&project_component) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let mut remaining = PathBuf::new();
        let mut valid = true;
        for component in components {
            match component {
                Component::Normal(segment) => remaining.push(segment),
                _ => {
                    valid = false;
                    break;
                }
            }
        }
        if !valid || remaining.as_os_str().is_empty() {
            continue;
        }

        let Some(normalized) = normalize_relative_path(&remaining) else {
            continue;
        };

        let dedupe_key = format!("{}:{}", project_id, normalized);
        if !seen.insert(dedupe_key) {
            continue;
        }

        let metadata = match fs::metadata(&path).await {
            Ok(meta) => Some(meta),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => {
                warn!(
                    ?error,
                    path = %path.display(),
                    "workspace watcher failed to inspect path"
                );
                continue;
            }
        };
        if metadata
            .as_ref()
            .map(|meta| !meta.is_file())
            .unwrap_or(false)
        {
            continue;
        }

        let size = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
        let modified = metadata
            .as_ref()
            .and_then(|meta| meta.modified().ok())
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339());
        let deleted = metadata.is_none();

        let mut data = JsonMap::new();
        data.insert("path".to_string(), json!(normalized));
        data.insert("size".to_string(), json!(size));
        if let Some(modified_at) = modified {
            data.insert("modified".to_string(), json!(modified_at));
        }
        if deleted {
            data.insert("deleted".to_string(), JsonValue::Bool(true));
        }
        data.insert("sourceDeviceId".to_string(), JsonValue::Null);

        publish_controller_event(
            events,
            "workspace.file_changed",
            Some(project_id),
            None,
            None,
            None,
            JsonValue::Object(data),
        );
    }

    Ok(())
}

fn normalize_relative_path(path: &StdPath) -> Option<String> {
    let parts: Vec<String> = path
        .iter()
        .map(|segment| segment.to_string_lossy().to_string())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeCandidate {
    pub(crate) id: Uuid,
    pub(crate) provider: String,
    pub(crate) capabilities: JsonValue,
    pub(crate) status: String,
    pub(crate) endpoint_url: Option<String>,
    pub(crate) last_seen_at: Option<DateTime<Utc>>,
    pub(crate) idle_ttl_seconds: i32,
    pub(crate) display_name: Option<String>,
}

impl RuntimeCandidate {
    fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            provider: row.get("provider"),
            capabilities: row.get("capabilities"),
            status: row.get::<_, String>("status"),
            endpoint_url: row.get::<_, Option<String>>("endpoint_url"),
            last_seen_at: row.get::<_, Option<DateTime<Utc>>>("last_seen_at"),
            idle_ttl_seconds: row
                .get::<_, Option<i32>>("idle_ttl_seconds")
                .unwrap_or(LOCAL_WORKSPACE_IDLE_TTL_SECONDS as i32),
            display_name: row.get("display_name"),
        }
    }

    fn is_recent(&self) -> bool {
        runtime_is_recent(self.last_seen_at, self.idle_ttl_seconds, self.is_local())
    }

    fn is_local(&self) -> bool {
        endpoint_matches_local(self.endpoint_url.as_deref())
    }
}

pub(crate) const LOCAL_ENDPOINT_HINTS: &[&str] = &[
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
    "host.docker.internal",
];

pub(crate) fn endpoint_matches_local(endpoint: Option<&str>) -> bool {
    match endpoint {
        Some(value) => {
            let lowered = value.trim().to_ascii_lowercase();
            LOCAL_ENDPOINT_HINTS
                .iter()
                .any(|hint| lowered.contains(hint))
        }
        None => false,
    }
}

pub(crate) fn runtime_is_recent(
    last_seen: Option<DateTime<Utc>>,
    idle_ttl_seconds: i32,
    is_local: bool,
) -> bool {
    let last_seen = match last_seen {
        Some(time) => time,
        None => return false,
    };
    let now = Utc::now();
    let allowance = if is_local {
        idle_ttl_seconds
            .max(LOCAL_WORKSPACE_IDLE_TTL_SECONDS as i32)
            .max((*LOCAL_RUNTIME_RECENCY_SECONDS) as i32) as i64
    } else {
        *REMOTE_RUNTIME_RECENCY_SECONDS
    };
    now.signed_duration_since(last_seen).num_seconds() <= allowance
}

pub(crate) fn status_is_viable(status: &str) -> bool {
    matches!(status, "ready" | "running" | "requested")
}

pub(crate) async fn fetch_runtime_candidate(
    pool: &PgPool,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<Option<RuntimeCandidate>, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            "select id, provider, capabilities, status, endpoint_url, last_seen_at, idle_ttl_seconds, display_name \
             from runtimes where id = $1 and project_id = $2",
            &[runtime_id, project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load runtime: {error}")))?;
    Ok(row.map(|row| RuntimeCandidate::from_row(&row)))
}

pub(crate) async fn infer_runtime_candidate(
    state: &AppState,
    project_id: &Uuid,
    viewer_user_id: Option<Uuid>,
    is_service_role: bool,
) -> Result<Option<RuntimeCandidate>, (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let rows = connection
        .query(
            "select id, provider, capabilities, status, endpoint_url, last_seen_at, idle_ttl_seconds, display_name \
             from runtimes where project_id = $1 order by last_seen_at desc nulls last",
            &[project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to inspect runtimes: {error}")))?;

    let mut best_local: Option<RuntimeCandidate> = None;
    let mut fallback: Option<RuntimeCandidate> = None;

    for row in rows {
        let candidate = RuntimeCandidate::from_row(&row);
        if !crate::runtime::self_hosted_runtime_is_accessible_to_user(
            state,
            &candidate.provider,
            &candidate.capabilities,
            viewer_user_id,
            is_service_role,
        ) {
            continue;
        }
        if !status_is_viable(candidate.status.as_str()) {
            continue;
        }
        if !candidate.is_recent() {
            continue;
        }
        if candidate.is_local() {
            match &best_local {
                Some(current) if candidate.last_seen_at <= current.last_seen_at => {}
                _ => best_local = Some(candidate),
            }
        } else if fallback.is_none() {
            fallback = Some(candidate);
        }
    }

    if best_local.is_some() {
        return Ok(best_local);
    }

    Ok(fallback)
}

async fn store_local_runtime_preference(
    state: &AppState,
    preferences: &RuntimePreferenceRegistry,
    project_id: Uuid,
    candidate: &RuntimeCandidate,
    viewer_user_id: Option<Uuid>,
    source: &str,
    replace_managed: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    store_local_runtime_preference_classified(
        preferences,
        project_id,
        candidate,
        viewer_user_id,
        source,
        replace_managed,
        crate::runtime::runtime_is_private_self_hosted(
            state,
            &candidate.provider,
            &candidate.capabilities,
        ),
    )
    .await
}

async fn store_local_runtime_preference_classified(
    preferences: &RuntimePreferenceRegistry,
    project_id: Uuid,
    candidate: &RuntimeCandidate,
    viewer_user_id: Option<Uuid>,
    source: &str,
    replace_managed: bool,
    is_private_self_hosted: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if is_private_self_hosted {
        let owner_user_id = viewer_user_id.ok_or_else(|| {
            unauthorized("private runtime preference requires an authenticated owner")
        })?;
        preferences
            .set_private(
                project_id,
                owner_user_id,
                Some(candidate.id),
                Some(source.to_string()),
                candidate.display_name.clone(),
            )
            .await;
    } else if replace_managed
        || preferences
            .get(&project_id)
            .await
            .and_then(|entry| entry.runtime_id)
            .is_none()
    {
        preferences
            .set(
                project_id,
                Some(candidate.id),
                Some(source.to_string()),
                candidate.display_name.clone(),
            )
            .await;
    }
    Ok(())
}

async fn resolve_local_runtime_preference(
    state: &AppState,
    project_id: &Uuid,
    requested: Option<Uuid>,
    allow_infer: bool,
    viewer_user_id: Option<Uuid>,
    is_service_role: bool,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let selected_preference = if let Some(viewer_user_id) = viewer_user_id {
        state
            .runtime_preferences
            .get_private(project_id, &viewer_user_id)
            .await
            .or(state.runtime_preferences.get(project_id).await)
    } else {
        state.runtime_preferences.get(project_id).await
    };
    if let Some(existing) = selected_preference {
        if let Some(runtime_id) = existing.runtime_id {
            if let Some(candidate) =
                fetch_runtime_candidate(&state.pool, project_id, &runtime_id).await?
            {
                if crate::runtime::self_hosted_runtime_is_accessible_to_user(
                    state,
                    &candidate.provider,
                    &candidate.capabilities,
                    viewer_user_id,
                    is_service_role,
                ) {
                    return Ok(Some(runtime_id));
                }
            }
        }
    }

    if let Some(runtime_id) = requested {
        let candidate = fetch_runtime_candidate(&state.pool, project_id, &runtime_id).await?;
        let Some(candidate) = candidate else {
            return Err(bad_request("runtimeId not found for project"));
        };
        crate::runtime::ensure_self_hosted_runtime_access(
            state,
            &candidate.provider,
            &candidate.capabilities,
            viewer_user_id,
            is_service_role,
        )?;
        if !status_is_viable(candidate.status.as_str()) {
            return Err(bad_request("runtimeId is not ready for leases"));
        }
        store_local_runtime_preference(
            state,
            &state.runtime_preferences,
            *project_id,
            &candidate,
            viewer_user_id,
            "workspace",
            false,
        )
        .await?;
        return Ok(Some(candidate.id));
    }

    if !allow_infer {
        return Ok(None);
    }

    let inferred =
        infer_runtime_candidate(state, project_id, viewer_user_id, is_service_role).await?;
    if let Some(candidate) = inferred {
        store_local_runtime_preference(
            state,
            &state.runtime_preferences,
            *project_id,
            &candidate,
            viewer_user_id,
            "auto",
            true,
        )
        .await?;
        return Ok(Some(candidate.id));
    }

    Ok(None)
}

pub(crate) async fn runtime_is_viable_candidate(
    state: &AppState,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let candidate = fetch_runtime_candidate(&state.pool, project_id, runtime_id).await?;
    let Some(candidate) = candidate else {
        return Ok(false);
    };
    Ok(candidate.is_recent())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, EventKind, ModifyKind, RemoveKind};
    use tempfile::tempdir;
    use tokio::time::timeout;

    fn create_temp_project() -> (tempfile::TempDir, Uuid, PathBuf, PathBuf) {
        let temp_dir = tempdir().expect("temp dir");
        let project_id = Uuid::new_v4();
        let root = temp_dir.path().to_path_buf();
        let project_root = root.join(project_id.to_string());
        std::fs::create_dir_all(project_root.join("src")).expect("create project directories");
        let file_path = project_root.join("src/app.tsx");
        (temp_dir, project_id, root, file_path)
    }

    #[test]
    fn endpoint_matches_local_detects_loopback_hosts() {
        assert!(endpoint_matches_local(Some("http://127.0.0.1:8900")));
        assert!(endpoint_matches_local(Some("https://localhost:3000")));
        assert!(endpoint_matches_local(Some(
            "http://host.docker.internal:90"
        )));
        assert!(!endpoint_matches_local(Some("https://example.com")));
    }

    #[test]
    fn runtime_recent_respects_ttl() {
        let recent = Utc::now() - ChronoDuration::seconds(30);
        assert!(runtime_is_recent(Some(recent), 60, true));

        let allowance =
            (LOCAL_WORKSPACE_IDLE_TTL_SECONDS as i64).max(*LOCAL_RUNTIME_RECENCY_SECONDS);
        let stale = Utc::now() - ChronoDuration::seconds(allowance + 10);
        assert!(!runtime_is_recent(Some(stale), 30, true));
    }

    #[tokio::test]
    async fn inferred_private_runtime_preference_never_becomes_project_wide() {
        let preferences = RuntimePreferenceRegistry::new();
        let project_id = Uuid::new_v4();
        let owner_user_id = Uuid::new_v4();
        let teammate_user_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let candidate = RuntimeCandidate {
            id: runtime_id,
            provider: "self-hosted".to_string(),
            capabilities: json!({
                "_instafySelfHostedAccess": {
                    "mode": "private",
                    "ownerUserId": owner_user_id.to_string(),
                }
            }),
            status: "ready".to_string(),
            endpoint_url: Some("http://127.0.0.1:8787".to_string()),
            last_seen_at: Some(Utc::now()),
            idle_ttl_seconds: 120,
            display_name: Some("Owner workstation".to_string()),
        };

        store_local_runtime_preference_classified(
            &preferences,
            project_id,
            &candidate,
            Some(owner_user_id),
            "auto",
            true,
            true,
        )
        .await
        .expect("store owner-only inferred preference");

        assert_eq!(
            preferences
                .get_private(&project_id, &owner_user_id)
                .await
                .and_then(|entry| entry.runtime_id),
            Some(runtime_id)
        );
        assert!(preferences.get(&project_id).await.is_none());
        assert!(preferences
            .get_private(&project_id, &teammate_user_id)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn inferred_managed_runtime_preference_remains_project_wide() {
        let preferences = RuntimePreferenceRegistry::new();
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let candidate = RuntimeCandidate {
            id: runtime_id,
            provider: "instafy-cloud".to_string(),
            capabilities: json!({}),
            status: "ready".to_string(),
            endpoint_url: Some("https://runtime.instafy.test".to_string()),
            last_seen_at: Some(Utc::now()),
            idle_ttl_seconds: 600,
            display_name: Some("Hosted Runtime".to_string()),
        };

        store_local_runtime_preference_classified(
            &preferences,
            project_id,
            &candidate,
            Some(Uuid::new_v4()),
            "auto",
            true,
            false,
        )
        .await
        .expect("store shared managed preference");

        assert_eq!(
            preferences
                .get(&project_id)
                .await
                .and_then(|entry| entry.runtime_id),
            Some(runtime_id)
        );
    }

    #[tokio::test]
    async fn handle_notify_event_emits_workspace_change() {
        let (_temp_dir, project_id, root, file_path) = create_temp_project();
        std::fs::write(&file_path, "console.log('hello');").expect("write file");

        let events = EventHub::new();
        let mut receiver = events.subscribe();

        let event = NotifyEvent {
            kind: EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            paths: vec![file_path.clone()],
            attrs: Default::default(),
        };

        handle_notify_event(&events, root.as_path(), event)
            .await
            .expect("handle notify event");

        let received = timeout(std::time::Duration::from_millis(200), receiver.recv())
            .await
            .expect("event available")
            .expect("controller event");

        assert_eq!(received.kind, "workspace.file_changed");
        assert_eq!(received.project_id, Some(project_id));
        let path_value = received
            .data
            .get("path")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        assert_eq!(path_value, "src/app.tsx");
        assert!(
            !received
                .data
                .get("deleted")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false),
            "expected deleted flag to be absent or false"
        );
    }

    #[tokio::test]
    async fn handle_notify_event_marks_deleted_files() {
        let (_temp_dir, project_id, root, file_path) = create_temp_project();
        std::fs::write(&file_path, "console.log('delete');").expect("write file");
        std::fs::remove_file(&file_path).expect("remove file");

        let events = EventHub::new();
        let mut receiver = events.subscribe();

        let event = NotifyEvent {
            kind: EventKind::Remove(RemoveKind::File),
            paths: vec![file_path.clone()],
            attrs: Default::default(),
        };

        handle_notify_event(&events, root.as_path(), event)
            .await
            .expect("handle notify event");

        let received = timeout(std::time::Duration::from_millis(200), receiver.recv())
            .await
            .expect("event available")
            .expect("controller event");

        assert_eq!(received.kind, "workspace.file_changed");
        assert_eq!(received.project_id, Some(project_id));
        let path_value = received
            .data
            .get("path")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        assert_eq!(path_value, "src/app.tsx");
        assert!(
            received
                .data
                .get("deleted")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false),
            "expected deleted flag to be true"
        );
    }

    #[test]
    fn no_op_placeholder_test() {
        // Keep tests module non-empty after removing write-path helpers.
        assert_eq!(2 + 2, 4);
    }
}
