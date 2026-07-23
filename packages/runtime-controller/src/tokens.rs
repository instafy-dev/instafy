use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{
    decode, encode, Algorithm, DecodingKey, EncodingKey, Header as JwtHeader, Validation,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{config::AppConfig, internal_error, unauthorized, ApiError};
use runtime_contracts::AccessTokenClaims;

#[derive(Debug)]
pub struct ScopedTokenRequest {
    pub audience: String,
    pub subject: String,
    pub project_id: String,
    pub origin_id: Option<String>,
    pub runtime_id: Option<String>,
    pub protocol: Option<String>,
    pub scopes: Vec<String>,
    pub lease_id: Option<String>,
    pub run_id: Option<String>,
    pub prefer_runtime: Option<String>,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug)]
pub struct MintedAccessToken {
    pub token: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub scopes: Vec<String>,
    pub ttl: i64,
    pub jti: Uuid,
}

pub(crate) fn derive_origin_key_id_from_pem(pem: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pem.trim().as_bytes());
    let digest = hasher.finalize();
    let encoded = URL_SAFE_NO_PAD.encode(digest);
    let suffix = encoded.get(0..16).unwrap_or(&encoded);
    format!("origin-{suffix}")
}

pub fn mint_scoped_token(
    config: &AppConfig,
    request: ScopedTokenRequest,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(config, request, None, None, None, None)
}

pub fn mint_scoped_token_with_runtime_generation(
    config: &AppConfig,
    request: ScopedTokenRequest,
    runtime_generation: Option<Uuid>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(config, request, runtime_generation, None, None, None)
}

/// Mint a runtime-scoped token with controller-attested collaborative browser
/// identity. Ordinary workspace/runtime tokens intentionally omit these
/// presentation/session fields.
pub fn mint_scoped_token_with_browser_actor(
    config: &AppConfig,
    request: ScopedTokenRequest,
    runtime_generation: Option<Uuid>,
    actor_label: Option<String>,
    browser_session_id: Option<String>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(
        config,
        request,
        runtime_generation,
        None,
        actor_label,
        browser_session_id,
    )
}

/// Mint a scoped token whose signed expiry cannot pass an external
/// authorization boundary such as a live workspace lease.
///
/// Ordinary scoped tokens retain the historical 60-second minimum. This
/// narrowly scoped path may shorten the resulting JWT below that floor so a
/// child capability never outlives the authority from which it was derived.
pub fn mint_scoped_token_expires_no_later_than(
    config: &AppConfig,
    request: ScopedTokenRequest,
    latest_expires_at: DateTime<Utc>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    mint_scoped_token_inner(config, request, None, Some(latest_expires_at), None, None)
}

fn mint_scoped_token_inner(
    config: &AppConfig,
    request: ScopedTokenRequest,
    runtime_generation: Option<Uuid>,
    latest_expires_at: Option<DateTime<Utc>>,
    actor_label: Option<String>,
    browser_session_id: Option<String>,
) -> Result<MintedAccessToken, (StatusCode, Json<ApiError>)> {
    let private_key_pem = config
        .origin_token_private_key
        .as_ref()
        .ok_or_else(|| internal_error("origin token signing key not configured"))?;

    let encoding_key = EncodingKey::from_ed_pem(private_key_pem.as_bytes()).map_err(|error| {
        internal_error(format!(
            "failed to construct Ed25519 encoding key from PEM: {error}"
        ))
    })?;

    let issued_at = Utc::now();
    let ttl_source = request
        .ttl_seconds
        .unwrap_or(config.origin_token_ttl_seconds);
    let mut ttl = ttl_source.max(60);
    let mut expires_at = issued_at + ChronoDuration::seconds(ttl);
    if let Some(latest_expires_at) = latest_expires_at {
        let capped_exp_timestamp = expires_at.timestamp().min(latest_expires_at.timestamp());
        if capped_exp_timestamp <= issued_at.timestamp() {
            return Err(unauthorized("scoped token authorization window expired"));
        }
        expires_at = DateTime::<Utc>::from_timestamp(capped_exp_timestamp, 0)
            .ok_or_else(|| internal_error("failed to cap scoped token expiry"))?;
        ttl = capped_exp_timestamp - issued_at.timestamp();
    }
    let jti = Uuid::new_v4();

    let mut header = JwtHeader::new(Algorithm::EdDSA);
    header.kid = Some(
        config
            .origin_token_key_id
            .clone()
            .unwrap_or_else(|| derive_origin_key_id_from_pem(private_key_pem)),
    );

    let scopes = request.scopes.clone();

    let claims = AccessTokenClaims {
        aud: request.audience,
        sub: request.subject,
        project_id: request.project_id,
        origin_id: request.origin_id,
        runtime_id: request.runtime_id,
        protocol: request.protocol,
        scopes: scopes.clone(),
        lease_id: request.lease_id,
        runtime_generation: runtime_generation.map(|generation| generation.to_string()),
        run_id: request.run_id,
        iat: issued_at.timestamp(),
        exp: expires_at.timestamp(),
        jti: jti.to_string(),
        prefer_runtime: request.prefer_runtime,
        actor_label,
        browser_session_id,
    };

    let token = encode(&header, &claims, &encoding_key)
        .map_err(|error| internal_error(format!("failed to sign access token: {error}")))?;

    Ok(MintedAccessToken {
        token,
        issued_at,
        expires_at,
        scopes,
        ttl,
        jti,
    })
}

pub fn decode_scoped_token(
    config: &AppConfig,
    token: &str,
    token_label: &str,
) -> Result<AccessTokenClaims, (StatusCode, Json<ApiError>)> {
    let decoding_source = config
        .origin_token_public_key
        .as_ref()
        .or(config.origin_token_private_key.as_ref())
        .ok_or_else(|| unauthorized(format!("{token_label} public/private key not configured")))?;

    let decoding_key = DecodingKey::from_ed_pem(decoding_source.as_bytes()).map_err(|error| {
        internal_error(format!(
            "failed to construct Ed25519 decoding key from PEM: {error}"
        ))
    })?;

    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.validate_exp = true;
    validation.validate_aud = false;

    let token_data = decode::<AccessTokenClaims>(token, &decoding_key, &validation).map_err(
        |error| match error.kind() {
            JwtErrorKind::ExpiredSignature => unauthorized(format!("{token_label} expired")),
            _ => unauthorized(format!("invalid {token_label}")),
        },
    )?;

    Ok(token_data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(ttl_seconds: i64) -> ScopedTokenRequest {
        ScopedTokenRequest {
            audience: "git".to_string(),
            subject: Uuid::new_v4().to_string(),
            project_id: Uuid::new_v4().to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: Some("git".to_string()),
            scopes: vec!["git.read".to_string(), "git.write".to_string()],
            lease_id: Some(Uuid::new_v4().to_string()),
            run_id: Some(Uuid::new_v4().to_string()),
            prefer_runtime: None,
            ttl_seconds: Some(ttl_seconds),
        }
    }

    #[test]
    fn expiry_capped_child_token_can_be_shorter_than_global_minimum() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-expiry-cap",
        );
        let lease_expires_at = Utc::now() + ChronoDuration::seconds(27);
        let minted =
            mint_scoped_token_expires_no_later_than(&config, request(600), lease_expires_at)
                .expect("mint lease-capped child token");
        let claims = decode_scoped_token(&config, &minted.token, "lease-capped token")
            .expect("decode lease-capped child token");

        assert!(claims.exp <= lease_expires_at.timestamp());
        assert!(claims.exp - claims.iat > 0);
        assert!(claims.exp - claims.iat < 60);
        assert_eq!(minted.ttl, claims.exp - claims.iat);
    }

    #[test]
    fn expiry_capped_child_token_rejects_expired_authority() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-expired-cap",
        );
        assert!(mint_scoped_token_expires_no_later_than(
            &config,
            request(600),
            Utc::now() - ChronoDuration::seconds(1),
        )
        .is_err());
    }

    #[test]
    fn browser_actor_identity_is_signed_into_the_scoped_token() {
        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "scoped-token-browser-actor",
        );
        let runtime_generation = Uuid::new_v4();
        let minted = mint_scoped_token_with_browser_actor(
            &config,
            request(600),
            Some(runtime_generation),
            Some("Ada Lovelace".to_string()),
            Some("browser-tab-123".to_string()),
        )
        .expect("mint browser actor token");
        let claims = decode_scoped_token(&config, &minted.token, "browser actor token")
            .expect("decode browser actor token");

        assert_eq!(claims.actor_label.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            claims.browser_session_id.as_deref(),
            Some("browser-tab-123")
        );
        assert_eq!(
            claims.runtime_generation.as_deref(),
            Some(runtime_generation.to_string().as_str())
        );
    }
}
