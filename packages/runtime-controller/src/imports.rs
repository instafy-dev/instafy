use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use reqwest::multipart::Part;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use tokio::sync::{oneshot, Semaphore};
use tokio::time::timeout;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use tracing::{instrument, warn};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zip::write::{FileOptions, ZipWriter};
use zip::ZipArchive;

use crate::auth::{authenticate_request, claims_have_scopes, RequestContext};
use crate::config::CredentialEncryptionKey;
use crate::device_auth::{
    load_user_github_access_token, resolve_github_device_auth_session,
    GithubDeviceAuthSessionResolution,
};
use crate::integrations::{
    require_project_integrations_storage, upsert_project_integration_record_if_unchanged,
    ProjectIntegrationUpsert,
};
use crate::origins::{
    acquire_fresh_lease, load_origin_by_id, release_lease, renew_long_lease,
    resolve_accessible_origin_for_protocol_with_hosted_fallback,
    resolve_origin_proxy_upstream_endpoint, LeaseAcquireOutcome, WorkspaceOriginRecord,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::{
    bad_request, ensure_project_write_access, forbidden, internal_error, load_project_record,
    not_found, too_many_requests, unauthorized, ApiError, AppState, ProjectRecord,
};

const DEFAULT_CONTROLLER_IMPORT_MAX_ARCHIVE_BYTES: usize = 1024 * 1024 * 1024;
const DEFAULT_GITHUB_IMPORT_MAX_DOWNLOAD_BYTES: usize = 128 * 1024 * 1024;
const DEFAULT_GITHUB_IMPORT_MAX_REPACKED_BYTES: usize = 128 * 1024 * 1024;
const DEFAULT_GITHUB_IMPORT_MAX_UNCOMPRESSED_BYTES: usize = 512 * 1024 * 1024;
const DEFAULT_GITHUB_IMPORT_MAX_FILE_COUNT: usize = 50_000;
const DEFAULT_GITHUB_IMPORT_MAX_CONCURRENT: usize = 1;
const GITHUB_OWNER_MAX_BYTES: usize = 39;
const GITHUB_REPO_MAX_BYTES: usize = 100;
const GITHUB_REF_MAX_BYTES: usize = 1024;
const GITHUB_IMPORT_PATH_MAX_BYTES: usize = 4096;
const GITHUB_IMPORT_COMPONENT_MAX_BYTES: usize = 255;
const GITHUB_IMPORT_TOTAL_PATH_MAX_BYTES: usize = 12 * 1024 * 1024;
const ORIGIN_RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const ORIGIN_APPLY_TIMEOUT_SECS: u64 = 900;
const ORIGIN_APPLY_STATUS_TIMEOUT_SECS: u64 = 30;
const ORIGIN_GIT_SYNC_TIMEOUT_SECS: u64 = 180;
const ORIGIN_GIT_REMOTE_NOT_CONFIGURED: &str = "git remote is not configured for this project";
const GITHUB_IMPORT_IDEMPOTENCY_KEY_MAX_LEN: usize = 256;
const GITHUB_IMPORT_OPERATION_LEASE_MINUTES: i64 = 5;
const GITHUB_IMPORT_HEARTBEAT_SECONDS: u64 = 60;
const GITHUB_IMPORT_RATE_WINDOW_SECONDS: u64 = 60;
const GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE: &str = "Workspace is busy. Try again in a moment.";
const GITHUB_IMPORT_ORIGIN_TOKEN_TTL_SECONDS: i64 =
    (ORIGIN_APPLY_TIMEOUT_SECS + ORIGIN_GIT_SYNC_TIMEOUT_SECS + 120) as i64;
const GITHUB_IMPORT_WORKSPACE_LEASE_SECONDS: i64 = GITHUB_IMPORT_ORIGIN_TOKEN_TTL_SECONDS;
const GITHUB_IMPORT_APPLY_TOKEN_TTL_SECONDS: i64 = 180;
const GITHUB_IMPORT_STATUS_TOKEN_TTL_SECONDS: i64 = 60;
const GITHUB_IMPORT_SYNC_TOKEN_TTL_SECONDS: i64 = 300;

static GITHUB_IMPORT_ADMISSION: Lazy<Semaphore> = Lazy::new(|| {
    let permits = std::env::var("CONTROLLER_GITHUB_IMPORT_MAX_CONCURRENT")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(DEFAULT_GITHUB_IMPORT_MAX_CONCURRENT);
    Semaphore::new(permits)
});

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/projects/:project_id/import/github",
        post(import_github_project),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportGithubBody {
    repo: String,
    #[serde(rename = "ref")]
    git_ref: Option<String>,
    #[serde(default)]
    target_path: Option<String>,
    #[serde(default)]
    github_token: Option<String>,
    #[serde(default)]
    github_device_auth_session_id: Option<String>,
    #[serde(default)]
    idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportGithubResponse {
    ok: bool,
    project_id: String,
    repo: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    git_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_path: Option<String>,
    file_count: usize,
    bytes_written: usize,
    rev: Option<String>,
    deduplicated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginManifestFileEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectGithubAuthPolicy {
    Automatic,
    ExcludeUserOauth,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GithubImportAuthSource {
    DeviceSession,
    ExplicitToken,
    UserOauth,
    ProjectToken,
    Public,
}

#[derive(Clone)]
struct ResolvedGithubImportAuth {
    token: Option<String>,
    mode: &'static str,
    source: GithubImportAuthSource,
    fallback_policy_after_import: ProjectGithubAuthPolicy,
}

struct ProjectGithubIntegrationState {
    policy: ProjectGithubAuthPolicy,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubImportAppliedState {
    origin_id: String,
    origin_rev: String,
    source_revision: String,
    file_count: usize,
    bytes_written: usize,
    auth_mode: String,
    persistent_connection: bool,
    user_oauth_fallback_enabled: bool,
    #[serde(default)]
    integration_updated_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubImportPreparedState {
    origin_id: String,
    source_revision: String,
    auth_mode: String,
    persistent_connection: bool,
    user_oauth_fallback_enabled: bool,
    #[serde(default)]
    integration_updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug)]
struct OriginRequestError {
    message: String,
    ambiguous: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum OriginApplyStatus {
    Missing,
    Pending,
    Succeeded {
        rev: String,
        file_count: usize,
        bytes_written: usize,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginApplyStatusPayload {
    status: String,
    rev: Option<String>,
    file_count: Option<u64>,
    bytes_written: Option<u64>,
}

impl std::fmt::Display for OriginRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone, Copy, Debug)]
struct GithubImportArchiveLimits {
    download_bytes: usize,
    repacked_bytes: usize,
    uncompressed_bytes: usize,
    file_count: usize,
}

enum GithubImportOperationClaim {
    Claimed {
        claim_id: Uuid,
        source_revision: Option<String>,
        prepared: Option<GithubImportPreparedState>,
        applied: Option<GithubImportAppliedState>,
    },
    Cached(ImportGithubResponse),
    InProgress,
    Conflict,
    AdmissionRequired,
}

fn github_import_operation_can_retry_without_admission(
    status: &str,
    error_message: Option<&str>,
    has_prepared_state: bool,
    created_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    let receipt_age = now.signed_duration_since(created_at);
    status == "failed"
        && error_message == Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE)
        && has_prepared_state
        && receipt_age >= ChronoDuration::zero()
        && receipt_age < ChronoDuration::seconds(GITHUB_IMPORT_RATE_WINDOW_SECONDS as i64)
}

fn resolve_project_github_auth_policy(
    status: Option<&str>,
    connection_type: Option<&str>,
    metadata: Option<&JsonValue>,
) -> ProjectGithubAuthPolicy {
    let status = status.unwrap_or_default().trim().to_ascii_lowercase();
    let connection_type = connection_type
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let metadata = metadata.and_then(JsonValue::as_object);
    let metadata_disables_integration = metadata
        .map(|object| {
            object
                .get("attached")
                .and_then(JsonValue::as_bool)
                .map(|attached| !attached)
                .unwrap_or(false)
                || object
                    .get("enabled")
                    .and_then(JsonValue::as_bool)
                    .map(|enabled| !enabled)
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    let metadata_auth_mode = metadata
        .and_then(|object| object.get("authMode").or_else(|| object.get("auth_mode")))
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let metadata_excludes_user_oauth_fallback = metadata
        .and_then(|object| {
            object
                .get("userOauthFallbackEnabled")
                .or_else(|| object.get("user_oauth_fallback_enabled"))
        })
        .and_then(JsonValue::as_bool)
        .map(|enabled| !enabled)
        .unwrap_or(false);

    if matches!(status.as_str(), "disconnected" | "disabled" | "detached")
        || metadata_disables_integration
        || metadata_excludes_user_oauth_fallback
        || connection_type == "token"
        || metadata_auth_mode == "token"
    {
        ProjectGithubAuthPolicy::ExcludeUserOauth
    } else {
        ProjectGithubAuthPolicy::Automatic
    }
}

fn normalize_github_token(token: Option<String>) -> Option<String> {
    token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_github_import_auth(
    policy: ProjectGithubAuthPolicy,
    session_token: Option<String>,
    explicit_token: Option<String>,
    user_oauth_token: Option<String>,
    project_token: Option<String>,
) -> ResolvedGithubImportAuth {
    if let Some(token) = normalize_github_token(session_token) {
        return ResolvedGithubImportAuth {
            token: Some(token),
            mode: "oauth",
            source: GithubImportAuthSource::DeviceSession,
            // Supplying a new device session is an explicit account choice and
            // intentionally replaces any previous project opt-out.
            fallback_policy_after_import: ProjectGithubAuthPolicy::Automatic,
        };
    }
    if let Some(token) = normalize_github_token(explicit_token) {
        return ResolvedGithubImportAuth {
            token: Some(token),
            mode: "ephemeral_token",
            source: GithubImportAuthSource::ExplicitToken,
            // A body token authorizes this operation only. It is never stored,
            // so it must not silently turn the project into token-only mode.
            fallback_policy_after_import: policy,
        };
    }

    if policy == ProjectGithubAuthPolicy::Automatic {
        if let Some(token) = normalize_github_token(user_oauth_token) {
            return ResolvedGithubImportAuth {
                token: Some(token),
                mode: "oauth",
                source: GithubImportAuthSource::UserOauth,
                fallback_policy_after_import: ProjectGithubAuthPolicy::Automatic,
            };
        }
    }
    if let Some(token) = normalize_github_token(project_token) {
        return ResolvedGithubImportAuth {
            token: Some(token),
            mode: "token",
            source: GithubImportAuthSource::ProjectToken,
            fallback_policy_after_import: ProjectGithubAuthPolicy::ExcludeUserOauth,
        };
    }

    ResolvedGithubImportAuth {
        token: None,
        mode: "public",
        source: GithubImportAuthSource::Public,
        // A successful anonymous import must not erase a prior disconnect or
        // token-only policy and silently widen the next import to user OAuth.
        fallback_policy_after_import: policy,
    }
}

async fn resolve_github_import_request_auth(
    state: &AppState,
    user_id: Uuid,
    project_id: &Uuid,
    policy: ProjectGithubAuthPolicy,
    github_device_auth_session_id: Option<&str>,
    explicit_github_token: Option<String>,
) -> Result<ResolvedGithubImportAuth, (StatusCode, Json<ApiError>)> {
    let github_token_from_session = if let Some(session_raw) = github_device_auth_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let session_id = Uuid::parse_str(session_raw)
            .map_err(|_| bad_request("invalid githubDeviceAuthSessionId"))?;
        match resolve_github_device_auth_session(state, user_id, session_id).await? {
            GithubDeviceAuthSessionResolution::Completed { access_token } => Some(access_token),
            GithubDeviceAuthSessionResolution::Pending => {
                return Err(bad_request("GitHub device login is still pending"));
            }
            GithubDeviceAuthSessionResolution::Cancelled => {
                return Err(bad_request("GitHub device login was cancelled"));
            }
            GithubDeviceAuthSessionResolution::Failed { error } => {
                return Err(bad_request(format!("GitHub device login failed: {error}")));
            }
            GithubDeviceAuthSessionResolution::NotFoundOrExpired => {
                return Err(bad_request("GitHub device login not found or expired"));
            }
        }
    } else {
        None
    };

    let explicit_github_token = normalize_github_token(explicit_github_token);
    if github_token_from_session.is_some() || explicit_github_token.is_some() {
        return Ok(resolve_github_import_auth(
            policy,
            github_token_from_session,
            explicit_github_token,
            None,
            None,
        ));
    }

    let stored_github_token = if policy == ProjectGithubAuthPolicy::Automatic {
        load_user_github_access_token(state, user_id).await?
    } else {
        None
    };
    let project_secret_github_token = if stored_github_token.is_none() {
        load_project_github_token(state, project_id).await?
    } else {
        None
    };
    Ok(resolve_github_import_auth(
        policy,
        None,
        None,
        stored_github_token,
        project_secret_github_token,
    ))
}

fn normalize_github_import_idempotency_key(
    value: Option<String>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > GITHUB_IMPORT_IDEMPOTENCY_KEY_MAX_LEN {
        return Err(bad_request(format!(
            "idempotencyKey is too long (max {GITHUB_IMPORT_IDEMPOTENCY_KEY_MAX_LEN} chars)"
        )));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(bad_request(
            "idempotencyKey must contain only letters, numbers, ':', '.', '_' or '-'",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

async fn ensure_github_import_operations_table(
    state: &AppState,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let ready = connection
        .query_one(
            "select
               to_regclass('public.github_import_operations') is not null
               and exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'github_import_operations'
                   and column_name = 'source_revision'
               )
               and exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'github_import_operations'
                   and column_name = 'applied_json'
               )
               and exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'github_import_operations'
                   and column_name = 'prepared_json'
               ) as ready",
            &[],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect GitHub import operations storage: {error}"
            ))
        })?
        .get::<_, bool>("ready");
    if !ready {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::with_details(
                "GitHub import storage is not ready. Please try again shortly.",
                "github_import_storage_unavailable",
                json!({ "retryable": true }),
            )),
        ));
    }
    Ok(())
}

async fn claim_github_import_operation(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    idempotency_key: &str,
    repo: &str,
    git_ref: &str,
    target_path: Option<&str>,
    admission_granted: bool,
) -> Result<GithubImportOperationClaim, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start GitHub import claim transaction: {error}"
        ))
    })?;
    let project_lock_key = format!("github-import-project:{project_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&project_lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to serialize GitHub import claims: {error}"))
        })?;
    let existing = transaction
        .query_opt(
            "select repo, git_ref, target_path, status, source_revision,
                    prepared_json, applied_json, response_json,
                    error_message, created_at,
                    claim_expires_at > now() as claim_active
             from github_import_operations
             where project_id = $1 and idempotency_key = $2
             for update",
            &[project_id, &idempotency_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load GitHub import claim: {error}")))?;

    if let Some(row) = existing {
        let stored_repo: String = row.get("repo");
        let stored_ref: String = row.get("git_ref");
        let stored_target_path: Option<String> = row.get("target_path");
        if !stored_repo.eq_ignore_ascii_case(repo)
            || stored_ref != git_ref
            || stored_target_path.as_deref() != target_path
        {
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize GitHub import conflict: {error}"
                ))
            })?;
            return Ok(GithubImportOperationClaim::Conflict);
        }

        let status: String = row.get("status");
        if status == "succeeded" {
            let response: Option<PgJson<JsonValue>> = row.get("response_json");
            let response = decode_cached_github_import_response(response)?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize cached GitHub import: {error}"))
            })?;
            return Ok(GithubImportOperationClaim::Cached(response));
        }

        let claim_active: bool = row.get("claim_active");
        if matches!(status.as_str(), "pending" | "applied") && claim_active {
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize in-progress GitHub import: {error}"
                ))
            })?;
            return Ok(GithubImportOperationClaim::InProgress);
        }

        let other_active_key = transaction
            .query_opt(
                "select idempotency_key
                 from github_import_operations
                 where project_id = $1 and status in ('pending', 'applied')
                   and claim_expires_at > now() and idempotency_key <> $2
                 limit 1",
                &[project_id, &idempotency_key],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to inspect active GitHub imports: {error}"))
            })?;
        if other_active_key.is_some() {
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize active GitHub import lookup: {error}"
                ))
            })?;
            return Ok(GithubImportOperationClaim::InProgress);
        }

        let error_message: Option<String> = row.get("error_message");
        let created_at: DateTime<Utc> = row.get("created_at");
        let prepared_json: Option<PgJson<JsonValue>> = row.get("prepared_json");
        if !admission_granted
            && !github_import_operation_can_retry_without_admission(
                &status,
                error_message.as_deref(),
                prepared_json.is_some(),
                created_at,
                Utc::now(),
            )
        {
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize GitHub import admission lookup: {error}"
                ))
            })?;
            return Ok(GithubImportOperationClaim::AdmissionRequired);
        }

        let claim_id = Uuid::new_v4();
        let claim_expires_at =
            Utc::now() + ChronoDuration::minutes(GITHUB_IMPORT_OPERATION_LEASE_MINUTES);
        let resumed_status = if status == "applied" {
            "applied"
        } else {
            "pending"
        };
        let source_revision: Option<String> = row.get("source_revision");
        let prepared = prepared_json
            .map(|value| {
                serde_json::from_value::<GithubImportPreparedState>(value.0).map_err(|error| {
                    internal_error(format!(
                        "stored GitHub import preparation is invalid: {error}"
                    ))
                })
            })
            .transpose()?;
        if let (Some(source_revision), Some(prepared)) =
            (source_revision.as_deref(), prepared.as_ref())
        {
            if prepared.source_revision != source_revision {
                return Err(internal_error(
                    "stored GitHub import preparation has a mismatched source revision",
                ));
            }
        }
        let applied = if status == "applied" {
            let value: Option<PgJson<JsonValue>> = row.get("applied_json");
            Some(
                serde_json::from_value::<GithubImportAppliedState>(
                    value
                        .ok_or_else(|| {
                            internal_error(
                                "GitHub import operation is applied without an applied result",
                            )
                        })?
                        .0,
                )
                .map_err(|error| {
                    internal_error(format!("stored GitHub applied result is invalid: {error}"))
                })?,
            )
        } else {
            None
        };
        transaction
            .execute(
                "update github_import_operations
                 set status = $3, claim_id = $4, created_by = $5,
                     claim_expires_at = $6, response_json = null,
                     error_message = null, completed_at = null, updated_at = now()
                 where project_id = $1 and idempotency_key = $2",
                &[
                    project_id,
                    &idempotency_key,
                    &resumed_status,
                    &claim_id,
                    user_id,
                    &claim_expires_at,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to renew GitHub import claim: {error}"))
            })?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to commit renewed GitHub import claim: {error}"
            ))
        })?;
        return Ok(GithubImportOperationClaim::Claimed {
            claim_id,
            source_revision,
            prepared,
            applied,
        });
    }

    if !admission_granted {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finalize missing GitHub import lookup: {error}"
            ))
        })?;
        return Ok(GithubImportOperationClaim::AdmissionRequired);
    }

    let other_active_key = transaction
        .query_opt(
            "select idempotency_key
             from github_import_operations
             where project_id = $1 and status in ('pending', 'applied')
               and claim_expires_at > now()
             limit 1",
            &[project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to inspect active GitHub imports: {error}"))
        })?;
    if other_active_key.is_some() {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finalize active GitHub import lookup: {error}"
            ))
        })?;
        return Ok(GithubImportOperationClaim::InProgress);
    }

    let operation_id = Uuid::new_v4();
    let claim_id = Uuid::new_v4();
    let claim_expires_at =
        Utc::now() + ChronoDuration::minutes(GITHUB_IMPORT_OPERATION_LEASE_MINUTES);
    transaction
        .execute(
            "insert into github_import_operations (
               id, project_id, idempotency_key, repo, git_ref, target_path,
               status, claim_id, created_by, claim_expires_at
             ) values ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)",
            &[
                &operation_id,
                project_id,
                &idempotency_key,
                &repo,
                &git_ref,
                &target_path,
                &claim_id,
                user_id,
                &claim_expires_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to claim GitHub import: {error}")))?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit GitHub import claim: {error}"))
    })?;
    Ok(GithubImportOperationClaim::Claimed {
        claim_id,
        source_revision: None,
        prepared: None,
        applied: None,
    })
}

fn decode_cached_github_import_response(
    response: Option<PgJson<JsonValue>>,
) -> Result<ImportGithubResponse, (StatusCode, Json<ApiError>)> {
    let Some(response) = response else {
        return Err(internal_error(
            "GitHub import operation succeeded without a stored response",
        ));
    };
    let mut response =
        serde_json::from_value::<ImportGithubResponse>(response.0).map_err(|error| {
            internal_error(format!("stored GitHub import response is invalid: {error}"))
        })?;
    response.deduplicated = true;
    Ok(response)
}

/// Read-only fast path for a completed exact-payload replay. This must run
/// before rate admission so retrying an already-completed request neither
/// consumes import budget nor gets rejected after that budget is exhausted.
/// All other operation states fall through to the transactional exact-key
/// claim, which decides whether new-import admission is required.
async fn lookup_completed_github_import_replay(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    repo: &str,
    git_ref: &str,
    target_path: Option<&str>,
) -> Result<Option<ImportGithubResponse>, (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            "select repo, git_ref, target_path, status, response_json
             from github_import_operations
             where project_id = $1 and idempotency_key = $2",
            &[project_id, &idempotency_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect cached GitHub import operation: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Ok(None);
    };

    let stored_repo: String = row.get("repo");
    let stored_ref: String = row.get("git_ref");
    let stored_target_path: Option<String> = row.get("target_path");
    let status: String = row.get("status");
    if status != "succeeded"
        || !stored_repo.eq_ignore_ascii_case(repo)
        || stored_ref != git_ref
        || stored_target_path.as_deref() != target_path
    {
        return Ok(None);
    }

    let response = row.get::<_, Option<PgJson<JsonValue>>>("response_json");
    decode_cached_github_import_response(response).map(Some)
}

async fn complete_github_import_operation(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
    response: &ImportGithubResponse,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let response = PgJson(serde_json::to_value(response).map_err(|error| {
        internal_error(format!("failed to encode GitHub import response: {error}"))
    })?);
    let updated = connection
        .execute(
            "update github_import_operations
             set status = 'succeeded', response_json = $4, error_message = null,
                 completed_at = now(), updated_at = now()
             where project_id = $1 and idempotency_key = $2
               and claim_id = $3 and status in ('pending', 'applied')",
            &[project_id, &idempotency_key, claim_id, &response],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to persist GitHub import result: {error}"))
        })?;
    if updated != 1 {
        return Err(internal_error(
            "GitHub import operation claim changed before completion",
        ));
    }
    Ok(())
}

async fn prepare_github_import_operation(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
    prepared: &GithubImportPreparedState,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let source_revision = prepared.source_revision.clone();
    let prepared_json = PgJson(serde_json::to_value(prepared).map_err(|error| {
        internal_error(format!(
            "failed to encode GitHub import preparation: {error}"
        ))
    })?);
    let updated = connection
        .execute(
            "update github_import_operations
             set source_revision = $4, prepared_json = $5, updated_at = now()
             where project_id = $1 and idempotency_key = $2 and claim_id = $3
               and status = 'pending'
               and (source_revision is null or source_revision = $4)
               and (prepared_json is null or prepared_json = $5)",
            &[
                project_id,
                &idempotency_key,
                claim_id,
                &source_revision,
                &prepared_json,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to prepare GitHub import operation: {error}"
            ))
        })?;
    if updated != 1 {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::with_details(
                "The GitHub import source or origin changed before it could be pinned. Retry with a new import request.",
                "github_import_source_conflict",
                json!({}),
            )),
        ));
    }
    Ok(())
}

async fn update_github_import_prepared_auth(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
    prepared: &GithubImportPreparedState,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let prepared_json = PgJson(serde_json::to_value(prepared).map_err(|error| {
        internal_error(format!(
            "failed to encode updated GitHub import preparation: {error}"
        ))
    })?);
    let updated = connection
        .execute(
            "update github_import_operations
             set prepared_json = $4, updated_at = now()
             where project_id = $1 and idempotency_key = $2 and claim_id = $3
               and status = 'pending' and source_revision = $5",
            &[
                project_id,
                &idempotency_key,
                claim_id,
                &prepared_json,
                &prepared.source_revision,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to update GitHub import authentication checkpoint: {error}"
            ))
        })?;
    if updated != 1 {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::with_details(
                "The GitHub import operation changed before its retry could be prepared.",
                "github_import_preparation_conflict",
                json!({ "retryable": true }),
            )),
        ));
    }
    Ok(())
}

async fn mark_github_import_operation_applied(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
    applied: &GithubImportAppliedState,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let source_revision = applied.source_revision.clone();
    let applied = PgJson(serde_json::to_value(applied).map_err(|error| {
        internal_error(format!("failed to encode GitHub applied result: {error}"))
    })?);
    let claim_expires_at =
        Utc::now() + ChronoDuration::minutes(GITHUB_IMPORT_OPERATION_LEASE_MINUTES);
    let updated = connection
        .execute(
            "update github_import_operations
             set status = 'applied', applied_json = $4, source_revision = $5,
                 claim_expires_at = $6, error_message = null, updated_at = now()
             where project_id = $1 and idempotency_key = $2
               and claim_id = $3 and status = 'pending'",
            &[
                project_id,
                &idempotency_key,
                claim_id,
                &applied,
                &source_revision,
                &claim_expires_at,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to checkpoint applied GitHub import: {error}"
            ))
        })?;
    if updated != 1 {
        return Err(internal_error(
            "GitHub import operation claim changed before the applied checkpoint",
        ));
    }
    Ok(())
}

async fn renew_github_import_operation_claim(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let claim_expires_at =
        Utc::now() + ChronoDuration::minutes(GITHUB_IMPORT_OPERATION_LEASE_MINUTES);
    let updated = connection
        .execute(
            "update github_import_operations
             set claim_expires_at = $4, updated_at = now()
             where project_id = $1 and idempotency_key = $2 and claim_id = $3
               and status in ('pending', 'applied')",
            &[project_id, &idempotency_key, claim_id, &claim_expires_at],
        )
        .await
        .map_err(|error| internal_error(format!("failed to renew GitHub import claim: {error}")))?;
    if updated != 1 {
        return Err(internal_error(
            "GitHub import operation claim changed during execution",
        ));
    }
    Ok(())
}

async fn fail_github_import_operation(
    state: &AppState,
    project_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
    message: &str,
) {
    let Ok(connection) = state.pool.get().await else {
        return;
    };
    if let Err(error) = connection
        .execute(
            "update github_import_operations
             set status = case when status = 'applied' then 'applied' else 'failed' end,
                 error_message = $4, claim_expires_at = now(),
                 completed_at = case when status = 'applied' then completed_at else now() end,
                 updated_at = now()
             where project_id = $1 and idempotency_key = $2
               and claim_id = $3 and status in ('pending', 'applied')",
            &[project_id, &idempotency_key, claim_id, &message],
        )
        .await
    {
        warn!(?error, project_id = %project_id, "failed to mark GitHub import operation failed");
    }
}

async fn maintain_github_import_claims(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    lease_id: &Uuid,
    idempotency_key: &str,
    claim_id: &Uuid,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut interval = tokio::time::interval(Duration::from_secs(GITHUB_IMPORT_HEARTBEAT_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = &mut stop => return Ok(()),
            _ = interval.tick() => {
                let renewed = renew_long_lease(
                    &state.pool,
                    lease_id,
                    project_id,
                    Some(user_id),
                    None,
                    GITHUB_IMPORT_WORKSPACE_LEASE_SECONDS,
                    Some(&json!({ "source": "github_import" })),
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to renew GitHub import workspace lease: {error}"))
                })?;
                if renewed.is_none() {
                    return Err((
                        StatusCode::CONFLICT,
                        Json(ApiError::with_details(
                            "The workspace lease expired while importing GitHub. Retry the import.",
                            "github_import_lease_lost",
                            json!({ "retryable": true }),
                        )),
                    ));
                }
                renew_github_import_operation_claim(
                    state,
                    project_id,
                    idempotency_key,
                    claim_id,
                )
                .await?;
            }
        }
    }
}

async fn load_project_github_integration_state(
    state: &AppState,
    project_id: &Uuid,
) -> Result<ProjectGithubIntegrationState, (StatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    require_project_integrations_storage(&*connection).await?;
    let row = connection
        .query_opt(
            "select status, connection_type, metadata, updated_at
             from project_integrations
             where project_id = $1 and provider = 'github'
             limit 1",
            &[project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load project GitHub integration: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Ok(ProjectGithubIntegrationState {
            policy: ProjectGithubAuthPolicy::Automatic,
            updated_at: None,
        });
    };
    let status: String = row.get("status");
    let connection_type: String = row.get("connection_type");
    let metadata: PgJson<JsonValue> = row.get("metadata");
    let updated_at: DateTime<Utc> = row.get("updated_at");
    Ok(ProjectGithubIntegrationState {
        policy: resolve_project_github_auth_policy(
            Some(&status),
            Some(&connection_type),
            Some(&metadata.0),
        ),
        updated_at: Some(updated_at),
    })
}

async fn load_project_github_token(
    state: &AppState,
    project_id: &Uuid,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    if let Some(token) =
        load_project_secret_value_by_name(state, project_id, "GITHUB_TOKEN").await?
    {
        Ok(Some(token))
    } else {
        load_project_secret_value_by_name(state, project_id, "GH_TOKEN").await
    }
}

fn github_import_role_can_write(role: &str) -> bool {
    matches!(
        role.trim().to_ascii_lowercase().as_str(),
        "owner" | "admin" | "builder"
    )
}

async fn ensure_github_import_write_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(());
    }
    if let Some(claims) = context.scoped_claims.as_ref() {
        let scoped_project_id = Uuid::parse_str(claims.project_id.trim())
            .map_err(|_| unauthorized("access token project scope invalid"))?;
        if scoped_project_id != project.id || !claims_have_scopes(claims, &["fs.write"]) {
            return Err(forbidden("GitHub import requires project write access"));
        }
        return Ok(());
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required to import a repository"))?;
    if project.owner_user_id == Some(user_id) {
        return Ok(());
    }

    // An org-less project is private to its recorded owner. Legacy records
    // without an owner must not become writable merely because their UUID is
    // known to another authenticated user.
    let Some(org_id) = project.org_id else {
        return Err(forbidden("You do not have write access to this project"));
    };

    let project_role = transaction
        .query_opt(
            "select role from project_memberships where project_id = $1 and user_id = $2 limit 1",
            &[&project.id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load project membership role: {error}"))
        })?
        .map(|row| row.get::<_, String>("role"));
    if project_role
        .as_deref()
        .map(github_import_role_can_write)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let org_role = transaction
        .query_opt(
            "select role from org_memberships where org_id = $1 and user_id = $2 limit 1",
            &[&org_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org membership role: {error}")))?
        .map(|row| row.get::<_, String>("role"));
    if org_role
        .as_deref()
        .map(github_import_role_can_write)
        .unwrap_or(false)
    {
        return Ok(());
    }

    Err(forbidden(
        "Read-only members cannot import repositories into this project",
    ))
}

fn decrypt_project_secret_payload(
    key: &CredentialEncryptionKey,
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> anyhow::Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes())?;
    let nonce_raw = BASE64.decode(nonce_b64.trim().as_bytes())?;
    anyhow::ensure!(nonce_raw.len() == 12, "invalid nonce length");
    let nonce = Nonce::from_slice(&nonce_raw);
    let ciphertext = BASE64.decode(ciphertext_b64.trim().as_bytes())?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|error| anyhow::anyhow!("failed to decrypt secret payload: {error:?}"))?;
    Ok(plaintext)
}

async fn load_project_secret_value_by_name(
    state: &AppState,
    project_id: &Uuid,
    secret_name: &str,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let Some(key) = state.config.credential_encryption_key.as_ref() else {
        return Ok(None);
    };

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let row = match connection
        .query_opt(
            "select nonce_b64, ciphertext_b64
             from project_secrets
             where project_id = $1
               and upper(name) = upper($2)
               and revoked_at is null
             order by updated_at desc
             limit 1",
            &[project_id, &secret_name],
        )
        .await
    {
        Ok(row) => row,
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false)
            {
                return Ok(None);
            }
            return Err(internal_error(format!(
                "failed to load project secret {secret_name}: {error}"
            )));
        }
    };

    let Some(row) = row else {
        return Ok(None);
    };

    let nonce_b64: String = row.get("nonce_b64");
    let ciphertext_b64: String = row.get("ciphertext_b64");
    let plaintext = decrypt_project_secret_payload(key, &nonce_b64, &ciphertext_b64)
        .map_err(|error| internal_error(format!("failed to decrypt project secret: {error}")))?;
    let value =
        String::from_utf8(plaintext).map_err(|_| internal_error("secret payload must be utf-8"))?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed))
}

#[instrument(skip(state, headers, body))]
async fn import_github_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id): AxumPath<String>,
    Json(body): Json<ImportGithubBody>,
) -> Result<Json<ImportGithubResponse>, (StatusCode, Json<ApiError>)> {
    let project_uuid =
        Uuid::parse_str(project_id.trim()).map_err(|_| bad_request("invalid project id"))?;

    let context = authenticate_request(&state.config, &headers, None).await?;
    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("user session required"))?;

    {
        let mut conn = state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        let transaction = conn
            .transaction()
            .await
            .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
        let project = load_project_record(&transaction, &project_uuid).await?;
        // Shipped production gate: rejects scoped access tokens for writes and
        // enforces read + can_write() membership semantics.
        ensure_project_write_access(&transaction, &project, &context, None).await?;
        // Import-hardening layer: GitHub-import-specific role and scope checks.
        ensure_github_import_write_access(&transaction, &project, &context).await?;
        transaction.commit().await.map_err(|error| {
            internal_error(format!("failed to finalize project authorization: {error}"))
        })?;
    }

    let repo_spec = body.repo.trim();
    if repo_spec.is_empty() {
        return Err(bad_request("repo is required"));
    }
    let (owner, repo) = parse_github_repo(repo_spec).map_err(bad_request)?;
    let git_ref = parse_github_ref(body.git_ref.as_deref()).map_err(bad_request)?;
    let target_path = parse_import_target_path(body.target_path.as_deref()).map_err(bad_request)?;
    let idempotency_key = normalize_github_import_idempotency_key(body.idempotency_key)?
        .unwrap_or_else(|| format!("github-import-legacy:{}", Uuid::new_v4()));
    let canonical_repo = format!("{owner}/{repo}");

    ensure_github_import_operations_table(&state).await?;
    if let Some(response) = lookup_completed_github_import_replay(
        &state,
        &project_uuid,
        &idempotency_key,
        &canonical_repo,
        &git_ref,
        target_path.as_deref(),
    )
    .await?
    {
        return Ok(Json(response));
    }

    // Inspect the exact operation before rate admission. Cached responses and
    // the controller's narrowly marked workspace-busy retry state do not
    // spend new-import budget; all other receipts require admission.
    let mut operation_claim = claim_github_import_operation(
        &state,
        &project_uuid,
        &user_id,
        &idempotency_key,
        &canonical_repo,
        &git_ref,
        target_path.as_deref(),
        false,
    )
    .await?;

    if matches!(
        &operation_claim,
        GithubImportOperationClaim::AdmissionRequired
    ) {
        let mut admitted = state.config.dev_mode || context.is_service_role;
        let mut rate_limit = None;
        if !admitted {
            match state
                .rate_limiter
                .enforce(
                    format!("import:github:user:{user_id}"),
                    3,
                    Duration::from_secs(GITHUB_IMPORT_RATE_WINDOW_SECONDS),
                )
                .await
            {
                Ok(()) => admitted = true,
                Err(limit) => rate_limit = Some(limit),
            }
        }

        if admitted {
            operation_claim = claim_github_import_operation(
                &state,
                &project_uuid,
                &user_id,
                &idempotency_key,
                &canonical_repo,
                &git_ref,
                target_path.as_deref(),
                true,
            )
            .await?;
        } else {
            // Close the lookup/admission race without permitting a new row or
            // reclaiming a non-exempt receipt. A key that still requires
            // admission must receive the original 429.
            operation_claim = claim_github_import_operation(
                &state,
                &project_uuid,
                &user_id,
                &idempotency_key,
                &canonical_repo,
                &git_ref,
                target_path.as_deref(),
                false,
            )
            .await?;
            if matches!(
                &operation_claim,
                GithubImportOperationClaim::AdmissionRequired
            ) {
                let limit = rate_limit.ok_or_else(|| {
                    internal_error("GitHub import rate admission lost its rejection result")
                })?;
                let seconds = limit.retry_after.as_secs().max(1);
                return Err(too_many_requests(format!(
                    "Too many GitHub imports. Try again in {seconds}s."
                )));
            }
        }
    }

    let (operation_claim_id, operation_source_revision, operation_prepared, operation_applied) =
        match operation_claim {
            GithubImportOperationClaim::Claimed {
                claim_id,
                source_revision,
                prepared,
                applied,
            } => (claim_id, source_revision, prepared, applied),
            GithubImportOperationClaim::Cached(response) => return Ok(Json(response)),
            GithubImportOperationClaim::Conflict => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::with_details(
                        "GitHub import idempotency key was already used for a different repository, ref, or target path.",
                        "github_import_idempotency_conflict",
                        json!({}),
                    )),
                ));
            }
            GithubImportOperationClaim::InProgress => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::with_details(
                        "A GitHub import is already in progress for this project. Try again shortly.",
                        "github_import_in_progress",
                        json!({ "retryable": true }),
                    )),
                ));
            }
            GithubImportOperationClaim::AdmissionRequired => {
                return Err(internal_error(
                    "GitHub import admission completed without claiming an operation",
                ));
            }
        };

    let import_result: Result<ImportGithubResponse, (StatusCode, Json<ApiError>)> = async {
        let mut fresh_import_auth = None;
        let prepared_state = if operation_applied.is_some() {
            None
        } else if let Some(prepared) = operation_prepared.as_ref() {
            Some(prepared.clone())
        } else {
            let project_github_integration =
                load_project_github_integration_state(&state, &project_uuid).await?;
            let resolved_github_auth = resolve_github_import_request_auth(
                &state,
                user_id,
                &project_uuid,
                project_github_integration.policy,
                body.github_device_auth_session_id.as_deref(),
                body.github_token.clone(),
            )
            .await?;
            let source_revision = if let Some(revision) = operation_source_revision.clone() {
                revision
            } else {
                resolve_github_commit_revision(
                    &state,
                    &owner,
                    &repo,
                    &git_ref,
                    resolved_github_auth.token.as_deref(),
                )
                .await?
            };
            let resolved_origin = resolve_accessible_origin_for_protocol_with_hosted_fallback(
                &state,
                &project_uuid,
                "http",
                user_id,
                false,
            )
            .await?
            .ok_or_else(|| not_found("no origin available for project"))?;
            let persistent_connection = matches!(
                resolved_github_auth.source,
                GithubImportAuthSource::DeviceSession
                    | GithubImportAuthSource::UserOauth
                    | GithubImportAuthSource::ProjectToken
            );
            let prepared = GithubImportPreparedState {
                origin_id: resolved_origin.origin.id.to_string(),
                source_revision,
                auth_mode: resolved_github_auth.mode.to_string(),
                persistent_connection,
                user_oauth_fallback_enabled: resolved_github_auth.fallback_policy_after_import
                    == ProjectGithubAuthPolicy::Automatic,
                integration_updated_at: project_github_integration.updated_at,
            };
            prepare_github_import_operation(
                &state,
                &project_uuid,
                &idempotency_key,
                &operation_claim_id,
                &prepared,
            )
            .await?;
            fresh_import_auth = Some(resolved_github_auth);
            Some(prepared)
        };

        let lease_id = match acquire_fresh_lease(
            &state.pool,
            &project_uuid,
            Some(&user_id),
            None,
            GITHUB_IMPORT_WORKSPACE_LEASE_SECONDS,
            Some(&json!({ "source": "github_import" })),
        )
        .await
        .map_err(|error| internal_error(format!("failed to acquire lease: {error}")))?
        {
            LeaseAcquireOutcome::Granted(lease) => lease.id,
            // Kept defensive in case the fresh-acquire policy changes; the
            // current helper never renews a pre-existing lease.
            LeaseAcquireOutcome::Renewed(_) => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::with_details(
                        GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE,
                        "workspace_busy",
                        json!({ "retryable": true }),
                    )),
                ));
            }
            LeaseAcquireOutcome::Conflict { holder: _ } => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError::with_details(
                        GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE,
                        "workspace_busy",
                        json!({ "retryable": true }),
                    )),
                ));
            }
        };

        let mutation_started = Arc::new(AtomicBool::new(false));
        let mutation_started_for_work = mutation_started.clone();
        let (stop_tx, stop_rx) = oneshot::channel();
        let work = async {
            let (rev, applied) = if let Some(applied) = operation_applied.as_ref() {
                let rev = resume_applied_github_import(
                    &state,
                    &project_uuid,
                    &user_id,
                    &lease_id,
                    &canonical_repo,
                    applied,
                    mutation_started_for_work.as_ref(),
                )
                .await?;
                (rev, applied.clone())
            } else {
                'prepare_or_apply: {
                let prepared = prepared_state
                    .as_ref()
                    .ok_or_else(|| internal_error("GitHub import was not prepared"))?;
                if operation_prepared.is_some() {
                    match query_prepared_origin_apply_status(
                        &state,
                        &project_uuid,
                        &user_id,
                        &lease_id,
                        &canonical_repo,
                        target_path.as_deref(),
                        &idempotency_key,
                        prepared,
                    )
                    .await?
                    {
                        OriginApplyStatus::Succeeded {
                            rev,
                            file_count,
                            bytes_written,
                        } => {
                            let applied = GithubImportAppliedState {
                                origin_id: prepared.origin_id.clone(),
                                origin_rev: rev,
                                source_revision: prepared.source_revision.clone(),
                                file_count,
                                bytes_written,
                                auth_mode: prepared.auth_mode.clone(),
                                persistent_connection: prepared.persistent_connection,
                                user_oauth_fallback_enabled: prepared
                                    .user_oauth_fallback_enabled,
                                integration_updated_at: prepared.integration_updated_at,
                            };
                            mark_github_import_operation_applied(
                                &state,
                                &project_uuid,
                                &idempotency_key,
                                &operation_claim_id,
                                &applied,
                            )
                            .await?;
                            let synced_rev = resume_applied_github_import(
                                &state,
                                &project_uuid,
                                &user_id,
                                &lease_id,
                                &canonical_repo,
                                &applied,
                                mutation_started_for_work.as_ref(),
                            )
                            .await?;
                            break 'prepare_or_apply (synced_rev, applied);
                        }
                        // A pending receipt may belong to a detached worker or
                        // a crashed stale claim. Re-entering /apply with the
                        // same key/fingerprint lets origin either replay,
                        // serialize behind the live worker, or recover it.
                        OriginApplyStatus::Pending | OriginApplyStatus::Missing => {}
                    }
                }

                let (resolved_github_auth, effective_prepared) =
                    if let Some(auth) = fresh_import_auth.clone() {
                        (auth, prepared.clone())
                    } else {
                        // Connection changes made after the preparation
                        // checkpoint are authoritative for any retry that
                        // still needs GitHub. This prevents a disconnect or
                        // account switch from silently reusing stale OAuth.
                        let current_integration =
                            load_project_github_integration_state(&state, &project_uuid).await?;
                        let auth = resolve_github_import_request_auth(
                            &state,
                            user_id,
                            &project_uuid,
                            current_integration.policy,
                            body.github_device_auth_session_id.as_deref(),
                            body.github_token.clone(),
                        )
                        .await?;
                        let persistent_connection = matches!(
                            auth.source,
                            GithubImportAuthSource::DeviceSession
                                | GithubImportAuthSource::UserOauth
                                | GithubImportAuthSource::ProjectToken
                        );
                        let updated_prepared = GithubImportPreparedState {
                            origin_id: prepared.origin_id.clone(),
                            source_revision: prepared.source_revision.clone(),
                            auth_mode: auth.mode.to_string(),
                            persistent_connection,
                            user_oauth_fallback_enabled: auth.fallback_policy_after_import
                                == ProjectGithubAuthPolicy::Automatic,
                            integration_updated_at: current_integration.updated_at,
                        };
                        update_github_import_prepared_auth(
                            &state,
                            &project_uuid,
                            &idempotency_key,
                            &operation_claim_id,
                            &updated_prepared,
                        )
                        .await?;
                        (auth, updated_prepared)
                    };
                import_github_zip_and_apply(
                    &state,
                    &project_uuid,
                    &user_id,
                    &lease_id,
                    &owner,
                    &repo,
                    target_path.as_deref(),
                    resolved_github_auth.token.as_deref(),
                    &idempotency_key,
                    &operation_claim_id,
                    &effective_prepared,
                    mutation_started_for_work.as_ref(),
                )
                .await?
                }
            };

            let response = ImportGithubResponse {
                ok: true,
                project_id: project_uuid.to_string(),
                repo: canonical_repo.clone(),
                git_ref: Some(git_ref.clone()),
                target_path: target_path.clone(),
                file_count: applied.file_count,
                bytes_written: applied.bytes_written,
                rev: Some(rev.clone()),
                deduplicated: false,
            };

            let integration_status = if applied.persistent_connection {
                "connected"
            } else {
                "imported"
            };
            let required_scopes = if applied.auth_mode == "public" {
                Vec::new()
            } else {
                vec!["repo".to_string()]
            };
            // A public or explicit body token authorizes only this import. It
            // must not replace an existing connected/disconnected account
            // row with an "imported" pseudo-connection.
            if !applied.persistent_connection && applied.integration_updated_at.is_some() {
                tracing::debug!(
                    project_id = %project_uuid,
                    "preserving existing GitHub integration after one-shot import"
                );
            } else {
                // A connection/disconnect change made after this import
                // started wins. The observed version is checkpointed with the
                // applied operation so a crash-safe resume makes the same CAS.
                match upsert_project_integration_record_if_unchanged(
                &state,
                project_uuid,
                "github",
                Some(user_id),
                ProjectIntegrationUpsert {
                    status: integration_status.to_string(),
                    connection_type: applied.auth_mode.clone(),
                    credential_id: None,
                    metadata: json!({
                        "source": "github_import",
                        "repo": canonical_repo,
                        "ref": git_ref,
                        "targetPath": target_path,
                        "rev": rev,
                        "authMode": applied.auth_mode,
                        "userOauthFallbackEnabled": applied.user_oauth_fallback_enabled,
                        "sourceRevision": applied.source_revision,
                        "fileCount": applied.file_count,
                        "bytesWritten": applied.bytes_written,
                        "importedAt": Utc::now().to_rfc3339(),
                    }),
                    required_scopes,
                    capabilities: vec!["repo.read".to_string()],
                },
                applied.integration_updated_at,
            )
                .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        warn!(
                            project_id = %project_uuid,
                            "GitHub integration changed during import; preserving the newer connection policy"
                        );
                    }
                    Err(error) => {
                        warn!(
                            ?error,
                            project_id = %project_uuid,
                            repo = format!("{owner}/{repo}"),
                            "failed to persist github integration metadata after import"
                        );
                    }
                }
            }

            // Required while the workspace lease and operation heartbeat are
            // still held: once a writer can advance HEAD, this exact response
            // must already be replayable without touching the workspace.
            complete_github_import_operation(
                &state,
                &project_uuid,
                &idempotency_key,
                &operation_claim_id,
                &response,
            )
            .await?;

            Ok(response)
        };
        let heartbeat = maintain_github_import_claims(
            &state,
            &project_uuid,
            &user_id,
            &lease_id,
            &idempotency_key,
            &operation_claim_id,
            stop_rx,
        );
        tokio::pin!(work);
        tokio::pin!(heartbeat);
        let work_result = tokio::select! {
            result = &mut work => {
                let _ = stop_tx.send(());
                heartbeat.await?;
                result
            }
            heartbeat_result = &mut heartbeat => {
                match heartbeat_result {
                    Ok(()) => Err(internal_error("GitHub import heartbeat stopped unexpectedly")),
                    Err(error) => Err(error),
                }
            }
        };

        let release_is_safe = work_result.is_ok() || !mutation_started.load(Ordering::Acquire);
        if release_is_safe {
            match release_lease(
                &state.pool,
                &lease_id,
                &project_uuid,
                Some(&user_id),
                None,
                "released",
            )
            .await
            {
                Ok(Some(_)) => {}
                Ok(None) => {
                    tracing::warn!(lease_id = %lease_id, "github import lease was not active at release");
                }
                Err(error) => {
                    tracing::warn!(?error, lease_id = %lease_id, "failed to release lease after github import");
                }
            }
        } else {
            // The origin may still be finishing a detached blocking mutation
            // after a timeout/cancel. Leave the lease to expire instead of
            // explicitly opening a concurrent-write window.
            tracing::warn!(
                lease_id = %lease_id,
                "retaining GitHub import lease after an ambiguous mutation failure"
            );
        }

        work_result
    }
    .await;

    let response = match import_result {
        Ok(response) => response,
        Err(error) => {
            fail_github_import_operation(
                &state,
                &project_uuid,
                &idempotency_key,
                &operation_claim_id,
                &error.1 .0.message,
            )
            .await;
            return Err(error);
        }
    };

    Ok(Json(response))
}

async fn load_prepared_github_import_origin(
    state: &AppState,
    project_id: &Uuid,
    prepared: &GithubImportPreparedState,
) -> Result<WorkspaceOriginRecord, (StatusCode, Json<ApiError>)> {
    let origin_id = Uuid::parse_str(&prepared.origin_id)
        .map_err(|_| internal_error("stored GitHub import origin id is invalid"))?;
    let origin = load_origin_by_id(&state.pool, &origin_id)
        .await
        .map_err(|error| internal_error(format!("failed to load prepared import origin: {error}")))?
        .ok_or_else(|| not_found("the prepared GitHub import origin is no longer available"))?;
    if origin.project_id != *project_id {
        return Err(internal_error(
            "prepared GitHub import origin belongs to a different project",
        ));
    }
    if !origin.protocols.iter().any(|protocol| protocol == "http") {
        return Err(internal_error(
            "prepared GitHub import origin no longer supports HTTP",
        ));
    }
    Ok(origin)
}

fn mint_github_import_origin_token(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    lease_id: &Uuid,
    origin: &WorkspaceOriginRecord,
    ttl_seconds: i64,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: origin.id.to_string(),
            subject: user_id.to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin.id.to_string()),
            runtime_id: None,
            protocol: Some("http".to_string()),
            scopes: vec!["fs.write".to_string()],
            lease_id: Some(lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(ttl_seconds),
        },
    )
    .map(|token| token.token)
}

async fn query_prepared_origin_apply_status(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    lease_id: &Uuid,
    canonical_repo: &str,
    target_path: Option<&str>,
    idempotency_key: &str,
    prepared: &GithubImportPreparedState,
) -> Result<OriginApplyStatus, (StatusCode, Json<ApiError>)> {
    let origin = load_prepared_github_import_origin(state, project_id, prepared).await?;
    let scoped_token = mint_github_import_origin_token(
        state,
        project_id,
        user_id,
        lease_id,
        &origin,
        GITHUB_IMPORT_STATUS_TOKEN_TTL_SECONDS,
    )?;
    let request_fingerprint =
        github_import_request_fingerprint(canonical_repo, &prepared.source_revision, target_path);
    let (origin_base, host_override) = resolve_origin_proxy_upstream_endpoint(&origin.endpoint);
    let status_url = format!("{}/apply/status", origin_base.trim_end_matches('/'));
    let mut request = state
        .http_client
        .post(status_url)
        .bearer_auth(&scoped_token)
        .json(&json!({
            "idempotencyKey": idempotency_key,
            "requestFingerprint": request_fingerprint,
        }));
    if let Some(host) = host_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.header("host", host);
    }

    let (status, body) = execute_bounded_origin_request(
        request,
        "apply status",
        Duration::from_secs(ORIGIN_APPLY_STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|error| internal_error(error.message))?;
    parse_origin_apply_status_response(status, &body)
}

fn parse_origin_apply_status_response(
    status: reqwest::StatusCode,
    body: &[u8],
) -> Result<OriginApplyStatus, (StatusCode, Json<ApiError>)> {
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(OriginApplyStatus::Missing);
    }
    if status == reqwest::StatusCode::CONFLICT {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::with_details(
                "The stored origin receipt belongs to a different GitHub import request.",
                "github_import_origin_receipt_conflict",
                json!({}),
            )),
        ));
    }
    if !status.is_success() {
        return Err(internal_error(format!(
            "origin apply status failed ({}): {}",
            status.as_u16(),
            String::from_utf8_lossy(body)
        )));
    }

    let payload = serde_json::from_slice::<OriginApplyStatusPayload>(body).map_err(|error| {
        internal_error(format!("origin apply status response invalid: {error}"))
    })?;
    match payload.status.trim() {
        "pending" => Ok(OriginApplyStatus::Pending),
        "succeeded" => {
            let rev = payload
                .rev
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| internal_error("origin apply receipt is missing rev"))?;
            let file_count = payload
                .file_count
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| internal_error("origin apply receipt is missing fileCount"))?;
            let bytes_written = payload
                .bytes_written
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| internal_error("origin apply receipt is missing bytesWritten"))?;
            Ok(OriginApplyStatus::Succeeded {
                rev,
                file_count,
                bytes_written,
            })
        }
        _ => Err(internal_error("origin apply status response is invalid")),
    }
}

async fn import_github_zip_and_apply(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    lease_id: &Uuid,
    owner: &str,
    repo: &str,
    target_path: Option<&str>,
    github_token: Option<&str>,
    idempotency_key: &str,
    claim_id: &Uuid,
    prepared_state: &GithubImportPreparedState,
    mutation_started: &AtomicBool,
) -> Result<(String, GithubImportAppliedState), (StatusCode, Json<ApiError>)> {
    let _admission = GITHUB_IMPORT_ADMISSION.acquire().await.map_err(|_| {
        internal_error("GitHub import admission control is unavailable. Please try again.")
    })?;
    let archive_limits = github_import_archive_limits();
    let zip_bytes = download_github_zipball(
        state,
        owner,
        repo,
        &prepared_state.source_revision,
        github_token,
        archive_limits.download_bytes,
    )
    .await?;

    let target_prefix = target_path.map(str::to_string);
    let prepared_archive = tokio::task::spawn_blocking(move || {
        repack_github_zip_with_limits(zip_bytes, target_prefix, archive_limits)
    })
    .await
    .map_err(|error| internal_error(format!("zip repack task failed: {error}")))?
    .map_err(bad_request)?;

    if prepared_archive.files.is_empty() {
        return Err(bad_request("zipball contained no files to import"));
    }
    let max_archive_bytes = archive_limits.repacked_bytes;
    let archive_size_bytes = prepared_archive.archive.len();
    if archive_size_bytes > max_archive_bytes {
        return Err(bad_request(format!(
            "import archive is too large ({} bytes). current limit is {} bytes",
            archive_size_bytes, max_archive_bytes
        )));
    }

    let origin = load_prepared_github_import_origin(state, project_id, prepared_state).await?;
    let scoped_token = mint_github_import_origin_token(
        state,
        project_id,
        user_id,
        lease_id,
        &origin,
        GITHUB_IMPORT_APPLY_TOKEN_TTL_SECONDS,
    )?;

    let canonical_repo = format!("{owner}/{repo}");
    let request_fingerprint = github_import_request_fingerprint(
        &canonical_repo,
        &prepared_state.source_revision,
        target_path,
    );
    let commit_message = format!(
        "instafy: import {owner}/{repo}@{}",
        &prepared_state.source_revision[..12.min(prepared_state.source_revision.len())]
    );
    let manifest = build_origin_manifest(
        project_id,
        lease_id,
        &prepared_archive.files,
        Some(commit_message.clone()),
        Some(idempotency_key),
        Some(&request_fingerprint),
    );
    let manifest_json = serde_json::to_vec(&manifest)
        .map_err(|error| internal_error(format!("failed to encode origin manifest: {error}")))?;
    let (origin_base, host_override) = resolve_origin_proxy_upstream_endpoint(&origin.endpoint);
    let apply_url = format!("{}/apply", origin_base.trim_end_matches('/'));
    let form = reqwest::multipart::Form::new()
        .part(
            "manifest",
            Part::bytes(manifest_json)
                .file_name("manifest.json")
                .mime_str("application/json")
                .map_err(|error| {
                    internal_error(format!("failed to build manifest part: {error}"))
                })?,
        )
        .part(
            "archive",
            Part::bytes(prepared_archive.archive)
                .file_name("workspace.zip")
                .mime_str("application/zip")
                .map_err(|error| {
                    internal_error(format!("failed to build archive part: {error}"))
                })?,
        );

    let mut request = state.http_client.post(apply_url).bearer_auth(&scoped_token);
    if let Some(host) = host_override
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.header("host", host);
    }
    let (status, response_body) = execute_bounded_mutating_origin_request(
        request.multipart(form),
        "apply",
        Duration::from_secs(ORIGIN_APPLY_TIMEOUT_SECS),
        Some(mutation_started),
    )
    .await
    .map_err(|error| internal_error(error.message))?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&response_body);
        warn!(
            project_id = %project_id,
            status = status.as_u16(),
            archive_size_bytes,
            body = %text,
            "origin apply import request failed"
        );
        if status.as_u16() == 413 {
            return Err(bad_request(format!(
                "origin rejected the import archive as too large (status {}). archive size: {} bytes. raise ORIGIN_MAX_ARCHIVE_BYTES / CONTROLLER_IMPORT_MAX_ARCHIVE_BYTES",
                status.as_u16(),
                archive_size_bytes
            )));
        }
        return Err(internal_error(format!(
            "origin apply failed ({}): {}",
            status.as_u16(),
            text
        )));
    }

    let payload = serde_json::from_slice::<serde_json::Value>(&response_body)
        .map_err(|error| internal_error(format!("origin apply response invalid: {error}")))?;
    let rev = payload
        .get("rev")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    if rev.is_empty() {
        return Err(internal_error("origin apply response missing rev"));
    }
    let applied_file_count = payload
        .get("fileCount")
        .and_then(JsonValue::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or_else(|| {
            warn!(
                project_id = %project_id,
                "origin apply response omitted fileCount; using prepared manifest count"
            );
            prepared_archive.files.len()
        });
    let applied_bytes_written = payload
        .get("bytesWritten")
        .and_then(JsonValue::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or_else(|| {
            warn!(
                project_id = %project_id,
                "origin apply response omitted bytesWritten; using prepared archive count"
            );
            prepared_archive.bytes_written
        });

    let applied = GithubImportAppliedState {
        origin_id: origin.id.to_string(),
        origin_rev: rev.clone(),
        source_revision: prepared_state.source_revision.clone(),
        file_count: applied_file_count,
        bytes_written: applied_bytes_written,
        auth_mode: prepared_state.auth_mode.clone(),
        persistent_connection: prepared_state.persistent_connection,
        user_oauth_fallback_enabled: prepared_state.user_oauth_fallback_enabled,
        integration_updated_at: prepared_state.integration_updated_at,
    };
    // This checkpoint is required before the optional push/sync phase. A
    // retry can now resume against the exact origin/revision without asking
    // GitHub again or applying the archive a second time.
    mark_github_import_operation_applied(state, project_id, idempotency_key, claim_id, &applied)
        .await?;

    let sync_token = mint_github_import_origin_token(
        state,
        project_id,
        user_id,
        lease_id,
        &origin,
        GITHUB_IMPORT_SYNC_TOKEN_TTL_SECONDS,
    )?;
    let synced_rev = sync_origin_git_after_apply(
        &state.http_client,
        &origin_base,
        host_override.as_deref(),
        &sync_token,
        &commit_message,
        &rev,
        Some(mutation_started),
    )
    .await
    .map_err(|error| internal_error(error.message))?;

    Ok((synced_rev.unwrap_or(rev), applied))
}

async fn resume_applied_github_import(
    state: &AppState,
    project_id: &Uuid,
    user_id: &Uuid,
    lease_id: &Uuid,
    canonical_repo: &str,
    applied: &GithubImportAppliedState,
    mutation_started: &AtomicBool,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let origin_id = Uuid::parse_str(&applied.origin_id)
        .map_err(|_| internal_error("stored GitHub import origin id is invalid"))?;
    let origin = load_origin_by_id(&state.pool, &origin_id)
        .await
        .map_err(|error| internal_error(format!("failed to load applied import origin: {error}")))?
        .ok_or_else(|| {
            not_found("the origin used for this GitHub import is no longer available")
        })?;
    if origin.project_id != *project_id {
        return Err(internal_error(
            "stored GitHub import origin belongs to a different project",
        ));
    }
    let scoped_token = mint_github_import_origin_token(
        state,
        project_id,
        user_id,
        lease_id,
        &origin,
        GITHUB_IMPORT_SYNC_TOKEN_TTL_SECONDS,
    )?;
    let (origin_base, host_override) = resolve_origin_proxy_upstream_endpoint(&origin.endpoint);
    let commit_message = format!(
        "instafy: import {canonical_repo}@{}",
        &applied.source_revision[..12.min(applied.source_revision.len())]
    );
    let synced_rev = sync_origin_git_after_apply(
        &state.http_client,
        &origin_base,
        host_override.as_deref(),
        &scoped_token,
        &commit_message,
        &applied.origin_rev,
        Some(mutation_started),
    )
    .await
    .map_err(|error| internal_error(error.message))?;
    Ok(synced_rev.unwrap_or_else(|| applied.origin_rev.clone()))
}

async fn sync_origin_git_after_apply(
    http_client: &reqwest::Client,
    origin_base: &str,
    host_override: Option<&str>,
    bearer_token: &str,
    commit_message: &str,
    expected_rev: &str,
    mutation_started: Option<&AtomicBool>,
) -> Result<Option<String>, OriginRequestError> {
    let sync_url = format!("{}/git/sync", origin_base.trim_end_matches('/'));
    let mut request = http_client
        .post(sync_url)
        .bearer_auth(bearer_token)
        .json(&json!({
            "message": commit_message,
            "expectedRev": expected_rev,
        }));

    if let Some(host) = host_override.filter(|value| !value.trim().is_empty()) {
        request = request.header("host", host);
    }

    let (status, response_body) = execute_bounded_mutating_origin_request(
        request,
        "git sync",
        Duration::from_secs(ORIGIN_GIT_SYNC_TIMEOUT_SECS),
        mutation_started,
    )
    .await?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&response_body);
        if status.as_u16() == 400 && text.contains(ORIGIN_GIT_REMOTE_NOT_CONFIGURED) {
            return Ok(None);
        }
        return Err(OriginRequestError {
            message: format!("origin git sync failed ({}): {}", status.as_u16(), text),
            ambiguous: false,
        });
    }

    let payload = serde_json::from_slice::<serde_json::Value>(&response_body).map_err(|error| {
        OriginRequestError {
            message: format!("origin git sync response invalid: {error}"),
            ambiguous: false,
        }
    })?;
    let rev = payload
        .get("rev")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if rev.is_empty() {
        return Err(OriginRequestError {
            message: "origin git sync response missing rev".to_string(),
            ambiguous: false,
        });
    }

    Ok(Some(rev))
}

async fn execute_bounded_origin_request(
    request: reqwest::RequestBuilder,
    operation: &'static str,
    request_timeout: Duration,
) -> Result<(reqwest::StatusCode, Vec<u8>), OriginRequestError> {
    let response_received = AtomicBool::new(false);
    let result = timeout(request_timeout, async {
        let response = request.send().await.map_err(|error| OriginRequestError {
            message: format!("origin {operation} request failed: {error}"),
            // Connection establishment and request-builder failures happen
            // before the origin handler can receive the mutation. Other send
            // failures may occur after request bytes were transmitted.
            ambiguous: !error.is_connect() && !error.is_builder(),
        })?;
        // Axum/Hyper do not produce response headers until the route handler
        // has returned. Once headers arrive, the mutation itself is settled;
        // a body decoding/size failure is no longer an ambiguous write.
        response_received.store(true, Ordering::Release);
        let status = response.status();
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| OriginRequestError {
                message: format!("origin {operation} response failed: {error}"),
                ambiguous: false,
            })?;
            let next_len =
                body.len()
                    .checked_add(chunk.len())
                    .ok_or_else(|| OriginRequestError {
                        message: format!("origin {operation} response is too large"),
                        ambiguous: false,
                    })?;
            if next_len > ORIGIN_RESPONSE_MAX_BYTES {
                return Err(OriginRequestError {
                    message: format!(
                        "origin {operation} response exceeds {ORIGIN_RESPONSE_MAX_BYTES} bytes"
                    ),
                    ambiguous: false,
                });
            }
            body.extend_from_slice(&chunk);
        }
        Ok((status, body))
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => Err(OriginRequestError {
            message: format!("origin {operation} request timed out"),
            ambiguous: !response_received.load(Ordering::Acquire),
        }),
    }
}

async fn execute_bounded_mutating_origin_request(
    request: reqwest::RequestBuilder,
    operation: &'static str,
    request_timeout: Duration,
    mutation_may_be_in_flight: Option<&AtomicBool>,
) -> Result<(reqwest::StatusCode, Vec<u8>), OriginRequestError> {
    if let Some(flag) = mutation_may_be_in_flight {
        flag.store(true, Ordering::Release);
    }
    let result = execute_bounded_origin_request(request, operation, request_timeout).await;
    if let Some(flag) = mutation_may_be_in_flight {
        if matches!(
            &result,
            Ok(_)
                | Err(OriginRequestError {
                    ambiguous: false,
                    ..
                })
        ) {
            flag.store(false, Ordering::Release);
        }
    }
    result
}

async fn download_github_zipball(
    state: &AppState,
    owner: &str,
    repo: &str,
    git_ref: &str,
    github_token: Option<&str>,
    max_download_bytes: usize,
) -> Result<Vec<u8>, (StatusCode, Json<ApiError>)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/zipball/{}",
        urlencoding::encode(owner),
        urlencoding::encode(repo),
        urlencoding::encode(git_ref)
    );

    let mut request = state
        .http_client
        .get(url)
        .header("Accept", "application/vnd.github+json");

    if let Some(token) = github_token
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        request = request.header("Authorization", format!("Bearer {token}"));
    }

    let response = timeout(Duration::from_secs(30), request.send())
        .await
        .map_err(|_| internal_error("GitHub request timed out"))?
        .map_err(|error| internal_error(format!("GitHub request failed: {error}")))?;

    let status = response.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let token_present = github_token
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .is_some();
        let rate_limited = status_code == 403
            && response
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                == Some("0");
        let text = response.text().await.unwrap_or_default();
        let detail =
            parse_github_api_error_message(&text).unwrap_or_else(|| "unknown error".to_string());

        let (response_status, code, message) = match status_code {
            401 => (
                StatusCode::BAD_REQUEST,
                "github_auth_failed",
                "GitHub authentication failed. Connect GitHub and try again.".to_string(),
            ),
            403 if rate_limited => (
                StatusCode::TOO_MANY_REQUESTS,
                "github_rate_limited",
                "GitHub rate-limited this import. Try again later.".to_string(),
            ),
            403 => (
                StatusCode::FORBIDDEN,
                "github_access_denied",
                "GitHub denied access to this repository.".to_string(),
            ),
            404 => {
                if token_present {
                    (
                        StatusCode::BAD_REQUEST,
                        "github_access_or_not_found",
                        "GitHub repo or ref not found (or you do not have access).".to_string(),
                    )
                } else {
                    (
                        StatusCode::BAD_REQUEST,
                        "github_auth_required",
                        "GitHub repo or ref not found. If this is a private repo, connect GitHub and try again."
                            .to_string(),
                    )
                }
            }
            _ => (
                StatusCode::BAD_GATEWAY,
                "github_download_failed",
                format!("GitHub zipball download failed ({status_code}): {detail}"),
            ),
        };

        return Err((
            response_status,
            Json(ApiError::with_details(
                message,
                code,
                json!({ "githubStatus": status_code }),
            )),
        ));
    }

    read_github_zipball_body(response, max_download_bytes).await
}

async fn read_github_zipball_body(
    response: reqwest::Response,
    max_download_bytes: usize,
) -> Result<Vec<u8>, (StatusCode, Json<ApiError>)> {
    if response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .map(|length| length > max_download_bytes)
        .unwrap_or(false)
    {
        return Err(github_import_payload_too_large(format!(
            "GitHub zipball exceeds the compressed download limit of {max_download_bytes} bytes"
        )));
    }

    let mut stream = response.bytes_stream();
    timeout(Duration::from_secs(120), async move {
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                internal_error(format!("GitHub zipball read failed: {error}"))
            })?;
            let next_len = bytes
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| {
                    github_import_payload_too_large(
                        "GitHub zipball size overflowed the download limit".to_string(),
                    )
                })?;
            if next_len > max_download_bytes {
                return Err(github_import_payload_too_large(format!(
                    "GitHub zipball exceeds the compressed download limit of {max_download_bytes} bytes"
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| internal_error("GitHub zipball read timed out"))?
}

fn github_import_payload_too_large(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(ApiError::with_details(
            message,
            "github_import_too_large",
            json!({}),
        )),
    )
}

async fn resolve_github_commit_revision(
    state: &AppState,
    owner: &str,
    repo: &str,
    git_ref: &str,
    github_token: Option<&str>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}",
        urlencoding::encode(owner),
        urlencoding::encode(repo),
        urlencoding::encode(git_ref)
    );
    let mut request = state
        .http_client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    let token_present = github_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    if let Some(token) = github_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("Authorization", format!("Bearer {token}"));
    }

    let response = timeout(Duration::from_secs(30), request.send())
        .await
        .map_err(|_| internal_error("GitHub commit lookup timed out"))?
        .map_err(|error| internal_error(format!("GitHub commit lookup failed: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let rate_limited = status_code == 403
            && response
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                == Some("0");
        let text = response.text().await.unwrap_or_default();
        let detail =
            parse_github_api_error_message(&text).unwrap_or_else(|| "unknown error".to_string());
        let (response_status, code, message) = match status_code {
            401 => (
                StatusCode::BAD_REQUEST,
                "github_auth_failed",
                "GitHub authentication failed. Connect GitHub and try again.".to_string(),
            ),
            403 if rate_limited => (
                StatusCode::TOO_MANY_REQUESTS,
                "github_rate_limited",
                "GitHub rate-limited this import. Try again later.".to_string(),
            ),
            403 => (
                StatusCode::FORBIDDEN,
                "github_access_denied",
                "GitHub denied access to this repository.".to_string(),
            ),
            404 if token_present => (
                StatusCode::BAD_REQUEST,
                "github_access_or_not_found",
                "GitHub repo or ref not found (or you do not have access).".to_string(),
            ),
            404 => (
                StatusCode::BAD_REQUEST,
                "github_auth_required",
                "GitHub repo or ref not found. If this is a private repo, connect GitHub and try again."
                    .to_string(),
            ),
            _ => (
                StatusCode::BAD_GATEWAY,
                "github_download_failed",
                format!("GitHub commit lookup failed ({status_code}): {detail}"),
            ),
        };
        return Err((
            response_status,
            Json(ApiError::with_details(
                message,
                code,
                json!({ "githubStatus": status_code }),
            )),
        ));
    }

    let payload = response
        .json::<JsonValue>()
        .await
        .map_err(|error| internal_error(format!("GitHub commit response invalid: {error}")))?;
    let revision = payload
        .get("sha")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| internal_error("GitHub commit response missing a valid SHA"))?;
    Ok(revision.to_ascii_lowercase())
}

fn github_import_request_fingerprint(
    canonical_repo: &str,
    source_revision: &str,
    target_path: Option<&str>,
) -> String {
    let canonical = format!(
        "github-import:v1\nrepo={}\nsource={}\ntarget={}\n",
        canonical_repo.to_ascii_lowercase(),
        source_revision.to_ascii_lowercase(),
        target_path.unwrap_or_default()
    );
    let digest = Sha256::digest(canonical.as_bytes());
    format!("sha256:{digest:x}")
}

fn parse_github_api_error_message(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = value.get("message").and_then(JsonValue::as_str) {
            let message = message.trim();
            if !message.is_empty() {
                return Some(message.to_string());
            }
        }
    }

    Some(trimmed.to_string())
}

fn parse_github_repo(input: &str) -> Result<(String, String), String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("repo is required".to_string());
    }

    let mut candidate = if let Some(rest) = raw.strip_prefix("git@github.com:") {
        rest.to_string()
    } else if let Some(rest) = raw.strip_prefix("ssh://git@github.com/") {
        rest.to_string()
    } else if let Some(rest) = raw
        .strip_prefix("github.com/")
        .or_else(|| raw.strip_prefix("www.github.com/"))
    {
        rest.to_string()
    } else if raw.contains("://") {
        let parsed = reqwest::Url::parse(raw)
            .map_err(|_| "repo must be a GitHub URL or owner/repo".to_string())?;
        if !matches!(
            parsed.host_str(),
            Some("github.com") | Some("www.github.com")
        ) {
            return Err("repo URL host must be github.com".to_string());
        }
        parsed.path().trim_start_matches('/').to_string()
    } else {
        raw.to_string()
    };

    candidate = candidate
        .trim_start_matches('/')
        .split(&['?', '#'][..])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();

    let parts = candidate
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err("repo must be an exact owner/repo reference".to_string());
    }
    let owner = parts[0];
    let repo = parts[1];

    let valid_segment = |value: &str| {
        value != "."
            && value != ".."
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };
    if !valid_segment(owner.trim()) || !valid_segment(repo.trim()) {
        return Err("repo owner and name contain unsupported characters".to_string());
    }
    if owner.len() > GITHUB_OWNER_MAX_BYTES {
        return Err(format!(
            "GitHub owner is too long (max {GITHUB_OWNER_MAX_BYTES} bytes)"
        ));
    }
    if repo.len() > GITHUB_REPO_MAX_BYTES {
        return Err(format!(
            "GitHub repository name is too long (max {GITHUB_REPO_MAX_BYTES} bytes)"
        ));
    }

    Ok((owner.trim().to_string(), repo.trim().to_string()))
}

fn parse_github_ref(raw: Option<&str>) -> Result<String, String> {
    let value = raw.map(str::trim).filter(|value| !value.is_empty());
    let value = value.unwrap_or("HEAD");
    if value.len() > GITHUB_REF_MAX_BYTES {
        return Err(format!(
            "GitHub ref is too long (max {GITHUB_REF_MAX_BYTES} bytes)"
        ));
    }
    if value.contains('\\')
        || value
            .chars()
            .any(|character| character.is_control() || character == '\u{7f}')
    {
        return Err("GitHub ref contains unsupported control or path characters".to_string());
    }
    Ok(value.to_string())
}

#[derive(Debug)]
struct PreparedWorkspaceArchive {
    archive: Vec<u8>,
    files: Vec<OriginManifestFileEntry>,
    bytes_written: usize,
}

struct BoundedArchiveCursor {
    inner: Cursor<Vec<u8>>,
    max_len: usize,
}

impl BoundedArchiveCursor {
    fn new(max_len: usize) -> Self {
        Self {
            inner: Cursor::new(Vec::new()),
            max_len,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.inner.into_inner()
    }
}

impl Write for BoundedArchiveCursor {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let position = usize::try_from(self.inner.position())
            .map_err(|_| std::io::Error::other("repacked GitHub archive position is invalid"))?;
        let end = position
            .checked_add(buf.len())
            .ok_or_else(|| std::io::Error::other("repacked GitHub archive size overflowed"))?;
        if end > self.max_len {
            return Err(std::io::Error::other(format!(
                "repacked GitHub archive exceeds the limit of {} bytes",
                self.max_len
            )));
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl Seek for BoundedArchiveCursor {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(position)
    }
}

fn build_origin_manifest(
    project_id: &Uuid,
    lease_id: &Uuid,
    files: &[OriginManifestFileEntry],
    commit_message: Option<String>,
    idempotency_key: Option<&str>,
    request_fingerprint: Option<&str>,
) -> JsonValue {
    json!({
        "projectId": project_id.to_string(),
        "leaseId": lease_id.to_string(),
        "generatedAt": Utc::now().to_rfc3339(),
        "files": files,
        "deletes": [],
        "autoCommitAfterApply": true,
        "commitMessage": commit_message,
        "idempotencyKey": idempotency_key,
        "requestFingerprint": request_fingerprint,
    })
}

#[cfg(test)]
fn repack_github_zip(
    zip_bytes: Vec<u8>,
    target_prefix: Option<String>,
) -> Result<PreparedWorkspaceArchive, String> {
    repack_github_zip_with_limits(zip_bytes, target_prefix, github_import_archive_limits())
}

fn repack_github_zip_with_limits(
    zip_bytes: Vec<u8>,
    target_prefix: Option<String>,
    limits: GithubImportArchiveLimits,
) -> Result<PreparedWorkspaceArchive, String> {
    let cursor = Cursor::new(zip_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|error| format!("invalid zipball: {error}"))?;

    let root_prefix = find_root_prefix(&mut archive)
        .ok_or_else(|| "zipball is missing root folder".to_string())?;

    let out = BoundedArchiveCursor::new(limits.repacked_bytes);
    let mut writer = ZipWriter::new(out);
    let mut manifest_files: Vec<OriginManifestFileEntry> = Vec::new();
    let mut bytes_written: usize = 0;
    let mut total_path_bytes: usize = 0;
    let mut portable_destinations = BTreeMap::<String, String>::new();

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|error| format!("zip entry read failed: {error}"))?;
        if file.is_dir() {
            continue;
        }
        if manifest_files.len() >= limits.file_count {
            return Err(format!(
                "GitHub repository exceeds the file-count limit of {}",
                limits.file_count
            ));
        }
        let name = file.name().to_string();
        let stripped = strip_root_prefix(&root_prefix, &name)
            .ok_or_else(|| format!("zip entry missing expected prefix: {}", name))?;
        let normalized = normalize_relative_path(stripped)
            .ok_or_else(|| format!("zip entry has invalid path: {}", stripped))?;
        if normalized.is_empty() {
            continue;
        }
        let relative_path =
            if let Some(prefix) = target_prefix.as_ref().filter(|value| !value.is_empty()) {
                format!("{prefix}/{normalized}")
            } else {
                normalized
            };
        total_path_bytes = total_path_bytes
            .checked_add(relative_path.len())
            .ok_or_else(|| "GitHub import path bytes overflowed".to_string())?;
        if total_path_bytes > GITHUB_IMPORT_TOTAL_PATH_MAX_BYTES {
            return Err(format!(
                "GitHub repository exceeds the total path-byte limit of {GITHUB_IMPORT_TOTAL_PATH_MAX_BYTES}"
            ));
        }
        insert_portable_import_destination(&mut portable_destinations, &relative_path)?;

        let mut options =
            FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);
        if let Some(mode) = executable_archive_mode(file.unix_mode()) {
            options = options.unix_permissions(mode);
        }

        writer
            .start_file(relative_path.as_str(), options)
            .map_err(|error| format!("zip write failed: {error}"))?;

        let mut file_bytes = 0usize;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("zip entry read failed: {error}"))?;
            if read == 0 {
                break;
            }
            file_bytes = file_bytes
                .checked_add(read)
                .ok_or_else(|| "GitHub archive entry size overflowed".to_string())?;
            let total_bytes = bytes_written
                .checked_add(file_bytes)
                .ok_or_else(|| "GitHub archive uncompressed size overflowed".to_string())?;
            if total_bytes > limits.uncompressed_bytes {
                return Err(format!(
                    "GitHub repository exceeds the uncompressed import limit of {} bytes",
                    limits.uncompressed_bytes
                ));
            }
            writer
                .write_all(&buffer[..read])
                .map_err(|error| format!("zip write failed: {error}"))?;
        }

        bytes_written = bytes_written
            .checked_add(file_bytes)
            .ok_or_else(|| "GitHub archive uncompressed size overflowed".to_string())?;
        manifest_files.push(OriginManifestFileEntry {
            path: relative_path,
            size: Some(file_bytes as u64),
        });
    }

    let out = writer
        .finish()
        .map_err(|error| format!("zip finalize failed: {error}"))?;
    let archive_bytes = out.into_inner();

    Ok(PreparedWorkspaceArchive {
        archive: archive_bytes,
        files: manifest_files,
        bytes_written,
    })
}

fn executable_archive_mode(unix_mode: Option<u32>) -> Option<u32> {
    let mode = unix_mode?;
    if mode & 0o111 == 0 {
        None
    } else {
        Some(0o755)
    }
}

fn find_root_prefix(archive: &mut ZipArchive<Cursor<Vec<u8>>>) -> Option<String> {
    for i in 0..archive.len() {
        let file = archive.by_index(i).ok()?;
        let name = file.name();
        let trimmed = name.trim_start_matches('/');
        let first = trimmed.split('/').next().unwrap_or("").trim();
        if !first.is_empty() {
            return Some(first.to_string());
        }
    }
    None
}

fn strip_root_prefix<'a>(prefix: &str, name: &'a str) -> Option<&'a str> {
    let trimmed = name.trim_start_matches('/');
    let candidate = trimmed.strip_prefix(prefix)?;
    let candidate = candidate.strip_prefix('/')?;
    Some(candidate)
}

fn normalize_relative_path(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.contains('\\') {
        return None;
    }

    let mut buf = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(segment) => buf.push(segment),
            Component::CurDir => continue,
            Component::Prefix(_) | Component::ParentDir | Component::RootDir => return None,
        }
    }

    if buf.as_os_str().is_empty() {
        return None;
    }

    Some(pathbuf_to_string(&buf))
}

fn portable_import_path_key(normalized: &str) -> Result<String, String> {
    if normalized.len() > GITHUB_IMPORT_PATH_MAX_BYTES {
        return Err(format!(
            "import path exceeds {GITHUB_IMPORT_PATH_MAX_BYTES} bytes"
        ));
    }
    for component in normalized.split('/') {
        if component.len() > GITHUB_IMPORT_COMPONENT_MAX_BYTES {
            return Err(format!(
                "import path component exceeds {GITHUB_IMPORT_COMPONENT_MAX_BYTES} bytes"
            ));
        }
        if component.ends_with([' ', '.'])
            || component.contains(':')
            || component.chars().any(|value| value <= '\u{1f}')
        {
            return Err(format!(
                "import path component {component:?} is not portable"
            ));
        }
        let windows_alias = component.trim_end_matches([' ', '.']);
        if windows_alias.eq_ignore_ascii_case(".instafy")
            || windows_alias.eq_ignore_ascii_case(".git")
            || windows_alias
                .get(..".git.instafy-hidden-".len())
                .is_some_and(|value| value.eq_ignore_ascii_case(".git.instafy-hidden-"))
        {
            return Err(format!("import path component {component:?} is reserved"));
        }
        let device_stem = component
            .split('.')
            .next()
            .unwrap_or(component)
            .to_ascii_uppercase();
        let is_dos_device = matches!(device_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || device_stem
                .strip_prefix("COM")
                .or_else(|| device_stem.strip_prefix("LPT"))
                .is_some_and(|number| matches!(number.as_bytes(), [b'1'..=b'9']));
        if is_dos_device {
            return Err(format!(
                "import path component {component:?} is a reserved device name"
            ));
        }
    }
    Ok(normalized
        .nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>())
}

fn insert_portable_import_destination(
    destinations: &mut BTreeMap<String, String>,
    normalized: &str,
) -> Result<(), String> {
    let portable_key = portable_import_path_key(normalized)?;
    if let Some(existing) = destinations.get(&portable_key) {
        return Err(format!(
            "import destinations collide: {existing:?} and {normalized:?}"
        ));
    }
    for (separator_index, _) in portable_key.match_indices('/') {
        if let Some(existing) = destinations.get(&portable_key[..separator_index]) {
            return Err(format!(
                "import destinations overlap: {existing:?} and {normalized:?}"
            ));
        }
    }
    let descendant_prefix = format!("{portable_key}/");
    if let Some((existing_key, existing)) = destinations.range(descendant_prefix.clone()..).next() {
        if existing_key.starts_with(&descendant_prefix) {
            return Err(format!(
                "import destinations overlap: {existing:?} and {normalized:?}"
            ));
        }
    }
    destinations.insert(portable_key, normalized.to_string());
    Ok(())
}

fn parse_import_target_path(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = raw else {
        return Ok(None);
    };
    let trimmed = value.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    let normalized = normalize_relative_path(trimmed)
        .ok_or_else(|| "targetPath must be a safe relative path".to_string())?;
    portable_import_path_key(&normalized)?;
    Ok(Some(normalized))
}

fn pathbuf_to_string(path: &Path) -> String {
    path.iter()
        .map(|component| component.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn controller_import_max_archive_bytes() -> usize {
    std::env::var("CONTROLLER_IMPORT_MAX_ARCHIVE_BYTES")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CONTROLLER_IMPORT_MAX_ARCHIVE_BYTES)
}

fn github_import_limit_from_env(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn github_import_archive_limits() -> GithubImportArchiveLimits {
    GithubImportArchiveLimits {
        download_bytes: github_import_limit_from_env(
            "CONTROLLER_GITHUB_IMPORT_MAX_DOWNLOAD_BYTES",
            DEFAULT_GITHUB_IMPORT_MAX_DOWNLOAD_BYTES,
        ),
        repacked_bytes: github_import_limit_from_env(
            "CONTROLLER_GITHUB_IMPORT_MAX_REPACKED_BYTES",
            controller_import_max_archive_bytes().min(DEFAULT_GITHUB_IMPORT_MAX_REPACKED_BYTES),
        ),
        uncompressed_bytes: github_import_limit_from_env(
            "CONTROLLER_GITHUB_IMPORT_MAX_UNCOMPRESSED_BYTES",
            DEFAULT_GITHUB_IMPORT_MAX_UNCOMPRESSED_BYTES,
        ),
        file_count: github_import_limit_from_env(
            "CONTROLLER_GITHUB_IMPORT_MAX_FILE_COUNT",
            DEFAULT_GITHUB_IMPORT_MAX_FILE_COUNT,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        execute_bounded_mutating_origin_request,
        github_import_operation_can_retry_without_admission, github_import_request_fingerprint,
        github_import_role_can_write, normalize_github_import_idempotency_key, parse_github_ref,
        parse_github_repo, parse_import_target_path, parse_origin_apply_status_response,
        read_github_zipball_body, repack_github_zip, repack_github_zip_with_limits,
        resolve_github_import_auth, resolve_project_github_auth_policy,
        sync_origin_git_after_apply, GithubImportArchiveLimits, GithubImportAuthSource,
        OriginApplyStatus, ProjectGithubAuthPolicy, GITHUB_IMPORT_RATE_WINDOW_SECONDS,
        GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE, ORIGIN_GIT_REMOTE_NOT_CONFIGURED,
        ORIGIN_RESPONSE_MAX_BYTES,
    };
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use chrono::{Duration as ChronoDuration, Utc};
    use httpmock::Method::{GET, POST};
    use httpmock::MockServer;
    use serde_json::json;
    use std::io::{Cursor, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio_postgres::types::Json as PgJson;
    use tower::ServiceExt;
    use uuid::Uuid;
    use zip::write::{FileOptions, ZipWriter};
    use zip::ZipArchive;

    #[test]
    fn parse_import_target_path_defaults_to_root_when_empty() {
        assert_eq!(parse_import_target_path(None).unwrap(), None);
        assert_eq!(parse_import_target_path(Some("")).unwrap(), None);
        assert_eq!(parse_import_target_path(Some("/")).unwrap(), None);
    }

    #[test]
    fn parse_import_target_path_accepts_safe_relative_path() {
        assert_eq!(
            parse_import_target_path(Some("repos/rust-lang-rust")).unwrap(),
            Some("repos/rust-lang-rust".to_string())
        );
        assert_eq!(
            parse_import_target_path(Some("/repos/rust-lang-rust/")).unwrap(),
            Some("repos/rust-lang-rust".to_string())
        );
    }

    #[test]
    fn parse_import_target_path_rejects_traversal() {
        let error = parse_import_target_path(Some("../escape")).unwrap_err();
        assert!(error.contains("targetPath"));
        let reserved = parse_import_target_path(Some(".instafy/imported")).unwrap_err();
        assert!(reserved.contains("reserved"));
        for unsafe_path in [
            ".INSTAFY/imported",
            "repos/.git./config",
            "repos/CON/readme",
            "repos/name:stream",
            "repos\\escape",
        ] {
            assert!(
                parse_import_target_path(Some(unsafe_path)).is_err(),
                "{unsafe_path} should be rejected"
            );
        }
        let long_component = format!("repos/{}", "x".repeat(256));
        assert!(parse_import_target_path(Some(&long_component)).is_err());
    }

    #[test]
    fn github_import_idempotency_key_is_bounded_and_transport_safe() {
        assert_eq!(
            normalize_github_import_idempotency_key(Some(
                " github-import-v1:abc_123.def-456 ".to_string()
            ))
            .unwrap()
            .as_deref(),
            Some("github-import-v1:abc_123.def-456")
        );
        assert!(normalize_github_import_idempotency_key(Some("unsafe/key".to_string())).is_err());
        assert!(normalize_github_import_idempotency_key(Some("x".repeat(257))).is_err());
    }

    #[test]
    fn only_recent_prepared_failed_workspace_busy_receipts_skip_import_admission() {
        let now = Utc::now();
        let recent = now - ChronoDuration::seconds(GITHUB_IMPORT_RATE_WINDOW_SECONDS as i64 - 1);
        let expired = now - ChronoDuration::seconds(GITHUB_IMPORT_RATE_WINDOW_SECONDS as i64);
        assert!(github_import_operation_can_retry_without_admission(
            "failed",
            Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE),
            true,
            recent,
            now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "failed",
            Some("workspace busy"),
            true,
            recent,
            now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "pending",
            Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE),
            true,
            recent,
            now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "applied",
            Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE),
            true,
            recent,
            now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "failed", None, true, recent, now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "failed",
            Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE),
            false,
            recent,
            now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "failed",
            Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE),
            true,
            expired,
            now,
        ));
        assert!(!github_import_operation_can_retry_without_admission(
            "failed",
            Some(GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE),
            true,
            now + ChronoDuration::seconds(1),
            now,
        ));
    }

    #[tokio::test]
    async fn only_cached_and_workspace_busy_retries_bypass_exhausted_import_rate_limit(
    ) -> anyhow::Result<()> {
        let Some(pool) = crate::tests::setup_origin_test_pool().await? else {
            eprintln!("skipping existing GitHub import rate-limit test: TEST_DATABASE_URL not set");
            return Ok(());
        };

        let user_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let cached_key = format!("github-import-v1:cached-{project_id}");
        let retry_key = format!("github-import-v1:retry-{project_id}");
        let failed_key = format!("github-import-v1:failed-{project_id}");
        let stale_key = format!("github-import-v1:stale-{project_id}");
        let unprepared_busy_key = format!("github-import-v1:unprepared-busy-{project_id}");
        let expired_busy_key = format!("github-import-v1:expired-busy-{project_id}");
        let new_key = format!("github-import-v1:new-{project_id}");
        let failed_claim_id = Uuid::new_v4();
        let stale_claim_id = Uuid::new_v4();
        let unprepared_busy_claim_id = Uuid::new_v4();
        let expired_busy_claim_id = Uuid::new_v4();
        let repo = "octocat/Hello-World";
        let git_ref = "HEAD";
        let target_path = "repos/octocat-hello-world";
        let source_revision = "0123456789012345678901234567890123456789";
        let cached_response = json!({
            "ok": true,
            "projectId": project_id.to_string(),
            "repo": repo,
            "ref": git_ref,
            "targetPath": target_path,
            "fileCount": 16,
            "bytesWritten": 4096,
            "rev": "cached-origin-rev",
            "deduplicated": false,
        });
        let prepared_retry = json!({
            "originId": Uuid::new_v4().to_string(),
            "sourceRevision": source_revision,
            "authMode": "public",
            "persistentConnection": false,
            "userOauthFallbackEnabled": false,
        });

        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into auth.users (
                        instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, last_sign_in_at, confirmation_token,
                        recovery_token, email_change_token_new, email_change,
                        raw_app_meta_data, raw_user_meta_data, is_super_admin,
                        created_at, updated_at
                     ) values (
                        $1, $2, 'authenticated', 'authenticated', $3, 'test-secret',
                        now(), now(), '', '', '', '', '{}'::jsonb, '{}'::jsonb,
                        false, now(), now()
                     )",
                    &[
                        &Uuid::nil(),
                        &user_id,
                        &format!("github-import-rate+{user_id}@example.com"),
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into projects (
                        id, owner_user_id, project_type, status
                     ) values ($1, $2, 'customer', 'active')",
                    &[&project_id, &user_id],
                )
                .await?;
            connection
                .execute(
                    "insert into github_import_operations (
                        id, project_id, idempotency_key, repo, git_ref,
                        target_path, status, claim_id, created_by,
                        claim_expires_at, response_json, completed_at
                     ) values (
                        $1, $2, $3, $4, $5, $6, 'succeeded', $7, $8,
                        now() + interval '5 minutes', $9, now()
                     )",
                    &[
                        &Uuid::new_v4(),
                        &project_id,
                        &cached_key,
                        &repo,
                        &git_ref,
                        &target_path,
                        &Uuid::new_v4(),
                        &user_id,
                        &PgJson(cached_response),
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into github_import_operations (
                        id, project_id, idempotency_key, repo, git_ref,
                        target_path, status, claim_id, created_by,
                        claim_expires_at, source_revision, prepared_json,
                        error_message, completed_at
                     ) values (
                        $1, $2, $3, $4, $5, $6, 'failed', $7, $8,
                        now(), $9, $10, $11, now()
                     )",
                    &[
                        &Uuid::new_v4(),
                        &project_id,
                        &retry_key,
                        &repo,
                        &git_ref,
                        &target_path,
                        &Uuid::new_v4(),
                        &user_id,
                        &source_revision,
                        &PgJson(prepared_retry.clone()),
                        &GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE,
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into github_import_operations (
                        id, project_id, idempotency_key, repo, git_ref,
                        target_path, status, claim_id, created_by,
                        claim_expires_at, error_message, completed_at
                     ) values (
                        $1, $2, $3, $4, $5, $6, 'failed', $7, $8,
                        now(), 'origin apply failed', now()
                     )",
                    &[
                        &Uuid::new_v4(),
                        &project_id,
                        &failed_key,
                        &repo,
                        &git_ref,
                        &target_path,
                        &failed_claim_id,
                        &user_id,
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into github_import_operations (
                        id, project_id, idempotency_key, repo, git_ref,
                        target_path, status, claim_id, created_by,
                        claim_expires_at, error_message, completed_at
                     ) values (
                        $1, $2, $3, $4, $5, $6, 'failed', $7, $8,
                        now(), $9, now()
                     )",
                    &[
                        &Uuid::new_v4(),
                        &project_id,
                        &unprepared_busy_key,
                        &repo,
                        &git_ref,
                        &target_path,
                        &unprepared_busy_claim_id,
                        &user_id,
                        &GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE,
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into github_import_operations (
                        id, project_id, idempotency_key, repo, git_ref,
                        target_path, status, claim_id, created_by,
                        claim_expires_at, source_revision, prepared_json,
                        error_message, created_at, updated_at, completed_at
                     ) values (
                        $1, $2, $3, $4, $5, $6, 'failed', $7, $8,
                        now(), $9, $10, $11,
                        now() - interval '2 minutes',
                        now() - interval '2 minutes', now()
                     )",
                    &[
                        &Uuid::new_v4(),
                        &project_id,
                        &expired_busy_key,
                        &repo,
                        &git_ref,
                        &target_path,
                        &expired_busy_claim_id,
                        &user_id,
                        &source_revision,
                        &PgJson(prepared_retry),
                        &GITHUB_IMPORT_WORKSPACE_BUSY_MESSAGE,
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into github_import_operations (
                        id, project_id, idempotency_key, repo, git_ref,
                        target_path, status, claim_id, created_by,
                        claim_expires_at
                     ) values (
                        $1, $2, $3, $4, $5, $6, 'pending', $7, $8,
                        now() - interval '1 minute'
                     )",
                    &[
                        &Uuid::new_v4(),
                        &project_id,
                        &stale_key,
                        &repo,
                        &git_ref,
                        &target_path,
                        &stale_claim_id,
                        &user_id,
                    ],
                )
                .await?;
            connection
                .execute(
                    "insert into workspace_leases (
                        project_id, user_id, status, acquired_at, expires_at, metadata
                     ) values ($1, $2, 'active', now(), now() + interval '5 minutes', $3)",
                    &[
                        &project_id,
                        &user_id,
                        &PgJson(json!({ "source": "github_import_rate_limit_test" })),
                    ],
                )
                .await?;
        }

        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "github-import-replay-rate-limit",
        );
        assert!(!config.dev_mode, "regression must exercise production mode");
        let state = crate::tests::build_test_state(pool.clone(), config.clone());
        let rate_key = format!("import:github:user:{user_id}");
        for _ in 0..3 {
            state
                .rate_limiter
                .enforce(
                    rate_key.clone(),
                    3,
                    Duration::from_secs(GITHUB_IMPORT_RATE_WINDOW_SECONDS),
                )
                .await
                .expect("seed exhausted import rate budget");
        }
        assert!(
            state
                .rate_limiter
                .enforce(
                    rate_key,
                    3,
                    Duration::from_secs(GITHUB_IMPORT_RATE_WINDOW_SECONDS),
                )
                .await
                .is_err(),
            "import budget should be exhausted before either route request"
        );

        let user_token = crate::auth::issue_controller_token(&config, &user_id)
            .expect("issue controller user token")
            .token;
        let authorization = format!("Bearer {user_token}");
        let app = super::router().with_state(state);
        let cached = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/projects/{project_id}/import/github"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(axum::http::header::AUTHORIZATION, &authorization)
                    .body(Body::from(
                        json!({
                            "repo": "https://github.com/octocat/Hello-World",
                            "ref": git_ref,
                            "targetPath": target_path,
                            "idempotencyKey": cached_key,
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(cached.status(), StatusCode::OK);
        let cached_body = to_bytes(cached.into_body(), usize::MAX).await?;
        let cached_body: serde_json::Value = serde_json::from_slice(&cached_body)?;
        assert_eq!(cached_body["rev"], "cached-origin-rev");
        assert_eq!(cached_body["deduplicated"], true);

        for attempt in 0..5 {
            let retry = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/projects/{project_id}/import/github"))
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .header(axum::http::header::AUTHORIZATION, &authorization)
                        .body(Body::from(
                            json!({
                                "repo": repo,
                                "ref": git_ref,
                                "targetPath": target_path,
                                "idempotencyKey": retry_key,
                            })
                            .to_string(),
                        ))?,
                )
                .await?;
            assert_eq!(
                retry.status(),
                StatusCode::CONFLICT,
                "same-key retry {attempt} must bypass exhausted new-import admission",
            );
            let retry_body = to_bytes(retry.into_body(), usize::MAX).await?;
            let retry_body: serde_json::Value = serde_json::from_slice(&retry_body)?;
            assert_eq!(retry_body["code"], "workspace_busy");
            assert_eq!(retry_body["details"]["retryable"], true);
        }

        let conflict = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/projects/{project_id}/import/github"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(axum::http::header::AUTHORIZATION, &authorization)
                    .body(Body::from(
                        json!({
                            "repo": repo,
                            "ref": git_ref,
                            "targetPath": "repos/different-target",
                            "idempotencyKey": retry_key,
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let conflict_body = to_bytes(conflict.into_body(), usize::MAX).await?;
        let conflict_body: serde_json::Value = serde_json::from_slice(&conflict_body)?;
        assert_eq!(conflict_body["code"], "github_import_idempotency_conflict");

        for (key, description) in [
            (&failed_key, "non-retryable failed receipt"),
            (&stale_key, "stale pending receipt"),
            (
                &unprepared_busy_key,
                "workspace-busy receipt without preparation",
            ),
            (&expired_busy_key, "expired workspace-busy receipt"),
        ] {
            let rejected_existing = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/projects/{project_id}/import/github"))
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .header(axum::http::header::AUTHORIZATION, &authorization)
                        .body(Body::from(
                            json!({
                                "repo": repo,
                                "ref": git_ref,
                                "targetPath": target_path,
                                "idempotencyKey": key,
                            })
                            .to_string(),
                        ))?,
                )
                .await?;
            assert_eq!(
                rejected_existing.status(),
                StatusCode::TOO_MANY_REQUESTS,
                "{description} must not bypass exhausted new-import admission",
            );
        }

        let rejected = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/projects/{project_id}/import/github"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .header(axum::http::header::AUTHORIZATION, authorization)
                    .body(Body::from(
                        json!({
                            "repo": repo,
                            "ref": git_ref,
                            "targetPath": target_path,
                            "idempotencyKey": new_key,
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);

        {
            let connection = pool.get().await?;
            let new_rows: i64 = connection
                .query_one(
                    "select count(*) from github_import_operations
                     where project_id = $1 and idempotency_key = $2",
                    &[&project_id, &new_key],
                )
                .await?
                .get(0);
            assert_eq!(new_rows, 0, "rate-limited key must not create a row");
            for (key, expected_status, expected_claim_id) in [
                (&failed_key, "failed", failed_claim_id),
                (&stale_key, "pending", stale_claim_id),
                (&unprepared_busy_key, "failed", unprepared_busy_claim_id),
                (&expired_busy_key, "failed", expired_busy_claim_id),
            ] {
                let receipt = connection
                    .query_one(
                        "select status, claim_id from github_import_operations
                         where project_id = $1 and idempotency_key = $2",
                        &[&project_id, key],
                    )
                    .await?;
                assert_eq!(receipt.get::<_, String>("status"), expected_status);
                assert_eq!(receipt.get::<_, Uuid>("claim_id"), expected_claim_id);
            }
            connection
                .execute("delete from projects where id = $1", &[&project_id])
                .await?;
            connection
                .execute("delete from auth.users where id = $1", &[&user_id])
                .await?;
        }

        Ok(())
    }

    #[test]
    fn github_import_fingerprint_pins_source_and_target() {
        let first = github_import_request_fingerprint(
            "octocat/Hello-World",
            "0123456789012345678901234567890123456789",
            Some("repos/octocat-hello-world"),
        );
        assert_eq!(first.len(), "sha256:".len() + 64);
        assert_eq!(
            first,
            github_import_request_fingerprint(
                "OCTOCAT/hello-world",
                "0123456789012345678901234567890123456789",
                Some("repos/octocat-hello-world"),
            )
        );
        assert_ne!(
            first,
            github_import_request_fingerprint(
                "octocat/Hello-World",
                "1123456789012345678901234567890123456789",
                Some("repos/octocat-hello-world"),
            )
        );
    }

    #[test]
    fn origin_apply_status_decodes_durable_receipts() {
        assert_eq!(
            parse_origin_apply_status_response(reqwest::StatusCode::NOT_FOUND, b"").unwrap(),
            OriginApplyStatus::Missing
        );
        assert_eq!(
            parse_origin_apply_status_response(
                reqwest::StatusCode::OK,
                br#"{"status":"pending"}"#,
            )
            .unwrap(),
            OriginApplyStatus::Pending
        );
        assert_eq!(
            parse_origin_apply_status_response(
                reqwest::StatusCode::OK,
                br#"{"status":"succeeded","rev":"abc123","fileCount":4,"bytesWritten":99}"#,
            )
            .unwrap(),
            OriginApplyStatus::Succeeded {
                rev: "abc123".to_string(),
                file_count: 4,
                bytes_written: 99,
            }
        );
        let conflict = parse_origin_apply_status_response(
            reqwest::StatusCode::CONFLICT,
            br#"{"message":"mismatch"}"#,
        )
        .unwrap_err();
        assert_eq!(
            conflict.1 .0.code.as_deref(),
            Some("github_import_origin_receipt_conflict")
        );
    }

    #[test]
    fn github_repo_parser_rejects_lookalikes_and_non_root_urls() {
        assert_eq!(
            parse_github_repo("https://github.com/octocat/Hello-World").unwrap(),
            ("octocat".to_string(), "Hello-World".to_string())
        );
        assert!(parse_github_repo("https://notgithub.com/octocat/Hello-World").is_err());
        assert!(parse_github_repo("https://github.com/octocat/Hello-World/issues/1").is_err());
        assert!(parse_github_repo("https://github.com/octocat/Hello-World/blob/main/a").is_err());
        assert!(parse_github_repo(&format!("{}/repo", "o".repeat(40))).is_err());
        assert!(parse_github_repo(&format!("owner/{}", "r".repeat(101))).is_err());
    }

    #[test]
    fn github_ref_is_bounded_and_rejects_control_paths() {
        assert_eq!(parse_github_ref(None).unwrap(), "HEAD");
        assert_eq!(parse_github_ref(Some(" main ")).unwrap(), "main");
        assert!(parse_github_ref(Some(&"r".repeat(1025))).is_err());
        assert!(parse_github_ref(Some("refs\\heads\\main")).is_err());
        assert!(parse_github_ref(Some("main\nother")).is_err());
    }

    #[test]
    fn github_import_write_roles_exclude_viewers() {
        assert!(github_import_role_can_write("owner"));
        assert!(github_import_role_can_write("admin"));
        assert!(github_import_role_can_write("builder"));
        assert!(!github_import_role_can_write("viewer"));
        assert!(!github_import_role_can_write("unknown"));
    }

    #[test]
    fn github_auth_automatically_reuses_user_oauth_without_project_opt_out() {
        assert_eq!(
            resolve_project_github_auth_policy(None, None, None),
            ProjectGithubAuthPolicy::Automatic
        );

        let public_import_metadata = json!({ "authMode": "public" });
        let policy = resolve_project_github_auth_policy(
            Some("imported"),
            Some("public"),
            Some(&public_import_metadata),
        );
        assert_eq!(policy, ProjectGithubAuthPolicy::Automatic);

        let auth = resolve_github_import_auth(
            policy,
            None,
            None,
            Some("user-oauth".to_string()),
            Some("project-token".to_string()),
        );
        assert_eq!(auth.token.as_deref(), Some("user-oauth"));
        assert_eq!(auth.mode, "oauth");
        assert_eq!(auth.source, GithubImportAuthSource::UserOauth);
    }

    #[test]
    fn github_auth_disconnect_and_disabled_metadata_exclude_user_oauth() {
        let disconnected_policy = resolve_project_github_auth_policy(
            Some("disconnected"),
            Some("oauth"),
            Some(&json!({})),
        );
        assert_eq!(
            disconnected_policy,
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );

        let disabled_metadata = json!({ "enabled": false });
        assert_eq!(
            resolve_project_github_auth_policy(
                Some("connected"),
                Some("oauth"),
                Some(&disabled_metadata),
            ),
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );

        let auth = resolve_github_import_auth(
            disconnected_policy,
            None,
            None,
            Some("old-user-oauth".to_string()),
            Some("one-repo-token".to_string()),
        );
        assert_eq!(auth.token.as_deref(), Some("one-repo-token"));
        assert_eq!(auth.mode, "token");
        assert_eq!(auth.source, GithubImportAuthSource::ProjectToken);
    }

    #[test]
    fn github_auth_token_policy_is_sticky_and_never_widens_to_user_oauth() {
        let connection_type_policy =
            resolve_project_github_auth_policy(Some("connected"), Some("token"), Some(&json!({})));
        assert_eq!(
            connection_type_policy,
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );

        let token_metadata = json!({ "authMode": "token" });
        assert_eq!(
            resolve_project_github_auth_policy(
                Some("connected"),
                Some("oauth"),
                Some(&token_metadata),
            ),
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );

        let auth = resolve_github_import_auth(
            connection_type_policy,
            None,
            None,
            Some("old-user-oauth".to_string()),
            None,
        );
        assert_eq!(auth.token, None);
        assert_eq!(auth.mode, "public");
        assert_eq!(
            auth.fallback_policy_after_import,
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );

        // A public repo can still import anonymously, but persisting that
        // success must retain the earlier disconnect/token-only boundary.
        let post_import_metadata = json!({
            "authMode": auth.mode,
            "userOauthFallbackEnabled": auth.fallback_policy_after_import
                == ProjectGithubAuthPolicy::Automatic,
        });
        assert_eq!(
            resolve_project_github_auth_policy(
                Some("imported"),
                Some("public"),
                Some(&post_import_metadata),
            ),
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );
    }

    #[test]
    fn github_auth_explicit_session_and_body_tokens_override_project_policy() {
        let session_auth = resolve_github_import_auth(
            ProjectGithubAuthPolicy::ExcludeUserOauth,
            Some("new-account-oauth".to_string()),
            Some("explicit-token".to_string()),
            Some("old-user-oauth".to_string()),
            Some("project-token".to_string()),
        );
        assert_eq!(session_auth.token.as_deref(), Some("new-account-oauth"));
        assert_eq!(session_auth.mode, "oauth");
        assert_eq!(session_auth.source, GithubImportAuthSource::DeviceSession);
        assert_eq!(
            session_auth.fallback_policy_after_import,
            ProjectGithubAuthPolicy::Automatic
        );

        let explicit_auth = resolve_github_import_auth(
            ProjectGithubAuthPolicy::ExcludeUserOauth,
            None,
            Some("explicit-token".to_string()),
            Some("old-user-oauth".to_string()),
            Some("project-token".to_string()),
        );
        assert_eq!(explicit_auth.token.as_deref(), Some("explicit-token"));
        assert_eq!(explicit_auth.mode, "ephemeral_token");
        assert_eq!(explicit_auth.source, GithubImportAuthSource::ExplicitToken);
        assert_eq!(
            explicit_auth.fallback_policy_after_import,
            ProjectGithubAuthPolicy::ExcludeUserOauth
        );
    }

    #[test]
    fn repack_github_zip_preserves_executable_scripts() {
        let mut source = ZipWriter::new(Cursor::new(Vec::new()));
        source
            .start_file(
                "owner-repo-sha/tools/run",
                FileOptions::<()>::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .unix_permissions(0o100755),
            )
            .unwrap();
        source.write_all(b"#!/usr/bin/env bash\ntrue\n").unwrap();
        source
            .start_file(
                "owner-repo-sha/README.md",
                FileOptions::<()>::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .unix_permissions(0o100644),
            )
            .unwrap();
        source.write_all(b"# readme\n").unwrap();
        let source = source.finish().unwrap().into_inner();

        let prepared = repack_github_zip(source, Some("repos/example".to_string())).unwrap();
        let mut archive = ZipArchive::new(Cursor::new(prepared.archive)).unwrap();
        let executable = archive.by_name("repos/example/tools/run").unwrap();
        assert_eq!(executable.unix_mode().map(|mode| mode & 0o777), Some(0o755));
        drop(executable);

        let readme = archive.by_name("repos/example/README.md").unwrap();
        assert_eq!(readme.unix_mode().map(|mode| mode & 0o111).unwrap_or(0), 0);
    }

    #[test]
    fn repack_github_zip_bounds_uncompressed_bytes() {
        let mut source = ZipWriter::new(Cursor::new(Vec::new()));
        source
            .start_file(
                "owner-repo-sha/large.txt",
                FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        source.write_all(&vec![b'a'; 4_096]).unwrap();
        let source = source.finish().unwrap().into_inner();

        let error = repack_github_zip_with_limits(
            source,
            None,
            GithubImportArchiveLimits {
                download_bytes: usize::MAX,
                repacked_bytes: usize::MAX,
                uncompressed_bytes: 1_024,
                file_count: 10,
            },
        )
        .unwrap_err();
        assert!(error.contains("uncompressed import limit"));
    }

    #[test]
    fn repack_github_zip_rejects_portable_collisions_and_reserved_paths() {
        let mut source = ZipWriter::new(Cursor::new(Vec::new()));
        for path in ["owner-repo-sha/Readme.md", "owner-repo-sha/README.md"] {
            source
                .start_file(
                    path,
                    FileOptions::<()>::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            source.write_all(b"content").unwrap();
        }
        let source = source.finish().unwrap().into_inner();
        let collision = repack_github_zip(source, Some("repos/example".to_string())).unwrap_err();
        assert!(collision.contains("collide"));

        let mut source = ZipWriter::new(Cursor::new(Vec::new()));
        source
            .start_file(
                "owner-repo-sha/.GIT/config",
                FileOptions::<()>::default().compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        source.write_all(b"unsafe").unwrap();
        let source = source.finish().unwrap().into_inner();
        let reserved = repack_github_zip(source, Some("repos/example".to_string())).unwrap_err();
        assert!(reserved.contains("reserved"));
    }

    #[test]
    fn repack_github_zip_bounds_file_count_and_output_bytes() {
        let mut source = ZipWriter::new(Cursor::new(Vec::new()));
        for index in 0..3 {
            source
                .start_file(
                    format!("owner-repo-sha/file-{index}.txt"),
                    FileOptions::<()>::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            source.write_all(b"content").unwrap();
        }
        let source = source.finish().unwrap().into_inner();

        let file_error = repack_github_zip_with_limits(
            source.clone(),
            None,
            GithubImportArchiveLimits {
                download_bytes: usize::MAX,
                repacked_bytes: usize::MAX,
                uncompressed_bytes: usize::MAX,
                file_count: 2,
            },
        )
        .unwrap_err();
        assert!(file_error.contains("file-count limit"));

        let output_error = repack_github_zip_with_limits(
            source,
            None,
            GithubImportArchiveLimits {
                download_bytes: usize::MAX,
                repacked_bytes: 64,
                uncompressed_bytes: usize::MAX,
                file_count: 10,
            },
        )
        .unwrap_err();
        assert!(output_error.contains("repacked GitHub archive exceeds"));
    }

    #[tokio::test]
    async fn github_zipball_download_is_bounded_while_streaming() {
        let server = MockServer::start_async().await;
        let archive = vec![b'x'; 4_096];
        let mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.zip");
                then.status(200).body(archive);
            })
            .await;
        let response = reqwest::Client::new()
            .get(format!("{}/archive.zip", server.base_url()))
            .send()
            .await
            .unwrap();

        let error = read_github_zipball_body(response, 1_024).await.unwrap_err();
        mock.assert_async().await;
        assert_eq!(error.0, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error.1 .0.code.as_deref(), Some("github_import_too_large"));
    }

    #[tokio::test]
    async fn origin_response_body_is_bounded_while_streaming() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/apply");
                then.status(200)
                    .body(vec![b'x'; ORIGIN_RESPONSE_MAX_BYTES + 1]);
            })
            .await;

        let mutation_may_be_in_flight = AtomicBool::new(false);
        let error = execute_bounded_mutating_origin_request(
            reqwest::Client::new().post(format!("{}/apply", server.base_url())),
            "apply",
            Duration::from_secs(5),
            Some(&mutation_may_be_in_flight),
        )
        .await
        .unwrap_err();

        mock.assert_async().await;
        assert!(error.message.contains("response exceeds"));
        assert!(!error.ambiguous);
        assert!(!mutation_may_be_in_flight.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn origin_connect_failure_is_known_not_to_be_in_flight() {
        let mutation_may_be_in_flight = AtomicBool::new(false);
        let error = execute_bounded_mutating_origin_request(
            reqwest::Client::new().post("http://127.0.0.1:1/apply"),
            "apply",
            Duration::from_secs(2),
            Some(&mutation_may_be_in_flight),
        )
        .await
        .unwrap_err();

        assert!(!error.ambiguous);
        assert!(!mutation_may_be_in_flight.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn origin_timeout_before_headers_remains_ambiguously_in_flight() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path("/apply");
                then.status(200)
                    .delay(Duration::from_millis(250))
                    .json_body(json!({ "rev": "late" }));
            })
            .await;
        let mutation_may_be_in_flight = AtomicBool::new(false);
        let error = execute_bounded_mutating_origin_request(
            reqwest::Client::new().post(format!("{}/apply", server.base_url())),
            "apply",
            Duration::from_millis(25),
            Some(&mutation_may_be_in_flight),
        )
        .await
        .unwrap_err();

        mock.assert_async().await;
        assert!(error.ambiguous);
        assert!(mutation_may_be_in_flight.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn sync_origin_git_after_apply_returns_synced_rev() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/git/sync")
                    .header("authorization", "Bearer test-token")
                    .json_body(json!({
                        "message": "instafy: import octocat/hello-world@HEAD",
                        "expectedRev": "applied-rev",
                    }));
                then.status(200).json_body(json!({ "rev": "synced-rev" }));
            })
            .await;

        let client = reqwest::Client::new();
        let result = sync_origin_git_after_apply(
            &client,
            &server.base_url(),
            None,
            "test-token",
            "instafy: import octocat/hello-world@HEAD",
            "applied-rev",
            None,
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result, Some("synced-rev".to_string()));
    }

    #[tokio::test]
    async fn sync_origin_git_after_apply_skips_when_remote_is_not_configured() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/git/sync")
                    .header("authorization", "Bearer test-token")
                    .json_body(json!({
                        "message": "instafy: import octocat/hello-world@HEAD",
                        "expectedRev": "applied-rev",
                    }));
                then.status(400)
                    .json_body(json!({ "message": ORIGIN_GIT_REMOTE_NOT_CONFIGURED }));
            })
            .await;

        let client = reqwest::Client::new();
        let result = sync_origin_git_after_apply(
            &client,
            &server.base_url(),
            None,
            "test-token",
            "instafy: import octocat/hello-world@HEAD",
            "applied-rev",
            None,
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(result, None);
    }
}
