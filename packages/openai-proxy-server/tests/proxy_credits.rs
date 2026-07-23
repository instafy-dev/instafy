use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use jsonwebtoken::{EncodingKey, Header};
use prost::Message;
use runtime_contracts::{CreditEventRequest, CreditEventResponse};
use serde_json::json;
use serial_test::serial;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use openai_proxy_server::auth::Credentials;
use openai_proxy_server::client::DEFAULT_MODEL;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use openai_proxy_server::proxy_auth::ProxyClaims;

#[tokio::test]
#[serial]
async fn proxy_emits_credit_burn_on_success() -> Result<()> {
    let mut controller = spawn_controller().await?;
    let openai = spawn_openai(OpenAiMode::Success).await?;

    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
        ("PROXY_CREDIT_BURN_AMOUNT", "5".to_string()),
        ("CODEX_OPENAI_ENDPOINT", openai.endpoint()),
    ]);

    let credentials = Credentials::ApiKey {
        key: "test-api-key".to_string(),
        endpoint: None,
        default_model: None,
    };

    let proxy = spawn_proxy(credentials).await?;

    let response = send_proxy_request(proxy.addr, "test-signing").await?;
    assert!(response.status().is_success());

    let burn = controller
        .expect_event(Duration::from_secs(2))
        .await
        .context("missing burn event")?;

    assert_eq!(burn.action, "burn");
    assert_eq!(burn.project_id, "project-123");
    assert_eq!(burn.runtime_id, "runtime-456");
    assert_eq!(burn.run_id, "run-789");
    assert_eq!(burn.provider, DEFAULT_MODEL);
    assert_eq!(burn.amount, 5);

    assert!(controller.try_event().is_none(), "unexpected extra events");

    proxy.shutdown().await;
    controller.shutdown().await;
    openai.shutdown().await;
    drop(env_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_refunds_credits_on_failure() -> Result<()> {
    let mut controller = spawn_controller().await?;
    let openai = spawn_openai(OpenAiMode::Failure).await?;

    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
        ("PROXY_CREDIT_BURN_AMOUNT", "4".to_string()),
        ("CODEX_OPENAI_ENDPOINT", openai.endpoint()),
    ]);

    let credentials = Credentials::ApiKey {
        key: "test-api-key".to_string(),
        endpoint: None,
        default_model: None,
    };

    let proxy = spawn_proxy(credentials).await?;

    let response = send_proxy_request(proxy.addr, "test-signing").await?;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let burn = controller
        .expect_event(Duration::from_secs(2))
        .await
        .context("missing burn event")?;
    assert_eq!(burn.action, "burn");
    assert_eq!(burn.amount, 4);

    let refund = controller
        .expect_event(Duration::from_secs(2))
        .await
        .context("missing refund event")?;
    assert_eq!(refund.action, "refill");
    assert_eq!(refund.amount, 4);
    assert!(
        refund.reason.contains("proxy upstream failure") || refund.reason.contains("proxy refund"),
        "unexpected refund reason: {}",
        refund.reason
    );

    assert!(controller.try_event().is_none(), "unexpected extra events");

    proxy.shutdown().await;
    controller.shutdown().await;
    openai.shutdown().await;
    drop(env_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_rejects_missing_auth_before_parsing_request_body() -> Result<()> {
    let mut controller = spawn_controller().await?;
    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
    ]);
    let proxy = spawn_proxy(Credentials::ApiKey {
        key: "test-api-key".to_string(),
        endpoint: None,
        default_model: None,
    })
    .await?;

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", proxy.addr))
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        controller.try_event().is_none(),
        "unauthorized input must not emit credit events"
    );

    proxy.shutdown().await;
    controller.shutdown().await;
    drop(env_guard);
    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_liveness_is_acyclic_while_readiness_rejects_an_old_controller() -> Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let controller_addr = listener.local_addr()?;
    let controller_health_calls = Arc::new(AtomicUsize::new(0));
    let handler_calls = Arc::clone(&controller_health_calls);
    let old_controller = tokio::spawn(async move {
        let app = Router::new().route(
            "/healthz",
            get(move || {
                let handler_calls = Arc::clone(&handler_calls);
                async move {
                    handler_calls.fetch_add(1, Ordering::SeqCst);
                    StatusCode::OK
                }
            }),
        );
        let _ = axum::serve(listener, app).await;
    });
    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller_addr)),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
    ]);
    let proxy = spawn_proxy(Credentials::ApiKey {
        key: "test-api-key".to_string(),
        endpoint: None,
        default_model: None,
    })
    .await?;
    let client = reqwest::Client::new();

    let health = client
        .get(format!("http://{}/healthz", proxy.addr))
        .send()
        .await?;
    assert_eq!(health.status(), StatusCode::OK);
    let health_body: serde_json::Value = health.json().await?;
    assert_eq!(health_body["status"], "ok");
    assert!(health_body["controllerCredentialLeaseCompatible"].is_null());
    assert_eq!(
        controller_health_calls.load(Ordering::SeqCst),
        0,
        "proxy liveness must not call a dependency",
    );

    let ready = client
        .get(format!("http://{}/readyz", proxy.addr))
        .send()
        .await?;
    assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);
    let ready_body: serde_json::Value = ready.json().await?;
    assert_eq!(ready_body["status"], "error");
    assert_eq!(
        ready_body["controllerCredentialLeaseCompatible"],
        serde_json::Value::Bool(false)
    );
    assert_eq!(
        controller_health_calls.load(Ordering::SeqCst),
        1,
        "proxy readiness must probe the controller exactly once",
    );

    proxy.shutdown().await;
    old_controller.abort();
    drop(env_guard);
    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_public_lane_rejects_non_byoc_or_non_run_scoped_tokens_before_body() -> Result<()> {
    let mut controller = spawn_controller().await?;
    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "1".to_string()),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "1".to_string()),
    ]);
    let proxy = spawn_proxy(Credentials::ApiKey {
        key: "platform-key-must-not-be-reachable".to_string(),
        endpoint: None,
        default_model: None,
    })
    .await?;
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/responses", proxy.addr);
    let project_id = uuid::Uuid::new_v4().to_string();
    let runtime_id = uuid::Uuid::new_v4().to_string();

    let registration_token =
        issue_proxy_token_with_claims("test-signing", &project_id, &runtime_id, None, None);
    let registration_response = client
        .post(&url)
        .bearer_auth(registration_token)
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await?;
    assert_eq!(registration_response.status(), StatusCode::UNAUTHORIZED);

    let credential_only_token = issue_proxy_token_with_claims(
        "test-signing",
        &project_id,
        &runtime_id,
        None,
        Some(&uuid::Uuid::new_v4().to_string()),
    );
    let public_response = client
        .post(&url)
        .bearer_auth(credential_only_token)
        .header("x-instafy-proxy-lane", "public-personal-browser")
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await?;
    assert_eq!(public_response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        controller.try_event().is_none(),
        "rejected public tokens must not emit credit events"
    );

    proxy.shutdown().await;
    controller.shutdown().await;
    drop(env_guard);
    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_public_lane_uses_run_scoped_byoc_credential() -> Result<()> {
    let byoc_key = "personal-browser-byoc-key";
    let openai = spawn_openai(OpenAiMode::SuccessWithBearer(format!("Bearer {byoc_key}"))).await?;
    let mut controller = spawn_controller_with_credential(Some(openai.endpoint())).await?;
    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "1".to_string()),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "1".to_string()),
    ]);
    let proxy = spawn_proxy(Credentials::ApiKey {
        key: "platform-key-must-not-be-used".to_string(),
        endpoint: None,
        default_model: None,
    })
    .await?;
    let project_id = uuid::Uuid::new_v4().to_string();
    let runtime_id = uuid::Uuid::new_v4().to_string();
    let run_id = uuid::Uuid::new_v4().to_string();
    let credential_id = uuid::Uuid::new_v4().to_string();
    let token = issue_proxy_token_with_claims(
        "test-signing",
        &project_id,
        &runtime_id,
        Some(&run_id),
        Some(&credential_id),
    );

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", proxy.addr))
        .bearer_auth(token)
        .header("x-instafy-proxy-lane", "public-personal-browser")
        .json(&json!({
            "model": DEFAULT_MODEL,
            "stream": false,
            "messages": [{
                "role": "user",
                "content": "Prove the Personal Browser BYOC lane."
            }]
        }))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert!(
        controller.try_event().is_none(),
        "BYOC public requests must not emit managed-credit events"
    );

    proxy.shutdown().await;
    controller.shutdown().await;
    openai.shutdown().await;
    drop(env_guard);
    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_required_controller_auth_fails_closed_without_integration() -> Result<()> {
    let env_guard = EnvGuard::set(&[
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "1".to_string()),
        ("PROXY_CONTROLLER_BASE_URL", "".to_string()),
        ("CONTROLLER_BASE_URL", "".to_string()),
        ("CONTROLLER_INTERNAL_TOKEN", "".to_string()),
        ("PROXY_CREDENTIAL_LEASE_TOKEN", "".to_string()),
        ("PROXY_SIGNING_SECRET", "".to_string()),
    ]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    drop(listener);

    let error = run_proxy_with_shutdown(
        addr,
        Some(Credentials::ApiKey {
            key: "must-not-become-public".to_string(),
            endpoint: None,
            default_model: None,
        }),
        std::future::pending::<()>(),
    )
    .await
    .expect_err("required controller authentication must fail closed");
    assert!(error.to_string().contains("PROXY_REQUIRE_CONTROLLER_AUTH"));

    drop(env_guard);
    Ok(())
}

#[tokio::test]
#[serial]
async fn controller_integrated_proxy_fails_startup_without_credential_lease_token() -> Result<()> {
    let env_guard = EnvGuard::set(&[
        (
            "CONTROLLER_BASE_URL",
            "http://127.0.0.1:1".to_string(),
        ),
        ("PROXY_CONTROLLER_BASE_URL", "".to_string()),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        ("PROXY_CREDENTIAL_LEASE_TOKEN", "".to_string()),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
    ]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    drop(listener);

    let error = run_proxy_with_shutdown(
        addr,
        Some(Credentials::ApiKey {
            key: "standalone-key-must-not-mask-partial-controller-config".to_string(),
            endpoint: None,
            default_model: None,
        }),
        std::future::pending::<()>(),
    )
    .await
    .expect_err("partial controller integration must fail before binding");
    assert!(
        error
            .to_string()
            .contains("PROXY_CREDENTIAL_LEASE_TOKEN")
    );

    drop(env_guard);
    Ok(())
}

async fn send_proxy_request(addr: SocketAddr, signing_secret: &str) -> Result<reqwest::Response> {
    let url = format!("http://{addr}/v1/chat/completions");
    let token = issue_proxy_token(signing_secret);

    let client = reqwest::Client::new();
    let payload = json!({
        "model": DEFAULT_MODEL,
        "stream": false,
        "messages": [
            {
                "role": "user",
                "content": "Say hello to the controller test."
            }
        ]
    });

    let response = client
        .post(&url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .context("failed to send proxy request")?;

    Ok(response)
}

fn issue_proxy_token(secret: &str) -> String {
    issue_proxy_token_with_claims(secret, "project-123", "runtime-456", Some("run-789"), None)
}

fn issue_proxy_token_with_claims(
    secret: &str,
    project_id: &str,
    runtime_id: &str,
    run_id: Option<&str>,
    credential_id: Option<&str>,
) -> String {
    let claims = ProxyClaims {
        _aud: Some("proxy".to_string()),
        _iss: None,
        project_id: project_id.to_string(),
        runtime_id: Some(runtime_id.to_string()),
        run_id: run_id.map(str::to_string),
        credential_id: credential_id.map(str::to_string),
        agent_handle: None,
        agent_display_name: None,
        agent_description: None,
        exp: Some(
            (std::time::SystemTime::now() + std::time::Duration::from_secs(300))
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        ),
    };

    jsonwebtoken::encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("failed to sign token")
}

struct ProxyHandle {
    addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl ProxyHandle {
    async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

async fn spawn_proxy(credentials: Credentials) -> Result<ProxyHandle> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let shutdown = async move {
        let _ = shutdown_rx.await;
    };

    let handle = tokio::spawn(async move {
        if let Err(error) = run_proxy_with_shutdown(addr, Some(credentials), shutdown).await {
            eprintln!("proxy server exited with error: {error}");
        }
    });

    tokio::time::sleep(Duration::from_millis(200)).await;

    Ok(ProxyHandle {
        addr,
        shutdown_tx: Some(shutdown_tx),
        task: Some(handle),
    })
}

struct EnvGuard(Vec<(String, Option<String>)>);

impl EnvGuard {
    fn set(vars: &[(&str, String)]) -> Self {
        let mut previous = Vec::with_capacity(vars.len());
        for (key, value) in vars {
            let key_str = key.to_string();
            let prior = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            previous.push((key_str, prior));
        }
        Self(previous)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, prior) in self.0.drain(..) {
            match prior {
                Some(value) => unsafe {
                    std::env::set_var(key, value);
                },
                None => unsafe {
                    std::env::remove_var(key);
                },
            }
        }
    }
}

struct ControllerHandle {
    addr: SocketAddr,
    receiver: mpsc::Receiver<CreditEventRequest>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl ControllerHandle {
    fn addr(&self) -> SocketAddr {
        self.addr
    }

    async fn expect_event(&mut self, timeout: Duration) -> Option<CreditEventRequest> {
        match tokio::time::timeout(timeout, self.receiver.recv()).await {
            Ok(event) => event,
            Err(_) => None,
        }
    }

    fn try_event(&mut self) -> Option<CreditEventRequest> {
        self.receiver.try_recv().ok()
    }

    async fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

async fn spawn_controller() -> Result<ControllerHandle> {
    spawn_controller_with_credential(None).await
}

async fn spawn_controller_with_credential(
    credential_endpoint: Option<String>,
) -> Result<ControllerHandle> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind controller stub")?;
    let addr = listener.local_addr()?;

    let (tx, rx) = mpsc::channel::<CreditEventRequest>(8);
    let state = ControllerState {
        credential_endpoint,
        events: tx.clone(),
        service_token: "controller-secret".to_string(),
        credential_lease_token: "credential-lease-secret".to_string(),
    };

    let router = Router::new()
        .route("/healthz", get(controller_health_handler))
        .route("/credits", post(controller_handler))
        .route(
            "/internal/credentials/:credential_id",
            get(controller_credential_handler),
        )
        .with_state(state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };

        if let Err(error) = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(shutdown)
            .await
        {
            eprintln!("controller stub exited with error: {error}");
        }
    });

    Ok(ControllerHandle {
        addr,
        receiver: rx,
        shutdown_tx: Some(shutdown_tx),
        task: Some(task),
    })
}

#[derive(Clone)]
struct ControllerState {
    credential_endpoint: Option<String>,
    events: mpsc::Sender<CreditEventRequest>,
    service_token: String,
    credential_lease_token: String,
}

async fn controller_health_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        [("x-instafy-credential-lease-protocol", "1")],
    )
}

async fn controller_credential_handler(
    State(state): State<ControllerState>,
    Path(credential_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if auth_header != format!("Bearer {}", state.credential_lease_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if uuid::Uuid::parse_str(&credential_id).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(endpoint) = state.credential_endpoint else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Json(json!({
        "kind": "openai_api_key",
        "openaiApiKey": "personal-browser-byoc-key",
        "provider": "openai",
        "upstreamEndpoint": endpoint,
        "defaultModel": DEFAULT_MODEL,
        "leaseExpiresInSeconds": 60,
        "renewalAuthority": "controller"
    }))
    .into_response()
}

async fn controller_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if auth_header != format!("Bearer {}", state.service_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let request = match CreditEventRequest::decode(body) {
        Ok(req) => req,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    let _ = state.events.send(request).await;

    let response = CreditEventResponse::default();
    let mut buf = Vec::new();
    if let Err(err) = response.encode(&mut buf) {
        return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
    }

    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/x-protobuf")
        .body(Body::from(buf))
        .unwrap()
        .into_response()
}

struct OpenAiHandle {
    addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl OpenAiHandle {
    fn endpoint(&self) -> String {
        format!("http://{}/v1/responses", self.addr)
    }

    async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

enum OpenAiMode {
    Success,
    SuccessWithBearer(String),
    Failure,
}

async fn spawn_openai(mode: OpenAiMode) -> Result<OpenAiHandle> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind openai stub")?;
    let addr = listener.local_addr()?;

    let shared_mode = Arc::new(mode);

    let router = Router::new()
        .route("/v1/responses", post(openai_handler))
        .with_state(shared_mode.clone());

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };

        if let Err(error) = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(shutdown)
            .await
        {
            eprintln!("openai stub exited with error: {error}");
        }
    });

    Ok(OpenAiHandle {
        addr,
        shutdown_tx: Some(shutdown_tx),
        task: Some(task),
    })
}

async fn openai_handler(
    State(mode): State<Arc<OpenAiMode>>,
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if authorization.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let OpenAiMode::SuccessWithBearer(expected) = mode.as_ref() {
        if authorization != Some(expected.as_str()) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    }

    match mode.as_ref() {
        OpenAiMode::Success | OpenAiMode::SuccessWithBearer(_) => {
            let body = json!({
                "id": "resp-success",
                "model": payload
                    .get("model")
                    .and_then(|value| value.as_str())
                    .unwrap_or(DEFAULT_MODEL),
                "output": [
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "Hello from the stub!"
                            }
                        ]
                    }
                ],
                "usage": {
                    "input_text_tokens": 12,
                    "output_text_tokens": 7,
                    "total_tokens": 19
                }
            });
            Json(body).into_response()
        }
        OpenAiMode::Failure => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": {
                    "message": "backend outage",
                    "type": "bad_gateway"
                }
            })),
        )
            .into_response(),
    }
}

fn format_http_base(addr: &SocketAddr) -> String {
    format!("http://{}", addr)
}
