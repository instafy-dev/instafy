use super::*;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RENEWAL_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;

/// No response body, request URL, or credential material enters this error.
#[derive(Debug, thiserror::Error)]
pub enum JobProxyTokenError {
    #[error("job proxy token renewal request failed")]
    RequestFailed,
    #[error("job proxy token renewal rejected (status={0})")]
    Rejected(u16),
    #[error("job proxy token renewal returned an invalid response")]
    InvalidResponse,
    #[error("job proxy token renewal timed out")]
    TimedOut,
}

impl ControllerClient {
    /// The machine bearer authenticates this call. The attempt is only a fence;
    /// every identity and the replacement's lifetime come from the controller.
    pub async fn renew_job_proxy_token(
        &self,
        registration: &Registration,
        job_id: Uuid,
        lease_attempt: i32,
    ) -> std::result::Result<ProxyEnvelopePayload, JobProxyTokenError> {
        let operation = async {
            let http = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|_| JobProxyTokenError::RequestFailed)?;
            let url = self
                .base_url
                .join(&format!("/agent/jobs/{job_id}/proxy-token"))
                .map_err(|_| JobProxyTokenError::RequestFailed)?;
            let send = || {
                http.post(url.clone())
                    .bearer_auth(self.bearer_for_agent(registration))
                    .json(&json!({ "lease_attempt": lease_attempt }))
                    .send()
            };
            let mut response = send()
                .await
                .map_err(|_| JobProxyTokenError::RequestFailed)?;
            if matches!(
                response.status(),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
            ) && self.refresh_credentials_once().await
            {
                response = send()
                    .await
                    .map_err(|_| JobProxyTokenError::RequestFailed)?;
            }
            if response.status() != StatusCode::OK {
                return Err(JobProxyTokenError::Rejected(response.status().as_u16()));
            }
            if response
                .content_length()
                .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
            {
                return Err(JobProxyTokenError::InvalidResponse);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| JobProxyTokenError::InvalidResponse)?
            {
                if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
                    return Err(JobProxyTokenError::InvalidResponse);
                }
                body.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&body).map_err(|_| JobProxyTokenError::InvalidResponse)
        };
        tokio::time::timeout(RENEWAL_TIMEOUT, operation)
            .await
            .map_err(|_| JobProxyTokenError::TimedOut)?
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn proxy_test_client(base_url: Url) -> (ControllerClient, Registration) {
        let client = ControllerClient {
            http: reqwest::Client::new(),
            base_url: base_url.clone(),
            runtime_access_token: std::sync::Arc::new(ControllerTokenStore::new(None)),
            current_agent_token: Mutex::new(None),
            poll_interval: Duration::from_secs(1),
            lease_wait: Duration::ZERO,
            lease_max_jobs: 1,
            lease_seconds: 60,
            heartbeat_seconds: 30,
            agent_tokens: AgentTokenVerifier::new(base_url.join("/jwks").unwrap()),
            resources: Mutex::new(ResourceSampler::new(std::env::temp_dir())),
            browser_profile_session: tokio::sync::Mutex::new(Default::default()),
        };
        let registration = Registration {
            runtime_id: Uuid::new_v4(),
            agent_token: "test-spawn-time-agent".into(),
            runtime_token: None,
            lease_url: base_url.join("/agent/lease").unwrap(),
            heartbeat_url: base_url.join("/agent/heartbeat").unwrap(),
            stop_url: None,
            lease_id: None,
            proxy: None,
            lease_scope: None,
            tenant_projects: Vec::new(),
            workspace_manifest: None,
            parent_lease_id: None,
            agent_token_scopes: vec!["agent.lease".into()],
            agent_token_issued_at: None,
            agent_token_expires_at: None,
            agent_token_ttl: None,
        };
        (client, registration)
    }

    #[tokio::test]
    async fn job_proxy_token_uses_live_bearer_and_only_retries_agent_auth_once() {
        use axum::{extract::State, http::HeaderMap, routing::post};
        use std::sync::Arc;
        let received = Arc::new(Mutex::new(Vec::<String>::new()));
        let app = axum::Router::new().route("/agent/jobs/:id/proxy-token", post(
            |State(received): State<Arc<Mutex<Vec<String>>>>, headers: HeaderMap| async move {
                received.lock().push(headers["authorization"].to_str().unwrap().to_owned());
                (axum::http::StatusCode::UNAUTHORIZED, "must-not-appear-in-error")
            })).with_state(received.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (client, registration) = proxy_test_client(base);
        let client = Arc::new(client);
        *client.current_agent_token.lock() = Some("test-current-agent".into());
        let renewer = {
            let client = client.clone();
            tokio::spawn(async move {
                client.runtime_access_token.refresh_requested().await;
                *client.current_agent_token.lock() = Some("test-renewed-agent".into());
                client.runtime_access_token.note_refreshed();
            })
        };
        let error = client
            .renew_job_proxy_token(&registration, Uuid::new_v4(), 1)
            .await
            .unwrap_err();
        renewer.await.unwrap();
        assert!(matches!(error, JobProxyTokenError::Rejected(401)));
        assert_eq!(
            *received.lock(),
            ["Bearer test-current-agent", "Bearer test-renewed-agent"]
        );
        assert!(!format!("{error:?} {error}").contains("must-not-appear"));
        server.abort();
    }

    #[tokio::test]
    async fn job_proxy_token_never_follows_redirects_or_logs_response_bodies() {
        let app = axum::Router::new().route(
            "/agent/jobs/:id/proxy-token",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::TEMPORARY_REDIRECT,
                    [("location", "/must-not-follow")],
                    "credential-body-must-not-be-logged",
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (client, registration) = proxy_test_client(base);
        let error = client
            .renew_job_proxy_token(&registration, Uuid::new_v4(), 1)
            .await
            .unwrap_err();
        assert!(matches!(error, JobProxyTokenError::Rejected(307)));
        assert!(!format!("{error:?} {error}").contains("credential-body"));
        server.abort();
    }
}
