use axum::http::{header, HeaderMap};
use base64::Engine as _;
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use runtime_contracts::AccessTokenClaims;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::sync::RwLock;
use tracing::warn;

use crate::error::ServiceError;
use crate::jwks::Ed25519Jwks;

const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct TokenValidator {
    client: reqwest::Client,
    jwks_url: reqwest::Url,
    cache: Arc<RwLock<Option<Ed25519Jwks>>>,
    refresh_state: Arc<Mutex<Option<Instant>>>,
}

impl TokenValidator {
    pub fn new(client: reqwest::Client, jwks_url: reqwest::Url) -> Self {
        Self {
            client,
            jwks_url,
            cache: Arc::new(RwLock::new(None)),
            refresh_state: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn validate(
        &self,
        token: &str,
        expected_audience: Option<&str>,
    ) -> Result<AccessTokenClaims, ServiceError> {
        let header = decode_header(token).map_err(|error| {
            ServiceError::unauthorized(format!("invalid token header: {error}"))
        })?;
        let kid = header.kid.as_deref();
        let algorithm = header.alg;

        let mut validation = Validation::new(algorithm_for_decode(algorithm));
        validation.validate_exp = true;
        validation.leeway = 5;
        if let Some(aud) = expected_audience {
            validation.set_audience(&[aud]);
        } else {
            validation.validate_aud = false;
        }

        let key = self.decoding_key(kid).await.map_err(|error| {
            ServiceError::unauthorized(format!("token validation failed: {error}"))
        })?;

        match decode::<AccessTokenClaims>(token, &key, &validation) {
            Ok(data) => Ok(data.claims),
            Err(error) => {
                let should_refresh = matches!(error.kind(), JwtErrorKind::InvalidSignature);
                if should_refresh {
                    warn!(
                        kid = kid.unwrap_or(""),
                        algorithm = ?algorithm,
                        "token signature invalid; refreshing JWKS"
                    );
                    let _ = self.refresh_jwks().await;
                    let refreshed_key = self.decoding_key(kid).await.map_err(|error| {
                        ServiceError::unauthorized(format!("token validation failed: {error}"))
                    })?;
                    match decode::<AccessTokenClaims>(token, &refreshed_key, &validation) {
                        Ok(data) => return Ok(data.claims),
                        Err(retry_error) => {
                            warn!(
                                ?retry_error,
                                kid = kid.unwrap_or(""),
                                algorithm = ?algorithm,
                                "token validation failed after JWKS refresh"
                            );
                            return Err(ServiceError::unauthorized(format!(
                                "invalid token: {retry_error}"
                            )));
                        }
                    }
                }

                warn!(
                    ?error,
                    kid = kid.unwrap_or(""),
                    algorithm = ?algorithm,
                    "token validation failed"
                );
                Err(ServiceError::unauthorized(format!(
                    "invalid token: {error}"
                )))
            }
        }
    }

    async fn decoding_key(&self, kid: Option<&str>) -> anyhow::Result<Arc<DecodingKey>> {
        {
            let guard = self.cache.read().await;
            if let Some(jwks) = guard.as_ref() {
                if let Some(key) = jwks.decoding_key(kid) {
                    return Ok(key);
                }
            }
        }

        let fresh = Ed25519Jwks::fetch(&self.client, &self.jwks_url).await?;
        let key = fresh
            .decoding_key(kid)
            .ok_or_else(|| anyhow::anyhow!("key id {:?} not found in JWKS", kid))?;

        let mut guard = self.cache.write().await;
        *guard = Some(fresh);

        Ok(key)
    }

    async fn refresh_jwks(&self) -> anyhow::Result<()> {
        let now = Instant::now();
        let mut last = self.refresh_state.lock().await;
        if let Some(last_at) = *last {
            if now.duration_since(last_at) < JWKS_REFRESH_COOLDOWN {
                return Ok(());
            }
        }
        *last = Some(now);
        drop(last);

        let fresh = Ed25519Jwks::fetch(&self.client, &self.jwks_url).await?;
        let mut guard = self.cache.write().await;
        *guard = Some(fresh);
        Ok(())
    }
}

pub fn extract_token(headers: &HeaderMap) -> Result<String, ServiceError> {
    let header_value = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| ServiceError::unauthorized("missing Authorization header"))?;

    let raw = header_value
        .to_str()
        .map_err(|_| ServiceError::unauthorized("invalid Authorization header"))?
        .trim();

    if raw.is_empty() {
        return Err(ServiceError::unauthorized("missing Authorization header"));
    }

    if let Some(value) = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
    {
        let token = value.trim();
        if token.is_empty() {
            return Err(ServiceError::unauthorized("missing bearer token"));
        }
        return Ok(token.to_string());
    }

    if let Some(value) = raw
        .strip_prefix("Basic ")
        .or_else(|| raw.strip_prefix("basic "))
    {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(value.trim())
            .map_err(|_| ServiceError::unauthorized("invalid basic auth header"))?;
        let as_string = String::from_utf8_lossy(&decoded);
        let token = as_string
            .split_once(':')
            .map(|(_, p)| p)
            .unwrap_or(as_string.as_ref());
        let token = token.trim();
        if token.is_empty() {
            return Err(ServiceError::unauthorized("missing basic token"));
        }
        return Ok(token.to_string());
    }

    Err(ServiceError::unauthorized(
        "unsupported Authorization scheme (use Bearer or Basic)",
    ))
}

fn algorithm_for_decode(header_alg: Algorithm) -> Algorithm {
    match header_alg {
        Algorithm::EdDSA => Algorithm::EdDSA,
        other => other,
    }
}
