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
pub struct OriginJwks {
    keys: Arc<HashMap<String, Arc<DecodingKey>>>,
    default_key: Option<Arc<DecodingKey>>,
}

impl OriginJwks {
    pub async fn fetch(client: &Client, url: &Url) -> Result<Self> {
        let response = client
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("failed to fetch origin JWKS from {}", url))?;

        let status = response.status();
        if !status.is_success() {
            bail!("origin JWKS request failed: status={} url={}", status, url);
        }

        let set: JwkSet = response
            .json()
            .await
            .context("failed to parse origin JWKS response")?;

        Self::from_jwk_set(set)
    }

    pub fn from_jwk_set(set: JwkSet) -> Result<Self> {
        if set.keys.is_empty() {
            bail!("origin JWKS response did not include any keys");
        }

        let mut keys = HashMap::new();
        let mut default = None;

        for jwk in set.keys {
            let kid = jwk
                .common
                .key_id
                .clone()
                .unwrap_or_else(|| "origin".to_string());

            if !matches!(jwk.common.key_algorithm, Some(KeyAlgorithm::EdDSA) | None) {
                bail!(
                    "origin JWKS reported unsupported algorithm {:?}",
                    jwk.common.key_algorithm
                );
            }

            match &jwk.algorithm {
                AlgorithmParameters::OctetKeyPair(params) => {
                    if params.curve != EllipticCurve::Ed25519 {
                        bail!("origin JWKS contained unsupported curve {:?}", params.curve);
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
                other => {
                    bail!("origin JWKS contained unsupported parameters {:?}", other);
                }
            }
        }

        if keys.is_empty() {
            bail!("origin JWKS did not produce any decoding keys");
        }

        Ok(Self {
            keys: Arc::new(keys),
            default_key: default,
        })
    }

    pub fn decoding_key(&self, kid: Option<&str>) -> Option<Arc<DecodingKey>> {
        match kid {
            Some(kid) => self.keys.get(kid).cloned(),
            None => self.default_key.clone(),
        }
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
