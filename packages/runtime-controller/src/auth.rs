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
use tracing::info;
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
    // A token the cached key set cannot verify, such as one signed with a key
    // Supabase has just rotated in, gets one more look once the JWKS
    // refresher has fetched. The request only signals and waits for it,
    // briefly: it never fetches, so unknown key ids cannot multiply fetches.
    let mut refreshed_supabase_jwks = false;

    if token_may_be_supabase {
        loop {
            let snapshot = config.supabase_jwks.snapshot().await;
            let jwks_snapshot = snapshot.key_set;
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
                                && config
                                    .supabase_jwks
                                    .wait_for_refresh(snapshot.generation)
                                    .await
                            {
                                refreshed_supabase_jwks = true;
                                continue;
                            }
                        }
                    },
                }
            } else if !refreshed_supabase_jwks
                && config
                    .supabase_jwks
                    .wait_for_refresh(snapshot.generation)
                    .await
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
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine as _,
    };
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde::Serialize;
    use serde_json::json;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration as StdDuration;
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
            supabase_jwks_url: jwks::SupabaseJwksUrl::for_test("https://example.supabase.co"),
            supabase_jwks: jwks::SupabaseJwksCache::new(jwks::SupabaseJwks::from_hmac_secret(
                TEST_SUPABASE_SECRET,
            )),
            supabase_jwks_refresh_seconds: 300,
            supabase_jwks_on_demand_interval_seconds: 30,
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
            credential_keys: None,
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
            managed_ai_openai_api_key: None,
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
            runtime_limit_reclaim_idle_seconds: 120,
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
            jwks::SUPABASE_JWKS_PATH,
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

        // Bound to 127.0.0.1 above; spelled out so the URL is visibly loopback.
        (format!("http://127.0.0.1:{}", address.port()), handle)
    }

    /// A P-256 signing key generated for one test and published as an ES256
    /// JWK, as Supabase publishes its asymmetric signing keys.
    struct TestEcKey {
        kid: String,
        pkcs8: Vec<u8>,
        jwk: serde_json::Value,
    }

    impl TestEcKey {
        fn generate(kid: &str) -> Self {
            use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
                .expect("generate test EC key");
            let key_pair =
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                    .expect("parse test EC key");
            // An uncompressed point: 0x04, then the X and Y coordinates.
            let point = key_pair.public_key().as_ref();
            let jwk = json!({
                "kty": "EC",
                "crv": "P-256",
                "alg": "ES256",
                "use": "sig",
                "kid": kid,
                "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
                "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
            });
            Self {
                kid: kid.to_string(),
                pkcs8: pkcs8.as_ref().to_vec(),
                jwk,
            }
        }

        fn mint(&self, user_id: Uuid) -> String {
            self.mint_as(&self.kid, user_id)
        }

        fn mint_with_kid(&self, kid: &str) -> String {
            self.mint_as(kid, Uuid::new_v4())
        }

        fn mint_as(&self, kid: &str, user_id: Uuid) -> String {
            #[derive(Serialize)]
            struct Claims {
                sub: String,
                role: &'static str,
                aud: &'static str,
                exp: i64,
            }
            let mut header = Header::new(Algorithm::ES256);
            header.kid = Some(kid.to_string());
            encode(
                &header,
                &Claims {
                    sub: user_id.to_string(),
                    role: "authenticated",
                    aud: "authenticated",
                    exp: (Utc::now() + ChronoDuration::minutes(5)).timestamp(),
                },
                &EncodingKey::from_ec_der(&self.pkcs8),
            )
            .expect("sign ES256 test token")
        }
    }

    fn key_set(keys: &[&TestEcKey]) -> jwks::SupabaseJwks {
        let keys: Vec<_> = keys.iter().map(|key| key.jwk.clone()).collect();
        jwks::SupabaseJwks::from_jwk_set(
            serde_json::from_value(json!({ "keys": keys })).expect("test key set"),
        )
        .expect("usable test key set")
    }

    /// A Supabase JWKS endpoint whose keys a test rotates, recording when
    /// each fetch arrives.
    #[derive(Clone, Default)]
    struct RotatingJwks {
        keys: Arc<Mutex<Vec<serde_json::Value>>>,
        fetches: Arc<Mutex<Vec<std::time::Instant>>>,
    }

    impl RotatingJwks {
        fn publish(&self, keys: &[&TestEcKey]) {
            *self.keys.lock().unwrap() = keys.iter().map(|key| key.jwk.clone()).collect();
        }

        fn fetches(&self) -> Vec<std::time::Instant> {
            self.fetches.lock().unwrap().clone()
        }
    }

    async fn spawn_rotating_jwks_server(
        endpoint: RotatingJwks,
    ) -> (jwks::SupabaseJwksUrl, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            jwks::SUPABASE_JWKS_PATH,
            get(move || {
                let endpoint = endpoint.clone();
                async move {
                    endpoint
                        .fetches
                        .lock()
                        .unwrap()
                        .push(std::time::Instant::now());
                    let keys = endpoint.keys.lock().unwrap().clone();
                    Json(json!({ "keys": keys }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind rotating jwks test server");
        let address = listener
            .local_addr()
            .expect("rotating jwks test server address");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve rotating jwks test server");
        });
        let url = jwks::SupabaseJwksUrl::for_test(&format!("http://127.0.0.1:{}", address.port()));
        (url, handle)
    }

    /// Serve `config` from a cache holding `initial`, as the startup load
    /// leaves it, with a refresher fetching from `url` as main.rs starts it.
    fn spawn_refresher(
        config: &mut AppConfig,
        url: jwks::SupabaseJwksUrl,
        initial: jwks::SupabaseJwks,
        schedule: jwks::JwksRefreshSchedule,
    ) -> tokio::task::JoinHandle<()> {
        spawn_refresher_with(config, url, initial, schedule, |refresher| refresher)
    }

    /// [`spawn_refresher`], with test settings applied to the refresher.
    fn spawn_refresher_with(
        config: &mut AppConfig,
        url: jwks::SupabaseJwksUrl,
        initial: jwks::SupabaseJwks,
        schedule: jwks::JwksRefreshSchedule,
        adjust: impl FnOnce(jwks::JwksRefresher) -> jwks::JwksRefresher,
    ) -> tokio::task::JoinHandle<()> {
        config.supabase_jwks = jwks::SupabaseJwksCache::new(initial);
        config.supabase_jwks_url = url.clone();
        config.supabase_jwks_refresh_enabled = true;
        adjust(
            jwks::JwksRefresher::new(url, config.supabase_jwks.clone(), schedule)
                .expect("build the JWKS refresher"),
        )
        .spawn()
    }

    async fn wait_for_generation(cache: &jwks::SupabaseJwksCache, generation: u64) {
        let deadline = std::time::Instant::now() + StdDuration::from_secs(5);
        while cache.snapshot().await.generation < generation {
            assert!(
                std::time::Instant::now() < deadline,
                "the JWKS refresher did not finish fetch {generation} in time"
            );
            tokio::time::sleep(StdDuration::from_millis(5)).await;
        }
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
        let (supabase_project_url, server) = spawn_test_jwks_server().await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        // The HS256 fallback a failed startup load leaves behind.
        let refresher = spawn_refresher(
            &mut config,
            jwks::SupabaseJwksUrl::for_test(&supabase_project_url),
            jwks::SupabaseJwks::from_hmac_secret("stale-secret"),
            jwks::JwksRefreshSchedule::new(StdDuration::from_secs(300), StdDuration::from_secs(30)),
        );

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

        refresher.abort();
        server.abort();
    }

    /// However many requests name keys the cache does not hold, the JWKS
    /// endpoint sees at most one fetch per on-demand interval, and every
    /// request is still answered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn unknown_key_ids_cannot_multiply_jwks_fetches() {
        const INTERVAL: StdDuration = StdDuration::from_millis(300);
        const WAVE: usize = 100;
        let current = TestEcKey::generate("current");
        let stray = TestEcKey::generate("stray");
        let endpoint = RotatingJwks::default();
        endpoint.publish(&[&current]);
        let (url, server) = spawn_rotating_jwks_server(endpoint.clone()).await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        let refresher = spawn_refresher(
            &mut config,
            url,
            key_set(&[&current]),
            jwks::JwksRefreshSchedule {
                periodic: StdDuration::from_secs(3600),
                on_demand_interval: INTERVAL,
                auth_wait: StdDuration::from_secs(2),
            },
        );
        wait_for_generation(&config.supabase_jwks, 1).await;
        assert_eq!(endpoint.fetches().len(), 1, "the startup fetch");

        let config = Arc::new(config);
        let flood_started = std::time::Instant::now();
        let mut requests = 0;
        while flood_started.elapsed() < StdDuration::from_secs(1) {
            let wave: Vec<_> = (0..WAVE)
                .map(|index| {
                    let config = config.clone();
                    // Every request a key id nobody published.
                    let token = stray.mint_with_kid(&format!("stray-{requests}-{index}"));
                    tokio::spawn(async move {
                        authenticate_request(&config, &header_with_token(&token)).await
                    })
                })
                .collect();
            for request in wave {
                let (status, _) = request
                    .await
                    .expect("join request")
                    .expect_err("a key nobody published never verifies");
                assert_eq!(status, StatusCode::UNAUTHORIZED);
            }
            requests += WAVE;
        }
        // Let a fetch the last wave asked for land before counting.
        tokio::time::sleep(INTERVAL * 2).await;

        let fetches = endpoint.fetches();
        assert!(
            fetches.len() >= 2,
            "the unknown key ids never reached the refresher"
        );
        for pair in fetches.windows(2) {
            let gap = pair[1] - pair[0];
            assert!(
                gap >= INTERVAL * 8 / 10,
                "two JWKS fetches {gap:?} apart, inside one {INTERVAL:?} interval"
            );
        }
        let windows = flood_started.elapsed().as_millis() / INTERVAL.as_millis() + 1;
        assert!(
            (fetches.len() as u128) <= 1 + windows,
            "{} fetches for {requests} requests over {windows} intervals",
            fetches.len()
        );
        assert!(
            requests >= 2 * WAVE,
            "the flood sent only {requests} requests"
        );

        refresher.abort();
        server.abort();
    }

    /// The first request signed with a key Supabase has just published asks
    /// the refresher for it, waits for the fetch, and is accepted.
    #[tokio::test]
    async fn a_rotated_in_key_is_fetched_for_the_request_that_needs_it() {
        let current = TestEcKey::generate("current");
        let next = TestEcKey::generate("next");
        let endpoint = RotatingJwks::default();
        endpoint.publish(&[&current]);
        let (url, server) = spawn_rotating_jwks_server(endpoint.clone()).await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        let refresher = spawn_refresher(
            &mut config,
            url,
            key_set(&[&current]),
            jwks::JwksRefreshSchedule {
                periodic: StdDuration::from_secs(3600),
                on_demand_interval: StdDuration::from_millis(300),
                auth_wait: StdDuration::from_secs(2),
            },
        );
        wait_for_generation(&config.supabase_jwks, 1).await;

        endpoint.publish(&[&current, &next]);
        let user_id = Uuid::new_v4();
        let context = authenticate_request(&config, &header_with_token(&next.mint(user_id)))
            .await
            .expect("the rotated-in key verifies once fetched");
        assert_eq!(context.user_id, Some(user_id));
        assert_eq!(endpoint.fetches().len(), 2, "one fetch for the new key");

        // Both keys verify from the cache now, without another fetch.
        for key in [&current, &next] {
            let user_id = Uuid::new_v4();
            let context = authenticate_request(&config, &header_with_token(&key.mint(user_id)))
                .await
                .expect("a published key verifies");
            assert_eq!(context.user_id, Some(user_id));
        }
        assert_eq!(endpoint.fetches().len(), 2);

        refresher.abort();
        server.abort();
    }

    /// A key rotated in just after a fetch is refused, without waiting, until
    /// the on-demand interval allows the fetch its requests asked for; that
    /// fetch then happens without another request having to ask.
    #[tokio::test]
    async fn a_rotation_inside_the_interval_is_picked_up_when_it_ends() {
        const INTERVAL: StdDuration = StdDuration::from_millis(800);
        let current = TestEcKey::generate("current");
        let next = TestEcKey::generate("next");
        let endpoint = RotatingJwks::default();
        endpoint.publish(&[&current]);
        let (url, server) = spawn_rotating_jwks_server(endpoint.clone()).await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        let refresher = spawn_refresher(
            &mut config,
            url,
            key_set(&[&current]),
            jwks::JwksRefreshSchedule {
                periodic: StdDuration::from_secs(3600),
                on_demand_interval: INTERVAL,
                auth_wait: StdDuration::from_millis(100),
            },
        );
        wait_for_generation(&config.supabase_jwks, 1).await;
        let interval_started = std::time::Instant::now();

        endpoint.publish(&[&current, &next]);
        let token = next.mint(Uuid::new_v4());
        for _ in 0..50 {
            let (status, _) = authenticate_request(&config, &header_with_token(&token))
                .await
                .expect_err("not fetched yet");
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        assert!(
            interval_started.elapsed() < INTERVAL / 2,
            "refused requests waited for a fetch the interval does not allow yet"
        );
        assert_eq!(endpoint.fetches().len(), 1, "no fetch inside the interval");

        wait_for_generation(&config.supabase_jwks, 2).await;
        assert!(interval_started.elapsed() >= INTERVAL * 8 / 10);
        let user_id = Uuid::new_v4();
        let context = authenticate_request(&config, &header_with_token(&next.mint(user_id)))
            .await
            .expect("the key the refused requests asked for arrived");
        assert_eq!(context.user_id, Some(user_id));
        assert_eq!(endpoint.fetches().len(), 2);

        refresher.abort();
        server.abort();
    }

    /// With no request asking, the refresher still fetches on its schedule,
    /// and a retired key leaves the cache.
    #[tokio::test]
    async fn the_refresher_still_fetches_periodically() {
        const PERIOD: StdDuration = StdDuration::from_millis(150);
        let current = TestEcKey::generate("current");
        let next = TestEcKey::generate("next");
        let endpoint = RotatingJwks::default();
        endpoint.publish(&[&current]);
        let (url, server) = spawn_rotating_jwks_server(endpoint.clone()).await;
        let mut config = base_app_config();
        let refresher = spawn_refresher(
            &mut config,
            url,
            key_set(&[&current]),
            jwks::JwksRefreshSchedule {
                periodic: PERIOD,
                on_demand_interval: StdDuration::from_secs(3600),
                auth_wait: StdDuration::from_secs(2),
            },
        );
        wait_for_generation(&config.supabase_jwks, 1).await;
        endpoint.publish(&[&next]);

        wait_for_generation(&config.supabase_jwks, 3).await;
        let snapshot = config.supabase_jwks.snapshot().await;
        assert!(snapshot.key_set.decoding_key(Some("next")).is_some());
        assert!(snapshot.key_set.decoding_key(Some("current")).is_none());
        let fetches = endpoint.fetches();
        assert!(fetches.len() >= 3);
        for pair in fetches.windows(2) {
            assert!(pair[1] - pair[0] >= PERIOD * 8 / 10);
        }

        refresher.abort();
        server.abort();
    }

    /// Captures what the thread's default subscriber writes.
    #[derive(Clone, Default)]
    struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

    impl CapturedLogs {
        fn contents(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    impl std::io::Write for CapturedLogs {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A refresher that panics mid-fetch is logged and restarted with the
    /// URL and client it was built with. The request whose fetch panicked is
    /// answered at once rather than after the full auth wait, the restarted
    /// refresher fetches, and it answers the next request that asks for a
    /// rotated-in key.
    #[tokio::test]
    async fn the_refresher_restarts_after_a_panic_and_answers_later_requests() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        const INTERVAL: StdDuration = StdDuration::from_millis(200);
        const BACKOFF: StdDuration = StdDuration::from_millis(300);
        let logs = CapturedLogs::default();
        // The test's tasks all run on this thread.
        let _subscriber = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_writer({
                    let logs = logs.clone();
                    move || logs.clone()
                })
                .with_ansi(false)
                .finish(),
        );
        let current = TestEcKey::generate("current");
        let next = TestEcKey::generate("next");
        let third = TestEcKey::generate("third");
        let endpoint = RotatingJwks::default();
        endpoint.publish(&[&current]);
        let (url, server) = spawn_rotating_jwks_server(endpoint.clone()).await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        let panics = Arc::new(AtomicUsize::new(0));
        let refresher = spawn_refresher_with(
            &mut config,
            url,
            key_set(&[&current]),
            jwks::JwksRefreshSchedule {
                periodic: StdDuration::from_secs(3600),
                on_demand_interval: INTERVAL,
                auth_wait: StdDuration::from_secs(2),
            },
            |refresher| {
                refresher
                    .with_restart_backoff(BACKOFF, StdDuration::from_secs(1))
                    .with_injected_panics(panics.clone())
            },
        );
        wait_for_generation(&config.supabase_jwks, 1).await;

        // The fetch the next request asks for panics.
        panics.store(1, Ordering::SeqCst);
        endpoint.publish(&[&current, &next]);
        let asked = std::time::Instant::now();
        let (status, _) =
            authenticate_request(&config, &header_with_token(&next.mint_with_kid("next")))
                .await
                .expect_err("the fetch this request asked for panicked");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let waited = asked.elapsed();
        assert!(
            waited < StdDuration::from_secs(1),
            "the request waited {waited:?} for a refresher that had panicked"
        );
        assert_eq!(panics.load(Ordering::SeqCst), 0, "no fetch cycle panicked");
        assert_eq!(endpoint.fetches().len(), 1);

        // Restarted after the backoff, it fetches the rotated key set.
        wait_for_generation(&config.supabase_jwks, 2).await;
        assert_eq!(endpoint.fetches().len(), 2);
        let user_id = Uuid::new_v4();
        let context = authenticate_request(&config, &header_with_token(&next.mint(user_id)))
            .await
            .expect("the restarted refresher fetched the rotated-in key");
        assert_eq!(context.user_id, Some(user_id));

        // And it still answers a request that asks for a key rotated in later.
        endpoint.publish(&[&current, &next, &third]);
        let user_id = Uuid::new_v4();
        let context = authenticate_request(&config, &header_with_token(&third.mint(user_id)))
            .await
            .expect("the restarted refresher fetched on demand");
        assert_eq!(context.user_id, Some(user_id));
        assert_eq!(endpoint.fetches().len(), 3);

        let output = logs.contents();
        let restarts: Vec<&str> = output
            .lines()
            .filter(|line| line.contains("Supabase JWKS refresher panicked; restarting it"))
            .collect();
        assert_eq!(restarts.len(), 1, "{output}");
        assert!(restarts[0].contains("ERROR"), "{output}");
        assert!(
            !output.contains("injected JWKS fetch panic"),
            "the panic payload reached the log: {output}"
        );

        refresher.abort();
        server.abort();
    }

    /// Once the refresher has stopped, nothing would answer a signal, so a
    /// request with an unknown key id is refused at once instead of waiting
    /// out the auth wait.
    #[tokio::test]
    async fn requests_do_not_wait_for_a_stopped_refresher() {
        let current = TestEcKey::generate("current");
        let stray = TestEcKey::generate("stray");
        let endpoint = RotatingJwks::default();
        endpoint.publish(&[&current]);
        let (url, server) = spawn_rotating_jwks_server(endpoint.clone()).await;
        let mut config = base_app_config();
        config.supabase_service_role_key = Some("different-service-token".to_string());
        // A short on-demand interval, so a running refresher could fetch
        // within the auth wait and a request would wait for it.
        let refresher = spawn_refresher(
            &mut config,
            url,
            key_set(&[&current]),
            jwks::JwksRefreshSchedule {
                periodic: StdDuration::from_secs(3600),
                on_demand_interval: StdDuration::from_millis(100),
                auth_wait: StdDuration::from_secs(2),
            },
        );
        wait_for_generation(&config.supabase_jwks, 1).await;

        refresher.abort();
        assert!(refresher
            .await
            .expect_err("the refresher was aborted")
            .is_cancelled());
        let asked = std::time::Instant::now();
        let (status, _) =
            authenticate_request(&config, &header_with_token(&stray.mint_with_kid("stray")))
                .await
                .expect_err("a key nobody published never verifies");
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let waited = asked.elapsed();
        assert!(
            waited < StdDuration::from_secs(1),
            "the request waited {waited:?} for a refresher that had stopped"
        );
        assert_eq!(endpoint.fetches().len(), 1);

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
