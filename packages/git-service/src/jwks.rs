use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use jsonwebtoken::jwk::{AlgorithmParameters, EllipticCurve, JwkSet, KeyAlgorithm};
use jsonwebtoken::{Algorithm, DecodingKey};
use reqwest::{Client, Url};
use std::str;

const ED25519_DER_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Clone)]
pub struct Ed25519Jwks {
    keys: Arc<HashMap<String, Arc<DecodingKey>>>,
    default_key: Option<Arc<DecodingKey>>,
}

impl Ed25519Jwks {
    pub async fn fetch(client: &Client, url: &Url) -> Result<Self> {
        let response = client
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("failed to fetch JWKS from {}", url))?;

        let status = response.status();
        if !status.is_success() {
            bail!("JWKS request failed: status={} url={}", status, url);
        }

        let set: JwkSet = response
            .json()
            .await
            .context("failed to parse JWKS response")?;
        Self::from_jwk_set(set)
    }

    pub fn from_jwk_set(set: JwkSet) -> Result<Self> {
        if set.keys.is_empty() {
            bail!("JWKS response did not include any keys");
        }

        let mut keys = HashMap::new();
        let mut default = None;

        for jwk in set.keys {
            let kid = jwk
                .common
                .key_id
                .clone()
                .unwrap_or_else(|| "default".to_string());

            if !matches!(jwk.common.key_algorithm, Some(KeyAlgorithm::EdDSA) | None) {
                bail!(
                    "JWKS reported unsupported algorithm {:?}",
                    jwk.common.key_algorithm
                );
            }

            match &jwk.algorithm {
                AlgorithmParameters::OctetKeyPair(params) => {
                    if params.curve != EllipticCurve::Ed25519 {
                        bail!("JWKS contained unsupported curve {:?}", params.curve);
                    }
                    let der = decode_ed25519_der(&params.x)?;
                    let pem = der_to_pem(&der);
                    let decoding_key = DecodingKey::from_ed_pem(pem.as_bytes())
                        .context("failed to parse Ed25519 public key from JWKS")?;
                    let key = Arc::new(decoding_key);
                    if default.is_none() {
                        default = Some(key.clone());
                    }
                    keys.insert(kid, key);
                }
                other => bail!("JWKS contained unsupported parameters {:?}", other),
            }
        }

        if keys.is_empty() {
            bail!("JWKS did not produce any decoding keys");
        }

        Ok(Self {
            keys: Arc::new(keys),
            default_key: default,
        })
    }

    pub fn decoding_key(&self, kid: Option<&str>) -> Option<Arc<DecodingKey>> {
        if let Some(kid) = kid {
            if let Some(key) = self.keys.get(kid) {
                return Some(key.clone());
            }
        }
        self.default_key.clone()
    }

    pub fn algorithm(&self) -> Algorithm {
        Algorithm::EdDSA
    }
}

fn decode_ed25519_der(x: &str) -> Result<Vec<u8>> {
    let mut der = Vec::with_capacity(ED25519_DER_PREFIX.len() + 32);
    der.extend_from_slice(ED25519_DER_PREFIX);

    let raw = URL_SAFE_NO_PAD
        .decode(x)
        .with_context(|| "failed to decode Ed25519 public key material")?;
    if raw.len() != 32 {
        bail!(
            "Ed25519 public key must be 32 bytes, received {} bytes",
            raw.len()
        );
    }
    der.extend_from_slice(&raw);
    Ok(der)
}

fn der_to_pem(der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let mut pem = String::with_capacity(body.len() + 64);
    pem.push_str("-----BEGIN PUBLIC KEY-----\n");
    for chunk in body.as_bytes().chunks(64) {
        let line = str::from_utf8(chunk).expect("base64 chunk is valid utf8");
        pem.push_str(line);
        pem.push('\n');
    }
    pem.push_str("-----END PUBLIC KEY-----\n");
    pem
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
    use jsonwebtoken::errors::ErrorKind;
    use jsonwebtoken::{decode, encode, EncodingKey, Header, Validation};
    use serde_json::{json, Value};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A fresh Ed25519 key as (PKCS#8 private key, raw public key).
    fn generate_key() -> (Vec<u8>, Vec<u8>) {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).expect("generate key");
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse generated key");
        (pkcs8.as_ref().to_vec(), pair.public_key().as_ref().to_vec())
    }

    fn sign(pkcs8: &[u8]) -> String {
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after the epoch")
            .as_secs()
            + 600;
        let header = Header {
            kid: Some("edge".to_string()),
            ..Header::new(Algorithm::EdDSA)
        };
        let claims = json!({ "sub": "user", "exp": exp });
        encode(&header, &claims, &EncodingKey::from_ed_der(pkcs8)).expect("sign")
    }

    // TokenValidator refreshes the JWKS only when a decode fails with
    // InvalidSignature, so pin that kind as well as the accepted path.
    #[test]
    fn jwks_key_accepts_its_own_signature_and_rejects_another_keys() {
        let (pkcs8, public_key) = generate_key();
        let (other_pkcs8, _) = generate_key();
        let set: JwkSet = serde_json::from_value(json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "kid": "edge",
                "x": URL_SAFE_NO_PAD.encode(&public_key)
            }]
        }))
        .expect("parse JWKS");
        let jwks = Ed25519Jwks::from_jwk_set(set).expect("build JWKS keys");
        let key = jwks.decoding_key(Some("edge")).expect("key for kid");
        let mut validation = Validation::new(jwks.algorithm());
        validation.validate_aud = false;

        let accepted = decode::<Value>(&sign(&pkcs8), &key, &validation).expect("own signature");
        assert_eq!(accepted.claims["sub"], "user");

        let error = decode::<Value>(&sign(&other_pkcs8), &key, &validation)
            .expect_err("another key's signature");
        assert!(
            matches!(error.kind(), ErrorKind::InvalidSignature),
            "unexpected error kind: {:?}",
            error.kind()
        );
    }
}
