use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    pub aud: String,
    pub sub: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
    /// Stable controller-owned runtime generation for self-hosted runtimes.
    /// Unlike `jti`, this value is preserved across ordinary token renewals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefer_runtime: Option<String>,
    /// Controller-attested display label for short-lived collaborative UI.
    /// This is presentation metadata only; authorization remains bound to
    /// `sub`, scopes, project, runtime, and the browser client session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_label: Option<String>,
    /// Per-tab/device browser client identity, supplied while minting the
    /// token and then signed by the controller. Shared Browser control leases
    /// bind to `(sub, browser_session_id)` so two devices for one account do
    /// not silently share input authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyEnvelopePayload {
    pub url: String,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl ProxyEnvelopePayload {
    pub fn from_parts(url: String, token: String, expires_at: DateTime<Utc>) -> Self {
        Self {
            url,
            token,
            expires_at: Some(expires_at.to_rfc3339()),
        }
    }
}
