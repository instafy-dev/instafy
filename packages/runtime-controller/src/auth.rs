use std::borrow::Cow;
use std::str::FromStr;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{Duration as ChronoDuration, Utc};
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{decode, decode_header, encode, Algorithm, EncodingKey, Header, Validation};
use runtime_contracts::ProxyEnvelopePayload;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tracing::{info, warn};
use uuid::Uuid;

#[cfg(test)]
use crate::model_defaults::{
    default_managed_ai_model_id, default_managed_ai_model_label,
    DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K, DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K,
    DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K,
};
use crate::{
    internal_error,
    tokens::{mint_scoped_token_with_runtime_generation, MintedAccessToken, ScopedTokenRequest},
    unauthorized, ApiError, AppConfig, AppState,
};

pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

pub(crate) fn claims_have_scopes(
    claims: &runtime_contracts::AccessTokenClaims,
    required: &[&str],
) -> bool {
    required
        .iter()
        .all(|scope| claims.scopes.iter().any(|s| s == scope))
}

#[derive(Debug, Deserialize)]
struct SupabaseClaims {
    sub: Option<String>,
    #[serde(rename = "user_id")]
    user_id: Option<String>,
    role: Option<String>,
    aud: Option<String>,
    #[serde(rename = "exp")]
    _exp: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct UserTokenClaims {
    aud: String,
    role: String,
    sub: String,
    #[serde(default)]
    session_id: Option<String>,
    iat: i64,
    exp: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct RequestContext {
    pub(crate) user_id: Option<Uuid>,
    pub(crate) is_service_role: bool,
    pub(crate) scoped_claims: Option<runtime_contracts::AccessTokenClaims>,
}

/// Return the signed-in human user for account-level actions.
///
/// Scoped runtime/origin tokens intentionally retain their subject so exact
/// capability handlers can attribute work. That subject must never be treated
/// as a reusable interactive login for `/me/*` or session-minting endpoints.
pub(crate) fn require_user_session(
    context: &RequestContext,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() || context.is_service_role {
        return Err(unauthorized("interactive user session required"));
    }
    context
        .user_id
        .ok_or_else(|| unauthorized("user session required"))
}

fn decode_scoped_access_token(
    config: &AppConfig,
    token: &str,
) -> Result<Option<runtime_contracts::AccessTokenClaims>, (StatusCode, Json<ApiError>)> {
    let decoding_source = match config
        .origin_token_public_key
        .as_ref()
        .or(config.origin_token_private_key.as_ref())
    {
        Some(value) => value,
        None => return Ok(None),
    };

    let decoding_key =
        jsonwebtoken::DecodingKey::from_ed_pem(decoding_source.as_bytes()).map_err(|error| {
            internal_error(format!(
                "failed to construct Ed25519 decoding key from PEM: {error}"
            ))
        })?;

    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.validate_exp = true;
    validation.validate_aud = false;

    match decode::<runtime_contracts::AccessTokenClaims>(token, &decoding_key, &validation) {
        Ok(data) => Ok(Some(data.claims)),
        Err(error) => match error.kind() {
            JwtErrorKind::ExpiredSignature => Err(unauthorized("access token expired")),
            JwtErrorKind::InvalidSignature | JwtErrorKind::InvalidToken => Ok(None),
            other => {
                tracing::warn!(?other, "failed to decode scoped access token");
                Err(unauthorized("invalid access token"))
            }
        },
    }
}

async fn refresh_supabase_jwks_on_auth_retry(config: &AppConfig) -> bool {
    if !config.supabase_jwks_refresh_enabled {
        return false;
    }

    match crate::jwks::SupabaseJwks::load_async(&reqwest::Client::new(), &config.supabase_jwks_url)
        .await
    {
        Ok(next) => {
            let mut guard = config.supabase_jwks.write().await;
            *guard = next;
            true
        }
        Err(error) => {
            warn!(
                %error,
                jwks_url = %config.supabase_jwks_url,
                "failed to refresh Supabase JWKS during auth retry"
            );
            false
        }
    }
}

pub(crate) async fn authenticate_request(
    config: &AppConfig,
    headers: &HeaderMap,
) -> Result<RequestContext, (StatusCode, Json<ApiError>)> {
    let Some(raw_value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(RequestContext {
            user_id: None,
            is_service_role: false,
            scoped_claims: None,
        });
    };

    if !raw_value.starts_with("Bearer ") {
        return Err(unauthorized("authorization header must be Bearer token"));
    }
    let token = raw_value.trim_start_matches("Bearer ").trim().to_string();

    if token.is_empty() {
        return Err(unauthorized("authorization token is empty"));
    }

    info!(
        token_len = token.len(),
        "access token received from authorization header"
    );

    if let Some(internal_token) = config.controller_internal_token.as_ref() {
        if ConstantTimeEq::ct_eq(token.as_bytes(), internal_token.as_bytes()).unwrap_u8() == 1 {
            info!("controller internal token accepted via direct match");
            return Ok(RequestContext {
                user_id: None,
                is_service_role: true,
                scoped_claims: None,
            });
        }
    }

    if let Some(service_role_key) = config.supabase_service_role_key.as_ref() {
        if ConstantTimeEq::ct_eq(token.as_bytes(), service_role_key.as_bytes()).unwrap_u8() == 1 {
            info!("service role token accepted via direct match");
            return Ok(RequestContext {
                user_id: None,
                is_service_role: true,
                scoped_claims: None,
            });
        }
    }

    match decode_controller_user_token(config, &token) {
        Ok(Some(user_id)) => {
            return Ok(RequestContext {
                user_id: Some(user_id),
                is_service_role: false,
                scoped_claims: None,
            });
        }
        Ok(None) => {}
        Err(error) => return Err(error),
    }

    let header = decode_header(&token).map_err(|_| unauthorized("invalid access token"))?;
    let token_may_be_supabase = matches!(
        header.alg,
        Algorithm::ES256 | Algorithm::RS256 | Algorithm::HS256
    );
    let mut attempted_supabase_decode = false;
    let mut refreshed_supabase_jwks = false;

    if token_may_be_supabase {
        loop {
            let jwks_snapshot = config.supabase_jwks.read().await.clone();
            let key = jwks_snapshot.decoding_key(header.kid.as_deref());

            let mut validation = Validation::new(jwks_snapshot.algorithm());
            validation.validate_exp = true;
            validation.leeway = 60;
            validation.set_audience(&[
                "authenticated",
                "service_role",
                "supabase_admin",
                "supabase_functions_admin",
                "anon",
                "public",
                "agent",
            ]);

            if let Some(key) = key {
                attempted_supabase_decode = true;
                match decode::<SupabaseClaims>(&token, key.as_ref(), &validation) {
                    Ok(token_data) => {
                        let claims = token_data.claims;
                        let role = claims.role.as_deref().unwrap_or_default();
                        let audience = claims.aud.as_deref().unwrap_or_default();

                        let user_id = claims
                            .user_id
                            .as_deref()
                            .or_else(|| claims.sub.as_deref())
                            .and_then(|raw| Uuid::from_str(raw).ok());

                        let is_service_role = matches!(
                            role,
                            "service_role"
                                | "supabase_admin"
                                | "supabase_functions_admin"
                                | "agent"
                        ) || audience == "service_role";

                        return Ok(RequestContext {
                            user_id,
                            is_service_role,
                            scoped_claims: None,
                        });
                    }
                    Err(error) => match error.kind() {
                        JwtErrorKind::ExpiredSignature => {
                            return Err(unauthorized("access token expired"))
                        }
                        _ => {
                            if !refreshed_supabase_jwks
                                && refresh_supabase_jwks_on_auth_retry(config).await
                            {
                                refreshed_supabase_jwks = true;
                                continue;
                            }
                        }
                    },
                }
            } else if !refreshed_supabase_jwks && refresh_supabase_jwks_on_auth_retry(config).await
            {
                refreshed_supabase_jwks = true;
                continue;
            }

            break;
        }
    }

    let claims = match decode_scoped_access_token(config, &token)? {
        Some(claims) => claims,
        None => {
            return Err(if attempted_supabase_decode {
                unauthorized("invalid access token")
            } else {
                unauthorized("unknown access token key")
            })
        }
    };

    let user_id = Uuid::from_str(claims.sub.trim()).ok();
    Ok(RequestContext {
        user_id,
        is_service_role: false,
        scoped_claims: Some(claims),
    })
}

pub(crate) struct AgentToken {
    pub(crate) token: String,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) expires_in: i64,
    pub(crate) scopes: Vec<String>,
}

#[cfg(test)]
pub(crate) fn issue_agent_token(
    config: &AppConfig,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
) -> Result<AgentToken, (StatusCode, Json<ApiError>)> {
    issue_agent_token_with_browser_profile_scope(
        config,
        project_id,
        runtime_id,
        lease_id,
        runtime_generation,
        false,
    )
}

pub(crate) fn issue_agent_token_for_runtime(
    config: &AppConfig,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
    runtime_provider: &str,
    runtime_capabilities: &serde_json::Value,
) -> Result<AgentToken, (StatusCode, Json<ApiError>)> {
    let include_browser_profile_scope = config
        .browser_profile_persistence_enabled_for_project(project_id)
        && crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(runtime_provider)
        && !crate::runtime::runtime_has_private_self_hosted_identity(
            runtime_provider,
            runtime_capabilities,
        );
    issue_agent_token_with_browser_profile_scope(
        config,
        project_id,
        runtime_id,
        lease_id,
        runtime_generation,
        include_browser_profile_scope,
    )
}

fn issue_agent_token_with_browser_profile_scope(
    config: &AppConfig,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
    include_browser_profile_scope: bool,
) -> Result<AgentToken, (StatusCode, Json<ApiError>)> {
    let subject = config
        .service_runtime_user_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| format!("agent:{}", project_id));

    let mut scopes = vec![
        "agent.lease".to_string(),
        "agent.heartbeat".to_string(),
        "agent.message".to_string(),
        "agent.complete".to_string(),
        "agent.input".to_string(),
        "agent.secrets".to_string(),
        "agent.stop".to_string(),
    ];
    if include_browser_profile_scope {
        scopes.push("agent.browser_profile".to_string());
    }

    let minted = mint_scoped_token_with_runtime_generation(
        config,
        ScopedTokenRequest {
            audience: runtime_id.to_string(),
            subject,
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes,
            lease_id: lease_id.map(Uuid::to_string),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(config.agent_token_ttl_seconds),
        },
        runtime_generation,
    )?;

    let MintedAccessToken {
        token,
        issued_at,
        expires_at,
        scopes,
        ttl,
        ..
    } = minted;

    Ok(AgentToken {
        token,
        issued_at: issued_at.timestamp(),
        expires_at: expires_at.timestamp(),
        expires_in: ttl,
        scopes,
    })
}

#[cfg(test)]
pub(crate) fn issue_agent_token_with_browser_profile_scope_for_test(
    config: &AppConfig,
    project_id: &Uuid,
    runtime_id: &Uuid,
    lease_id: Option<&Uuid>,
    runtime_generation: Option<Uuid>,
) -> Result<AgentToken, (StatusCode, Json<ApiError>)> {
    issue_agent_token_with_browser_profile_scope(
        config,
        project_id,
        runtime_id,
        lease_id,
        runtime_generation,
        true,
    )
}

pub(crate) struct ControllerToken {
    pub(crate) token: String,
    pub(crate) expires_at: i64,
    pub(crate) expires_in: i64,
}

pub(crate) fn issue_controller_token(
    config: &AppConfig,
    user_id: &Uuid,
) -> Result<ControllerToken, (StatusCode, Json<ApiError>)> {
    let issued_at = Utc::now();
    let exp = issued_at + ChronoDuration::seconds(config.user_token_ttl_seconds);

    let claims = UserTokenClaims {
        aud: "controller".to_string(),
        role: "controller_user".to_string(),
        sub: user_id.to_string(),
        session_id: None,
        iat: issued_at.timestamp(),
        exp: exp.timestamp(),
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(config.user_token_secret.as_bytes()),
    )
    .map_err(|error| internal_error(format!("failed to encode controller token: {error}")))?;

    Ok(ControllerToken {
        token,
        expires_at: exp.timestamp(),
        expires_in: config.user_token_ttl_seconds,
    })
}

fn decode_controller_user_token(
    config: &AppConfig,
    token: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.leeway = 30;
    validation.set_audience(&["controller"]);

    match decode::<UserTokenClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(config.user_token_secret.as_bytes()),
        &validation,
    ) {
        Ok(data) => {
            let user_id = Uuid::from_str(&data.claims.sub)
                .map_err(|_| unauthorized("invalid controller token subject"))?;
            Ok(Some(user_id))
        }
        Err(error) => match error.kind() {
            JwtErrorKind::ExpiredSignature => Err(unauthorized("controller token expired")),
            JwtErrorKind::InvalidToken | JwtErrorKind::InvalidSignature => Ok(None),
            other => {
                tracing::debug!(?other, "failed to decode controller token");
                Ok(None)
            }
        },
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControllerSessionResponse {
    token: String,
    token_type: &'static str,
    expires_in: i64,
    expires_at: i64,
}

pub(crate) async fn create_controller_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ControllerSessionResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;

    let token = issue_controller_token(&state.config, &user_id)?;

    Ok(Json(ControllerSessionResponse {
        token: token.token,
        token_type: "bearer",
        expires_in: token.expires_in,
        expires_at: token.expires_at,
    }))
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/auth/session", post(create_controller_session))
}

#[derive(Serialize)]
struct ProxyTokenClaims {
    aud: &'static str,
    iss: &'static str,
    sub: String,
    project_id: String,
    runtime_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_description: Option<String>,
    iat: i64,
    exp: i64,
}

fn clamp_claim_text(value: Option<&str>, max_len: usize) -> Option<String> {
    let trimmed = value.map(str::trim).filter(|value| !value.is_empty())?;
    if trimmed.len() <= max_len {
        return Some(trimmed.to_string());
    }
    Some(trimmed.chars().take(max_len).collect::<String>())
}

pub(crate) fn issue_proxy_envelope(
    config: &AppConfig,
    project_id: &Uuid,
    runtime_id: &Uuid,
    run_id: Option<&Uuid>,
    credential_id: Option<&Uuid>,
    agent_handle: Option<&str>,
    agent_display_name: Option<&str>,
    agent_description: Option<&str>,
) -> Option<ProxyEnvelopePayload> {
    const DEFAULT_PROXY_BASE_URL: &str = "http://proxy:8789";

    let secret: Cow<'_, str> = config
        .proxy_signing_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Cow::Borrowed)
        .or_else(|| {
            config
                .controller_internal_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|token| Cow::Owned(format!("instafy-proxy-signing:{token}")))
        })?;
    let base_url = config
        .proxy_base_url
        .as_deref()
        .unwrap_or(DEFAULT_PROXY_BASE_URL)
        .trim()
        .trim_end_matches('/');

    let issued_at = Utc::now();
    let exp = issued_at + ChronoDuration::seconds(config.proxy_token_ttl_seconds);

    let claims = ProxyTokenClaims {
        aud: "proxy",
        iss: "runtime-controller",
        sub: format!("proxy:{}:{}", project_id, runtime_id),
        project_id: project_id.to_string(),
        runtime_id: runtime_id.to_string(),
        run_id: run_id.map(|value| value.to_string()),
        credential_id: credential_id.map(|value| value.to_string()),
        agent_handle: clamp_claim_text(agent_handle, 32),
        agent_display_name: clamp_claim_text(agent_display_name, 80),
        agent_description: clamp_claim_text(agent_description, 600),
        iat: issued_at.timestamp(),
        exp: exp.timestamp(),
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .ok()?;

    Some(ProxyEnvelopePayload::from_parts(
        base_url.to_string(),
        token,
        exp,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RuntimeProviderConfig;
    use crate::jwks;
    use crate::tokens::ScopedTokenRequest;
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::{Json, Router};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde::Serialize;
    use serde_json::json;
    use std::sync::{Arc, OnceLock};
    use tokio::sync::RwLock;
    use uuid::Uuid;

    const TEST_SUPABASE_SECRET: &str = "test-secret";
    struct TestOriginKeyPair {
        private_pem: String,
        public_pem: String,
    }

    static TEST_ORIGIN_KEY_PAIR: OnceLock<TestOriginKeyPair> = OnceLock::new();

    const ED25519_PUBLIC_KEY_SPKI_PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];

    fn test_origin_private_key() -> &'static str {
        &test_origin_key_pair().private_pem
    }

    fn test_origin_public_key() -> &'static str {
        &test_origin_key_pair().public_pem
    }

    fn test_origin_key_pair() -> &'static TestOriginKeyPair {
        TEST_ORIGIN_KEY_PAIR.get_or_init(|| {
            let rng = SystemRandom::new();
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate test origin keypair");
            let key_pair =
                Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse test origin keypair");

            let mut public_der = ED25519_PUBLIC_KEY_SPKI_PREFIX.to_vec();
            public_der.extend_from_slice(key_pair.public_key().as_ref());

            TestOriginKeyPair {
                private_pem: format_pem_block("PRIVATE KEY", pkcs8.as_ref()),
                public_pem: format_pem_block("PUBLIC KEY", &public_der),
            }
        })
    }

    fn format_pem_block(label: &str, der: &[u8]) -> String {
        let body = STANDARD.encode(der);
        let mut pem = format!("-----BEGIN {label}-----\n");
        for chunk in body.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).expect("base64 chunk utf8"));
            pem.push('\n');
        }
        pem.push_str(&format!("-----END {label}-----"));
        pem
    }

    const TEST_RS256_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDUcqlvgFjB5JCJ\naRhcTGUASIGk8yANQVO2CJ1n3qZ85gb8G1T2gBtzbwm7sFEkAxBMpIkEDV1AGdaM\nZKY6dUxLJtkH3jvuKn7qaMUVHkaxvFMSILk2FHTg9Rkd/Jd/soQIvV5lg+wt/WR2\nODIR7DHcaf26gFt1ZQ3PWyLBmctWgdDpUlmvIntSe9H4O/JpmIKZhYxPMK3DIxbI\nz17L35oZ7m7ebiTqkNqlpUYOabtlFdtHNKcMr4FqaUqh3gvRgkdAu8saEMBRXWQ4\nBZljy14Ob9/TaRaD0DrLt3i/68wkmdD2LVjn/MovoG4nNPPe2kVbuQUQYh817fn3\nsP2imgmNAgMBAAECggEAV++qMIwIsSEhrq8AtVutxuM8PoGgN7xdoRCJzu+7LCGu\nrHXHwkyekDZa6gR+YZCfE4pbaID7o0fOpcgXgkUBMm4/EWGsntWaOP7q7OXeTz1r\niSpgX4EyK9dn8SCXuPS0cEWqKAzmGtcy2ThDiWWh8eExdBwjP0F36OeJSGeXYhOS\ngvkv/K/Pwp2TXIyPkH7Amv+ZSf3kJWEydS1EbIyQzn+CCHVH1uylQ4yHVfnuaHGT\nAbGFXXdZ6RV7A7RALKtX4eC8jVXoY9g6Unqocr211YdYQXauCsWvDpYSMqf6yTN7\nttSlUhZCC2hfQEqDsHPhAJ3y3A08S8wY9ZFx+hvzZQKBgQD2TGXgskXxuoBZQPKX\nVXgrde9ks7BF4LVN+IteQ6YsoYW6h5CZCc3gcuNi3SDsQj7CA89VhCz9sBWKCtor\nPw9/PuFky2SCrvJI0xEIltKV0tiPvJEam6VGRAhRgHDnEkX2cMU6LgcAlbXZxPcv\nXZ2EuRCGe2cey+XDU0Xu8Yb/SwKBgQDc0OzIzs90FR/aDIhUE2WNEwguLfRBFgcS\nmT/+vaXWa24WiFdUSqQnbazTMR8X8vwikNJ3o+1ga2kWsTNY0fvBZjEfWWEr2Q2m\nYI7OX7n948vN0kioeo79b6MkVaCSrLTW4odO5VZC+/kk71P5J5k0ELH0kuwbSmxt\noDvWpiWbhwKBgDA7cc/42V2nKi9QWrFsGWZZaBIOZjyo7phgTdqd4NLopqmKlrSB\niQGlPgZES4g4yNVxrY6PncfoTa+ExIinhr9ibv0wH3TAEc5VFwbZkk+oxKQRR1Ew\nncMO25oqTvHRUEYce2MTVGe26a/FtKpf6NLu8t+DFwSe5VXE3vMV9VvVAoGBAMz/\nQPPj24BfJCTgQagcIcjohE2q5/mMo6BGmby6/7yiG5/bj4d3jBH2pd2i2sT3FdBZ\nNqtPik5bKUKh25N3zgtr/eqmpal5Zkyxk6JQCHGGC2zW7hFLRnhOLdzLibjhkTl1\nMDy0eHLTTidV8FV8x6QoY600wPFNFIBpo2PQ91T9AoGBALAyqBSGdpjG5C797kCD\nh4pamn5HGj7YEMduxWi0F9aU4vjsDA+GUPsvp7ylgF4YYFEkzhq2v4oIu3dHI2JY\nWkIPRQEaxuT6BjzeOGh2H5FG1VP9jRvD+ePGzPlVcdc1UuRXyJ5PNVN89JDFWkgo\nCf115nmxco+EmGstvD8beuS9\n-----END PRIVATE KEY-----\n";
    const TEST_RS256_KID: &str = "test-rsa-kid";

    fn base_app_config() -> AppConfig {
        AppConfig {
            port: 8788,
            database_url: "postgres://localhost/test".to_string(),
            database_pool_size: 2,
            redis_url: None,
            redis_namespace: None,
            redis_events_channel: None,
            _supabase_project_url: "https://example.supabase.co".to_string(),
            supabase_jwks_url: "https://example.supabase.co/auth/v1/.well-known/jwks.json"
                .to_string(),
            supabase_jwks: Arc::new(RwLock::new(jwks::SupabaseJwks::from_hmac_secret(
                TEST_SUPABASE_SECRET,
            ))),
            supabase_jwks_refresh_seconds: 300,
            supabase_jwks_refresh_enabled: true,
            controller_internal_token: None,
            proxy_credential_lease_token: None,
            supabase_service_role_key: None,
            agent_token_ttl_seconds: 900,
            user_token_ttl_seconds: 900,
            user_token_secret: TEST_SUPABASE_SECRET.to_string(),
            origin_token_private_key: Some(test_origin_private_key().to_string()),
            origin_token_public_key: Some(test_origin_public_key().to_string()),
            origin_token_key_id: Some("test-origin-key".to_string()),
            origin_token_ttl_seconds: 600,
            lease_path: "/agent/lease".to_string(),
            heartbeat_path: "/agent/heartbeat".to_string(),
            stop_path: "/runtime/stop".to_string(),
            proxy_signing_secret: None,
            proxy_base_url: None,
            proxy_token_ttl_seconds: 900,
            credential_encryption_key: None,
            browser_profile_persist_project_ids: vec![],
            browser_profile_snapshot_secs: 30,
            progress_callback_secret: None,
            git_remote_base_url: None,
            git_remote_public_base_url: None,
            git_shards: vec![],
            hosted_origin_endpoint: None,
            browser_turn_rest: None,
            sandbox_credit_seed_amount: 0,
            sandbox_credit_seed_limit: 0,
            billing_unit_label: "credits".to_string(),
            billing_units_per_usd: 1_000,
            tunnel_credit_burn_amount: 0,
            tunnel_credit_burn_interval_seconds: 600,
            tunnel_credit_burn_lead_seconds: 60,
            hosted_runtime_credit_burn_amount: 0,
            hosted_runtime_credit_burn_interval_seconds: 600,
            managed_ai_enabled: true,
            managed_ai_label: "Instafy AI".to_string(),
            managed_ai_credit_burn_amount: 1,
            managed_ai_daily_prompt_limit: 20,
            managed_ai_model_id: default_managed_ai_model_id().to_string(),
            managed_ai_model_label: default_managed_ai_model_label().to_string(),
            managed_ai_input_usd_micros_per_1k: DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K,
            managed_ai_cached_input_usd_micros_per_1k:
                DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K,
            managed_ai_output_usd_micros_per_1k: DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K,
            managed_ai_startup_check: true,
            tunnel_broker_hook_secret: None,
            git_event_hook_secret: None,
            _controller_external_url: None,
            public_app_url: "https://instafy.dev".to_string(),
            workspace_root: None,
            strict_mode: false,
            dev_isolation_mode: false,
            dev_mode: false,
            runtime_idle_release_seconds: 150,
            runtime_idle_stop_seconds: 1800,
            max_orgs_per_user: 5,
            max_active_hosted_runtimes_global: 0,
            auto_create_projects: false,
            service_runtime_user_id: None,
            dev_project_registry_path: None,
            runtime_providers: vec![RuntimeProviderConfig {
                id: "default".to_string(),
                display_name: "Default".to_string(),
                kind: "noop".to_string(),
                owner_org_id: None,
                allowed_org_ids: vec![],
                endpoint: None,
                auth_token: None,
                metadata: None,
            }],
            self_hosted_tunnel_broker: None,
            stripe: None,
            operator_console_org_id: None,
            operator_console_allowed_user_ids: vec![],
            bug_reports_operator_user_ids: vec![],
            desktop_release_github_owner: None,
            desktop_release_github_repo: None,
            desktop_release_github_token: None,
            desktop_release_promote_workflow: "desktop-promote.yml".to_string(),
            cloudflare_api_token: None,
            cloudflare_zone_id: None,
            downloads_public_host: "downloads.instafy.dev".to_string(),
            desktop_downloads_prefix: "desktop-app".to_string(),
            mobile_ota_downloads_prefix: "mobile".to_string(),
            web_push_vapid_public_key: None,
            web_push_vapid_private_key: None,
            web_push_vapid_subject: None,
            apns_key_id: None,
            apns_team_id: None,
            apns_bundle_id: None,
            apns_private_key: None,
            apns_use_sandbox: false,
        }
    }

    #[test]
    fn proxy_envelope_expiry_covers_long_codex_runs() {
        let mut config = base_app_config();
        config.proxy_signing_secret = Some("proxy-secret".to_string());
        config.proxy_token_ttl_seconds = 1800;
        let before = Utc::now();

        let envelope = issue_proxy_envelope(
            &config,
            &Uuid::new_v4(),
            &Uuid::new_v4(),
            Some(&Uuid::new_v4()),
            None,
            None,
            None,
            None,
        )
        .expect("proxy envelope should be issued");
        let expires_at = chrono::DateTime::parse_from_rfc3339(
            envelope.expires_at.as_deref().expect("expires_at"),
        )
        .expect("valid expires_at")
        .with_timezone(&Utc);
        let lifetime = expires_at.signed_duration_since(before).num_seconds();

        assert!(
            (1790..=1810).contains(&lifetime),
            "proxy envelope lifetime should cover a long Codex run, got {lifetime}s"
        );
    }

    fn header_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let value = format!("Bearer {token}");
        headers.insert(
            axum::http::header::AUTHORIZATION,
            axum::http::HeaderValue::from_str(&value).expect("failed to build header"),
        );
        headers
    }

    fn mint_access_token(
        secret: &str,
        role: &str,
        aud: &str,
        user_id: Option<Uuid>,
        kid: Option<&str>,
    ) -> String {
        #[derive(Serialize)]
        struct TestClaims<'a> {
            sub: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            user_id: Option<String>,
            role: &'a str,
            aud: &'a str,
            exp: i64,
        }

        let now = Utc::now();
        let claims = TestClaims {
            sub: user_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| format!("{role}-subject")),
            user_id: user_id.map(|value| value.to_string()),
            role,
            aud,
            exp: (now + ChronoDuration::minutes(5)).timestamp(),
        };

        let mut header = Header::new(Algorithm::HS256);
        header.kid = kid.map(|value| value.to_string());

        encode(
            &header,
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .expect("failed to encode access token")
    }

    fn mint_rs256_access_token(
        private_key_pem: &str,
        role: &str,
        aud: &str,
        user_id: Option<Uuid>,
        kid: Option<&str>,
    ) -> String {
        #[derive(Serialize)]
        struct TestClaims<'a> {
            sub: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            user_id: Option<String>,
            role: &'a str,
            aud: &'a str,
            exp: i64,
        }

        let now = Utc::now();
        let claims = TestClaims {
            sub: user_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| format!("{role}-subject")),
            user_id: user_id.map(|value| value.to_string()),
            role,
            aud,
            exp: (now + ChronoDuration::minutes(5)).timestamp(),
        };

        let mut header = Header::new(Algorithm::RS256);
        header.kid = kid.map(|value| value.to_string());

        encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
                .expect("failed to construct RS256 encoding key"),
        )
        .expect("failed to encode RS256 access token")
    }

    async fn spawn_test_jwks_server() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/.well-known/jwks.json",
            get(|| async move {
                Json(json!({
                    "keys": [
                        {
                            "kty": "RSA",
                            "kid": TEST_RS256_KID,
                            "alg": "RS256",
                            "use": "sig",
                            "n": "1HKpb4BYweSQiWkYXExlAEiBpPMgDUFTtgidZ96mfOYG_BtU9oAbc28Ju7BRJAMQTKSJBA1dQBnWjGSmOnVMSybZB9477ip-6mjFFR5GsbxTEiC5NhR04PUZHfyXf7KECL1eZYPsLf1kdjgyEewx3Gn9uoBbdWUNz1siwZnLVoHQ6VJZryJ7UnvR-DvyaZiCmYWMTzCtwyMWyM9ey9-aGe5u3m4k6pDapaVGDmm7ZRXbRzSnDK-BamlKod4L0YJHQLvLGhDAUV1kOAWZY8teDm_f02kWg9A6y7d4v-vMJJnQ9i1Y5_zKL6BuJzTz3tpFW7kFEGIfNe3597D9opoJjQ",
                            "e": "AQAB"
                        }
                    ]
                }))
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind jwks test server");
        let address = listener.local_addr().expect("jwks test server address");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve jwks test server");
        });

        (format!("http://{address}/.well-known/jwks.json"), handle)
    }

    #[tokio::test]
    async fn authenticate_request_allows_missing_token() {
        let config = base_app_config();
        let headers = HeaderMap::new();
        let context = authenticate_request(&config, &headers)
            .await
            .expect("auth should succeed");
        assert!(context.user_id.is_none());
        assert!(!context.is_service_role);
    }

    #[tokio::test]
    async fn authenticate_request_detects_service_role_token() {
        let mut config = base_app_config();
        let service_token = mint_access_token(
            TEST_SUPABASE_SECRET,
            "service_role",
            "service_role",
            None,
            None,
        );
        config.supabase_service_role_key = Some(service_token.clone());

        let headers = header_with_token(&service_token);
        let context = authenticate_request(&config, &headers)
            .await
            .expect("auth should succeed");
        assert!(context.is_service_role);
        assert!(context.user_id.is_none());
    }

    #[tokio::test]
    async fn credential_lease_token_is_not_a_general_service_bearer() {
        let mut config = base_app_config();
        config.proxy_credential_lease_token = Some("credential-lease-only".to_string());
        let headers = header_with_token("credential-lease-only");

        assert!(
            authenticate_request(&config, &headers).await.is_err(),
            "the route-scoped lease token must not authorize credits or other service routes",
        );
    }

    #[tokio::test]
    async fn authenticate_request_extracts_user_from_token() {
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        let user_id = Uuid::new_v4();
        let token = mint_access_token(
            TEST_SUPABASE_SECRET,
            "authenticated",
            "authenticated",
            Some(user_id),
            None,
        );
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = true;
        validation.leeway = 60;
        validation.set_audience(&[
            "authenticated",
            "service_role",
            "supabase_admin",
            "supabase_functions_admin",
            "anon",
            "public",
            "agent",
        ]);
        decode::<SupabaseClaims>(
            &token,
            &DecodingKey::from_secret(TEST_SUPABASE_SECRET.as_bytes()),
            &validation,
        )
        .expect("token should decode");

        let headers = header_with_token(&token);
        let context = authenticate_request(&config, &headers)
            .await
            .expect("auth should succeed");
        assert_eq!(context.user_id, Some(user_id));
        assert!(!context.is_service_role);
    }

    #[tokio::test]
    async fn authenticate_request_extracts_user_from_token_with_kid() {
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        let user_id = Uuid::new_v4();
        let token = mint_access_token(
            TEST_SUPABASE_SECRET,
            "authenticated",
            "authenticated",
            Some(user_id),
            Some("test-kid"),
        );

        let headers = header_with_token(&token);
        let context = authenticate_request(&config, &headers)
            .await
            .expect("auth should succeed");
        assert_eq!(context.user_id, Some(user_id));
        assert!(!context.is_service_role);
    }

    #[tokio::test]
    async fn authenticate_request_refreshes_stale_supabase_jwks() {
        let (jwks_url, server) = spawn_test_jwks_server().await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        config.supabase_jwks_url = jwks_url;
        config.supabase_jwks = Arc::new(RwLock::new(jwks::SupabaseJwks::from_hmac_secret(
            "stale-secret",
        )));
        config.supabase_jwks_refresh_enabled = true;

        let user_id = Uuid::new_v4();
        let token = mint_rs256_access_token(
            TEST_RS256_PRIVATE_KEY,
            "authenticated",
            "authenticated",
            Some(user_id),
            Some(TEST_RS256_KID),
        );

        let headers = header_with_token(&token);
        let context = authenticate_request(&config, &headers)
            .await
            .expect("auth should succeed after JWKS refresh");
        assert_eq!(context.user_id, Some(user_id));
        assert!(!context.is_service_role);

        server.abort();
    }

    #[tokio::test]
    async fn authenticate_request_uses_authorization_header_as_sole_token_transport() {
        let mut config = base_app_config();
        config.supabase_service_role_key = None;
        let user_id = Uuid::new_v4();
        let token = mint_access_token(
            TEST_SUPABASE_SECRET,
            "authenticated",
            "authenticated",
            Some(user_id),
            None,
        );
        let context = authenticate_request(&config, &HeaderMap::new())
            .await
            .unwrap();
        assert_eq!(context.user_id, None);
        assert!(!context.is_service_role);

        let headers = header_with_token(&token);
        let context = authenticate_request(&config, &headers).await.unwrap();
        assert_eq!(context.user_id, Some(user_id));
        assert!(!context.is_service_role);
    }

    #[tokio::test]
    async fn authenticate_request_accepts_controller_scoped_token() {
        let config = base_app_config();
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();

        let token = crate::tokens::mint_scoped_token(
            &config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: user_id.to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes: vec!["prompt.execute".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(600),
            },
        )
        .expect("mint scoped token")
        .token;

        let headers = header_with_token(&token);
        let context = authenticate_request(&config, &headers)
            .await
            .expect("auth should succeed");
        assert_eq!(context.user_id, Some(user_id));
        assert!(context.scoped_claims.is_some());
        assert!(require_user_session(&context).is_err());
    }

    #[test]
    fn agent_token_only_grants_browser_profile_scope_to_allowlisted_managed_cloud_runtime() {
        let mut config = base_app_config();
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();

        let lease_id = Uuid::new_v4();
        let runtime_generation = Uuid::new_v4();
        let denied_without_project_policy = issue_agent_token_for_runtime(
            &config,
            &project_id,
            &runtime_id,
            Some(&lease_id),
            Some(runtime_generation),
            "instafy-cloud",
            &json!({}),
        )
        .expect("agent token without browser persistence");
        assert!(!denied_without_project_policy
            .scopes
            .iter()
            .any(|scope| scope == "agent.browser_profile"));

        config.browser_profile_persist_project_ids.push(project_id);
        let generic = issue_agent_token(
            &config,
            &project_id,
            &runtime_id,
            Some(&lease_id),
            Some(runtime_generation),
        )
        .expect("generic agent token");
        assert!(!generic
            .scopes
            .iter()
            .any(|scope| scope == "agent.browser_profile"));

        for (provider, capabilities) in [
            ("self-hosted", json!({})),
            ("instafy-cloud-custom", json!({})),
            (
                "instafy-cloud-custom",
                json!({
                    "_instafySelfHostedAccess": {
                        "mode": "private",
                        "ownerUserId": Uuid::new_v4().to_string()
                    }
                }),
            ),
        ] {
            let denied_runtime = issue_agent_token_for_runtime(
                &config,
                &project_id,
                &runtime_id,
                Some(&lease_id),
                Some(runtime_generation),
                provider,
                &capabilities,
            )
            .expect("non-managed runtime agent token");
            assert!(!denied_runtime
                .scopes
                .iter()
                .any(|scope| scope == "agent.browser_profile"));
        }

        let allowed = issue_agent_token_for_runtime(
            &config,
            &project_id,
            &runtime_id,
            Some(&lease_id),
            Some(runtime_generation),
            "instafy-cloud",
            &json!({}),
        )
        .expect("managed-cloud agent token with browser persistence");
        assert!(allowed
            .scopes
            .iter()
            .any(|scope| scope == "agent.browser_profile"));

        let claims = crate::tokens::decode_scoped_token(&config, &allowed.token, "agent token")
            .expect("decode lease-bound agent token");
        assert_eq!(claims.lease_id, Some(lease_id.to_string()));
        assert_eq!(
            claims.runtime_generation,
            Some(runtime_generation.to_string())
        );
    }
}
