use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use origin_http_server::jwks::OriginJwks;
use reqwest::{Client, Url};
use runtime_contracts::AccessTokenClaims;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct AgentTokenVerifier {
    client: Client,
    jwks_url: Url,
    jwks: RwLock<Option<OriginJwks>>,
}

impl AgentTokenVerifier {
    pub fn new(jwks_url: Url) -> Self {
        Self {
            client: Client::new(),
            jwks_url,
            jwks: RwLock::new(None),
        }
    }

    pub async fn verify(
        &self,
        token: &str,
        expected_project: &Uuid,
        expected_runtime: Option<&Uuid>,
        required_scopes: &[&str],
    ) -> Result<AccessTokenClaims> {
        let header =
            decode_header(token).context("failed to decode agent token header for verification")?;
        let kid = header.kid.as_deref();

        let key = self.decoding_key(kid).await?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.validate_exp = true;

        if let Some(runtime_id) = expected_runtime {
            let runtime_id_str = runtime_id.to_string();
            validation.set_audience(&[runtime_id_str.as_str()]);
        } else {
            validation.validate_aud = false;
        }

        let claims = match decode::<AccessTokenClaims>(token, key.as_ref(), &validation) {
            Ok(data) => data.claims,
            Err(error) if matches!(error.kind(), JwtErrorKind::InvalidSignature) => {
                self.refresh_jwks().await?;
                let key = self.decoding_key(kid).await?;
                let data = decode::<AccessTokenClaims>(token, key.as_ref(), &validation)
                    .map_err(|decode_error| {
                        anyhow!(
                            "failed to validate agent token signature after JWKS refresh: {decode_error}"
                        )
                    })?;
                data.claims
            }
            Err(error) => return Err(anyhow!("failed to verify agent token: {error}")),
        };

        if claims.project_id != expected_project.to_string() {
            return Err(anyhow!(
                "agent token project mismatch: expected {}, received {}",
                expected_project,
                claims.project_id
            ));
        }

        if let Some(runtime_id) = expected_runtime {
            let runtime_id_str = runtime_id.to_string();
            match claims.runtime_id.as_deref() {
                Some(value) if value == runtime_id_str => {}
                Some(value) => {
                    return Err(anyhow!(
                        "agent token runtime mismatch: expected {}, received {}",
                        runtime_id_str,
                        value
                    ));
                }
                None => {
                    return Err(anyhow!(
                        "agent token missing runtime scope (expected runtime {})",
                        runtime_id
                    ));
                }
            }
        }

        for scope in required_scopes {
            if !claims.scopes.iter().any(|value| value == scope) {
                return Err(anyhow!(
                    "agent token missing required scope {:?}; claims: {:?}",
                    scope,
                    claims.scopes
                ));
            }
        }

        Ok(claims)
    }

    async fn decoding_key(&self, kid: Option<&str>) -> Result<Arc<DecodingKey>> {
        if let Some(key) = self.try_decoding_key(kid).await? {
            return Ok(key);
        }
        self.refresh_jwks().await?;
        self.try_decoding_key(kid)
            .await?
            .ok_or_else(|| anyhow!("controller JWKS did not contain key {:?}", kid))
    }

    async fn try_decoding_key(&self, kid: Option<&str>) -> Result<Option<Arc<DecodingKey>>> {
        let guard = self.jwks.read().await;
        Ok(guard.as_ref().and_then(|jwks| jwks.decoding_key(kid)))
    }

    async fn refresh_jwks(&self) -> Result<()> {
        let jwks = OriginJwks::fetch(&self.client, &self.jwks_url)
            .await
            .with_context(|| format!("failed to fetch controller JWKS from {}", self.jwks_url))?;
        let mut guard = self.jwks.write().await;
        *guard = Some(jwks);
        Ok(())
    }
}
