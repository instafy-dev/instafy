use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet, KeyAlgorithm};
use jsonwebtoken::{Algorithm, DecodingKey};
use reqwest::Client;

#[derive(Clone)]
pub struct SupabaseJwks {
    algorithm: Algorithm,
    keys: Arc<HashMap<String, Arc<DecodingKey>>>,
    default_key: Option<Arc<DecodingKey>>,
}

impl SupabaseJwks {
    pub fn load(jwks_url: &str) -> Result<Self> {
        let set: JwkSet = reqwest::blocking::Client::builder()
            .build()
            .context("failed to construct blocking HTTP client for JWKS fetch")?
            .get(jwks_url)
            .send()
            .with_context(|| format!("failed to fetch Supabase JWKS from {}", jwks_url))?
            .json()
            .context("failed to parse Supabase JWKS response")?;

        Self::from_jwk_set(set)
    }

    pub async fn load_async(client: &Client, jwks_url: &str) -> Result<Self> {
        let response = client
            .get(jwks_url)
            .send()
            .await
            .with_context(|| format!("failed to fetch Supabase JWKS from {}", jwks_url))?;

        let status = response.status();
        if !status.is_success() {
            bail!(
                "failed to fetch Supabase JWKS: status={} url={}",
                status,
                jwks_url
            );
        }

        let set: JwkSet = response
            .json()
            .await
            .context("failed to parse Supabase JWKS response")?;

        Self::from_jwk_set(set)
    }

    pub fn from_jwk_set(set: JwkSet) -> Result<Self> {
        if set.keys.is_empty() {
            bail!("Supabase JWKS response did not contain any keys");
        }

        let mut keys: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        let mut algorithm: Option<Algorithm> = None;
        let mut default_key: Option<Arc<DecodingKey>> = None;

        for jwk in set.keys {
            let kid = jwk
                .common
                .key_id
                .clone()
                .unwrap_or_else(|| "default".to_string());

            let alg = match jwk.common.key_algorithm {
                Some(KeyAlgorithm::ES256) | None => Algorithm::ES256,
                Some(KeyAlgorithm::RS256) => Algorithm::RS256,
                Some(other) => {
                    bail!("Supabase JWKS reported unsupported algorithm {:?}", other)
                }
            };

            if let Some(existing_alg) = algorithm {
                if existing_alg != alg {
                    bail!(
                        "Supabase JWKS returned mixed algorithms (found both {:?} and {:?})",
                        existing_alg,
                        alg
                    );
                }
            } else {
                algorithm = Some(alg);
            }

            let decoding_key = match (&jwk.algorithm, alg) {
                (AlgorithmParameters::EllipticCurve(params), Algorithm::ES256) => {
                    let key = DecodingKey::from_ec_components(&params.x, &params.y)
                        .context("failed to construct EC decoding key from Supabase JWKS entry")?;
                    Arc::new(key)
                }
                (AlgorithmParameters::RSA(params), Algorithm::RS256) => {
                    let key = DecodingKey::from_rsa_components(&params.n, &params.e)
                        .context("failed to construct RSA decoding key from Supabase JWKS entry")?;
                    Arc::new(key)
                }
                _ => {
                    bail!(
                        "Supabase JWKS contained unsupported key parameters for algorithm {:?}",
                        alg
                    )
                }
            };

            if default_key.is_none() {
                default_key = Some(decoding_key.clone());
            }

            keys.insert(kid, decoding_key);
        }

        Ok(Self {
            algorithm: algorithm
                .ok_or_else(|| anyhow!("Supabase JWKS did not contain a usable algorithm"))?,
            keys: Arc::new(keys),
            default_key,
        })
    }

    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }

    pub fn decoding_key(&self, kid: Option<&str>) -> Option<Arc<DecodingKey>> {
        match kid {
            Some(kid) => {
                if let Some(key) = self.keys.get(kid).cloned() {
                    return Some(key);
                }
                // Supabase still uses HS256 for its GoTrue access tokens, but includes a `kid`
                // header that does not correspond to our shared-secret verifier. When we're in
                // HS256 mode, treat `kid` as advisory and fall back to the default key.
                if self.algorithm == Algorithm::HS256 {
                    return self.default_key.clone();
                }
                None
            }
            None => self.default_key.clone(),
        }
    }

    /// Build an HS256-only key set from a shared secret. Used for local Supabase CLI
    /// instances that still rely on the legacy secret signing flow.
    pub fn from_hmac_secret(secret: &str) -> Self {
        let key = Arc::new(DecodingKey::from_secret(secret.as_bytes()));
        let mut map = HashMap::new();
        map.insert("hmac".to_string(), key.clone());
        Self {
            algorithm: Algorithm::HS256,
            keys: Arc::new(map),
            default_key: Some(key),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn hs256_decoding_key_falls_back_when_kid_unknown() {
        let default_key = Arc::new(DecodingKey::from_secret(b"secret"));
        let mut map: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        map.insert("hmac".to_string(), default_key.clone());

        let jwks = SupabaseJwks {
            algorithm: Algorithm::HS256,
            keys: Arc::new(map),
            default_key: Some(default_key.clone()),
        };

        let resolved = jwks
            .decoding_key(Some("supabase-kid"))
            .expect("should resolve");
        assert!(Arc::ptr_eq(&resolved, &default_key));
    }

    #[test]
    fn rs256_decoding_key_does_not_fallback_when_kid_unknown() {
        let default_key = Arc::new(DecodingKey::from_secret(b"secret"));
        let mut map: HashMap<String, Arc<DecodingKey>> = HashMap::new();
        map.insert("default".to_string(), default_key.clone());

        let jwks = SupabaseJwks {
            algorithm: Algorithm::RS256,
            keys: Arc::new(map),
            default_key: Some(default_key),
        };

        assert!(jwks.decoding_key(Some("unknown")).is_none());
    }
}

impl std::fmt::Debug for SupabaseJwks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let key_ids: Vec<&String> = self.keys.keys().collect();
        f.debug_struct("SupabaseJwks")
            .field("algorithm", &self.algorithm)
            .field("key_ids", &key_ids)
            .finish()
    }
}
