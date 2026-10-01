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
    /// The agent job and lease attempt a job token was minted for. Only the
    /// controller's job lease sets them; other tokens, and every token from
    /// a controller that predates them, carry neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_attempt: Option<i64>,
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

        Some(Self::from_secret(&secret))
    }

    fn from_secret(secret: &str) -> Self {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&["proxy"]);

        Self {
            decoding_key: DecodingKey::from_secret(secret.as_bytes()),
            validation,
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::{Value, json};

    const SECRET: &str = "proxy-auth-test-secret";

    fn bearer(claims: &Value) -> HeaderMap {
        let token = encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .expect("sign test token");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("header value"),
        );
        headers
    }

    fn controller_claims() -> Value {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs() as i64;
        json!({
            "aud": "proxy",
            "iss": "runtime-controller",
            "sub": "proxy:project:runtime",
            "project_id": "11111111-1111-4111-8111-111111111111",
            "runtime_id": "22222222-2222-4222-8222-222222222222",
            "run_id": "33333333-3333-4333-8333-333333333333",
            "iat": now,
            "exp": now + 300,
        })
    }

    #[test]
    fn proxy_claims_accept_job_binding_and_legacy_tokens() {
        let validator = ProxyTokenValidator::from_secret(SECRET);

        let mut bound = controller_claims();
        bound["job_id"] = json!("44444444-4444-4444-8444-444444444444");
        bound["lease_attempt"] = json!(2);
        let claims = validator
            .authenticate(&bearer(&bound))
            .expect("a job token is accepted");
        assert_eq!(
            claims.job_id.as_deref(),
            Some("44444444-4444-4444-8444-444444444444")
        );
        assert_eq!(claims.lease_attempt, Some(2));
        assert_eq!(
            claims.run_id.as_deref(),
            Some("33333333-3333-4333-8333-333333333333")
        );

        // A controller that predates the binding signs neither claim.
        let claims = validator
            .authenticate(&bearer(&controller_claims()))
            .expect("a legacy token is still accepted");
        assert_eq!(claims.job_id, None);
        assert_eq!(claims.lease_attempt, None);
        assert_eq!(
            claims.run_id.as_deref(),
            Some("33333333-3333-4333-8333-333333333333")
        );

        // Claims this proxy does not know yet are ignored.
        let mut newer = controller_claims();
        newer["some_future_claim"] = json!({ "nested": true });
        validator
            .authenticate(&bearer(&newer))
            .expect("unknown claims are ignored");
    }
}
