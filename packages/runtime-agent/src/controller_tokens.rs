use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use origin_http_server::jwks::OriginJwks;
use reqwest::{Client, Url};
use runtime_contracts::AccessTokenClaims;
use tokio::sync::RwLock;

pub struct ControllerTokenVerifier {
    client: Client,
    jwks_url: Url,
    jwks: RwLock<Option<OriginJwks>>,
}

impl ControllerTokenVerifier {
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
        expected_audience: Option<&str>,
    ) -> Result<AccessTokenClaims> {
        let header = decode_header(token)
            .context("failed to decode controller token header for verification")?;
        let kid = header.kid.as_deref();

        let key = self.decoding_key(kid).await?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.validate_exp = true;
        if let Some(audience) = expected_audience {
            validation.set_audience(&[audience]);
        } else {
            validation.validate_aud = false;
        }

        match decode::<AccessTokenClaims>(token, key.as_ref(), &validation) {
            Ok(data) => Ok(data.claims),
            Err(error) if matches!(error.kind(), JwtErrorKind::InvalidSignature) => {
                self.refresh_jwks().await?;
                let key = self.decoding_key(kid).await?;
                let data = decode::<AccessTokenClaims>(token, key.as_ref(), &validation)
                    .map_err(|decode_error| {
                        anyhow!(
                            "failed to validate controller token signature after JWKS refresh: {decode_error}"
                        )
                    })?;
                Ok(data.claims)
            }
            Err(error) => Err(anyhow!("failed to verify controller token: {error}")),
        }
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
