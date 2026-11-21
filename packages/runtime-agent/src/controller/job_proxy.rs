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

    /// Tells the controller what this lease attempt of a job changes about its message's
    /// Instafy AI web searches, which the controller counts and the proxy asks it for: the
    /// routing step read the person's own words as asking for deeper research, so they go up to
    /// the larger limit; or the attempt starts over, holding none of an earlier attempt's
    /// searches, which go back to the message. Fenced to the job's lease attempt and
    /// authenticated with the machine bearer, as a renewal is.
    pub async fn report_web_searches(
        &self,
        registration: &Registration,
        job_id: Uuid,
        lease_attempt: i32,
        deeper_research: bool,
        starts_over: bool,
    ) -> Result<()> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        let url = self
            .base_url
            .join(&format!("/agent/jobs/{job_id}/web-searches"))?;
        let body = json!({
            "lease_attempt": lease_attempt,
            "deeper_research": deeper_research,
            "starts_over": starts_over,
        });
        let send = || {
            http.post(url.clone())
                .bearer_auth(self.bearer_for_agent(registration))
                .json(&body)
                .send()
        };
        let mut response = send().await?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) && self.refresh_credentials_once().await
        {
            response = send().await?;
        }
        if !response.status().is_success() {
            anyhow::bail!(
                "the controller refused the web search report (status={})",
                response.status().as_u16()
            );
        }
        Ok(())
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
            machine_lifetime_ended: std::sync::atomic::AtomicBool::new(false),
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

    /// The runtime tells the controller about a job's web searches (deeper research, or an
    /// attempt that starts over) at the job's own path, fenced to its lease attempt, with the
    /// machine bearer; a refusal is an error, so nothing changes.
    #[tokio::test]
    async fn web_searches_are_reported_for_the_jobs_lease_attempt() {
        use axum::{
            extract::{Path, State},
            http::HeaderMap,
            routing::post,
        };
        use std::sync::Arc;
        type Seen = Arc<Mutex<Vec<(String, String, JsonValue)>>>;
        let seen: Seen = Arc::default();
        let app = axum::Router::new()
            .route(
                "/agent/jobs/:id/web-searches",
                post(
                    |State(seen): State<Seen>,
                     Path(id): Path<String>,
                     headers: HeaderMap,
                     axum::Json(body): axum::Json<JsonValue>| async move {
                        let refused = body["lease_attempt"] == json!(3);
                        seen.lock().push((
                            id,
                            headers["authorization"].to_str().unwrap().to_owned(),
                            body,
                        ));
                        if refused {
                            axum::http::StatusCode::CONFLICT
                        } else {
                            axum::http::StatusCode::NO_CONTENT
                        }
                    },
                ),
            )
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (client, registration) = proxy_test_client(base);
        *client.current_agent_token.lock() = Some("test-current-agent".into());
        let job_id = Uuid::new_v4();
        client
            .report_web_searches(&registration, job_id, 2, true, false)
            .await
            .expect("reported");
        client
            .report_web_searches(&registration, job_id, 2, false, true)
            .await
            .expect("reported");
        assert_eq!(
            *seen.lock(),
            [
                (
                    job_id.to_string(),
                    "Bearer test-current-agent".to_string(),
                    json!({"lease_attempt": 2, "deeper_research": true, "starts_over": false})
                ),
                (
                    job_id.to_string(),
                    "Bearer test-current-agent".to_string(),
                    json!({"lease_attempt": 2, "deeper_research": false, "starts_over": true})
                )
            ]
        );
        // A lease that has moved on is refused.
        assert!(
            client
                .report_web_searches(&registration, job_id, 3, false, true)
                .await
                .is_err()
        );
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
