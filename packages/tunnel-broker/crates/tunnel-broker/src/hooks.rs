use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::config::HookConfig;

#[derive(Debug, Serialize)]
pub struct AclRequest {
    pub intent: String,
    pub project_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonValue>,
}

#[derive(Debug, Deserialize)]
pub struct AclResponse {
    pub allowed: bool,
    #[serde(default)]
    #[allow(dead_code)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventPayload<'a> {
    pub kind: &'a str,
    pub project_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<Uuid>,
    pub data: JsonValue,
}

pub async fn check_acl(client: &Client, cfg: &HookConfig, body: &AclRequest) -> Result<bool> {
    let resp = client
        .post(&cfg.url)
        .bearer_auth(cfg.token.as_deref().unwrap_or_default())
        .json(body)
        .send()
        .await?;

    let status = resp.status();
    if status.is_success() {
        let acl: AclResponse = resp.json().await.unwrap_or(AclResponse {
            allowed: true,
            reason: None,
        });
        return Ok(acl.allowed);
    }

    if status.is_client_error() {
        return Ok(false);
    }

    let body = resp.text().await.unwrap_or_default();
    anyhow::bail!("acl hook returned {}: {}", status, body);
}

pub async fn emit_event(client: &Client, cfg: &HookConfig, payload: &EventPayload<'_>) {
    let _ = client
        .post(&cfg.url)
        .bearer_auth(cfg.token.as_deref().unwrap_or_default())
        .json(payload)
        .send()
        .await;
}
