use anyhow::Result;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::time::Duration;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAuthRequest {
    pub tunnel_id: Uuid,
    /// Lowercase hex sha256 of the hostname label; the raw label never leaves the broker.
    pub capability_hash: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAuthDecision {
    pub allow: bool,
    #[serde(default)]
    pub ttl_seconds: i64,
}

/// Forward auth sits on every preview request, so a slow controller must not stall the page.
const PREVIEW_AUTH_TIMEOUT: Duration = Duration::from_secs(3);

/// Any transport error, non-2xx status or malformed body is an `Err`; callers deny on it.
pub async fn check_preview_auth(
    client: &Client,
    cfg: &HookConfig,
    body: &PreviewAuthRequest,
) -> Result<PreviewAuthDecision> {
    let resp = client
        .post(&cfg.url)
        .bearer_auth(cfg.token.as_deref().unwrap_or_default())
        .timeout(PREVIEW_AUTH_TIMEOUT)
        .json(body)
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("preview auth hook returned {status}");
    }
    Ok(resp.json().await?)
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

/// Events are fire-and-forget: one attempt, never retried, never failing the caller. A
/// delivery the hook did not accept is logged, so a wrong URL or token shows up in the logs.
pub async fn emit_event(client: &Client, cfg: &HookConfig, payload: &EventPayload<'_>) {
    if let Err(error) = deliver_event(client, cfg, payload).await {
        tracing::warn!(
            kind = payload.kind,
            project_id = %payload.project_id,
            error = %error,
            "event hook delivery failed"
        );
    }
}

/// One delivery attempt. A transport error and any non-2xx answer are an `Err`.
async fn deliver_event(
    client: &Client,
    cfg: &HookConfig,
    payload: &EventPayload<'_>,
) -> Result<()> {
    let status = client
        .post(&cfg.url)
        .bearer_auth(cfg.token.as_deref().unwrap_or_default())
        .json(payload)
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("event hook unreachable: {}", error.without_url()))?
        .status();
    if !status.is_success() {
        anyhow::bail!("event hook returned {status}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A hook that answers one request with `status_line`.
    async fn hook_answering(status_line: &'static str) -> HookConfig {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let reply = format!("{status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = socket.write_all(reply.as_bytes()).await;
        });
        HookConfig {
            url: format!("http://{addr}/tunnel-broker/hooks/events"),
            token: Some("hook-token".into()),
        }
    }

    fn event() -> EventPayload<'static> {
        EventPayload {
            kind: "tunnel.created",
            project_id: Uuid::new_v4(),
            org_id: None,
            runtime_id: None,
            lease_id: None,
            data: serde_json::json!({}),
        }
    }

    #[tokio::test]
    async fn event_delivery_reports_what_the_hook_did_not_accept() {
        let client = Client::new();
        let accepted = hook_answering("HTTP/1.1 204 No Content").await;
        assert!(deliver_event(&client, &accepted, &event()).await.is_ok());

        let rejected = hook_answering("HTTP/1.1 401 Unauthorized").await;
        let error = deliver_event(&client, &rejected, &event())
            .await
            .expect_err("a 401 is not a delivery");
        assert!(error.to_string().contains("401"), "{error}");

        let failing = hook_answering("HTTP/1.1 500 Internal Server Error").await;
        assert!(deliver_event(&client, &failing, &event()).await.is_err());

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unreachable = HookConfig {
            url: format!("http://{}/hooks/events", closed.local_addr().unwrap()),
            token: Some("hook-token".into()),
        };
        drop(closed);
        let error = deliver_event(&client, &unreachable, &event())
            .await
            .expect_err("nothing listening");
        assert!(error.to_string().contains("unreachable"), "{error}");
    }

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
