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
use tracing::warn;
use uuid::Uuid;
use zip::CompressionMethod;
use zip::write::{FileOptions, ZipWriter};

use super::{CodexFileDescriptor, FileChangeKind, JobMessage, JobMessageSender};

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

fn git_sync_enabled() -> bool {
    parse_env_bool("RUNTIME_GIT_SYNC_AFTER_APPLY").unwrap_or(true)
}

pub(crate) async fn git_sync_only(
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    run_id: Option<Uuid>,
    message: &str,
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

async fn git_sync_with_lease(
    client: &reqwest::Client,
    controller_base_url: &Url,
    controller_token: &str,
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    message: &str,
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

    let endpoint = normalize_origin_endpoint_for_runtime(token.endpoint.as_str());
    if endpoint.is_empty() {
        bail!("origin access token response missing endpoint");
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

    let endpoint = normalize_origin_endpoint_for_runtime(token.endpoint.as_str());
    if endpoint.is_empty() {
        bail!("origin access token response missing endpoint");
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

    let form = reqwest::multipart::Form::new()
        .part(
            "manifest",
            reqwest::multipart::Part::bytes(manifest_json)
                .file_name("manifest.json")
                .mime_str("application/json")
                .context("failed to build manifest multipart part")?,
        )
        .part(
            "archive",
            reqwest::multipart::Part::bytes(archive_bytes)
                .file_name("workspace.zip")
                .mime_str("application/zip")
                .context("failed to build archive multipart part")?,
        );

    let response = client
        .post(&apply_url)
        .bearer_auth(&token.token)
        .multipart(form)
        .send()
        .await
        .context("origin apply request failed")?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("origin apply failed ({}): {}", status, text);
    }

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
    use std::io::{Cursor, Read};

    use zip::ZipArchive;

    use super::normalize_origin_endpoint_for_runtime_with_flag;
    use super::{UploadEntry, build_zip_archive};

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
