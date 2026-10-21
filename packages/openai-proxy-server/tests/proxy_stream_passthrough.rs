//! Offline tests for a streaming `/v1/responses` request whose upstream streams: the proxy sends
//! each event on as it arrives instead of reading the whole response first. Every credential is
//! inert and every upstream is loopback.
use std::net::SocketAddr;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::stream;
use openai_proxy_server::{auth::Credentials, proxy::run_proxy_with_shutdown};
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;
use tokio::sync::Notify;

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
            "PROXY_STREAM_PASSTHROUGH",
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

/// One upstream answer: its events up to `gate`, then, once the test lets it go on, the rest.
/// The upstream ends the body after the last event; with `hang_up`, without a terminal event.
#[derive(Clone)]
struct Upstream {
    before_gate: Vec<Value>,
    after_gate: Vec<Value>,
    gate: Arc<Notify>,
    requests: Arc<Mutex<Vec<Value>>>,
    calls: Arc<AtomicUsize>,
}

fn sse(event: &Value) -> String {
    format!(
        "event: {}\ndata: {event}\n\n",
        event["type"].as_str().unwrap_or("message")
    )
}

async fn upstream(State(upstream): State<Upstream>, Json(body): Json<Value>) -> Response {
    upstream.calls.fetch_add(1, Ordering::SeqCst);
    upstream.requests.lock().unwrap().push(body);
    let first: String = upstream.before_gate.iter().map(sse).collect();
    let rest: String = upstream.after_gate.iter().map(sse).collect();
    let gate = upstream.gate.clone();
    let chunks = stream::unfold(0, move |step| {
        let (first, rest, gate) = (first.clone(), rest.clone(), gate.clone());
        async move {
            match step {
                0 => Some((Ok::<_, std::io::Error>(first), 1)),
                1 => {
                    gate.notified().await;
                    Some((Ok(rest), 2))
                }
                _ => None,
            }
        }
    });
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(chunks),
    )
        .into_response()
}

async fn upstream_server(upstream_state: Upstream) -> Result<(String, Server)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/v1/responses", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(upstream_state);
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    Ok((endpoint, server))
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

#[derive(Clone, Copy, Debug)]
enum Lane {
    /// A ChatGPT login, whose Codex endpoint always streams.
    ChatGpt,
    /// An API key on the OpenAI API, here at `CODEX_OPENAI_ENDPOINT`.
    OpenAiApiKey,
}

struct Fixture {
    addr: SocketAddr,
    upstream: Upstream,
    _servers: (Server, Server),
}

async fn fixture(
    env: &mut EnvGuard,
    lane: Lane,
    before_gate: Vec<Value>,
    after_gate: Vec<Value>,
) -> Result<Fixture> {
    let upstream = Upstream {
        before_gate,
        after_gate,
        gate: Arc::new(Notify::new()),
        requests: Arc::new(Mutex::new(Vec::new())),
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let (endpoint, upstream_server) = upstream_server(upstream.clone()).await?;
    let credentials = match lane {
        Lane::ChatGpt => {
            env.set("CODEX_PROXY_CHATGPT_ENDPOINT", &endpoint);
            Credentials::ChatGpt {
                access_token: "inert-access".into(),
                refresh_token: None,
                account_id: None,
                default_model: None,
                auth_path: None,
            }
        }
        Lane::OpenAiApiKey => {
            env.set("CODEX_OPENAI_ENDPOINT", &endpoint);
            Credentials::ApiKey {
                key: "inert-fixture-key".into(),
                endpoint: None,
                default_model: None,
            }
        }
    };
    let (addr, proxy_server) = proxy(credentials).await?;
    Ok(Fixture {
        addr,
        upstream,
        _servers: (upstream_server, proxy_server),
    })
}

/// Sends a streaming request. Its answer must begin within a few seconds, even while the
/// upstream waits for the test: a proxy that read the whole response first would answer only
/// once the upstream finished.
async fn stream_request(addr: SocketAddr) -> Result<reqwest::Response> {
    let request = reqwest::Client::new()
        .post(format!("http://{addr}/v1/responses"))
        .json(&json!({"model": "gpt-6-luna", "input": "local test", "stream": true}))
        .send();
    Ok(tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .context("the proxy held its answer back while the upstream was still writing")??)
}

/// Reads a proxy stream's events as they arrive.
struct ClientStream {
    response: reqwest::Response,
    buffer: String,
    events: Vec<Value>,
    done: bool,
}

impl ClientStream {
    fn new(response: reqwest::Response) -> Self {
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/event-stream")
        );
        Self {
            response,
            buffer: String::new(),
            events: Vec::new(),
            done: false,
        }
    }

    /// Reads until an event of `kind` arrived, within a few seconds.
    async fn until(&mut self, kind: &str) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.events.iter().any(|event| event["type"] == kind) {
                if !self.read_chunk().await? {
                    anyhow::bail!("the stream ended before {kind}: {:?}", self.events);
                }
            }
            Ok(())
        })
        .await
        .with_context(|| {
            format!(
                "no {kind} arrived while the upstream waited: {:?}",
                self.events
            )
        })?
    }

    /// Reads to the end of the stream.
    async fn rest(mut self) -> Result<(Vec<Value>, bool)> {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.read_chunk().await? {}
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("the stream did not end")??;
        Ok((self.events, self.done))
    }

    async fn read_chunk(&mut self) -> Result<bool> {
        let Some(chunk) = self.response.chunk().await? else {
            return Ok(false);
        };
        self.buffer.push_str(std::str::from_utf8(&chunk)?);
        while let Some(end) = self.buffer.find("\n\n") {
            let block: String = self.buffer.drain(..end + 2).collect();
            for line in block.lines() {
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        self.done = true;
                    } else {
                        self.events.push(serde_json::from_str(data)?);
                    }
                }
            }
        }
        Ok(true)
    }
}

fn usage() -> Value {
    json!({"input_tokens": 40, "output_tokens": 12, "total_tokens": 52})
}

fn created() -> Value {
    json!({"type": "response.created", "response": {"id": "resp-1", "object": "response",
        "model": "gpt-6-luna", "status": "in_progress", "output": []}})
}

fn answer(status: &str, text: &str) -> Value {
    json!({"type": "message", "id": "msg-1", "role": "assistant", "status": status,
        "content": [{"type": "output_text", "text": text, "annotations": []}]})
}

fn delta(text: &str) -> Value {
    json!({"type": "response.output_text.delta", "item_id": "msg-1", "output_index": 0,
        "content_index": 0, "delta": text})
}

fn completed(output: Vec<Value>) -> Value {
    json!({"type": "response.completed", "response": {"id": "resp-1", "object": "response",
        "model": "gpt-6-luna", "status": "completed", "output": output, "usage": usage()}})
}

/// An answer in two pieces, the second only once the test lets the upstream go on.
fn answer_in_two_pieces() -> (Vec<Value>, Vec<Value>) {
    (
        vec![
            created(),
            json!({"type": "response.output_item.added", "output_index": 0,
                "item": answer("in_progress", "")}),
            delta("Hello"),
        ],
        vec![
            delta(" world"),
            json!({"type": "response.output_item.done", "output_index": 0,
                "item": answer("completed", "Hello world")}),
            completed(vec![answer("completed", "Hello world")]),
        ],
    )
}

#[tokio::test]
#[serial]
async fn the_first_text_reaches_the_client_while_the_upstream_still_writes() -> Result<()> {
    for lane in [Lane::ChatGpt, Lane::OpenAiApiKey] {
        let mut env = EnvGuard::isolated();
        let (before, after) = answer_in_two_pieces();
        let fixture = fixture(&mut env, lane, before, after).await?;
        let mut client = ClientStream::new(stream_request(fixture.addr).await?);

        // The upstream sends the rest only after the client has the first piece.
        client.until("response.output_text.delta").await?;
        let deltas: Vec<_> = client
            .events
            .iter()
            .filter_map(|event| event["delta"].as_str())
            .collect();
        assert_eq!(deltas, ["Hello"], "{lane:?}");
        assert!(
            !client
                .events
                .iter()
                .any(|event| event["type"] == "response.completed"),
            "{lane:?}"
        );
        fixture.upstream.gate.notify_one();

        let (events, done) = client.rest().await?;
        assert!(done, "{lane:?}: a finished stream ends with [DONE]");
        let types: Vec<_> = events.iter().map(|event| event["type"].clone()).collect();
        assert_eq!(
            types,
            [
                "response.created",
                "response.output_item.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.output_item.done",
                "response.completed",
            ],
            "{lane:?}"
        );
        let last = events.last().unwrap();
        assert_eq!(last["response"]["usage"], usage(), "{lane:?}");
        assert_eq!(fixture.upstream.calls.load(Ordering::SeqCst), 1, "{lane:?}");
        // The API-key lane asks the OpenAI API for a stream; a ChatGPT login's always is one.
        let request = fixture.upstream.requests.lock().unwrap()[0].clone();
        assert_eq!(request["stream"], json!(true), "{lane:?}");
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn the_kill_switch_reads_the_whole_response_first_again() -> Result<()> {
    let mut env = EnvGuard::isolated();
    env.set("PROXY_STREAM_PASSTHROUGH", "0");
    let (mut before, after) = answer_in_two_pieces();
    before.extend(after);
    let fixture = fixture(&mut env, Lane::ChatGpt, before, Vec::new()).await?;
    fixture.upstream.gate.notify_one();
    let (events, done) = ClientStream::new(stream_request(fixture.addr).await?)
        .rest()
        .await?;
    assert!(done);
    // The buffered shape: the answer's text as one delta.
    let deltas: Vec<_> = events
        .iter()
        .filter_map(|event| event["delta"].as_str())
        .collect();
    assert_eq!(deltas, ["Hello world"]);
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_chatgpt_login_still_gets_no_reasoning_items() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let reasoning = json!({"type": "reasoning", "id": "rs-1", "summary": []});
    let events = vec![
        created(),
        json!({"type": "response.output_item.added", "output_index": 0, "item": reasoning}),
        json!({"type": "response.reasoning_summary_text.delta", "item_id": "rs-1",
            "output_index": 0, "delta": "Thinking"}),
        json!({"type": "response.output_item.done", "output_index": 0, "item": reasoning}),
        json!({"type": "response.output_item.added", "output_index": 1,
            "item": answer("in_progress", "")}),
        json!({"type": "response.output_text.delta", "item_id": "msg-1", "output_index": 1,
            "delta": "Hi"}),
        json!({"type": "response.output_item.done", "output_index": 1,
            "item": answer("completed", "Hi")}),
        completed(Vec::new()),
    ];
    let fixture = fixture(&mut env, Lane::ChatGpt, events, Vec::new()).await?;
    fixture.upstream.gate.notify_one();
    let (events, done) = ClientStream::new(stream_request(fixture.addr).await?)
        .rest()
        .await?;
    assert!(done);
    assert!(!json!(events).to_string().contains("rs-1"), "{events:?}");
    let finished: Vec<_> = events
        .iter()
        .filter(|event| event["type"] == "response.output_item.done")
        .map(|event| event["item"].clone())
        .collect();
    assert_eq!(finished, [answer("completed", "Hi")]);
    Ok(())
}

#[tokio::test]
#[serial]
async fn text_without_an_announced_answer_streams_inside_one_the_proxy_finishes() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let events = vec![
        created(),
        json!({"type": "response.output_text.delta", "delta": "Hello"}),
        json!({"type": "response.output_text.delta", "delta": " there"}),
        completed(Vec::new()),
    ];
    let fixture = fixture(&mut env, Lane::ChatGpt, events, Vec::new()).await?;
    fixture.upstream.gate.notify_one();
    let (events, done) = ClientStream::new(stream_request(fixture.addr).await?)
        .rest()
        .await?;
    assert!(done);
    let types: Vec<_> = events.iter().map(|event| event["type"].clone()).collect();
    assert_eq!(
        types,
        [
            "response.created",
            "response.output_item.added",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_item.done",
            "response.completed",
        ]
    );
    let announced = &events[1]["item"];
    let finished = &events[4]["item"];
    assert_eq!(announced["id"], finished["id"]);
    assert_eq!(finished["role"], "assistant");
    assert_eq!(finished["content"][0]["text"], "Hello there");
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_failure_after_output_goes_on_as_the_upstream_sent_it() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let failed = json!({"type": "response.failed", "response": {"id": "resp-1",
        "status": "failed", "error": {"code": "server_error", "message": "upstream broke"}}});
    let (before, _) = answer_in_two_pieces();
    let fixture = fixture(&mut env, Lane::ChatGpt, before, vec![failed.clone()]).await?;
    let mut client = ClientStream::new(stream_request(fixture.addr).await?);
    client.until("response.output_text.delta").await?;
    fixture.upstream.gate.notify_one();
    let (events, done) = client.rest().await?;
    assert!(done);
    assert_eq!(events.last(), Some(&failed));
    // Not sent again: the client already has output from this attempt.
    assert_eq!(fixture.upstream.calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_stream_that_breaks_off_after_output_ends_without_done() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let (before, _) = answer_in_two_pieces();
    let fixture = fixture(&mut env, Lane::ChatGpt, before, Vec::new()).await?;
    let mut client = ClientStream::new(stream_request(fixture.addr).await?);
    client.until("response.output_text.delta").await?;
    fixture.upstream.gate.notify_one();
    let (events, done) = client.rest().await?;
    assert!(!done, "a cut stream must not look finished: {events:?}");
    assert!(
        !events
            .iter()
            .any(|event| event["type"] == "response.completed")
    );
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_failure_before_any_output_is_still_the_requests_error() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let failed = json!({"type": "response.failed", "response": {"id": "resp-1",
        "status": "failed", "error": {"code": "insufficient_quota", "message": "quota"}}});
    let fixture = fixture(&mut env, Lane::ChatGpt, vec![created(), failed], Vec::new()).await?;
    let response = stream_request(fixture.addr).await?;
    // The same answer as when the proxy read the whole response: an error, not a stream that
    // started and failed.
    assert_ne!(response.status(), StatusCode::OK);
    let body = response.text().await?;
    assert!(
        body.contains("insufficient_quota") || body.contains("quota"),
        "{body}"
    );
    assert_eq!(fixture.upstream.calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
#[serial]
async fn a_cut_short_answer_that_already_went_out_gets_the_notice_after_it() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let call = |status: &str, arguments: &str| {
        json!({"type": "function_call", "id": "fc-cut", "call_id": "call-cut",
            "name": "exec_command", "arguments": arguments, "status": status})
    };
    let incomplete = json!({"type": "response.incomplete", "response": {"id": "resp-1",
        "object": "response", "model": "gpt-6-luna", "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"}, "output": [], "usage": usage()}});
    let events = vec![
        created(),
        json!({"type": "response.output_item.added", "output_index": 0,
            "item": answer("in_progress", "")}),
        delta("Here is the plan."),
        json!({"type": "response.output_item.done", "output_index": 0,
            "item": answer("completed", "Here is the plan.")}),
        json!({"type": "response.output_item.added", "output_index": 1,
            "item": call("in_progress", "")}),
        json!({"type": "response.output_item.done", "output_index": 1,
            "item": call("incomplete", "{\"cmd\":\"rm")}),
        incomplete,
    ];
    let fixture = fixture(&mut env, Lane::ChatGpt, events, Vec::new()).await?;
    fixture.upstream.gate.notify_one();
    let (events, done) = ClientStream::new(stream_request(fixture.addr).await?)
        .rest()
        .await?;
    assert!(done);
    let finished: Vec<_> = events
        .iter()
        .filter(|event| event["type"] == "response.output_item.done")
        .map(|event| event["item"].clone())
        .collect();
    let notice = json!({"type": "message", "id": "proxy-notice-resp-1", "role": "assistant",
        "status": "completed", "content": [{"type": "output_text",
            "text": "The response was cut off before it finished (reason: max_output_tokens).",
            "annotations": []}]});
    // The cut-off call never finishes, so it never runs; the notice follows the answer.
    assert_eq!(
        finished,
        [answer("completed", "Here is the plan."), notice.clone()]
    );
    let last = events.last().unwrap();
    assert_eq!(last["type"], "response.completed");
    assert_eq!(last["response"]["status"], "completed");
    assert_eq!(
        last["response"]["output"],
        json!([answer("completed", "Here is the plan."), notice])
    );
    assert_eq!(last["response"]["usage"], usage());
    assert_eq!(fixture.upstream.calls.load(Ordering::SeqCst), 1);
    Ok(())
}
