use std::str::FromStr;
use std::time::Duration;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::time::timeout;
use tokio_postgres::{types::Json as PgJson, Transaction};
use uuid::Uuid;

use crate::ai_agents;
use crate::auth::{
    authenticate_request, bearer_token, issue_proxy_envelope, require_user_session, RequestContext,
};
use crate::config::CredentialEncryptionKey;
use crate::model_defaults::{default_managed_ai_model_id, default_model_for_provider};
use crate::{bad_request, internal_error, not_found, unauthorized, ApiError, AppState};

const CREDENTIAL_KIND_CODEX_AUTH_JSON: &str = "codex_auth_json";
const CREDENTIAL_KIND_OPENAI_API_KEY: &str = "openai_api_key";
const PROVIDER_OPENAI: &str = "openai";
const PROVIDER_DEEPSEEK: &str = "deepseek";
const PROVIDER_ZAI: &str = "zai";
const PROVIDER_GEMINI: &str = "gemini";

const DEFAULT_OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/responses";
const DEFAULT_CHATGPT_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_DEEPSEEK_ENDPOINT: &str = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_ZAI_ENDPOINT: &str = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const DEFAULT_GEMINI_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const CREDENTIAL_PROBE_PROMPT: &str = "Respond with exactly: OK";
const INLINE_COMPLETION_MAX_PREFIX_CHARS: usize = 6000;
const INLINE_COMPLETION_MAX_SUFFIX_CHARS: usize = 2000;
const INLINE_COMPLETION_MAX_OUTPUT_TOKENS: u32 = 128;
const CONVERSATION_TITLE_MAX_INPUT_CHARS: usize = 600;
const CONVERSATION_TITLE_MAX_OUTPUT_TOKENS: u32 = 32;
const CONVERSATION_TITLE_MAX_CHARS: usize = 48;
const GOOGLE_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CODEX_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR: &str = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_ACCESS_TOKEN_REFRESH_MAX_AGE_SECONDS: i64 = 60 * 60;
const INTERNAL_CREDENTIAL_LEASE_SECONDS: u64 = 60;
const GEMINI_AUTH_MODE_CODE_ASSIST: &str = "code_assist";
const GEMINI_AUTH_MODE_CODE_ASSIST_CLI: &str = "code_assist_cli";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCodexCredentialBody {
    auth_json: JsonValue,
    label: Option<String>,
    #[serde(default)]
    make_default: Option<bool>,
    #[serde(default)]
    provider: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateCredentialResponse {
    credential_id: String,
    kind: String,
    is_default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_handle: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MySessionResponse {
    user_id: String,
}

#[derive(Debug)]
pub(crate) struct CreatedCredential {
    pub(crate) credential_id: Uuid,
    pub(crate) kind: String,
    pub(crate) is_default: bool,
    pub(crate) agent_id: Uuid,
    pub(crate) agent_handle: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialListItem {
    id: String,
    kind: String,
    label: Option<String>,
    is_default: bool,
    metadata: JsonValue,
    // Latest BYOC subscription-usage snapshot; `null` until a usage report lands.
    // Serialized as `subscriptionUsage` for the frontend usage meters.
    subscription_usage: Option<JsonValue>,
    last_used_at: Option<String>,
    revoked_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalCredentialResponse {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    openai_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code_assist_project: Option<String>,
    lease_expires_in_seconds: u64,
    renewal_authority: &'static str,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InternalCredentialQuery {
    #[serde(default)]
    force_refresh: bool,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/session", get(get_my_session))
        .route("/me/credentials", get(list_my_credentials))
        .route(
            "/me/credentials/requirements",
            get(get_my_credential_requirements),
        )
        .route("/me/credentials/codex", post(create_my_codex_credential))
        .route(
            "/me/credentials/:credential_id/test",
            post(test_my_credential),
        )
        .route(
            "/projects/:project_id/editor/completions",
            post(request_project_editor_completion),
        )
        .route(
            "/projects/:project_id/conversation/title",
            post(request_project_conversation_title),
        )
        .route(
            "/me/credentials/:credential_id/default",
            post(set_my_default_credential),
        )
        .route(
            "/me/credentials/default",
            delete(clear_my_default_credential),
        )
        .route(
            "/me/credentials/:credential_id",
            delete(revoke_my_credential),
        )
        .route(
            "/internal/credentials/:credential_id",
            get(get_internal_credential),
        )
        .route(
            "/internal/credentials/:credential_id/usage",
            post(set_internal_credential_usage),
        )
}

async fn get_my_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<MySessionResponse>), (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let session = my_session_response(context)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok((response_headers, Json(session)))
}

fn my_session_response(
    context: RequestContext,
) -> Result<MySessionResponse, (StatusCode, Json<ApiError>)> {
    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("user session required"))?;
    Ok(MySessionResponse {
        user_id: user_id.to_string(),
    })
}

pub(crate) async fn insert_user_credential(
    state: &AppState,
    user_id: Uuid,
    kind: String,
    metadata: JsonValue,
    auth_json: JsonValue,
    label: Option<String>,
    make_default: Option<bool>,
) -> Result<CreatedCredential, (StatusCode, Json<ApiError>)> {
    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("CREDENTIAL_ENCRYPTION_KEY is not configured"))?;

    let auth_object = auth_json
        .as_object()
        .ok_or_else(|| bad_request("authJson must be a JSON object"))?;

    let plaintext = serde_json::to_vec(&JsonValue::Object(auth_object.clone()))
        .map_err(|error| internal_error(format!("failed to encode authJson: {error}")))?;

    let (nonce_b64, ciphertext_b64) = encrypt_secret_payload(key, &plaintext).map_err(|error| {
        internal_error(format!("failed to encrypt credential payload: {error}"))
    })?;

    let label = label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let default_row = transaction
        .query_opt(
            "select id from user_credentials where user_id = $1 and is_default = true and revoked_at is null limit 1",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check default credential: {error}")))?;

    let should_default = make_default.unwrap_or(default_row.is_none());

    if should_default {
        transaction
            .execute(
                "update user_credentials set is_default = false, updated_at = now()
                 where user_id = $1 and is_default = true",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to clear default credential: {error}"))
            })?;
    }

    let credential_id = Uuid::new_v4();
    let metadata_param = PgJson(&metadata);
    let agent_provider = metadata
        .get("provider")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| PROVIDER_OPENAI.to_string());
    let agent_model = metadata
        .get("default_model")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    transaction
        .execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
             ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
            &[
                &credential_id,
                &user_id,
                &kind,
                &label,
                &nonce_b64,
                &ciphertext_b64,
                &metadata_param,
                &should_default,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert credential: {error}")))?;

    let (agent_id, agent_handle) = ai_agents::create_default_agent_for_credential(
        &transaction,
        user_id,
        credential_id,
        label.as_deref(),
        None,
        agent_model,
        // New credential-seeded agents inherit reasoning effort (null) until set.
        None,
        &agent_provider,
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit credential insert: {error}")))?;

    Ok(CreatedCredential {
        credential_id,
        kind,
        is_default: should_default,
        agent_id,
        agent_handle,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedAiAccessResponse {
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) label: String,
    pub(crate) credit_burn_amount: i32,
    pub(crate) daily_prompt_limit: i32,
    pub(crate) daily_prompts_used: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) remaining_prompts: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialRequirementsResponse {
    pub(crate) requires_user_credentials: bool,
    pub(crate) proxy_backend: String,
    pub(crate) has_default_credential: bool,
    pub(crate) managed_ai: ManagedAiAccessResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProxyCredentialRequirements {
    pub(crate) requires_user_credentials: bool,
    pub(crate) proxy_backend: String,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialTestResponse {
    ok: bool,
    provider: Option<String>,
    upstream_endpoint: Option<String>,
    model: Option<String>,
    output: Option<String>,
    elapsed_ms: u128,
}

struct CredentialProbeResult {
    ok: bool,
    output: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorCompletionBody {
    path: String,
    prefix: String,
    suffix: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    credential_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorCompletionResponse {
    completion: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTitleBody {
    message: String,
    #[serde(default)]
    credential_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTitleResponse {
    title: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug)]
struct EditorCompletionCredential {
    credential_id: Uuid,
    model: String,
    provider: String,
}

pub(crate) async fn fetch_proxy_credential_requirements(
    client: &reqwest::Client,
    proxy_base_url: &str,
    timeout_duration: std::time::Duration,
) -> ProxyCredentialRequirements {
    let url = format!("{}/healthz", proxy_base_url.trim_end_matches('/'));
    let request = client.get(url);
    let response = timeout(timeout_duration, request.send()).await;

    let response = match response {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return ProxyCredentialRequirements {
                requires_user_credentials: true,
                proxy_backend: "unknown".to_string(),
                error: Some(format!("proxy request failed: {error}")),
            };
        }
        Err(_) => {
            return ProxyCredentialRequirements {
                requires_user_credentials: true,
                proxy_backend: "unknown".to_string(),
                error: Some("proxy request timed out".to_string()),
            };
        }
    };

    let status = response.status();
    let payload: JsonValue = response.json().await.unwrap_or(JsonValue::Null);
    if !status.is_success() {
        return ProxyCredentialRequirements {
            requires_user_credentials: true,
            proxy_backend: "unknown".to_string(),
            error: Some(format!("proxy returned {}", status.as_u16())),
        };
    }

    let proxy_backend = payload
        .get("backend")
        .and_then(JsonValue::as_str)
        .unwrap_or("unknown")
        .to_string();
    let requires_user_credentials = payload
        .get("requiresCredential")
        .and_then(JsonValue::as_bool)
        .unwrap_or(true);

    ProxyCredentialRequirements {
        requires_user_credentials,
        proxy_backend,
        error: None,
    }
}

pub(crate) async fn ensure_managed_ai_proxy_ready(
    client: &reqwest::Client,
    config: &crate::config::AppConfig,
) -> anyhow::Result<()> {
    if !config.managed_ai_enabled || !config.managed_ai_startup_check {
        return Ok(());
    }

    let proxy_base_url = config.proxy_base_url.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "managed AI is enabled but PROXY_BASE_URL is unset; disable MANAGED_AI_ENABLED or configure a proxy with static credentials"
        )
    })?;

    let mut requirements =
        fetch_proxy_credential_requirements(client, proxy_base_url, Duration::from_secs(2)).await;
    for attempt in 0..14 {
        if requirements.error.is_none() && !requirements.requires_user_credentials {
            break;
        }
        sleep_managed_ai_startup_retry(attempt).await;
        requirements =
            fetch_proxy_credential_requirements(client, proxy_base_url, Duration::from_secs(2))
                .await;
        if attempt == 13 {
            break;
        }
    }

    if let Some(error) = requirements.error {
        anyhow::bail!(
            "managed AI startup check failed for {}: {}",
            proxy_base_url,
            error
        );
    }

    if requirements.requires_user_credentials {
        anyhow::bail!(
            "managed AI startup check failed for {}: proxy reports requiresCredential=true; provide static proxy credentials (OPENAI_API_KEY or auth.json) or disable MANAGED_AI_ENABLED",
            proxy_base_url
        );
    }

    Ok(())
}

fn managed_ai_startup_retry_delay(attempt: u32) -> Duration {
    Duration::from_millis(500 * 2_u64.pow(attempt.min(4)))
}

async fn sleep_managed_ai_startup_retry(attempt: u32) {
    #[cfg(not(test))]
    tokio::time::sleep(managed_ai_startup_retry_delay(attempt)).await;

    #[cfg(test)]
    let _ = attempt;
    #[cfg(test)]
    tokio::task::yield_now().await;
}

pub(crate) async fn count_recent_managed_ai_prompts(
    transaction: &Transaction<'_>,
    user_id: Option<Uuid>,
    since: DateTime<Utc>,
) -> Result<i32, (StatusCode, Json<ApiError>)> {
    let Some(user_id) = user_id else {
        return Ok(0);
    };

    let row = transaction
        .query_one(
            "select count(*)::int as count
             from prompts
             where user_id = $1
               and created_at >= $2
               and metadata @> '{\"managedAiUsed\": true}'::jsonb",
            &[&user_id, &since],
        )
        .await
        .map_err(|error| internal_error(format!("failed to count managed AI prompts: {error}")))?;

    Ok(row.get::<_, i32>("count"))
}

pub(crate) fn build_managed_ai_access_response(
    config: &crate::config::AppConfig,
    proxy_requirements: &ProxyCredentialRequirements,
    has_default_credential: bool,
    daily_prompts_used: i32,
) -> ManagedAiAccessResponse {
    let remaining_prompts = if config.managed_ai_daily_prompt_limit > 0 {
        Some((config.managed_ai_daily_prompt_limit - daily_prompts_used).max(0))
    } else {
        None
    };
    let within_daily_limit = remaining_prompts.map(|value| value > 0).unwrap_or(true);
    let available = config.managed_ai_enabled
        && !has_default_credential
        && proxy_requirements.error.is_none()
        && !proxy_requirements.requires_user_credentials
        && within_daily_limit;

    ManagedAiAccessResponse {
        enabled: config.managed_ai_enabled,
        available,
        label: config.managed_ai_label.clone(),
        credit_burn_amount: config.managed_ai_credit_burn_amount,
        daily_prompt_limit: config.managed_ai_daily_prompt_limit,
        daily_prompts_used,
        remaining_prompts,
    }
}

fn build_credential_requirements_response(
    proxy_requirements: ProxyCredentialRequirements,
    has_default_credential: bool,
    managed_ai: ManagedAiAccessResponse,
) -> CredentialRequirementsResponse {
    CredentialRequirementsResponse {
        requires_user_credentials: !has_default_credential && !managed_ai.available,
        proxy_backend: proxy_requirements.proxy_backend,
        has_default_credential,
        managed_ai,
        error: proxy_requirements.error,
    }
}

async fn get_my_credential_requirements(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CredentialRequirementsResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let Some(proxy_base_url) = state.config.proxy_base_url.as_ref() else {
        let managed_ai = ManagedAiAccessResponse {
            enabled: state.config.managed_ai_enabled,
            available: false,
            label: state.config.managed_ai_label.clone(),
            credit_burn_amount: state.config.managed_ai_credit_burn_amount,
            daily_prompt_limit: state.config.managed_ai_daily_prompt_limit,
            daily_prompts_used: 0,
            remaining_prompts: if state.config.managed_ai_daily_prompt_limit > 0 {
                Some(state.config.managed_ai_daily_prompt_limit)
            } else {
                None
            },
        };
        return Ok(Json(CredentialRequirementsResponse {
            requires_user_credentials: true,
            proxy_backend: "disabled".to_string(),
            has_default_credential: false,
            managed_ai,
            error: None,
        }));
    };

    let proxy_requirements = fetch_proxy_credential_requirements(
        &state.http_client,
        proxy_base_url,
        std::time::Duration::from_secs(2),
    )
    .await;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let has_default_credential = load_default_credential_id(&transaction, Some(user_id))
        .await?
        .is_some();
    let daily_prompts_used = count_recent_managed_ai_prompts(
        &transaction,
        Some(user_id),
        Utc::now() - chrono::Duration::hours(24),
    )
    .await?;
    transaction
        .rollback()
        .await
        .map_err(|error| internal_error(format!("failed to close transaction: {error}")))?;

    let managed_ai = build_managed_ai_access_response(
        &state.config,
        &proxy_requirements,
        has_default_credential,
        daily_prompts_used,
    );

    Ok(Json(build_credential_requirements_response(
        proxy_requirements,
        has_default_credential,
        managed_ai,
    )))
}

async fn test_my_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(credential_id_raw): AxumPath<String>,
) -> Result<Json<CredentialTestResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let credential_id = Uuid::from_str(credential_id_raw.trim())
        .map_err(|_| bad_request("credentialId must be a valid UUID"))?;
    let started_at = std::time::Instant::now();

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    // Load metadata before probing so we can return helpful context without parsing secrets.
    // Importantly: avoid holding a DB transaction open while the proxy calls back into the controller.
    let row = connection
        .query_opt(
            "select kind, metadata
             from user_credentials
             where id = $1 and user_id = $2 and revoked_at is null
             limit 1",
            &[&credential_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credential: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("credential not found"));
    };

    let kind: String = row.get("kind");
    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;

    let meta = metadata.as_object();
    let provider = meta
        .and_then(|map| map.get("provider"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if kind.trim() == CREDENTIAL_KIND_CODEX_AUTH_JSON {
                Some(PROVIDER_OPENAI.to_string())
            } else {
                None
            }
        });
    let upstream_endpoint = meta
        .and_then(|map| map.get("upstream_endpoint"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| match kind.trim() {
            CREDENTIAL_KIND_OPENAI_API_KEY => Some(
                provider
                    .as_deref()
                    .map(default_endpoint_for_provider)
                    .unwrap_or(DEFAULT_OPENAI_ENDPOINT)
                    .to_string(),
            ),
            CREDENTIAL_KIND_CODEX_AUTH_JSON => Some(DEFAULT_CHATGPT_ENDPOINT.to_string()),
            _ => None,
        });
    let model = meta
        .and_then(|map| map.get("default_model"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| match kind.trim() {
            CREDENTIAL_KIND_CODEX_AUTH_JSON => default_managed_ai_model_id().to_string(),
            _ => provider
                .as_deref()
                .map(default_model_for_provider)
                .unwrap_or(default_managed_ai_model_id())
                .to_string(),
        });

    // Always probe through the proxy. This keeps the credential test path aligned with real runs,
    // and avoids accumulating per-provider "direct" probing logic in the controller.
    let probe_result = probe_credential_via_proxy(&state, credential_id, &model).await?;

    connection
        .execute(
            "update user_credentials
             set last_used_at = now(), updated_at = now()
             where id = $1 and user_id = $2",
            &[&credential_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to update credential last_used_at: {error}"))
        })?;

    Ok(Json(CredentialTestResponse {
        ok: probe_result.ok,
        provider,
        upstream_endpoint,
        model: Some(model),
        output: probe_result.output,
        elapsed_ms: started_at.elapsed().as_millis(),
    }))
}

async fn request_project_editor_completion(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<EditorCompletionBody>,
) -> Result<Json<EditorCompletionResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let path = body.path.trim();
    if path.is_empty() {
        return Err(bad_request("path is required"));
    }

    let prefix = take_last_chars(
        &normalize_completion_context(&body.prefix),
        INLINE_COMPLETION_MAX_PREFIX_CHARS,
    );
    let suffix = take_first_chars(
        &normalize_completion_context(&body.suffix),
        INLINE_COMPLETION_MAX_SUFFIX_CHARS,
    );
    let language = body
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    if prefix.trim().is_empty() && suffix.trim().is_empty() {
        return Ok(Json(EditorCompletionResponse {
            completion: None,
            provider: None,
            model: None,
            credential_id: None,
            error: None,
        }));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = crate::load_project_record(&transaction, &project_id).await?;
    crate::ensure_project_write_access(&transaction, &project, &context, None).await?;

    let credential =
        resolve_editor_completion_credential(&transaction, user_id, body.credential_id.as_deref())
            .await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize completion lookup: {error}"))
    })?;

    let Some(credential) = credential else {
        return Ok(Json(EditorCompletionResponse {
            completion: None,
            provider: None,
            model: None,
            credential_id: None,
            error: None,
        }));
    };

    let response = complete_editor_inline_via_proxy(
        &state,
        &project_id,
        &credential,
        path,
        language.as_deref(),
        &prefix,
        &suffix,
    )
    .await;

    if response.completion.is_some() {
        if let Err(error) = connection
            .execute(
                "update user_credentials set last_used_at = now(), updated_at = now() where id = $1",
                &[&credential.credential_id],
            )
            .await
        {
            tracing::warn!(?error, "failed to update inline completion credential last_used_at");
        }
    }

    Ok(Json(response))
}

async fn request_project_conversation_title(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<ConversationTitleBody>,
) -> Result<Json<ConversationTitleResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let message = take_first_chars(
        &normalize_completion_context(body.message.trim()),
        CONVERSATION_TITLE_MAX_INPUT_CHARS,
    );

    if message.is_empty() {
        return Ok(Json(ConversationTitleResponse {
            title: None,
            provider: None,
            model: None,
            credential_id: None,
            error: None,
        }));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = crate::load_project_record(&transaction, &project_id).await?;
    crate::ensure_project_write_access(&transaction, &project, &context, None).await?;

    let credential =
        resolve_editor_completion_credential(&transaction, user_id, body.credential_id.as_deref())
            .await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize title lookup: {error}")))?;

    let Some(credential) = credential else {
        return Ok(Json(ConversationTitleResponse {
            title: None,
            provider: None,
            model: None,
            credential_id: None,
            error: None,
        }));
    };

    let response =
        generate_conversation_title_via_proxy(&state, &project_id, &credential, &message).await;

    if response.title.is_some() {
        if let Err(error) = connection
            .execute(
                "update user_credentials set last_used_at = now(), updated_at = now() where id = $1",
                &[&credential.credential_id],
            )
            .await
        {
            tracing::warn!(?error, "failed to update conversation title credential last_used_at");
        }
    }

    Ok(Json(response))
}

async fn resolve_editor_completion_credential(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: Uuid,
    credential_id_hint: Option<&str>,
) -> Result<Option<EditorCompletionCredential>, (StatusCode, Json<ApiError>)> {
    let credential_id = credential_id_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::from_str(value).map_err(|_| bad_request("credentialId must be a valid UUID"))
        })
        .transpose()?;

    let row = if let Some(credential_id) = credential_id {
        transaction
            .query_opt(
                "select id, kind, metadata
                 from user_credentials
                 where id = $1 and user_id = $2 and revoked_at is null
                 limit 1",
                &[&credential_id, &user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load requested completion credential: {error}"
                ))
            })?
    } else {
        transaction
            .query_opt(
                "select id, kind, metadata
                 from user_credentials
                 where user_id = $1 and is_default = true and revoked_at is null
                 order by updated_at desc, created_at desc
                 limit 1",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load default completion credential: {error}"
                ))
            })?
    };

    let Some(row) = row else {
        return Ok(None);
    };

    let credential_id: Uuid = row.get("id");
    let kind: String = row.get("kind");
    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
    let provider = provider_for_credential(&kind, &metadata);
    let model = metadata
        .as_object()
        .and_then(|map| map.get("default_model"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_model_for_credential(&kind, &provider))
        .to_string();

    Ok(Some(EditorCompletionCredential {
        credential_id,
        model,
        provider,
    }))
}

async fn complete_editor_inline_via_proxy(
    state: &AppState,
    project_id: &Uuid,
    credential: &EditorCompletionCredential,
    path: &str,
    language: Option<&str>,
    prefix: &str,
    suffix: &str,
) -> EditorCompletionResponse {
    let synthetic_runtime_id = Uuid::new_v4();
    let Some(proxy_envelope) = issue_proxy_envelope(
        &state.config,
        project_id,
        &synthetic_runtime_id,
        None,
        Some(&credential.credential_id),
        Some("octo"),
        Some("Octo"),
        Some("Inline editor completion"),
    ) else {
        return EditorCompletionResponse {
            completion: None,
            provider: Some(credential.provider.clone()),
            model: Some(credential.model.clone()),
            credential_id: Some(credential.credential_id.to_string()),
            error: Some("AI proxy is not configured.".to_string()),
        };
    };

    let endpoint = format!("{}/v1/responses", proxy_envelope.url.trim_end_matches('/'));
    let prompt = build_inline_completion_prompt(path, language, prefix, suffix);
    let body = json!({
        "model": credential.model,
        "instructions": "Return only the text to insert at the cursor. Do not explain anything. Do not wrap the answer in code fences or quotes. If there is no confident completion, return an empty response.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": prompt,
                    }
                ]
            }
        ],
        "max_output_tokens": INLINE_COMPLETION_MAX_OUTPUT_TOKENS,
        "stream": false,
    });

    let response = match state
        .http_client
        .post(&endpoint)
        .bearer_auth(&proxy_envelope.token)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(?error, "inline completion proxy request failed");
            return EditorCompletionResponse {
                completion: None,
                provider: Some(credential.provider.clone()),
                model: Some(credential.model.clone()),
                credential_id: Some(credential.credential_id.to_string()),
                error: Some("AI proxy request failed; please retry.".to_string()),
            };
        }
    };

    let status = response.status();
    let response_text = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(?error, "inline completion returned invalid proxy body");
            return EditorCompletionResponse {
                completion: None,
                provider: Some(credential.provider.clone()),
                model: Some(credential.model.clone()),
                credential_id: Some(credential.credential_id.to_string()),
                error: Some("AI proxy returned an invalid response.".to_string()),
            };
        }
    };

    let payload = serde_json::from_str::<JsonValue>(&response_text).ok();
    let completion = if status.is_success() {
        payload
            .as_ref()
            .and_then(extract_output_text_from_responses)
            .and_then(|value| sanitize_inline_completion(&value, prefix, suffix))
    } else {
        None
    };
    let error = if status.is_success() {
        None
    } else {
        extract_error_message_from_payload(payload.as_ref(), &response_text)
    };

    EditorCompletionResponse {
        completion,
        provider: Some(credential.provider.clone()),
        model: Some(credential.model.clone()),
        credential_id: Some(credential.credential_id.to_string()),
        error,
    }
}

async fn generate_conversation_title_via_proxy(
    state: &AppState,
    project_id: &Uuid,
    credential: &EditorCompletionCredential,
    message: &str,
) -> ConversationTitleResponse {
    let synthetic_runtime_id = Uuid::new_v4();
    let Some(proxy_envelope) = issue_proxy_envelope(
        &state.config,
        project_id,
        &synthetic_runtime_id,
        None,
        Some(&credential.credential_id),
        Some("octo"),
        Some("Octo"),
        Some("Conversation title"),
    ) else {
        return ConversationTitleResponse {
            title: None,
            provider: Some(credential.provider.clone()),
            model: Some(credential.model.clone()),
            credential_id: Some(credential.credential_id.to_string()),
            error: Some("AI proxy is not configured.".to_string()),
        };
    };

    let endpoint = format!("{}/v1/responses", proxy_envelope.url.trim_end_matches('/'));
    let prompt = build_conversation_title_prompt(message);
    let body = json!({
        "model": credential.model,
        "instructions": "Return only a short conversation title in sentence case. Use 2 to 5 words when possible. Do not include quotes, markdown, or a trailing period. Prefer the user's intent over filler. If the message contains an email address, generalize it rather than repeating the full address.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": prompt,
                    }
                ]
            }
        ],
        "max_output_tokens": CONVERSATION_TITLE_MAX_OUTPUT_TOKENS,
        "stream": false,
    });

    let response = match state
        .http_client
        .post(&endpoint)
        .bearer_auth(&proxy_envelope.token)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(?error, "conversation title proxy request failed");
            return ConversationTitleResponse {
                title: None,
                provider: Some(credential.provider.clone()),
                model: Some(credential.model.clone()),
                credential_id: Some(credential.credential_id.to_string()),
                error: Some("AI proxy request failed; please retry.".to_string()),
            };
        }
    };

    let status = response.status();
    let response_text = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(?error, "conversation title returned invalid proxy body");
            return ConversationTitleResponse {
                title: None,
                provider: Some(credential.provider.clone()),
                model: Some(credential.model.clone()),
                credential_id: Some(credential.credential_id.to_string()),
                error: Some("AI proxy returned an invalid response.".to_string()),
            };
        }
    };

    let payload = serde_json::from_str::<JsonValue>(&response_text).ok();
    let title = if status.is_success() {
        payload
            .as_ref()
            .and_then(extract_output_text_from_responses)
            .and_then(|value| sanitize_conversation_title(&value))
    } else {
        None
    };
    let error = if status.is_success() {
        None
    } else {
        extract_error_message_from_payload(payload.as_ref(), &response_text)
    };

    ConversationTitleResponse {
        title,
        provider: Some(credential.provider.clone()),
        model: Some(credential.model.clone()),
        credential_id: Some(credential.credential_id.to_string()),
        error,
    }
}

fn build_inline_completion_prompt(
    path: &str,
    language: Option<&str>,
    prefix: &str,
    suffix: &str,
) -> String {
    format!(
        "Provide a short inline editor completion.\n\
         File path: {path}\n\
         Language: {}\n\
         The following excerpts are adjacent around the cursor.\n\
         Continue naturally from <beforeCursor> into <afterCursor>.\n\
         Prefer a short completion, not a rewrite.\n\
         <beforeCursor>\n{prefix}\n</beforeCursor>\n\
         <afterCursor>\n{suffix}\n</afterCursor>",
        language.unwrap_or("plaintext")
    )
}

fn build_conversation_title_prompt(message: &str) -> String {
    format!(
        "Create a concise title for this chat based on the user's first message.\n\
         Message:\n{message}"
    )
}

fn normalize_completion_context(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn take_first_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn take_last_chars(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }
    value.chars().skip(char_count - max_chars).collect()
}

fn strip_wrapping_code_fences(value: &str) -> String {
    let trimmed = value.trim_matches('\n');
    if !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return value.to_string();
    }

    let lines: Vec<&str> = trimmed.lines().collect();
    if lines.len() < 2 {
        return value.to_string();
    }
    if !lines
        .first()
        .map(|line| line.trim_start().starts_with("```"))
        .unwrap_or(false)
    {
        return value.to_string();
    }
    if !lines
        .last()
        .map(|line| line.trim() == "```")
        .unwrap_or(false)
    {
        return value.to_string();
    }

    lines[1..lines.len() - 1].join("\n")
}

fn overlap_len(left: &str, right: &str) -> usize {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let max = left_chars.len().min(right_chars.len());

    for len in (1..=max).rev() {
        if left_chars[left_chars.len() - len..] == right_chars[..len] {
            return len;
        }
    }

    0
}

fn drop_leading_chars(value: &str, count: usize) -> String {
    value.chars().skip(count).collect()
}

fn drop_trailing_chars(value: &str, count: usize) -> String {
    let total = value.chars().count();
    value.chars().take(total.saturating_sub(count)).collect()
}

fn sanitize_inline_completion(raw: &str, prefix: &str, suffix: &str) -> Option<String> {
    let normalized = normalize_completion_context(raw);
    let mut candidate = strip_wrapping_code_fences(&normalized).replace('\0', "");

    let prefix_overlap = overlap_len(prefix, &candidate);
    if prefix_overlap > 0 {
        candidate = drop_leading_chars(&candidate, prefix_overlap);
    }

    let suffix_overlap = overlap_len(&candidate, suffix);
    if suffix_overlap > 0 {
        candidate = drop_trailing_chars(&candidate, suffix_overlap);
    }

    if candidate.trim().is_empty() {
        None
    } else {
        Some(candidate)
    }
}

fn sanitize_conversation_title(raw: &str) -> Option<String> {
    let normalized = normalize_completion_context(raw);
    let stripped = strip_wrapping_code_fences(&normalized).replace('\0', "");
    let first_line = stripped.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return None;
    }

    let without_label = first_line
        .strip_prefix("Title:")
        .or_else(|| first_line.strip_prefix("title:"))
        .unwrap_or(first_line)
        .trim();
    let without_wrapping = without_label
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '“' | '”'))
        .trim();
    let collapsed = without_wrapping
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed_punctuation = collapsed
        .trim_end_matches(|ch: char| matches!(ch, '.' | '!' | '?' | ':' | ';' | ','))
        .trim()
        .to_string();
    if trimmed_punctuation.is_empty() {
        return None;
    }

    let clamped = take_first_chars(&trimmed_punctuation, CONVERSATION_TITLE_MAX_CHARS)
        .trim()
        .to_string();
    if clamped.is_empty() {
        None
    } else {
        Some(clamped)
    }
}

async fn probe_credential_via_proxy(
    state: &AppState,
    credential_id: Uuid,
    model: &str,
) -> Result<CredentialProbeResult, (StatusCode, Json<ApiError>)> {
    let synthetic_project_id = Uuid::new_v4();
    let synthetic_runtime_id = Uuid::new_v4();
    let Some(proxy_envelope) = issue_proxy_envelope(
        &state.config,
        &synthetic_project_id,
        &synthetic_runtime_id,
        None,
        Some(&credential_id),
        Some("octo"),
        Some("Octo"),
        Some("Credential verification probe"),
    ) else {
        return Ok(CredentialProbeResult {
            ok: false,
            output: Some("AI proxy is not configured; unable to verify credentials.".to_string()),
        });
    };

    let endpoint = format!("{}/v1/responses", proxy_envelope.url.trim_end_matches('/'));
    let body = json!({
        "model": model,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": CREDENTIAL_PROBE_PROMPT,
                    }
                ]
            }
        ],
        "stream": false,
    });

    let response = match state
        .http_client
        .post(&endpoint)
        .bearer_auth(&proxy_envelope.token)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(?error, "credential test proxy request failed");
            return Ok(CredentialProbeResult {
                ok: false,
                output: Some("AI proxy request failed; please retry.".to_string()),
            });
        }
    };

    let status = response.status();
    let response_text = response.text().await.map_err(|error| {
        internal_error(format!(
            "credential test returned invalid proxy body: {error}"
        ))
    })?;
    let payload = serde_json::from_str::<JsonValue>(&response_text).ok();

    let output = payload
        .as_ref()
        .and_then(extract_output_text_from_responses)
        .or_else(|| extract_error_message_from_payload(payload.as_ref(), &response_text));

    Ok(CredentialProbeResult {
        ok: status.is_success(),
        output,
    })
}

fn extract_error_message_from_payload(
    payload: Option<&JsonValue>,
    fallback_text: &str,
) -> Option<String> {
    if let Some(payload) = payload {
        if let Some(message) = payload
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(JsonValue::as_str)
        {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(message) = payload.get("message").and_then(JsonValue::as_str) {
            let trimmed = message.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    let trimmed = fallback_text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_output_text_from_responses(payload: &JsonValue) -> Option<String> {
    if let Some(value) = payload.get("output_text").and_then(JsonValue::as_str) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let output = payload.get("output").and_then(JsonValue::as_array)?;
    let mut parts = Vec::new();
    for item in output {
        if item.get("role").and_then(JsonValue::as_str) != Some("assistant") {
            continue;
        }
        let content = item.get("content").and_then(JsonValue::as_array)?;
        for part in content {
            if part.get("type").and_then(JsonValue::as_str) != Some("output_text") {
                continue;
            }
            let Some(text) = part.get("text").and_then(JsonValue::as_str) else {
                continue;
            };
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    let joined = parts.join("\n").trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

pub(crate) async fn load_default_credential_id(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(user_id) = user_id else {
        return Ok(None);
    };

    let row = transaction
        .query_opt(
            "select id
             from user_credentials
             where user_id = $1 and is_default = true and revoked_at is null
             order by updated_at desc, created_at desc
             limit 1",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load default credential: {error}")))?;

    Ok(row.map(|row| row.get::<_, Uuid>("id")))
}

async fn list_my_credentials(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<CredentialListItem>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let rows = connection
        .query(
            "select id, kind, label, metadata, is_default, subscription_usage, last_used_at, revoked_at, created_at, updated_at
             from user_credentials
             where user_id = $1
             order by created_at desc, id desc
             limit 200",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list credentials: {error}")))?;

    let items = rows
        .into_iter()
        .map(|row| {
            let id: Uuid = row.get("id");
            let kind: String = row.get("kind");
            let label: Option<String> = row.get("label");
            let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
            let is_default: bool = row.get("is_default");
            let subscription_usage: Option<JsonValue> = row
                .get::<_, Option<PgJson<JsonValue>>>("subscription_usage")
                .map(|value| value.0);
            let last_used_at: Option<DateTime<Utc>> = row.get("last_used_at");
            let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
            let created_at: DateTime<Utc> = row.get("created_at");
            let updated_at: DateTime<Utc> = row.get("updated_at");

            CredentialListItem {
                id: id.to_string(),
                kind,
                label,
                is_default,
                metadata,
                subscription_usage,
                last_used_at: last_used_at.map(|dt| dt.to_rfc3339()),
                revoked_at: revoked_at.map(|dt| dt.to_rfc3339()),
                created_at: created_at.to_rfc3339(),
                updated_at: updated_at.to_rfc3339(),
            }
        })
        .collect();

    Ok(Json(items))
}

async fn create_my_codex_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateCodexCredentialBody>,
) -> Result<Json<CreateCredentialResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let auth_object = body
        .auth_json
        .as_object()
        .ok_or_else(|| bad_request("authJson must be a JSON object"))?;

    let (kind, metadata) = classify_auth_json(auth_object)?;
    let metadata = augment_metadata_with_provider(&kind, metadata, body.provider.as_deref());

    let created = insert_user_credential(
        &state,
        user_id,
        kind,
        metadata,
        body.auth_json,
        body.label,
        body.make_default,
    )
    .await?;

    Ok(Json(CreateCredentialResponse {
        credential_id: created.credential_id.to_string(),
        kind: created.kind,
        is_default: created.is_default,
        agent_id: Some(created.agent_id.to_string()),
        agent_handle: Some(created.agent_handle),
    }))
}

async fn set_my_default_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(credential_id_raw): AxumPath<String>,
) -> Result<Json<CreateCredentialResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let credential_id = Uuid::from_str(credential_id_raw.trim())
        .map_err(|_| bad_request("credentialId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let row = transaction
        .query_opt(
            "select id, kind, metadata
             from user_credentials
             where id = $1 and user_id = $2 and revoked_at is null
             limit 1",
            &[&credential_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credential: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("credential not found"));
    };

    let kind: String = row.get("kind");
    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
    let next_default_provider = provider_for_credential(&kind, &metadata);

    let previous_default_provider = transaction
        .query_opt(
            "select kind, metadata
             from user_credentials
             where user_id = $1 and is_default = true and revoked_at is null and id <> $2
             limit 1",
            &[&user_id, &credential_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load previous default credential: {error}"
            ))
        })?
        .map(|existing| {
            let existing_kind: String = existing.get("kind");
            let existing_metadata: JsonValue = existing.get::<_, PgJson<JsonValue>>("metadata").0;
            provider_for_credential(&existing_kind, &existing_metadata)
        });

    transaction
        .execute(
            "update user_credentials set is_default = false, updated_at = now()
             where user_id = $1 and is_default = true",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to clear default credential: {error}")))?;

    transaction
        .execute(
            "update user_credentials set is_default = true, updated_at = now()
             where id = $1 and user_id = $2",
            &[&credential_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to set default credential: {error}")))?;

    if previous_default_provider
        .as_deref()
        .map(|provider| provider != next_default_provider.as_str())
        .unwrap_or(false)
    {
        transaction
            .execute(
                "update user_agents
                 set model = null, updated_at = now()
                 where user_id = $1
                   and deleted_at is null
                   and credential_id is null
                   and lower(provider) = 'assistant'",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to reset assistant agent models after default credential change: {error}"
                ))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit default credential update: {error}"
        ))
    })?;

    Ok(Json(CreateCredentialResponse {
        credential_id: credential_id.to_string(),
        kind,
        is_default: true,
        agent_id: None,
        agent_handle: None,
    }))
}

async fn clear_my_default_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let updated = transaction
        .execute(
            "update user_credentials set is_default = false, updated_at = now()
             where user_id = $1 and is_default = true and revoked_at is null",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to clear default credential: {error}")))?;

    if updated > 0 {
        transaction
            .execute(
                "update user_agents
                 set model = null, updated_at = now()
                 where user_id = $1
                   and deleted_at is null
                   and credential_id is null
                   and lower(provider) = 'assistant'",
                &[&user_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to reset assistant agent models after default credential clear: {error}"
                ))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit default credential clear: {error}"
        ))
    })?;

    Ok(Json(json!({
        "ok": true,
        "hasDefaultCredential": false,
    })))
}

async fn revoke_my_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(credential_id_raw): AxumPath<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let credential_id = Uuid::from_str(credential_id_raw.trim())
        .map_err(|_| bad_request("credentialId must be a valid UUID"))?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let updated = connection
        .execute(
            "update user_credentials
             set revoked_at = now(), is_default = false, updated_at = now()
             where id = $1 and user_id = $2 and revoked_at is null",
            &[&credential_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to revoke credential: {error}")))?;

    if updated == 0 {
        return Err(not_found("credential not found"));
    }

    connection
        .execute(
            "update user_agents
             set credential_id = null, updated_at = now()
             where user_id = $1 and credential_id = $2 and deleted_at is null",
            &[&user_id, &credential_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to disconnect agents from credential: {error}"
            ))
        })?;

    Ok(Json(json!({ "ok": true })))
}

async fn get_internal_credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(credential_id_raw): AxumPath<String>,
    Query(query): Query<InternalCredentialQuery>,
) -> Result<Json<InternalCredentialResponse>, (StatusCode, Json<ApiError>)> {
    require_proxy_credential_lease_token(&state.config, &headers)?;

    let credential_id = Uuid::from_str(credential_id_raw.trim())
        .map_err(|_| bad_request("credentialId must be a valid UUID"))?;

    let key = state
        .config
        .credential_encryption_key
        .as_ref()
        .ok_or_else(|| internal_error("CREDENTIAL_ENCRYPTION_KEY is not configured"))?;

    // The in-process lock avoids duplicate work on one controller. The row
    // lock below is the cross-controller authority: rotating refresh tokens
    // are not safe under a process-local mutex alone.
    let refresh_lock = state.credential_refresh_locks.lock_for(credential_id).await;
    let _refresh_guard = refresh_lock.lock().await;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start credential lease transaction: {error}"
        ))
    })?;

    let row = transaction
        .query_opt(
            "select kind, nonce_b64, ciphertext_b64, metadata
             from user_credentials
             where id = $1 and revoked_at is null
             limit 1
             for update",
            &[&credential_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load credential: {error}")))?;

    let (effective_credential_id, row) = match row {
        Some(row) => (credential_id, row),
        None => resolve_revoked_credential_fallback(&transaction, credential_id).await?,
    };

    let kind: String = row.get("kind");
    let nonce_b64: String = row.get("nonce_b64");
    let ciphertext_b64: String = row.get("ciphertext_b64");
    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;

    let mut parsed = decode_authoritative_credential_payload(key, &nonce_b64, &ciphertext_b64)?;

    let auth_json_to_persist = if let Some(updated_auth_json) =
        maybe_refresh_codex_oauth_access_token(&state, &parsed, query.force_refresh).await?
    {
        Some(updated_auth_json)
    } else {
        maybe_refresh_gemini_oauth_access_token(&state, &metadata, &parsed).await?
    };

    if let Some(updated_auth_json) = auth_json_to_persist {
        let updated_plaintext = serde_json::to_vec(&updated_auth_json).map_err(|error| {
            internal_error(format!(
                "failed to encode refreshed credential payload: {error}"
            ))
        })?;
        let (updated_nonce_b64, updated_ciphertext_b64) =
            encrypt_secret_payload(key, &updated_plaintext).map_err(|error| {
                internal_error(format!(
                    "failed to encrypt refreshed credential payload: {error}"
                ))
            })?;
        transaction
            .execute(
                "update user_credentials
                 set nonce_b64 = $2, ciphertext_b64 = $3, updated_at = now()
                 where id = $1",
                &[
                    &effective_credential_id,
                    &updated_nonce_b64,
                    &updated_ciphertext_b64,
                ],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to persist refreshed credential payload: {error}"
                ))
            })?;
        parsed = updated_auth_json;
    }

    let response = materialize_internal_credential(&kind, &parsed, &metadata)?;

    transaction
        .execute(
            "update user_credentials set last_used_at = now(), updated_at = now() where id = $1",
            &[&effective_credential_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to update credential last_used_at: {error}"))
        })?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit credential lease transaction: {error}"
        ))
    })?;

    Ok(Json(response))
}

/// The owner's current default credential, loaded as a candidate replacement
/// for a revoked pinned credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FallbackCredentialCandidate {
    pub(crate) id: Uuid,
    pub(crate) user_id: Uuid,
    pub(crate) kind: String,
    pub(crate) metadata: JsonValue,
}

/// Authorization gate for the revoked-credential lease fallback: the candidate
/// must be owned by the same user the original lease was pinned to and must
/// resolve to the same provider. The SQL lookup already scopes candidates to
/// the pinned credential's owner; this check is deliberate defense in depth so
/// a future query change cannot silently lease a credential across users or
/// swap providers under a running job.
fn fallback_candidate_is_authorized(
    pinned_owner_user_id: Uuid,
    pinned_provider: &str,
    candidate: &FallbackCredentialCandidate,
) -> bool {
    candidate.user_id == pinned_owner_user_id
        && provider_for_credential(&candidate.kind, &candidate.metadata) == pinned_provider
}

/// The pinned credential id no longer resolves to a live row: routine
/// credential rotation revokes a credential and replaces it with an equivalent
/// default of the same provider, but running jobs keep the id they pinned at
/// creation. Fall back to the owner's current default credential for the same
/// provider so the job survives the rotation. Returns the effective credential
/// id together with its row (same columns as the primary lease query), or the
/// lease 404 when no authorized replacement exists.
async fn resolve_revoked_credential_fallback(
    transaction: &tokio_postgres::Transaction<'_>,
    pinned_credential_id: Uuid,
) -> Result<(Uuid, tokio_postgres::Row), (StatusCode, Json<ApiError>)> {
    let pinned = transaction
        .query_opt(
            "select user_id, kind, metadata
             from user_credentials
             where id = $1
             limit 1",
            &[&pinned_credential_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load revoked credential: {error}")))?;

    // The pinned row is gone entirely, so there is no owner to scope a
    // fallback to: keep the plain 404.
    let Some(pinned) = pinned else {
        return Err(not_found("credential not found"));
    };

    let pinned_owner_user_id: Uuid = pinned.get("user_id");
    let pinned_kind: String = pinned.get("kind");
    let pinned_metadata: JsonValue = pinned.get::<_, PgJson<JsonValue>>("metadata").0;
    let pinned_provider = provider_for_credential(&pinned_kind, &pinned_metadata);

    // Row-lock the candidate like the primary lease query does: token
    // refreshes on the fallback credential must stay serialized across
    // controllers (the process-local refresh mutex is keyed by the pinned id
    // on this path, so the row lock is the authority).
    let candidate_row = transaction
        .query_opt(
            "select id, user_id, kind, nonce_b64, ciphertext_b64, metadata
             from user_credentials
             where user_id = $1 and is_default = true and revoked_at is null
             order by updated_at desc, created_at desc
             limit 1
             for update",
            &[&pinned_owner_user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load fallback default credential: {error}"
            ))
        })?;

    let no_replacement = || {
        not_found(
            "credential not found: the pinned credential was revoked and no default \
             replacement with the same provider exists",
        )
    };

    let Some(candidate_row) = candidate_row else {
        return Err(no_replacement());
    };

    let candidate = FallbackCredentialCandidate {
        id: candidate_row.get("id"),
        user_id: candidate_row.get("user_id"),
        kind: candidate_row.get("kind"),
        metadata: candidate_row.get::<_, PgJson<JsonValue>>("metadata").0,
    };

    if !fallback_candidate_is_authorized(pinned_owner_user_id, &pinned_provider, &candidate) {
        return Err(no_replacement());
    }

    tracing::info!(
        pinned_credential_id = %pinned_credential_id,
        fallback_credential_id = %candidate.id,
        provider = %pinned_provider,
        "pinned credential is revoked; leasing the owner's current default credential instead"
    );

    Ok((candidate.id, candidate_row))
}

/// Store the latest BYOC subscription-usage snapshot for a credential. Called
/// by the proxy (fire-and-forget) after it captures OpenAI's x-codex-* rate
/// limit headers. Guarded by the same proxy credential-lease token as the
/// internal credential lease endpoint. The body is the opaque `subscriptionUsage`
/// contract JSON produced by the proxy; the controller persists it verbatim and
/// re-exposes it on GET /me/credentials.
async fn set_internal_credential_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(credential_id_raw): AxumPath<String>,
    Json(usage): Json<JsonValue>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    require_proxy_credential_lease_token(&state.config, &headers)?;

    let credential_id = Uuid::from_str(credential_id_raw.trim())
        .map_err(|_| bad_request("credentialId must be a valid UUID"))?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    let usage_param = PgJson(&usage);
    let updated = connection
        .execute(
            "update user_credentials
             set subscription_usage = $1, subscription_usage_updated_at = now()
             where id = $2 and revoked_at is null",
            &[&usage_param, &credential_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to persist credential subscription usage: {error}"
            ))
        })?;

    if updated == 0 {
        return Err(not_found("credential not found"));
    }

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct GoogleOauthRefreshResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexOauthRefreshResponse {
    id_token: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
}

fn chatgpt_access_token_expires_at(auth_json: &JsonValue) -> Option<DateTime<Utc>> {
    let token = auth_json
        .get("tokens")
        .and_then(JsonValue::as_object)
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let mut segments = token.split('.');
    let _header = segments.next()?;
    let payload = segments.next()?;
    let payload_bytes = BASE64
        .decode(format_base64url_for_decode(payload).as_bytes())
        .ok()?;
    let claims = serde_json::from_slice::<JsonValue>(&payload_bytes).ok()?;
    let exp = claims.get("exp").and_then(JsonValue::as_i64)?;
    DateTime::<Utc>::from_timestamp(exp, 0)
}

fn chatgpt_last_refresh_at(auth_json: &JsonValue) -> Option<DateTime<Utc>> {
    auth_json
        .get("last_refresh")
        .and_then(JsonValue::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn codex_auth_json_should_refresh(auth_json: &JsonValue, now: DateTime<Utc>) -> bool {
    if let Some(expires_at) = chatgpt_access_token_expires_at(auth_json) {
        return expires_at <= now + chrono::Duration::seconds(60);
    }

    let refresh_deadline =
        now - chrono::Duration::seconds(CODEX_ACCESS_TOKEN_REFRESH_MAX_AGE_SECONDS);
    match chatgpt_last_refresh_at(auth_json) {
        Some(last_refresh_at) => last_refresh_at <= refresh_deadline,
        None => true,
    }
}

fn format_base64url_for_decode(value: &str) -> String {
    let mut normalized = value.replace('-', "+").replace('_', "/");
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    normalized
}

async fn maybe_refresh_codex_oauth_access_token(
    state: &AppState,
    auth_json: &JsonValue,
    force_refresh: bool,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let Some(auth_map) = auth_json.as_object() else {
        return Ok(None);
    };
    let Some(tokens) = auth_map.get("tokens").and_then(JsonValue::as_object) else {
        return Ok(None);
    };

    let Some(refresh_token) = tokens
        .get("refresh_token")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    if !force_refresh && !codex_auth_json_should_refresh(auth_json, Utc::now()) {
        return Ok(None);
    }

    // A rotation that just happened (e.g. a concurrent 401's winner while we
    // waited on the per-credential refresh lock) already produced fresh
    // tokens; rotating again burns another refresh token for nothing. If the
    // fresh token still fails upstream, another rotation would not help.
    if force_refresh {
        if let Some(last_refresh) = chatgpt_last_refresh_at(auth_json) {
            if Utc::now() - last_refresh < chrono::Duration::seconds(30) {
                return Ok(None);
            }
        }
    }

    let refresh = match request_codex_oauth_refresh(state, refresh_token).await {
        Ok(refresh) => refresh,
        Err(message) => {
            // A failed rotation must not take down credential fetches while
            // the stored access token is still valid: the upstream validates
            // signature + expiry, so serving the stored token degrades
            // gracefully instead of hard-failing every runtime turn with an
            // error that masquerades as a model failure (2026-07-06 incident:
            // agent turns aborted ~350ms in, "Finishing response from saved
            // workspace context", hours of misdiagnosis).
            if should_serve_stale_codex_access_token_after_refresh_failure(
                auth_json,
                force_refresh,
                Utc::now(),
            ) {
                tracing::warn!(
                    %message,
                    "Codex OAuth refresh failed; serving the stored, still-valid access token instead of failing the credential fetch"
                );
                return Ok(None);
            }
            return Err(internal_error(message));
        }
    };

    let access_token = match refresh
        .access_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(access_token) => access_token,
        None => {
            let message = "Codex OAuth refresh returned no access_token".to_string();
            if should_serve_stale_codex_access_token_after_refresh_failure(
                auth_json,
                force_refresh,
                Utc::now(),
            ) {
                tracing::warn!(
                    %message,
                    "Codex OAuth refresh failed; serving the stored, still-valid access token instead of failing the credential fetch"
                );
                return Ok(None);
            }
            return Err(internal_error(message));
        }
    };

    let mut refreshed = auth_map.clone();
    let mut refreshed_tokens = tokens.clone();
    if let Some(id_token) = refresh
        .id_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        refreshed_tokens.insert(
            "id_token".to_string(),
            JsonValue::String(id_token.to_string()),
        );
    }
    refreshed_tokens.insert(
        "access_token".to_string(),
        JsonValue::String(access_token.to_string()),
    );
    if let Some(updated_refresh_token) = refresh
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        refreshed_tokens.insert(
            "refresh_token".to_string(),
            JsonValue::String(updated_refresh_token.to_string()),
        );
    }
    refreshed.insert("tokens".to_string(), JsonValue::Object(refreshed_tokens));
    refreshed.insert(
        "last_refresh".to_string(),
        JsonValue::String(Utc::now().to_rfc3339()),
    );

    Ok(Some(JsonValue::Object(refreshed)))
}

/// Performs the OAuth refresh request itself, returning the parsed response
/// or a human-readable failure message. Kept separate from
/// `maybe_refresh_codex_oauth_access_token` so the caller can decide whether
/// a failure is fatal (forced refresh / expired token) or degradable (the
/// stored access token is still valid).
async fn request_codex_oauth_refresh(
    state: &AppState,
    refresh_token: &str,
) -> Result<CodexOauthRefreshResponse, String> {
    let payload = json!({
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": "openid profile email"
    });
    let request = state
        .http_client
        .post(codex_oauth_token_url())
        .header("accept", "application/json")
        .header("content-type", "application/json")
        .json(&payload);

    let response = timeout(Duration::from_secs(12), request.send())
        .await
        .map_err(|_| "Codex OAuth refresh request timed out".to_string())?
        .map_err(|error| format!("Codex OAuth refresh request failed: {error}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Codex OAuth refresh response invalid: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "Codex OAuth refresh failed: {}",
            extract_refresh_error_message(&body)
        ));
    }

    serde_json::from_str(&body)
        .map_err(|error| format!("Codex OAuth refresh response invalid: {error}"))
}

/// After a FAILED refresh, decide between serving the stored access token and
/// hard-failing the credential fetch. Serving is safe only when the stored
/// token is demonstrably not yet expired (the upstream validates signature +
/// expiry, so it will keep working until its `exp`). Forced refreshes mean the
/// upstream already REJECTED the stored token — falling back would bounce, so
/// those stay hard failures. Tokens without a parseable `exp` claim cannot be
/// vouched for and also stay hard failures.
fn should_serve_stale_codex_access_token_after_refresh_failure(
    auth_json: &JsonValue,
    force_refresh: bool,
    now: DateTime<Utc>,
) -> bool {
    !force_refresh
        && chatgpt_access_token_expires_at(auth_json).is_some_and(|expires_at| expires_at > now)
}

fn extract_refresh_error_message(body: &str) -> String {
    let parsed = serde_json::from_str::<JsonValue>(body).ok();
    parsed
        .as_ref()
        .and_then(|value| value.get("error_description"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.get("error"))
                .and_then(|value| match value {
                    JsonValue::String(text) => Some(text.as_str()),
                    JsonValue::Object(map) => map.get("message").and_then(JsonValue::as_str),
                    _ => None,
                })
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("OAuth refresh failed")
        .to_string()
}

fn codex_oauth_token_url() -> String {
    std::env::var(CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR)
        .unwrap_or_else(|_| CODEX_OAUTH_TOKEN_URL.to_string())
}

async fn maybe_refresh_gemini_oauth_access_token(
    state: &AppState,
    metadata: &JsonValue,
    auth_json: &JsonValue,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let metadata_map = metadata.as_object();
    let provider = metadata_map
        .and_then(|map| map.get("provider"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if provider != PROVIDER_GEMINI {
        return Ok(None);
    }

    let source = metadata_map
        .and_then(|map| map.get("source"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if source != "google_oauth" {
        return Ok(None);
    }

    let auth_mode = metadata_map
        .and_then(|map| map.get("auth_mode"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !is_gemini_code_assist_mode(auth_mode.as_str()) {
        return Ok(None);
    }

    let auth_map = auth_json.as_object().ok_or_else(|| {
        internal_error("credential payload must be a JSON object for OAuth refresh")
    })?;
    let tokens = auth_map
        .get("tokens")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| internal_error("credential payload missing tokens object"))?;

    let refresh_token = tokens
        .get("refresh_token")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| internal_error("credential payload missing tokens.refresh_token"))?;

    let expires_at = tokens
        .get("expires_at")
        .and_then(JsonValue::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    if let Some(expires_at) = expires_at {
        if expires_at > Utc::now() + chrono::Duration::seconds(60) {
            return Ok(None);
        }
    }

    let (client_id, client_secret) = if auth_mode == GEMINI_AUTH_MODE_CODE_ASSIST_CLI {
        let client_id = read_env_trimmed("GEMINI_OAUTH_CLI_CLIENT_ID")
            .or_else(|| read_env_trimmed("GEMINI_OAUTH_CLIENT_ID"))
            .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_ID"))
            .ok_or_else(|| {
                internal_error(
                    "Gemini Google login refresh is not enabled. Reconnect Gemini with an API key.",
                )
            })?;
        let client_secret = read_env_trimmed("GEMINI_OAUTH_CLI_CLIENT_SECRET")
            .or_else(|| read_env_trimmed("GEMINI_OAUTH_CLIENT_SECRET"))
            .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_SECRET"));
        (client_id, client_secret)
    } else {
        let client_id = read_env_trimmed("GEMINI_OAUTH_CLIENT_ID")
            .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_ID"))
            .ok_or_else(|| {
                internal_error(
                    "Gemini OAuth refresh is not configured. Set GEMINI_OAUTH_CLIENT_ID (or GOOGLE_OAUTH_CLIENT_ID).",
                )
            })?;
        let client_secret = read_env_trimmed("GEMINI_OAUTH_CLIENT_SECRET")
            .or_else(|| read_env_trimmed("GOOGLE_OAUTH_CLIENT_SECRET"));
        (client_id, client_secret)
    };

    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret
        .as_deref()
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
    let response = timeout(Duration::from_secs(12), request.send())
        .await
        .map_err(|_| internal_error("Gemini OAuth refresh request timed out"))?
        .map_err(|error| internal_error(format!("Gemini OAuth refresh request failed: {error}")))?;

    let status = response.status();
    let payload: GoogleOauthRefreshResponse = response.json().await.map_err(|error| {
        internal_error(format!("Gemini OAuth refresh response invalid: {error}"))
    })?;

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
            .unwrap_or("OAuth refresh failed");
        return Err(internal_error(format!(
            "Gemini OAuth refresh failed: {message}"
        )));
    }

    let access_token = payload
        .access_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| internal_error("Gemini OAuth refresh returned no access_token"))?;

    let expires_in = payload.expires_in.unwrap_or(3600);
    let expires_at =
        Utc::now() + chrono::Duration::seconds(i64::try_from(expires_in).unwrap_or(3600));

    let mut refreshed = auth_map.clone();
    refreshed.insert(
        "OPENAI_API_KEY".to_string(),
        JsonValue::String(access_token.to_string()),
    );

    let mut refreshed_tokens = tokens.clone();
    refreshed_tokens.insert(
        "access_token".to_string(),
        JsonValue::String(access_token.to_string()),
    );
    refreshed_tokens.insert(
        "expires_in".to_string(),
        JsonValue::Number(serde_json::Number::from(expires_in)),
    );
    refreshed_tokens.insert(
        "expires_at".to_string(),
        JsonValue::String(expires_at.to_rfc3339()),
    );
    if let Some(refresh_token) = payload
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        refreshed_tokens.insert(
            "refresh_token".to_string(),
            JsonValue::String(refresh_token.to_string()),
        );
    }
    if let Some(token_type) = payload
        .token_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        refreshed_tokens.insert(
            "token_type".to_string(),
            JsonValue::String(token_type.to_string()),
        );
    }
    if let Some(scope) = payload
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        refreshed_tokens.insert("scope".to_string(), JsonValue::String(scope.to_string()));
    }
    refreshed.insert("tokens".to_string(), JsonValue::Object(refreshed_tokens));

    Ok(Some(JsonValue::Object(refreshed)))
}

fn read_env_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_gemini_code_assist_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        GEMINI_AUTH_MODE_CODE_ASSIST | GEMINI_AUTH_MODE_CODE_ASSIST_CLI
    )
}

fn require_proxy_credential_lease_token(
    config: &crate::AppConfig,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let expected = config.proxy_credential_lease_token.as_deref();
    let presented = bearer_token(headers);
    if let (Some(expected), Some(presented)) = (expected, presented.as_deref()) {
        let expected_digest = Sha256::digest(expected.as_bytes());
        let presented_digest = Sha256::digest(presented.as_bytes());
        if expected_digest.ct_eq(&presented_digest).unwrap_u8() == 1 {
            return Ok(());
        }
    }
    Err(unauthorized("credential lease authorization failed"))
}

fn classify_auth_json(
    auth: &JsonMap<String, JsonValue>,
) -> Result<(String, JsonValue), (StatusCode, Json<ApiError>)> {
    let openai_api_key = auth
        .get("OPENAI_API_KEY")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let token_object = auth.get("tokens").and_then(JsonValue::as_object);
    let access_token = token_object
        .and_then(|map| map.get("access_token"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let account_id = token_object
        .and_then(|map| map.get("account_id"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let mut metadata_map = JsonMap::new();
    metadata_map.insert(
        "source".to_string(),
        JsonValue::String("codex_cli".to_string()),
    );
    if let Some(id) = account_id.as_deref() {
        metadata_map.insert("account_id".to_string(), JsonValue::String(id.to_string()));
    }

    if access_token.is_some() {
        return Ok((
            CREDENTIAL_KIND_CODEX_AUTH_JSON.to_string(),
            JsonValue::Object(metadata_map),
        ));
    }
    if openai_api_key.is_some() {
        return Ok((
            CREDENTIAL_KIND_OPENAI_API_KEY.to_string(),
            JsonValue::Object(metadata_map),
        ));
    }

    Err(bad_request(
        "authJson must include tokens.access_token or OPENAI_API_KEY",
    ))
}

fn materialize_internal_credential(
    kind: &str,
    auth_json: &JsonValue,
    metadata: &JsonValue,
) -> Result<InternalCredentialResponse, (StatusCode, Json<ApiError>)> {
    let auth = auth_json
        .as_object()
        .ok_or_else(|| internal_error("credential payload must be an object"))?;

    let metadata_map = metadata.as_object();
    let provider = metadata_map
        .and_then(|map| map.get("provider"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let upstream_endpoint = metadata_map
        .and_then(|map| map.get("upstream_endpoint"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let default_model = metadata_map
        .and_then(|map| map.get("default_model"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let auth_mode = metadata_map
        .and_then(|map| map.get("auth_mode"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let code_assist_project = metadata_map
        .and_then(|map| map.get("code_assist_project"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if kind == CREDENTIAL_KIND_OPENAI_API_KEY {
        let provider = provider.or_else(|| Some(PROVIDER_OPENAI.to_string()));
        let provider_key = provider
            .as_deref()
            .unwrap_or(PROVIDER_OPENAI)
            .trim()
            .to_ascii_lowercase();
        let upstream_endpoint = upstream_endpoint
            .or_else(|| Some(default_endpoint_for_provider(&provider_key).to_string()));
        let default_model =
            default_model.or_else(|| Some(default_model_for_provider(&provider_key).to_string()));

        let key = auth
            .get("OPENAI_API_KEY")
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| internal_error("credential missing OPENAI_API_KEY"))?;

        return Ok(InternalCredentialResponse {
            kind: CREDENTIAL_KIND_OPENAI_API_KEY.to_string(),
            access_token: None,
            account_id: None,
            openai_api_key: Some(key),
            provider,
            upstream_endpoint,
            default_model,
            auth_mode,
            code_assist_project,
            lease_expires_in_seconds: INTERNAL_CREDENTIAL_LEASE_SECONDS,
            renewal_authority: "controller",
        });
    }

    let tokens = auth
        .get("tokens")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| internal_error("credential missing tokens object"))?;

    let access_token = tokens
        .get("access_token")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| internal_error("credential missing tokens.access_token"))?;

    let account_id = tokens
        .get("account_id")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(InternalCredentialResponse {
        kind: CREDENTIAL_KIND_CODEX_AUTH_JSON.to_string(),
        access_token: Some(access_token),
        account_id,
        openai_api_key: None,
        provider,
        upstream_endpoint,
        default_model: default_model.or_else(|| Some(default_managed_ai_model_id().to_string())),
        auth_mode,
        code_assist_project,
        lease_expires_in_seconds: INTERNAL_CREDENTIAL_LEASE_SECONDS,
        renewal_authority: "controller",
    })
}

fn normalize_provider_id(raw: Option<&str>) -> Option<String> {
    raw.map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .map(|value| match value.as_str() {
            PROVIDER_OPENAI => PROVIDER_OPENAI.to_string(),
            PROVIDER_DEEPSEEK => PROVIDER_DEEPSEEK.to_string(),
            PROVIDER_ZAI => PROVIDER_ZAI.to_string(),
            PROVIDER_GEMINI | "google" | "google-ai" | "google_gemini" | "google-gemini" => {
                PROVIDER_GEMINI.to_string()
            }
            _ => PROVIDER_OPENAI.to_string(),
        })
}

pub(crate) fn provider_for_credential(kind: &str, metadata: &JsonValue) -> String {
    if kind == CREDENTIAL_KIND_CODEX_AUTH_JSON {
        return PROVIDER_OPENAI.to_string();
    }
    let provider_hint = metadata
        .as_object()
        .and_then(|map| map.get("provider"))
        .and_then(JsonValue::as_str);
    normalize_provider_id(provider_hint).unwrap_or_else(|| PROVIDER_OPENAI.to_string())
}

fn default_endpoint_for_provider(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        PROVIDER_DEEPSEEK => DEFAULT_DEEPSEEK_ENDPOINT,
        PROVIDER_ZAI => DEFAULT_ZAI_ENDPOINT,
        PROVIDER_GEMINI => DEFAULT_GEMINI_ENDPOINT,
        _ => DEFAULT_OPENAI_ENDPOINT,
    }
}

fn default_model_for_credential(kind: &str, provider: &str) -> &'static str {
    if kind.trim() == CREDENTIAL_KIND_CODEX_AUTH_JSON {
        return default_managed_ai_model_id();
    }
    default_model_for_provider(provider)
}

fn augment_metadata_with_provider(
    kind: &str,
    metadata: JsonValue,
    provider_hint: Option<&str>,
) -> JsonValue {
    let mut map = metadata.as_object().cloned().unwrap_or_default();

    let provider = if kind == CREDENTIAL_KIND_CODEX_AUTH_JSON {
        PROVIDER_OPENAI.to_string()
    } else {
        normalize_provider_id(provider_hint).unwrap_or_else(|| PROVIDER_OPENAI.to_string())
    };
    map.insert("provider".to_string(), JsonValue::String(provider.clone()));

    if kind == CREDENTIAL_KIND_OPENAI_API_KEY {
        map.insert(
            "upstream_endpoint".to_string(),
            JsonValue::String(default_endpoint_for_provider(&provider).to_string()),
        );
        map.insert(
            "default_model".to_string(),
            JsonValue::String(default_model_for_provider(&provider).to_string()),
        );
    } else if kind == CREDENTIAL_KIND_CODEX_AUTH_JSON {
        map.insert(
            "default_model".to_string(),
            JsonValue::String(default_managed_ai_model_id().to_string()),
        );
    }

    JsonValue::Object(map)
}

fn encrypt_secret_payload(
    key: &CredentialEncryptionKey,
    plaintext: &[u8],
) -> anyhow::Result<(String, String)> {
    let cipher = Aes256Gcm::new_from_slice(key.as_bytes())?;
    let nonce_bytes = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce_bytes, plaintext)
        .map_err(|error| anyhow::anyhow!("failed to encrypt credential payload: {error:?}"))?;
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
        .map_err(|error| anyhow::anyhow!("failed to decrypt credential payload: {error:?}"))?;
    Ok(plaintext)
}

fn decode_authoritative_credential_payload(
    key: &CredentialEncryptionKey,
    nonce_b64: &str,
    ciphertext_b64: &str,
) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let plaintext = decrypt_secret_payload(key, nonce_b64, ciphertext_b64).map_err(|error| {
        internal_error(format!("failed to decrypt credential payload: {error}"))
    })?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| internal_error(format!("credential payload is not valid JSON: {error}")))
}

#[cfg(test)]
mod provider_metadata_tests {
    use super::{
        augment_metadata_with_provider, default_endpoint_for_provider,
        default_model_for_credential, normalize_provider_id, provider_for_credential,
        CREDENTIAL_KIND_CODEX_AUTH_JSON, CREDENTIAL_KIND_OPENAI_API_KEY, PROVIDER_GEMINI,
        PROVIDER_OPENAI,
    };
    use crate::model_defaults::{default_managed_ai_model_id, default_model_for_provider};
    use serde_json::json;

    #[test]
    fn normalize_provider_id_accepts_gemini_aliases() {
        assert_eq!(
            normalize_provider_id(Some("gemini")).as_deref(),
            Some(PROVIDER_GEMINI)
        );
        assert_eq!(
            normalize_provider_id(Some("google")).as_deref(),
            Some(PROVIDER_GEMINI)
        );
        assert_eq!(
            normalize_provider_id(Some("google-ai")).as_deref(),
            Some(PROVIDER_GEMINI)
        );
    }

    #[test]
    fn provider_defaults_include_gemini_upstream_and_model() {
        assert_eq!(
            default_endpoint_for_provider(PROVIDER_GEMINI),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(
            default_model_for_provider(PROVIDER_GEMINI),
            "gemini-2.5-pro"
        );
    }

    #[test]
    fn provider_defaults_use_latest_general_openai_model_for_api_keys() {
        assert_eq!(default_model_for_provider(PROVIDER_OPENAI), "gpt-5.6-sol");
    }

    #[test]
    fn augment_metadata_with_provider_sets_gemini_defaults_for_api_keys() {
        let metadata = augment_metadata_with_provider(
            CREDENTIAL_KIND_OPENAI_API_KEY,
            json!({ "source": "codex_cli" }),
            Some("gemini"),
        );

        assert_eq!(
            metadata.get("provider").and_then(|value| value.as_str()),
            Some("gemini")
        );
        assert_eq!(
            metadata
                .get("upstream_endpoint")
                .and_then(|value| value.as_str()),
            Some("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
        );
        assert_eq!(
            metadata
                .get("default_model")
                .and_then(|value| value.as_str()),
            Some("gemini-2.5-pro")
        );
    }

    #[test]
    fn augment_metadata_with_provider_sets_codex_default_for_chatgpt_credentials() {
        let metadata = augment_metadata_with_provider(
            CREDENTIAL_KIND_CODEX_AUTH_JSON,
            json!({ "source": "codex_cli" }),
            None,
        );

        assert_eq!(
            metadata.get("provider").and_then(|value| value.as_str()),
            Some(PROVIDER_OPENAI)
        );
        assert_eq!(
            metadata
                .get("default_model")
                .and_then(|value| value.as_str()),
            Some(default_managed_ai_model_id())
        );
    }

    #[test]
    fn provider_for_credential_prefers_codex_kind_and_falls_back_to_openai() {
        assert_eq!(
            provider_for_credential(CREDENTIAL_KIND_CODEX_AUTH_JSON, &json!({"provider":"zai"})),
            PROVIDER_OPENAI
        );
        assert_eq!(
            provider_for_credential(CREDENTIAL_KIND_OPENAI_API_KEY, &json!({"provider":"zai"})),
            "zai"
        );
        assert_eq!(
            provider_for_credential(CREDENTIAL_KIND_OPENAI_API_KEY, &json!({})),
            PROVIDER_OPENAI
        );
        assert_eq!(
            default_model_for_credential(CREDENTIAL_KIND_CODEX_AUTH_JSON, PROVIDER_OPENAI),
            default_managed_ai_model_id()
        );
    }
}

#[cfg(test)]
mod revoked_credential_fallback_tests {
    use super::{
        fallback_candidate_is_authorized, provider_for_credential, FallbackCredentialCandidate,
        CREDENTIAL_KIND_CODEX_AUTH_JSON, CREDENTIAL_KIND_OPENAI_API_KEY, PROVIDER_OPENAI,
    };
    use serde_json::json;
    use uuid::Uuid;

    fn candidate(
        user_id: Uuid,
        kind: &str,
        metadata: serde_json::Value,
    ) -> FallbackCredentialCandidate {
        FallbackCredentialCandidate {
            id: Uuid::new_v4(),
            user_id,
            kind: kind.to_string(),
            metadata,
        }
    }

    #[test]
    fn accepts_same_owner_and_same_provider() {
        let owner = Uuid::new_v4();
        let replacement = candidate(
            owner,
            CREDENTIAL_KIND_OPENAI_API_KEY,
            json!({ "provider": "openai" }),
        );
        assert!(fallback_candidate_is_authorized(
            owner,
            PROVIDER_OPENAI,
            &replacement
        ));
    }

    #[test]
    fn rejects_a_credential_owned_by_another_user() {
        let owner = Uuid::new_v4();
        let other_user = Uuid::new_v4();
        let replacement = candidate(
            other_user,
            CREDENTIAL_KIND_OPENAI_API_KEY,
            json!({ "provider": "openai" }),
        );
        assert!(!fallback_candidate_is_authorized(
            owner,
            PROVIDER_OPENAI,
            &replacement
        ));
    }

    #[test]
    fn rejects_a_default_with_a_different_provider() {
        let owner = Uuid::new_v4();
        let replacement = candidate(
            owner,
            CREDENTIAL_KIND_OPENAI_API_KEY,
            json!({ "provider": "gemini" }),
        );
        assert!(!fallback_candidate_is_authorized(
            owner,
            PROVIDER_OPENAI,
            &replacement
        ));
    }

    #[test]
    fn matches_providers_across_credential_kinds() {
        // A revoked openai API-key credential may be replaced by a codex
        // (ChatGPT auth.json) default: both resolve to the openai provider.
        let owner = Uuid::new_v4();
        let pinned_provider = provider_for_credential(
            CREDENTIAL_KIND_OPENAI_API_KEY,
            &json!({ "provider": "openai" }),
        );
        let replacement = candidate(
            owner,
            CREDENTIAL_KIND_CODEX_AUTH_JSON,
            json!({ "source": "codex_cli" }),
        );
        assert!(fallback_candidate_is_authorized(
            owner,
            &pinned_provider,
            &replacement
        ));
    }

    #[test]
    fn rejects_when_pinned_provider_is_not_openai_and_default_lacks_provider_metadata() {
        // Metadata without a provider hint resolves to openai, which must not
        // satisfy a zai-pinned lease.
        let owner = Uuid::new_v4();
        let replacement = candidate(owner, CREDENTIAL_KIND_OPENAI_API_KEY, json!({}));
        assert!(!fallback_candidate_is_authorized(
            owner,
            "zai",
            &replacement
        ));
    }
}

#[cfg(test)]
mod inline_completion_tests {
    use super::{
        sanitize_inline_completion, strip_wrapping_code_fences, take_first_chars, take_last_chars,
    };

    #[test]
    fn sanitize_inline_completion_removes_prefix_and_suffix_overlap() {
        let completion = sanitize_inline_completion("conversationId", "conver", "Id");
        assert_eq!(completion.as_deref(), Some("sation"));
    }

    #[test]
    fn sanitize_inline_completion_strips_wrapping_code_fences() {
        let stripped = strip_wrapping_code_fences("```ts\nconst total = subtotal + tax;\n```");
        assert_eq!(stripped, "const total = subtotal + tax;");
    }

    #[test]
    fn sanitize_inline_completion_drops_whitespace_only_results() {
        let completion = sanitize_inline_completion("   \n\t", "prefix", "suffix");
        assert_eq!(completion, None);
    }

    #[test]
    fn completion_context_helpers_clamp_from_each_side() {
        assert_eq!(take_first_chars("abcdef", 3), "abc");
        assert_eq!(take_last_chars("abcdef", 3), "def");
    }
}

#[cfg(test)]
mod conversation_title_tests {
    use super::sanitize_conversation_title;

    #[test]
    fn sanitize_conversation_title_trims_quotes_and_trailing_punctuation() {
        let title = sanitize_conversation_title("\"Invite teammate.\"");
        assert_eq!(title.as_deref(), Some("Invite teammate"));
    }

    #[test]
    fn sanitize_conversation_title_drops_empty_results() {
        let title = sanitize_conversation_title("   \n\t");
        assert_eq!(title, None);
    }

    #[test]
    fn sanitize_conversation_title_only_keeps_first_line() {
        let title = sanitize_conversation_title("Title: Launch checklist\n- ignore this");
        assert_eq!(title.as_deref(), Some("Launch checklist"));
    }
}

#[cfg(test)]
mod codex_refresh_tests {
    use super::codex_auth_json_should_refresh;
    use super::should_serve_stale_codex_access_token_after_refresh_failure;
    use base64::Engine;
    use chrono::{Duration, Utc};
    use serde_json::json;

    fn fake_jwt(exp: i64) -> String {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
        format!("{header}.{payload}.signature")
    }

    #[test]
    fn failed_refresh_serves_stored_token_only_while_valid_and_unforced() {
        // Pins the 2026-07-06 fix: a failed (non-forced) refresh must not
        // hard-fail the credential fetch while the stored access token is
        // still valid — that outage aborted every runtime turn ~350ms in and
        // masqueraded as a model failure.
        let now = Utc::now();
        let valid = json!({
            "tokens": { "access_token": fake_jwt((now + Duration::days(3)).timestamp()) }
        });
        let expired = json!({
            "tokens": { "access_token": fake_jwt((now - Duration::hours(1)).timestamp()) }
        });
        let no_exp = json!({
            "tokens": { "access_token": "not-a-jwt" }
        });

        // Valid token + organic refresh failure: degrade gracefully.
        assert!(should_serve_stale_codex_access_token_after_refresh_failure(
            &valid, false, now
        ));
        // Forced refresh means the upstream already rejected the stored
        // token; serving it again would bounce.
        assert!(!should_serve_stale_codex_access_token_after_refresh_failure(&valid, true, now));
        // Expired token: nothing valid to serve.
        assert!(!should_serve_stale_codex_access_token_after_refresh_failure(&expired, false, now));
        // Unparseable exp: cannot vouch for the token.
        assert!(!should_serve_stale_codex_access_token_after_refresh_failure(&no_exp, false, now));
    }

    #[test]
    fn codex_refresh_skips_stale_last_refresh_when_jwt_exp_is_far_out() {
        let now = Utc::now();
        let auth = json!({
            "last_refresh": (now - Duration::days(13)).to_rfc3339(),
            "tokens": {
                "access_token": fake_jwt((now + Duration::days(7)).timestamp()),
                "refresh_token": "refresh-token"
            }
        });

        assert!(!codex_auth_json_should_refresh(&auth, now));
    }

    #[test]
    fn codex_refresh_skips_recent_tokens_with_distant_expiry() {
        let now = Utc::now();
        let auth = json!({
            "last_refresh": (now - Duration::minutes(5)).to_rfc3339(),
            "tokens": {
                "access_token": fake_jwt((now + Duration::days(7)).timestamp()),
                "refresh_token": "refresh-token"
            }
        });

        assert!(!codex_auth_json_should_refresh(&auth, now));
    }

    #[test]
    fn codex_refresh_requires_last_refresh_only_when_expiry_cannot_be_inferred() {
        let now = Utc::now();
        let auth = json!({
            "tokens": {
                "access_token": "opaque-access-token",
                "refresh_token": "refresh-token"
            }
        });

        assert!(codex_auth_json_should_refresh(&auth, now));
    }

    #[test]
    fn codex_refresh_uses_jwt_expiry_even_without_last_refresh() {
        let now = Utc::now();
        let auth = json!({
            "tokens": {
                "access_token": fake_jwt((now + Duration::days(7)).timestamp()),
                "refresh_token": "refresh-token"
            }
        });

        assert!(!codex_auth_json_should_refresh(&auth, now));
    }
}

#[cfg(test)]
mod credential_lease_contract_tests {
    use super::{
        decode_authoritative_credential_payload, encrypt_secret_payload,
        materialize_internal_credential, require_proxy_credential_lease_token,
        CREDENTIAL_KIND_CODEX_AUTH_JSON, CREDENTIAL_KIND_OPENAI_API_KEY,
        INTERNAL_CREDENTIAL_LEASE_SECONDS,
    };
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::{json, Value};

    use crate::tests::build_app_config;

    #[test]
    fn credential_lease_route_accepts_only_its_dedicated_bearer() {
        let config = build_app_config("", "", "");
        for (token, accepted) in [
            ("credential-lease", true),
            ("internal", false),
            ("service-role-token", false),
            ("wrong", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                axum::http::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .expect("test bearer should be a valid header"),
            );
            assert_eq!(
                require_proxy_credential_lease_token(&config, &headers).is_ok(),
                accepted,
                "unexpected authorization result for {token}",
            );
        }

        let mut unconfigured = config;
        unconfigured.proxy_credential_lease_token = None;
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer credential-lease"),
        );
        assert!(require_proxy_credential_lease_token(&unconfigured, &headers).is_err());
    }

    #[test]
    fn delegated_lease_decodes_only_the_encrypted_record() {
        let config = build_app_config("", "", "");
        let key = config
            .credential_encryption_key
            .unwrap_or_else(|| crate::config::CredentialEncryptionKey::for_test("record-a"));
        let record = json!({
            "tokens": {
                "access_token": "record-a-access",
                "refresh_token": "record-a-refresh"
            }
        });
        let encoded = serde_json::to_vec(&record).expect("record should encode");
        let (nonce, ciphertext) =
            encrypt_secret_payload(&key, &encoded).expect("record should encrypt");

        assert_eq!(
            decode_authoritative_credential_payload(&key, &nonce, &ciphertext)
                .expect("stored record should decode"),
            record,
        );
    }

    #[test]
    fn delegated_lease_is_short_lived_and_keeps_renewal_in_controller() {
        let response = materialize_internal_credential(
            CREDENTIAL_KIND_CODEX_AUTH_JSON,
            &json!({
                "tokens": {
                    "access_token": "test-access-token",
                    "refresh_token": "test-refresh-token",
                    "account_id": "acct_test"
                }
            }),
            &json!({ "provider": "openai" }),
        )
        .expect("credential should materialize");
        let wire = serde_json::to_value(response).expect("response should serialize");

        assert_eq!(
            wire.get("leaseExpiresInSeconds").and_then(Value::as_u64),
            Some(INTERNAL_CREDENTIAL_LEASE_SECONDS)
        );
        assert_eq!(
            wire.get("renewalAuthority").and_then(Value::as_str),
            Some("controller")
        );
        assert!(wire.get("accessToken").is_some());
        assert!(wire.get("refreshToken").is_none());
    }

    #[test]
    fn api_key_lease_preserves_api_key_material_and_routing_summary() {
        let response = materialize_internal_credential(
            CREDENTIAL_KIND_OPENAI_API_KEY,
            &json!({ "OPENAI_API_KEY": "test-api-key" }),
            &json!({
                "provider": "openai",
                "upstream_endpoint": "https://api.openai.test/v1/responses",
                "default_model": "gpt-test"
            }),
        )
        .expect("credential should materialize");
        let wire = serde_json::to_value(response).expect("response should serialize");

        assert!(wire.get("openaiApiKey").is_some());
        assert_eq!(wire.get("provider").and_then(Value::as_str), Some("openai"));
        assert_eq!(
            wire.get("defaultModel").and_then(Value::as_str),
            Some("gpt-test")
        );
        assert_eq!(
            wire.get("renewalAuthority").and_then(Value::as_str),
            Some("controller")
        );
    }
}

#[cfg(test)]
mod requirement_tests {
    use super::{
        build_managed_ai_access_response, ensure_managed_ai_proxy_ready,
        fetch_proxy_credential_requirements, ProxyCredentialRequirements,
    };
    use crate::tests::{build_app_config, test_origin_private_key, test_origin_public_key};

    use axum::routing::get;
    use axum::{Json, Router};
    use httpmock::Method::GET;
    use httpmock::MockServer;
    use serde_json::json;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn proxy_requirements_fail_closed_on_error_status() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/healthz");
                then.status(500).json_body(json!({}));
            })
            .await;

        let client = reqwest::Client::new();
        let result = fetch_proxy_credential_requirements(
            &client,
            &server.base_url(),
            std::time::Duration::from_secs(1),
        )
        .await;

        mock.assert_async().await;
        assert!(result.requires_user_credentials);
        assert_eq!(result.proxy_backend, "unknown");
        assert_eq!(result.error.as_deref(), Some("proxy returned 500"));
    }

    #[tokio::test]
    async fn proxy_requirements_defaults_to_require_credentials_when_field_missing() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/healthz");
                then.status(200).json_body(json!({ "backend": "codex" }));
            })
            .await;

        let client = reqwest::Client::new();
        let result = fetch_proxy_credential_requirements(
            &client,
            &server.base_url(),
            std::time::Duration::from_secs(1),
        )
        .await;

        mock.assert_async().await;
        assert!(result.requires_user_credentials);
        assert_eq!(result.proxy_backend, "codex");
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn proxy_requirements_respects_requires_credential_false() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/healthz");
                then.status(200)
                    .json_body(json!({ "backend": "codex", "requiresCredential": false }));
            })
            .await;

        let client = reqwest::Client::new();
        let result = fetch_proxy_credential_requirements(
            &client,
            &server.base_url(),
            std::time::Duration::from_secs(1),
        )
        .await;

        mock.assert_async().await;
        assert!(!result.requires_user_credentials);
        assert_eq!(result.proxy_backend, "codex");
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn proxy_requirements_fail_closed_on_timeout() {
        let app = Router::new().route(
            "/healthz",
            get(|| async {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                Json(json!({ "backend": "codex", "requiresCredential": false }))
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("server");
        });

        let client = reqwest::Client::new();
        let result = fetch_proxy_credential_requirements(
            &client,
            &format!("http://{}", addr),
            std::time::Duration::from_millis(5),
        )
        .await;

        assert!(result.requires_user_credentials);
        assert_eq!(result.proxy_backend, "unknown");
        assert_eq!(result.error.as_deref(), Some("proxy request timed out"));

        let _ = shutdown_tx.send(());
        let _ = server.await;
    }

    #[test]
    fn managed_ai_is_available_when_proxy_allows_it_and_user_has_no_default() {
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-key-id",
        );
        let managed_ai = build_managed_ai_access_response(
            &config,
            &ProxyCredentialRequirements {
                requires_user_credentials: false,
                proxy_backend: "codex".to_string(),
                error: None,
            },
            false,
            3,
        );

        assert!(managed_ai.enabled);
        assert!(managed_ai.available);
        assert_eq!(managed_ai.label, "Instafy AI");
        assert_eq!(managed_ai.credit_burn_amount, 1);
        assert_eq!(managed_ai.daily_prompt_limit, 20);
        assert_eq!(managed_ai.remaining_prompts, Some(17));
    }

    #[test]
    fn managed_ai_becomes_unavailable_after_daily_limit() {
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-key-id",
        );
        let managed_ai = build_managed_ai_access_response(
            &config,
            &ProxyCredentialRequirements {
                requires_user_credentials: false,
                proxy_backend: "codex".to_string(),
                error: None,
            },
            false,
            20,
        );

        assert!(managed_ai.enabled);
        assert!(!managed_ai.available);
        assert_eq!(managed_ai.remaining_prompts, Some(0));
    }

    #[tokio::test]
    async fn managed_ai_startup_check_accepts_proxy_with_static_credentials() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/healthz");
                then.status(200)
                    .json_body(json!({ "backend": "codex", "requiresCredential": false }));
            })
            .await;

        let client = reqwest::Client::new();
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-key-id",
        );
        config.proxy_base_url = Some(server.base_url());
        config.managed_ai_startup_check = true;

        ensure_managed_ai_proxy_ready(&client, &config)
            .await
            .expect("managed AI proxy should be ready");

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn managed_ai_startup_check_rejects_proxy_without_static_credentials() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(GET).path("/healthz");
                then.status(200)
                    .json_body(json!({ "backend": "codex", "requiresCredential": true }));
            })
            .await;

        let client = reqwest::Client::new();
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-key-id",
        );
        config.proxy_base_url = Some(server.base_url());
        config.managed_ai_startup_check = true;

        let error = ensure_managed_ai_proxy_ready(&client, &config)
            .await
            .expect_err("managed AI proxy should fail when it requires user credentials");

        assert!(mock.hits_async().await >= 1);
        assert!(
            error
                .to_string()
                .contains("proxy reports requiresCredential=true"),
            "unexpected error: {error}"
        );
        assert_eq!(mock.hits_async().await, 15);
    }

    #[test]
    fn managed_ai_startup_retries_back_off_for_slow_proxy_dns() {
        let delays = (0..14)
            .map(super::managed_ai_startup_retry_delay)
            .collect::<Vec<_>>();

        assert_eq!(delays[0], std::time::Duration::from_millis(500));
        assert_eq!(delays[1], std::time::Duration::from_secs(1));
        assert_eq!(delays[2], std::time::Duration::from_secs(2));
        assert_eq!(delays[3], std::time::Duration::from_secs(4));
        assert!(delays[4..]
            .iter()
            .all(|delay| *delay == std::time::Duration::from_secs(8)));
        assert_eq!(delays.iter().sum::<std::time::Duration>().as_secs(), 87);
    }
}

#[cfg(test)]
mod session_identity_tests {
    use super::my_session_response;
    use crate::auth::RequestContext;
    use uuid::Uuid;

    #[test]
    fn session_response_contains_only_authenticated_user_id() {
        let user_id = Uuid::new_v4();
        let response = my_session_response(RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        })
        .expect("user session should be accepted");
        assert_eq!(response.user_id, user_id.to_string());
    }

    #[test]
    fn session_response_rejects_non_user_credentials() {
        let error = my_session_response(RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        })
        .expect_err("service credentials must not select a Personal Browser profile");
        assert_eq!(error.0, axum::http::StatusCode::UNAUTHORIZED);
    }
}
