use anyhow::Result;
use reqwest::{Client, StatusCode};
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
    let body = resp.bytes().await.unwrap_or_default();
    acl_decision(status, &body)
}

/// The ACL hook's answer. Only a 2xx whose body says `{"allowed": true}` allows; any other 2xx
/// body and any 4xx deny, so a hook that answers something unexpected never opens a tunnel. A
/// 5xx is an error.
fn acl_decision(status: StatusCode, body: &[u8]) -> Result<bool> {
    if status.is_success() {
        return Ok(serde_json::from_slice::<AclResponse>(body)
            .map(|acl| acl.allowed)
            .unwrap_or(false));
    }

    if status.is_client_error() {
        return Ok(false);
    }

    anyhow::bail!(
        "acl hook returned {}: {}",
        status,
        String::from_utf8_lossy(body)
    );
}

pub async fn emit_event(client: &Client, cfg: &HookConfig, payload: &EventPayload<'_>) {
    let _ = client
        .post(&cfg.url)
        .bearer_auth(cfg.token.as_deref().unwrap_or_default())
        .json(payload)
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acl_allows_only_an_explicit_allowed_true() {
        assert!(acl_decision(StatusCode::OK, br#"{"allowed":true}"#).unwrap());
        assert!(!acl_decision(
            StatusCode::OK,
            br#"{"allowed":false,"reason":"no credits"}"#
        )
        .unwrap());
    }

    #[test]
    fn acl_denies_a_2xx_it_cannot_read() {
        for body in [
            &b""[..],
            b"ok",
            b"{}",
            br#"{"allowed":"yes"}"#,
            b"<html></html>",
        ] {
            assert!(
                !acl_decision(StatusCode::OK, body).unwrap(),
                "body {:?} must deny",
                String::from_utf8_lossy(body)
            );
        }
        assert!(!acl_decision(StatusCode::NO_CONTENT, b"").unwrap());
    }

    #[test]
    fn acl_denies_a_4xx_and_errors_on_a_5xx() {
        assert!(!acl_decision(StatusCode::UNAUTHORIZED, b"").unwrap());
        assert!(!acl_decision(StatusCode::NOT_FOUND, b"").unwrap());
        assert!(acl_decision(StatusCode::SERVICE_UNAVAILABLE, b"down").is_err());
    }
}
