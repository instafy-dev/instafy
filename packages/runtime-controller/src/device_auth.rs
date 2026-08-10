use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode as HttpStatusCode};
use axum::response::Html;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio::sync::RwLock;
use tokio::time::timeout;
use tokio_postgres::{error::SqlState, GenericClient, Row};
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::config::{CredentialEncryptionKey, PgPool};
use crate::credentials;
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

const DEFAULT_CODEX_ISSUER: &str = "https://auth.openai.com";
const DEFAULT_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GOOGLE_OAUTH_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_CODE_ASSIST_API_BASE: &str = "https://cloudcode-pa.googleapis.com";
const GEMINI_CODE_ASSIST_FREE_TIER_ID: &str = "free-tier";
const GEMINI_CODE_ASSIST_LEGACY_TIER_ID: &str = "legacy-tier";
const DEFAULT_GEMINI_OAUTH_MODE: &str = "code_assist";
const GEMINI_OAUTH_MODE_API: &str = "api";
const GEMINI_OAUTH_MODE_CODE_ASSIST: &str = "code_assist";
const GEMINI_OAUTH_MODE_CODE_ASSIST_CLI: &str = "code_assist_cli";
const REQUIRED_GEMINI_CODE_ASSIST_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_GEMINI_OAUTH_SCOPE: &str =
    "https://www.googleapis.com/auth/generative-language.retriever";
const DEFAULT_GEMINI_CODE_ASSIST_OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const DEFAULT_GEMINI_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const DEFAULT_GEMINI_MODEL: &str = "gemini-2.5-pro";
const USER_OAUTH_TOKEN_PROVIDER_GITHUB: &str = "github";
const USER_OAUTH_TOKEN_PROVIDER_GEMINI: &str = "gemini";
const OPENAI_API_KEY_CREDENTIAL_KIND: &str = "openai_api_key";
const CODEX_DEVICE_AUTH_FORBIDDEN_MESSAGE: &str = "ChatGPT device-code login is not enabled. Enable it in ChatGPT Settings → Security, or ask your workspace admin to allow it in workspace permissions, then generate a new code.";
const GITHUB_DEVICE_AUTH_ASSERTION_TTL_MINUTES: i64 = 30;
const GITHUB_DEVICE_AUTH_TERMINAL_RETENTION_MINUTES: i64 = 30;
const GITHUB_DEVICE_AUTH_STORAGE_UNAVAILABLE_MESSAGE: &str =
    "GitHub connection storage is not configured.";
const GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE: &str = "GitHub device login timed out.";
const GITHUB_DEVICE_AUTH_INTERRUPTED_MESSAGE: &str =
    "GitHub device login was interrupted. Start again.";
const GITHUB_DEVICE_AUTH_RESPONSE_MAX_BYTES: usize = 64 * 1024;
const GITHUB_DEVICE_AUTH_START_RATE_LIMIT: i64 = 5;
const GITHUB_DEVICE_AUTH_START_RATE_WINDOW_SECONDS: i64 = 60;
const GITHUB_DEVICE_AUTH_PENDING_PER_USER_LIMIT: i64 = 2;
const GITHUB_DEVICE_AUTH_PENDING_GLOBAL_LIMIT: i64 = 256;
const GITHUB_DEVICE_AUTH_START_RESERVATION_SECONDS: i64 = 30;
const GITHUB_DEVICE_AUTH_START_ATTEMPT_RETENTION_MINUTES: i64 = 30;
const GITHUB_DEVICE_AUTH_POLL_LEASE_SECONDS: i64 = 90;
const GITHUB_DEVICE_AUTH_POLL_SHUTDOWN_GRACE_SECONDS: i64 = 60;
const GITHUB_DEVICE_AUTH_DEFAULT_LIFETIME_SECONDS: u64 = 15 * 60;
const GITHUB_DEVICE_AUTH_MAX_LIFETIME_SECONDS: u64 = 15 * 60;
const GITHUB_DEVICE_AUTH_DEFAULT_POLL_INTERVAL_SECONDS: u64 = 5;
const GITHUB_DEVICE_AUTH_MAX_POLL_INTERVAL_SECONDS: u64 = 30;

fn github_device_auth_service_unavailable(
    message: impl Into<String>,
) -> (HttpStatusCode, Json<ApiError>) {
    (
        HttpStatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::new(message)),
    )
}

fn oauth_token_storage_unavailable() -> (HttpStatusCode, Json<ApiError>) {
    (
        HttpStatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::with_details(
            "OAuth connection storage is not ready. Please try again shortly.",
            "oauth_token_storage_unavailable",
            json!({ "retryable": true }),
        )),
    )
}

#[derive(Clone)]
pub(crate) struct DeviceAuthRegistry {
    inner: Arc<RwLock<HashMap<Uuid, DeviceAuthSession>>>,
}

impl DeviceAuthRegistry {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn insert(&self, session: DeviceAuthSession) {
        let mut guard = self.inner.write().await;
        guard.insert(session.session_id, session);
        prune_sessions(&mut guard);
    }

    pub(crate) async fn get(&self, session_id: &Uuid) -> Option<DeviceAuthSession> {
        let mut guard = self.inner.write().await;
        prune_sessions(&mut guard);
        guard.get(session_id).cloned()
    }

    pub(crate) async fn update_status(
        &self,
        session_id: &Uuid,
        status: DeviceAuthStatus,
    ) -> Option<DeviceAuthSession> {
        let mut guard = self.inner.write().await;
        prune_sessions(&mut guard);
        let session = guard.get_mut(session_id)?;
        session.status = status;
        session.completed_at = match &session.status {
            DeviceAuthStatus::Pending => None,
            _ => Some(Utc::now()),
        };
        Some(session.clone())
    }

    pub(crate) async fn cancel(&self, session_id: &Uuid, user_id: &Uuid) -> bool {
        let mut guard = self.inner.write().await;
        prune_sessions(&mut guard);
        let Some(session) = guard.get_mut(session_id) else {
            return false;
        };
        if &session.user_id != user_id {
            return false;
        }
        if matches!(session.status, DeviceAuthStatus::Pending) {
            session.status = DeviceAuthStatus::Cancelled;
            session.completed_at = Some(Utc::now());
        }
        true
    }

    pub(crate) async fn find_pending_gemini_session_by_state(
        &self,
        oauth_state: &str,
    ) -> Option<DeviceAuthSession> {
        let needle = oauth_state.trim();
        if needle.is_empty() {
            return None;
        }

        let mut guard = self.inner.write().await;
        prune_sessions(&mut guard);
        guard
            .values()
            .find(|session| {
                if !session.provider.eq_ignore_ascii_case("gemini") {
                    return false;
                }
                if !matches!(session.status, DeviceAuthStatus::Pending) {
                    return false;
                }
                match &session.provider_state {
                    DeviceAuthProviderState::Gemini { oauth_state, .. } => oauth_state == needle,
                    _ => false,
                }
            })
            .cloned()
    }
}

fn prune_sessions(sessions: &mut HashMap<Uuid, DeviceAuthSession>) {
    let now = Utc::now();
    for session in sessions.values_mut() {
        if session.expires_at <= now && matches!(session.status, DeviceAuthStatus::Pending) {
            session.status = DeviceAuthStatus::Failed {
                error: "Device login timed out.".to_string(),
            };
            session.completed_at = Some(now);
        } else if !matches!(session.status, DeviceAuthStatus::Pending)
            && session.completed_at.is_none()
        {
            session.completed_at = Some(now);
        }
    }
    sessions.retain(|_, session| match session.status {
        DeviceAuthStatus::Pending => true,
        _ => session
            .completed_at
            .map(|dt| now - dt < chrono::Duration::minutes(30))
            .unwrap_or(true),
    });
}

#[derive(Clone)]
pub(crate) struct DeviceAuthSession {
    pub(crate) session_id: Uuid,
    pub(crate) user_id: Uuid,
    pub(crate) provider: String,
    pub(crate) verification_url: String,
    pub(crate) user_code: String,
    pub(crate) poll_interval_seconds: u64,
    pub(crate) expires_at: DateTime<Utc>,
    pub(crate) status: DeviceAuthStatus,
    pub(crate) completed_at: Option<DateTime<Utc>>,
    pub(crate) provider_state: DeviceAuthProviderState,
}

#[derive(Clone, Debug)]
pub(crate) enum DeviceAuthStatus {
    Pending,
    Completed { credential_id: Option<Uuid> },
    Failed { error: String },
    Cancelled,
}

#[derive(Clone)]
pub(crate) enum DeviceAuthProviderState {
    Codex {
        issuer: String,
        client_id: String,
        device_auth_id: String,
    },
    Github {
        client_id: String,
        device_code: String,
        access_token: Option<String>,
        scope: Option<String>,
    },
    Gemini {
        client_id: String,
        client_secret: Option<String>,
        code_verifier: String,
        oauth_state: String,
        redirect_uri: String,
        scope: String,
        oauth_mode: String,
        configured_project_id: Option<String>,
        requested_label: Option<String>,
    },
}

pub(crate) enum GithubDeviceAuthSessionResolution {
    Pending,
    Completed { access_token: String },
    Failed { error: String },
    Cancelled,
    NotFoundOrExpired,
}

struct GithubDeviceAuthSessionRecord {
    status: String,
    verification_url: String,
    user_code: String,
    poll_interval_seconds: u64,
    device_expires_at: DateTime<Utc>,
    assertion_expires_at: Option<DateTime<Utc>>,
    error_message: Option<String>,
    token_nonce_b64: Option<String>,
    token_ciphertext_b64: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GithubDeviceAuthCompletionOutcome {
    Completed { completed_at: DateTime<Utc> },
    AlreadyTerminal,
    Expired,
}

struct PreparedOauthToken {
    nonce_b64: String,
    ciphertext_b64: String,
    scope: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum GithubDeviceAuthStartReservation {
    Reserved,
    RateLimited { retry_after_seconds: u64 },
    PendingLimitReached,
    GlobalLimitReached,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/auth/device/:provider/start", post(start_device_auth))
        .route("/me/auth/device/:session_id", get(get_device_auth_status))
        .route("/me/auth/device/:session_id", delete(cancel_device_auth))
        .route(
            "/auth/device/gemini/callback",
            get(complete_gemini_oauth_callback),
        )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthStartResponse {
    session_id: String,
    provider: String,
    verification_url: String,
    user_code: String,
    expires_at: String,
    poll_interval_seconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthStatusResponse {
    session_id: String,
    provider: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_interval_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceAuthStartQuery {
    #[serde(default)]
    gemini_flow: Option<String>,
    #[serde(default)]
    oauth_mode: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

fn github_device_auth_assertion_expires_at(completed_at: DateTime<Utc>) -> DateTime<Utc> {
    completed_at + chrono::Duration::minutes(GITHUB_DEVICE_AUTH_ASSERTION_TTL_MINUTES)
}

fn github_device_auth_completion_outcome(
    status: &str,
    device_expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> GithubDeviceAuthCompletionOutcome {
    if status != "pending" {
        GithubDeviceAuthCompletionOutcome::AlreadyTerminal
    } else if device_expires_at <= now {
        GithubDeviceAuthCompletionOutcome::Expired
    } else {
        GithubDeviceAuthCompletionOutcome::Completed { completed_at: now }
    }
}

fn github_device_auth_expires_at(
    now: DateTime<Utc>,
    provider_expires_in_seconds: u64,
) -> DateTime<Utc> {
    let lifetime_seconds = if provider_expires_in_seconds == 0 {
        GITHUB_DEVICE_AUTH_DEFAULT_LIFETIME_SECONDS
    } else {
        provider_expires_in_seconds.min(GITHUB_DEVICE_AUTH_MAX_LIFETIME_SECONDS)
    };
    now + chrono::Duration::seconds(i64::try_from(lifetime_seconds).unwrap_or(900))
}

fn github_device_auth_poll_interval(provider_interval_seconds: u64) -> u64 {
    if provider_interval_seconds == 0 {
        GITHUB_DEVICE_AUTH_DEFAULT_POLL_INTERVAL_SECONDS
    } else {
        provider_interval_seconds.min(GITHUB_DEVICE_AUTH_MAX_POLL_INTERVAL_SECONDS)
    }
}

async fn github_device_auth_sessions_table_exists(
    client: &impl GenericClient,
) -> Result<bool, tokio_postgres::Error> {
    client
        .query_one(
            "select to_regclass('public.github_device_auth_sessions') is not null as exists",
            &[],
        )
        .await
        .map(|row| row.get::<_, bool>("exists"))
}

async fn github_device_auth_start_storage_ready(
    client: &impl GenericClient,
) -> Result<bool, tokio_postgres::Error> {
    client
        .query_one(
            "select
               to_regclass('public.github_device_auth_sessions') is not null
               and to_regclass('public.github_device_auth_start_attempts') is not null
               and exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'github_device_auth_sessions'
                   and column_name = 'poll_owner_id'
               )
               and exists (
                 select 1 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'github_device_auth_sessions'
                   and column_name = 'poll_lease_expires_at'
               ) as ready",
            &[],
        )
        .await
        .map(|row| row.get::<_, bool>("ready"))
}

async fn reserve_github_device_auth_start(
    pool: &PgPool,
    user_id: Uuid,
    attempt_id: Uuid,
) -> Result<GithubDeviceAuthStartReservation, (HttpStatusCode, Json<ApiError>)> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let ready = github_device_auth_start_storage_ready(&*connection)
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect GitHub device auth start storage: {error}"
            ))
        })?;
    if !ready {
        return Err(github_device_auth_service_unavailable(
            "GitHub connection storage is not ready. Please try again shortly.",
        ));
    }

    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start GitHub device auth reservation transaction: {error}"
        ))
    })?;
    let global_lock_key = "github-device-auth-start:global";
    let user_lock_key = format!("github-device-auth-start:user:{user_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&global_lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to serialize GitHub device auth starts: {error}"
            ))
        })?;
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&user_lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to serialize GitHub device auth user starts: {error}"
            ))
        })?;

    transaction
        .execute(
            "update github_device_auth_sessions
             set status = 'failed',
                 completed_at = now(),
                 assertion_expires_at = null,
                 error_message = case
                   when device_expires_at <= now() then $2
                   else $3
                 end,
                 token_nonce_b64 = null,
                 token_ciphertext_b64 = null,
                 token_scope = null,
                 poll_owner_id = null,
                 poll_lease_expires_at = null,
                 updated_at = now()
             where user_id = $1
               and status = 'pending'
               and (
                 device_expires_at <= now()
                 or poll_owner_id is null
                 or poll_lease_expires_at is null
                 or poll_lease_expires_at <= now()
               )",
            &[
                &user_id,
                &GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE,
                &GITHUB_DEVICE_AUTH_INTERRUPTED_MESSAGE,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to expire orphaned GitHub device auth sessions: {error}"
            ))
        })?;
    transaction
        .execute(
            "delete from github_device_auth_start_attempts
             where user_id = $1
               and created_at <= now() - ($2::bigint * interval '1 minute')",
            &[
                &user_id,
                &GITHUB_DEVICE_AUTH_START_ATTEMPT_RETENTION_MINUTES,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to prune GitHub device auth start attempts: {error}"
            ))
        })?;

    let recent = transaction
        .query_one(
            "select count(*)::bigint as attempt_count, min(created_at) as oldest_attempt
             from github_device_auth_start_attempts
             where user_id = $1
               and created_at > now() - ($2::bigint * interval '1 second')",
            &[&user_id, &GITHUB_DEVICE_AUTH_START_RATE_WINDOW_SECONDS],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect GitHub device auth start rate: {error}"
            ))
        })?;
    let attempt_count: i64 = recent.get("attempt_count");
    if attempt_count >= GITHUB_DEVICE_AUTH_START_RATE_LIMIT {
        let oldest_attempt: Option<DateTime<Utc>> = recent.get("oldest_attempt");
        let retry_after_seconds = oldest_attempt
            .map(|value| {
                (value + chrono::Duration::seconds(GITHUB_DEVICE_AUTH_START_RATE_WINDOW_SECONDS)
                    - Utc::now())
                .num_seconds()
                .max(1) as u64
            })
            .unwrap_or(1);
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finish GitHub device auth rate-limit transaction: {error}"
            ))
        })?;
        return Ok(GithubDeviceAuthStartReservation::RateLimited {
            retry_after_seconds,
        });
    }

    let active = transaction
        .query_one(
            "select
               (
                 (select count(*) from github_device_auth_sessions
                  where user_id = $1
                    and status = 'pending'
                    and device_expires_at > now()
                    and poll_lease_expires_at > now())
                 +
                 (select count(*) from github_device_auth_start_attempts
                  where user_id = $1
                    and completed_at is null
                    and reservation_expires_at > now())
               )::bigint as user_active,
               (
                 (select count(*) from github_device_auth_sessions
                  where status = 'pending'
                    and device_expires_at > now()
                    and poll_lease_expires_at > now())
                 +
                 (select count(*) from github_device_auth_start_attempts
                  where completed_at is null
                    and reservation_expires_at > now())
               )::bigint as global_active",
            &[&user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect active GitHub device auth starts: {error}"
            ))
        })?;
    let user_active: i64 = active.get("user_active");
    let global_active: i64 = active.get("global_active");
    let limit_outcome = if user_active >= GITHUB_DEVICE_AUTH_PENDING_PER_USER_LIMIT {
        Some(GithubDeviceAuthStartReservation::PendingLimitReached)
    } else if global_active >= GITHUB_DEVICE_AUTH_PENDING_GLOBAL_LIMIT {
        Some(GithubDeviceAuthStartReservation::GlobalLimitReached)
    } else {
        None
    };
    if let Some(outcome) = limit_outcome {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finish GitHub device auth capacity transaction: {error}"
            ))
        })?;
        return Ok(outcome);
    }

    transaction
        .execute(
            "insert into github_device_auth_start_attempts (
               attempt_id, user_id, reservation_expires_at
             ) values (
               $1, $2, now() + ($3::bigint * interval '1 second')
             )",
            &[
                &attempt_id,
                &user_id,
                &GITHUB_DEVICE_AUTH_START_RESERVATION_SECONDS,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to reserve GitHub device auth start: {error}"
            ))
        })?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit GitHub device auth start reservation: {error}"
        ))
    })?;
    Ok(GithubDeviceAuthStartReservation::Reserved)
}

async fn release_github_device_auth_start(
    pool: &PgPool,
    user_id: Uuid,
    attempt_id: Uuid,
) -> Result<(), (HttpStatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    connection
        .execute(
            "update github_device_auth_start_attempts
             set completed_at = coalesce(completed_at, now()),
                 reservation_expires_at = least(reservation_expires_at, now())
             where attempt_id = $1 and user_id = $2",
            &[&attempt_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to release GitHub device auth start reservation: {error}"
            ))
        })?;
    Ok(())
}

async fn prune_expired_github_device_auth_sessions(
    client: &impl GenericClient,
) -> Result<u64, tokio_postgres::Error> {
    let deleted_sessions = client
        .execute(
            "delete from github_device_auth_sessions
             where (
               status <> 'pending'
               and (
                 (assertion_expires_at is not null and assertion_expires_at <= now())
                 or (
                   assertion_expires_at is null
                   and completed_at <= now() - ($1::bigint * interval '1 minute')
                 )
               )
             )
             or (
               status = 'pending'
               and device_expires_at <= now() - ($1::bigint * interval '1 minute')
             )",
            &[&GITHUB_DEVICE_AUTH_TERMINAL_RETENTION_MINUTES],
        )
        .await?;
    let deleted_attempts = client
        .execute(
            "delete from github_device_auth_start_attempts
             where ctid in (
               select ctid
               from github_device_auth_start_attempts
               where created_at <= now() - ($1::bigint * interval '1 minute')
               order by created_at asc
               limit 1000
             )",
            &[&GITHUB_DEVICE_AUTH_START_ATTEMPT_RETENTION_MINUTES],
        )
        .await?;
    Ok(deleted_sessions.saturating_add(deleted_attempts))
}

async fn insert_github_device_auth_session(
    state: &AppState,
    session: &DeviceAuthSession,
    attempt_id: Uuid,
) -> Result<(), (HttpStatusCode, Json<ApiError>)> {
    // PostgreSQL `integer` is INT4, so tokio-postgres requires an i32 here.
    // Passing an i64 fails client-side with "error serializing parameter 4"
    // before the insert reaches PostgreSQL.
    let poll_interval_seconds = i32::try_from(session.poll_interval_seconds)
        .map_err(|_| internal_error("GitHub device auth poll interval is invalid"))?;
    let poll_lease_expires_at =
        Utc::now() + chrono::Duration::seconds(GITHUB_DEVICE_AUTH_POLL_LEASE_SECONDS);
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start GitHub device auth persistence transaction: {error}"
        ))
    })?;
    let global_lock_key = "github-device-auth-start:global";
    let user_lock_key = format!("github-device-auth-start:user:{}", session.user_id);
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&global_lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to serialize GitHub device auth persistence: {error}"
            ))
        })?;
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&user_lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to serialize GitHub device auth user persistence: {error}"
            ))
        })?;
    let reservation_active = transaction
        .query_opt(
            "select 1
             from github_device_auth_start_attempts
             where attempt_id = $1
               and user_id = $2
               and completed_at is null
               and reservation_expires_at > now()
             for update",
            &[&attempt_id, &session.user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock GitHub device auth start reservation: {error}"
            ))
        })?
        .is_some();
    if !reservation_active {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finish expired GitHub device auth reservation: {error}"
            ))
        })?;
        return Err((
            HttpStatusCode::CONFLICT,
            Json(ApiError::with_details(
                "The GitHub connection request took too long to start. Try again.",
                "github_device_auth_start_expired",
                json!({ "retryable": true }),
            )),
        ));
    }

    match transaction
        .execute(
            "insert into github_device_auth_sessions (
               session_id,
               user_id,
               status,
               verification_url,
               user_code,
               poll_interval_seconds,
               device_expires_at,
               poll_owner_id,
               poll_lease_expires_at
             ) values ($1, $2, 'pending', $3, $4, $5, $6, $1, $7)",
            &[
                &session.session_id,
                &session.user_id,
                &session.verification_url,
                &session.user_code,
                &poll_interval_seconds,
                &session.expires_at,
                &poll_lease_expires_at,
            ],
        )
        .await
    {
        Ok(_) => {}
        Err(error)
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNDEFINED_TABLE)
                .unwrap_or(false) =>
        {
            return Err(github_device_auth_service_unavailable(
                "GitHub connection storage is not ready. Please try again shortly.",
            ));
        }
        Err(error) => {
            return Err(internal_error(format!(
                "failed to persist GitHub device auth session: {error}"
            )));
        }
    }

    let released = transaction
        .execute(
            "update github_device_auth_start_attempts
             set completed_at = now(), reservation_expires_at = now()
             where attempt_id = $1 and user_id = $2 and completed_at is null",
            &[&attempt_id, &session.user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to complete GitHub device auth start reservation: {error}"
            ))
        })?;
    if released != 1 {
        return Err(internal_error(
            "GitHub device auth start reservation changed before persistence",
        ));
    }
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit GitHub device auth session: {error}"
        ))
    })?;

    if let Err(error) = prune_expired_github_device_auth_sessions(&*connection).await {
        tracing::warn!(
            ?error,
            "failed to prune expired GitHub device auth sessions"
        );
    }
    Ok(())
}

fn github_device_auth_record_from_row(row: Row) -> GithubDeviceAuthSessionRecord {
    let poll_interval_seconds = row
        .get::<_, i64>("poll_interval_seconds")
        .try_into()
        .unwrap_or(1);
    GithubDeviceAuthSessionRecord {
        status: row.get("status"),
        verification_url: row.get("verification_url"),
        user_code: row.get("user_code"),
        poll_interval_seconds,
        device_expires_at: row.get("device_expires_at"),
        assertion_expires_at: row.get("assertion_expires_at"),
        error_message: row.get("error_message"),
        token_nonce_b64: row.get("token_nonce_b64"),
        token_ciphertext_b64: row.get("token_ciphertext_b64"),
    }
}

async fn load_github_device_auth_session_record(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<Option<GithubDeviceAuthSessionRecord>, (HttpStatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let table_exists = github_device_auth_sessions_table_exists(&*connection)
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect GitHub device auth storage: {error}"
            ))
        })?;
    if !table_exists {
        return Ok(None);
    }

    connection
        .execute(
            "delete from github_device_auth_sessions
             where session_id = $1
               and user_id = $2
               and status <> 'pending'
               and (
                 (assertion_expires_at is not null and assertion_expires_at <= now())
                 or (
                   assertion_expires_at is null
                   and completed_at <= now() - ($3::bigint * interval '1 minute')
                 )
               )",
            &[
                &session_id,
                &user_id,
                &GITHUB_DEVICE_AUTH_TERMINAL_RETENTION_MINUTES,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to prune GitHub device auth session: {error}"
            ))
        })?;

    connection
        .execute(
            "update github_device_auth_sessions
             set status = 'failed',
                 completed_at = now(),
                 error_message = case
                   when device_expires_at <= now() then $3
                   else $4
                 end,
                 poll_owner_id = null,
                 poll_lease_expires_at = null,
                 updated_at = now()
             where session_id = $1
               and user_id = $2
               and status = 'pending'
               and (
                 device_expires_at <= now()
                 or poll_owner_id is null
                 or poll_lease_expires_at is null
                 or poll_lease_expires_at <= now()
               )",
            &[
                &session_id,
                &user_id,
                &GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE,
                &GITHUB_DEVICE_AUTH_INTERRUPTED_MESSAGE,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to expire GitHub device auth session: {error}"
            ))
        })?;

    let row = connection
        .query_opt(
            "select
               status,
               verification_url,
               user_code,
               poll_interval_seconds::bigint as poll_interval_seconds,
               device_expires_at,
               assertion_expires_at,
               error_message,
               token_nonce_b64,
               token_ciphertext_b64
             from github_device_auth_sessions
             where session_id = $1 and user_id = $2",
            &[&session_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load GitHub device auth session: {error}"
            ))
        })?;

    Ok(row.map(github_device_auth_record_from_row))
}

async fn cancel_github_device_auth_session(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<bool, (HttpStatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let table_exists = github_device_auth_sessions_table_exists(&*connection)
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to inspect GitHub device auth storage: {error}"
            ))
        })?;
    if !table_exists {
        return Ok(false);
    }

    let transitioned = connection
        .query_opt(
            "update github_device_auth_sessions
             set status = case
                   when device_expires_at <= now() then 'failed'
                   else 'cancelled'
                 end,
                 completed_at = now(),
                 error_message = case
                   when device_expires_at <= now() then $3
                   else null
                 end,
                 poll_owner_id = null,
                 poll_lease_expires_at = null,
                 updated_at = now()
             where session_id = $1
               and user_id = $2
               and status = 'pending'
             returning status",
            &[&session_id, &user_id, &GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to cancel GitHub device auth session: {error}"
            ))
        })?;
    if transitioned.is_some() {
        return Ok(true);
    }

    connection
        .query_opt(
            "select 1 from github_device_auth_sessions where session_id = $1 and user_id = $2",
            &[&session_id, &user_id],
        )
        .await
        .map(|row| row.is_some())
        .map_err(|error| {
            internal_error(format!(
                "failed to load GitHub device auth session after cancel: {error}"
            ))
        })
}

async fn fail_github_device_auth_session(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
    error_message: &str,
) -> Result<bool, (HttpStatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let changed = connection
        .execute(
            "update github_device_auth_sessions
             set status = 'failed',
                 completed_at = now(),
                 error_message = $3,
                 poll_owner_id = null,
                 poll_lease_expires_at = null,
                 updated_at = now()
             where session_id = $1
               and user_id = $2
               and status = 'pending'",
            &[&session_id, &user_id, &error_message],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to fail GitHub device auth session: {error}"
            ))
        })?;
    Ok(changed == 1)
}

async fn renew_github_device_auth_poll_lease(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<bool, (HttpStatusCode, Json<ApiError>)> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let changed = connection
        .execute(
            "update github_device_auth_sessions
             set poll_lease_expires_at = now() + ($3::bigint * interval '1 second'),
                 updated_at = now()
             where session_id = $1
               and user_id = $2
               and status = 'pending'
               and poll_owner_id = $1
               and poll_lease_expires_at > now()
               and device_expires_at > now()",
            &[
                &session_id,
                &user_id,
                &GITHUB_DEVICE_AUTH_POLL_LEASE_SECONDS,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to renew GitHub device auth poll lease: {error}"
            ))
        })?;
    Ok(changed == 1)
}

async fn complete_github_device_auth_session(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
    access_token: &str,
    scope: Option<&str>,
) -> Result<GithubDeviceAuthCompletionOutcome, (HttpStatusCode, Json<ApiError>)> {
    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| {
            github_device_auth_service_unavailable(GITHUB_DEVICE_AUTH_STORAGE_UNAVAILABLE_MESSAGE)
        })?;
    let completed_at = Utc::now();
    let assertion_expires_at = github_device_auth_assertion_expires_at(completed_at);
    let prepared = prepare_oauth_token(
        key,
        access_token,
        scope,
        Some((session_id, assertion_expires_at)),
    )?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    ensure_user_oauth_tokens_storage_ready(&*connection).await?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let row = transaction
        .query_opt(
            "select status, device_expires_at
             from github_device_auth_sessions
             where session_id = $1 and user_id = $2
             for update",
            &[&session_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock GitHub device auth session: {error}"
            ))
        })?;
    let Some(row) = row else {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finish missing GitHub device auth session transaction: {error}"
            ))
        })?;
        return Ok(GithubDeviceAuthCompletionOutcome::AlreadyTerminal);
    };
    let status: String = row.get("status");
    let device_expires_at: DateTime<Utc> = row.get("device_expires_at");
    let outcome = github_device_auth_completion_outcome(&status, device_expires_at, completed_at);

    match outcome {
        GithubDeviceAuthCompletionOutcome::AlreadyTerminal => {
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finish GitHub device auth transaction: {error}"
                ))
            })?;
            Ok(outcome)
        }
        GithubDeviceAuthCompletionOutcome::Expired => {
            transaction
                .execute(
                    "update github_device_auth_sessions
                     set status = 'failed',
                         completed_at = $3,
                         error_message = $4,
                         poll_owner_id = null,
                         poll_lease_expires_at = null,
                         updated_at = now()
                     where session_id = $1 and user_id = $2 and status = 'pending'",
                    &[
                        &session_id,
                        &user_id,
                        &completed_at,
                        &GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE,
                    ],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to expire GitHub device auth session: {error}"
                    ))
                })?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit expired GitHub device auth session: {error}"
                ))
            })?;
            Ok(outcome)
        }
        GithubDeviceAuthCompletionOutcome::Completed { .. } => {
            upsert_prepared_user_oauth_access_token(
                &transaction,
                user_id,
                USER_OAUTH_TOKEN_PROVIDER_GITHUB,
                &prepared,
            )
            .await
            .map_err(|error| internal_error(format!("failed to upsert oauth token: {error}")))?;

            let scope = prepared.scope.as_deref();
            let changed = transaction
                .execute(
                    "update github_device_auth_sessions
                     set status = 'completed',
                         completed_at = $3,
                         assertion_expires_at = $4,
                         error_message = null,
                         token_nonce_b64 = $5,
                         token_ciphertext_b64 = $6,
                         token_scope = $7,
                         poll_owner_id = null,
                         poll_lease_expires_at = null,
                         updated_at = now()
                     where session_id = $1 and user_id = $2 and status = 'pending'",
                    &[
                        &session_id,
                        &user_id,
                        &completed_at,
                        &assertion_expires_at,
                        &prepared.nonce_b64,
                        &prepared.ciphertext_b64,
                        &scope,
                    ],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to complete GitHub device auth session: {error}"
                    ))
                })?;
            if changed != 1 {
                return Err(internal_error(
                    "GitHub device auth session changed while completing",
                ));
            }
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to commit GitHub device auth session: {error}"
                ))
            })?;
            Ok(outcome)
        }
    }
}

fn github_device_auth_status_response(
    session_id: Uuid,
    record: GithubDeviceAuthSessionRecord,
) -> Result<DeviceAuthStatusResponse, (HttpStatusCode, Json<ApiError>)> {
    let (status, error, include_codes) = match record.status.as_str() {
        "pending" => ("pending".to_string(), None, true),
        "completed" => ("completed".to_string(), None, false),
        "cancelled" => ("cancelled".to_string(), None, false),
        "failed" => (
            "failed".to_string(),
            Some(
                record
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "GitHub device login failed.".to_string()),
            ),
            false,
        ),
        _ => {
            return Err(internal_error(
                "GitHub device auth session status is invalid",
            ))
        }
    };

    Ok(DeviceAuthStatusResponse {
        session_id: session_id.to_string(),
        provider: "github".to_string(),
        status,
        verification_url: include_codes.then(|| record.verification_url),
        user_code: include_codes.then(|| record.user_code),
        expires_at: include_codes.then(|| record.device_expires_at.to_rfc3339()),
        poll_interval_seconds: include_codes.then_some(record.poll_interval_seconds),
        credential_id: None,
        error,
    })
}

async fn start_device_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DeviceAuthStartQuery>,
    AxumPath(provider): AxumPath<String>,
) -> Result<Json<DeviceAuthStartResponse>, (HttpStatusCode, Json<ApiError>)> {
    let provider = provider.trim().to_ascii_lowercase();

    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let now = Utc::now();
    let session_id = Uuid::new_v4();
    match provider.as_str() {
        "codex" => {
            let issuer = read_env_trimmed("CODEX_DEVICE_AUTH_ISSUER")
                .unwrap_or_else(|| DEFAULT_CODEX_ISSUER.to_string());
            let client_id = read_env_trimmed("CODEX_DEVICE_AUTH_CLIENT_ID")
                .unwrap_or_else(|| DEFAULT_CODEX_CLIENT_ID.to_string());
            let challenge = request_codex_user_code(&state, &issuer, &client_id).await?;

            let expires_at = now + chrono::Duration::minutes(15);
            let verification_url = format!("{}/codex/device", issuer.trim_end_matches('/'));

            let session = DeviceAuthSession {
                session_id,
                user_id,
                provider: "codex".to_string(),
                verification_url: verification_url.clone(),
                user_code: challenge.user_code.clone(),
                poll_interval_seconds: challenge.interval.max(1),
                expires_at,
                status: DeviceAuthStatus::Pending,
                completed_at: None,
                provider_state: DeviceAuthProviderState::Codex {
                    issuer: issuer.clone(),
                    client_id: client_id.clone(),
                    device_auth_id: challenge.device_auth_id.clone(),
                },
            };

            state.device_auth_sessions.insert(session).await;
            tokio::spawn(poll_codex_device_auth(state.clone(), session_id));

            Ok(Json(DeviceAuthStartResponse {
                session_id: session_id.to_string(),
                provider: "codex".to_string(),
                verification_url,
                user_code: challenge.user_code,
                expires_at: expires_at.to_rfc3339(),
                poll_interval_seconds: challenge.interval.max(1),
            }))
        }
        "github" => {
            if state.config.credential_encryption_key.is_none() {
                return Err(github_device_auth_service_unavailable(
                    GITHUB_DEVICE_AUTH_STORAGE_UNAVAILABLE_MESSAGE,
                ));
            }
            let client_id = read_env_trimmed("GITHUB_DEVICE_AUTH_CLIENT_ID")
                .ok_or_else(|| {
                    bad_request(
                        "GitHub device-code login is not configured. Set GITHUB_DEVICE_AUTH_CLIENT_ID in the controller environment.",
                    )
                })?;
            let scope =
                read_env_trimmed("GITHUB_DEVICE_AUTH_SCOPE").unwrap_or_else(|| "repo".to_string());
            let attempt_id = Uuid::new_v4();
            match reserve_github_device_auth_start(&state.pool, user_id, attempt_id).await? {
                GithubDeviceAuthStartReservation::Reserved => {}
                GithubDeviceAuthStartReservation::RateLimited {
                    retry_after_seconds,
                } => {
                    return Err((
                        HttpStatusCode::TOO_MANY_REQUESTS,
                        Json(ApiError::with_details(
                            format!(
                                "Too many GitHub connection attempts. Try again in {retry_after_seconds}s."
                            ),
                            "github_device_auth_rate_limited",
                            json!({
                                "retryable": true,
                                "retryAfterSeconds": retry_after_seconds,
                            }),
                        )),
                    ));
                }
                GithubDeviceAuthStartReservation::PendingLimitReached => {
                    return Err((
                        HttpStatusCode::CONFLICT,
                        Json(ApiError::with_details(
                            "Two GitHub connection requests are already pending. Finish or cancel one before starting another.",
                            "github_device_auth_pending_limit",
                            json!({ "retryable": true }),
                        )),
                    ));
                }
                GithubDeviceAuthStartReservation::GlobalLimitReached => {
                    return Err((
                        HttpStatusCode::SERVICE_UNAVAILABLE,
                        Json(ApiError::with_details(
                            "GitHub connection capacity is temporarily full. Try again shortly.",
                            "github_device_auth_capacity_reached",
                            json!({ "retryable": true }),
                        )),
                    ));
                }
            }

            let challenge = match request_github_device_code(&state, &client_id, &scope).await {
                Ok(challenge) => challenge,
                Err(error) => {
                    if let Err((status, _)) =
                        release_github_device_auth_start(&state.pool, user_id, attempt_id).await
                    {
                        tracing::warn!(
                            http_status = %status,
                            user_id = %user_id,
                            attempt_id = %attempt_id,
                            "failed to release rejected GitHub device auth start"
                        );
                    }
                    return Err(error);
                }
            };
            let expires_at = github_device_auth_expires_at(Utc::now(), challenge.expires_in);
            let poll_interval_seconds = github_device_auth_poll_interval(challenge.interval);

            let session = DeviceAuthSession {
                session_id,
                user_id,
                provider: "github".to_string(),
                verification_url: challenge.verification_uri.clone(),
                user_code: challenge.user_code.clone(),
                poll_interval_seconds,
                expires_at,
                status: DeviceAuthStatus::Pending,
                completed_at: None,
                provider_state: DeviceAuthProviderState::Github {
                    client_id: client_id.clone(),
                    device_code: challenge.device_code.clone(),
                    access_token: None,
                    scope: None,
                },
            };

            if let Err(error) =
                insert_github_device_auth_session(&state, &session, attempt_id).await
            {
                if let Err((status, _)) =
                    release_github_device_auth_start(&state.pool, user_id, attempt_id).await
                {
                    tracing::warn!(
                        http_status = %status,
                        user_id = %user_id,
                        attempt_id = %attempt_id,
                        "failed to release unpersisted GitHub device auth start"
                    );
                }
                return Err(error);
            }
            state.device_auth_sessions.insert(session).await;
            tokio::spawn(poll_github_device_auth(state.clone(), session_id));

            Ok(Json(DeviceAuthStartResponse {
                session_id: session_id.to_string(),
                provider: "github".to_string(),
                verification_url: challenge.verification_uri,
                user_code: challenge.user_code,
                expires_at: expires_at.to_rfc3339(),
                poll_interval_seconds,
            }))
        }
        "gemini" | "google" | "google-ai" | "google_gemini" | "google-gemini" => {
            let oauth_mode = resolve_gemini_oauth_mode(Some(&query));
            let (client_id, client_secret) = resolve_gemini_oauth_client_credentials(&oauth_mode)?;
            let requested_label = query
                .label
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string());
            let scope = read_env_trimmed("GEMINI_OAUTH_SCOPE")
                .or_else(|| read_env_trimmed("GOOGLE_OAUTH_SCOPE"))
                .unwrap_or_else(|| {
                    if is_gemini_code_assist_mode(&oauth_mode) {
                        DEFAULT_GEMINI_CODE_ASSIST_OAUTH_SCOPE.to_string()
                    } else {
                        DEFAULT_GEMINI_OAUTH_SCOPE.to_string()
                    }
                });
            let redirect_uri = resolve_gemini_oauth_redirect_uri(&headers).ok_or_else(|| {
                bad_request(
                    "Gemini OAuth redirect URL is not configured. Set GEMINI_OAUTH_REDIRECT_URI (or CONTROLLER_EXTERNAL_URL).",
                )
            })?;
            let configured_project_id = resolve_configured_gemini_project_id();

            let code_verifier = generate_oauth_token(48);
            let code_challenge = build_pkce_code_challenge(&code_verifier);
            let oauth_state = generate_oauth_token(24);
            let verification_url = build_gemini_authorize_url(
                &client_id,
                &redirect_uri,
                &scope,
                &oauth_state,
                &code_challenge,
            );
            let expires_at = now + chrono::Duration::minutes(20);

            let session = DeviceAuthSession {
                session_id,
                user_id,
                provider: "gemini".to_string(),
                verification_url: verification_url.clone(),
                user_code: "GOOGLE-OAUTH".to_string(),
                poll_interval_seconds: 3,
                expires_at,
                status: DeviceAuthStatus::Pending,
                completed_at: None,
                provider_state: DeviceAuthProviderState::Gemini {
                    client_id,
                    client_secret,
                    code_verifier,
                    oauth_state,
                    redirect_uri,
                    scope,
                    oauth_mode,
                    configured_project_id,
                    requested_label,
                },
            };

            state.device_auth_sessions.insert(session).await;

            Ok(Json(DeviceAuthStartResponse {
                session_id: session_id.to_string(),
                provider: "gemini".to_string(),
                verification_url,
                user_code: "GOOGLE-OAUTH".to_string(),
                expires_at: expires_at.to_rfc3339(),
                poll_interval_seconds: 3,
            }))
        }
        _ => Err(not_found("unknown device auth provider")),
    }
}

async fn get_device_auth_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<DeviceAuthStatusResponse>, (HttpStatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let session_id = Uuid::parse_str(session_id.trim())
        .map_err(|_| bad_request("invalid device auth session id"))?;
    let local_session = state.device_auth_sessions.get(&session_id).await;
    if let Some(session) = local_session.as_ref() {
        if session.user_id != user_id {
            return Err(not_found("device auth session not found"));
        }
        // Codex and Gemini remain intentionally process-local. Their status
        // path must not gain a PostgreSQL availability dependency merely
        // because GitHub sessions are now durable.
        if session.provider != "github" {
            return Ok(Json(local_device_auth_status_response(session.clone())));
        }
    }

    if let Some(record) =
        load_github_device_auth_session_record(&state, user_id, session_id).await?
    {
        return github_device_auth_status_response(session_id, record).map(Json);
    }

    let session = local_session.ok_or_else(|| not_found("device auth session not found"))?;

    Ok(Json(local_device_auth_status_response(session)))
}

fn local_device_auth_status_response(session: DeviceAuthSession) -> DeviceAuthStatusResponse {
    let (status, credential_id, error, include_codes) = match session.status {
        DeviceAuthStatus::Pending => ("pending".to_string(), None, None, true),
        DeviceAuthStatus::Cancelled => ("cancelled".to_string(), None, None, false),
        DeviceAuthStatus::Completed { credential_id } => (
            "completed".to_string(),
            credential_id.map(|value| value.to_string()),
            None,
            false,
        ),
        DeviceAuthStatus::Failed { error } => ("failed".to_string(), None, Some(error), false),
    };

    DeviceAuthStatusResponse {
        session_id: session.session_id.to_string(),
        provider: session.provider,
        status,
        verification_url: include_codes.then(|| session.verification_url),
        user_code: include_codes.then(|| session.user_code),
        expires_at: include_codes.then(|| session.expires_at.to_rfc3339()),
        poll_interval_seconds: include_codes.then(|| session.poll_interval_seconds),
        credential_id,
        error,
    }
}

async fn cancel_device_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(session_id): AxumPath<String>,
) -> Result<HttpStatusCode, (HttpStatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let session_id = Uuid::parse_str(session_id.trim())
        .map_err(|_| bad_request("invalid device auth session id"))?;
    if let Some(session) = state.device_auth_sessions.get(&session_id).await {
        if session.user_id != user_id {
            return Err(not_found("device auth session not found"));
        }
        if session.provider != "github" {
            let cancelled = state
                .device_auth_sessions
                .cancel(&session_id, &user_id)
                .await;
            return if cancelled {
                Ok(HttpStatusCode::NO_CONTENT)
            } else {
                Err(not_found("device auth session not found"))
            };
        }
    }

    if cancel_github_device_auth_session(&state, user_id, session_id).await? {
        let _ = state
            .device_auth_sessions
            .cancel(&session_id, &user_id)
            .await;
        return Ok(HttpStatusCode::NO_CONTENT);
    }

    let cancelled = state
        .device_auth_sessions
        .cancel(&session_id, &user_id)
        .await;
    if !cancelled {
        return Err(not_found("device auth session not found"));
    }
    Ok(HttpStatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct GeminiOauthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiOauthTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    scope: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCodeAssistLoadResponse {
    cloudaicompanion_project: Option<JsonValue>,
    current_tier: Option<GeminiCodeAssistTier>,
    allowed_tiers: Option<Vec<GeminiCodeAssistTier>>,
    ineligible_tiers: Option<Vec<GeminiCodeAssistIneligibleTier>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCodeAssistTier {
    id: Option<String>,
    #[allow(dead_code)]
    is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCodeAssistIneligibleTier {
    reason_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCodeAssistOnboardResponse {
    name: Option<String>,
    done: Option<bool>,
    response: Option<GeminiCodeAssistOnboardInnerResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCodeAssistOnboardInnerResponse {
    cloudaicompanion_project: Option<GeminiCodeAssistProjectRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiCodeAssistProjectRef {
    id: Option<String>,
}

#[derive(Debug)]
struct GeminiOauthTokens {
    access_token: String,
    refresh_token: Option<String>,
    scope: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    expires_at: Option<DateTime<Utc>>,
}

async fn complete_gemini_oauth_callback(
    State(state): State<AppState>,
    Query(query): Query<GeminiOauthCallbackQuery>,
) -> (HttpStatusCode, Html<String>) {
    let oauth_state = query
        .state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let Some(oauth_state) = oauth_state else {
        return oauth_callback_response(
            HttpStatusCode::BAD_REQUEST,
            "Gemini login failed",
            "Missing OAuth state.",
        );
    };

    let Some(session) = state
        .device_auth_sessions
        .find_pending_gemini_session_by_state(&oauth_state)
        .await
    else {
        return oauth_callback_response(
            HttpStatusCode::BAD_REQUEST,
            "Gemini login failed",
            "This login session is invalid or expired. Start Gemini login again from Instafy.",
        );
    };

    if let Some(error_code) = query
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let message = query
            .error_description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(error_code)
            .to_string();
        mark_device_auth_failed(&state, session.session_id, &message).await;
        return oauth_callback_response(
            HttpStatusCode::BAD_REQUEST,
            "Gemini login failed",
            &message,
        );
    }

    let Some(code) = query
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        mark_device_auth_failed(&state, session.session_id, "Missing OAuth code.").await;
        return oauth_callback_response(
            HttpStatusCode::BAD_REQUEST,
            "Gemini login failed",
            "Missing OAuth code.",
        );
    };

    let (
        client_id,
        client_secret,
        code_verifier,
        redirect_uri,
        requested_scope,
        oauth_mode,
        configured_project_id,
        requested_label,
    ) = match session.provider_state.clone() {
        DeviceAuthProviderState::Gemini {
            client_id,
            client_secret,
            code_verifier,
            redirect_uri,
            scope,
            oauth_mode,
            configured_project_id,
            requested_label,
            ..
        } => (
            client_id,
            client_secret,
            code_verifier,
            redirect_uri,
            scope,
            oauth_mode,
            configured_project_id,
            requested_label,
        ),
        _ => {
            mark_device_auth_failed(
                &state,
                session.session_id,
                "Login session is not a Gemini OAuth flow.",
            )
            .await;
            return oauth_callback_response(
                HttpStatusCode::BAD_REQUEST,
                "Gemini login failed",
                "Login session is not a Gemini OAuth flow.",
            );
        }
    };

    let tokens = match exchange_gemini_oauth_code(
        &state,
        &client_id,
        client_secret.as_deref(),
        &code_verifier,
        &redirect_uri,
        code,
    )
    .await
    {
        Ok(tokens) => tokens,
        Err(error) => {
            mark_device_auth_failed(&state, session.session_id, &error).await;
            return oauth_callback_response(
                HttpStatusCode::BAD_REQUEST,
                "Gemini login failed",
                &error,
            );
        }
    };

    let scope = tokens
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(requested_scope.as_str())
        .to_string();

    if is_gemini_code_assist_mode(&oauth_mode)
        && !scope_has_oauth_value(scope.as_str(), REQUIRED_GEMINI_CODE_ASSIST_SCOPE)
    {
        let message = format!(
            "Google OAuth did not grant required scope {} for Gemini Code Assist. Update OAuth consent screen scopes, revoke prior app access, and reconnect Gemini.",
            REQUIRED_GEMINI_CODE_ASSIST_SCOPE
        );
        mark_device_auth_failed(&state, session.session_id, &message).await;
        return oauth_callback_response(
            HttpStatusCode::BAD_REQUEST,
            "Gemini login failed",
            &message,
        );
    }

    let code_assist_project_id = if is_gemini_code_assist_mode(&oauth_mode) {
        match resolve_gemini_code_assist_project(
            &state,
            &tokens.access_token,
            configured_project_id.as_deref(),
            oauth_mode == GEMINI_OAUTH_MODE_CODE_ASSIST_CLI,
        )
        .await
        {
            Ok(project_id) => project_id,
            Err(error) => {
                mark_device_auth_failed(&state, session.session_id, &error).await;
                return oauth_callback_response(
                    HttpStatusCode::BAD_REQUEST,
                    "Gemini login failed",
                    &error,
                );
            }
        }
    } else {
        None
    };

    let auth_json = build_gemini_oauth_auth_json(
        &tokens,
        &scope,
        &oauth_mode,
        code_assist_project_id.as_deref(),
    );
    let metadata = build_gemini_oauth_metadata(
        &tokens,
        &scope,
        &oauth_mode,
        code_assist_project_id.as_deref(),
    );

    let created = match credentials::insert_user_credential(
        &state,
        session.user_id,
        OPENAI_API_KEY_CREDENTIAL_KIND.to_string(),
        metadata,
        auth_json,
        requested_label.or_else(|| Some("Google Gemini".to_string())),
        None,
    )
    .await
    {
        Ok(created) => created,
        Err((_, error)) => {
            let message = error.0.message.clone();
            mark_device_auth_failed(&state, session.session_id, &message).await;
            return oauth_callback_response(
                HttpStatusCode::BAD_REQUEST,
                "Gemini login failed",
                &message,
            );
        }
    };

    if let Err(error) = upsert_user_oauth_access_token(
        &state,
        session.user_id,
        USER_OAUTH_TOKEN_PROVIDER_GEMINI,
        &tokens.access_token,
        Some(&scope),
        None,
    )
    .await
    {
        tracing::warn!(
            ?error,
            session_id = %session.session_id,
            user_id = %session.user_id,
            "failed to persist Gemini oauth token"
        );
    }

    let _ = state
        .device_auth_sessions
        .update_status(
            &session.session_id,
            DeviceAuthStatus::Completed {
                credential_id: Some(created.credential_id),
            },
        )
        .await;
    {
        let mut guard = state.device_auth_sessions.inner.write().await;
        if let Some(entry) = guard.get_mut(&session.session_id) {
            entry.completed_at = Some(Utc::now());
        }
    }

    oauth_callback_response(
        HttpStatusCode::OK,
        "Gemini connected",
        "Gemini is connected. You can close this window and return to Instafy.",
    )
}

async fn mark_device_auth_failed(state: &AppState, session_id: Uuid, message: &str) {
    let _ = state
        .device_auth_sessions
        .update_status(
            &session_id,
            DeviceAuthStatus::Failed {
                error: message.to_string(),
            },
        )
        .await;
}

fn oauth_callback_response(
    status: HttpStatusCode,
    title: &str,
    message: &str,
) -> (HttpStatusCode, Html<String>) {
    let escaped_title = html_escape(title);
    let escaped_message = html_escape(message);
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;background:#f8fafc;color:#0f172a}}main{{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,.08)}}h1{{font-size:18px;margin:0 0 8px}}p{{margin:0 0 12px;line-height:1.45;color:#334155}}small{{color:#64748b}}</style></head><body><main><h1>{}</h1><p>{}</p><small>You can close this window.</small></main><script>setTimeout(function(){{try{{window.close();}}catch(_e){{}}}},250);</script></body></html>",
        escaped_title, escaped_title, escaped_message
    );
    (status, Html(body))
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[derive(Deserialize)]
struct CodexUserCodeResp {
    device_auth_id: String,
    #[serde(alias = "user_code", alias = "usercode")]
    user_code: String,
    #[serde(default, deserialize_with = "deserialize_interval")]
    interval: u64,
}

#[derive(Serialize)]
struct CodexUserCodeReq {
    client_id: String,
}

#[derive(Clone, Debug)]
struct CodexTokenPollResp {
    authorization_code: String,
    code_verifier: String,
}

#[derive(Serialize)]
struct CodexTokenPollReq {
    device_auth_id: String,
    user_code: String,
}

#[derive(Deserialize)]
struct CodexOauthTokenResp {
    id_token: String,
    access_token: String,
    refresh_token: String,
}

fn deserialize_interval<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = JsonValue::deserialize(deserializer)?;
    match value {
        JsonValue::Number(number) => number
            .as_u64()
            .ok_or_else(|| serde::de::Error::custom("interval number is not a valid u64")),
        JsonValue::String(raw) => raw
            .trim()
            .parse::<u64>()
            .map_err(|error| serde::de::Error::custom(format!("invalid interval: {error}"))),
        _ => Err(serde::de::Error::custom("invalid interval value")),
    }
}

fn read_env_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_gemini_oauth_mode(raw: Option<&str>) -> String {
    match raw
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_GEMINI_OAUTH_MODE.to_string())
        .as_str()
    {
        "api" | "gemini_api" | "developer_api" => GEMINI_OAUTH_MODE_API.to_string(),
        "code_assist" | "codeassist" => GEMINI_OAUTH_MODE_CODE_ASSIST.to_string(),
        "code_assist_cli" | "gemini_cli" | "cli" => GEMINI_OAUTH_MODE_CODE_ASSIST_CLI.to_string(),
        _ => DEFAULT_GEMINI_OAUTH_MODE.to_string(),
    }
}

fn resolve_gemini_oauth_mode(query: Option<&DeviceAuthStartQuery>) -> String {
    let requested_mode = query.and_then(|value| {
        value
            .oauth_mode
            .as_deref()
            .or(value.gemini_flow.as_deref())
            .map(str::trim)
            .filter(|candidate| !candidate.is_empty())
    });
    if let Some(mode) = requested_mode {
        return normalize_gemini_oauth_mode(Some(mode));
    }
    normalize_gemini_oauth_mode(read_env_trimmed("GEMINI_OAUTH_MODE").as_deref())
}

fn is_gemini_code_assist_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        GEMINI_OAUTH_MODE_CODE_ASSIST | GEMINI_OAUTH_MODE_CODE_ASSIST_CLI
    )
}

fn resolve_gemini_oauth_client_credentials(
    oauth_mode: &str,
) -> Result<(String, Option<String>), (HttpStatusCode, Json<ApiError>)> {
    if oauth_mode == GEMINI_OAUTH_MODE_CODE_ASSIST_CLI {
        let client_id = read_env_trimmed("GEMINI_OAUTH_CLI_CLIENT_ID")
            .or_else(|| read_env_trimmed("GEMINI_OAUTH_CLIENT_ID"))
            .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_ID"))
            .ok_or_else(|| {
                bad_request(
                    "Gemini Google login is not enabled. Connect Gemini with an API key instead.",
                )
            })?;
        let client_secret = read_env_trimmed("GEMINI_OAUTH_CLI_CLIENT_SECRET")
            .or_else(|| read_env_trimmed("GEMINI_OAUTH_CLIENT_SECRET"))
            .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_SECRET"));
        return Ok((client_id, client_secret));
    }

    let client_id = read_env_trimmed("GEMINI_OAUTH_CLIENT_ID")
        .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_ID"))
        .ok_or_else(|| {
            bad_request(
                "Gemini OAuth is not configured. Set GEMINI_OAUTH_CLIENT_ID (or GOOGLE_OAUTH_CLIENT_ID) in the controller environment.",
            )
        })?;
    let client_secret = read_env_trimmed("GEMINI_OAUTH_CLIENT_SECRET")
        .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_SECRET"));
    Ok((client_id, client_secret))
}

fn resolve_configured_gemini_project_id() -> Option<String> {
    read_env_trimmed("GEMINI_CODE_ASSIST_PROJECT_ID")
        .or_else(|| read_env_trimmed("OPENCODE_GEMINI_PROJECT_ID"))
        .or_else(|| read_env_trimmed("GOOGLE_CLOUD_PROJECT"))
        .or_else(|| read_env_trimmed("GOOGLE_CLOUD_PROJECT_ID"))
}

fn generate_oauth_token(byte_len: usize) -> String {
    let bytes = (0..byte_len)
        .map(|_| rand::random::<u8>())
        .collect::<Vec<_>>();
    BASE64URL.encode(bytes)
}

fn build_pkce_code_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    BASE64URL.encode(digest)
}

fn scope_has_oauth_value(scope: &str, required: &str) -> bool {
    let required = required.trim();
    if required.is_empty() {
        return true;
    }
    scope
        .split_whitespace()
        .any(|candidate| candidate.eq_ignore_ascii_case(required))
}

fn header_value(headers: &HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_gemini_oauth_redirect_uri(headers: &HeaderMap) -> Option<String> {
    if let Some(explicit) = read_env_trimmed("GEMINI_OAUTH_REDIRECT_URI")
        .or_else(|| read_env_trimmed("GOOGLE_OAUTH_REDIRECT_URI"))
    {
        return Some(explicit);
    }

    if let Some(external_base) = read_env_trimmed("CONTROLLER_EXTERNAL_URL") {
        return Some(format!(
            "{}/auth/device/gemini/callback",
            external_base.trim_end_matches('/')
        ));
    }

    let host = header_value(headers, "x-forwarded-host")
        .or_else(|| header_value(headers, "host"))
        .or_else(|| header_value(headers, "x-original-host"))?;
    let protocol = header_value(headers, "x-forwarded-proto")
        .or_else(|| header_value(headers, "x-forwarded-protocol"))
        .or_else(|| {
            if host.starts_with("localhost")
                || host.starts_with("127.")
                || host.starts_with("[::1]")
            {
                Some("http".to_string())
            } else {
                Some("https".to_string())
            }
        })?;

    Some(format!(
        "{}://{}/auth/device/gemini/callback",
        protocol, host
    ))
}

fn build_gemini_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    oauth_state: &str,
    code_challenge: &str,
) -> String {
    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256&state={}",
        GOOGLE_OAUTH_AUTHORIZE_URL,
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(code_challenge),
        urlencoding::encode(oauth_state),
    )
}

fn build_gemini_code_assist_metadata(
    project_id: Option<&str>,
    include_duet_project: bool,
) -> JsonValue {
    let mut metadata = JsonMap::new();
    metadata.insert(
        "ideType".to_string(),
        JsonValue::String("IDE_UNSPECIFIED".to_string()),
    );
    metadata.insert(
        "platform".to_string(),
        JsonValue::String("PLATFORM_UNSPECIFIED".to_string()),
    );
    metadata.insert(
        "pluginType".to_string(),
        JsonValue::String("GEMINI".to_string()),
    );
    if include_duet_project {
        if let Some(project) = project_id.map(str::trim).filter(|value| !value.is_empty()) {
            metadata.insert(
                "duetProject".to_string(),
                JsonValue::String(project.to_string()),
            );
        }
    }
    JsonValue::Object(metadata)
}

fn normalize_gemini_code_assist_project_id(value: Option<&JsonValue>) -> Option<String> {
    let value = value?;
    match value {
        JsonValue::String(project_id) => {
            let trimmed = project_id.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        JsonValue::Object(map) => map
            .get("id")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        _ => None,
    }
}

fn pick_gemini_code_assist_tier_id(allowed_tiers: Option<&[GeminiCodeAssistTier]>) -> String {
    let Some(allowed_tiers) = allowed_tiers else {
        return GEMINI_CODE_ASSIST_LEGACY_TIER_ID.to_string();
    };
    for tier in allowed_tiers {
        if tier.is_default == Some(true) {
            if let Some(id) = tier
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return id.to_string();
            }
        }
    }
    allowed_tiers
        .iter()
        .find_map(|tier| {
            tier.id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| GEMINI_CODE_ASSIST_LEGACY_TIER_ID.to_string())
}

fn build_project_required_error() -> String {
    "Google Gemini requires a Google Cloud project. Set GEMINI_CODE_ASSIST_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) and enable Gemini for Google Cloud API."
        .to_string()
}

async fn load_gemini_code_assist(
    state: &AppState,
    access_token: &str,
    project_id: Option<&str>,
) -> Result<GeminiCodeAssistLoadResponse, String> {
    let mut body_map = JsonMap::new();
    body_map.insert(
        "metadata".to_string(),
        build_gemini_code_assist_metadata(project_id, true),
    );
    if let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) {
        body_map.insert(
            "cloudaicompanionProject".to_string(),
            JsonValue::String(project_id.to_string()),
        );
    }

    let request = state
        .http_client
        .post(format!(
            "{GEMINI_CODE_ASSIST_API_BASE}/v1internal:loadCodeAssist"
        ))
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .header("user-agent", "google-api-nodejs-client/9.15.1")
        .header("x-goog-api-client", "gl-node/22.17.0")
        .header(
            "client-metadata",
            "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
        )
        .bearer_auth(access_token.trim())
        .json(&JsonValue::Object(body_map));

    let response = match timeout(Duration::from_secs(12), request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("Gemini Code Assist request failed: {error}")),
        Err(_) => return Err("Gemini Code Assist request timed out.".to_string()),
    };

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<empty>".to_string());
    if !status.is_success() {
        return Err(format!(
            "Gemini Code Assist load failed ({}): {}",
            status.as_u16(),
            body
        ));
    }

    serde_json::from_str::<GeminiCodeAssistLoadResponse>(&body)
        .map_err(|error| format!("Gemini Code Assist load response invalid: {error}"))
}

async fn onboard_gemini_code_assist(
    state: &AppState,
    access_token: &str,
    tier_id: &str,
    project_id: Option<&str>,
) -> Result<Option<String>, String> {
    let is_free_tier = tier_id.trim() == GEMINI_CODE_ASSIST_FREE_TIER_ID;
    let mut body_map = JsonMap::new();
    body_map.insert(
        "tierId".to_string(),
        JsonValue::String(tier_id.trim().to_string()),
    );
    body_map.insert(
        "metadata".to_string(),
        build_gemini_code_assist_metadata(project_id, !is_free_tier),
    );
    if !is_free_tier {
        if let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) {
            body_map.insert(
                "cloudaicompanionProject".to_string(),
                JsonValue::String(project_id.to_string()),
            );
        }
    }

    let request = state
        .http_client
        .post(format!(
            "{GEMINI_CODE_ASSIST_API_BASE}/v1internal:onboardUser"
        ))
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .header("user-agent", "google-api-nodejs-client/9.15.1")
        .header("x-goog-api-client", "gl-node/22.17.0")
        .header(
            "client-metadata",
            "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
        )
        .bearer_auth(access_token.trim())
        .json(&JsonValue::Object(body_map));

    let response = match timeout(Duration::from_secs(12), request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Err(format!(
                "Gemini Code Assist onboard request failed: {error}"
            ))
        }
        Err(_) => return Err("Gemini Code Assist onboard request timed out.".to_string()),
    };
    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<empty>".to_string());
    if !status.is_success() {
        return Err(format!(
            "Gemini Code Assist onboarding failed ({}): {}",
            status.as_u16(),
            body
        ));
    }

    let mut payload: GeminiCodeAssistOnboardResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Gemini Code Assist onboarding response invalid: {error}"))?;

    if payload.done == Some(false) {
        if let Some(operation_name) = payload
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
        {
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let operation_url =
                    format!("{GEMINI_CODE_ASSIST_API_BASE}/v1internal/{operation_name}");
                let operation_request = state
                    .http_client
                    .get(operation_url)
                    .header("accept", "application/json")
                    .header("user-agent", "google-api-nodejs-client/9.15.1")
                    .header("x-goog-api-client", "gl-node/22.17.0")
                    .header(
                        "client-metadata",
                        "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
                    )
                    .bearer_auth(access_token.trim());
                let operation_response =
                    match timeout(Duration::from_secs(12), operation_request.send()).await {
                        Ok(Ok(response)) => response,
                        Ok(Err(error)) => {
                            return Err(format!(
                                "Gemini Code Assist operation poll failed: {error}"
                            ));
                        }
                        Err(_) => {
                            return Err("Gemini Code Assist operation poll timed out.".to_string());
                        }
                    };
                let operation_status = operation_response.status();
                let operation_body = operation_response
                    .text()
                    .await
                    .unwrap_or_else(|_| "<empty>".to_string());
                if !operation_status.is_success() {
                    return Err(format!(
                        "Gemini Code Assist operation failed ({}): {}",
                        operation_status.as_u16(),
                        operation_body
                    ));
                }
                payload = serde_json::from_str::<GeminiCodeAssistOnboardResponse>(&operation_body)
                    .map_err(|error| {
                        format!("Gemini Code Assist operation response invalid: {error}")
                    })?;
                if payload.done == Some(true) {
                    break;
                }
            }
        }
    }

    if payload.done == Some(true) {
        if let Some(project_id) = payload
            .response
            .as_ref()
            .and_then(|response| response.cloudaicompanion_project.as_ref())
            .and_then(|project| project.id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(Some(project_id.to_string()));
        }
        if let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(Some(project_id.to_string()));
        }
    }

    Ok(None)
}

async fn resolve_gemini_code_assist_project(
    state: &AppState,
    access_token: &str,
    configured_project_id: Option<&str>,
    allow_missing_project: bool,
) -> Result<Option<String>, String> {
    let configured_project_id = configured_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let payload =
        load_gemini_code_assist(state, access_token, configured_project_id.as_deref()).await?;

    if let Some(project_id) =
        normalize_gemini_code_assist_project_id(payload.cloudaicompanion_project.as_ref())
    {
        return Ok(Some(project_id));
    }

    if payload
        .current_tier
        .as_ref()
        .and_then(|tier| tier.id.as_ref())
        .is_some()
    {
        if let Some(project_id) = configured_project_id.as_ref() {
            return Ok(Some(project_id.to_string()));
        }

        if let Some(message) = payload.ineligible_tiers.as_deref().and_then(|tiers| {
            let reasons = tiers
                .iter()
                .filter_map(|tier| {
                    tier.reason_message
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| value.to_string())
                })
                .collect::<Vec<_>>();
            if reasons.is_empty() {
                None
            } else {
                Some(reasons.join(", "))
            }
        }) {
            return Err(message);
        }

        return if allow_missing_project {
            Ok(None)
        } else {
            Err(build_project_required_error())
        };
    }

    let tier_id = pick_gemini_code_assist_tier_id(payload.allowed_tiers.as_deref());
    if tier_id != GEMINI_CODE_ASSIST_FREE_TIER_ID && configured_project_id.is_none() {
        if !allow_missing_project {
            return Err(build_project_required_error());
        }
    }

    if let Some(project_id) = onboard_gemini_code_assist(
        state,
        access_token,
        &tier_id,
        configured_project_id.as_deref(),
    )
    .await?
    {
        return Ok(Some(project_id));
    }

    if let Some(project_id) = configured_project_id {
        return Ok(Some(project_id));
    }

    if allow_missing_project {
        Ok(None)
    } else {
        Err(build_project_required_error())
    }
}

async fn exchange_gemini_oauth_code(
    state: &AppState,
    client_id: &str,
    client_secret: Option<&str>,
    code_verifier: &str,
    redirect_uri: &str,
    code: &str,
) -> Result<GeminiOauthTokens, String> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("client_id", client_id.trim().to_string()),
        ("code", code.trim().to_string()),
        ("redirect_uri", redirect_uri.trim().to_string()),
        ("code_verifier", code_verifier.trim().to_string()),
    ];
    if let Some(secret) = client_secret
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form.push(("client_secret", secret.to_string()));
    }

    let request = state
        .http_client
        .post(GOOGLE_OAUTH_TOKEN_URL)
        .header("accept", "application/json")
        .form(&form);

    let response = match timeout(Duration::from_secs(12), request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("Gemini OAuth token exchange failed: {error}")),
        Err(_) => return Err("Gemini OAuth token exchange timed out.".to_string()),
    };

    let status = response.status();
    let payload = response
        .json::<GeminiOauthTokenResponse>()
        .await
        .map_err(|error| format!("Gemini OAuth token response invalid: {error}"))?;

    if !status.is_success() {
        let message = payload
            .error_description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                payload
                    .error
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or("OAuth token exchange failed");
        return Err(format!("Gemini OAuth token exchange failed: {message}"));
    }

    let access_token = payload
        .access_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Gemini OAuth token exchange returned no access_token.".to_string())?
        .to_string();

    Ok(GeminiOauthTokens {
        access_token,
        refresh_token: payload
            .refresh_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        scope: payload
            .scope
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        token_type: payload
            .token_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string()),
        expires_in: payload.expires_in,
        expires_at: payload
            .expires_in
            .and_then(|seconds| i64::try_from(seconds).ok())
            .map(|seconds| Utc::now() + chrono::Duration::seconds(seconds)),
    })
}

fn build_gemini_oauth_auth_json(
    tokens: &GeminiOauthTokens,
    scope: &str,
    oauth_mode: &str,
    code_assist_project_id: Option<&str>,
) -> JsonValue {
    let mut token_map = JsonMap::new();
    token_map.insert(
        "access_token".to_string(),
        JsonValue::String(tokens.access_token.clone()),
    );
    if let Some(refresh_token) = tokens.refresh_token.as_ref() {
        token_map.insert(
            "refresh_token".to_string(),
            JsonValue::String(refresh_token.clone()),
        );
    }
    if let Some(expires_in) = tokens.expires_in {
        token_map.insert(
            "expires_in".to_string(),
            JsonValue::Number(serde_json::Number::from(expires_in)),
        );
    }
    if let Some(token_type) = tokens.token_type.as_ref() {
        token_map.insert(
            "token_type".to_string(),
            JsonValue::String(token_type.clone()),
        );
    }
    if let Some(expires_at) = tokens.expires_at.as_ref() {
        token_map.insert(
            "expires_at".to_string(),
            JsonValue::String(expires_at.to_rfc3339()),
        );
    }
    if let Some(project_id) = code_assist_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        token_map.insert(
            "code_assist_project".to_string(),
            JsonValue::String(project_id.to_string()),
        );
    }

    json!({
        "OPENAI_API_KEY": tokens.access_token.clone(),
        "tokens": token_map,
        "scope": scope,
        "gemini_oauth_mode": oauth_mode,
    })
}

fn build_gemini_oauth_metadata(
    tokens: &GeminiOauthTokens,
    scope: &str,
    oauth_mode: &str,
    code_assist_project_id: Option<&str>,
) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert(
        "source".to_string(),
        JsonValue::String("google_oauth".to_string()),
    );
    map.insert(
        "provider".to_string(),
        JsonValue::String("gemini".to_string()),
    );
    map.insert(
        "auth_mode".to_string(),
        JsonValue::String(oauth_mode.to_string()),
    );
    map.insert(
        "upstream_endpoint".to_string(),
        JsonValue::String(
            if is_gemini_code_assist_mode(oauth_mode) {
                GEMINI_CODE_ASSIST_API_BASE
            } else {
                DEFAULT_GEMINI_ENDPOINT
            }
            .to_string(),
        ),
    );
    map.insert(
        "default_model".to_string(),
        JsonValue::String(DEFAULT_GEMINI_MODEL.to_string()),
    );
    map.insert("scope".to_string(), JsonValue::String(scope.to_string()));
    if let Some(token_type) = tokens.token_type.as_ref() {
        map.insert(
            "token_type".to_string(),
            JsonValue::String(token_type.clone()),
        );
    }
    if let Some(expires_in) = tokens.expires_in {
        map.insert(
            "expires_in".to_string(),
            JsonValue::Number(serde_json::Number::from(expires_in)),
        );
    }
    if let Some(expires_at) = tokens.expires_at.as_ref() {
        map.insert(
            "expires_at".to_string(),
            JsonValue::String(expires_at.to_rfc3339()),
        );
    }
    if let Some(project_id) = code_assist_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        map.insert(
            "code_assist_project".to_string(),
            JsonValue::String(project_id.to_string()),
        );
    }
    JsonValue::Object(map)
}

async fn request_codex_user_code(
    state: &AppState,
    issuer: &str,
    client_id: &str,
) -> Result<CodexUserCodeResp, (HttpStatusCode, Json<ApiError>)> {
    let issuer = issuer.trim_end_matches('/');
    let url = format!("{issuer}/api/accounts/deviceauth/usercode");
    let request = state
        .http_client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&CodexUserCodeReq {
            client_id: client_id.to_string(),
        });
    let response = timeout(Duration::from_secs(8), request.send())
        .await
        .map_err(|_| internal_error("device auth request timed out"))?
        .map_err(|error| internal_error(format!("device auth request failed: {error}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(bad_request(CODEX_DEVICE_AUTH_FORBIDDEN_MESSAGE));
    }
    if !status.is_success() {
        return Err(internal_error(format!(
            "device auth returned {}",
            status.as_u16()
        )));
    }
    response
        .json::<CodexUserCodeResp>()
        .await
        .map_err(|error| internal_error(format!("device auth response invalid: {error}")))
}

async fn poll_codex_device_auth(state: AppState, session_id: Uuid) {
    let Some(session) = state.device_auth_sessions.get(&session_id).await else {
        return;
    };

    let (issuer, client_id, device_auth_id) = match session.provider_state.clone() {
        DeviceAuthProviderState::Codex {
            issuer,
            client_id,
            device_auth_id,
        } => (issuer, client_id, device_auth_id),
        _ => return,
    };

    let mut interval = Duration::from_secs(session.poll_interval_seconds.max(1));
    let deadline = session.expires_at;

    loop {
        let Some(latest) = state.device_auth_sessions.get(&session_id).await else {
            return;
        };
        match latest.status {
            DeviceAuthStatus::Pending => {}
            _ => return,
        }

        if Utc::now() >= deadline {
            let _ = state
                .device_auth_sessions
                .update_status(
                    &session_id,
                    DeviceAuthStatus::Failed {
                        error: "Device login timed out.".to_string(),
                    },
                )
                .await;
            return;
        }

        match poll_codex_token(&state, &issuer, &device_auth_id, &session.user_code).await {
            Ok(Some(code)) => {
                match exchange_codex_code_for_tokens(&state, &issuer, &client_id, &code).await {
                    Ok(tokens) => {
                        let account_id = extract_chatgpt_account_id(&tokens.id_token);
                        let auth_json = build_codex_auth_json(tokens, account_id.as_deref());
                        let metadata = build_codex_metadata("device_code", account_id.as_deref());

                        let result = credentials::insert_user_credential(
                            &state,
                            session.user_id,
                            "codex_auth_json".to_string(),
                            metadata,
                            auth_json,
                            Some("ChatGPT".to_string()),
                            None,
                        )
                        .await;

                        match result {
                            Ok(created) => {
                                let _ = state
                                    .device_auth_sessions
                                    .update_status(
                                        &session_id,
                                        DeviceAuthStatus::Completed {
                                            credential_id: Some(created.credential_id),
                                        },
                                    )
                                    .await;
                                let mut guard = state.device_auth_sessions.inner.write().await;
                                if let Some(entry) = guard.get_mut(&session_id) {
                                    entry.completed_at = Some(Utc::now());
                                }
                                return;
                            }
                            Err((_, error)) => {
                                let message = error.0.message.clone();
                                let _ = state
                                    .device_auth_sessions
                                    .update_status(
                                        &session_id,
                                        DeviceAuthStatus::Failed { error: message },
                                    )
                                    .await;
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = state
                            .device_auth_sessions
                            .update_status(&session_id, DeviceAuthStatus::Failed { error })
                            .await;
                        return;
                    }
                }
            }
            Ok(None) => {
                // Keep polling.
            }
            Err(error) => {
                let _ = state
                    .device_auth_sessions
                    .update_status(&session_id, DeviceAuthStatus::Failed { error })
                    .await;
                return;
            }
        }

        tokio::time::sleep(interval).await;
        if interval < Duration::from_secs(10) {
            interval = Duration::from_secs(10);
        }
    }
}

#[derive(Deserialize)]
struct GithubDeviceCodeResp {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    expires_in: u64,
    #[serde(default, deserialize_with = "deserialize_interval")]
    interval: u64,
}

async fn request_github_device_code(
    state: &AppState,
    client_id: &str,
    scope: &str,
) -> Result<GithubDeviceCodeResp, (HttpStatusCode, Json<ApiError>)> {
    let request = state
        .http_client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.trim()), ("scope", scope.trim())]);

    let (status, body) = timeout(Duration::from_secs(8), async {
        let response = request
            .send()
            .await
            .map_err(|error| format!("GitHub device auth request failed: {error}"))?;
        read_github_device_auth_response(response).await
    })
    .await
    .map_err(|_| internal_error("GitHub device auth request timed out"))?
    .map_err(internal_error)?;

    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        return Err(bad_request(format!(
            "GitHub device auth request failed ({}): {}",
            status.as_u16(),
            text
        )));
    }

    serde_json::from_slice::<GithubDeviceCodeResp>(&body)
        .map_err(|error| internal_error(format!("GitHub device auth response invalid: {error}")))
}

async fn read_github_device_auth_response(
    response: reqwest::Response,
) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let status = response.status();
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("GitHub response failed: {error}"))?;
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "GitHub response is too large".to_string())?;
        if next_len > GITHUB_DEVICE_AUTH_RESPONSE_MAX_BYTES {
            return Err(format!(
                "GitHub response exceeds {GITHUB_DEVICE_AUTH_RESPONSE_MAX_BYTES} bytes"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

enum GithubTokenPollOutcome {
    Pending,
    SlowDown,
    Completed {
        access_token: String,
        scope: Option<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum GithubTokenPollError {
    Retryable(String),
    Terminal(String),
}

fn github_token_poll_http_error(status: reqwest::StatusCode) -> GithubTokenPollError {
    let message = format!(
        "GitHub device auth poll failed with status {}",
        status.as_u16()
    );
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        GithubTokenPollError::Retryable(message)
    } else {
        GithubTokenPollError::Terminal(message)
    }
}

#[derive(Deserialize)]
struct GithubTokenPollResp {
    access_token: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn poll_github_token(
    state: &AppState,
    client_id: &str,
    device_code: &str,
) -> Result<GithubTokenPollOutcome, GithubTokenPollError> {
    let request = state
        .http_client
        .post(GITHUB_DEVICE_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.trim()),
            ("device_code", device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ]);

    let (status, body) = match timeout(Duration::from_secs(8), async {
        let response = request
            .send()
            .await
            .map_err(|error| format!("GitHub device auth poll failed: {error}"))?;
        read_github_device_auth_response(response).await
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Err(GithubTokenPollError::Retryable(error));
        }
        Err(_) => {
            return Err(GithubTokenPollError::Retryable(
                "GitHub device auth poll timed out".to_string(),
            ))
        }
    };

    if !status.is_success() {
        return Err(github_token_poll_http_error(status));
    }

    let payload = serde_json::from_slice::<GithubTokenPollResp>(&body).map_err(|error| {
        GithubTokenPollError::Retryable(format!(
            "GitHub device auth poll response invalid: {error}"
        ))
    })?;

    if let Some(token) = payload
        .access_token
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(GithubTokenPollOutcome::Completed {
            access_token: token,
            scope: payload
                .scope
                .as_deref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        });
    }

    let Some(error_code) = payload
        .error
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Err(GithubTokenPollError::Retryable(
            "GitHub device auth poll response missing error/access_token".to_string(),
        ));
    };

    match error_code.as_str() {
        "authorization_pending" => Ok(GithubTokenPollOutcome::Pending),
        "slow_down" => Ok(GithubTokenPollOutcome::SlowDown),
        "expired_token" => Err(GithubTokenPollError::Terminal(
            "GitHub device login expired. Try again.".to_string(),
        )),
        "access_denied" => Err(GithubTokenPollError::Terminal(
            "GitHub device login was denied.".to_string(),
        )),
        _ => Err(GithubTokenPollError::Terminal(
            payload
                .error_description
                .unwrap_or_else(|| format!("GitHub device auth failed: {error_code}")),
        )),
    }
}

async fn sync_local_github_device_auth_session_from_database(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<(), (HttpStatusCode, Json<ApiError>)> {
    let record = load_github_device_auth_session_record(state, user_id, session_id).await?;
    let Some(record) = record else {
        state
            .device_auth_sessions
            .inner
            .write()
            .await
            .remove(&session_id);
        return Ok(());
    };

    match record.status.as_str() {
        "pending" => {}
        "completed" => {
            // Another executor completed the canonical row. Drop the tokenless
            // local mirror so imports resolve the encrypted per-session token.
            state
                .device_auth_sessions
                .inner
                .write()
                .await
                .remove(&session_id);
        }
        "cancelled" => {
            let _ = state
                .device_auth_sessions
                .cancel(&session_id, &user_id)
                .await;
        }
        "failed" => {
            let error = record
                .error_message
                .unwrap_or_else(|| "GitHub device login failed.".to_string());
            let _ = state
                .device_auth_sessions
                .update_status(&session_id, DeviceAuthStatus::Failed { error })
                .await;
        }
        _ => {
            state
                .device_auth_sessions
                .inner
                .write()
                .await
                .remove(&session_id);
            return Err(internal_error(
                "GitHub device auth session status is invalid",
            ));
        }
    }
    Ok(())
}

async fn poll_github_device_auth(state: AppState, session_id: Uuid) {
    let Some(session) = state.device_auth_sessions.get(&session_id).await else {
        return;
    };

    let user_id = session.user_id;
    let (client_id, device_code) = match session.provider_state.clone() {
        DeviceAuthProviderState::Github {
            client_id,
            device_code,
            ..
        } => (client_id, device_code),
        _ => return,
    };

    let mut interval = Duration::from_secs(
        session
            .poll_interval_seconds
            .clamp(1, GITHUB_DEVICE_AUTH_MAX_POLL_INTERVAL_SECONDS),
    );
    let shutdown_deadline = session.expires_at
        + chrono::Duration::seconds(GITHUB_DEVICE_AUTH_POLL_SHUTDOWN_GRACE_SECONDS);
    let mut completed_token: Option<(String, Option<String>)> = None;
    let mut pending_failure: Option<String> = None;

    loop {
        if Utc::now() >= shutdown_deadline {
            let error_message = GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE.to_string();
            if let Err((status, _)) =
                fail_github_device_auth_session(&state, user_id, session_id, &error_message).await
            {
                tracing::warn!(
                    http_status = %status,
                    session_id = %session_id,
                    user_id = %user_id,
                    "GitHub device auth poller reached its hard deadline before persisting failure"
                );
            }
            let _ = state
                .device_auth_sessions
                .update_status(
                    &session_id,
                    DeviceAuthStatus::Failed {
                        error: error_message,
                    },
                )
                .await;
            return;
        }

        match renew_github_device_auth_poll_lease(&state, user_id, session_id).await {
            Ok(true) => {}
            Ok(false) => {
                let _ = sync_local_github_device_auth_session_from_database(
                    &state, user_id, session_id,
                )
                .await;
                return;
            }
            Err((status, _)) => {
                tracing::warn!(
                    http_status = %status,
                    session_id = %session_id,
                    user_id = %user_id,
                    "failed to renew GitHub device auth poll lease"
                );
                tokio::time::sleep(interval).await;
                continue;
            }
        }

        let record = match load_github_device_auth_session_record(&state, user_id, session_id).await
        {
            Ok(Some(record)) => record,
            Ok(None) => {
                state
                    .device_auth_sessions
                    .inner
                    .write()
                    .await
                    .remove(&session_id);
                return;
            }
            Err((status, _)) => {
                tracing::warn!(
                    http_status = %status,
                    session_id = %session_id,
                    user_id = %user_id,
                    "failed to load canonical GitHub device auth session"
                );
                tokio::time::sleep(interval).await;
                continue;
            }
        };
        match record.status.as_str() {
            "pending" => {}
            "completed" | "failed" | "cancelled" => {
                if let Err((status, _)) =
                    sync_local_github_device_auth_session_from_database(&state, user_id, session_id)
                        .await
                {
                    tracing::warn!(
                        http_status = %status,
                        session_id = %session_id,
                        user_id = %user_id,
                        "failed to synchronize terminal GitHub device auth session"
                    );
                }
                return;
            }
            _ => {
                state
                    .device_auth_sessions
                    .inner
                    .write()
                    .await
                    .remove(&session_id);
                return;
            }
        }

        if Utc::now() >= record.device_expires_at && pending_failure.is_none() {
            pending_failure = Some(GITHUB_DEVICE_AUTH_TIMED_OUT_MESSAGE.to_string());
        }

        if let Some(error_message) = pending_failure.take() {
            match fail_github_device_auth_session(&state, user_id, session_id, &error_message).await
            {
                Ok(true) => {
                    let _ = state
                        .device_auth_sessions
                        .update_status(
                            &session_id,
                            DeviceAuthStatus::Failed {
                                error: error_message,
                            },
                        )
                        .await;
                    return;
                }
                Ok(false) => {
                    let _ = sync_local_github_device_auth_session_from_database(
                        &state, user_id, session_id,
                    )
                    .await;
                    return;
                }
                Err((status, _)) => {
                    tracing::warn!(
                        http_status = %status,
                        session_id = %session_id,
                        user_id = %user_id,
                        "failed to persist terminal GitHub device auth failure"
                    );
                    pending_failure = Some(error_message);
                    tokio::time::sleep(interval).await;
                    continue;
                }
            }
        }

        if let Some((access_token, scope)) = completed_token.take() {
            match complete_github_device_auth_session(
                &state,
                user_id,
                session_id,
                &access_token,
                scope.as_deref(),
            )
            .await
            {
                Ok(GithubDeviceAuthCompletionOutcome::Completed { completed_at }) => {
                    let mut guard = state.device_auth_sessions.inner.write().await;
                    if let Some(entry) = guard.get_mut(&session_id) {
                        entry.status = DeviceAuthStatus::Completed {
                            credential_id: None,
                        };
                        entry.completed_at = Some(completed_at);
                        if let DeviceAuthProviderState::Github {
                            access_token: stored,
                            scope: stored_scope,
                            ..
                        } = &mut entry.provider_state
                        {
                            *stored = Some(access_token);
                            *stored_scope = scope;
                        }
                    }
                    return;
                }
                Ok(
                    GithubDeviceAuthCompletionOutcome::AlreadyTerminal
                    | GithubDeviceAuthCompletionOutcome::Expired,
                ) => {
                    let _ = sync_local_github_device_auth_session_from_database(
                        &state, user_id, session_id,
                    )
                    .await;
                    return;
                }
                Err((status, _)) => {
                    tracing::warn!(
                        http_status = %status,
                        session_id = %session_id,
                        user_id = %user_id,
                        "failed to persist completed GitHub device auth session"
                    );
                    completed_token = Some((access_token, scope));
                    tokio::time::sleep(interval).await;
                    continue;
                }
            }
        }

        match poll_github_token(&state, &client_id, &device_code).await {
            Ok(GithubTokenPollOutcome::Completed {
                access_token,
                scope,
            }) => {
                completed_token = Some((access_token, scope));
                continue;
            }
            Ok(GithubTokenPollOutcome::SlowDown) => {
                interval = interval.saturating_add(Duration::from_secs(5));
            }
            Ok(GithubTokenPollOutcome::Pending) => {
                // keep polling
            }
            Err(GithubTokenPollError::Terminal(error)) => {
                pending_failure = Some(error);
                continue;
            }
            Err(GithubTokenPollError::Retryable(error)) => {
                tracing::warn!(
                    session_id = %session_id,
                    user_id = %user_id,
                    error = %error,
                    "transient GitHub device auth poll failure"
                );
                interval = interval.saturating_add(Duration::from_secs(5));
            }
        }

        if interval < Duration::from_secs(5) {
            interval = Duration::from_secs(5);
        }
        if interval > Duration::from_secs(30) {
            interval = Duration::from_secs(30);
        }
        tokio::time::sleep(interval).await;
    }
}

fn decrypt_oauth_access_token_payload(
    key: &CredentialEncryptionKey,
    nonce_b64: &str,
    ciphertext_b64: &str,
    expected_device_auth_session_id: Option<Uuid>,
) -> Result<Option<String>, (HttpStatusCode, Json<ApiError>)> {
    let plaintext = decrypt_secret_payload(key, nonce_b64, ciphertext_b64).map_err(|error| {
        internal_error(format!("failed to decrypt oauth token payload: {error}"))
    })?;
    let parsed: JsonValue = serde_json::from_slice(&plaintext).map_err(|error| {
        internal_error(format!("oauth token payload is not valid JSON: {error}"))
    })?;

    if let Some(expected_session_id) = expected_device_auth_session_id {
        let stored_session_id = parsed
            .get("device_auth_session_id")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok());
        let stored_session_expires_at = parsed
            .get("device_auth_session_expires_at")
            .and_then(JsonValue::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value.trim()).ok())
            .map(|value| value.with_timezone(&Utc));
        if stored_session_id != Some(expected_session_id)
            || stored_session_expires_at
                .map(|expires_at| expires_at <= Utc::now())
                .unwrap_or(true)
        {
            return Ok(None);
        }
    }

    Ok(parsed
        .get("access_token")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

async fn load_user_oauth_access_token_for_session(
    state: &AppState,
    user_id: Uuid,
    provider: &str,
    expected_device_auth_session_id: Option<Uuid>,
) -> Result<Option<String>, (HttpStatusCode, Json<ApiError>)> {
    let provider = provider.trim().to_ascii_lowercase();
    if provider.is_empty() {
        return Ok(None);
    }

    let Some(key) = state.config.credential_encryption_key.as_ref() else {
        return Ok(None);
    };

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    ensure_user_oauth_tokens_storage_ready(&*connection).await?;

    let row = connection
        .query_opt(
            "select nonce_b64, ciphertext_b64 from user_oauth_tokens where user_id = $1 and provider = $2 and revoked_at is null limit 1",
            &[&user_id, &provider],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load oauth token: {error}")))?;

    let Some(row) = row else {
        return Ok(None);
    };

    let nonce_b64: String = row.get("nonce_b64");
    let ciphertext_b64: String = row.get("ciphertext_b64");
    let access_token = decrypt_oauth_access_token_payload(
        key,
        &nonce_b64,
        &ciphertext_b64,
        expected_device_auth_session_id,
    )?;

    if access_token.is_some() {
        let _ = connection
            .execute(
                "update user_oauth_tokens set last_used_at = now(), updated_at = now() where user_id = $1 and provider = $2",
                &[&user_id, &provider],
            )
            .await;
    }

    Ok(access_token)
}

pub(crate) async fn resolve_github_device_auth_session(
    state: &AppState,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<GithubDeviceAuthSessionResolution, (HttpStatusCode, Json<ApiError>)> {
    let record = load_github_device_auth_session_record(state, user_id, session_id).await?;
    let Some(record) = record else {
        return load_user_oauth_access_token_for_session(
            state,
            user_id,
            USER_OAUTH_TOKEN_PROVIDER_GITHUB,
            Some(session_id),
        )
        .await
        .map(|token| match token {
            Some(access_token) => GithubDeviceAuthSessionResolution::Completed { access_token },
            None => GithubDeviceAuthSessionResolution::NotFoundOrExpired,
        });
    };

    match record.status.as_str() {
        "pending" => Ok(GithubDeviceAuthSessionResolution::Pending),
        "cancelled" => Ok(GithubDeviceAuthSessionResolution::Cancelled),
        "failed" => Ok(GithubDeviceAuthSessionResolution::Failed {
            error: record
                .error_message
                .unwrap_or_else(|| "GitHub device login failed.".to_string()),
        }),
        "completed" => {
            if record
                .assertion_expires_at
                .map(|expires_at| expires_at <= Utc::now())
                .unwrap_or(true)
            {
                return Ok(GithubDeviceAuthSessionResolution::NotFoundOrExpired);
            }
            let key = state
                .config
                .credential_encryption_key
                .as_ref()
                .ok_or_else(|| {
                    github_device_auth_service_unavailable(
                        GITHUB_DEVICE_AUTH_STORAGE_UNAVAILABLE_MESSAGE,
                    )
                })?;
            let nonce_b64 = record.token_nonce_b64.ok_or_else(|| {
                internal_error("GitHub device auth session is missing its encrypted token")
            })?;
            let ciphertext_b64 = record.token_ciphertext_b64.ok_or_else(|| {
                internal_error("GitHub device auth session is missing its encrypted token")
            })?;
            let access_token = decrypt_oauth_access_token_payload(
                key,
                &nonce_b64,
                &ciphertext_b64,
                Some(session_id),
            )?
            .ok_or_else(|| internal_error("GitHub device auth session token binding is invalid"))?;
            Ok(GithubDeviceAuthSessionResolution::Completed { access_token })
        }
        _ => Err(internal_error(
            "GitHub device auth session status is invalid",
        )),
    }
}

pub(crate) async fn load_user_oauth_access_token(
    state: &AppState,
    user_id: Uuid,
    provider: &str,
) -> Result<Option<String>, (HttpStatusCode, Json<ApiError>)> {
    load_user_oauth_access_token_for_session(state, user_id, provider, None).await
}

pub(crate) async fn load_user_github_access_token(
    state: &AppState,
    user_id: Uuid,
) -> Result<Option<String>, (HttpStatusCode, Json<ApiError>)> {
    load_user_oauth_access_token(state, user_id, USER_OAUTH_TOKEN_PROVIDER_GITHUB).await
}

fn prepare_oauth_token(
    key: &CredentialEncryptionKey,
    access_token: &str,
    scope: Option<&str>,
    source_session: Option<(Uuid, DateTime<Utc>)>,
) -> Result<PreparedOauthToken, (HttpStatusCode, Json<ApiError>)> {
    let scope = scope
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let (source_session_id, source_session_expires_at) = source_session
        .map(|(session_id, expires_at)| {
            (Some(session_id.to_string()), Some(expires_at.to_rfc3339()))
        })
        .unwrap_or((None, None));
    let payload = json!({
        "access_token": access_token,
        "scope": scope,
        "device_auth_session_id": source_session_id,
        "device_auth_session_expires_at": source_session_expires_at,
    });
    let plaintext = serde_json::to_vec(&payload).map_err(|error| {
        internal_error(format!("failed to encode oauth token payload: {error}"))
    })?;
    let (nonce_b64, ciphertext_b64) = encrypt_secret_payload(key, &plaintext).map_err(|error| {
        internal_error(format!("failed to encrypt oauth token payload: {error}"))
    })?;

    Ok(PreparedOauthToken {
        nonce_b64,
        ciphertext_b64,
        scope,
    })
}

async fn upsert_prepared_user_oauth_access_token(
    client: &impl GenericClient,
    user_id: Uuid,
    provider: &str,
    prepared: &PreparedOauthToken,
) -> Result<u64, tokio_postgres::Error> {
    let scope = prepared.scope.as_deref();
    client
        .execute(
            "insert into user_oauth_tokens (user_id, provider, nonce_b64, ciphertext_b64, scope, last_used_at, revoked_at)
             values ($1, $2, $3, $4, $5, now(), null)
             on conflict (user_id, provider) do update set
               nonce_b64 = excluded.nonce_b64,
               ciphertext_b64 = excluded.ciphertext_b64,
               scope = excluded.scope,
               last_used_at = now(),
               revoked_at = null,
               updated_at = now()",
            &[
                &user_id,
                &provider,
                &prepared.nonce_b64,
                &prepared.ciphertext_b64,
                &scope,
            ],
        )
        .await
}

async fn upsert_user_oauth_access_token(
    state: &AppState,
    user_id: Uuid,
    provider: &str,
    access_token: &str,
    scope: Option<&str>,
    source_session: Option<(Uuid, DateTime<Utc>)>,
) -> Result<(), (HttpStatusCode, Json<ApiError>)> {
    let Some(key) = state.config.credential_encryption_key.as_ref() else {
        return Ok(());
    };

    let provider = provider.trim().to_ascii_lowercase();
    if provider.is_empty() {
        return Ok(());
    }
    let prepared = prepare_oauth_token(key, access_token, scope, source_session)?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    ensure_user_oauth_tokens_storage_ready(&*connection).await?;
    upsert_prepared_user_oauth_access_token(&*connection, user_id, &provider, &prepared)
        .await
        .map_err(|error| internal_error(format!("failed to upsert oauth token: {error}")))?;
    Ok(())
}

async fn ensure_user_oauth_tokens_storage_ready(
    client: &impl GenericClient,
) -> Result<(), (HttpStatusCode, Json<ApiError>)> {
    let ready = client
        .query_one(
            "select to_regclass('public.user_oauth_tokens') is not null as ready",
            &[],
        )
        .await
        .map_err(|error| internal_error(format!("failed to inspect OAuth token storage: {error}")))?
        .get::<_, bool>("ready");
    if !ready {
        return Err(oauth_token_storage_unavailable());
    }
    Ok(())
}

fn encrypt_secret_payload(
    key: &CredentialEncryptionKey,
    plaintext: &[u8],
) -> anyhow::Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes())?;
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce_bytes, plaintext)
        .map_err(|error| anyhow::anyhow!("failed to encrypt oauth payload: {error:?}"))?;
    Ok((
        BASE64.encode(nonce_bytes.as_slice()),
        BASE64.encode(ciphertext),
    ))
}

fn decrypt_secret_payload(
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
        .map_err(|error| anyhow::anyhow!("failed to decrypt oauth payload: {error:?}"))?;
    Ok(plaintext)
}

async fn poll_codex_token(
    state: &AppState,
    issuer: &str,
    device_auth_id: &str,
    user_code: &str,
) -> Result<Option<CodexTokenPollResp>, String> {
    let issuer = issuer.trim_end_matches('/');
    let url = format!("{issuer}/api/accounts/deviceauth/token");
    let request = state
        .http_client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&CodexTokenPollReq {
            device_auth_id: device_auth_id.to_string(),
            user_code: user_code.to_string(),
        });

    let response = match timeout(Duration::from_secs(8), request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("device auth poll failed: {error}")),
        Err(_) => return Err("device auth poll timed out".to_string()),
    };

    let status = response.status();
    if status.is_success() {
        let payload = response
            .json::<JsonValue>()
            .await
            .map_err(|error| format!("device auth poll response invalid: {error}"))?;

        let authorization_code =
            extract_json_string(&payload, &["authorization_code", "authorizationCode"]);
        let code_verifier = extract_json_string(&payload, &["code_verifier", "codeVerifier"]);

        if let (Some(authorization_code), Some(code_verifier)) = (authorization_code, code_verifier)
        {
            return Ok(Some(CodexTokenPollResp {
                authorization_code,
                code_verifier,
            }));
        }

        let error_code = extract_json_string(&payload, &["error", "error_code", "code"]);
        if matches!(
            error_code.as_deref(),
            Some("authorization_pending" | "pending" | "not_found" | "not_ready")
        ) {
            return Ok(None);
        }

        let keys = payload
            .as_object()
            .map(|obj| {
                let mut keys = obj.keys().cloned().collect::<Vec<_>>();
                keys.sort();
                keys.join(", ")
            })
            .unwrap_or_else(|| payload.to_string());

        return Err(format!(
            "device auth poll response invalid: missing authorization_code/code_verifier (keys: {keys})"
        ));
    }

    codex_poll_http_error(status)
}

fn codex_poll_http_error(
    status: reqwest::StatusCode,
) -> Result<Option<CodexTokenPollResp>, String> {
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(CODEX_DEVICE_AUTH_FORBIDDEN_MESSAGE.to_string());
    }

    Err(format!(
        "device auth failed with status {}",
        status.as_u16()
    ))
}

fn extract_json_string(payload: &JsonValue, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(JsonValue::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

async fn exchange_codex_code_for_tokens(
    state: &AppState,
    issuer: &str,
    client_id: &str,
    code: &CodexTokenPollResp,
) -> Result<CodexOauthTokenResp, String> {
    let issuer = issuer.trim_end_matches('/');
    let url = format!("{issuer}/oauth/token");
    let redirect_uri = format!("{issuer}/deviceauth/callback");
    let body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
        urlencoding::encode(&code.authorization_code),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(client_id),
        urlencoding::encode(&code.code_verifier),
    );

    let request = state
        .http_client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body);
    let response = match timeout(Duration::from_secs(12), request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return Err(format!("token exchange request failed: {error}")),
        Err(_) => return Err("token exchange request timed out".to_string()),
    };

    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "token exchange failed with status {}",
            status.as_u16()
        ));
    }

    response
        .json::<CodexOauthTokenResp>()
        .await
        .map_err(|error| format!("token exchange response invalid: {error}"))
}

fn extract_chatgpt_account_id(id_token: &str) -> Option<String> {
    let payload_b64 = id_token.split('.').nth(1)?;
    let decoded = BASE64URL.decode(payload_b64.as_bytes()).ok()?;
    let json: JsonValue = serde_json::from_slice(&decoded).ok()?;
    json.get("chatgpt_account_id")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_codex_auth_json(tokens: CodexOauthTokenResp, account_id: Option<&str>) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert("id_token".to_string(), JsonValue::String(tokens.id_token));
    map.insert(
        "access_token".to_string(),
        JsonValue::String(tokens.access_token),
    );
    map.insert(
        "refresh_token".to_string(),
        JsonValue::String(tokens.refresh_token),
    );
    if let Some(account_id) = account_id {
        map.insert(
            "account_id".to_string(),
            JsonValue::String(account_id.to_string()),
        );
    }
    json!({
        "last_refresh": Utc::now().to_rfc3339(),
        "tokens": JsonValue::Object(map)
    })
}

fn build_codex_metadata(source: &str, account_id: Option<&str>) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert("source".to_string(), JsonValue::String(source.to_string()));
    if let Some(account_id) = account_id {
        map.insert(
            "account_id".to_string(),
            JsonValue::String(account_id.to_string()),
        );
    }
    JsonValue::Object(map)
}

#[cfg(test)]
mod device_auth_session_tests {
    use std::collections::HashMap;

    use bb8::Pool;
    use bb8_postgres::PostgresConnectionManager;
    use chrono::{Duration as ChronoDuration, Utc};
    use tokio_postgres::NoTls;
    use uuid::Uuid;

    use super::{
        codex_poll_http_error, github_device_auth_assertion_expires_at,
        github_device_auth_completion_outcome, github_device_auth_expires_at,
        github_device_auth_poll_interval, github_token_poll_http_error, prune_sessions,
        release_github_device_auth_start, reserve_github_device_auth_start,
        DeviceAuthProviderState, DeviceAuthRegistry, DeviceAuthSession, DeviceAuthStatus,
        GithubDeviceAuthCompletionOutcome, GithubDeviceAuthStartReservation, GithubTokenPollError,
        GITHUB_DEVICE_AUTH_ASSERTION_TTL_MINUTES, GITHUB_DEVICE_AUTH_INTERRUPTED_MESSAGE,
        GITHUB_DEVICE_AUTH_MAX_LIFETIME_SECONDS, GITHUB_DEVICE_AUTH_MAX_POLL_INTERVAL_SECONDS,
    };

    fn test_session(
        session_id: Uuid,
        user_id: Uuid,
        expires_at: chrono::DateTime<Utc>,
        status: DeviceAuthStatus,
        completed_at: Option<chrono::DateTime<Utc>>,
    ) -> DeviceAuthSession {
        DeviceAuthSession {
            session_id,
            user_id,
            provider: "codex".to_string(),
            verification_url: "https://auth.openai.com/codex/device".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            poll_interval_seconds: 5,
            expires_at,
            status,
            completed_at,
            provider_state: DeviceAuthProviderState::Codex {
                issuer: "https://auth.openai.com".to_string(),
                client_id: "test-client".to_string(),
                device_auth_id: "test-device-auth".to_string(),
            },
        }
    }

    #[test]
    fn expired_pending_session_becomes_observable_failure() {
        let before_prune = Utc::now();
        let session_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let mut sessions = HashMap::from([(
            session_id,
            test_session(
                session_id,
                user_id,
                before_prune - ChronoDuration::seconds(1),
                DeviceAuthStatus::Pending,
                None,
            ),
        )]);

        prune_sessions(&mut sessions);

        let session = sessions
            .get(&session_id)
            .expect("expired session should be retained as a terminal result");
        assert!(matches!(
            &session.status,
            DeviceAuthStatus::Failed { error } if error == "Device login timed out."
        ));
        assert!(session.completed_at.is_some_and(|at| at >= before_prune));
    }

    #[test]
    fn terminal_sessions_are_retained_for_thirty_minutes() {
        let now = Utc::now();
        let user_id = Uuid::new_v4();
        let recent_id = Uuid::new_v4();
        let stale_id = Uuid::new_v4();
        let mut sessions = HashMap::from([
            (
                recent_id,
                test_session(
                    recent_id,
                    user_id,
                    now + ChronoDuration::minutes(10),
                    DeviceAuthStatus::Cancelled,
                    Some(now - ChronoDuration::minutes(29)),
                ),
            ),
            (
                stale_id,
                test_session(
                    stale_id,
                    user_id,
                    now + ChronoDuration::minutes(10),
                    DeviceAuthStatus::Cancelled,
                    Some(now - ChronoDuration::minutes(31)),
                ),
            ),
        ]);

        prune_sessions(&mut sessions);

        assert!(sessions.contains_key(&recent_id));
        assert!(!sessions.contains_key(&stale_id));
    }

    #[test]
    fn github_completion_only_transitions_unexpired_pending_sessions() {
        let now = Utc::now();
        assert_eq!(
            github_device_auth_completion_outcome("pending", now + ChronoDuration::seconds(1), now,),
            GithubDeviceAuthCompletionOutcome::Completed { completed_at: now }
        );
        assert_eq!(
            github_device_auth_completion_outcome("pending", now, now),
            GithubDeviceAuthCompletionOutcome::Expired
        );
        for terminal_status in ["completed", "failed", "cancelled"] {
            assert_eq!(
                github_device_auth_completion_outcome(
                    terminal_status,
                    now + ChronoDuration::minutes(10),
                    now,
                ),
                GithubDeviceAuthCompletionOutcome::AlreadyTerminal
            );
        }
    }

    #[test]
    fn github_session_assertion_uses_the_terminal_retention_window() {
        let completed_at = Utc::now();
        assert_eq!(
            github_device_auth_assertion_expires_at(completed_at),
            completed_at + ChronoDuration::minutes(GITHUB_DEVICE_AUTH_ASSERTION_TTL_MINUTES)
        );
    }

    #[test]
    fn github_provider_lifetime_and_poll_interval_are_bounded() {
        let now = Utc::now();
        assert_eq!(
            github_device_auth_expires_at(now, u64::MAX),
            now + ChronoDuration::seconds(GITHUB_DEVICE_AUTH_MAX_LIFETIME_SECONDS as i64)
        );
        assert_eq!(github_device_auth_poll_interval(0), 5);
        assert_eq!(
            github_device_auth_poll_interval(u64::MAX),
            GITHUB_DEVICE_AUTH_MAX_POLL_INTERVAL_SECONDS
        );
    }

    #[tokio::test]
    async fn github_start_reservations_are_atomic_rate_limited_and_reap_orphans(
    ) -> anyhow::Result<()> {
        let database_url = match std::env::var("TEST_DATABASE_URL") {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                eprintln!(
                    "skipping GitHub device auth reservation test: TEST_DATABASE_URL not set"
                );
                return Ok(());
            }
        };
        let manager = PostgresConnectionManager::new_from_stringlike(database_url, NoTls)?;
        let pool = Pool::builder().max_size(8).build(manager).await?;
        let capacity_user_id = Uuid::new_v4();
        let rate_user_id = Uuid::new_v4();
        let orphan_user_id = Uuid::new_v4();
        let connection = pool.get().await?;
        for user_id in [capacity_user_id, rate_user_id, orphan_user_id] {
            connection
                .execute("insert into auth.users (id) values ($1)", &[&user_id])
                .await?;
        }
        drop(connection);

        let capacity_attempts = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        let (first, second, third) = tokio::join!(
            reserve_github_device_auth_start(&pool, capacity_user_id, capacity_attempts[0]),
            reserve_github_device_auth_start(&pool, capacity_user_id, capacity_attempts[1]),
            reserve_github_device_auth_start(&pool, capacity_user_id, capacity_attempts[2]),
        );
        let capacity_outcomes = [
            first.expect("first reservation should complete"),
            second.expect("second reservation should complete"),
            third.expect("third reservation should complete"),
        ];
        let reserved_count = capacity_outcomes
            .iter()
            .filter(|outcome| matches!(outcome, GithubDeviceAuthStartReservation::Reserved))
            .count();
        let limited_count = capacity_outcomes
            .iter()
            .filter(|outcome| {
                matches!(
                    outcome,
                    GithubDeviceAuthStartReservation::PendingLimitReached
                )
            })
            .count();
        for (attempt_id, outcome) in capacity_attempts.iter().zip(capacity_outcomes.iter()) {
            if matches!(outcome, GithubDeviceAuthStartReservation::Reserved) {
                release_github_device_auth_start(&pool, capacity_user_id, *attempt_id)
                    .await
                    .expect("reserved capacity slot should release");
            }
        }

        for _ in 0..5 {
            let attempt_id = Uuid::new_v4();
            assert_eq!(
                reserve_github_device_auth_start(&pool, rate_user_id, attempt_id)
                    .await
                    .expect("rate-limit probe should complete"),
                GithubDeviceAuthStartReservation::Reserved
            );
            release_github_device_auth_start(&pool, rate_user_id, attempt_id)
                .await
                .expect("rate-limit probe should release");
        }
        let rate_limited = reserve_github_device_auth_start(&pool, rate_user_id, Uuid::new_v4())
            .await
            .expect("rate-limited reservation should complete");

        let orphan_session_id = Uuid::new_v4();
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into github_device_auth_sessions (
                   session_id, user_id, status, verification_url, user_code,
                   poll_interval_seconds, device_expires_at,
                   poll_owner_id, poll_lease_expires_at
                 ) values (
                   $1, $2, 'pending', 'https://github.com/login/device', 'TEST-CODE',
                   5, now() + interval '10 minutes', $1, now() - interval '1 second'
                 )",
                &[&orphan_session_id, &orphan_user_id],
            )
            .await?;
        drop(connection);
        let orphan_attempt_id = Uuid::new_v4();
        let orphan_outcome =
            reserve_github_device_auth_start(&pool, orphan_user_id, orphan_attempt_id)
                .await
                .expect("orphan-reaping reservation should complete");
        release_github_device_auth_start(&pool, orphan_user_id, orphan_attempt_id)
            .await
            .expect("orphan-reaping reservation should release");
        let connection = pool.get().await?;
        let orphan = connection
            .query_one(
                "select status, error_message, poll_owner_id, poll_lease_expires_at
                 from github_device_auth_sessions where session_id = $1",
                &[&orphan_session_id],
            )
            .await?;
        let orphan_status: String = orphan.get("status");
        let orphan_error: Option<String> = orphan.get("error_message");
        let orphan_owner: Option<Uuid> = orphan.get("poll_owner_id");
        let orphan_lease: Option<chrono::DateTime<Utc>> = orphan.get("poll_lease_expires_at");

        for user_id in [capacity_user_id, rate_user_id, orphan_user_id] {
            connection
                .execute("delete from auth.users where id = $1", &[&user_id])
                .await?;
        }

        assert_eq!(reserved_count, 2);
        assert_eq!(limited_count, 1);
        assert!(matches!(
            rate_limited,
            GithubDeviceAuthStartReservation::RateLimited {
                retry_after_seconds: 1..=60
            }
        ));
        assert_eq!(orphan_outcome, GithubDeviceAuthStartReservation::Reserved);
        assert_eq!(orphan_status, "failed");
        assert_eq!(
            orphan_error.as_deref(),
            Some(GITHUB_DEVICE_AUTH_INTERRUPTED_MESSAGE)
        );
        assert!(orphan_owner.is_none());
        assert!(orphan_lease.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn terminal_registry_transitions_record_completion_time() {
        let registry = DeviceAuthRegistry::new();
        let user_id = Uuid::new_v4();
        let failed_id = Uuid::new_v4();
        registry
            .insert(test_session(
                failed_id,
                user_id,
                Utc::now() + ChronoDuration::minutes(10),
                DeviceAuthStatus::Pending,
                None,
            ))
            .await;

        let failed = registry
            .update_status(
                &failed_id,
                DeviceAuthStatus::Failed {
                    error: "test failure".to_string(),
                },
            )
            .await
            .expect("session should exist");
        assert!(failed.completed_at.is_some());

        let cancelled_id = Uuid::new_v4();
        registry
            .insert(test_session(
                cancelled_id,
                user_id,
                Utc::now() + ChronoDuration::minutes(10),
                DeviceAuthStatus::Pending,
                None,
            ))
            .await;
        assert!(registry.cancel(&cancelled_id, &user_id).await);
        let cancelled = registry
            .get(&cancelled_id)
            .await
            .expect("cancelled session should be retained");
        assert!(matches!(cancelled.status, DeviceAuthStatus::Cancelled));
        assert!(cancelled.completed_at.is_some());

        let completed_id = Uuid::new_v4();
        let completed_at = Utc::now();
        registry
            .insert(test_session(
                completed_id,
                user_id,
                Utc::now() + ChronoDuration::minutes(10),
                DeviceAuthStatus::Completed {
                    credential_id: None,
                },
                Some(completed_at),
            ))
            .await;
        assert!(registry.cancel(&completed_id, &user_id).await);
        let completed = registry
            .get(&completed_id)
            .await
            .expect("completed session should be retained");
        assert!(matches!(
            completed.status,
            DeviceAuthStatus::Completed { .. }
        ));
        assert_eq!(completed.completed_at, Some(completed_at));
    }

    #[test]
    fn codex_forbidden_poll_is_actionable_and_not_pending() {
        let error = codex_poll_http_error(reqwest::StatusCode::FORBIDDEN)
            .expect_err("403 must stop polling");
        assert!(error.contains("ChatGPT Settings"));
        assert!(error.contains("Security"));
        assert!(error.contains("workspace permissions"));
        assert!(matches!(
            codex_poll_http_error(reqwest::StatusCode::NOT_FOUND),
            Ok(None)
        ));
    }

    #[test]
    fn github_poll_retries_rate_limits_and_server_failures() {
        for status in [
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert!(matches!(
                github_token_poll_http_error(status),
                GithubTokenPollError::Retryable(_)
            ));
        }
    }

    #[test]
    fn github_poll_stops_on_non_retryable_http_failures() {
        for status in [
            reqwest::StatusCode::BAD_REQUEST,
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
        ] {
            assert!(matches!(
                github_token_poll_http_error(status),
                GithubTokenPollError::Terminal(_)
            ));
        }
    }
}

#[cfg(test)]
mod gemini_oauth_tests {
    use chrono::{DateTime, Utc};
    use serde_json::Value as JsonValue;

    use super::{
        build_gemini_authorize_url, build_gemini_oauth_auth_json, build_gemini_oauth_metadata,
        build_pkce_code_challenge, html_escape, normalize_gemini_oauth_mode, GeminiOauthTokens,
        GEMINI_CODE_ASSIST_API_BASE,
    };

    #[test]
    fn pkce_code_challenge_is_url_safe() {
        let challenge = build_pkce_code_challenge("test-verifier");
        assert!(!challenge.is_empty());
        assert!(!challenge.contains('+'));
        assert!(!challenge.contains('/'));
        assert!(!challenge.contains('='));
    }

    #[test]
    fn gemini_authorize_url_contains_expected_params() {
        let url = build_gemini_authorize_url(
            "client-id-123",
            "https://controller.example.com/auth/device/gemini/callback",
            "scope-a scope-b",
            "state-abc",
            "challenge-xyz",
        );

        assert!(url.contains("accounts.google.com/o/oauth2/v2/auth"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=state-abc"));
    }

    #[test]
    fn html_escape_escapes_html_chars() {
        let escaped = html_escape("<b>\"hello\" & 'bye'</b>");
        assert_eq!(
            escaped,
            "&lt;b&gt;&quot;hello&quot; &amp; &#39;bye&#39;&lt;/b&gt;"
        );
    }

    #[test]
    fn normalize_gemini_oauth_mode_maps_aliases() {
        assert_eq!(normalize_gemini_oauth_mode(None), "code_assist");
        assert_eq!(normalize_gemini_oauth_mode(Some("api")), "api");
        assert_eq!(normalize_gemini_oauth_mode(Some("gemini_api")), "api");
        assert_eq!(normalize_gemini_oauth_mode(Some("CLI")), "code_assist_cli");
        assert_eq!(
            normalize_gemini_oauth_mode(Some("code_assist_cli")),
            "code_assist_cli"
        );
        assert_eq!(normalize_gemini_oauth_mode(Some("unknown")), "code_assist");
    }

    #[test]
    fn gemini_oauth_metadata_uses_code_assist_endpoint() {
        let tokens = GeminiOauthTokens {
            access_token: "access-token".to_string(),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("scope-a".to_string()),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            expires_at: None,
        };

        let metadata =
            build_gemini_oauth_metadata(&tokens, "scope-a", "code_assist", Some("proj-123"));

        assert_eq!(
            metadata.get("auth_mode").and_then(JsonValue::as_str),
            Some("code_assist")
        );
        assert_eq!(
            metadata
                .get("upstream_endpoint")
                .and_then(JsonValue::as_str),
            Some(GEMINI_CODE_ASSIST_API_BASE)
        );
        assert_eq!(
            metadata
                .get("code_assist_project")
                .and_then(JsonValue::as_str),
            Some("proj-123")
        );
    }

    #[test]
    fn gemini_oauth_auth_json_tracks_mode_and_expiry() {
        let expires_at = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .expect("fixed RFC3339 timestamp should parse")
            .with_timezone(&Utc);
        let tokens = GeminiOauthTokens {
            access_token: "access-token".to_string(),
            refresh_token: Some("refresh-token".to_string()),
            scope: Some("scope-a".to_string()),
            token_type: Some("Bearer".to_string()),
            expires_in: Some(3600),
            expires_at: Some(expires_at),
        };

        let auth = build_gemini_oauth_auth_json(&tokens, "scope-a", "code_assist", Some("proj-1"));

        assert_eq!(
            auth.get("gemini_oauth_mode").and_then(JsonValue::as_str),
            Some("code_assist")
        );
        assert_eq!(
            auth.get("scope").and_then(JsonValue::as_str),
            Some("scope-a")
        );
        assert_eq!(
            auth.pointer("/tokens/code_assist_project")
                .and_then(JsonValue::as_str),
            Some("proj-1")
        );
        assert_eq!(
            auth.pointer("/tokens/expires_at")
                .and_then(JsonValue::as_str),
            Some("2026-01-01T00:00:00+00:00")
        );
    }
}
