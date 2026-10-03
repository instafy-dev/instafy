use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
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

use super::save_report::{OriginSaveResponse, SaveReport};
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
    /// What did not reach canonical `main`, and where it is kept.
    pub(crate) save: SaveReport,
    pub(crate) paths: Vec<String>,
}

impl CommitToOriginResult {
    /// The "Not saved: ..." sentences for this checkpoint: paths the origin
    /// left out, and every path when the save failed as a whole.
    pub(crate) fn not_saved_sentences(&self) -> Vec<String> {
        if !self.git_sync_attempted {
            return Vec::new();
        }
        let failed_whole = self
            .git_sync_error
            .as_deref()
            .is_some_and(|error| !super::git_sync_error_is_history_exclusion(error));
        let unsaved = if failed_whole {
            self.paths.as_slice()
        } else {
            &[]
        };
        self.save
            .not_saved_sentences(unsaved, self.git_sync_error.as_deref())
    }
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

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginGitSyncRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paths: Option<Vec<String>>,
    /// `"refresh"`: publish nothing new, push parked work, publish commits
    /// already on the local branch and move the checkout to `main`.
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
}

const ORIGIN_APPLY_MAX_ATTEMPTS: usize = 3;
const ORIGIN_APPLY_RETRY_DELAY: Duration = Duration::from_millis(250);
/// Another writer (a parallel worker's checkpoint, a person saving in Files)
/// may hold the workspace lease for a moment; wait this long between tries.
const LEASE_CONFLICT_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(750),
    Duration::from_millis(1500),
];
/// How long the refresh before a turn may take before the turn goes ahead
/// without it.
const PRE_TURN_REFRESH_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone)]
pub(crate) enum GitSyncOutcome {
    NotConfigured,
    Synced {
        rev: Option<String>,
        report: SaveReport,
    },
    /// Nothing reached canonical `main`; the report says where it is kept.
    NotSaved {
        message: String,
        report: SaveReport,
    },
    /// A 409 from an origin that does not report where the work is kept.
    Conflict {
        message: String,
    },
    /// The workspace is stopping: a stop already kept its work on recovery
    /// refs, and saves wait for the next start. Nothing needs resolving.
    Stopping {
        message: String,
    },
    Failed {
        message: String,
    },
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
        if file.is_read_reference() {
            continue;
        }
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

/// Where a command lane's checkpoint goes and the gates it must pass: the same job-level
/// inputs a model turn hands to `commit_to_hosted_origin`.
pub(crate) struct LaneCheckpoint<'a> {
    /// The command lane that wrote the files, such as `skills/import`. Recorded on the
    /// `origin/apply` artifact so a reader can tell the lane's checkpoint from a model turn's.
    pub(crate) lane: &'static str,
    pub(crate) commit_to_workspace: bool,
    /// The job's write scope is read-only (`read_only`, `readonly` or
    /// `coordination_required`). A model turn keeps only coordination files then, and a
    /// lane's files are never coordination files, so the lane skips its checkpoint.
    pub(crate) read_only_workspace: bool,
    pub(crate) controller_base_url: &'a Url,
    /// The verified workspace token, bound to this job's run. It does not prove the run may
    /// write: a job without the separate workspace token falls back to its controller token.
    /// The controller checks write permission again when the checkpoint asks for a lease.
    pub(crate) workspace_token: Option<&'a str>,
    pub(crate) project_id: Uuid,
    pub(crate) runtime_id: Uuid,
    pub(crate) job_id: Uuid,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) workspace_dir: &'a Path,
    pub(crate) auto_sync_after_apply_override: Option<bool>,
    pub(crate) progress_sender: Option<JobMessageSender>,
    pub(crate) local_origin: Option<LocalOriginSync>,
}

/// Hand files a command lane wrote itself, such as a skill folder from `/skills import`, to
/// the protected checkpoint a model turn's files go through, behind the same gates: the job
/// commits to the workspace, its write scope is not read-only and it has a verified
/// workspace token for its run. The controller then decides whether the run may write.
/// Returns the artifacts that record the outcome, in the shape a model turn records, with
/// the lane named on the `origin/apply` artifact.
///
/// Unlike a model turn, a checkpoint error does not fail the job: the lane's files are
/// already in place, so the error is recorded as an `origin/apply-error` artifact. A space
/// without a git remote is not an error here either: the origin applies the files and the
/// failed save is recorded as `gitSyncStatus: "failed"`, as it is for a model turn.
pub(crate) async fn checkpoint_lane_files(
    checkpoint: LaneCheckpoint<'_>,
    files: &[CodexFileDescriptor],
) -> Vec<JsonValue> {
    checkpoint_lane_files_with_report(checkpoint, files).await.0
}

/// [`checkpoint_lane_files`], also returning the "Not saved: ..." sentences
/// for the paths that did not reach canonical `main`.
pub(crate) async fn checkpoint_lane_files_with_report(
    checkpoint: LaneCheckpoint<'_>,
    files: &[CodexFileDescriptor],
) -> (Vec<JsonValue>, Vec<String>) {
    if !checkpoint.commit_to_workspace || files.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if checkpoint.read_only_workspace {
        return (
            vec![json!({
                "kind": "origin/apply-skipped",
                "metadata": { "reason": "read_only_workspace" }
            })],
            Vec::new(),
        );
    }
    let Some(token) = checkpoint.workspace_token else {
        return (
            vec![json!({
                "kind": "origin/apply-skipped",
                "metadata": { "reason": "missing_controller_token" }
            })],
            Vec::new(),
        );
    };

    if let Some(sender) = checkpoint.progress_sender.as_ref() {
        let _ = sender.send(JobMessage {
            content: "Syncing workspace changes…".to_string(),
            message_type: Some("status".to_string()),
            metadata: Some(json!({
                "kind": "workspace_commit",
                "status": "started",
            })),
        });
    }

    match commit_to_hosted_origin(
        checkpoint.controller_base_url,
        token,
        checkpoint.project_id,
        checkpoint.runtime_id,
        checkpoint.job_id,
        checkpoint.run_id,
        checkpoint.workspace_dir,
        files,
        checkpoint.auto_sync_after_apply_override,
        checkpoint.progress_sender.clone(),
        checkpoint.local_origin,
    )
    .await
    {
        Ok(Some(result)) => {
            if let Some(sender) = checkpoint.progress_sender.as_ref() {
                let _ = sender.send(super::workspace_commit_progress_message(&result));
            }
            (
                vec![super::origin_apply_artifact(&result, Some(checkpoint.lane))],
                result.not_saved_sentences(),
            )
        }
        Ok(None) => (Vec::new(), Vec::new()),
        Err(error) => {
            warn!(
                ?error,
                project_id = %checkpoint.project_id,
                job_id = %checkpoint.job_id,
                "command lane workspace checkpoint failed; the files stay on this machine"
            );
            let paths = files
                .iter()
                .filter(|file| !file.is_read_reference())
                .map(|file| file.workspace_path.clone())
                .collect::<Vec<_>>();
            (
                vec![json!({
                    "kind": "origin/apply-error",
                    "metadata": { "error": error.to_string() }
                })],
                SaveReport::default().not_saved_sentences(&paths, Some(&error.to_string())),
            )
        }
    }
}

/// Acquire the workspace lease for a checkpoint, waiting briefly while
/// another writer holds it.
async fn acquire_workspace_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
) -> Result<Uuid> {
    let mut delays = LEASE_CONFLICT_RETRY_DELAYS.iter();
    loop {
        match acquire_workspace_lease_once(
            client,
            controller_base_url,
            controller_token,
            project_id,
            runtime_id,
            job_id,
            run_id,
        )
        .await
        {
            Ok(lease_id) => return Ok(lease_id),
            Err(error @ LeaseAcquireError::Conflict(_)) => match delays.next() {
                Some(delay) => tokio::time::sleep(*delay).await,
                None => return Err(error.into()),
            },
            Err(error) => return Err(error.into()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum LeaseAcquireError {
    #[error("workspace lease conflict: {0}")]
    Conflict(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

async fn acquire_workspace_lease_once(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
) -> std::result::Result<Uuid, LeaseAcquireError> {
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
        return Err(LeaseAcquireError::Conflict(text));
    }
    if !status.is_success() {
        return Err(anyhow!("workspace lease acquire failed ({}): {}", status, text).into());
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

/// An `fs.write` origin token for the leased workspace and the endpoint to
/// use it on.
struct OriginWriteAccess {
    token: OriginAccessTokenResponse,
    endpoint: String,
}

/// Mint an `fs.write` origin token under `lease_id` and pick the endpoint:
/// this process's own listener when the controller selected the origin it
/// hosts, otherwise the controller-provided endpoint.
#[allow(clippy::too_many_arguments)]
async fn origin_write_access(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    local_origin: Option<&LocalOriginSync>,
    purpose: &'static str,
) -> Result<OriginWriteAccess> {
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
            purpose,
            "targeting the origin hosted by this runtime; using the local listener instead of the tunnel"
        );
    }
    Ok(OriginWriteAccess { token, endpoint })
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
    let access = origin_write_access(
        client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
        local_origin,
        "git sync",
    )
    .await?;

    let url = format!("{}/git/sync", access.endpoint);
    let body = OriginGitSyncRequest {
        message: Some(message.to_string()),
        ..OriginGitSyncRequest::default()
    };

    let response = client
        .post(url)
        .bearer_auth(&access.token.token)
        .json(&body)
        .send()
        .await
        .context("origin git sync request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed = OriginSaveResponse::parse(&text);

    if parsed.is_not_saved() {
        let message = parsed
            .error
            .clone()
            .unwrap_or_else(|| format!("{}: {}", status, text.trim()));
        return Ok(GitSyncOutcome::NotSaved {
            message,
            report: parsed.save_report(),
        });
    }

    if parsed.is_workspace_stopping() {
        return Ok(GitSyncOutcome::Stopping {
            message: parsed
                .error
                .clone()
                .unwrap_or_else(|| "the workspace is stopping".to_string()),
        });
    }

    if status == StatusCode::CONFLICT {
        return Ok(GitSyncOutcome::Conflict { message: text });
    }

    if !status.is_success() {
        return Ok(GitSyncOutcome::Failed {
            message: format!("{}: {}", status, text.trim()),
        });
    }

    Ok(GitSyncOutcome::Synced {
        rev: parsed.rev.clone(),
        report: parsed.save_report(),
    })
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
    let OriginWriteAccess { token, endpoint } = origin_write_access(
        client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
        local_origin,
        "workspace apply",
    )
    .await?;

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
    let mut save = SaveReport::default();
    if auto_sync_after_apply {
        git_sync_attempted = true;
        match try_git_sync(client, &endpoint, &token.token, project_id, paths).await {
            Ok(synced) if synced.is_not_saved() => {
                // Nothing reached `main`; the report says where it is kept.
                git_base_rev = synced.base_rev.clone();
                save = synced.save_report();
                let error = synced
                    .error
                    .clone()
                    .or_else(|| synced.failure.clone())
                    .unwrap_or_else(|| "Not saved".to_string());
                warn!(error = %error, project_id = %project_id, "git sync after apply saved nothing");
                git_sync_error = Some(error);
            }
            Ok(synced) => {
                save = synced.save_report();
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
        save,
        paths: Vec::new(),
    })
}

/// Where the refresh before a turn goes and with what credential.
pub(crate) struct PreTurnRefresh<'a> {
    pub(crate) controller_base_url: &'a Url,
    /// The job's verified workspace token. Without it (or without a lease)
    /// only the read-only refresh can run.
    pub(crate) workspace_token: Option<&'a str>,
    pub(crate) project_id: Uuid,
    pub(crate) runtime_id: Uuid,
    pub(crate) job_id: Uuid,
    pub(crate) run_id: Option<Uuid>,
    /// The origin this process hosts. The refresh only ever moves this
    /// runtime's own checkout.
    pub(crate) local_origin: Option<LocalOriginSync>,
    /// The workspace has a canonical remote to refresh from.
    pub(crate) has_git_remote: bool,
}

/// What the refresh before a turn did. It never fails the turn.
#[derive(Debug, Clone, Default)]
pub(crate) struct PreTurnRefreshOutcome {
    /// `refresh` (under a workspace lease), `read_only` (no lease: fetch and
    /// follow `main` only when nothing local is unpublished), `skipped` or
    /// `failed`.
    pub(crate) mode: &'static str,
    pub(crate) response: Option<OriginSaveResponse>,
    pub(crate) error: Option<String>,
    /// Why no workspace lease was used, when the read-only refresh ran.
    pub(crate) lease_error: Option<String>,
    pub(crate) skipped_reason: Option<&'static str>,
}

impl PreTurnRefreshOutcome {
    fn skipped(reason: &'static str, lease_error: Option<String>) -> Self {
        Self {
            mode: "skipped",
            skipped_reason: Some(reason),
            lease_error,
            ..Self::default()
        }
    }

    fn failed(error: String, lease_error: Option<String>) -> Self {
        Self {
            mode: "failed",
            error: Some(error),
            lease_error,
            ..Self::default()
        }
    }

    /// The `origin/refresh` artifact recorded on the turn.
    pub(crate) fn artifact(&self) -> JsonValue {
        let response = self.response.clone().unwrap_or_default();
        json!({
            "kind": "origin/refresh",
            "metadata": {
                "mode": self.mode,
                "skippedReason": self.skipped_reason,
                "rev": response.rev,
                "baseRev": response.base_rev,
                "gitSyncStatus": response.git_sync_status,
                "checkoutMoved": response.checkout_moved,
                "recoveryRef": response.recovery_ref,
                "conflictedPaths": response.conflicted_paths,
                "rejectedPaths": response.rejected_paths,
                "unpushedRefs": response.unpushed_refs,
                "failure": response.failure,
                "error": self.error,
                "leaseError": self.lease_error,
            }
        })
    }

    /// Work from an earlier turn the refresh could not bring onto `main`.
    pub(crate) fn not_saved_sentences(&self) -> Vec<String> {
        self.response
            .as_ref()
            .map(|response| response.save_report().not_saved_sentences(&[], None))
            .unwrap_or_default()
    }
}

/// Before a turn, bring this runtime's checkout up to date with canonical
/// `main`: under a workspace lease, `POST /git/sync {mode: "refresh"}` pushes
/// parked work, publishes commits left on the local branch and moves the
/// checkout to `main`. When no lease can be had (a read-only run, or someone
/// else holds it), the origin hosted by this process fetches with its own
/// read credential and moves the checkout only when nothing local is
/// unpublished. Failures are recorded, never fatal.
pub(crate) async fn refresh_before_turn(params: PreTurnRefresh<'_>) -> PreTurnRefreshOutcome {
    if !params.has_git_remote {
        return PreTurnRefreshOutcome::skipped("no_git_remote", None);
    }
    let Some(local_origin) = params.local_origin.as_ref() else {
        return PreTurnRefreshOutcome::skipped("no_local_origin", None);
    };

    let lease_error = match params.workspace_token {
        None => Some("missing workspace token".to_string()),
        Some(token) => {
            let client = match reqwest::Client::builder()
                .timeout(PRE_TURN_REFRESH_TIMEOUT)
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    return PreTurnRefreshOutcome::failed(error.to_string(), None);
                }
            };
            match acquire_workspace_lease_once(
                &client,
                params.controller_base_url,
                token,
                params.project_id,
                params.runtime_id,
                params.job_id,
                params.run_id,
            )
            .await
            {
                Ok(lease_id) => {
                    let result = refresh_with_lease(
                        &client,
                        params.controller_base_url,
                        token,
                        params.project_id,
                        params.runtime_id,
                        lease_id,
                        local_origin,
                    )
                    .await;
                    if let Err(error) = release_workspace_lease(
                        &client,
                        params.controller_base_url,
                        token,
                        params.project_id,
                        params.runtime_id,
                        lease_id,
                    )
                    .await
                    {
                        warn!(?error, lease_id = %lease_id, "failed to release workspace lease after the pre-turn refresh");
                    }
                    return match result {
                        Ok(Some(response)) => PreTurnRefreshOutcome {
                            mode: "refresh",
                            response: Some(response),
                            ..PreTurnRefreshOutcome::default()
                        },
                        Ok(None) => PreTurnRefreshOutcome::skipped("origin_not_local", None),
                        Err(error) => PreTurnRefreshOutcome::failed(format!("{error:#}"), None),
                    };
                }
                Err(error) => Some(error.to_string()),
            }
        }
    };

    let Some(refresh) = local_origin.read_only_refresh.as_ref() else {
        return PreTurnRefreshOutcome::skipped("no_read_only_refresh", lease_error);
    };
    match tokio::time::timeout(PRE_TURN_REFRESH_TIMEOUT, refresh.run()).await {
        Ok(Ok(report)) => PreTurnRefreshOutcome {
            mode: "read_only",
            response: Some(OriginSaveResponse::from_value(report)),
            lease_error,
            ..PreTurnRefreshOutcome::default()
        },
        Ok(Err(error)) => PreTurnRefreshOutcome::failed(format!("{error:#}"), lease_error),
        Err(_) => PreTurnRefreshOutcome::failed(
            "the read-only refresh timed out".to_string(),
            lease_error,
        ),
    }
}

/// `POST /git/sync {mode: "refresh"}` on this runtime's own origin. `None`
/// when the controller selected another origin: the refresh never moves a
/// checkout this runtime does not host.
async fn refresh_with_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    local_origin: &LocalOriginSync,
) -> Result<Option<OriginSaveResponse>> {
    let access = origin_write_access(
        client,
        controller_base_url,
        controller_token,
        project_id,
        runtime_id,
        lease_id,
        Some(local_origin),
        "pre-turn refresh",
    )
    .await?;
    if access.token.origin_id != local_origin.origin_id {
        return Ok(None);
    }
    let response = client
        .post(format!("{}/git/sync", access.endpoint))
        .bearer_auth(&access.token.token)
        .json(&OriginGitSyncRequest {
            mode: Some("refresh".to_string()),
            ..OriginGitSyncRequest::default()
        })
        .send()
        .await
        .context("origin refresh request failed")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let details = text.trim();
        if details.is_empty() {
            bail!("origin refresh failed ({status})");
        }
        bail!("origin refresh failed ({status}): {details}");
    }
    Ok(Some(OriginSaveResponse::parse(&text)))
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

/// `POST /git/sync {paths}`. A `not_saved` answer (409 or 503 with the
/// report) is returned as a response, not an error, so the caller can say
/// where the work is kept.
async fn try_git_sync(
    client: &reqwest::Client,
    endpoint: &str,
    origin_token: &str,
    project_id: Uuid,
    paths: &[String],
) -> Result<OriginSaveResponse> {
    let url = format!("{}/git/sync", endpoint.trim_end_matches('/'));
    let message = format!("instafy: agent sync (project {} )", project_id);
    let body = OriginGitSyncRequest {
        message: Some(message),
        paths: Some(paths.to_vec()),
        mode: None,
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
    let parsed = OriginSaveResponse::parse(&text);
    if !status.is_success() {
        if parsed.is_not_saved() {
            return Ok(parsed);
        }
        if parsed.is_workspace_stopping() {
            // Not a conflict: a stop has already kept this work on recovery
            // refs, and the save waits for the next start.
            bail!(
                "not saved now: the workspace is stopping and its work is kept on recovery refs until it restarts"
            );
        }
        let details = text.trim();
        if details.is_empty() {
            bail!("origin git sync failed ({status})");
        }
        bail!("origin git sync failed ({status}): {details}");
    }
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

    use super::super::skills::{
        SkillImportRequest, SkillsLaneOutcome, SkillsRequest, resolve_skills_lane,
    };
    use super::super::{
        CodexFileDescriptor, FileChangeDescriptor, FileChangeKind, SkillsLaneStep,
        settle_skills_lane_outcome,
    };
    use super::{
        LaneCheckpoint, PreTurnRefresh, checkpoint_lane_files, checkpoint_lane_files_with_report,
        commit_to_hosted_origin, refresh_before_turn, resolve_origin_sync_endpoint,
    };
    use crate::origin::{LocalOriginSync, ReadOnlyRefresh};
    use std::time::Duration;

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

    fn read_file_descriptor(path: &str) -> CodexFileDescriptor {
        let mut file = changed_file_descriptor(path);
        file.change = Some(FileChangeDescriptor {
            kind: FileChangeKind::Read,
            lines: Vec::new(),
            raw: serde_json::json!({ "type": "read" }),
        });
        file
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
            read_only_refresh: None,
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
            read_only_refresh: None,
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
            read_only_refresh: None,
        };

        let (endpoint, is_local) =
            resolve_origin_sync_endpoint(origin_id, "https://abc123.rt.instafy.dev", Some(&local));
        assert!(!is_local);
        assert_eq!(endpoint, "https://abc123.rt.instafy.dev");
    }

    #[tokio::test]
    async fn read_references_do_not_acquire_a_workspace_lease() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("reference.txt"), "read-only evidence\n")?;

        let requests = Arc::new(AtomicUsize::new(0));
        let requests_for_handler = Arc::clone(&requests);
        let app = Router::new().fallback(move || {
            let requests = Arc::clone(&requests_for_handler);
            async move {
                requests.fetch_add(1, Ordering::SeqCst);
                AxumStatusCode::BAD_REQUEST
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let result = commit_to_hosted_origin(
            &reqwest::Url::parse(&format!("http://{address}/"))?,
            "controller-token",
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            None,
            &workspace,
            &[read_file_descriptor("reference.txt")],
            Some(true),
            None,
            None,
        )
        .await;
        server.abort();

        assert!(result?.is_none());
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read(workspace.join("reference.txt"))?,
            b"read-only evidence\n"
        );
        Ok(())
    }

    #[tokio::test]
    async fn mixed_changes_upload_only_mutations_not_read_references() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace)?;
        std::fs::write(workspace.join("changed.txt"), "requested change\n")?;
        std::fs::write(workspace.join("reference.txt"), "read-only evidence\n")?;

        let apply_bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let bodies_for_handler = Arc::clone(&apply_bodies);
        let app = Router::new().route(
            "/apply",
            post(move |body: axum::body::Bytes| {
                let bodies = Arc::clone(&bodies_for_handler);
                async move {
                    bodies.lock().unwrap().push(body.to_vec());
                    (AxumStatusCode::OK, r#"{"rev":"mixedrev","baseRev":"base"}"#)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let (controller_address, token_mints) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{address}")).await;
        let result = commit_to_hosted_origin(
            &reqwest::Url::parse(&format!("http://{controller_address}/"))?,
            "controller-token",
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            None,
            &workspace,
            &[
                read_file_descriptor("reference.txt"),
                changed_file_descriptor("changed.txt"),
            ],
            Some(false),
            None,
            None,
        )
        .await;
        server.abort();

        let result = result?.context("expected the changed file to be committed")?;
        assert_eq!(result.paths, vec!["changed.txt"]);
        assert_eq!(token_mints.load(Ordering::SeqCst), 1);
        let bodies = apply_bodies.lock().unwrap();
        assert_eq!(bodies.len(), 1);
        let body = &bodies[0];
        // Filenames are present in both the JSON manifest and ZIP directory entries.
        assert!(
            body.windows(b"changed.txt".len())
                .any(|part| part == b"changed.txt")
        );
        assert!(
            !body
                .windows(b"reference.txt".len())
                .any(|part| part == b"reference.txt")
        );
        Ok(())
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
                read_only_refresh: None,
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
                read_only_refresh: None,
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

    /// Write a one-file skill folder inside `workspace` and return the `/skills import`
    /// request that installs it, with or without `--start`.
    fn solo_skill_import(workspace: &std::path::Path, start: bool) -> SkillsRequest {
        let source = workspace.join("incoming/solo-skill");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "# Solo\n\nOne skill.\n").unwrap();
        SkillsRequest::Import(SkillImportRequest {
            source: "incoming/solo-skill".to_string(),
            skill_name: None,
            overwrite: false,
            start,
        })
    }

    /// Install a one-file skill from a folder inside `workspace` with `/skills import` and
    /// return the checkpoint descriptors the lane hands back.
    async fn import_solo_skill(workspace: &std::path::Path) -> Vec<CodexFileDescriptor> {
        match resolve_skills_lane(solo_skill_import(workspace, false), workspace).await {
            SkillsLaneOutcome::Installed { files, .. } => files,
            other => panic!("expected an installed import, got {other:?}"),
        }
    }

    fn lane_checkpoint<'a>(
        controller_base_url: &'a reqwest::Url,
        workspace_token: Option<&'a str>,
        workspace: &'a std::path::Path,
    ) -> LaneCheckpoint<'a> {
        LaneCheckpoint {
            lane: "skills/import",
            commit_to_workspace: true,
            read_only_workspace: false,
            controller_base_url,
            workspace_token,
            project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            run_id: Some(Uuid::new_v4()),
            workspace_dir: workspace,
            auto_sync_after_apply_override: Some(true),
            progress_sender: None,
            local_origin: None,
        }
    }

    /// Controller stand-in that refuses everything, counting requests.
    async fn spawn_refusing_controller() -> (reqwest::Url, Arc<AtomicUsize>) {
        let requests = Arc::new(AtomicUsize::new(0));
        let requests_for_handler = Arc::clone(&requests);
        let app = Router::new().fallback(move || {
            let requests = Arc::clone(&requests_for_handler);
            async move {
                requests.fetch_add(1, Ordering::SeqCst);
                AxumStatusCode::BAD_REQUEST
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (
            reqwest::Url::parse(&format!("http://{address}/")).unwrap(),
            requests,
        )
    }

    #[tokio::test]
    async fn lane_checkpoint_respects_the_model_turn_gates() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let files = import_solo_skill(temp.path()).await;
        ensure!(!files.is_empty());
        let (controller, requests) = spawn_refusing_controller().await;

        // A job that does not commit to the workspace records nothing.
        let mut no_commit = lane_checkpoint(&controller, Some("workspace-token"), temp.path());
        no_commit.commit_to_workspace = false;
        ensure!(checkpoint_lane_files(no_commit, &files).await.is_empty());

        // Nothing written, nothing to record.
        let empty = lane_checkpoint(&controller, Some("workspace-token"), temp.path());
        ensure!(checkpoint_lane_files(empty, &[]).await.is_empty());

        // No verified workspace token (no run): the files stay local and the skip is
        // recorded exactly as a model turn records it.
        let artifacts =
            checkpoint_lane_files(lane_checkpoint(&controller, None, temp.path()), &files).await;
        ensure!(
            artifacts
                == vec![serde_json::json!({
                    "kind": "origin/apply-skipped",
                    "metadata": { "reason": "missing_controller_token" }
                })],
            "unexpected artifacts: {artifacts:?}"
        );

        // A read-only job keeps its files local even with a token: its controller token
        // still verifies, so the write-scope check is the runtime's gate, as it is for a
        // model turn, which keeps only coordination files then.
        let mut read_only = lane_checkpoint(&controller, Some("workspace-token"), temp.path());
        read_only.read_only_workspace = true;
        let artifacts = checkpoint_lane_files(read_only, &files).await;
        ensure!(
            artifacts
                == vec![serde_json::json!({
                    "kind": "origin/apply-skipped",
                    "metadata": { "reason": "read_only_workspace" }
                })],
            "unexpected artifacts: {artifacts:?}"
        );
        ensure!(
            requests.load(Ordering::SeqCst) == 0,
            "a gated checkpoint must not reach the controller"
        );
        Ok(())
    }

    #[tokio::test]
    async fn lane_checkpoint_uploads_an_imported_skill_and_records_a_space_without_a_remote()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let files = import_solo_skill(temp.path()).await;

        // An origin with no git remote applies the files and refuses the save, as
        // origin-http-server answers `/git/sync` when ORIGIN_GIT_REMOTE_URL is unset.
        let apply_bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let bodies_for_handler = Arc::clone(&apply_bodies);
        let app = Router::new()
            .route(
                "/apply",
                post(move |body: axum::body::Bytes| {
                    let bodies = Arc::clone(&bodies_for_handler);
                    async move {
                        bodies.lock().unwrap().push(body.to_vec());
                        (AxumStatusCode::OK, r#"{"rev":"applyrev","baseRev":"base"}"#)
                    }
                }),
            )
            .route(
                "/git/sync",
                post(|| async {
                    (
                        AxumStatusCode::BAD_REQUEST,
                        r#"{"error":"git remote is not configured for this project"}"#,
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let origin_address = listener.local_addr()?;
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let (controller_address, token_mints) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let artifacts = checkpoint_lane_files(
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
            &files,
        )
        .await;
        server.abort();

        ensure!(token_mints.load(Ordering::SeqCst) == 1);
        let bodies = apply_bodies.lock().unwrap();
        ensure!(bodies.len() == 1, "the skill must be applied exactly once");
        let skill_path = b".agents/skills/solo-skill/SKILL.md";
        ensure!(
            bodies[0]
                .windows(skill_path.len())
                .any(|part| part == skill_path),
            "the apply upload must carry the installed SKILL.md"
        );
        ensure!(artifacts.len() == 1, "unexpected artifacts: {artifacts:?}");
        let metadata = &artifacts[0]["metadata"];
        ensure!(artifacts[0]["kind"] == "origin/apply");
        ensure!(metadata["paths"] == serde_json::json!([".agents/skills/solo-skill/SKILL.md"]));
        ensure!(metadata["lane"] == "skills/import", "{metadata}");
        ensure!(metadata["rev"] == "applyrev");
        ensure!(metadata["gitSyncAttempted"] == true);
        ensure!(metadata["gitSyncStatus"] == "failed");
        ensure!(
            metadata["gitSyncError"]
                .as_str()
                .is_some_and(|error| error.contains("git remote is not configured")),
            "the failed save must be recorded: {metadata}"
        );
        ensure!(
            temp.path()
                .join(".agents/skills/solo-skill/SKILL.md")
                .is_file()
        );
        Ok(())
    }

    #[tokio::test]
    async fn lane_checkpoint_saves_an_imported_skill_when_the_space_has_a_remote() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let files = import_solo_skill(temp.path()).await;
        let (origin_address, apply_hits) = spawn_origin_server("applyrev").await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let artifacts = checkpoint_lane_files(
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
            &files,
        )
        .await;

        ensure!(apply_hits.load(Ordering::SeqCst) == 1);
        ensure!(artifacts.len() == 1, "unexpected artifacts: {artifacts:?}");
        let metadata = &artifacts[0]["metadata"];
        ensure!(metadata["gitSyncStatus"] == "synced", "{metadata}");
        ensure!(metadata["gitRev"] == "gitrev");
        ensure!(metadata["gitBaseRev"] == "gitbase");
        Ok(())
    }

    #[tokio::test]
    async fn lane_checkpoint_errors_are_recorded_without_failing_the_import() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let files = import_solo_skill(temp.path()).await;
        let (controller, requests) = spawn_refusing_controller().await;

        let artifacts = checkpoint_lane_files(
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
            &files,
        )
        .await;

        ensure!(requests.load(Ordering::SeqCst) >= 1);
        ensure!(artifacts.len() == 1, "unexpected artifacts: {artifacts:?}");
        ensure!(artifacts[0]["kind"] == "origin/apply-error");
        ensure!(artifacts[0]["metadata"]["error"].is_string());
        ensure!(
            temp.path()
                .join(".agents/skills/solo-skill/SKILL.md")
                .is_file(),
            "the installed skill stays in place"
        );
        Ok(())
    }

    /// The `origin/apply` artifacts in `artifacts`, each as its paths.
    fn origin_apply_paths(artifacts: &[serde_json::Value]) -> Vec<serde_json::Value> {
        artifacts
            .iter()
            .filter(|artifact| artifact["kind"] == "origin/apply")
            .map(|artifact| artifact["metadata"]["paths"].clone())
            .collect()
    }

    // `run_apply_job` hands the skills lane's outcome to `settle_skills_lane_outcome`; these
    // check that an import's files reach the checkpoint on both of its paths.
    #[tokio::test]
    async fn skills_lane_checkpoints_a_plain_import_before_it_finishes() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (origin_address, apply_hits) = spawn_origin_server("applyrev").await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let outcome = resolve_skills_lane(solo_skill_import(temp.path(), false), temp.path()).await;
        let step = settle_skills_lane_outcome(
            outcome,
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
        )
        .await;

        let SkillsLaneStep::Finished(execution) = step else {
            anyhow::bail!("a plain import finishes the job");
        };
        ensure!(apply_hits.load(Ordering::SeqCst) == 1);
        ensure!(
            execution
                .artifacts
                .iter()
                .any(|artifact| artifact["kind"] == "skills/import"),
            "the import report stays: {:?}",
            execution.artifacts
        );
        ensure!(
            origin_apply_paths(&execution.artifacts)
                == vec![serde_json::json!([".agents/skills/solo-skill/SKILL.md"])],
            "unexpected artifacts: {:?}",
            execution.artifacts
        );
        Ok(())
    }

    #[tokio::test]
    async fn skills_lane_checkpoints_a_started_import_after_streaming_its_report() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let (origin_address, apply_hits) = spawn_origin_server("applyrev").await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut checkpoint = lane_checkpoint(&controller, Some("workspace-token"), temp.path());
        checkpoint.progress_sender = Some(sender);

        let outcome = resolve_skills_lane(solo_skill_import(temp.path(), true), temp.path()).await;
        let step = settle_skills_lane_outcome(outcome, checkpoint).await;

        let SkillsLaneStep::Kickoff { prompt, kickoff } = step else {
            anyhow::bail!("a `--start` import hands off to a model turn");
        };
        ensure!(!prompt.is_empty());
        ensure!(kickoff.names == vec!["solo-skill".to_string()]);
        ensure!(
            kickoff.messages.len() == 1,
            "the import report joins the turn"
        );
        ensure!(apply_hits.load(Ordering::SeqCst) == 1);
        ensure!(
            origin_apply_paths(&kickoff.artifacts)
                == vec![serde_json::json!([".agents/skills/solo-skill/SKILL.md"])],
            "unexpected artifacts: {:?}",
            kickoff.artifacts
        );

        // The report streams before the checkpoint's own status lines.
        let mut streamed = Vec::new();
        while let Ok(message) = receiver.try_recv() {
            streamed.push(message);
        }
        ensure!(streamed.len() >= 2, "unexpected stream: {streamed:?}");
        ensure!(streamed[0].content == kickoff.messages[0].content);
        ensure!(
            streamed[1]
                .metadata
                .as_ref()
                .is_some_and(|metadata| metadata["kind"] == "workspace_commit"),
            "unexpected stream: {streamed:?}"
        );
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

    /// Origin stand-in answering `/apply` and `/git/sync` with `sync_status`
    /// and `sync_body`, recording every `/git/sync` request body.
    async fn spawn_reporting_origin(
        sync_status: AxumStatusCode,
        sync_body: &'static str,
    ) -> (SocketAddr, Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
        let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = Arc::clone(&bodies);
        let app = Router::new()
            .route(
                "/apply",
                post(|| async { (AxumStatusCode::OK, r#"{"rev":"applyrev"}"#) }),
            )
            .route(
                "/git/sync",
                post(move |body: axum::body::Bytes| {
                    let recorded = Arc::clone(&recorded);
                    async move {
                        recorded
                            .lock()
                            .unwrap()
                            .push(serde_json::from_slice(&body).unwrap_or_default());
                        (sync_status, sync_body)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, bodies)
    }

    /// A read-only refresh stand-in that counts its calls.
    fn counting_read_only_refresh() -> (ReadOnlyRefresh, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let refresh = ReadOnlyRefresh::new(move || {
            let counter = Arc::clone(&counter);
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(serde_json::json!({
                    "rev": "mainrev",
                    "baseRev": "mainrev",
                    "gitSyncStatus": "unchanged",
                    "checkoutMoved": true,
                    "conflictedPaths": [],
                    "rejectedPaths": [],
                    "unpushedRefs": 0
                }))
            }
        });
        (refresh, calls)
    }

    fn pre_turn_refresh<'a>(
        controller: &'a reqwest::Url,
        workspace_token: Option<&'a str>,
        local_origin: Option<LocalOriginSync>,
    ) -> PreTurnRefresh<'a> {
        PreTurnRefresh {
            controller_base_url: controller,
            workspace_token,
            project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            run_id: Some(Uuid::new_v4()),
            local_origin,
            has_git_remote: true,
        }
    }

    #[tokio::test]
    async fn pre_turn_refresh_runs_under_a_lease_on_this_runtimes_origin() -> Result<()> {
        let origin_id = Uuid::new_v4();
        let (origin_address, bodies) = spawn_reporting_origin(
            AxumStatusCode::OK,
            r#"{"rev":"mainrev","baseRev":"mainrev","gitSyncStatus":"published",
                "checkoutMoved":true,"conflictedPaths":["src/a.rs"],
                "recoveryRef":"refs/instafy/recovery/o/x-conflict-1",
                "rejectedPaths":[],"unpushedRefs":0}"#,
        )
        .await;
        let (controller_address, token_mints) =
            spawn_stub_controller(origin_id, format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let (read_only, read_only_calls) = counting_read_only_refresh();

        let outcome = refresh_before_turn(pre_turn_refresh(
            &controller,
            Some("workspace-token"),
            Some(LocalOriginSync {
                origin_id,
                endpoint: format!("http://{origin_address}"),
                read_only_refresh: Some(read_only),
            }),
        ))
        .await;

        ensure!(outcome.mode == "refresh", "{outcome:?}");
        ensure!(token_mints.load(Ordering::SeqCst) == 1);
        ensure!(read_only_calls.load(Ordering::SeqCst) == 0);
        let bodies = bodies.lock().unwrap().clone();
        ensure!(
            bodies == vec![serde_json::json!({ "mode": "refresh" })],
            "{bodies:?}"
        );
        let artifact = outcome.artifact();
        ensure!(artifact["kind"] == "origin/refresh");
        ensure!(artifact["metadata"]["mode"] == "refresh");
        ensure!(artifact["metadata"]["checkoutMoved"] == true);
        // Work an earlier turn could not bring onto main is named in this turn.
        ensure!(
            outcome.not_saved_sentences()
                == vec!["Not saved: src/a.rs (kept at refs/instafy/recovery/o/x-conflict-1)"]
        );
        Ok(())
    }

    #[tokio::test]
    async fn pre_turn_refresh_falls_back_to_read_only_without_a_lease() -> Result<()> {
        let (controller, requests) = spawn_refusing_controller().await;
        let (read_only, read_only_calls) = counting_read_only_refresh();

        let outcome = refresh_before_turn(pre_turn_refresh(
            &controller,
            Some("workspace-token"),
            Some(LocalOriginSync {
                origin_id: Uuid::new_v4(),
                endpoint: "http://127.0.0.1:9".to_string(),
                read_only_refresh: Some(read_only.clone()),
            }),
        ))
        .await;
        ensure!(outcome.mode == "read_only", "{outcome:?}");
        ensure!(read_only_calls.load(Ordering::SeqCst) == 1);
        ensure!(
            requests.load(Ordering::SeqCst) == 1,
            "one lease attempt, no retry"
        );
        ensure!(outcome.lease_error.is_some());
        ensure!(outcome.artifact()["metadata"]["checkoutMoved"] == true);

        // No workspace token at all: straight to the read-only refresh.
        let outcome = refresh_before_turn(pre_turn_refresh(
            &controller,
            None,
            Some(LocalOriginSync {
                origin_id: Uuid::new_v4(),
                endpoint: "http://127.0.0.1:9".to_string(),
                read_only_refresh: Some(read_only),
            }),
        ))
        .await;
        ensure!(outcome.mode == "read_only", "{outcome:?}");
        ensure!(read_only_calls.load(Ordering::SeqCst) == 2);
        ensure!(requests.load(Ordering::SeqCst) == 1);
        Ok(())
    }

    #[tokio::test]
    async fn pre_turn_refresh_only_moves_this_runtimes_own_checkout() -> Result<()> {
        let (origin_address, bodies) =
            spawn_reporting_origin(AxumStatusCode::OK, r#"{"rev":"x"}"#).await;
        // The controller selects some other origin.
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let (read_only, read_only_calls) = counting_read_only_refresh();
        let local = LocalOriginSync {
            origin_id: Uuid::new_v4(),
            endpoint: "http://127.0.0.1:9".to_string(),
            read_only_refresh: Some(read_only),
        };

        let outcome = refresh_before_turn(pre_turn_refresh(
            &controller,
            Some("workspace-token"),
            Some(local.clone()),
        ))
        .await;
        ensure!(outcome.mode == "skipped", "{outcome:?}");
        ensure!(outcome.skipped_reason == Some("origin_not_local"));
        ensure!(bodies.lock().unwrap().is_empty());

        // Nothing to refresh from, or no origin in this process: no calls.
        let mut no_remote = pre_turn_refresh(&controller, Some("workspace-token"), Some(local));
        no_remote.has_git_remote = false;
        ensure!(refresh_before_turn(no_remote).await.skipped_reason == Some("no_git_remote"));
        let outcome =
            refresh_before_turn(pre_turn_refresh(&controller, Some("workspace-token"), None)).await;
        ensure!(outcome.skipped_reason == Some("no_local_origin"));
        ensure!(read_only_calls.load(Ordering::SeqCst) == 0);
        Ok(())
    }

    #[tokio::test]
    async fn a_partial_save_records_each_path_and_says_what_was_not_saved() -> Result<()> {
        let temp = tempfile::tempdir()?;
        std::fs::create_dir_all(temp.path().join("src"))?;
        std::fs::write(temp.path().join("src/a.rs"), "fn a() {}\n")?;
        std::fs::write(temp.path().join(".env"), "TOKEN=1\n")?;
        let (origin_address, bodies) = spawn_reporting_origin(
            AxumStatusCode::OK,
            r#"{"rev":"p","baseRev":"r","gitSyncStatus":"partial",
                "recoveryRef":"refs/instafy/recovery/o/x-conflict-1",
                "conflictedPaths":["src/a.rs"],
                "rejectedPaths":[{"path":".env","reason":"ignored","keptSavedVersion":false}],
                "unpushedRefs":0,"checkoutMoved":true}"#,
        )
        .await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let (artifacts, not_saved) = checkpoint_lane_files_with_report(
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
            &[
                changed_file_descriptor("src/a.rs"),
                changed_file_descriptor(".env"),
            ],
        )
        .await;

        let sent = bodies.lock().unwrap().clone();
        ensure!(sent.len() == 1);
        ensure!(
            sent[0]["paths"] == serde_json::json!([".env", "src/a.rs"]),
            "{sent:?}"
        );
        ensure!(artifacts.len() == 1, "{artifacts:?}");
        let metadata = &artifacts[0]["metadata"];
        ensure!(metadata["gitSyncStatus"] == "partial", "{metadata}");
        ensure!(metadata["conflictedPaths"] == serde_json::json!(["src/a.rs"]));
        ensure!(
            metadata["rejectedPaths"]
                == serde_json::json!([{"path": ".env", "reason": "ignored", "keptSavedVersion": false}])
        );
        ensure!(metadata["recoveryRef"] == "refs/instafy/recovery/o/x-conflict-1");
        ensure!(metadata["gitRev"] == "p");
        ensure!(
            not_saved
                == vec![
                    "Not saved: src/a.rs (kept at refs/instafy/recovery/o/x-conflict-1)",
                    "Not saved: .env (ignored by .gitignore)",
                ],
            "{not_saved:?}"
        );
        Ok(())
    }

    const STOPPING_BODY: &str = r#"{"error":"the workspace is stopping and its work is kept on recovery refs; save again after it restarts",
        "code":"workspace_stopping","retryable":true}"#;

    /// The `/sync` lane during a stop: the origin's `workspace_stopping`
    /// answer is not a merge conflict.
    #[tokio::test]
    async fn a_sync_during_a_stop_is_not_reported_as_a_conflict() -> Result<()> {
        let origin_id = Uuid::new_v4();
        let (origin_address, _) =
            spawn_reporting_origin(AxumStatusCode::SERVICE_UNAVAILABLE, STOPPING_BODY).await;
        let (controller_address, _) =
            spawn_stub_controller(origin_id, format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let outcome = super::git_sync_with_lease(
            &reqwest::Client::new(),
            &controller,
            "controller-token",
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "instafy: sync",
            None,
        )
        .await?;
        match outcome {
            super::GitSyncOutcome::Stopping { message } => {
                ensure!(message.contains("stopping"), "{message}")
            }
            other => anyhow::bail!("expected Stopping, got {other:?}"),
        }

        // A 409 with the same code is the same answer, whatever the status.
        let (origin_address, _) =
            spawn_reporting_origin(AxumStatusCode::CONFLICT, STOPPING_BODY).await;
        let (controller_address, _) =
            spawn_stub_controller(origin_id, format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let outcome = super::git_sync_with_lease(
            &reqwest::Client::new(),
            &controller,
            "controller-token",
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "instafy: sync",
            None,
        )
        .await?;
        ensure!(
            matches!(outcome, super::GitSyncOutcome::Stopping { .. }),
            "{outcome:?}"
        );
        Ok(())
    }

    /// A checkpoint during a stop says the workspace is stopping, not that
    /// the save conflicted.
    #[tokio::test]
    async fn a_checkpoint_during_a_stop_says_the_workspace_is_stopping() -> Result<()> {
        let temp = tempfile::tempdir()?;
        std::fs::write(temp.path().join("notes.md"), "hello\n")?;
        let (origin_address, _) =
            spawn_reporting_origin(AxumStatusCode::SERVICE_UNAVAILABLE, STOPPING_BODY).await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let (artifacts, _) = checkpoint_lane_files_with_report(
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
            &[changed_file_descriptor("notes.md")],
        )
        .await;
        let error = artifacts[0]["metadata"]["gitSyncError"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        ensure!(error.contains("the workspace is stopping"), "{error}");
        ensure!(!error.to_ascii_lowercase().contains("conflict"), "{error}");
        Ok(())
    }

    #[tokio::test]
    async fn a_save_that_kept_nothing_on_main_names_where_the_work_is() -> Result<()> {
        let temp = tempfile::tempdir()?;
        std::fs::write(temp.path().join("notes.md"), "hello\n")?;
        let (origin_address, _) = spawn_reporting_origin(
            AxumStatusCode::SERVICE_UNAVAILABLE,
            r#"{"error":"Not saved: could not reach the saved history (kept at refs/instafy/local-recovery/x-unpublished-2)",
                "code":"not_saved","gitSyncStatus":"unpublished","retryable":true,
                "recoveryRef":"refs/instafy/local-recovery/x-unpublished-2",
                "conflictedPaths":[],"rejectedPaths":[],"unpushedRefs":1}"#,
        )
        .await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;

        let (artifacts, not_saved) = checkpoint_lane_files_with_report(
            lane_checkpoint(&controller, Some("workspace-token"), temp.path()),
            &[changed_file_descriptor("notes.md")],
        )
        .await;
        let metadata = &artifacts[0]["metadata"];
        ensure!(metadata["gitSyncStatus"] == "failed", "{metadata}");
        ensure!(
            metadata["recoveryRef"] == "refs/instafy/local-recovery/x-unpublished-2",
            "{metadata}"
        );
        ensure!(
            metadata["gitSyncError"]
                .as_str()
                .is_some_and(|error| error.starts_with("Not saved:")),
            "{metadata}"
        );
        ensure!(
            not_saved
                == vec![
                    "Not saved: notes.md (kept at refs/instafy/local-recovery/x-unpublished-2)"
                ],
            "{not_saved:?}"
        );
        Ok(())
    }

    /// Controller stand-in for a real origin: publishes a JWKS, grants
    /// `lease_id`, mints a signed `fs.write` origin token for it (for
    /// `origin_endpoint`), answers the origin's lease check and its
    /// `git.write` exchange.
    async fn spawn_controller_for_real_origin(
        project_id: Uuid,
        origin_id: Uuid,
        origin_endpoint: String,
    ) -> SocketAddr {
        use axum::Json;
        use axum::routing::get;
        use base64::Engine as _;
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use ring::rand::SystemRandom;
        use ring::signature::{Ed25519KeyPair, KeyPair as _};

        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let jwks = serde_json::json!({
            "keys": [{
                "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
                "kid": "stub-key",
                "x": URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref()),
            }]
        });
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let encoding_key = jsonwebtoken::EncodingKey::from_ed_pem(pem.as_bytes()).unwrap();
        let lease_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let now = chrono::Utc::now().timestamp();
        let origin_token = jsonwebtoken::encode(
            &jsonwebtoken::Header {
                kid: Some("stub-key".to_string()),
                ..jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA)
            },
            &serde_json::json!({
                "aud": origin_id.to_string(),
                "sub": user_id.to_string(),
                "project_id": project_id.to_string(),
                "origin_id": origin_id.to_string(),
                "runtime_id": runtime_id.to_string(),
                "protocol": "http",
                "scopes": ["fs.write"],
                "lease_id": lease_id.to_string(),
                "iat": now,
                "exp": now + 300,
            }),
            &encoding_key,
        )
        .unwrap();
        let lease = serde_json::json!({
            "lease": {
                "leaseId": lease_id,
                "projectId": project_id,
                "userId": user_id,
                "runtimeId": runtime_id,
                "expiresAt": (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
            }
        });
        let access = serde_json::json!({
            "originId": origin_id,
            "endpoint": origin_endpoint,
            "mode": "hosted",
            "token": origin_token,
            "leaseId": lease_id,
        });
        let app = Router::new()
            .route(
                "/.well-known/jwks.json",
                get(move || {
                    let jwks = jwks.clone();
                    async move { Json(jwks) }
                }),
            )
            .route(
                "/lease/acquire",
                post(move || async move { Json(serde_json::json!({ "leaseId": lease_id })) }),
            )
            .route(
                "/lease/release",
                post(|| async { (AxumStatusCode::OK, "{}") }),
            )
            .route(
                "/access_token",
                post(move || {
                    let access = access.clone();
                    async move { Json(access) }
                }),
            )
            .route(
                "/projects/:project/lease",
                get(move || {
                    let lease = lease.clone();
                    async move { Json(lease) }
                }),
            )
            .route(
                "/projects/:project/git/access_token",
                post(|| async {
                    Json(serde_json::json!({ "token": "git-token", "expiresIn": 60 }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        address
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Seed")
            .env("GIT_AUTHOR_EMAIL", "seed@example.com")
            .env("GIT_COMMITTER_NAME", "Seed")
            .env("GIT_COMMITTER_EMAIL", "seed@example.com")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Selection (a), end to end against a real single-tenant origin: an
    /// ignored path in the checkpoint is reported, never published, and the
    /// rest of the turn reaches canonical `main`.
    #[tokio::test]
    async fn an_ignored_path_in_a_checkpoint_is_reported_by_a_real_origin() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().canonicalize()?;
        let remote = root.join("remote.git");
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed)?;
        git(
            &root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        git(&seed, &["init", "-q", "-b", "main"]);
        std::fs::write(seed.join(".gitignore"), ".env\n")?;
        std::fs::write(seed.join("README.md"), "seed\n")?;
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-q", "-m", "seed"]);
        git(&seed, &["push", "-q", remote.to_str().unwrap(), "main"]);

        let workspace = root.join("ws");
        std::fs::create_dir_all(&workspace)?;
        let origin_id = Uuid::new_v4();
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let origin_port = listener.local_addr()?.port();
        drop(listener);
        let project_id = Uuid::new_v4();
        let controller_address = spawn_controller_for_real_origin(
            project_id,
            origin_id,
            format!("http://127.0.0.1:{origin_port}"),
        )
        .await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let mut checkpoint = lane_checkpoint(&controller, Some("workspace-token"), &workspace);
        checkpoint.project_id = project_id;
        let mut server = origin_http_server::server::OriginHttpServer::new(
            origin_http_server::config::ServerConfig {
                project_id: checkpoint.project_id,
                origin_id,
                workspace_root: workspace.clone(),
                git_remote_url: Some(format!("file://{}", remote.display())),
                git_remote_base_url: None,
                git_branch: "main".to_string(),
                git_remote_name: "origin".to_string(),
                git_author_name: "Instafy Origin".to_string(),
                git_author_email: "origin@instafy.dev".to_string(),
                bind_host: "127.0.0.1".to_string(),
                bind_port: origin_port,
                controller_base_url: controller.clone(),
                controller_internal_token: None,
                controller_token_source: None,
                jwks_url: controller.join("/.well-known/jwks.json")?,
                skip_auth: false,
                enable_presence_heartbeat: false,
                presence_interval: Duration::from_secs(60),
                max_archive_bytes: 1024 * 1024,
                staging_base: None,
                multi_tenant: false,
                hosted_checkout: true,
            },
        )?;
        server.start().await?;

        std::fs::create_dir_all(workspace.join("src"))?;
        std::fs::write(workspace.join("src/a.rs"), "fn a() {}\n")?;
        std::fs::write(workspace.join(".env"), "TOKEN=secret\n")?;
        let (artifacts, not_saved) = checkpoint_lane_files_with_report(
            checkpoint,
            &[
                changed_file_descriptor("src/a.rs"),
                changed_file_descriptor(".env"),
            ],
        )
        .await;
        server.stop().await?;

        let metadata = &artifacts[0]["metadata"];
        ensure!(metadata["gitSyncStatus"] == "partial", "{metadata}");
        ensure!(
            metadata["rejectedPaths"][0]["path"] == ".env"
                && metadata["rejectedPaths"][0]["reason"] == "ignored",
            "{metadata}"
        );
        ensure!(
            not_saved == vec!["Not saved: .env (ignored by .gitignore)"],
            "{not_saved:?}"
        );
        ensure!(git(&remote, &["show", "main:src/a.rs"]) == "fn a() {}");
        let tree = git(&remote, &["ls-tree", "-r", "--name-only", "main"]);
        ensure!(!tree.lines().any(|path| path == ".env"), "{tree}");
        ensure!(metadata["gitRev"] == git(&remote, &["rev-parse", "main"]));
        Ok(())
    }

    /// Selection (b): a write-scoped worker's files go through the turn
    /// checkpoint, and what did not reach `main` is named in its reply.
    #[tokio::test]
    async fn a_write_scoped_workers_files_go_through_the_checkpoint() -> Result<()> {
        let temp = tempfile::tempdir()?;
        std::fs::create_dir_all(temp.path().join("web"))?;
        std::fs::write(temp.path().join("web/page.html"), "<p>hi</p>\n")?;
        let (origin_address, bodies) = spawn_reporting_origin(
            AxumStatusCode::OK,
            r#"{"rev":"p","baseRev":"r","gitSyncStatus":"partial",
                "recoveryRef":"refs/instafy/recovery/o/x-conflict-9",
                "conflictedPaths":["web/page.html"],"rejectedPaths":[]}"#,
        )
        .await;
        let (controller_address, _) =
            spawn_stub_controller(Uuid::new_v4(), format!("http://{origin_address}")).await;
        let controller = reqwest::Url::parse(&format!("http://{controller_address}/"))?;
        let mut checkpoint = lane_checkpoint(&controller, Some("workspace-token"), temp.path());
        checkpoint.lane = super::super::WRITE_SCOPED_WORKER_LANE;
        let execution = super::super::JobExecution {
            summary: "Wrote the page.".to_string(),
            suggested_replies: Vec::new(),
            provider: "openai-proxy-write-scoped-worker".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: Vec::new(),
        };

        let execution = super::super::checkpoint_write_scoped_worker(
            execution,
            checkpoint,
            &[changed_file_descriptor("web/page.html")],
        )
        .await;

        ensure!(bodies.lock().unwrap().len() == 1);
        ensure!(execution.artifacts.len() == 1, "{:?}", execution.artifacts);
        let metadata = &execution.artifacts[0]["metadata"];
        ensure!(
            metadata["lane"] == "multi-agent/write-scoped-worker",
            "{metadata}"
        );
        ensure!(metadata["gitSyncStatus"] == "partial");
        ensure!(
            execution.summary
                == "Wrote the page.\n\nNot saved: web/page.html (kept at refs/instafy/recovery/o/x-conflict-9).",
            "{}",
            execution.summary
        );
        Ok(())
    }
}
