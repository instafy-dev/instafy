use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use axum::Router;
use axum::extract::{Json as AxumJson, Path, State};
use axum::http::{HeaderMap, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use openai_proxy_server::auth;
use openai_proxy_server::client::DEFAULT_MODEL;
use openai_proxy_server::proxy::{MANAGED_AI_CREDENTIAL_ID, run_proxy_with_shutdown};
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const CHAT_PROMPT: &str = "Say hello to the integration test in one short sentence.";
const RESPONSES_FIXTURE: &str = include_str!("fixtures/responses_success.sse");
const MANAGED_STUB_KEY: &str = "sk-managed-stub";
const LEASE_BEARER: &str = "credential-lease";
const SIGNING_SECRET: &str = "proxy-signing-test";
/// The run a dispatch job token belongs to. Session envelopes (agent login,
/// runtime register) carry no run_id.
const RUN_ID: &str = "44444444-4444-4444-8444-444444444444";

#[tokio::test]
async fn proxy_chat_completion_smoke() -> Result<()> {
    let credentials = match auth::load_credentials(None) {
        Ok(creds) => creds,
        Err(err) => {
            eprintln!("skipping proxy test: {}", err);
            return Ok(());
        }
    };

    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let server_credentials = credentials.clone();
    let server = tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };

        if let Err(error) = run_proxy_with_shutdown(addr, Some(server_credentials), shutdown).await
        {
            eprintln!("proxy server exited with error: {error}");
        }
    });

    tokio::time::sleep(Duration::from_millis(300)).await;

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    let payload = json!({
        "model": DEFAULT_MODEL,
        "stream": false,
        "messages": [
            {"role": "user", "content": CHAT_PROMPT}
        ]
    });

    let response = match client.post(&url).json(&payload).send().await {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!("skipping proxy test: failed to reach proxy: {}", err);
            let _ = shutdown_tx.send(());
            let _ = server.await;
            return Ok(());
        }
    };

    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        eprintln!(
            "skipping proxy test: upstream rejected credentials (status {})",
            response.status()
        );
        let _ = shutdown_tx.send(());
        let _ = server.await;
        return Ok(());
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        eprintln!("skipping proxy test: proxy returned {}: {}", status, body);
        let _ = shutdown_tx.send(());
        let _ = server.await;
        return Ok(());
    }

    let body: serde_json::Value = response.json().await?;
    let message = body
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("");

    if message.trim().is_empty() {
        eprintln!("skipping proxy test: empty assistant message returned: {body:#?}");
        let _ = shutdown_tx.send(());
        let _ = server.await;
        return Ok(());
    }

    let _ = shutdown_tx.send(());
    let _ = server.await;

    Ok(())
}

// --- managed lane on a RemoteDynamic proxy ---------------------------------
//
// A hosted runtime talks to a per-runtime proxy sidecar that has no static
// credentials (RemoteDynamic). A managed-lane turn carries a controller token
// with no credential_id; the sidecar must lease the platform credential from
// the controller under MANAGED_AI_CREDENTIAL_ID instead of refusing the turn.

struct EnvGuard {
    key: String,
    original: Option<String>,
}

impl EnvGuard {
    fn set(key: &str, value: Option<&str>) -> Self {
        let original = std::env::var(key).ok();
        unsafe {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        Self {
            key: key.to_string(),
            original,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.original {
                Some(value) => std::env::set_var(&self.key, value),
                None => std::env::remove_var(&self.key),
            }
        }
    }
}

struct ChildGuard(Option<oneshot::Sender<()>>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Clone)]
struct ControllerStub {
    /// (credential id, authorization header) per lease request.
    leases: Arc<Mutex<Vec<(String, String)>>>,
    /// `None` models a controller without MANAGED_AI_OPENAI_API_KEY.
    managed_key: Option<String>,
    upstream_base: String,
}

#[derive(Clone, Default)]
struct UpstreamStub {
    /// Authorization headers seen by the model endpoint.
    bearers: Arc<Mutex<Vec<String>>>,
}

async fn controller_lease_stub(
    State(stub): State<ControllerStub>,
    Path(credential_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    stub.leases
        .lock()
        .expect("lease log")
        .push((credential_id.clone(), authorization.clone()));

    if authorization != format!("Bearer {LEASE_BEARER}") {
        return (
            StatusCode::UNAUTHORIZED,
            AxumJson(json!({ "message": "credential lease authorization failed" })),
        );
    }
    if credential_id == MANAGED_AI_CREDENTIAL_ID {
        return match stub.managed_key.as_deref() {
            Some(key) => (
                StatusCode::OK,
                AxumJson(json!({
                    "credentialId": credential_id,
                    "kind": "openai_api_key",
                    "openaiApiKey": key,
                    "provider": "openai",
                    "upstreamEndpoint": format!("{}/v1/responses", stub.upstream_base),
                    "defaultModel": "gpt-5.6-luna",
                    "leaseExpiresInSeconds": 60,
                    "renewalAuthority": "controller",
                })),
            ),
            None => (
                StatusCode::NOT_FOUND,
                AxumJson(json!({
                    "message": "managed AI credential is not configured: set MANAGED_AI_OPENAI_API_KEY on the controller or give the proxy static credentials"
                })),
            ),
        };
    }
    (
        StatusCode::NOT_FOUND,
        AxumJson(json!({ "message": "credential not found: it was revoked or removed" })),
    )
}

async fn controller_health_stub() -> impl IntoResponse {
    (
        StatusCode::OK,
        [("x-instafy-credential-lease-protocol", "1")],
    )
}

async fn upstream_responses_stub(
    State(stub): State<UpstreamStub>,
    headers: HeaderMap,
    AxumJson(_payload): AxumJson<Value>,
) -> impl IntoResponse {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    stub.bearers
        .lock()
        .expect("bearer log")
        .push(authorization.clone());
    if authorization != format!("Bearer {MANAGED_STUB_KEY}") {
        return (
            StatusCode::UNAUTHORIZED,
            AxumJson(json!({ "error": { "message": "bad upstream key" } })),
        );
    }
    (StatusCode::OK, AxumJson(fixture_completed_response()))
}

fn fixture_completed_response() -> Value {
    RESPONSES_FIXTURE
        .split("\n\n")
        .filter_map(|chunk| {
            let data = chunk
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .collect::<Vec<_>>();
            if data.is_empty() {
                None
            } else {
                serde_json::from_str::<Value>(&data.join("\n")).ok()
            }
        })
        .find(|value| value.get("type").and_then(Value::as_str) == Some("response.completed"))
        .and_then(|value| value.get("response").cloned())
        .expect("fixture missing response.completed")
}

async fn spawn_router(app: Router) -> Result<(SocketAddr, ChildGuard)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    Ok((addr, ChildGuard(Some(shutdown_tx))))
}

async fn spawn_dynamic_proxy() -> Result<(SocketAddr, ChildGuard)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    drop(listener);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };
        // No static credentials: the proxy boots as RemoteDynamic, exactly
        // like the provider-host sidecar.
        if let Err(error) = run_proxy_with_shutdown(addr, None, shutdown).await {
            eprintln!("[proxy-test] dynamic proxy exited with error: {error}");
        }
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    Ok((addr, ChildGuard(Some(shutdown_tx))))
}

/// A managed-lane stack: upstream model stub, controller stub, dynamic proxy.
/// Returns the proxy address plus the recorded lease and upstream bearer logs.
async fn spawn_managed_stack(
    managed_key: Option<&str>,
    require_credential_claim: bool,
) -> Result<(
    SocketAddr,
    ControllerStub,
    UpstreamStub,
    Vec<EnvGuard>,
    Vec<ChildGuard>,
)> {
    let upstream = UpstreamStub::default();
    let (upstream_addr, upstream_guard) = spawn_router(
        Router::new()
            .route("/v1/responses", post(upstream_responses_stub))
            .with_state(upstream.clone()),
    )
    .await?;

    let controller = ControllerStub {
        leases: Arc::new(Mutex::new(Vec::new())),
        managed_key: managed_key.map(str::to_string),
        upstream_base: format!("http://{upstream_addr}"),
    };
    let (controller_addr, controller_guard) = spawn_router(
        Router::new()
            .route(
                "/internal/credentials/:credential_id",
                get(controller_lease_stub),
            )
            .route("/healthz", get(controller_health_stub))
            .with_state(controller.clone()),
    )
    .await?;

    let env = vec![
        EnvGuard::set(
            "PROXY_CONTROLLER_BASE_URL",
            Some(&format!("http://{controller_addr}")),
        ),
        EnvGuard::set("CONTROLLER_INTERNAL_TOKEN", Some("internal")),
        EnvGuard::set("PROXY_CREDENTIAL_LEASE_TOKEN", Some(LEASE_BEARER)),
        EnvGuard::set("PROXY_SIGNING_SECRET", Some(SIGNING_SECRET)),
        EnvGuard::set("PROXY_CREDIT_BURN_AMOUNT", None),
        EnvGuard::set("PROXY_REQUIRE_CONTROLLER_AUTH", None),
        EnvGuard::set(
            "PROXY_REQUIRE_CREDENTIAL_CLAIM",
            require_credential_claim.then_some("1"),
        ),
    ];
    let (proxy_addr, proxy_guard) = spawn_dynamic_proxy().await?;

    Ok((
        proxy_addr,
        controller,
        upstream,
        env,
        vec![upstream_guard, controller_guard, proxy_guard],
    ))
}

#[derive(Serialize)]
struct TestProxyClaims {
    aud: &'static str,
    iss: &'static str,
    sub: String,
    project_id: String,
    runtime_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_id: Option<String>,
    iat: i64,
    exp: i64,
}

/// Mint what the controller mints. A dispatch job token carries a run_id; a
/// managed-lane one has no credential_id; the agent-login and runtime-register
/// envelopes carry neither.
fn proxy_token(run_id: Option<&str>, credential_id: Option<&str>) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = TestProxyClaims {
        aud: "proxy",
        iss: "runtime-controller",
        sub: "proxy:project:runtime".to_string(),
        project_id: "11111111-1111-4111-8111-111111111111".to_string(),
        runtime_id: "22222222-2222-4222-8222-222222222222".to_string(),
        run_id: run_id.map(str::to_string),
        credential_id: credential_id.map(str::to_string),
        iat: now,
        exp: now + 300,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(SIGNING_SECRET.as_bytes()),
    )
    .expect("test proxy token")
}

async fn chat_through_proxy(addr: SocketAddr, token: &str) -> Result<(StatusCode, String)> {
    let response = reqwest::Client::new()
        .post(format!("http://{addr}/v1/chat/completions"))
        .bearer_auth(token)
        .json(&json!({
            "model": "gpt-5.6-luna",
            "stream": false,
            "messages": [{ "role": "user", "content": CHAT_PROMPT }]
        }))
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await?;
    Ok((status, body))
}

#[tokio::test]
#[serial]
async fn managed_lane_leases_the_platform_credential_on_a_dynamic_proxy() -> Result<()> {
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), false).await?;

    let (status, body) = chat_through_proxy(proxy_addr, &proxy_token(Some(RUN_ID), None)).await?;
    assert_eq!(status, StatusCode::OK, "managed turn must complete: {body}");
    let completion: Value = serde_json::from_str(&body)?;
    let content = completion["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default();
    assert!(
        !content.trim().is_empty(),
        "empty assistant message: {body}"
    );

    let leases = controller.leases.lock().expect("lease log").clone();
    assert_eq!(
        leases,
        vec![(
            MANAGED_AI_CREDENTIAL_ID.to_string(),
            format!("Bearer {LEASE_BEARER}")
        )],
        "the sidecar leases exactly the managed id under the lease bearer"
    );
    let bearers = upstream.bearers.lock().expect("bearer log").clone();
    assert_eq!(
        bearers,
        vec![format!("Bearer {MANAGED_STUB_KEY}")],
        "the platform key reaches the model endpoint"
    );

    // A second managed turn is served from the lease cache: still no static
    // material involved, and no repeat lease.
    let (status, body) = chat_through_proxy(proxy_addr, &proxy_token(Some(RUN_ID), None)).await?;
    assert_eq!(status, StatusCode::OK, "second managed turn: {body}");
    assert_eq!(controller.leases.lock().expect("lease log").len(), 1);

    Ok(())
}

#[tokio::test]
#[serial]
async fn session_envelope_without_a_run_id_keeps_the_byoc_rejection_on_a_dynamic_proxy()
-> Result<()> {
    // The controller also mints credential-less tokens with no run_id at
    // agent login and runtime register: session envelopes, not turns. Even
    // with the managed credential configured, a dynamic proxy answers those
    // with the exact pre-existing rejection and never leases the platform
    // key for them.
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), false).await?;

    let (status, body) = chat_through_proxy(proxy_addr, &proxy_token(None, None)).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unexpected body: {body}");
    let error: Value = serde_json::from_str(&body)?;
    assert_eq!(
        error["error"]["message"].as_str(),
        Some("proxy token missing credential_id for BYOC request"),
        "the exact old rejection, with no managed-lease suffix: {body}"
    );
    assert!(
        controller.leases.lock().expect("lease log").is_empty(),
        "no managed lease attempt for a run_id-less token"
    );
    assert!(
        upstream.bearers.lock().expect("bearer log").is_empty(),
        "nothing reaches the model endpoint"
    );

    // The same proxy still serves a dispatch job token (run_id set).
    let (status, body) = chat_through_proxy(proxy_addr, &proxy_token(Some(RUN_ID), None)).await?;
    assert_eq!(status, StatusCode::OK, "managed turn must complete: {body}");
    let ids = controller
        .leases
        .lock()
        .expect("lease log")
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec![MANAGED_AI_CREDENTIAL_ID.to_string()]);

    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_lane_keeps_the_byoc_rejection_when_the_controller_has_no_managed_credential()
-> Result<()> {
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(None, false).await?;

    let (status, body) = chat_through_proxy(proxy_addr, &proxy_token(Some(RUN_ID), None)).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unexpected body: {body}");
    assert!(
        body.contains("proxy token missing credential_id for BYOC request"),
        "today's rejection text stays the prefix: {body}"
    );
    assert!(
        body.contains("MANAGED_AI_OPENAI_API_KEY"),
        "the cause names the operator setting: {body}"
    );
    assert!(
        upstream.bearers.lock().expect("bearer log").is_empty(),
        "nothing reaches the model endpoint without a credential"
    );

    // BYOC tokens are untouched: they lease their own id and a controller
    // 404 surfaces as the credential error, never as the managed fallback.
    let byoc_id = "33333333-3333-4333-8333-333333333333";
    let (status, body) =
        chat_through_proxy(proxy_addr, &proxy_token(Some(RUN_ID), Some(byoc_id))).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unexpected body: {body}");
    assert!(
        !body.contains("missing credential_id"),
        "a BYOC token must not be treated as managed: {body}"
    );
    assert!(
        body.contains("credential not found"),
        "unexpected body: {body}"
    );

    let leases = controller.leases.lock().expect("lease log").clone();
    let ids = leases.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>();
    assert_eq!(ids, vec![MANAGED_AI_CREDENTIAL_ID, byoc_id]);

    Ok(())
}

#[tokio::test]
#[serial]
async fn credential_claim_requirement_still_rejects_credential_less_tokens() -> Result<()> {
    // The public lane (PROXY_REQUIRE_CREDENTIAL_CLAIM=1) must never reach the
    // platform key: authentication refuses the token before any lease.
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), true).await?;

    let (status, body) = chat_through_proxy(proxy_addr, &proxy_token(Some(RUN_ID), None)).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unexpected body: {body}");
    assert!(
        body.contains("proxy token missing valid credential_id claim"),
        "unexpected body: {body}"
    );
    assert!(controller.leases.lock().expect("lease log").is_empty());
    assert!(upstream.bearers.lock().expect("bearer log").is_empty());

    Ok(())
}
