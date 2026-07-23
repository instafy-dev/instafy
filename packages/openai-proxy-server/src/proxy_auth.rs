use std::env;

use anyhow::{Result, anyhow};
use axum::http::{HeaderMap, header};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct ProxyTokenValidator {
    decoding_key: DecodingKey,
    validation: Validation,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ProxyClaims {
    #[serde(default, rename = "aud")]
    pub _aud: Option<String>,
    #[serde(default, rename = "iss")]
    pub _iss: Option<String>,
    pub project_id: String,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub agent_handle: Option<String>,
    #[serde(default)]
    pub agent_display_name: Option<String>,
    #[serde(default)]
    pub agent_description: Option<String>,
    #[serde(default)]
    pub exp: Option<i64>,
}

impl ProxyTokenValidator {
    pub fn from_env(require: bool) -> Option<Self> {
        let secret = read_env("PROXY_SIGNING_SECRET").or_else(|| {
            read_env("CONTROLLER_INTERNAL_TOKEN")
                .map(|token| format!("instafy-proxy-signing:{token}"))
        });

        let secret = match secret {
            Some(value) => value,
            None if require => {
                eprintln!("[proxy] PROXY_SIGNING_SECRET missing; proxy tokens cannot be validated");
                return None;
            }
            None => return None,
        };

        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&["proxy"]);

        Some(Self {
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
            validation,
        })
    }

    pub fn authenticate(&self, headers: &HeaderMap) -> Result<ProxyClaims> {
        let auth_header = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| anyhow!("missing Authorization header"))?;

        let token = auth_header
            .trim()
            .strip_prefix("Bearer ")
            .or_else(|| auth_header.trim().strip_prefix("bearer "))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("invalid Authorization header"))?;

        let claims = decode::<ProxyClaims>(token, &self.decoding_key, &self.validation)
            .map_err(|error| anyhow!("invalid proxy token: {error}"))?
            .claims;

        if claims.project_id.trim().is_empty() {
            return Err(anyhow!("proxy token missing project_id claim"));
        }

        Ok(claims)
    }
}

fn read_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
