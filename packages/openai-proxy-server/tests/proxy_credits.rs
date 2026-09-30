use std::io::Read;
use std::net::SocketAddr;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jsonwebtoken::{EncodingKey, Header};
use serde_json::json;
use serial_test::serial;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use openai_proxy_server::auth::Credentials;
use openai_proxy_server::client::DEFAULT_MODEL;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use openai_proxy_server::proxy_auth::ProxyClaims;

/// The proxy once debited PROXY_CREDIT_BURN_AMOUNT through the controller's
/// `/credits` route before every request and refunded it on an upstream
/// failure. Nothing may reach that route now, even from a sidecar whose
/// environment still sets the amount, and the proxy says once that it ignores it.
#[tokio::test]
#[serial]
async fn no_credit_burn_request_is_sent_even_when_amount_configured() -> Result<()> {
    let mut controller = spawn_controller().await?;
    let openai = spawn_openai(OpenAiMode::FailPromptsContaining("fail upstream")).await?;
    let proxy = spawn_proxy_process(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
        ("PROXY_CREDIT_BURN_AMOUNT", "5".to_string()),
        ("OPENAI_API_KEY", "test-api-key".to_string()),
        ("CODEX_OPENAI_ENDPOINT", openai.endpoint()),
    ])
    .await?;
    let client = reqwest::Client::new();
    let token = issue_proxy_token("test-signing");

    // A managed run served on the sidecar's static key, the lane the burn
    // charged, on both routes.
    let chat = send_proxy_request(proxy.addr, "test-signing").await?;
    assert!(chat.status().is_success());
    let responses = client
        .post(format!("http://{}/v1/responses", proxy.addr))
        .bearer_auth(&token)
        .json(&json!({
            "model": DEFAULT_MODEL,
            "stream": false,
            "input": "Say hello to the controller test."
        }))
        .send()
        .await?;
    assert!(responses.status().is_success());

    // An upstream failure, which the burn followed with a refund.
    let failed = client
        .post(format!("http://{}/v1/chat/completions", proxy.addr))
        .bearer_auth(&token)
        .json(&json!({
            "model": DEFAULT_MODEL,
            "stream": false,
            "messages": [{"role": "user", "content": "Please fail upstream."}]
        }))
        .send()
        .await?;
    assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);

    let stderr = proxy.stop();
    let credit_requests = controller
        .requests()
        .into_iter()
        .filter(|request| request.ends_with(" /credits"))
        .collect::<Vec<_>>();
    assert!(
        credit_requests.is_empty(),
        "the proxy must not send credit events: {credit_requests:?}"
    );
    assert_eq!(
        stderr
            .matches("PROXY_CREDIT_BURN_AMOUNT is ignored")
            .count(),
        1,
        "expected one ignored-setting warning, got stderr: {stderr}"
    );

    controller.shutdown().await;
    openai.shutdown().await;
    Ok(())
}

/// A standalone proxy, with no controller to debit, still says once that it
/// ignores the amount, and serves requests without repeating the warning.
#[tokio::test]
#[serial]
async fn standalone_proxy_warns_once_that_credit_burn_amount_is_ignored() -> Result<()> {
    let openai = spawn_openai(OpenAiMode::SuccessWithBearer(
        "Bearer test-api-key".to_string(),
    ))
    .await?;
    let proxy = spawn_proxy_process(&[
        ("PROXY_CREDIT_BURN_AMOUNT", "5".to_string()),
        ("OPENAI_API_KEY", "test-api-key".to_string()),
        ("CODEX_OPENAI_ENDPOINT", openai.endpoint()),
    ])
    .await?;

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", proxy.addr))
        .json(&json!({
            "model": DEFAULT_MODEL,
            "stream": false,
            "messages": [{"role": "user", "content": "Say hello without a controller."}]
        }))
        .send()
        .await?;
    assert!(response.status().is_success());

    let stderr = proxy.stop();
    assert_eq!(
        stderr
            .matches("PROXY_CREDIT_BURN_AMOUNT is ignored")
            .count(),
        1,
        "expected one ignored-setting warning, got stderr: {stderr}"
    );

    openai.shutdown().await;
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
        ("CONTROLLER_BASE_URL", "http://127.0.0.1:1".to_string()),
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
    assert!(error.to_string().contains("PROXY_CREDENTIAL_LEASE_TOKEN"));

    drop(env_guard);
    Ok(())
}

/// A ChatGPT login's response that the upstream stops early is still a response the login's
/// plan was charged for, so the proxy reports the subscription usage its headers carry, as for a
/// completed one, while the client gets the proxy's terminal failure instead of a re-send.
#[tokio::test]
#[serial]
async fn a_cut_short_chatgpt_response_still_reports_the_subscription_usage() -> Result<()> {
    let upstream_calls = Arc::new(AtomicUsize::new(0));
    let calls = upstream_calls.clone();
    let chatgpt = Router::new().route(
        "/backend-api/codex/responses",
        post(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            async {
                let incomplete = json!({"type": "response.incomplete", "response": {
                    "id": "resp-cut", "model": DEFAULT_MODEL, "status": "incomplete",
                    "incomplete_details": {"reason": "max_output_tokens"}, "output": [],
                    "usage": {"input_tokens": 40, "output_tokens": 128, "total_tokens": 168}}});
                (
                    [
                        ("content-type", "text/event-stream"),
                        ("x-codex-primary-used-percent", "37"),
                        ("x-codex-primary-window-minutes", "300"),
                    ],
                    format!("data: {incomplete}\n\ndata: [DONE]\n\n"),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let chatgpt_endpoint = format!(
        "http://{}/backend-api/codex/responses",
        listener.local_addr()?
    );
    let chatgpt_server = tokio::spawn(async move { axum::serve(listener, chatgpt).await });

    let usage_reports = Arc::new(Mutex::new(Vec::new()));
    let mut controller = spawn_controller_with_state(ControllerState {
        credential_endpoint: None,
        credential_lease_token: "credential-lease-secret".to_string(),
        chatgpt_lease: true,
        usage_reports: usage_reports.clone(),
    })
    .await?;
    let env_guard = EnvGuard::set(&[
        ("CONTROLLER_BASE_URL", format_http_base(&controller.addr())),
        ("CONTROLLER_INTERNAL_TOKEN", "controller-secret".to_string()),
        (
            "PROXY_CREDENTIAL_LEASE_TOKEN",
            "credential-lease-secret".to_string(),
        ),
        ("PROXY_SIGNING_SECRET", "test-signing".to_string()),
        ("CODEX_PROXY_CHATGPT_ENDPOINT", chatgpt_endpoint),
    ]);
    let proxy = spawn_proxy(Credentials::ApiKey {
        key: "platform-key-must-not-be-used".to_string(),
        endpoint: None,
        default_model: None,
    })
    .await?;
    let credential_id = uuid::Uuid::new_v4().to_string();
    let token = issue_proxy_token_with_claims(
        "test-signing",
        "project-123",
        "runtime-456",
        Some("run-789"),
        Some(&credential_id),
    );

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/responses", proxy.addr))
        .bearer_auth(token)
        .json(&json!({"model": DEFAULT_MODEL, "input": "Cut this short.", "stream": true}))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await?;
    assert!(body.contains("\"type\":\"response.failed\""), "{body}");
    assert!(
        body.contains("Incomplete response returned, reason: max_output_tokens"),
        "{body}"
    );

    // The report is best effort and detached from the response.
    let deadline = Instant::now() + Duration::from_secs(5);
    while usage_reports.lock().expect("usage reports").is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let reports = usage_reports.lock().expect("usage reports").clone();
    assert_eq!(reports.len(), 1, "{reports:?}");
    assert_eq!(
        reports[0]["windows"],
        json!([{"kind": "primary", "usedPercent": 37, "windowMinutes": 300}])
    );
    assert!(
        controller
            .requests()
            .contains(&format!("POST /internal/credentials/{credential_id}/usage"))
    );
    assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);

    proxy.shutdown().await;
    controller.shutdown().await;
    chatgpt_server.abort();
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

/// The real `proxy` binary with only `vars` in its environment, so its
/// startup log can be read back.
struct ProxyProcess {
    addr: SocketAddr,
    child: Option<Child>,
    stderr: Option<std::thread::JoinHandle<String>>,
}

impl ProxyProcess {
    /// Stops the proxy and returns everything it wrote to stderr.
    fn stop(mut self) -> String {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.stderr
            .take()
            .and_then(|reader| reader.join().ok())
            .unwrap_or_default()
    }
}

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

async fn spawn_proxy_process(vars: &[(&str, String)]) -> Result<ProxyProcess> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    drop(listener);

    let mut child = Command::new(env!("CARGO_BIN_EXE_proxy"))
        .env_clear()
        .env("CODEX_PROXY_ADDR", addr.to_string())
        .envs(vars.iter().map(|(key, value)| (*key, value.as_str())))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start the proxy binary")?;
    let mut stderr = child.stderr.take().context("proxy stderr is piped")?;
    let stderr = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stderr.read_to_string(&mut output);
        output
    });
    let mut proxy = ProxyProcess {
        addr,
        child: Some(child),
        stderr: Some(stderr),
    };

    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let healthy = client
            .get(format!("http://{addr}/healthz"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        if healthy {
            return Ok(proxy);
        }
        if let Some(status) = proxy
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten())
        {
            bail!("proxy exited with {status}: {}", proxy.stop());
        }
        if Instant::now() > deadline {
            bail!("proxy did not become healthy: {}", proxy.stop());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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

/// Every request the controller stub received, as `METHOD /path`.
#[derive(Clone, Default)]
struct RequestLog(Arc<Mutex<Vec<String>>>);

struct ControllerHandle {
    addr: SocketAddr,
    requests: RequestLog,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl ControllerHandle {
    fn addr(&self) -> SocketAddr {
        self.addr
    }

    fn requests(&self) -> Vec<String> {
        self.requests.0.lock().expect("request log").clone()
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
    spawn_controller_with_state(ControllerState {
        credential_endpoint,
        credential_lease_token: "credential-lease-secret".to_string(),
        chatgpt_lease: false,
        usage_reports: Arc::default(),
    })
    .await
}

async fn spawn_controller_with_state(state: ControllerState) -> Result<ControllerHandle> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to bind controller stub")?;
    let addr = listener.local_addr()?;

    let requests = RequestLog::default();

    // Unknown routes, the old `/credits` among them, fall back to 404 and are
    // still logged.
    let router = Router::new()
        .route("/healthz", get(controller_health_handler))
        .route(
            "/internal/credentials/:credential_id",
            get(controller_credential_handler),
        )
        .route(
            "/internal/credentials/:credential_id/usage",
            post(controller_usage_handler),
        )
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn_with_state(
            requests.clone(),
            record_controller_request,
        ))
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
        requests,
        shutdown_tx: Some(shutdown_tx),
        task: Some(task),
    })
}

#[derive(Clone)]
struct ControllerState {
    credential_endpoint: Option<String>,
    credential_lease_token: String,
    /// Leases a ChatGPT login instead of an API key.
    chatgpt_lease: bool,
    /// The subscription-usage snapshots the proxy reported.
    usage_reports: Arc<Mutex<Vec<serde_json::Value>>>,
}

async fn record_controller_request(
    State(requests): State<RequestLog>,
    request: Request,
    next: Next,
) -> Response {
    requests.0.lock().expect("request log").push(format!(
        "{} {}",
        request.method(),
        request.uri().path()
    ));
    next.run(request).await
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
    if state.chatgpt_lease {
        return Json(json!({
            "kind": "codex_auth_json",
            "accessToken": "inert-chatgpt-access",
            "provider": "openai",
            "defaultModel": DEFAULT_MODEL,
            "leaseExpiresInSeconds": 60,
            "renewalAuthority": "controller"
        }))
        .into_response();
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

async fn controller_usage_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(snapshot): Json<serde_json::Value>,
) -> StatusCode {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if auth_header != format!("Bearer {}", state.credential_lease_token) {
        return StatusCode::UNAUTHORIZED;
    }
    state
        .usage_reports
        .lock()
        .expect("usage reports")
        .push(snapshot);
    StatusCode::NO_CONTENT
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
    SuccessWithBearer(String),
    /// Fails any request whose body contains the marker, and serves the rest.
    FailPromptsContaining(&'static str),
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

    let fail = match mode.as_ref() {
        OpenAiMode::SuccessWithBearer(_) => false,
        OpenAiMode::FailPromptsContaining(marker) => payload.to_string().contains(marker),
    };
    if fail {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": {
                    "message": "backend outage",
                    "type": "bad_gateway"
                }
            })),
        )
            .into_response();
    }

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

fn format_http_base(addr: &SocketAddr) -> String {
    format!("http://{}", addr)
}
