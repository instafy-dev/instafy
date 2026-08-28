use std::fmt;
use std::time::Duration;

use anyhow::{Result, bail};
use prost::Message;
use reqwest::Client;
use runtime_contracts::{CreditEventRequest, CreditEventResponse};
use serde::Deserialize;

#[derive(Debug)]
pub struct ControllerCreditsError {
    pub status: reqwest::StatusCode,
    pub body: String,
}

impl fmt::Display for ControllerCreditsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "controller credits returned {}: {}",
            self.status, self.body
        )
    }
}

impl std::error::Error for ControllerCreditsError {}

#[derive(Clone)]
pub struct ControllerClient {
    http: Client,
    base_url: String,
    service_bearer: String,
    credential_lease_bearer: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialResponse {
    pub kind: String,
    pub access_token: Option<String>,
    pub account_id: Option<String>,
    pub openai_api_key: Option<String>,
    pub provider: Option<String>,
    pub upstream_endpoint: Option<String>,
    pub default_model: Option<String>,
    pub auth_mode: Option<String>,
    pub code_assist_project: Option<String>,
    pub lease_expires_in_seconds: Option<u64>,
    pub renewal_authority: Option<String>,
}

impl ControllerClient {
    pub fn new(
        base_url: impl Into<String>,
        service_bearer: impl Into<String>,
        credential_lease_bearer: impl Into<String>,
    ) -> Self {
        Self {
            http: Client::new(),
            base_url: base_url.into(),
            service_bearer: service_bearer.into(),
            credential_lease_bearer: credential_lease_bearer.into(),
        }
    }

    pub async fn send_credit_event(
        &self,
        request: CreditEventRequest,
    ) -> Result<CreditEventResponse> {
        let mut body = Vec::new();
        request.encode(&mut body)?;
        let response = self
            .http
            .post(format!("{}/credits", self.base_url.trim_end_matches('/')))
            .bearer_auth(&self.service_bearer)
            .header("content-type", "application/x-protobuf")
            .header("accept", "application/x-protobuf")
            .body(body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(ControllerCreditsError { status, body: text }.into());
        }

        let bytes = response.bytes().await?;
        let proto = CreditEventResponse::decode(bytes)?;
        Ok(proto)
    }

    pub async fn verify_credential_lease_protocol(&self) -> Result<()> {
        let response = self
            .http
            .get(format!("{}/healthz", self.base_url.trim_end_matches('/')))
            .timeout(Duration::from_secs(2))
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "controller health returned {} while probing credential lease protocol",
                response.status()
            );
        }
        let version = response
            .headers()
            .get("x-instafy-credential-lease-protocol")
            .and_then(|value| value.to_str().ok());
        if version != Some("1") {
            bail!("controller does not support credential lease protocol 1");
        }
        Ok(())
    }

    pub async fn fetch_credential(&self, credential_id: &str) -> Result<CredentialResponse> {
        self.fetch_credential_request(credential_id, false).await
    }

    pub async fn renew_credential_after_rejection(
        &self,
        credential_id: &str,
    ) -> Result<CredentialResponse> {
        self.fetch_credential_request(credential_id, true).await
    }

    async fn fetch_credential_request(
        &self,
        credential_id: &str,
        renew_after_rejection: bool,
    ) -> Result<CredentialResponse> {
        let mut url = format!(
            "{}/internal/credentials/{}",
            self.base_url.trim_end_matches('/'),
            credential_id.trim()
        );
        if renew_after_rejection {
            url.push_str("?forceRefresh=true");
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.credential_lease_bearer)
            .header("accept", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            bail!("controller credentials returned {}: {}", status, text);
        }

        let payload = response.json::<CredentialResponse>().await?;
        Ok(payload)
    }

    /// Report a BYOC subscription-usage snapshot for `credential_id` to the
    /// controller. Authenticated with the same credential-lease bearer as
    /// `fetch_credential*`. This is invoked fire-and-forget from the proxy, so
    /// the caller is responsible for swallowing errors; we still surface them
    /// here so a debug log can name the cause.
    pub async fn post_credential_usage(
        &self,
        credential_id: &str,
        snapshot: &serde_json::Value,
    ) -> Result<()> {
        let url = format!(
            "{}/internal/credentials/{}/usage",
            self.base_url.trim_end_matches('/'),
            credential_id.trim()
        );
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.credential_lease_bearer)
            .header("content-type", "application/json")
            // Bound each best-effort report: a slow/degraded controller must not
            // let a detached task (and its socket) linger indefinitely.
            .timeout(Duration::from_secs(5))
            .json(snapshot)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            bail!("controller credential usage returned {}: {}", status, text);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use axum::extract::{OriginalUri, State};
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    #[derive(Clone, Default)]
    struct Requests(Arc<Mutex<Vec<(String, String)>>>);

    async fn credential_handler(
        State(requests): State<Requests>,
        OriginalUri(uri): OriginalUri,
        headers: HeaderMap,
    ) -> Json<Value> {
        let authorization = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        requests
            .0
            .lock()
            .expect("request lock")
            .push((uri.to_string(), authorization));
        Json(json!({
            "kind": "codex_auth_json",
            "accessToken": "test-access-token",
            "accountId": "acct_test",
            "provider": "openai"
        }))
    }

    async fn health_handler() -> impl IntoResponse {
        (
            axum::http::StatusCode::OK,
            [("x-instafy-credential-lease-protocol", "1")],
        )
    }

    #[tokio::test]
    async fn fetch_credential_can_request_forced_refresh() -> Result<()> {
        let requests = Requests::default();
        let app = Router::new()
            .route("/healthz", get(health_handler))
            .route(
                "/internal/credentials/:credential_id",
                get(credential_handler),
            )
            .with_state(requests.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let client = ControllerClient::new(
            format!("http://{addr}"),
            "service-token",
            "credential-lease-token",
        );
        client.verify_credential_lease_protocol().await?;
        let _ = client.fetch_credential("cred-123").await?;
        let _ = client.renew_credential_after_rejection("cred-123").await?;

        let paths = requests.0.lock().expect("request lock").clone();
        assert_eq!(
            paths,
            vec![
                (
                    "/internal/credentials/cred-123".to_string(),
                    "Bearer credential-lease-token".to_string(),
                ),
                (
                    "/internal/credentials/cred-123?forceRefresh=true".to_string(),
                    "Bearer credential-lease-token".to_string(),
                ),
            ]
        );

        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn missing_credential_lease_protocol_fails_closed() -> Result<()> {
        let app = Router::new().route("/healthz", get(|| async { axum::http::StatusCode::OK }));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let client = ControllerClient::new(
            format!("http://{addr}"),
            "service-token",
            "credential-lease-token",
        );
        assert!(
            client
                .verify_credential_lease_protocol()
                .await
                .expect_err("old controller must be incompatible")
                .to_string()
                .contains("does not support credential lease protocol 1")
        );
        server.abort();
        Ok(())
    }
}
