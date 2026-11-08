//! Requests that share their start, through the real proxy.
//!
//! Each chat's routing step is a new thread, and its request opens with the same items in every
//! chat (the tool list, the instructions, the space's folder and the routing instructions) up to
//! the person's own words, under one cache key for that start. Codex gives every item of a
//! thread its own id, and every message the turn and the time it was made in, so a provider
//! served another chat's routing step from its cache only as far as the first item with an id.
//! A request with that key now goes upstream with its opening items as every chat in the space
//! sends them, and a request with its own thread's key goes as it came. All credentials are
//! fixtures and every upstream is a loopback server.
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use axum::body::Bytes;
use axum::extract::{OriginalUri, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use openai_proxy_server::auth::Credentials;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;

/// The one cache key the runtime gives every chat's routing step.
const SHARED_START_KEY: &str = "instafy-shared-start-6f1d2c3b4a5968778695a4b3c2d1e0f9";
const BASE: &str = "You are Codex, a background agent.";
const PERMISSIONS: &str =
    "<permissions instructions>Commands run in the space's folder.</permissions instructions>";
const RUN: &str =
    "<instafy_run_instructions>\nAnswer with one JSON object.\n</instafy_run_instructions>";
const ENVIRONMENT: &str = "<environment_context>\n  <cwd>/workspace/space</cwd>\n  <shell>bash</shell>\n  <current_date>2026-11-08</current_date>\n</environment_context>";
const ROUTING_START: &str = "\nInstafy routing preflight.\nDecide only how the latest user request should enter the runtime.\nRoutes:\n- `direct`: a normal turn.\n- `browser`: Instafy's browser.\n\nLatest user request:\n";

/// A chat's thread, as Codex names its items, and the person's words.
struct Chat {
    thread: &'static str,
    turn: &'static str,
    made_at: f64,
    words: &'static str,
}

const MUSEUM: Chat = Chat {
    thread: "019a5d3e-8977-7e02-a9d0-a72dcaa648c1",
    turn: "019a5d3e-89c4-70d1-9e69-5a600dcb8727",
    made_at: 1_794_125_957.600_234,
    words: "What time does the museum open on Sunday?",
};

const TRAIN: Chat = Chat {
    thread: "019a5d44-0687-7a83-be86-36fa0fb20a3b",
    turn: "019a5d44-06a1-7c22-8d14-0b9e2f6c4d10",
    made_at: 1_794_126_381.118_02,
    words: "Find a train from the airport to the old town.",
};

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
        // The tests in this file run one at a time (`serial`) and own these fixtures meanwhile.
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

#[derive(Clone, Default)]
struct Upstream {
    /// Each request's body, byte for byte as it arrived.
    bodies: Arc<Mutex<Vec<Bytes>>>,
    /// Whether it refuses every request, as an upstream refuses one it can't take.
    refuses: Arc<AtomicBool>,
}

impl Upstream {
    fn take(&self) -> Vec<Bytes> {
        std::mem::take(&mut *self.bodies.lock().unwrap())
    }
}

async fn upstream(
    State(state): State<Upstream>,
    OriginalUri(uri): OriginalUri,
    body: Bytes,
) -> Response {
    state.bodies.lock().unwrap().push(body.clone());
    let payload: Value = serde_json::from_slice(&body).unwrap_or_default();
    if state.refuses.load(Ordering::SeqCst) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {
                "type": "invalid_request_error",
                "code": "invalid_value",
                "param": "input[1]",
                "message": "Invalid value: 'input[1]'."
            }})),
        )
            .into_response();
    }
    let response = json!({
        "id": "resp_test", "object": "response", "model": payload["model"], "status": "completed",
        "output": [{"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "{\"route\":\"browser\"}"}]}]
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

/// The loopback upstream, and the environment the proxy reads, for one test.
async fn start_upstream() -> Result<(Upstream, SocketAddr, TaskGuard, Vec<EnvGuard>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let env = vec![
        EnvGuard::set(
            "CODEX_PROXY_CHATGPT_ENDPOINT",
            &format!("http://{addr}/backend-api/codex/responses"),
        ),
        EnvGuard::set("PROXY_CONTROLLER_BASE_URL", ""),
        EnvGuard::set("CONTROLLER_BASE_URL", ""),
        EnvGuard::set("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        EnvGuard::set("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
    ];
    let state = Upstream::default();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .route("/backend-api/codex/responses", post(upstream))
        // A Gemini Code Assist upstream's `/v1internal:generateContent`.
        .fallback(upstream)
        .with_state(state.clone());
    let task = TaskGuard(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    Ok((state, addr, task, env))
}

fn api_key(upstream: SocketAddr) -> Credentials {
    Credentials::ApiKey {
        key: "fixture-api-key".into(),
        endpoint: Some(format!("http://{upstream}/v1/responses")),
        default_model: None,
    }
}

fn gemini_code_assist(upstream: SocketAddr) -> Credentials {
    Credentials::GeminiCodeAssist {
        access_token: "fixture-access-token".into(),
        project_id: "fixture-project".into(),
        endpoint: Some(format!("http://{upstream}/v1internal:generateContent")),
        default_model: None,
    }
}

fn chatgpt_login() -> Credentials {
    Credentials::ChatGpt {
        access_token: "fixture-access-token".into(),
        refresh_token: None,
        account_id: None,
        default_model: None,
        auth_path: None,
    }
}

/// A message as Codex sends it in a thread: its own id, and the turn and the time it was made in
/// beside what it holds and where that came from.
fn message(chat: &Chat, n: u32, role: &str, texts: &[&str], kinds: &[&str], from: Value) -> Value {
    json!({
        "type": "message",
        "id": format!("msg_{}-{n}", chat.thread),
        "role": role,
        "content": texts.iter().map(|text| json!({"type": "input_text", "text": text})).collect::<Vec<_>>(),
        "internal_chat_message_metadata_passthrough": {
            "turn_id": chat.turn,
            "create_time": chat.made_at + f64::from(n) / 1_000_000.0,
            "content_item_kinds": kinds,
            "content_item_metadata": kinds.iter().map(|_| json!({"provenance": from})).collect::<Vec<_>>()
        }
    })
}

/// What a thread of a Responses Lite model opens with: its tool list, its instructions and its
/// space's folder.
fn opening(chat: &Chat) -> Vec<Value> {
    let harness = json!({"type": "harness", "hook": false});
    vec![
        json!({
            "type": "additional_tools",
            "id": format!("at_{}-1", chat.thread),
            "role": "developer",
            "tools": [{"type": "namespace", "name": "functions", "description": "",
                "tools": [{"type": "custom", "name": "exec", "description": "Run JavaScript."}]}]
        }),
        message(
            chat,
            2,
            "developer",
            &[BASE],
            &["model.base_instructions"],
            harness.clone(),
        ),
        message(
            chat,
            3,
            "developer",
            &[PERMISSIONS, RUN],
            &[
                "permissions.instructions",
                "instafy_run_instructions.instructions",
            ],
            harness.clone(),
        ),
        message(
            chat,
            4,
            "user",
            &[ENVIRONMENT],
            &["environments.environment_context"],
            harness,
        ),
    ]
}

fn request(input: Vec<Value>, key: &str) -> Value {
    json!({
        "model": "gpt-6-luna",
        "input": input,
        "tool_choice": "auto",
        "parallel_tool_calls": false,
        "reasoning": {"effort": "low", "context": "all_turns"},
        "store": false,
        "stream": false,
        "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": key,
        "text": {"format": {"type": "json_schema", "name": "routing", "strict": true,
            "schema": {"type": "object", "properties": {"route": {"type": "string"}},
                "required": ["route"], "additionalProperties": false}}}
    })
}

/// A chat's routing step: a new thread whose prompt is the routing instructions and then the
/// person's words, under the key every routing step shares.
fn routing_step(chat: &Chat) -> Value {
    let mut input = opening(chat);
    let prompt = format!("{ROUTING_START}{}", chat.words);
    input.push(message(
        chat,
        5,
        "user",
        &[&prompt],
        &["user.text"],
        json!({"type": "user"}),
    ));
    request(input, SHARED_START_KEY)
}

/// The same request after the model called a tool: the call and its output come after the
/// prompt and name each other by `call_id`.
fn routing_step_after_a_tool_call(chat: &Chat) -> Value {
    let mut step = routing_step(chat);
    let input = step["input"].as_array_mut().unwrap();
    input.push(json!({
        "type": "custom_tool_call", "id": format!("ctc_{}-6", chat.thread), "status": "completed",
        "call_id": "call_1", "name": "exec", "input": "text('ok');",
        "internal_chat_message_metadata_passthrough": {"turn_id": chat.turn}
    }));
    input.push(json!({
        "type": "custom_tool_call_output", "id": format!("ctco_{}-7", chat.thread),
        "call_id": "call_1", "output": "ok",
        "internal_chat_message_metadata_passthrough": {"turn_id": chat.turn, "create_time": chat.made_at + 1.0}
    }));
    step
}

/// A building turn: the same thread start and the person's words, under its own thread's key.
fn building_turn(chat: &Chat) -> Value {
    let mut input = opening(chat);
    input.push(message(
        chat,
        5,
        "user",
        &[chat.words],
        &["user.text"],
        json!({"type": "user"}),
    ));
    request(input, chat.thread)
}

async fn send(addr: SocketAddr, chat: &Chat, body: &Value) -> Result<reqwest::Response> {
    Ok(reqwest::Client::new()
        .post(format!("http://{addr}/v1/responses"))
        .header("session-id", chat.thread)
        .header("thread-id", chat.thread)
        .json(body)
        .timeout(Duration::from_secs(5))
        .send()
        .await?)
}

fn parsed(body: &Bytes) -> Value {
    serde_json::from_slice(body).expect("the proxy sends JSON upstream")
}

/// The items Codex sent that the proxy forwards in their place: all but the developer messages
/// that open the thread, which it joins into the message it puts first.
fn forwarded_as_sent(sent: &Value) -> Vec<Value> {
    sent["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| !(item["type"] == "message" && item["role"] == "developer"))
        .cloned()
        .collect()
}

#[tokio::test]
#[serial]
async fn every_chats_routing_step_reaches_the_upstream_alike_up_to_the_persons_words() -> Result<()>
{
    let (state, upstream_addr, _upstream, _env) = start_upstream().await?;
    let mut tool_list_ids = Vec::new();
    for (name, credentials) in [
        ("an API key", api_key(upstream_addr)),
        ("a ChatGPT login", chatgpt_login()),
    ] {
        let (addr, _proxy) = spawn_proxy(credentials).await?;
        for chat in [&MUSEUM, &TRAIN] {
            let response = send(addr, chat, &routing_step(chat)).await?;
            ensure!(
                response.status().is_success(),
                "{name}: {}",
                response.text().await?
            );
        }
        let bodies = state.take();
        ensure!(
            bodies.len() == 2,
            "{name}: the upstream got {} requests",
            bodies.len()
        );
        let museum = std::str::from_utf8(&bodies[0])?;
        let train = std::str::from_utf8(&bodies[1])?;
        let museum_words = museum.find(MUSEUM.words).context("the museum's words")?;
        let train_words = train.find(TRAIN.words).context("the train's words")?;
        ensure!(
            museum[..museum_words] == train[..train_words],
            "{name}: the two chats' routing steps differ ahead of the person's words:\n{museum}\n{train}"
        );
        ensure!(
            museum.replacen(MUSEUM.words, TRAIN.words, 1) == train,
            "{name}: the two chats' routing steps differ in more than the person's words:\n{museum}\n{train}"
        );

        // Only what names the thread changes: the tool list keeps an id of the form Codex
        // gives it, the same in both chats, and the messages go without theirs. What each item
        // holds, and what the model reads of where it came from, go as they came.
        let forwarded = parsed(&bodies[0]);
        let input = forwarded["input"]
            .as_array()
            .context("the forwarded input")?;
        let tool_list_id = input[1]["id"].as_str().context("the tool list's id")?;
        ensure!(
            tool_list_id.starts_with("at_")
                && uuid::Uuid::parse_str(&tool_list_id[3..]).is_ok()
                && [&MUSEUM, &TRAIN]
                    .iter()
                    .all(|chat| !tool_list_id.contains(chat.thread)),
            "{name}: the tool list went upstream with the id {tool_list_id}"
        );
        tool_list_ids.push(tool_list_id.to_owned());
        let expected: Vec<Value> = forwarded_as_sent(&routing_step(&MUSEUM))
            .into_iter()
            .map(|mut item| {
                let item = item.as_object_mut().unwrap();
                if item["type"] == "additional_tools" {
                    item.insert("id".into(), json!(tool_list_id));
                } else {
                    item.remove("id");
                }
                if let Some(metadata) = item
                    .get_mut("internal_chat_message_metadata_passthrough")
                    .and_then(Value::as_object_mut)
                {
                    metadata.remove("turn_id");
                    metadata.remove("create_time");
                }
                Value::Object(item.clone())
            })
            .collect();
        ensure!(
            input[1..] == expected[..],
            "{name}: the opening items went upstream as {input:#?}"
        );
        ensure!(
            input[0]["role"] == "user" && input[0].get("id").is_none(),
            "{name}: the proxy's own first message is not first: {:#}",
            input[0]
        );
        ensure!(
            forwarded["prompt_cache_key"] != SHARED_START_KEY
                && forwarded["prompt_cache_key"] == parsed(&bodies[1])["prompt_cache_key"],
            "{name}: the routing steps' upstream keys are {} and {}",
            forwarded["prompt_cache_key"],
            parsed(&bodies[1])["prompt_cache_key"]
        );
    }
    // Each credential's (and so each space's) starts stay apart, as their keys do.
    ensure!(
        tool_list_ids[0] != tool_list_ids[1],
        "an API key and a ChatGPT login share the tool list's id {}",
        tool_list_ids[0]
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn what_the_model_wrote_and_a_tool_returned_goes_upstream_as_it_came() -> Result<()> {
    let (state, upstream_addr, _upstream, _env) = start_upstream().await?;
    let (addr, _proxy) = spawn_proxy(api_key(upstream_addr)).await?;
    let sent = routing_step_after_a_tool_call(&MUSEUM);
    let response = send(addr, &MUSEUM, &sent).await?;
    ensure!(response.status().is_success(), "{}", response.text().await?);
    let forwarded = parsed(&state.take()[0]);
    let input = forwarded["input"]
        .as_array()
        .context("the forwarded input")?;
    let sent_input = sent["input"].as_array().unwrap();
    let later = &sent_input[sent_input.len() - 2..];
    ensure!(
        input[input.len() - 2..] == *later,
        "the tool call and its output did not go as they came: {input:#?}"
    );
    ensure!(
        input[..input.len() - 2].iter().all(|item| {
            let id = item["id"].as_str().unwrap_or_default();
            (item["type"] == "additional_tools" || item.get("id").is_none())
                && !id.contains(MUSEUM.thread)
                && item["internal_chat_message_metadata_passthrough"]
                    .get("turn_id")
                    .is_none()
        }),
        "an opening item kept what names its thread: {input:#?}"
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_turn_under_its_own_threads_key_goes_upstream_as_it_came() -> Result<()> {
    let (state, upstream_addr, _upstream, _env) = start_upstream().await?;
    for (name, credentials) in [
        ("an API key", api_key(upstream_addr)),
        ("a ChatGPT login", chatgpt_login()),
    ] {
        let (addr, _proxy) = spawn_proxy(credentials).await?;
        let sent = building_turn(&MUSEUM);
        let response = send(addr, &MUSEUM, &sent).await?;
        ensure!(
            response.status().is_success(),
            "{name}: {}",
            response.text().await?
        );
        let forwarded = parsed(&state.take()[0]);
        let input = forwarded["input"]
            .as_array()
            .context("the forwarded input")?;
        ensure!(
            input[1..] == forwarded_as_sent(&sent)[..],
            "{name}: a building turn's items did not go as they came: {input:#?}"
        );
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_refused_routing_step_goes_upstream_once() -> Result<()> {
    let (state, upstream_addr, _upstream, _env) = start_upstream().await?;
    state.refuses.store(true, Ordering::SeqCst);
    for (name, credentials) in [
        ("an API key", api_key(upstream_addr)),
        (
            "a Gemini Code Assist login",
            gemini_code_assist(upstream_addr),
        ),
    ] {
        let (addr, _proxy) = spawn_proxy(credentials).await?;
        let response = send(addr, &MUSEUM, &routing_step(&MUSEUM)).await?;
        ensure!(
            !response.status().is_success(),
            "{name}: a refused routing step answered {}",
            response.status()
        );
        let sent = state.take().len();
        ensure!(sent == 1, "{name}: the upstream got {sent} requests");
    }
    Ok(())
}
