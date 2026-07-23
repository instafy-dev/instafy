use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

pub type LabelMap = HashMap<String, String>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelStatus {
    Requested,
    Active,
    Refreshing,
    Revoking,
    Revoked,
    Error,
}

impl Default for TunnelStatus {
    fn default() -> Self {
        TunnelStatus::Requested
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTunnelRequest {
    pub project_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<Uuid>,
    /// Optional idempotency key (caller-defined). When provided, the broker should return the
    /// existing tunnel assignment for repeated requests using the same key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<LabelMap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelResponse {
    pub tunnel: TunnelDescriptor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit: Option<CreditSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelDescriptor {
    pub tunnel_id: Uuid,
    pub hostname: String,
    pub status: TunnelStatus,
    pub ingress_host: String,
    pub ingress_port: u16,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub client: RatholeClientConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreditSnapshot {
    pub balance: i32,
    pub credit_limit: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_after: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelTokenClaims {
    pub sub: String,
    pub project_id: Uuid,
    pub hostname: String,
    pub ingress_host: String,
    pub ingress_port: u16,
    pub iss: String,
    pub iat: i64,
    pub exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aud: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RatholeClientConfig {
    pub server: String,
    pub token: String,
    pub hostname: String,
    /// Optional per-tunnel rathole service name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    /// Optional per-tunnel remote port bound on the ingress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub protocol: ClientProtocol,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_http_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_tcp_port: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClientProtocol {
    Tcp,
    Http,
}

impl Default for ClientProtocol {
    fn default() -> Self {
        ClientProtocol::Tcp
    }
}
