//! Offline contract tests for the shapes a streaming Responses client gets when the upstream cuts
//! a response short or rate limits it. Every credential is inert and every upstream is loopback.
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use anyhow::Result;
use axum::{
    Router,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use openai_proxy_server::{auth::Credentials, proxy::run_proxy_with_shutdown};
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;

struct EnvGuard(Vec<(String, Option<String>)>);
impl EnvGuard {
    fn isolated() -> Self {
        let mut guard = Self(Vec::new());
        for key in [
            "PROXY_CONTROLLER_BASE_URL",
            "CONTROLLER_BASE_URL",
            "PROXY_REQUIRE_CONTROLLER_AUTH",
            "PROXY_REQUIRE_CREDENTIAL_CLAIM",
            "CODEX_DEBUG_HTTP",
            "PROXY_DEBUG_STREAM",
        ] {
            guard.set(key, "");
        }
        guard
    }
    fn set(&mut self, key: &str, value: &str) {
        self.0.push((key.into(), std::env::var(key).ok()));
        unsafe {
            std::env::set_var(key, value);
        }
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.0.iter().rev() {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone)]
struct Reply {
    status: StatusCode,
    body: String,
    headers: Vec<(&'static str, String)>,
}
impl Reply {
    fn ok(body: String) -> Self {
        Self {
            status: StatusCode::OK,
            body,
            headers: Vec::new(),
        }
    }
}
#[derive(Clone)]
struct Mock {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    calls: Arc<AtomicUsize>,
}
async fn upstream(State(mock): State<Mock>) -> axum::response::Response {
    mock.calls.fetch_add(1, Ordering::SeqCst);
    let reply = mock
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected additional upstream attempt");
    let mut response = (reply.status, reply.body).into_response();
    for (name, value) in reply.headers {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}
async fn mock_server(replies: Vec<Reply>) -> Result<(String, Mock, Server)> {
    let mock = Mock {
        replies: Arc::new(Mutex::new(replies.into())),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/v1/responses", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(mock.clone());
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    Ok((endpoint, mock, server))
}
async fn proxy(credentials: Credentials) -> Result<(SocketAddr, Server)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    drop(listener);
    let server = Server(tokio::spawn(async move {
        run_proxy_with_shutdown(addr, Some(credentials), std::future::pending::<()>())
            .await
            .unwrap();
    }));
    for _ in 0..100 {
        if reqwest::get(format!("http://{addr}/healthz")).await.is_ok() {
            return Ok((addr, server));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("local proxy did not start")
}
fn api_credentials(endpoint: String) -> Credentials {
    Credentials::ApiKey {
        key: "inert-fixture-key".into(),
        endpoint: Some(endpoint),
        default_model: None,
    }
}
fn chatgpt_credentials() -> Credentials {
    Credentials::ChatGpt {
        access_token: "inert-access".into(),
        refresh_token: None,
        account_id: None,
        default_model: None,
        auth_path: None,
    }
}

/// Serves `replies` to the proxy on `lane`, one per upstream request, and returns the proxy's
/// address with the upstream mock. The ChatGPT lane streams from the upstream; the API-key lane
/// gets one JSON body.
async fn lane_proxy(
    env: &mut EnvGuard,
    lane: Lane,
    replies: Vec<Reply>,
) -> Result<(SocketAddr, Mock, Server, Server)> {
    let (endpoint, mock, upstream) = mock_server(replies).await?;
    let credentials = match lane {
        Lane::ChatGpt => {
            env.set("CODEX_PROXY_CHATGPT_ENDPOINT", &endpoint);
            chatgpt_credentials()
        }
        Lane::ApiKey => api_credentials(endpoint),
    };
    let (addr, proxy) = proxy(credentials).await?;
    Ok((addr, mock, upstream, proxy))
}

#[derive(Clone, Copy, Debug)]
enum Lane {
    ChatGpt,
    ApiKey,
}

async fn send(addr: SocketAddr, route: &str, body: Value) -> Result<reqwest::Response> {
    Ok(reqwest::Client::new()
        .post(format!("http://{addr}{route}"))
        .json(&body)
        .send()
        .await?)
}

async fn stream_request(addr: SocketAddr) -> Result<reqwest::Response> {
    send(
        addr,
        "/v1/responses",
        json!({"model": "gpt-6-luna", "input": "local test", "stream": true}),
    )
    .await
}

/// The events of a proxy stream, which must end with `[DONE]` after its last event.
async fn stream_events(response: reqwest::Response) -> Result<Vec<Value>> {
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()?
            .starts_with("text/event-stream")
    );
    assert!(response.headers().get(header::RETRY_AFTER).is_none());
    let body = response.text().await?;
    let data = body
        .split("\n\n")
        .filter_map(|block| block.trim().strip_prefix("data:"))
        .map(str::trim)
        .collect::<Vec<_>>();
    assert_eq!(data.last(), Some(&"[DONE]"), "{body}");
    Ok(data[..data.len() - 1]
        .iter()
        .map(|event| serde_json::from_str(event).expect("a JSON event"))
        .collect())
}

fn usage() -> Value {
    json!({"input_tokens": 40, "output_tokens": 128, "total_tokens": 168,
        "input_tokens_details": {"cached_tokens": 8},
        "output_tokens_details": {"reasoning_tokens": 100}})
}

fn function_call(call_id: &str, status: &str, arguments: &str) -> Value {
    json!({"type": "function_call", "id": format!("fc-{call_id}"), "call_id": call_id,
        "name": "exec_command", "arguments": arguments, "status": status})
}

fn finished_call() -> Value {
    function_call("call-finished", "completed", "{\"cmd\":\"pwd\"}")
}

/// A ChatGPT stream of `events`, stopped with `response.incomplete` for `reason`.
fn chatgpt_incomplete(events: Vec<Value>, reason: Option<&str>) -> String {
    let terminal = json!({"type": "response.incomplete", "response": {
        "id": "resp-cut", "object": "response", "model": "gpt-6-luna", "status": "incomplete",
        "incomplete_details": reason.map(|reason| json!({"reason": reason})),
        "output": [], "usage": usage()}});
    std::iter::once(
        json!({"type": "response.created", "response": {"id": "resp-cut",
        "object": "response", "model": "gpt-6-luna", "status": "in_progress", "output": []}}),
    )
    .chain(events)
    .chain(std::iter::once(terminal))
    .map(|event| format!("data: {event}\n\n"))
    .chain(std::iter::once("data: [DONE]\n\n".to_string()))
    .collect()
}

/// A finished reasoning item, then an answer the stop cut off, which the upstream finalizes as
/// incomplete.
fn reasoning_then_cut_off_answer() -> Vec<Value> {
    let answer = |status: &str, text: &str| {
        json!({"type": "message", "id": "msg-cut", "role": "assistant", "status": status,
            "content": [{"type": "output_text", "text": text, "annotations": []}]})
    };
    vec![
        json!({"type": "response.output_item.done", "output_index": 0, "item": {
            "type": "reasoning", "id": "rs-1", "summary": [],
            "encrypted_content": "b3BhcXVl"}}),
        json!({"type": "response.output_item.added", "output_index": 1,
            "item": answer("in_progress", "A partial")}),
        json!({"type": "response.output_text.delta", "output_index": 1, "delta": " answer"}),
        json!({"type": "response.output_item.done", "output_index": 1,
            "item": answer("incomplete", "A partial answer")}),
    ]
}

/// A finished call, then a second call the stop cut off, which the upstream finalizes as
/// incomplete with truncated arguments.
fn finished_call_then_cut_off_call() -> Vec<Value> {
    vec![
        json!({"type": "response.output_item.done", "output_index": 0, "item": finished_call()}),
        json!({"type": "response.output_item.added", "output_index": 1,
            "item": function_call("call-cut-off", "in_progress", "")}),
        json!({"type": "response.output_item.done", "output_index": 1,
            "item": function_call("call-cut-off", "incomplete", "{\"cmd\":\"rm")}),
    ]
}

/// The two events a streaming client gets for a cut-short response with no finished tool call:
/// a terminal `invalid_prompt` failure with codex's own message, keeping the upstream usage.
fn failed_events(id: &str, reason: &str) -> Vec<Value> {
    let response = json!({"id": id, "object": "response", "model": "gpt-6-luna",
        "output": [], "usage": usage()});
    let mut created = response.clone();
    created["status"] = json!("in_progress");
    let mut failed = response;
    failed["status"] = json!("failed");
    failed["error"] = json!({"code": "invalid_prompt",
        "message": format!("Incomplete response returned, reason: {reason}")});
    vec![
        json!({"type": "response.created", "response": created}),
        json!({"type": "response.failed", "response": failed}),
    ]
}

/// The events a streaming client gets for a cut-short response whose finished items include a
/// tool call: a completed response with only those items and the upstream usage.
fn completed_events(id: &str, items: Vec<Value>) -> Vec<Value> {
    let response = json!({"id": id, "object": "response", "model": "gpt-6-luna",
        "output": items.clone(), "usage": usage()});
    let mut created = response.clone();
    created["status"] = json!("in_progress");
    let mut completed = response;
    completed["status"] = json!("completed");
    let mut events = vec![json!({"type": "response.created", "response": created})];
    for item in items {
        events.push(json!({"type": "response.output_item.added", "item": item}));
        events.push(json!({"type": "response.output_item.done", "item": item}));
    }
    events.push(json!({"type": "response.completed", "response": completed}));
    events
}

#[tokio::test]
#[serial]
async fn chatgpt_cut_short_answer_streams_a_terminal_failure_with_its_reason() -> Result<()> {
    for (reason, expected) in [
        (Some("max_output_tokens"), "max_output_tokens"),
        (Some("content_filter"), "content_filter"),
        (None, "unknown"),
    ] {
        let mut env = EnvGuard::isolated();
        let upstream = chatgpt_incomplete(reasoning_then_cut_off_answer(), reason);
        let (addr, mock, _upstream, _proxy) =
            lane_proxy(&mut env, Lane::ChatGpt, vec![Reply::ok(upstream)]).await?;
        let events = stream_events(stream_request(addr).await?).await?;
        assert_eq!(events, failed_events("resp-cut", expected), "{reason:?}");
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn chatgpt_cut_short_after_a_finished_call_streams_only_that_call_as_completed() -> Result<()>
{
    let mut env = EnvGuard::isolated();
    let upstream = chatgpt_incomplete(finished_call_then_cut_off_call(), Some("max_output_tokens"));
    let (addr, mock, _upstream, _proxy) =
        lane_proxy(&mut env, Lane::ChatGpt, vec![Reply::ok(upstream)]).await?;
    let events = stream_events(stream_request(addr).await?).await?;
    assert_eq!(events, completed_events("resp-cut", vec![finished_call()]));
    assert!(!json!(events).to_string().contains("call-cut-off"));
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    Ok(())
}

/// An API key's Responses upstream answers with one JSON body, `status: "incomplete"`.
fn api_incomplete(reason: &str, output: Vec<Value>) -> String {
    json!({"id": "resp-api-cut", "object": "response", "model": "gpt-6-luna",
        "status": "incomplete", "incomplete_details": {"reason": reason},
        "output": output, "usage": usage()})
    .to_string()
}

#[tokio::test]
#[serial]
async fn api_key_cut_short_responses_get_the_same_treatment() -> Result<()> {
    let reasoning = json!({"type": "reasoning", "id": "rs-1", "summary": []});
    let partial = json!({"type": "message", "id": "msg-cut", "role": "assistant",
        "status": "incomplete", "content": [{"type": "output_text", "text": "A partial"}]});
    let custom = json!({"type": "custom_tool_call", "id": "ctc-1", "call_id": "call-custom",
        "name": "exec", "input": "text('ok')", "status": "completed"});
    let cut_off = function_call("call-cut-off", "incomplete", "{\"cmd\":\"rm");
    for (upstream, expected) in [
        (
            api_incomplete("content_filter", vec![reasoning.clone(), partial.clone()]),
            failed_events("resp-api-cut", "content_filter"),
        ),
        (
            api_incomplete(
                "max_output_tokens",
                vec![reasoning.clone(), custom.clone(), cut_off, partial],
            ),
            completed_events("resp-api-cut", vec![reasoning, custom]),
        ),
    ] {
        let mut env = EnvGuard::isolated();
        let (addr, mock, _upstream, _proxy) =
            lane_proxy(&mut env, Lane::ApiKey, vec![Reply::ok(upstream)]).await?;
        let events = stream_events(stream_request(addr).await?).await?;
        assert_eq!(events, expected);
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn non_streaming_requests_get_the_cut_short_response_as_the_upstream_reported_it()
-> Result<()> {
    // The Responses route returns the response with `status: "incomplete"` and its
    // `incomplete_details`, as the API does without a stream.
    let partial = json!({"type": "message", "id": "msg-cut", "role": "assistant",
        "status": "incomplete", "content": [{"type": "output_text", "text": "A partial"}]});
    let upstream = api_incomplete("max_output_tokens", vec![partial]);
    let mut env = EnvGuard::isolated();
    let (addr, _mock, _upstream, _proxy) =
        lane_proxy(&mut env, Lane::ApiKey, vec![Reply::ok(upstream.clone())]).await?;
    let body = json!({"model": "gpt-6-luna", "input": "local test", "stream": false});
    let response = send(addr, "/v1/responses", body).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await?,
        serde_json::from_str::<Value>(&upstream)?
    );
    drop(env);

    // A ChatGPT login's stream now ends in a response rather than a stream error, with the items
    // the stream finished.
    let mut env = EnvGuard::isolated();
    let upstream = chatgpt_incomplete(finished_call_then_cut_off_call(), Some("max_output_tokens"));
    let (addr, _mock, _upstream, _proxy) =
        lane_proxy(&mut env, Lane::ChatGpt, vec![Reply::ok(upstream)]).await?;
    let body = json!({"model": "gpt-6-luna", "input": "local test", "stream": false});
    let response = send(addr, "/v1/responses", body).await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await?,
        json!({"id": "resp-cut", "object": "response", "model": "gpt-6-luna",
        "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
        "usage": usage(),
        "output": [
            finished_call(),
            function_call("call-cut-off", "incomplete", "{\"cmd\":\"rm"),
        ]})
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn chat_completions_says_why_a_cut_short_answer_stopped() -> Result<()> {
    let partial = json!({"type": "message", "id": "msg-cut", "role": "assistant",
        "status": "incomplete", "content": [{"type": "output_text", "text": "A partial"}]});
    let completed = json!({"id": "resp-done", "object": "response", "model": "gpt-6-luna",
        "status": "completed", "usage": usage(), "output": [{"type": "message",
            "role": "assistant", "content": [{"type": "output_text", "text": "Done."}]}]})
    .to_string();
    for (upstream, content, finish_reason) in [
        (
            api_incomplete("max_output_tokens", vec![partial.clone()]),
            "A partial",
            "length",
        ),
        (
            api_incomplete("content_filter", vec![partial.clone()]),
            "A partial",
            "content_filter",
        ),
        (
            api_incomplete("interrupted", vec![partial]),
            "A partial",
            "length",
        ),
        (completed, "Done.", "stop"),
    ] {
        let mut env = EnvGuard::isolated();
        let (addr, _mock, _upstream, _proxy) =
            lane_proxy(&mut env, Lane::ApiKey, vec![Reply::ok(upstream)]).await?;
        let body = json!({"model": "gpt-6-luna", "stream": false,
            "messages": [{"role": "user", "content": "local test"}]});
        let response = send(addr, "/v1/chat/completions", body).await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await?;
        assert_eq!(body["choices"][0]["message"]["content"], content);
        assert_eq!(body["choices"][0]["finish_reason"], finish_reason);
    }
    Ok(())
}

/// The seconds a streamed rate limit's message asks the client to wait.
fn stated_wait(event: &Value) -> f64 {
    assert_eq!(event["type"], "response.failed");
    assert_eq!(
        event["response"].as_object().map(|response| response.len()),
        Some(2),
        "{event}"
    );
    assert_eq!(event["response"]["status"], "failed");
    let error = &event["response"]["error"];
    assert_eq!(
        error.as_object().map(|error| error.len()),
        Some(2),
        "{event}"
    );
    assert_eq!(error["code"], "rate_limit_exceeded");
    let message = error["message"].as_str().expect("a message");
    message
        .strip_prefix(
            "The upstream provider rate limit was reached (upstream_rate_limit, 429). \
             Please try again in ",
        )
        .and_then(|rest| rest.strip_suffix("s."))
        .and_then(|seconds| seconds.parse().ok())
        .unwrap_or_else(|| panic!("unexpected message: {message}"))
}

fn rate_limited(headers: Vec<(&'static str, &str)>) -> Reply {
    Reply {
        status: StatusCode::TOO_MANY_REQUESTS,
        body: json!({"error": {"message": "private-token", "type": "requests"}}).to_string(),
        headers: headers
            .into_iter()
            .map(|(name, value)| (name, value.to_string()))
            .collect(),
    }
}

#[tokio::test]
#[serial]
async fn streaming_transient_rate_limit_is_a_rate_limit_exceeded_stream_failure() -> Result<()> {
    for (lane, reply, low, high) in [
        (
            Lane::ApiKey,
            rate_limited(vec![("retry-after", "7")]),
            7.0,
            8.4,
        ),
        (Lane::ApiKey, rate_limited(Vec::new()), 5.0, 6.0),
        (
            Lane::ApiKey,
            rate_limited(vec![("x-ratelimit-reset-tokens", "6s")]),
            6.0,
            7.2,
        ),
        (
            Lane::ApiKey,
            rate_limited(vec![("retry-after", "0")]),
            1.0,
            1.2,
        ),
        (
            Lane::ApiKey,
            rate_limited(vec![("retry-after", "120")]),
            24.0,
            30.0,
        ),
        (
            Lane::ChatGpt,
            rate_limited(vec![("retry-after", "7")]),
            7.0,
            8.4,
        ),
        // A rate limit the backend reports inside its stream carries no headers.
        (
            Lane::ChatGpt,
            Reply::ok(format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"type": "response.failed", "response": {"error": {
                    "code": "rate_limit_exceeded", "message": "private-token"}}})
            )),
            5.0,
            6.0,
        ),
    ] {
        let mut env = EnvGuard::isolated();
        let (addr, mock, _upstream, _proxy) =
            lane_proxy(&mut env, lane, vec![reply.clone(), reply]).await?;
        let events = stream_events(stream_request(addr).await?).await?;
        assert_eq!(events.len(), 1, "{lane:?}: {events:?}");
        let wait = stated_wait(&events[0]);
        assert!((low..=high).contains(&wait), "{lane:?}: {wait}");
        assert!(!json!(events).to_string().contains("private-token"));
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);

        // A request that does not stream keeps the HTTP 429.
        let body = json!({"model": "gpt-6-luna", "input": "local test", "stream": false});
        let response = send(addr, "/v1/responses", body).await?;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().get(header::RETRY_AFTER).is_some());
        let body: Value = response.json().await?;
        assert_eq!(body["error"]["code"], "upstream_rate_limit");
        assert_eq!(body["error"]["retryable"], true);
        assert_eq!(mock.calls.load(Ordering::SeqCst), 2);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn streaming_plan_limits_and_long_rate_limit_windows_keep_their_http_errors() -> Result<()> {
    let mut plan_limit = rate_limited(vec![("retry-after", "7")]);
    plan_limit.body = json!({"error": {"type": "usage_limit_reached", "message": "private-token",
        "resets_at": 1_900_000_000}})
    .to_string();
    let mut quota = rate_limited(Vec::new());
    quota.body = json!({"error": {"code": "insufficient_quota"}}).to_string();
    let long_window = rate_limited(vec![
        ("x-ratelimit-remaining-tokens", "0"),
        ("x-ratelimit-reset-tokens", "13h20m0s"),
    ]);
    for (reply, status, error_type, code) in [
        (
            plan_limit,
            StatusCode::TOO_MANY_REQUESTS,
            "usage_limit_reached",
            "upstream_usage_limit_reached",
        ),
        (
            long_window,
            StatusCode::TOO_MANY_REQUESTS,
            "upstream_error",
            "upstream_rate_limit",
        ),
        (
            quota,
            StatusCode::PAYMENT_REQUIRED,
            "upstream_error",
            "upstream_insufficient_quota",
        ),
    ] {
        let mut env = EnvGuard::isolated();
        let (addr, mock, _upstream, _proxy) =
            lane_proxy(&mut env, Lane::ApiKey, vec![reply]).await?;
        let response = stream_request(addr).await?;
        assert_eq!(response.status(), status, "{code}");
        assert!(response.headers().get(header::RETRY_AFTER).is_none());
        let body: Value = response.json().await?;
        assert_eq!(body["error"]["type"], error_type);
        assert_eq!(body["error"]["code"], code);
        assert_eq!(body["error"]["retryable"], false);
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}
