//! Where a thread's developer messages reach each upstream, through the real proxy.
//!
//! Codex sends a thread's whole history with every request: its opening developer message
//! first, then the turns, and a turn whose run instructions or note changed starts with a
//! developer message of its own. A provider bills a request's start as cached as far as it
//! matches a request it saw before, so a Responses upstream gets each later developer message in
//! its place and the start of every request stays as it was. A Chat Completions upstream, whose
//! providers differ on instructions after the first message, gets all of them in the first
//! message, as before. All credentials are fixtures and every upstream is a loopback server.
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Result, ensure};
use axum::extract::{OriginalUri, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use openai_proxy_server::auth::Credentials;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

const OPENING: &str = "<permissions instructions>Opening rules.</permissions instructions>";
const CHANGED_RUN: &str = "<instafy_run_instructions>\nThese run instructions replace all run instructions given earlier in this conversation, including the ones it started with. All other instructions still apply.\n\nThe second turn's rules.\n</instafy_run_instructions>";
const NOTE: &str = "<instafy_turn_notes>\nThis note replaces any earlier turn note in this conversation.\n\nFor this turn only: a note.\n</instafy_turn_notes>";

struct TaskGuard(tokio::task::JoinHandle<()>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct EnvGuard(&'static str, Option<std::ffi::OsString>);

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let original = std::env::var_os(key);
        // This file's one test owns these fixtures for its whole run.
        unsafe { std::env::set_var(key, value) };
        Self(key, original)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.1 {
                Some(value) => std::env::set_var(self.0, value),
                None => std::env::remove_var(self.0),
            }
        }
    }
}

async fn capture_upstream(
    State(captured): State<mpsc::UnboundedSender<Value>>,
    OriginalUri(uri): OriginalUri,
    Json(payload): Json<Value>,
) -> Response {
    captured.send(payload.clone()).unwrap();
    if uri.path() == "/v1/chat/completions" {
        return Json(json!({
            "id": "chatcmpl-test", "model": payload["model"],
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]
        }))
        .into_response();
    }
    let response = json!({
        "id": "resp_test", "object": "response", "model": payload["model"], "status": "completed",
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]}]
    });
    if uri.path() == "/backend-api/codex/responses" {
        return (
            [("content-type", "text/event-stream")],
            format!(
                "data: {}\n\n",
                json!({"type": "response.completed", "response": response})
            ),
        )
            .into_response();
    }
    Json(response).into_response()
}

async fn spawn_proxy(credentials: Credentials) -> Result<(SocketAddr, TaskGuard)> {
    let reservation = TcpListener::bind("127.0.0.1:0").await?;
    let addr = reservation.local_addr()?;
    drop(reservation);
    let task = TaskGuard(tokio::spawn(async move {
        run_proxy_with_shutdown(addr, Some(credentials), std::future::pending::<()>())
            .await
            .expect("fixture proxy starts");
    }));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()?;
    for _ in 0..100 {
        if client
            .get(format!("http://{addr}/healthz"))
            .send()
            .await
            .is_ok()
        {
            return Ok((addr, task));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("fixture proxy did not become ready")
}

fn message(role: &str, text: &str) -> Value {
    let kind = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    json!({ "type": "message", "role": role, "content": [{ "type": kind, "text": text }] })
}

/// A thread's first request, and its request at the next turn, whose run instructions and
/// note changed.
fn thread_requests() -> [Value; 2] {
    let first = vec![
        message("developer", OPENING),
        message("user", "First request."),
    ];
    let mut second = first.clone();
    second.extend([
        message("assistant", "First answer."),
        message("developer", CHANGED_RUN),
        message("developer", NOTE),
        message("user", "Second request."),
    ]);
    [first, second].map(|input| {
        json!({
            "model": "gpt-5.5",
            "instructions": "Codex base.",
            "input": input,
            "stream": false,
            "prompt_cache_key": "thread-1",
        })
    })
}

fn text_of(item: &Value) -> String {
    match &item["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The two requests of a Responses upstream: the second starts with the whole of the first,
/// and its later developer messages are where Codex put them, as developer messages.
fn check_responses(name: &str, first: &Value, second: &Value) -> Result<()> {
    let first = first["input"].as_array().cloned().unwrap_or_default();
    let second = second["input"].as_array().cloned().unwrap_or_default();
    ensure!(
        second.get(..first.len()) == Some(&first[..]),
        "{name}: the later request does not start with the earlier one, so its start is not served from the cache:\nfirst: {first:#?}\nsecond: {second:#?}"
    );
    ensure!(
        first[0]["role"] == "user" && text_of(&first[0]) == format!("{OPENING}\n\nCodex base."),
        "{name}: the opening developer message and Codex's instructions are not the first message: {:#}",
        first[0]
    );
    let later: Vec<&Value> = second[first.len()..].iter().collect();
    ensure!(
        later
            == [
                &message("assistant", "First answer."),
                &message("developer", CHANGED_RUN),
                &message("developer", NOTE),
                &message("user", "Second request."),
            ],
        "{name}: the later developer messages are not in their place as developer messages: {later:#?}"
    );
    Ok(())
}

/// The second request of a Chat Completions upstream: every developer message is in the first
/// user message, in order and ahead of Codex's instructions, as before, and no message after it
/// carries instructions.
fn check_chat_completions(second: &Value) -> Result<()> {
    let messages = second["messages"].as_array().cloned().unwrap_or_default();
    let roles: Vec<&str> = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect();
    ensure!(
        roles == ["system", "user", "user", "assistant", "user"],
        "chat completions: unexpected messages {messages:#?}"
    );
    ensure!(
        text_of(&messages[1]) == format!("{OPENING}\n\n{CHANGED_RUN}\n\n{NOTE}\n\nCodex base."),
        "chat completions: the first user message does not carry every developer message: {:#}",
        messages[1]
    );
    for later in &messages[2..] {
        let text = text_of(later);
        ensure!(
            !text.contains("<instafy_run_instructions>") && !text.contains("<instafy_turn_notes>"),
            "chat completions: a later message carries instructions: {later:#}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn later_developer_messages_keep_the_start_of_a_request_on_responses_upstreams() -> Result<()>
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream = listener.local_addr()?;
    let _env = [
        EnvGuard::set(
            "CODEX_PROXY_CHATGPT_ENDPOINT",
            &format!("http://{upstream}/backend-api/codex/responses"),
        ),
        EnvGuard::set("PROXY_CONTROLLER_BASE_URL", ""),
        EnvGuard::set("CONTROLLER_BASE_URL", ""),
        EnvGuard::set("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        EnvGuard::set("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
    ];
    let (captured_tx, mut captured_rx) = mpsc::unbounded_channel();
    let app = Router::new()
        .route("/v1/responses", post(capture_upstream))
        .route("/v1/chat/completions", post(capture_upstream))
        .route("/backend-api/codex/responses", post(capture_upstream))
        .with_state(captured_tx);
    let _upstream_task = TaskGuard(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let upstreams = [
        (
            "a ChatGPT login",
            Credentials::ChatGpt {
                access_token: "fixture-access-token".into(),
                refresh_token: None,
                account_id: None,
                default_model: None,
                auth_path: None,
            },
        ),
        (
            "an API key",
            Credentials::ApiKey {
                key: "fixture-api-key".into(),
                endpoint: Some(format!("http://{upstream}/v1/responses")),
                default_model: None,
            },
        ),
        (
            "chat completions",
            Credentials::ApiKey {
                key: "fixture-api-key".into(),
                endpoint: Some(format!("http://{upstream}/v1/chat/completions")),
                default_model: None,
            },
        ),
    ];
    for (name, credentials) in upstreams {
        let (addr, _proxy_task) = spawn_proxy(credentials).await?;
        let mut sent = Vec::new();
        for request in thread_requests() {
            let response = client
                .post(format!("http://{addr}/v1/responses"))
                .json(&request)
                .send()
                .await?;
            ensure!(
                response.status().is_success(),
                "{name}: {}",
                response.text().await?
            );
            let upstream_request = tokio::time::timeout(Duration::from_secs(1), captured_rx.recv())
                .await?
                .expect("the upstream got the request");
            sent.push(upstream_request);
        }
        if name == "chat completions" {
            check_chat_completions(&sent[1])?;
        } else {
            check_responses(name, &sent[0], &sent[1])?;
        }
    }
    Ok(())
}
