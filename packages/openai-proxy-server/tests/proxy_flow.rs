use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use axum::Router;
use axum::extract::{Json as AxumJson, Path, State};
use axum::http::{HeaderMap, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use openai_proxy_server::auth::{self, Credentials};
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
/// A user's own API key, which the controller stub serves unpinned under
/// `BYO_CREDENTIAL_ID`.
const BYO_STUB_KEY: &str = "sk-byo-stub";
const BYO_CREDENTIAL_ID: &str = "55555555-5555-4555-8555-555555555555";
/// The managed model the controller stub pins its lease to.
const PINNED_MODEL: &str = "gpt-6-luna";
/// The model stub's Responses path. It names the OpenAI host so the proxy
/// treats the stub as OpenAI and honours explicit model ids as it does in
/// production; a bare loopback endpoint reads as a BYOC provider, where
/// OpenAI-shaped ids fall back to the credential default.
const UPSTREAM_RESPONSES_PATH: &str = "/api.openai.com/v1/responses";
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
    /// `pinnedModel` on the managed lease; `None` models a controller that
    /// predates the field.
    pinned_model: Option<String>,
    upstream_base: String,
}

#[derive(Clone, Default)]
struct UpstreamStub {
    /// Authorization headers seen by the model endpoint.
    bearers: Arc<Mutex<Vec<String>>>,
    /// The `model` of each request the model endpoint received.
    models: Arc<Mutex<Vec<String>>>,
    /// The `tools` of each request the model endpoint received (null when
    /// absent).
    tools: Arc<Mutex<Vec<Value>>>,
    /// The `input` of each request the model endpoint received.
    inputs: Arc<Mutex<Vec<Value>>>,
    /// How many of the next model requests to reject as an expired token.
    expire_next: Arc<AtomicUsize>,
    /// Paths of the audio requests that reached the provider.
    audio: Arc<Mutex<Vec<String>>>,
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
            Some(key) => {
                let mut lease = json!({
                    "credentialId": credential_id,
                    "kind": "openai_api_key",
                    "openaiApiKey": key,
                    "provider": "openai",
                    "upstreamEndpoint": format!("{}{UPSTREAM_RESPONSES_PATH}", stub.upstream_base),
                    "defaultModel": "gpt-5.6-luna",
                    "leaseExpiresInSeconds": 60,
                    "renewalAuthority": "controller",
                });
                if let Some(pinned_model) = stub.pinned_model.as_deref() {
                    lease["defaultModel"] = json!(pinned_model);
                    lease["pinnedModel"] = json!(pinned_model);
                }
                (StatusCode::OK, AxumJson(lease))
            }
            None => (
                StatusCode::NOT_FOUND,
                AxumJson(json!({
                    "message": "managed AI credential is not configured: set MANAGED_AI_OPENAI_API_KEY on the controller or give the proxy static credentials and PROXY_PINNED_MODEL"
                })),
            ),
        };
    }
    if credential_id == BYO_CREDENTIAL_ID {
        return (
            StatusCode::OK,
            AxumJson(json!({
                "credentialId": credential_id,
                "kind": "openai_api_key",
                "openaiApiKey": BYO_STUB_KEY,
                "provider": "openai",
                "upstreamEndpoint": format!("{}{UPSTREAM_RESPONSES_PATH}", stub.upstream_base),
                "defaultModel": "gpt-5.6-sol",
                "leaseExpiresInSeconds": 60,
                "renewalAuthority": "controller",
            })),
        );
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
    AxumJson(payload): AxumJson<Value>,
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
    stub.models.lock().expect("model log").push(
        payload
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    );
    stub.tools
        .lock()
        .expect("tool log")
        .push(payload.get("tools").cloned().unwrap_or(Value::Null));
    stub.inputs
        .lock()
        .expect("input log")
        .push(payload.get("input").cloned().unwrap_or(Value::Null));
    if authorization != format!("Bearer {MANAGED_STUB_KEY}")
        && authorization != format!("Bearer {BYO_STUB_KEY}")
    {
        return (
            StatusCode::UNAUTHORIZED,
            AxumJson(json!({ "error": { "message": "bad upstream key" } })),
        );
    }
    if stub
        .expire_next
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
            left.checked_sub(1)
        })
        .is_ok()
    {
        return (
            StatusCode::UNAUTHORIZED,
            AxumJson(json!({
                "error": {
                    "message": "Your authentication token has expired.",
                    "code": "token_expired"
                }
            })),
        );
    }
    (StatusCode::OK, AxumJson(fixture_completed_response()))
}

async fn upstream_audio_stub(
    State(stub): State<UpstreamStub>,
    uri: axum::http::Uri,
) -> impl IntoResponse {
    stub.audio
        .lock()
        .expect("audio log")
        .push(uri.path().to_string());
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"text":"stub"}"#,
    )
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

/// Without static credentials the proxy boots as RemoteDynamic, exactly like
/// the provider-host sidecar.
async fn spawn_proxy(credentials: Option<Credentials>) -> Result<(SocketAddr, ChildGuard)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    drop(listener);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };
        if let Err(error) = run_proxy_with_shutdown(addr, credentials, shutdown).await {
            eprintln!("[proxy-test] proxy exited with error: {error}");
        }
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    Ok((addr, ChildGuard(Some(shutdown_tx))))
}

type Stack = (
    SocketAddr,
    ControllerStub,
    UpstreamStub,
    Vec<EnvGuard>,
    Vec<ChildGuard>,
);

/// Which proxy a stack runs.
enum StackProxy<'a> {
    /// No static credentials (RemoteDynamic), the hosted sidecar.
    Dynamic,
    /// Static credentials holding the operator's key, the self-hosted
    /// managed lane, with this `PROXY_PINNED_MODEL` (`None` leaves it unset).
    Static { pinned_model: Option<&'a str> },
    /// Static credentials and no controller integration: the proxy checks
    /// no token. The controller stub still runs but the proxy never calls it.
    Standalone { pinned_model: Option<&'a str> },
}

/// A managed-lane stack: upstream model stub, controller stub, dynamic proxy.
/// Returns the proxy address plus the recorded lease and upstream bearer logs.
async fn spawn_managed_stack(
    managed_key: Option<&str>,
    pinned_model: Option<&str>,
    require_credential_claim: bool,
) -> Result<Stack> {
    spawn_stack(
        managed_key,
        pinned_model,
        require_credential_claim,
        StackProxy::Dynamic,
    )
    .await
}

/// A self-hosted managed lane: the proxy holds the operator's key as static
/// credentials, and the controller serves no managed lease.
async fn spawn_static_stack(pinned_model: Option<&str>) -> Result<Stack> {
    spawn_stack(None, None, false, StackProxy::Static { pinned_model }).await
}

async fn spawn_stack(
    managed_key: Option<&str>,
    pinned_model: Option<&str>,
    require_credential_claim: bool,
    proxy: StackProxy<'_>,
) -> Result<Stack> {
    let upstream = UpstreamStub::default();
    let (upstream_addr, upstream_guard) = spawn_router(
        Router::new()
            .route(UPSTREAM_RESPONSES_PATH, post(upstream_responses_stub))
            .route("/v1/audio/speech", post(upstream_audio_stub))
            .route("/v1/audio/transcriptions", post(upstream_audio_stub))
            .with_state(upstream.clone()),
    )
    .await?;

    let controller = ControllerStub {
        leases: Arc::new(Mutex::new(Vec::new())),
        managed_key: managed_key.map(str::to_string),
        pinned_model: pinned_model.map(str::to_string),
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

    let static_key = || {
        Some(Credentials::ApiKey {
            key: MANAGED_STUB_KEY.to_string(),
            endpoint: Some(format!("http://{upstream_addr}{UPSTREAM_RESPONSES_PATH}")),
            default_model: None,
        })
    };
    let (static_credentials, static_pinned_model, controller_integration) = match proxy {
        StackProxy::Dynamic => (None, None, true),
        StackProxy::Static { pinned_model } => (static_key(), pinned_model, true),
        StackProxy::Standalone { pinned_model } => (static_key(), pinned_model, false),
    };
    let controller_base_url = format!("http://{controller_addr}");
    let env = vec![
        EnvGuard::set("PROXY_PINNED_MODEL", static_pinned_model),
        EnvGuard::set(
            "PROXY_CONTROLLER_BASE_URL",
            controller_integration.then_some(controller_base_url.as_str()),
        ),
        EnvGuard::set("CONTROLLER_BASE_URL", None),
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
    let (proxy_addr, proxy_guard) = spawn_proxy(static_credentials).await?;

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
    chat_through_proxy_as(addr, token, "gpt-5.6-luna").await
}

async fn chat_through_proxy_as(
    addr: SocketAddr,
    token: &str,
    model: &str,
) -> Result<(StatusCode, String)> {
    post_through_proxy(
        addr,
        token,
        "/v1/chat/completions",
        json!({
            "model": model,
            "stream": false,
            "messages": [{ "role": "user", "content": CHAT_PROMPT }]
        }),
    )
    .await
}

async fn responses_through_proxy(
    addr: SocketAddr,
    token: &str,
    model: &str,
) -> Result<(StatusCode, String)> {
    post_through_proxy(
        addr,
        token,
        "/v1/responses",
        json!({
            "model": model,
            "stream": false,
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": CHAT_PROMPT }]
            }]
        }),
    )
    .await
}

async fn post_through_proxy(
    addr: SocketAddr,
    token: &str,
    path: &str,
    body: Value,
) -> Result<(StatusCode, String)> {
    let response = reqwest::Client::new()
        .post(format!("http://{addr}{path}"))
        .bearer_auth(token)
        .json(&body)
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
        spawn_managed_stack(Some(MANAGED_STUB_KEY), None, false).await?;

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

/// One request per proxy route, shaped as the runtime sends it.
fn every_route() -> Vec<(&'static str, Value)> {
    vec![
        (
            "/v1/responses",
            json!({
                "model": "gpt-5.6-sol",
                "stream": false,
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": CHAT_PROMPT }]
                }]
            }),
        ),
        (
            "/v1/chat/completions",
            json!({
                "model": "gpt-5.6-sol",
                "stream": false,
                "messages": [{ "role": "user", "content": CHAT_PROMPT }]
            }),
        ),
        (
            "/v1/audio/speech",
            json!({ "model": "gpt-4o-mini-tts", "voice": "cedar", "input": "Hello." }),
        ),
        (
            "/v1/audio/transcriptions",
            json!({ "model": "gpt-4o-transcribe" }),
        ),
    ]
}

/// Sends a session envelope (a credential-less token without a run_id) on
/// every route and checks each gets the exact pre-existing rejection, with
/// no lease and nothing sent upstream.
async fn assert_session_envelope_refused(
    proxy_addr: SocketAddr,
    controller: &ControllerStub,
    upstream: &UpstreamStub,
) -> Result<()> {
    let envelope = proxy_token(None, None);
    for (path, body) in every_route() {
        let (status, body) = post_through_proxy(proxy_addr, &envelope, path, body).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
        let error: Value = serde_json::from_str(&body)?;
        assert_eq!(
            error["error"]["message"].as_str(),
            Some("proxy token missing credential_id for BYOC request"),
            "{path}: the exact old rejection, with no managed-lease suffix: {body}"
        );
    }
    assert!(
        controller.leases.lock().expect("lease log").is_empty(),
        "no lease attempt for a run_id-less token"
    );
    assert!(
        upstream.bearers.lock().expect("bearer log").is_empty(),
        "nothing reaches the model endpoint"
    );
    assert!(
        upstream.audio.lock().expect("audio log").is_empty(),
        "nothing reaches the audio endpoints"
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn dynamic_proxy_refuses_credentialless_session_token() -> Result<()> {
    // The controller also mints credential-less tokens with no run_id at
    // agent login and runtime register: session envelopes, not turns. Even
    // with the managed credential configured, a dynamic proxy answers those
    // with the exact pre-existing rejection on every route and never leases
    // the platform key for them.
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), None, false).await?;

    assert_session_envelope_refused(proxy_addr, &controller, &upstream).await?;

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
async fn static_proxy_refuses_credentialless_session_token() -> Result<()> {
    // Static credentials used to serve a session envelope as they serve a
    // proxy without a controller: on the operator's key, with any model and
    // unmetered. With controller integration a static proxy refuses it
    // exactly as a dynamic one does, pinned or not.
    for pinned_model in [Some(PINNED_MODEL), None] {
        let (proxy_addr, controller, upstream, _env, _guards) =
            spawn_static_stack(pinned_model).await?;

        assert_session_envelope_refused(proxy_addr, &controller, &upstream).await?;

        // The same proxy still serves a managed run on its own key.
        let managed = proxy_token(Some(RUN_ID), None);
        let (status, body) = responses_through_proxy(proxy_addr, &managed, "gpt-5.6-sol").await?;
        assert_eq!(status, StatusCode::OK, "managed run: {body}");
        assert_eq!(
            upstream.models.lock().expect("model log").clone(),
            vec![pinned_model.unwrap_or("gpt-5.6-sol")]
        );
        assert_eq!(
            upstream.bearers.lock().expect("bearer log").clone(),
            vec![format!("Bearer {MANAGED_STUB_KEY}")]
        );
    }

    Ok(())
}

#[tokio::test]
#[serial]
async fn static_proxy_without_controller_serves_unauthenticated_requests() -> Result<()> {
    // Without a controller the proxy checks no token, so there is no lane
    // to tell apart: every request goes out on its static credentials as it
    // always has, with the model it asks for (PROXY_PINNED_MODEL pins only
    // a controller-signed managed run) and audio available.
    let (proxy_addr, controller, upstream, _env, _guards) = spawn_stack(
        None,
        None,
        false,
        StackProxy::Standalone {
            pinned_model: Some(PINNED_MODEL),
        },
    )
    .await?;

    let client = reqwest::Client::new();
    for (path, body) in every_route() {
        // No Authorization header, and a session envelope the proxy cannot
        // check, are served alike.
        let anonymous = client
            .post(format!("http://{proxy_addr}{path}"))
            .json(&body)
            .send()
            .await?;
        let status = anonymous.status();
        let text = anonymous.text().await?;
        assert_eq!(status, StatusCode::OK, "{path}: {text}");
        let (status, text) =
            post_through_proxy(proxy_addr, &proxy_token(None, None), path, body).await?;
        assert_eq!(status, StatusCode::OK, "{path} with a token: {text}");
    }
    assert_eq!(
        upstream.models.lock().expect("model log").clone(),
        vec!["gpt-5.6-sol"; 4],
        "responses and chat completions keep the requested model"
    );
    assert_eq!(
        upstream.bearers.lock().expect("bearer log").clone(),
        vec![format!("Bearer {MANAGED_STUB_KEY}"); 4]
    );
    assert_eq!(
        upstream.audio.lock().expect("audio log").clone(),
        vec![
            "/v1/audio/speech",
            "/v1/audio/speech",
            "/v1/audio/transcriptions",
            "/v1/audio/transcriptions"
        ]
    );
    assert!(controller.leases.lock().expect("lease log").is_empty());

    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_lane_keeps_the_byoc_rejection_when_the_controller_has_no_managed_credential()
-> Result<()> {
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(None, None, false).await?;

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
        spawn_managed_stack(Some(MANAGED_STUB_KEY), None, true).await?;

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

#[tokio::test]
#[serial]
async fn managed_lane_sends_every_request_as_the_pinned_model() -> Result<()> {
    // Jobs that reach the platform key without managedAiUsed (skill-mode
    // ambient evaluations, service-role dispatches, a failed secrets fetch)
    // ask for the runtime default. On the pinned managed lease the proxy
    // sends each of them as the managed model, on both model routes.
    let token = proxy_token(Some(RUN_ID), None);
    {
        let (proxy_addr, controller, upstream, _env, _guards) =
            spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?;

        for model in ["gpt-5.6-sol", "gpt-5-codex", "deepseek-chat", ""] {
            let (status, body) = responses_through_proxy(proxy_addr, &token, model).await?;
            assert_eq!(status, StatusCode::OK, "/v1/responses as {model:?}: {body}");
        }
        // The direct worker lanes call Chat Completions with CODEX_MODEL.
        let (status, body) = chat_through_proxy_as(proxy_addr, &token, "gpt-5.6-sol").await?;
        assert_eq!(status, StatusCode::OK, "/v1/chat/completions: {body}");

        assert_eq!(
            upstream.models.lock().expect("model log").clone(),
            vec![PINNED_MODEL; 5],
            "every request on the platform key goes out as the managed model"
        );
        assert_eq!(
            upstream.bearers.lock().expect("bearer log").clone(),
            vec![format!("Bearer {MANAGED_STUB_KEY}"); 5]
        );
        assert_eq!(controller.leases.lock().expect("lease log").len(), 1);
    }

    // A controller that predates `pinnedModel` leaves the proxy on today's
    // rule: an explicit model id goes out verbatim.
    {
        let (proxy_addr, _controller, upstream, _env, _guards) =
            spawn_managed_stack(Some(MANAGED_STUB_KEY), None, false).await?;
        let (status, body) = responses_through_proxy(proxy_addr, &token, "gpt-5.6-sol").await?;
        assert_eq!(status, StatusCode::OK, "/v1/responses: {body}");
        let (status, body) = chat_through_proxy_as(proxy_addr, &token, "gpt-5.6-sol").await?;
        assert_eq!(status, StatusCode::OK, "/v1/chat/completions: {body}");
        assert_eq!(
            upstream.models.lock().expect("model log").clone(),
            vec!["gpt-5.6-sol"; 2]
        );
    }

    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_lane_refuses_audio_on_the_pinned_lease() -> Result<()> {
    // Speech and transcription name an audio model the pinned model cannot
    // stand in for, so a pinned lease sends nothing upstream on those routes.
    let token = proxy_token(Some(RUN_ID), None);
    let speech = json!({ "model": "gpt-4o-mini-tts", "voice": "cedar", "input": "Hello." });
    let transcription = json!({ "model": "gpt-4o-transcribe" });
    {
        let (proxy_addr, _controller, upstream, _env, _guards) =
            spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?;
        for (path, body) in [
            ("/v1/audio/speech", speech.clone()),
            ("/v1/audio/transcriptions", transcription.clone()),
        ] {
            let (status, body) = post_through_proxy(proxy_addr, &token, path, body).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
            assert!(
                body.contains("only serves model gpt-6-luna"),
                "{path}: {body}"
            );
            assert!(!body.contains(MANAGED_STUB_KEY), "{path}: {body}");
        }
        assert!(
            upstream.audio.lock().expect("audio log").is_empty(),
            "no audio request reaches the provider on the platform key"
        );
    }

    // Without a pin the audio routes forward as they do today.
    {
        let (proxy_addr, _controller, upstream, _env, _guards) =
            spawn_managed_stack(Some(MANAGED_STUB_KEY), None, false).await?;
        for (path, body) in [
            ("/v1/audio/speech", speech),
            ("/v1/audio/transcriptions", transcription),
        ] {
            let (status, body) = post_through_proxy(proxy_addr, &token, path, body).await?;
            assert_eq!(status, StatusCode::OK, "{path}: {body}");
        }
        assert_eq!(
            upstream.audio.lock().expect("audio log").clone(),
            vec!["/v1/audio/speech", "/v1/audio/transcriptions"]
        );
    }

    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_lane_keeps_the_pin_when_a_rejected_lease_is_renewed() -> Result<()> {
    // A 401 token_expired from the provider makes the proxy renew the lease
    // (forceRefresh) and send the request again. The pin is the controller's
    // policy for the credential, so the retry goes out as the pinned model
    // too. Only the client's own token refresh is ChatGPT-only: the lease
    // renewal takes any leased credential, the managed API key included,
    // whose 401 body reports an expired or invalidated token.
    let token = proxy_token(Some(RUN_ID), None);
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?;
    upstream.expire_next.store(1, Ordering::SeqCst);

    let (status, body) = responses_through_proxy(proxy_addr, &token, "gpt-5.6-sol").await?;
    assert_eq!(status, StatusCode::OK, "renewed request: {body}");
    assert_eq!(
        upstream.models.lock().expect("model log").clone(),
        vec![PINNED_MODEL; 2],
        "the rejected request and its retry both go out as the managed model"
    );
    assert_eq!(
        upstream.bearers.lock().expect("bearer log").clone(),
        vec![format!("Bearer {MANAGED_STUB_KEY}"); 2]
    );
    let lease_ids = controller
        .leases
        .lock()
        .expect("lease log")
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        lease_ids,
        vec![MANAGED_AI_CREDENTIAL_ID.to_string(); 2],
        "the initial lease and its renewal"
    );

    Ok(())
}

/// Sends `tools` both as the request's `tools` and in an `additional_tools`
/// input item, where codex puts its tool list for Responses Lite models.
async fn responses_with_tools_through_proxy(
    addr: SocketAddr,
    token: &str,
    tools: &Value,
) -> Result<(StatusCode, String)> {
    post_through_proxy(
        addr,
        token,
        "/v1/responses",
        json!({
            "model": "gpt-5.6-sol",
            "stream": false,
            "tools": tools,
            "input": [
                { "type": "additional_tools", "role": "developer", "tools": tools },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": CHAT_PROMPT }]
                }
            ]
        }),
    )
    .await
}

/// The tools of the `additional_tools` input item each upstream request
/// carried.
fn upstream_additional_tools(upstream: &UpstreamStub) -> Vec<Value> {
    upstream
        .inputs
        .lock()
        .expect("input log")
        .iter()
        .map(|input| {
            input
                .as_array()
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("type").and_then(Value::as_str) == Some("additional_tools")
                    })
                })
                .and_then(|item| item.get("tools").cloned())
                .unwrap_or(Value::Null)
        })
        .collect()
}

/// Codex's client tools plus the hosted ones it can also emit (web search, a
/// tool search OpenAI runs), and hand-built tools that run their own model.
fn client_and_hosted_tools() -> (Value, Value) {
    let client_tools = json!([
        {
            "type": "function",
            "name": "exec_command",
            "description": "Runs a command.",
            "strict": false,
            "parameters": { "type": "object", "properties": {} }
        },
        {
            "type": "tool_search",
            "execution": "client",
            "description": "Search deferred tools.",
            "parameters": { "type": "object", "properties": {} }
        }
    ]);
    let mut tools = client_tools.clone();
    tools.as_array_mut().expect("tool list").extend([
        json!({ "type": "web_search", "external_web_access": true }),
        json!({
            "type": "tool_search",
            "execution": "server",
            "description": "Search deferred tools.",
            "parameters": { "type": "object", "properties": {} }
        }),
        json!({ "type": "image_generation", "model": "gpt-image-1" }),
        json!({
            "type": "function",
            "name": "priced",
            "parameters": { "type": "object", "properties": {} },
            "model": "gpt-5.6-sol"
        }),
    ]);
    (client_tools, tools)
}

#[tokio::test]
#[serial]
async fn pinned_lease_drops_web_search_in_tools_and_additional_tools() -> Result<()> {
    // A hosted tool runs on OpenAI's side and bills per call on top of the
    // tokens credits price, and a hand-built one can run its own model, on
    // the key the operator pays for. A pinned lease forwards only codex's
    // client tools, and none that names its own model: web search and a
    // server-run tool search stay off the platform key.
    let (client_tools, tools) = client_and_hosted_tools();
    let token = proxy_token(Some(RUN_ID), None);

    // The controller's pinned managed lease, and static credentials pinned
    // with PROXY_PINNED_MODEL.
    for name in ["managed lease", "static credentials"] {
        let (proxy_addr, _controller, upstream, _env, _guards) = if name == "managed lease" {
            spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?
        } else {
            spawn_static_stack(Some(PINNED_MODEL)).await?
        };
        let (status, body) = responses_with_tools_through_proxy(proxy_addr, &token, &tools).await?;
        assert_eq!(status, StatusCode::OK, "{name}: {body}");
        assert_eq!(
            upstream.tools.lock().expect("tool log").clone(),
            vec![client_tools.clone()],
            "{name}: only the allowed, model-free tools reach the provider"
        );
        assert_eq!(
            upstream_additional_tools(&upstream),
            vec![client_tools.clone()],
            "{name}: the same holds for tools carried in the input"
        );
    }

    // An unpinned lease (a controller that predates the pin) forwards every
    // client tool exactly as before.
    let (proxy_addr, _controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), None, false).await?;
    let (status, body) = responses_with_tools_through_proxy(proxy_addr, &token, &tools).await?;
    assert_eq!(status, StatusCode::OK, "unpinned lease: {body}");
    assert_eq!(
        upstream.tools.lock().expect("tool log").clone(),
        vec![tools.clone()]
    );
    assert_eq!(upstream_additional_tools(&upstream), vec![tools]);

    Ok(())
}

#[tokio::test]
#[serial]
async fn byo_lane_forwards_web_search() -> Result<()> {
    // A user's own credential pays for its own hosted tools: the platform
    // pin never applies to it, so every tool goes upstream unchanged, on a
    // dynamic proxy whose managed lease is pinned and on a pinned static one.
    let (_, tools) = client_and_hosted_tools();
    let byo = proxy_token(Some(RUN_ID), Some(BYO_CREDENTIAL_ID));
    for name in ["dynamic", "static"] {
        let (proxy_addr, controller, upstream, _env, _guards) = if name == "dynamic" {
            spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?
        } else {
            spawn_static_stack(Some(PINNED_MODEL)).await?
        };
        let (status, body) = responses_with_tools_through_proxy(proxy_addr, &byo, &tools).await?;
        assert_eq!(status, StatusCode::OK, "{name}: {body}");
        assert_eq!(
            upstream.tools.lock().expect("tool log").clone(),
            vec![tools.clone()],
            "{name}: every tool reaches the provider"
        );
        assert_eq!(
            upstream_additional_tools(&upstream),
            vec![tools.clone()],
            "{name}: the input keeps every tool"
        );
        assert_eq!(
            upstream.models.lock().expect("model log").clone(),
            vec!["gpt-5.6-sol"],
            "{name}: the requested model, not the pin"
        );
        assert_eq!(
            upstream.bearers.lock().expect("bearer log").clone(),
            vec![format!("Bearer {BYO_STUB_KEY}")],
            "{name}: on the user's own key"
        );
        let ids = controller
            .leases
            .lock()
            .expect("lease log")
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![BYO_CREDENTIAL_ID.to_string()], "{name}");
    }

    Ok(())
}

async fn platform_lane(proxy_addr: SocketAddr, path: &str) -> Result<Value> {
    let response = reqwest::Client::new()
        .get(format!("http://{proxy_addr}{path}"))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    let body: Value = response.json().await?;
    Ok(body["platformLane"].clone())
}

#[tokio::test]
#[serial]
async fn healthz_reports_static_pin_and_credential_kind() -> Result<()> {
    // Static credentials serve the platform lane on the proxy's own key, and
    // the report says which kind of key and which model it is pinned to,
    // on liveness and readiness alike.
    for (pinned_model, reported_pin) in [
        (Some(PINNED_MODEL), json!(PINNED_MODEL)),
        (Some("   "), json!(null)),
        (None, json!(null)),
    ] {
        let (proxy_addr, _controller, _upstream, _env, _guards) =
            spawn_static_stack(pinned_model).await?;
        for path in ["/healthz", "/readyz"] {
            assert_eq!(
                platform_lane(proxy_addr, path).await?,
                json!({
                    "servedBy": "static",
                    "pinnedModel": reported_pin,
                    "staticCredentialKind": "api_key",
                    "sessionTokensRefused": true,
                    "reportsUsage": false,
                    "controllerMeteringProtocol": null,
                    "outputCeilingSource": null,
                }),
                "{path} with PROXY_PINNED_MODEL={pinned_model:?}"
            );
        }
    }

    // The public lane (PROXY_REQUIRE_CREDENTIAL_CLAIM=1) refuses every
    // credential-less token even with static credentials, so it serves no
    // platform lane and reports neither the pin nor the key kind.
    let (proxy_addr, _controller, _upstream, _env, _guards) = spawn_stack(
        None,
        None,
        true,
        StackProxy::Static {
            pinned_model: Some(PINNED_MODEL),
        },
    )
    .await?;
    for path in ["/healthz", "/readyz"] {
        assert_eq!(
            platform_lane(proxy_addr, path).await?,
            json!({
                "servedBy": "refused",
                "pinnedModel": null,
                "staticCredentialKind": null,
                "sessionTokensRefused": true,
                "reportsUsage": false,
                "controllerMeteringProtocol": null,
                "outputCeilingSource": null,
            }),
            "{path} with static credentials on the public lane"
        );
    }

    // Without a controller no token marks a managed run, so the setting pins
    // nothing and no token is refused.
    let (proxy_addr, _controller, _upstream, _env, _guards) = spawn_stack(
        None,
        None,
        false,
        StackProxy::Standalone {
            pinned_model: Some(PINNED_MODEL),
        },
    )
    .await?;
    for path in ["/healthz", "/readyz"] {
        assert_eq!(
            platform_lane(proxy_addr, path).await?,
            json!({
                "servedBy": "static",
                "pinnedModel": null,
                "staticCredentialKind": "api_key",
                "sessionTokensRefused": false,
                "reportsUsage": false,
                "controllerMeteringProtocol": null,
                "outputCeilingSource": null,
            }),
            "{path} without a controller"
        );
    }

    Ok(())
}

#[tokio::test]
#[serial]
async fn healthz_reports_controller_lease_on_dynamic() -> Result<()> {
    // A sidecar without static credentials serves the platform lane from the
    // controller's managed lease, which brings its own pin.
    let (proxy_addr, _controller, _upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?;
    for path in ["/healthz", "/readyz"] {
        assert_eq!(
            platform_lane(proxy_addr, path).await?,
            json!({
                "servedBy": "controller_lease",
                "pinnedModel": null,
                "staticCredentialKind": null,
                "sessionTokensRefused": true,
                "reportsUsage": false,
                "controllerMeteringProtocol": null,
                "outputCeilingSource": null,
            }),
            "{path}"
        );
    }

    // The public lane (PROXY_REQUIRE_CREDENTIAL_CLAIM=1) refuses every
    // credential-less token, so it serves no platform lane at all.
    let (proxy_addr, _controller, _upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), true).await?;
    for path in ["/healthz", "/readyz"] {
        let lane = platform_lane(proxy_addr, path).await?;
        assert_eq!(lane["servedBy"], json!("refused"), "{path}: {lane}");
        assert_eq!(lane["sessionTokensRefused"], json!(true), "{path}: {lane}");
    }

    Ok(())
}

#[tokio::test]
#[serial]
async fn managed_lane_filters_client_tools_when_a_rejected_lease_is_renewed() -> Result<()> {
    // A lease renewal rebuilds the request from the client's original body,
    // so the retry must drop the same tools as the rejected attempt, in
    // `tools` and in the input.
    let function = json!({
        "type": "function",
        "name": "exec_command",
        "parameters": { "type": "object", "properties": {} }
    });
    let tools = json!([function, { "type": "image_generation", "model": "gpt-image-1" }]);
    let token = proxy_token(Some(RUN_ID), None);
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_managed_stack(Some(MANAGED_STUB_KEY), Some(PINNED_MODEL), false).await?;
    upstream.expire_next.store(1, Ordering::SeqCst);

    let (status, body) = responses_with_tools_through_proxy(proxy_addr, &token, &tools).await?;
    assert_eq!(status, StatusCode::OK, "renewed request: {body}");
    assert_eq!(
        controller.leases.lock().expect("lease log").len(),
        2,
        "the initial lease and its renewal"
    );
    assert_eq!(
        upstream.tools.lock().expect("tool log").clone(),
        vec![json!([function]); 2],
        "the rejected request and its retry forward only the allowed tools"
    );
    assert_eq!(
        upstream_additional_tools(&upstream),
        vec![json!([function]); 2],
        "the same holds for tools carried in the input"
    );

    Ok(())
}

#[tokio::test]
#[serial]
async fn static_credentials_send_managed_runs_as_the_proxy_pinned_model() -> Result<()> {
    // A self-hoster serves managed runs from the proxy's own key. With
    // PROXY_PINNED_MODEL set they get the managed lease's policy: every
    // request goes out as the pinned model and audio is refused.
    let (proxy_addr, controller, upstream, _env, _guards) =
        spawn_static_stack(Some(PINNED_MODEL)).await?;
    let managed = proxy_token(Some(RUN_ID), None);
    for model in ["gpt-5.6-sol", ""] {
        let (status, body) = responses_through_proxy(proxy_addr, &managed, model).await?;
        assert_eq!(status, StatusCode::OK, "/v1/responses as {model:?}: {body}");
    }
    let (status, body) = chat_through_proxy_as(proxy_addr, &managed, "gpt-5.6-sol").await?;
    assert_eq!(status, StatusCode::OK, "/v1/chat/completions: {body}");
    assert_eq!(
        upstream.models.lock().expect("model log").clone(),
        vec![PINNED_MODEL; 3]
    );
    assert_eq!(
        upstream.bearers.lock().expect("bearer log").clone(),
        vec![format!("Bearer {MANAGED_STUB_KEY}"); 3],
        "the static key serves managed runs"
    );
    let speech = json!({ "model": "gpt-4o-mini-tts", "voice": "cedar", "input": "Hello." });
    let transcription = json!({ "model": "gpt-4o-transcribe" });
    for (path, body) in [
        ("/v1/audio/speech", speech.clone()),
        ("/v1/audio/transcriptions", transcription.clone()),
    ] {
        let (status, body) = post_through_proxy(proxy_addr, &managed, path, body).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {body}");
        assert!(
            body.contains("only serves model gpt-6-luna"),
            "{path}: {body}"
        );
    }
    assert!(upstream.audio.lock().expect("audio log").is_empty());
    assert!(
        controller.leases.lock().expect("lease log").is_empty(),
        "static credentials serve managed runs without a lease"
    );

    // A user's own credential on the same proxy is leased from the
    // controller and never pinned by the setting.
    let byo = proxy_token(Some(RUN_ID), Some(BYO_CREDENTIAL_ID));
    let (status, body) = responses_through_proxy(proxy_addr, &byo, "gpt-5.6-sol").await?;
    assert_eq!(status, StatusCode::OK, "BYO /v1/responses: {body}");
    let (status, body) = chat_through_proxy_as(proxy_addr, &byo, "gpt-5.6-sol").await?;
    assert_eq!(status, StatusCode::OK, "BYO /v1/chat/completions: {body}");
    assert_eq!(
        upstream.models.lock().expect("model log")[3..].to_vec(),
        vec!["gpt-5.6-sol"; 2]
    );
    assert_eq!(
        upstream.bearers.lock().expect("bearer log")[3..].to_vec(),
        vec![format!("Bearer {BYO_STUB_KEY}"); 2]
    );
    for (path, body) in [
        ("/v1/audio/speech", speech),
        ("/v1/audio/transcriptions", transcription),
    ] {
        let (status, body) = post_through_proxy(proxy_addr, &byo, path, body).await?;
        assert_eq!(status, StatusCode::OK, "BYO {path}: {body}");
    }
    assert_eq!(
        upstream.audio.lock().expect("audio log").clone(),
        vec!["/v1/audio/speech", "/v1/audio/transcriptions"]
    );

    Ok(())
}

#[tokio::test]
#[serial]
async fn static_credentials_without_a_pinned_model_keep_the_requested_model() -> Result<()> {
    // Without PROXY_PINNED_MODEL, static credentials serve managed runs as
    // they always have (the proxy warns once that the pin is missing).
    let (proxy_addr, _controller, upstream, _env, _guards) = spawn_static_stack(None).await?;
    let managed = proxy_token(Some(RUN_ID), None);
    let (status, body) = responses_through_proxy(proxy_addr, &managed, "gpt-5.6-sol").await?;
    assert_eq!(status, StatusCode::OK, "/v1/responses: {body}");
    let (status, body) = chat_through_proxy_as(proxy_addr, &managed, "gpt-5.6-sol").await?;
    assert_eq!(status, StatusCode::OK, "/v1/chat/completions: {body}");
    assert_eq!(
        upstream.models.lock().expect("model log").clone(),
        vec!["gpt-5.6-sol"; 2]
    );
    let (status, body) = post_through_proxy(
        proxy_addr,
        &managed,
        "/v1/audio/speech",
        json!({ "model": "gpt-4o-mini-tts", "voice": "cedar", "input": "Hello." }),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "/v1/audio/speech: {body}");

    Ok(())
}
