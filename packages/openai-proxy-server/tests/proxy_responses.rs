use std::collections::HashSet;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Result;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use axum::routing::post;
use openai_proxy_server::auth::{self, Credentials};
use openai_proxy_server::client::DEFAULT_MODEL;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use futures_util::stream;
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const RESPONSES_FIXTURE: &str = include_str!("fixtures/responses_success.sse");
const STUB_API_KEY: &str = "test-proxy-api-key";

#[derive(Clone)]
struct ChatGptStubState {
    expected_token: String,
    expected_account_id: Option<String>,
}

#[derive(Clone)]
struct ApiStubState {
    expected_key: String,
}

#[derive(Clone)]
struct ChatGptToolForwardingStubState {
    expected_token: String,
}

#[derive(Clone)]
struct ApiToolForwardingStubState {
    expected_key: String,
}

fn resolve_live_api_key() -> Option<String> {
    std::env::var("PROXY_TEST_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

struct EnvGuard {
    key: String,
    original: Option<String>,
}

impl EnvGuard {
    fn set(key: &str, value: impl AsRef<str>) -> Self {
        let original = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, value.as_ref());
        }
        Self {
            key: key.to_string(),
            original,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.original {
            unsafe {
                std::env::set_var(&self.key, value);
            }
        } else {
            unsafe {
                std::env::remove_var(&self.key);
            }
        }
    }
}

struct ChildGuard {
    shutdown: Option<oneshot::Sender<()>>,
}

impl ChildGuard {
    fn new(shutdown: oneshot::Sender<()>) -> Self {
        Self {
            shutdown: Some(shutdown),
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

#[tokio::test]
#[serial]
async fn proxy_streams_responses_with_chatgpt_credentials() -> Result<()> {
    let token = "chatgpt-access-token";
    let account_id = Some("chatgpt-account".to_string());

    let (stub_addr, stub_guard) = spawn_chatgpt_stub(token, account_id.clone()).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_PROXY_CHATGPT_ENDPOINT",
        format!(
            "http://{}/backend-api/codex/responses",
            stub_addr.to_string()
        ),
    );

    let credentials = Credentials::ChatGpt {
        access_token: token.to_string(),
        refresh_token: None,
        account_id,
        default_model: None,
        auth_path: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;

    let body = issue_proxy_request(proxy_addr, "Create abc.md with xyz").await?;
    assert_proxy_stream(&body);

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_forwards_requested_tools_with_chatgpt_credentials() -> Result<()> {
    let token = "chatgpt-access-token";
    let (stub_addr, stub_guard) = spawn_chatgpt_tool_forwarding_stub(token).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_PROXY_CHATGPT_ENDPOINT",
        format!(
            "http://{}/backend-api/codex/responses",
            stub_addr.to_string()
        ),
    );

    let credentials = Credentials::ChatGpt {
        access_token: token.to_string(),
        refresh_token: None,
        account_id: None,
        default_model: None,
        auth_path: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;
    let body = issue_proxy_request_with_controls(proxy_addr, "Inspect the repo.").await?;
    assert_proxy_stream(&body);

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_streams_responses_with_api_key_credentials() -> Result<()> {
    let (stub_addr, stub_guard) = spawn_api_stub(STUB_API_KEY).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{}/v1/responses", stub_addr),
    );

    let credentials = Credentials::ApiKey {
        key: STUB_API_KEY.to_string(),
        endpoint: None,
        default_model: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;

    let body = issue_proxy_request(proxy_addr, "Create abc.md with xyz").await?;
    assert_proxy_stream(&body);

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_forwards_requested_tools_with_api_key_credentials() -> Result<()> {
    let (stub_addr, stub_guard) = spawn_api_tool_forwarding_stub(STUB_API_KEY).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{}/v1/responses", stub_addr),
    );

    let credentials = Credentials::ApiKey {
        key: STUB_API_KEY.to_string(),
        endpoint: None,
        default_model: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;
    let body = issue_proxy_request_with_controls(proxy_addr, "Inspect the repo.").await?;
    assert_proxy_stream(&body);

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_streams_responses_with_chat_completions_upstream() -> Result<()> {
    let (stub_addr, stub_guard) = spawn_chat_completions_stub(STUB_API_KEY).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{}/v1/chat/completions", stub_addr),
    );

    let credentials = Credentials::ApiKey {
        key: STUB_API_KEY.to_string(),
        endpoint: None,
        default_model: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;

    let body = issue_proxy_request(proxy_addr, "Hello from chat completions upstream").await?;
    assert_proxy_stream(&body);

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_forwards_audio_speech_with_api_key_credentials() -> Result<()> {
    let (stub_addr, stub_guard) = spawn_speech_stub(STUB_API_KEY).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{}/v1/responses", stub_addr),
    );

    let credentials = Credentials::ApiKey {
        key: STUB_API_KEY.to_string(),
        endpoint: None,
        default_model: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/audio/speech", proxy_addr);
    let response = client
        .post(url)
        .json(&json!({
            "model": "gpt-4o-mini-tts",
            "voice": "cedar",
            "input": "Hello from the proxy.",
            "response_format": "wav"
        }))
        .send()
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("audio/wav")
    );
    let bytes = response.bytes().await?;
    assert_eq!(bytes.as_ref(), b"stub-wave");

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

#[tokio::test]
#[serial]
async fn proxy_forwards_audio_transcriptions_with_api_key_credentials() -> Result<()> {
    let (stub_addr, stub_guard) = spawn_transcription_stub(STUB_API_KEY).await?;

    let _endpoint_guard = EnvGuard::set(
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{}/v1/responses", stub_addr),
    );

    let credentials = Credentials::ApiKey {
        key: STUB_API_KEY.to_string(),
        endpoint: None,
        default_model: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/audio/transcriptions", proxy_addr);
    let form = reqwest::multipart::Form::new()
        .text("model", "gpt-4o-transcribe")
        .text("language", "en")
        .part(
            "file",
            reqwest::multipart::Part::bytes(b"stub-wave".to_vec())
                .file_name("benchmark.wav")
                .mime_str("audio/wav")?,
        );
    let response = client.post(url).multipart(form).send().await?;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await?;
    assert_eq!(
        body.get("text").and_then(Value::as_str),
        Some("Transcribe this stub audio.")
    );

    drop(proxy_guard);
    drop(stub_guard);

    Ok(())
}

async fn spawn_proxy(credentials: Option<Credentials>) -> Result<(SocketAddr, ChildGuard)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("failed to bind proxy listener");
    let addr = listener.local_addr().expect("local addr");
    drop(listener);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn({
        async move {
            let shutdown = async move {
                let _ = shutdown_rx.await;
            };

            let result = run_proxy_with_shutdown(addr, credentials, shutdown).await;
            if let Err(error) = result {
                eprintln!("[proxy-test] proxy server exited with error: {error}");
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(100)).await;

    Ok((addr, ChildGuard::new(shutdown_tx)))
}

async fn issue_proxy_request(addr: SocketAddr, prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/responses", addr);
    let payload = json!({
        "model": DEFAULT_MODEL,
        "stream": true,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": prompt
                    }
                ]
            }
        ]
    });

    let response = client.post(url).json(&payload).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if status != StatusCode::OK {
        return Err(anyhow::anyhow!(
            "proxy returned status {} with body: {}",
            status,
            body
        ));
    }

    Ok(body)
}

async fn issue_proxy_request_with_controls(addr: SocketAddr, prompt: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/responses", addr);
    let payload = json!({
        "model": DEFAULT_MODEL,
        "stream": true,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": prompt
                    }
                ]
            }
        ],
        "tools": [
            {
                "type": "function",
                "name": "exec_command",
                "description": "Runs a command.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": { "type": "string" }
                    },
                    "required": ["cmd"],
                    "additionalProperties": false
                },
                "strict": false
            }
        ],
        "tool_choice": {
            "type": "function",
            "name": "exec_command"
        },
        "parallel_tool_calls": false,
        "text": {
            "format": {
                "type": "text"
            }
        }
    });

    let response = client.post(url).json(&payload).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if status != StatusCode::OK {
        return Err(anyhow::anyhow!(
            "proxy returned status {} with body: {}",
            status,
            body
        ));
    }

    Ok(body)
}

async fn spawn_chatgpt_stub(
    token: &str,
    account_id: Option<String>,
) -> Result<(SocketAddr, ChildGuard)> {
    let state = ChatGptStubState {
        expected_token: token.to_string(),
        expected_account_id: account_id,
    };

    let app = Router::new()
        .route("/backend-api/codex/responses", post(handle_chatgpt_stub))
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_chatgpt_tool_forwarding_stub(token: &str) -> Result<(SocketAddr, ChildGuard)> {
    let state = ChatGptToolForwardingStubState {
        expected_token: token.to_string(),
    };

    let app = Router::new()
        .route(
            "/backend-api/codex/responses",
            post(handle_chatgpt_tool_forwarding_stub),
        )
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_api_stub(api_key: &str) -> Result<(SocketAddr, ChildGuard)> {
    let state = ApiStubState {
        expected_key: api_key.to_string(),
    };

    let app = Router::new()
        .route("/v1/responses", post(handle_api_stub))
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_api_tool_forwarding_stub(api_key: &str) -> Result<(SocketAddr, ChildGuard)> {
    let state = ApiToolForwardingStubState {
        expected_key: api_key.to_string(),
    };

    let app = Router::new()
        .route("/v1/responses", post(handle_api_tool_forwarding_stub))
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_chat_completions_stub(api_key: &str) -> Result<(SocketAddr, ChildGuard)> {
    let state = ApiStubState {
        expected_key: api_key.to_string(),
    };

    let app = Router::new()
        .route("/v1/chat/completions", post(handle_chat_completions_stub))
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_speech_stub(api_key: &str) -> Result<(SocketAddr, ChildGuard)> {
    let state = ApiStubState {
        expected_key: api_key.to_string(),
    };

    let app = Router::new()
        .route("/v1/audio/speech", post(handle_speech_stub))
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_transcription_stub(api_key: &str) -> Result<(SocketAddr, ChildGuard)> {
    let state = ApiStubState {
        expected_key: api_key.to_string(),
    };

    let app = Router::new()
        .route("/v1/audio/transcriptions", post(handle_transcription_stub))
        .with_state(state);

    spawn_stub_router(app).await
}

async fn spawn_stub_router(app: Router) -> Result<(SocketAddr, ChildGuard)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("failed to bind stub listener");
    let addr = listener.local_addr().expect("stub address");
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let service = app.into_make_service();
        if let Err(error) = axum::serve(listener, service)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        {
            eprintln!("[proxy-test] stub server exited with error: {error}");
        }
    });

    Ok((addr, ChildGuard::new(shutdown_tx)))
}

async fn handle_chatgpt_stub(
    State(state): State<ChatGptStubState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_token);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected ChatGPT access token"
    );

    if let Some(ref expected_account_id) = state.expected_account_id {
        let actual_account = headers
            .get("chatgpt-account-id")
            .or_else(|| headers.get("ChatGPT-Account-Id"))
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert_eq!(
            actual_account, expected_account_id,
            "proxy forwarded unexpected ChatGPT account id"
        );
    }

    assert_tools_present(&payload);
    assert!(
        payload
            .get("parallel_tool_calls")
            .and_then(Value::as_bool)
            .is_some(),
        "expected parallel_tool_calls flag in ChatGPT payload"
    );

    responses_fixture_stream()
}

async fn handle_chatgpt_tool_forwarding_stub(
    State(state): State<ChatGptToolForwardingStubState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_token);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected ChatGPT access token"
    );

    assert_requested_exec_tool_controls(&payload);

    responses_fixture_stream()
}

async fn handle_api_stub(
    State(state): State<ApiStubState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_key);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected API key"
    );

    assert!(
        payload.get("stream").is_some(),
        "proxy omitted stream flag in API request"
    );

    axum::Json(fixture_completed_response())
}

async fn handle_api_tool_forwarding_stub(
    State(state): State<ApiToolForwardingStubState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_key);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected API key"
    );

    assert_requested_exec_tool_controls(&payload);

    axum::Json(fixture_completed_response())
}

async fn handle_chat_completions_stub(
    State(state): State<ApiStubState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_key);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected API key"
    );

    assert!(
        payload.get("stream").is_some(),
        "proxy omitted stream flag in chat completions request"
    );
    assert!(
        payload.get("messages").and_then(Value::as_array).is_some(),
        "proxy chat completions request missing messages array"
    );
    assert!(
        payload.get("model").and_then(Value::as_str).is_some(),
        "proxy chat completions request missing model"
    );

    axum::Json(json!({
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 1234567890,
        "model": payload.get("model").cloned().unwrap_or_else(|| json!("unknown")),
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "stubbed chat completion"
                },
                "finish_reason": "stop"
            }
        ],
        "usage": {
            "prompt_tokens": 1,
            "completion_tokens": 2,
            "total_tokens": 3
        }
    }))
}

async fn handle_speech_stub(
    State(state): State<ApiStubState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_key);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected API key"
    );

    assert_eq!(
        payload.get("model").and_then(Value::as_str),
        Some("gpt-4o-mini-tts")
    );
    assert_eq!(payload.get("voice").and_then(Value::as_str), Some("cedar"));
    assert_eq!(
        payload.get("input").and_then(Value::as_str),
        Some("Hello from the proxy.")
    );
    assert_eq!(
        payload.get("response_format").and_then(Value::as_str),
        Some("wav")
    );

    (
        [(header::CONTENT_TYPE, "audio/wav")],
        Vec::from("stub-wave".as_bytes()),
    )
}

async fn handle_transcription_stub(
    State(state): State<ApiStubState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let expected_header = format!("Bearer {}", state.expected_key);
    let actual_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert_eq!(
        actual_header, expected_header,
        "proxy forwarded unexpected API key"
    );

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.starts_with("multipart/form-data;"),
        "expected multipart content-type, got {}",
        content_type
    );

    let body_text = String::from_utf8(body.to_vec()).expect("utf8 multipart body");
    assert!(body_text.contains("name=\"model\""));
    assert!(body_text.contains("gpt-4o-transcribe"));
    assert!(body_text.contains("name=\"language\""));
    assert!(body_text.contains("en"));
    assert!(body_text.contains("name=\"file\"; filename=\"benchmark.wav\""));

    Json(json!({
        "text": "Transcribe this stub audio."
    }))
}

fn assert_tools_present(payload: &Value) {
    let tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .expect("ChatGPT payload missing tools array");

    let shell_present = tools.iter().any(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .map(|name| name == "shell")
            .unwrap_or(false)
    });
    assert!(
        shell_present,
        "ChatGPT payload missing shell tool spec: {tools:?}"
    );

    let apply_patch_present = tools.iter().any(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .map(|name| name == "apply_patch")
            .unwrap_or(false)
    });
    assert!(
        apply_patch_present,
        "ChatGPT payload missing apply_patch tool spec: {tools:?}"
    );
}

fn assert_requested_exec_tool_controls(payload: &Value) {
    let tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .expect("payload missing tools array");
    assert!(
        tools.iter().any(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name == "exec_command")
        }),
        "payload did not preserve requested exec_command tool: {tools:?}"
    );
    assert_eq!(
        payload.pointer("/tool_choice/type").and_then(Value::as_str),
        Some("function")
    );
    assert_eq!(
        payload.pointer("/tool_choice/name").and_then(Value::as_str),
        Some("exec_command")
    );
    assert_eq!(
        payload.get("parallel_tool_calls").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        payload.pointer("/text/format/type").and_then(Value::as_str),
        Some("text")
    );
}

fn responses_fixture_stream() -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let events = load_fixture_payloads();
    let stream = stream::iter(
        events
            .into_iter()
            .map(|payload| Ok::<Event, Infallible>(Event::default().data(payload))),
    );
    Sse::new(stream)
}

fn load_fixture_payloads() -> Vec<String> {
    RESPONSES_FIXTURE
        .split("\n\n")
        .filter_map(|chunk| {
            let data = chunk
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(|value| value.trim()))
                .collect::<Vec<_>>();
            if data.is_empty() {
                None
            } else {
                Some(data.join("\n"))
            }
        })
        .collect()
}

fn fixture_completed_response() -> Value {
    load_fixture_payloads()
        .into_iter()
        .filter_map(|payload| {
            let value: Value = serde_json::from_str(&payload).expect("fixture payload invalid");
            match value.get("type").and_then(Value::as_str) {
                Some("response.completed") => value.get("response").cloned(),
                _ => None,
            }
        })
        .next()
        .expect("fixture missing response.completed")
}

fn assert_proxy_stream(body: &str) {
    assert!(
        body.contains("[DONE]"),
        "proxy stream missing terminal [DONE] marker: {body}"
    );

    let events = parse_sse_events(body);
    let mut types = HashSet::new();
    for event in &events {
        if let Some(kind) = event.get("type").and_then(Value::as_str) {
            types.insert(kind.to_string());
        }
    }

    for expected in [
        "response.created",
        "response.output_item.added",
        "response.output_text.delta",
        "response.output_item.done",
        "response.completed",
    ] {
        assert!(
            types.contains(expected),
            "proxy stream missing expected event type {expected}; saw {types:?}"
        );
    }

    let completed = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("response.completed"))
        .expect("missing response.completed event");

    let output = completed
        .get("response")
        .and_then(|resp| resp.get("output"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    assert!(
        !output.is_empty(),
        "response.completed missing output items: {completed:?}"
    );
}

fn parse_sse_events(body: &str) -> Vec<Value> {
    let mut events = Vec::new();
    for chunk in body.split("\n\n") {
        for line in chunk.lines() {
            if let Some(payload) = line.strip_prefix("data:") {
                let payload = payload.trim();
                if payload == "[DONE]" || payload.is_empty() {
                    continue;
                }
                let value: Value =
                    serde_json::from_str(payload).expect("proxy stream emitted invalid JSON");
                events.push(value);
            }
        }
    }
    events
}

fn assert_events_include_answer(events: &[Value], expected: &str) {
    let trimmed_expected = expected.trim();

    let seen_delta = events.iter().any(|event| {
        event
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| *kind == "response.output_text.delta")
            .and_then(|_| {
                event
                    .get("delta")
                    .and_then(Value::as_str)
                    .map(|delta| delta.trim() == trimmed_expected)
            })
            .unwrap_or(false)
    });

    if seen_delta {
        return;
    }

    let final_text = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("response.completed"))
        .and_then(|event| {
            event
                .get("response")
                .and_then(|resp| resp.get("output"))
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().find_map(|item| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .and_then(|parts| {
                                parts.iter().find_map(|part| {
                                    if part.get("type").and_then(Value::as_str)
                                        == Some("output_text")
                                    {
                                        part.get("text").and_then(Value::as_str)
                                    } else {
                                        None
                                    }
                                })
                            })
                    })
                })
        });

    if let Some(text) = final_text {
        assert_eq!(
            text.trim(),
            trimmed_expected,
            "expected final output `{trimmed_expected}`, got `{text}`"
        );
    } else {
        panic!("expected response output to include `{trimmed_expected}`, events: {events:#?}");
    }
}

#[tokio::test]
async fn proxy_live_responses_with_api_key() -> anyhow::Result<()> {
    if std::env::var("PROXY_LIVE_TEST").ok().as_deref() != Some("1") {
        eprintln!("[proxy-live] skipping (set PROXY_LIVE_TEST=1 to enable)");
        return Ok(());
    }

    let api_key = match resolve_live_api_key() {
        Some(value) => value,
        None => {
            eprintln!(
                "[proxy-live] skipping (set PROXY_TEST_API_KEY to a valid OpenAI key to enable)"
            );
            return Ok(());
        }
    };
    let credentials = Credentials::ApiKey {
        key: api_key.clone(),
        endpoint: None,
        default_model: None,
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;
    let body = issue_proxy_request(proxy_addr, "What is 1+1? Answer only with the number.").await?;
    assert_proxy_stream(&body);
    let events = parse_sse_events(&body);
    assert_events_include_answer(&events, "2");

    drop(proxy_guard);
    Ok(())
}

#[tokio::test]
async fn proxy_live_responses_with_chatgpt_tokens() -> anyhow::Result<()> {
    if std::env::var("PROXY_LIVE_TEST").ok().as_deref() != Some("1") {
        eprintln!("[proxy-live] skipping (set PROXY_LIVE_TEST=1 to enable)");
        return Ok(());
    }

    let credentials = match auth::load_credentials(None) {
        Ok(Credentials::ChatGpt {
            access_token,
            refresh_token,
            account_id,
            default_model,
            auth_path,
        }) => Credentials::ChatGpt {
            access_token,
            refresh_token,
            account_id,
            default_model,
            auth_path,
        },
        Ok(_) => {
            eprintln!("[proxy-live] skipping (auth.json missing ChatGPT tokens)");
            return Ok(());
        }
        Err(err) => {
            eprintln!("[proxy-live] skipping (failed to load credentials: {err})");
            return Ok(());
        }
    };

    let (proxy_addr, proxy_guard) = spawn_proxy(Some(credentials)).await?;
    let body = issue_proxy_request(proxy_addr, "What is 1+1? Answer only with the number.").await?;
    assert_proxy_stream(&body);
    let events = parse_sse_events(&body);
    assert_events_include_answer(&events, "2");

    drop(proxy_guard);
    Ok(())
}
