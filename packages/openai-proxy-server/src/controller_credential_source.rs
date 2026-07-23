//! Concrete source for the public controller credential-lease protocol.
//!
//! The controller is the proxy's only credential authority today. Keep the
//! conversion from its wire response to request-ready credentials isolated
//! here; introduce a trait only if a second real source needs this contract.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use tokio::sync::Mutex;

use crate::auth::Credentials;
use crate::controller_client::{ControllerClient, CredentialResponse};
use crate::credential_lease::{CredentialLease, CredentialLeasePurpose};

#[derive(Clone)]
pub(crate) struct ControllerCredentialSource {
    client: ControllerClient,
    cache: Arc<Mutex<HashMap<String, CachedCredential>>>,
    lease_locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    maximum_cache_ttl: Duration,
}

#[derive(Clone)]
struct CachedCredential {
    credentials: Credentials,
    expires_at: Instant,
}

impl ControllerCredentialSource {
    pub(crate) fn new(client: ControllerClient, maximum_cache_ttl: Duration) -> Self {
        Self {
            client,
            cache: Arc::new(Mutex::new(HashMap::new())),
            lease_locks: Arc::new(Mutex::new(HashMap::new())),
            maximum_cache_ttl,
        }
    }

    async fn lock_for(&self, credential_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.lease_locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(credential_id).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(credential_id.to_string(), Arc::downgrade(&lock));
        lock
    }
    pub(crate) async fn acquire_lease(
        &self,
        credential_id: &str,
        purpose: CredentialLeasePurpose,
    ) -> Result<CredentialLease<Credentials>> {
        let id = credential_id.trim();
        if id.is_empty() {
            return Err(anyhow!("credential_id is empty"));
        }
        let lease_lock = self.lock_for(id).await;
        let _lease_guard = lease_lock.lock().await;

        {
            let now = Instant::now();
            let mut cache = self.cache.lock().await;
            cache.retain(|_, entry| now < entry.expires_at);
            if purpose == CredentialLeasePurpose::AfterUpstreamRejection {
                // Never hand rejected material out again if renewal fails.
                cache.remove(id);
            } else if let Some(entry) = cache.get(id) {
                return Ok(CredentialLease::new(
                    entry.credentials.clone(),
                    entry.expires_at,
                ));
            }
        }

        let response = match purpose {
            CredentialLeasePurpose::InitialRequest => self.client.fetch_credential(id).await,
            CredentialLeasePurpose::AfterUpstreamRejection => {
                self.client.renew_credential_after_rejection(id).await
            }
        }
        .map_err(|error| anyhow!("controller credential lease failed: {error:#}"))?;
        let lease_ttl = validate_controller_lease(&response, self.maximum_cache_ttl)?;

        let credentials = map_controller_credential(response)?;
        let expires_at = Instant::now()
            .checked_add(lease_ttl)
            .ok_or_else(|| anyhow!("controller returned an invalid credential lease duration"))?;
        let mut cache = self.cache.lock().await;
        cache.insert(
            id.to_string(),
            CachedCredential {
                credentials: credentials.clone(),
                expires_at,
            },
        );

        Ok(CredentialLease::new(credentials, expires_at))
    }
}

fn validate_controller_lease(
    response: &CredentialResponse,
    maximum_cache_ttl: Duration,
) -> Result<Duration> {
    let seconds = response
        .lease_expires_in_seconds
        .ok_or_else(|| anyhow!("controller credential response is missing its lease duration"))?;
    let lease_ttl = Duration::from_secs(seconds).min(maximum_cache_ttl);
    if lease_ttl.is_zero() {
        return Err(anyhow!(
            "controller returned an already-expired credential lease"
        ));
    }
    if response.renewal_authority.as_deref().map(str::trim) != Some("controller") {
        return Err(anyhow!(
            "controller credential response does not declare controller renewal authority"
        ));
    }
    Ok(lease_ttl)
}

fn map_controller_credential(response: CredentialResponse) -> Result<Credentials> {
    let kind = response.kind.trim().to_ascii_lowercase();
    let provider = response
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "openai".to_string());
    let default_model = normalize_optional(response.default_model.as_deref());

    if kind == "openai_api_key" || kind == "api_key" {
        let key = response
            .openai_api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("controller credential missing API key material"))?;
        let endpoint = normalize_optional(response.upstream_endpoint.as_deref());
        let auth_mode = response
            .auth_mode
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let code_assist_project = normalize_optional(response.code_assist_project.as_deref());

        if provider == "gemini" && is_project_bearer_auth_mode(&auth_mode) {
            let project_id = code_assist_project
                .ok_or_else(|| anyhow!("project bearer credential missing project identifier"))?;
            return Ok(Credentials::GeminiCodeAssist {
                access_token: key.to_string(),
                project_id,
                endpoint,
                default_model,
            });
        }

        return Ok(Credentials::ApiKey {
            key: key.to_string(),
            endpoint,
            default_model,
        });
    }

    if kind == "codex_auth_json" || kind == "chatgpt" {
        let access_token = response
            .access_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("controller credential missing access token material"))?;
        return Ok(Credentials::ChatGpt {
            access_token: access_token.to_string(),
            // Refresh material remains in the controller. A rejected lease
            // must be renewed through `ControllerCredentialSource`.
            refresh_token: None,
            account_id: normalize_optional(response.account_id.as_deref()),
            default_model,
            auth_path: None,
        });
    }

    Err(anyhow!(
        "unsupported controller credential kind `{}`",
        response.kind
    ))
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_project_bearer_auth_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "code_assist" | "code_assist_cli"
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use anyhow::Result;
    use axum::extract::{OriginalUri, State};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;

    use super::*;

    #[derive(Clone, Default)]
    struct Requests(Arc<StdMutex<Vec<String>>>);

    #[derive(Clone, Default)]
    struct RaceRequests {
        requests: Requests,
        initial_started: Arc<Notify>,
        release_initial: Arc<Notify>,
    }

    async fn credential_handler(
        State(requests): State<Requests>,
        OriginalUri(uri): OriginalUri,
    ) -> Json<Value> {
        requests
            .0
            .lock()
            .expect("request lock")
            .push(uri.to_string());
        Json(json!({
            "kind": "codex_auth_json",
            "accessToken": "test-access-token",
            "accountId": "acct_test",
            "provider": "openai",
            "defaultModel": "gpt-test",
            "leaseExpiresInSeconds": 30,
            "renewalAuthority": "controller"
        }))
    }

    async fn failing_renewal_handler(
        State(requests): State<Requests>,
        OriginalUri(uri): OriginalUri,
    ) -> Response {
        let path = uri.to_string();
        requests.0.lock().expect("request lock").push(path.clone());
        if path.contains("forceRefresh=true") {
            return (
                StatusCode::FAILED_DEPENDENCY,
                Json(json!({ "message": "renewal failed" })),
            )
                .into_response();
        }
        Json(json!({
            "kind": "codex_auth_json",
            "accessToken": "test-access-token",
            "provider": "openai",
            "leaseExpiresInSeconds": 30,
            "renewalAuthority": "controller"
        }))
        .into_response()
    }

    async fn serialized_credential_handler(
        State(state): State<RaceRequests>,
        OriginalUri(uri): OriginalUri,
    ) -> Json<Value> {
        let path = uri.to_string();
        state
            .requests
            .0
            .lock()
            .expect("request lock")
            .push(path.clone());
        if !path.contains("forceRefresh=true") {
            state.initial_started.notify_one();
            state.release_initial.notified().await;
        }
        Json(json!({
            "kind": "codex_auth_json",
            "accessToken": "test-access-token",
            "provider": "openai",
            "leaseExpiresInSeconds": 30,
            "renewalAuthority": "controller"
        }))
    }

    #[tokio::test]
    async fn initial_requests_use_cache_but_rejection_renews_at_controller() -> Result<()> {
        let requests = Requests::default();
        let app = Router::new()
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

        let source = ControllerCredentialSource::new(
            ControllerClient::new(
                format!("http://{addr}"),
                "service-token",
                "credential-lease-token",
            ),
            Duration::from_secs(60),
        );
        let first = source
            .acquire_lease("cred-123", CredentialLeasePurpose::InitialRequest)
            .await?;
        let _ = first.into_material()?;

        let cached = source
            .acquire_lease("cred-123", CredentialLeasePurpose::InitialRequest)
            .await?;
        let _ = cached.into_material()?;
        let renewed = source
            .acquire_lease("cred-123", CredentialLeasePurpose::AfterUpstreamRejection)
            .await?;
        match renewed.into_material()? {
            Credentials::ChatGpt {
                refresh_token,
                auth_path,
                ..
            } => {
                assert!(refresh_token.is_none());
                assert!(auth_path.is_none());
            }
            _ => panic!("expected delegated bearer credentials"),
        }

        let paths = requests.0.lock().expect("request lock").clone();
        assert_eq!(
            paths,
            vec![
                "/internal/credentials/cred-123",
                "/internal/credentials/cred-123?forceRefresh=true",
            ]
        );

        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn failed_renewal_invalidates_rejected_cached_material() -> Result<()> {
        let requests = Requests::default();
        let app = Router::new()
            .route(
                "/internal/credentials/:credential_id",
                get(failing_renewal_handler),
            )
            .with_state(requests.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let source = ControllerCredentialSource::new(
            ControllerClient::new(
                format!("http://{addr}"),
                "service-token",
                "credential-lease-token",
            ),
            Duration::from_secs(60),
        );
        let _ = source
            .acquire_lease("cred-123", CredentialLeasePurpose::InitialRequest)
            .await?;
        assert!(
            source
                .acquire_lease("cred-123", CredentialLeasePurpose::AfterUpstreamRejection)
                .await
                .is_err()
        );
        let _ = source
            .acquire_lease("cred-123", CredentialLeasePurpose::InitialRequest)
            .await?;

        let paths = requests.0.lock().expect("request lock").clone();
        assert_eq!(
            paths,
            vec![
                "/internal/credentials/cred-123",
                "/internal/credentials/cred-123?forceRefresh=true",
                "/internal/credentials/cred-123",
            ]
        );

        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn requests_for_one_credential_are_singleflight_across_renewal() -> Result<()> {
        let state = RaceRequests::default();
        let app = Router::new()
            .route(
                "/internal/credentials/:credential_id",
                get(serialized_credential_handler),
            )
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let source = ControllerCredentialSource::new(
            ControllerClient::new(
                format!("http://{addr}"),
                "service-token",
                "credential-lease-token",
            ),
            Duration::from_secs(60),
        );

        let initial_source = source.clone();
        let initial = tokio::spawn(async move {
            initial_source
                .acquire_lease("cred-race", CredentialLeasePurpose::InitialRequest)
                .await
        });
        state.initial_started.notified().await;

        let renewal_source = source.clone();
        let renewal = tokio::spawn(async move {
            renewal_source
                .acquire_lease("cred-race", CredentialLeasePurpose::AfterUpstreamRejection)
                .await
        });
        tokio::task::yield_now().await;
        assert_eq!(
            state.requests.0.lock().expect("request lock").as_slice(),
            ["/internal/credentials/cred-race"],
        );

        state.release_initial.notify_one();
        initial.await??;
        renewal.await??;
        assert_eq!(
            state.requests.0.lock().expect("request lock").as_slice(),
            [
                "/internal/credentials/cred-race",
                "/internal/credentials/cred-race?forceRefresh=true",
            ],
        );

        server.abort();
        Ok(())
    }

    fn api_key_response(provider: Option<&str>, auth_mode: Option<&str>) -> CredentialResponse {
        CredentialResponse {
            kind: "api_key".to_string(),
            access_token: None,
            account_id: None,
            openai_api_key: Some("token-123".to_string()),
            provider: provider.map(str::to_string),
            upstream_endpoint: Some("https://cloudcode-pa.googleapis.com".to_string()),
            default_model: Some("gemini-test".to_string()),
            auth_mode: auth_mode.map(str::to_string),
            code_assist_project: Some("proj-1".to_string()),
            lease_expires_in_seconds: Some(60),
            renewal_authority: Some("controller".to_string()),
        }
    }

    #[test]
    fn api_keys_keep_the_existing_routing_behavior() {
        let credentials = map_controller_credential(api_key_response(Some("gemini"), Some("api")))
            .expect("mapping should succeed");
        assert!(matches!(credentials, Credentials::ApiKey { .. }));

        let credentials =
            map_controller_credential(api_key_response(Some("gemini"), Some("code_assist_cli")))
                .expect("mapping should succeed");
        assert!(matches!(credentials, Credentials::GeminiCodeAssist { .. }));
    }

    #[test]
    fn controller_lease_metadata_is_mandatory_and_fail_closed() {
        let mut response = api_key_response(Some("openai"), Some("api"));
        response.lease_expires_in_seconds = None;
        assert!(
            validate_controller_lease(&response, Duration::from_secs(60))
                .expect_err("missing lease duration must fail")
                .to_string()
                .contains("missing its lease duration")
        );

        response.lease_expires_in_seconds = Some(60);
        response.renewal_authority = None;
        assert!(
            validate_controller_lease(&response, Duration::from_secs(60))
                .expect_err("missing renewal authority must fail")
                .to_string()
                .contains("does not declare controller renewal authority")
        );
    }
}
