use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{SecondsFormat, Utc};
use origin_http_server::apply::normalize_relative_path;
use origin_http_server::paths::is_reserved_path;
use reqwest::StatusCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::fs;
use tracing::{info, warn};
use uuid::Uuid;
use zip::CompressionMethod;
use zip::write::{FileOptions, ZipWriter};

use super::{CodexFileDescriptor, FileChangeKind, JobMessage, JobMessageSender};
use crate::origin::LocalOriginSync;

#[derive(Debug, Clone)]
pub(crate) struct CommitToOriginResult {
    pub(crate) origin_id: Uuid,
    pub(crate) origin_endpoint: String,
    pub(crate) origin_mode: String,
    pub(crate) lease_id: Uuid,
    pub(crate) apply_rev: Option<String>,
    // Origin HEAD before the apply/sync committed this run's changes — the base
    // for rendering the run's change as a tree-to-tree diff in the chat rail.
    pub(crate) apply_base_rev: Option<String>,
    pub(crate) git_rev: Option<String>,
    pub(crate) git_base_rev: Option<String>,
    pub(crate) git_sync_attempted: bool,
    pub(crate) git_sync_error: Option<String>,
    pub(crate) paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseAcquireRequest {
    project_id: String,
    runtime_id: Option<String>,
    lease_seconds: Option<i64>,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseReleaseRequest {
    lease_id: String,
    project_id: String,
    runtime_id: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    lease_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginAccessTokenRequest {
    project_id: String,
    protocol: String,
    scopes: Vec<String>,
    lease_id: String,
    prefer_runtime: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginAccessTokenResponse {
    origin_id: Uuid,
    endpoint: String,
    mode: String,
    token: String,
    #[serde(default)]
    lease_id: Option<String>,
}

#[derive(Debug)]
struct UploadEntry {
    path: String,
    bytes: Vec<u8>,
    encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyManifestFile {
    path: String,
    size: u64,
    encoding: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyManifest {
    project_id: String,
    lease_id: Option<String>,
    files: Vec<ApplyManifestFile>,
    deletes: Vec<String>,
    generated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginApplyResponse {
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    base_rev: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginGitSyncRequest {
    message: Option<String>,
    paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginGitSyncResponse {
    #[serde(default)]
    rev: Option<String>,
    #[serde(default)]
    base_rev: Option<String>,
}

const ORIGIN_APPLY_MAX_ATTEMPTS: usize = 3;
const ORIGIN_APPLY_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub(crate) enum GitSyncOutcome {
    NotConfigured,
    Synced { rev: Option<String> },
    Conflict { message: String },
    Failed { message: String },
}

fn parse_env_bool(key: &str) -> Option<bool> {
    std::env::var(key)
        .ok()
        .map(|raw| raw.trim().to_ascii_lowercase())
        .and_then(|raw| match raw.as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}

fn should_rewrite_host_docker_internal() -> bool {
    parse_env_bool("RUNTIME_REWRITE_DOCKER_HOST_INTERNAL")
        .unwrap_or_else(|| !Path::new("/.dockerenv").exists())
}

fn normalize_origin_endpoint_for_runtime_with_flag(
    endpoint: &str,
    rewrite_docker_host: bool,
) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }

    // Hosted dev stacks often expose the Origin gateway on the host loopback. Docker runtimes
    // cannot reach the host via 127.0.0.1/localhost, so rewrite to the Docker host gateway
    // hostname when we're running inside a container.
    let runtime_running_in_docker = Path::new("/.dockerenv").exists();

    match Url::parse(trimmed) {
        Ok(mut url) => {
            if rewrite_docker_host && url.host_str() == Some("host.docker.internal") {
                let _ = url.set_host(Some("127.0.0.1"));
            }
            if runtime_running_in_docker
                && !rewrite_docker_host
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            {
                let _ = url.set_host(Some("host.docker.internal"));
            }
            url.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => {
            let mut out = trimmed.to_string();
            if rewrite_docker_host && out.contains("host.docker.internal") {
                out = out.replace("host.docker.internal", "127.0.0.1");
            }
            if runtime_running_in_docker && !rewrite_docker_host {
                // Best-effort rewrite for non-URL strings.
                if out.contains("127.0.0.1") {
                    out = out.replace("127.0.0.1", "host.docker.internal");
                }
                if out.contains("localhost") {
                    out = out.replace("localhost", "host.docker.internal");
                }
            }
            out.trim_end_matches('/').to_string()
        }
    }
}

pub(super) fn normalize_origin_endpoint_for_runtime(endpoint: &str) -> String {
    normalize_origin_endpoint_for_runtime_with_flag(endpoint, should_rewrite_host_docker_internal())
}

/// Pick the endpoint for origin byte transfers (`/apply`, `/git/sync`).
///
/// When the controller-selected origin (`token_origin_id`, from the
/// controller's `/access_token` response) is the origin hosted inside this
/// runtime process, use the local listener directly: routing the transfer
/// through the controller proxy and the public tunnel back into this same
/// process only adds two network hops and every tunnel failure mode (#153).
/// The local endpoint is used verbatim — it points at this process, so the
/// Docker host rewrites for controller-provided endpoints must not apply.
///
/// Authorization is unchanged either way: the caller still acquires the
/// workspace lease and mints the fs.write token from the controller, and the
/// origin server validates that token identically on the loopback listener
/// (same axum middleware, same JWKS, audience = origin id).
///
/// Any other origin keeps the controller-provided endpoint, normalized
/// exactly as before. Returns the endpoint and whether it is local.
fn resolve_origin_sync_endpoint(
    token_origin_id: Uuid,
    token_endpoint: &str,
    local_origin: Option<&LocalOriginSync>,
) -> (String, bool) {
    if let Some(local) = local_origin {
        if local.origin_id == token_origin_id {
            let endpoint = local.endpoint.trim().trim_end_matches('/').to_string();
            if !endpoint.is_empty() {
                return (endpoint, true);
            }
        }
    }
    (normalize_origin_endpoint_for_runtime(token_endpoint), false)
}

fn git_sync_enabled() -> bool {
    parse_env_bool("RUNTIME_GIT_SYNC_AFTER_APPLY").unwrap_or(true)
}

fn should_retry_origin_apply(status: StatusCode, response_body: &str) -> bool {
    status == StatusCode::BAD_GATEWAY
        && response_body.contains("origin proxy request failed")
        && response_body
            .to_ascii_lowercase()
            .contains("connection refused")
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_sync_only(
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    message: &str,
    local_origin: Option<&LocalOriginSync>,
) -> Result<GitSyncOutcome> {
    let has_remote = std::env::var("ORIGIN_GIT_REMOTE_URL")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    if !has_remote {
        return Ok(GitSyncOutcome::NotConfigured);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .context("failed to build git sync http client")?;

    let lease_id = acquire_workspace_lease(
        &client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        job_id,
        run_id,
    )
    .await?;

    let outcome = git_sync_with_lease(
        &client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
        message,
        local_origin,
    )
    .await;

    if let Err(error) = release_workspace_lease(
        &client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
    )
    .await
    {
        warn!(?error, lease_id = %lease_id, "failed to release workspace lease after git sync");
    }

    outcome
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn commit_to_hosted_origin(
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    workspace_dir: &std::path::Path,
    files: &[CodexFileDescriptor],
    auto_sync_after_apply_override: Option<bool>,
    progress_sender: Option<JobMessageSender>,
    local_origin: Option<LocalOriginSync>,
) -> Result<Option<CommitToOriginResult>> {
    let mut uploads = BTreeMap::<String, UploadEntry>::new();
    let mut deletes = BTreeSet::<String>::new();
    let mut changed_paths = BTreeSet::<String>::new();

    for file in files {
        let normalized = normalize_relative_path(&file.workspace_path)
            .or_else(|| normalize_relative_path(&file.path));
        let Some(normalized) = normalized else {
            continue;
        };
        if is_reserved_path(&normalized) {
            continue;
        }

        let change_kind = file.change.as_ref().map(|change| &change.kind);
        if matches!(change_kind, Some(FileChangeKind::Deleted)) {
            uploads.remove(&normalized);
            deletes.insert(normalized.clone());
            changed_paths.insert(normalized);
            continue;
        }

        let absolute = workspace_dir.join(&normalized);
        let metadata = match fs::symlink_metadata(&absolute).await {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                warn!(
                    path = %normalized,
                    absolute = %absolute.display(),
                    "workspace sync skipped missing path"
                );
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to stat workspace path {}", absolute.display())
                });
            }
        };
        if metadata.is_dir() {
            warn!(
                path = %normalized,
                absolute = %absolute.display(),
                "workspace sync skipped directory path"
            );
            continue;
        }
        if !metadata.is_file() {
            warn!(
                path = %normalized,
                absolute = %absolute.display(),
                "workspace sync skipped non-file path"
            );
            continue;
        }
        let bytes = fs::read(&absolute)
            .await
            .with_context(|| format!("failed to read workspace file {}", absolute.display()))?;
        let encoding = if std::str::from_utf8(&bytes).is_ok() {
            "utf8"
        } else {
            "binary"
        };
        deletes.remove(&normalized);
        uploads.insert(
            normalized.clone(),
            UploadEntry {
                path: normalized.clone(),
                bytes,
                encoding: encoding.to_string(),
            },
        );
        changed_paths.insert(normalized);
    }

    let uploads: Vec<UploadEntry> = uploads.into_values().collect();
    let deletes: Vec<String> = deletes.into_iter().collect();
    let changed_paths: Vec<String> = changed_paths.into_iter().collect();

    if uploads.is_empty() && deletes.is_empty() {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .context("failed to build workspace commit http client")?;

    let lease_id = acquire_workspace_lease(
        &client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        job_id,
        run_id,
    )
    .await?;

    let mut lease_released = false;
    let auto_sync_after_apply = auto_sync_after_apply_override.unwrap_or_else(git_sync_enabled);
    let result = commit_with_lease(
        &client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
        &uploads,
        &deletes,
        &changed_paths,
        auto_sync_after_apply,
        progress_sender,
        local_origin.as_ref(),
    )
    .await;

    if let Err(error) = release_workspace_lease(
        &client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
    )
    .await
    {
        warn!(?error, lease_id = %lease_id, "failed to release workspace lease after commit");
    } else {
        lease_released = true;
    }

    let mut commit_result = result?;
    commit_result.lease_id = lease_id;
    commit_result.paths = changed_paths;

    if !lease_released {
        warn!(lease_id = %lease_id, "workspace lease was not released cleanly");
    }

    Ok(Some(commit_result))
}

async fn acquire_workspace_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
) -> Result<Uuid> {
    let url = controller_base_url
        .join("/lease/acquire")
        .context("controller base URL invalid for lease acquire")?;

    let metadata = json!({
        "source": "runtime-agent",
        "jobId": job_id.to_string(),
        "runId": run_id.map(|value| value.to_string()),
        "runtimeId": runtime_id.to_string(),
    });

    let body = LeaseAcquireRequest {
        project_id: project_id.to_string(),
        runtime_id: Some(runtime_id.to_string()),
        lease_seconds: Some(120),
        metadata: Some(metadata),
    };

    let response = client
        .post(url)
        .bearer_auth(controller_token)
        .json(&body)
        .send()
        .await
        .context("workspace lease acquire request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status == StatusCode::CONFLICT {
        bail!("workspace lease conflict: {}", text);
    }
    if !status.is_success() {
        bail!("workspace lease acquire failed ({}): {}", status, text);
    }

    let parsed: LeaseResponse =
        serde_json::from_str(&text).context("failed to parse lease acquire response")?;
    Ok(parsed.lease_id)
}

async fn release_workspace_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
) -> Result<()> {
    let url = controller_base_url
        .join("/lease/release")
        .context("controller base URL invalid for lease release")?;

    let body = LeaseReleaseRequest {
        lease_id: lease_id.to_string(),
        project_id: project_id.to_string(),
        runtime_id: Some(runtime_id.to_string()),
        status: Some("released".to_string()),
    };

    let response = client
        .post(url)
        .bearer_auth(controller_token)
        .json(&body)
        .send()
        .await
        .context("workspace lease release request failed")?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        bail!("workspace lease release failed ({}): {}", status, text);
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn git_sync_with_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    message: &str,
    local_origin: Option<&LocalOriginSync>,
) -> Result<GitSyncOutcome> {
    let access_token_url = controller_base_url
        .join("/access_token")
        .context("controller base URL invalid for origin access token")?;
    let access_body = OriginAccessTokenRequest {
        project_id: project_id.to_string(),
        protocol: "http".to_string(),
        scopes: vec!["fs.write".to_string()],
        lease_id: lease_id.to_string(),
        prefer_runtime: runtime_id.to_string(),
    };

    let response = client
        .post(access_token_url)
        .bearer_auth(controller_token)
        .json(&access_body)
        .send()
        .await
        .context("origin access token request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("origin access token failed ({}): {}", status, text);
    }

    let token: OriginAccessTokenResponse =
        serde_json::from_str(&text).context("failed to parse origin access token response")?;

    let (endpoint, endpoint_is_local) =
        resolve_origin_sync_endpoint(token.origin_id, token.endpoint.as_str(), local_origin);
    if endpoint.is_empty() {
        bail!("origin access token response missing endpoint");
    }
    if endpoint_is_local {
        info!(
            origin_id = %token.origin_id,
            endpoint = %endpoint,
            "git sync targeting the origin hosted by this runtime; using the local listener instead of the tunnel"
        );
    }

    let url = format!("{}/git/sync", endpoint);
    let body = OriginGitSyncRequest {
        message: Some(message.to_string()),
        paths: None,
    };

    let response = client
        .post(url)
        .bearer_auth(&token.token)
        .json(&body)
        .send()
        .await
        .context("origin git sync request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();

    if status == StatusCode::CONFLICT {
        return Ok(GitSyncOutcome::Conflict { message: text });
    }

    if !status.is_success() {
        return Ok(GitSyncOutcome::Failed {
            message: format!("{}: {}", status, text.trim()),
        });
    }

    let parsed: OriginGitSyncResponse =
        serde_json::from_str(&text).unwrap_or(OriginGitSyncResponse {
            rev: None,
            base_rev: None,
        });

    Ok(GitSyncOutcome::Synced { rev: parsed.rev })
}

#[allow(clippy::too_many_arguments)]
async fn commit_with_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    uploads: &[UploadEntry],
    deletes: &[String],
    paths: &[String],
    auto_sync_after_apply: bool,
    progress_sender: Option<JobMessageSender>,
    local_origin: Option<&LocalOriginSync>,
) -> Result<CommitToOriginResult> {
    let access_token_url = controller_base_url
        .join("/access_token")
        .context("controller base URL invalid for origin access token")?;
    let access_body = OriginAccessTokenRequest {
        project_id: project_id.to_string(),
        protocol: "http".to_string(),
        scopes: vec!["fs.write".to_string()],
        lease_id: lease_id.to_string(),
        prefer_runtime: runtime_id.to_string(),
    };

    let response = client
        .post(access_token_url)
        .bearer_auth(controller_token)
        .json(&access_body)
        .send()
        .await
        .context("origin access token request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("origin access token failed ({}): {}", status, text);
    }

    let token: OriginAccessTokenResponse =
        serde_json::from_str(&text).context("failed to parse origin access token response")?;

    let (endpoint, endpoint_is_local) =
        resolve_origin_sync_endpoint(token.origin_id, token.endpoint.as_str(), local_origin);
    if endpoint.is_empty() {
        bail!("origin access token response missing endpoint");
    }
    if endpoint_is_local {
        info!(
            origin_id = %token.origin_id,
            endpoint = %endpoint,
            "workspace apply targeting the origin hosted by this runtime; using the local listener instead of the tunnel"
        );
    }

    if let Some(sender) = progress_sender.as_ref() {
        let _ = sender.send(JobMessage {
            content: "Applying changes to workspace…".to_string(),
            message_type: Some("status".to_string()),
            metadata: Some(json!({
              "kind": "workspace_commit",
              "status": "applying",
              "endpoint": endpoint,
            })),
        });
    }

    let archive_bytes = build_zip_archive(uploads)?;
    let manifest = ApplyManifest {
        project_id: project_id.to_string(),
        lease_id: token
            .lease_id
            .clone()
            .or_else(|| Some(lease_id.to_string())),
        files: uploads
            .iter()
            .map(|entry| ApplyManifestFile {
                path: entry.path.clone(),
                size: entry.bytes.len() as u64,
                encoding: entry.encoding.clone(),
            })
            .collect(),
        deletes: deletes.to_vec(),
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };

    let apply_url = format!("{}/apply", endpoint);
    let manifest_json = serde_json::to_vec(&manifest).context("failed to encode apply manifest")?;

    let text = send_origin_apply_with_retry(
        client,
        &apply_url,
        &token.token,
        &manifest_json,
        &archive_bytes,
    )
    .await?;

    let apply_response: OriginApplyResponse =
        serde_json::from_str(&text).unwrap_or(OriginApplyResponse {
            rev: None,
            base_rev: None,
        });

    let mut git_rev = None;
    let mut git_base_rev = None;
    let mut git_sync_attempted = false;
    let mut git_sync_error = None;
    if auto_sync_after_apply {
        git_sync_attempted = true;
        match try_git_sync(client, &endpoint, &token.token, project_id, paths).await {
            Ok(synced) => {
                git_rev = synced.rev;
                git_base_rev = synced.base_rev;
            }
            Err(error) => {
                warn!(?error, project_id = %project_id, "git sync after apply failed");
                git_sync_error = Some(error.to_string());
            }
        };
    }

    Ok(CommitToOriginResult {
        origin_id: token.origin_id,
        origin_endpoint: endpoint,
        origin_mode: token.mode,
        lease_id,
        apply_rev: apply_response.rev,
        apply_base_rev: apply_response.base_rev,
        git_rev,
        git_base_rev,
        git_sync_attempted,
        git_sync_error,
        paths: Vec::new(),
    })
}

async fn send_origin_apply_with_retry(
    client: &reqwest::Client,
    apply_url: &str,
    token: &str,
    manifest_json: &[u8],
    archive_bytes: &[u8],
) -> Result<String> {
    for attempt in 1..=ORIGIN_APPLY_MAX_ATTEMPTS {
        let form = reqwest::multipart::Form::new()
            .part(
                "manifest",
                reqwest::multipart::Part::bytes(manifest_json.to_vec())
                    .file_name("manifest.json")
                    .mime_str("application/json")
                    .context("failed to build manifest multipart part")?,
            )
            .part(
                "archive",
                reqwest::multipart::Part::bytes(archive_bytes.to_vec())
                    .file_name("workspace.zip")
                    .mime_str("application/zip")
                    .context("failed to build archive multipart part")?,
            );

        let response = client
            .post(apply_url)
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
            .context("origin apply request failed")?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return Ok(text);
        }
        if attempt == ORIGIN_APPLY_MAX_ATTEMPTS || !should_retry_origin_apply(status, &text) {
            bail!("origin apply failed ({}): {}", status, text);
        }

        warn!(
            attempt,
            max_attempts = ORIGIN_APPLY_MAX_ATTEMPTS,
            "origin apply proxy was temporarily unavailable; retrying"
        );
        tokio::time::sleep(ORIGIN_APPLY_RETRY_DELAY).await;
    }

    unreachable!("bounded origin apply retry loop always returns")
}

fn build_zip_archive(files: &[UploadEntry]) -> Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);
        let mut unique_files = BTreeMap::<String, &UploadEntry>::new();
        for entry in files {
            let archive_path = normalize_upload_archive_path(&entry.path)
                .with_context(|| format!("failed to package workspace file {}", entry.path))?;
            unique_files.insert(archive_path, entry);
        }
        for (archive_path, entry) in unique_files {
            zip.start_file(archive_path.as_str(), options)
                .with_context(|| format!("failed to package workspace file {}", archive_path))?;
            zip.write_all(&entry.bytes)
                .with_context(|| format!("failed to package workspace file {}", archive_path))?;
        }
        zip.finish()
            .context("failed to package workspace changes")?;
    }
    Ok(cursor.into_inner())
}

fn normalize_upload_archive_path(path: &str) -> Result<String> {
    let Some(normalized) = normalize_relative_path(path) else {
        bail!("invalid workspace file path");
    };
    if is_reserved_path(&normalized) {
        bail!("reserved workspace file path");
    }
    Ok(normalized)
}

async fn try_git_sync(
    client: &reqwest::Client,
    endpoint: &str,
    origin_token: &str,
    project_id: Uuid,
    paths: &[String],
) -> Result<OriginGitSyncResponse> {
    let url = format!("{}/git/sync", endpoint.trim_end_matches('/'));
    let message = format!("instafy: agent sync (project {} )", project_id);
    let body = OriginGitSyncRequest {
        message: Some(message),
        paths: Some(paths.to_vec()),
    };

    let response = client
        .post(url)
        .bearer_auth(origin_token)
        .json(&body)
        .send()
        .await
        .context("origin git sync request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let details = text.trim();
        if details.is_empty() {
            bail!("origin git sync failed ({status})");
        }
        bail!("origin git sync failed ({status}): {details}");
    }

    let parsed: OriginGitSyncResponse =
        serde_json::from_str(&text).unwrap_or(OriginGitSyncResponse {
            rev: None,
            base_rev: None,
        });
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::extract::State;
    use axum::http::StatusCode as AxumStatusCode;
    use axum::routing::post;
    use std::io::{Cursor, Read};

    use zip::ZipArchive;

    use super::normalize_origin_endpoint_for_runtime_with_flag;
    use super::{
        UploadEntry, build_zip_archive, send_origin_apply_with_retry, should_retry_origin_apply,
    };
    use reqwest::StatusCode;

    use std::net::SocketAddr;

    use anyhow::{Context, Result, ensure};
    use uuid::Uuid;

    use super::super::{CodexFileDescriptor, FileChangeDescriptor, FileChangeKind};
    use super::{commit_to_hosted_origin, resolve_origin_sync_endpoint};
    use crate::origin::LocalOriginSync;

    fn changed_file_descriptor(path: &str) -> CodexFileDescriptor {
        CodexFileDescriptor {
            path: path.to_string(),
            workspace_path: path.to_string(),
            label: None,
            description: None,
            mime_type: None,
            content: None,
            content_base64: None,
            change: Some(FileChangeDescriptor {
                kind: FileChangeKind::Changed,
                lines: Vec::new(),
                raw: serde_json::json!({ "type": "changed" }),
            }),
        }
    }

    /// Origin stand-in serving /apply and /git/sync, counting apply hits.
    async fn spawn_origin_server(rev: &'static str) -> (SocketAddr, Arc<AtomicUsize>) {
        async fn git_sync() -> (AxumStatusCode, &'static str) {
            (
                AxumStatusCode::OK,
                r#"{"rev":"gitrev","baseRev":"gitbase"}"#,
            )
        }

        let apply_hits = Arc::new(AtomicUsize::new(0));
        let hits_for_apply = apply_hits.clone();
        let app = Router::new()
            .route(
                "/apply",
                post(move || {
                    let hits = hits_for_apply.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            AxumStatusCode::OK,
                            format!(r#"{{"rev":"{rev}","baseRev":"base"}}"#),
                        )
                    }
                }),
            )
            .route("/git/sync", post(git_sync));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, apply_hits)
    }

    /// Controller stand-in: grants the workspace lease and mints the origin
    /// access token (naming `origin_id` and pointing at `origin_endpoint`),
    /// counting token mints.
    async fn spawn_stub_controller(
        origin_id: Uuid,
        origin_endpoint: String,
    ) -> (SocketAddr, Arc<AtomicUsize>) {
        #[derive(Clone)]
        struct ControllerState {
            origin_id: Uuid,
            origin_endpoint: String,
            token_mints: Arc<AtomicUsize>,
        }

        async fn lease_acquire() -> (AxumStatusCode, String) {
            (
                AxumStatusCode::OK,
                format!(r#"{{"leaseId":"{}"}}"#, Uuid::new_v4()),
            )
        }

        async fn lease_release() -> (AxumStatusCode, &'static str) {
            (AxumStatusCode::OK, "{}")
        }

        async fn access_token(State(state): State<ControllerState>) -> (AxumStatusCode, String) {
            state.token_mints.fetch_add(1, Ordering::SeqCst);
            (
                AxumStatusCode::OK,
                format!(
                    r#"{{"originId":"{}","endpoint":"{}","mode":"hosted","token":"origin-token"}}"#,
                    state.origin_id, state.origin_endpoint
                ),
            )
        }

        let token_mints = Arc::new(AtomicUsize::new(0));
        let state = ControllerState {
            origin_id,
            origin_endpoint,
            token_mints: token_mints.clone(),
        };
        let app = Router::new()
            .route("/lease/acquire", post(lease_acquire))
            .route("/lease/release", post(lease_release))
            .route("/access_token", post(access_token))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, token_mints)
    }

    #[test]
    fn resolve_origin_sync_endpoint_prefers_the_local_listener_for_the_hosted_origin() {
        let origin_id = Uuid::new_v4();
        let local = LocalOriginSync {
            origin_id,
            endpoint: "http://127.0.0.1:54332/".to_string(),
        };

        let (endpoint, is_local) =
            resolve_origin_sync_endpoint(origin_id, "https://abc123.rt.instafy.dev", Some(&local));
        assert!(is_local);
        assert_eq!(endpoint, "http://127.0.0.1:54332");
    }

    #[test]
    fn resolve_origin_sync_endpoint_keeps_the_controller_endpoint_for_other_origins() {
        let local = LocalOriginSync {
            origin_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:54332".to_string(),
        };

        let (endpoint, is_local) = resolve_origin_sync_endpoint(
            Uuid::new_v4(),
            "https://abc123.rt.instafy.dev/",
            Some(&local),
        );
        assert!(!is_local);
        assert_eq!(endpoint, "https://abc123.rt.instafy.dev");

        let (endpoint, is_local) =
            resolve_origin_sync_endpoint(Uuid::new_v4(), "https://abc123.rt.instafy.dev", None);
        assert!(!is_local);
        assert_eq!(endpoint, "https://abc123.rt.instafy.dev");
    }

    #[test]
    fn resolve_origin_sync_endpoint_ignores_an_empty_local_endpoint() {
        let origin_id = Uuid::new_v4();
        let local = LocalOriginSync {
            origin_id,
            endpoint: "   ".to_string(),
        };

        let (endpoint, is_local) =
            resolve_origin_sync_endpoint(origin_id, "https://abc123.rt.instafy.dev", Some(&local));
        assert!(!is_local);
        assert_eq!(endpoint, "https://abc123.rt.instafy.dev");
    }

    #[tokio::test]
    async fn local_origin_apply_bypasses_the_tunnel_but_keeps_the_controller_token_mint()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(workspace.join("notes"))?;
        std::fs::write(workspace.join("notes/status.md"), "fresh contents\n")?;

        let origin_id = Uuid::new_v4();
        let (local_origin_address, local_apply_hits) = spawn_origin_server("localrev").await;
        let (tunnel_address, tunnel_apply_hits) = spawn_origin_server("tunnelrev").await;
        let (controller_address, token_mints) =
            spawn_stub_controller(origin_id, format!("http://{tunnel_address}")).await;
        let controller_base_url = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let result = commit_to_hosted_origin(
            &controller_base_url,
            "controller-token",
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            None,
            &workspace,
            &[changed_file_descriptor("notes/status.md")],
            Some(true),
            None,
            Some(LocalOriginSync {
                origin_id,
                endpoint: format!("http://{local_origin_address}"),
            }),
        )
        .await?
        .context("expected a commit result")?;

        ensure!(result.apply_rev.as_deref() == Some("localrev"));
        ensure!(result.origin_id == origin_id);
        ensure!(result.git_sync_attempted);
        ensure!(result.git_rev.as_deref() == Some("gitrev"));
        ensure!(
            local_apply_hits.load(Ordering::SeqCst) == 1,
            "apply must hit the local origin listener"
        );
        ensure!(
            tunnel_apply_hits.load(Ordering::SeqCst) == 0,
            "apply must not travel through the controller-provided tunnel endpoint"
        );
        ensure!(
            token_mints.load(Ordering::SeqCst) == 1,
            "the controller token mint is the authorization gate and must be kept"
        );
        Ok(())
    }

    #[tokio::test]
    async fn remote_origin_apply_still_uses_the_controller_provided_endpoint() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(workspace.join("notes"))?;
        std::fs::write(workspace.join("notes/status.md"), "fresh contents\n")?;

        let (local_origin_address, local_apply_hits) = spawn_origin_server("localrev").await;
        let (tunnel_address, tunnel_apply_hits) = spawn_origin_server("tunnelrev").await;
        let (controller_address, token_mints) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{tunnel_address}")).await;
        let controller_base_url = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let result = commit_to_hosted_origin(
            &controller_base_url,
            "controller-token",
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            None,
            &workspace,
            &[changed_file_descriptor("notes/status.md")],
            Some(false),
            None,
            Some(LocalOriginSync {
                origin_id: Uuid::new_v4(),
                endpoint: format!("http://{local_origin_address}"),
            }),
        )
        .await?
        .context("expected a commit result")?;

        ensure!(result.apply_rev.as_deref() == Some("tunnelrev"));
        ensure!(
            tunnel_apply_hits.load(Ordering::SeqCst) == 1,
            "an origin hosted elsewhere must keep the controller-provided endpoint"
        );
        ensure!(local_apply_hits.load(Ordering::SeqCst) == 0);
        ensure!(token_mints.load(Ordering::SeqCst) == 1);
        Ok(())
    }

    #[test]
    fn normalize_origin_endpoint_for_runtime_rewrites_docker_host_when_requested() {
        let input = "http://host.docker.internal:61232/";
        let normalized = normalize_origin_endpoint_for_runtime_with_flag(input, true);
        assert_eq!(normalized, "http://127.0.0.1:61232");
    }

    #[test]
    fn normalize_origin_endpoint_for_runtime_keeps_docker_host_when_not_rewriting() {
        let input = "http://host.docker.internal:61232/";
        let normalized = normalize_origin_endpoint_for_runtime_with_flag(input, false);
        assert_eq!(normalized, "http://host.docker.internal:61232");
    }

    #[test]
    fn origin_apply_retries_connection_refused_from_proxy() {
        let response = r#"{"message":"origin proxy request failed: tcp connect error: Connection refused (os error 111)"}"#;
        assert!(should_retry_origin_apply(StatusCode::BAD_GATEWAY, response));
    }

    #[test]
    fn origin_apply_does_not_retry_other_bad_gateway_responses() {
        assert!(!should_retry_origin_apply(
            StatusCode::BAD_GATEWAY,
            r#"{"message":"origin proxy request failed: request timed out"}"#,
        ));
        assert!(!should_retry_origin_apply(
            StatusCode::SERVICE_UNAVAILABLE,
            "Connection refused",
        ));
    }

    #[tokio::test]
    async fn origin_apply_retries_a_temporarily_unavailable_proxy() {
        async fn apply(State(attempts): State<Arc<AtomicUsize>>) -> (AxumStatusCode, &'static str) {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                (
                    AxumStatusCode::BAD_GATEWAY,
                    "origin proxy request failed: Connection refused",
                )
            } else {
                (AxumStatusCode::OK, r#"{"rev":"abc123"}"#)
            }
        }

        let attempts = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/apply", post(apply))
            .with_state(attempts.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = send_origin_apply_with_retry(
            &reqwest::Client::new(),
            &format!("http://{address}/apply"),
            "token",
            br#"{"projectId":"project"}"#,
            b"archive",
        )
        .await
        .unwrap();

        assert_eq!(response, r#"{"rev":"abc123"}"#);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn build_zip_archive_deduplicates_duplicate_paths() {
        let archive = build_zip_archive(&[
            UploadEntry {
                path: "repos/example/README.md".to_string(),
                bytes: b"old".to_vec(),
                encoding: "utf8".to_string(),
            },
            UploadEntry {
                path: "repos/example/README.md".to_string(),
                bytes: b"new".to_vec(),
                encoding: "utf8".to_string(),
            },
        ])
        .unwrap();

        let mut zip = ZipArchive::new(Cursor::new(archive)).unwrap();
        assert_eq!(zip.len(), 1);
        let mut entry = zip.by_name("repos/example/README.md").unwrap();
        let mut text = String::new();
        entry.read_to_string(&mut text).unwrap();
        assert_eq!(text, "new");
    }

    #[test]
    fn build_zip_archive_reports_invalid_paths_without_zip_jargon() {
        let error = build_zip_archive(&[UploadEntry {
            path: "../README.md".to_string(),
            bytes: b"bad".to_vec(),
            encoding: "utf8".to_string(),
        }])
        .unwrap_err();

        let message = format!("{error:#}");
        assert!(message.contains("failed to package workspace file ../README.md"));
        assert!(message.contains("invalid workspace file path"));
        assert!(!message.contains("zip entry"));
    }
}
