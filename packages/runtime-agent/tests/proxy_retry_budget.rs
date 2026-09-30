//! Local-only retry and turn-usage contract tests. Every embedded Codex run is in an env-cleared
//! child with an owned HOME and inert API credentials; no host auth is consulted.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use runtime_agent::codex::{CodexClient, CodexConfig, CodexRunOptions};
use runtime_agent::job_cancel::JobCancelSignal;
use serde_json::{Value, json};
use uuid::Uuid;

const CHILD_MARKER: &str = "INSTAFY_PROXY_RETRY_TEST_CHILD";
const API_KEY: &str = "inert-local-retry-test-key";
const FINAL_TEXT: &str = "LOCAL_RETRY_OK";
const STEP_TEXT: &str = "LOCAL_RETRY_STEP_DONE";
const FINISHED_CALL_ID: &str = "call-local-finished";
const PARTIAL_TEXT: &str = "LOCAL_CUT_SHORT_PARTIAL";
const TOOL_CMD: &str = "printf x >> tool-count.txt; printf TOOL_APPLIED";

struct MockState {
    scenario: String,
    request_ready: PathBuf,
    requests: Mutex<Vec<Value>>,
    errors: Mutex<Vec<String>>,
}

fn sse(item: Value) -> Response {
    sse_with_end_turn(item, None)
}

fn fixture_usage() -> Value {
    json!({"input_tokens":10,"output_tokens":5,"total_tokens":15,
        "input_tokens_details":{"cached_tokens":0},
        "output_tokens_details":{"reasoning_tokens":0}})
}

fn sse_with_end_turn(item: Value, end_turn: Option<bool>) -> Response {
    sse_with_usage(item, end_turn, Some(fixture_usage()))
}

fn sse_with_usage(item: Value, end_turn: Option<bool>, usage: Option<Value>) -> Response {
    sse_output(Some(item), end_turn, usage)
}

/// A completed response with at most one output item. Without one, the turn ends with no
/// assistant message at all.
fn sse_output(item: Option<Value>, end_turn: Option<bool>, usage: Option<Value>) -> Response {
    let response_id = format!("resp-{}", Uuid::new_v4());
    let item = item.map(|mut item| {
        item["id"] = json!(format!("item-{}", Uuid::new_v4()));
        if item.get("call_id").is_some() {
            item["call_id"] = json!(format!("call-{}", Uuid::new_v4()));
        }
        item
    });
    let mut response = json!({
        "id":response_id, "object":"response", "status":"completed",
        "model":"gpt-6-luna", "output":item.iter().collect::<Vec<_>>()
    });
    if let Some(usage) = usage {
        response["usage"] = usage;
    }
    if let Some(end_turn) = end_turn {
        response["end_turn"] = json!(end_turn);
    }
    let created = json!({"type":"response.created","response":{"id":response_id,"status":"in_progress","model":"gpt-6-luna","output":[]}});
    let done =
        item.map(|item| json!({"type":"response.output_item.done","output_index":0,"item":item}));
    let completed = json!({"type":"response.completed","response":response});
    let body = std::iter::once(created)
        .chain(done)
        .chain(std::iter::once(completed))
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    ([("content-type", "text/event-stream")], body).into_response()
}

/// The Instafy proxy's envelope for a retryable upstream rate limit. The proxy always sends a
/// Retry-After with it; one second keeps the scheduled retry short.
fn proxy_rate_limit() -> Response {
    let body = json!({"error":{"message":"The upstream provider rate limit was reached.",
        "type":"upstream_error", "code":"upstream_rate_limit", "retryable":true}});
    (
        StatusCode::TOO_MANY_REQUESTS,
        [("retry-after", "1")],
        Json(body),
    )
        .into_response()
}

/// What the proxy streams instead of that 429 when the request streams, as every codex request
/// does: one `response.failed` with code `rate_limit_exceeded` whose message names the wait.
/// The proxy never asks for less than a second, which keeps the scheduled retry short.
fn proxy_stream_rate_limit() -> Response {
    let failed = json!({"type":"response.failed","response":{"status":"failed","error":{
        "code":"rate_limit_exceeded",
        "message":"The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 1s."}}});
    sse_events(vec![failed])
}

/// The events of one proxy stream, which it ends with `[DONE]`.
fn sse_events(events: Vec<Value>) -> Response {
    let body = events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .chain(std::iter::once("data: [DONE]\n\n".to_string()))
        .collect::<String>();
    ([("content-type", "text/event-stream")], body).into_response()
}

/// The notice the proxy adds to a response the upstream stopped early, for `reason`, when no
/// tool call finished.
fn cut_short_notice(reason: &str) -> String {
    format!("The response was cut off before it finished (reason: {reason}).")
}

/// What the proxy streams for a response the upstream stopped early, for `reason`, with no
/// finished tool call: a completed response with the reasoning item the upstream finished and
/// the answer the stop cut off, with the text that arrived and then the proxy's notice of the
/// stop as a part of its own, keeping the upstream usage.
fn proxy_cut_short_with_notice(reason: &str) -> Response {
    proxy_cut_short_completed(
        &format!("resp-{}", Uuid::new_v4()),
        vec![
            json!({"type":"reasoning","id":"rs-local-cut","summary":[]}),
            json!({"type":"message","id":"msg-local-cut","role":"assistant",
                "status":"incomplete","phase":"final_answer",
                "content":[{"type":"output_text","text":PARTIAL_TEXT,"annotations":[]},
                    {"type":"output_text","text":format!("\n\n{}", cut_short_notice(reason)),
                        "annotations":[]}]}),
        ],
    )
}

/// What the proxy streams for a response the upstream stopped early: a completed response with
/// the items the proxy keeps, keeping the upstream usage. An item with text streams it as one
/// delta, its text parts joined by a line break.
fn proxy_cut_short_completed(response_id: &str, items: Vec<Value>) -> Response {
    let response = json!({"id":response_id, "object":"response",
        "model":"gpt-6-luna", "output":items.clone(), "usage":fixture_usage()});
    let mut created = response.clone();
    created["status"] = json!("in_progress");
    let mut completed = response;
    completed["status"] = json!("completed");
    let mut events = vec![json!({"type":"response.created","response":created})];
    for item in items {
        events.push(json!({"type":"response.output_item.added","item":item}));
        let text = item["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>();
        if !text.is_empty() {
            events.push(json!({"type":"response.output_text.delta","delta":text.join("\n")}));
        }
        events.push(json!({"type":"response.output_item.done","item":item}));
    }
    events.push(json!({"type":"response.completed","response":completed}));
    sse_events(events)
}

/// The proxy's envelope for an exhausted ChatGPT plan window, which resets in hours.
fn proxy_usage_limit() -> Response {
    let body = json!({"error":{"message":"The upstream plan usage limit was reached.",
        "type":"usage_limit_reached", "code":"upstream_usage_limit_reached",
        "retryable":false, "resets_at":4_102_444_800_i64}});
    (StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response()
}

fn answer_item(text: &str) -> Value {
    json!({"type":"message","id":"msg-local-retry","role":"assistant",
    "status":"completed","phase":"final_answer",
    "content":[{"type":"output_text","text":text,"annotations":[]}]})
}

fn answer(text: &str) -> Response {
    sse(answer_item(text))
}

fn step_item(text: &str) -> Value {
    json!({"type":"message","id":"msg-local-step","role":"assistant",
    "status":"completed","phase":"commentary",
    "content":[{"type":"output_text","text":text,"annotations":[]}]})
}

/// A completed step that asks Codex for another sampling request in the same turn, the way a
/// browser turn continues after each action, without depending on which tools are offered.
fn continue_turn(text: &str) -> Response {
    sse_with_end_turn(step_item(text), Some(false))
}

async fn responses(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if headers.get("authorization").and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {API_KEY}").as_str())
    {
        state.errors.lock().unwrap().push("unexpected auth".into());
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let ordinal = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body.clone());
        requests.len()
    };
    // A regression must fail quickly rather than consume the old nested budget.
    if ordinal > 8 {
        return (StatusCode::BAD_REQUEST, "local fixture request ceiling").into_response();
    }
    let code = match state.scenario.as_str() {
        "transient" | "transient_429" | "transient_429_sse" if ordinal > 1 => {
            return answer(FINAL_TEXT);
        }
        "transient_429" | "persistent_429" => return proxy_rate_limit(),
        "transient_429_sse" | "persistent_429_sse" => return proxy_stream_rate_limit(),
        "usage_limit_429" => return proxy_usage_limit(),
        // Two sampling requests in one browser-lane turn, each throttled once and recovered.
        "browser_step_429s" | "browser_step_429s_sse" => {
            return match ordinal {
                1 | 3 if state.scenario.ends_with("_sse") => proxy_stream_rate_limit(),
                1 | 3 => proxy_rate_limit(),
                2 => continue_turn(STEP_TEXT),
                _ => answer(FINAL_TEXT),
            };
        }
        // The upstream stopped the answer after a finished reasoning item. A re-send would send
        // the same input again under the same cap or filter, so the proxy completes the response
        // with the text that arrived and a notice, and codex ends the turn normally.
        "incomplete_max_output_tokens" => return proxy_cut_short_with_notice("max_output_tokens"),
        "incomplete_content_filter" => return proxy_cut_short_with_notice("content_filter"),
        // Parallel tool calls: the first finished, and max_output_tokens cut the second off. The
        // proxy passes on the finished one as a completed response, and codex continues with its
        // output on the next request.
        "incomplete_after_tool_call" => {
            if ordinal > 1 {
                return answer(FINAL_TEXT);
            }
            return match workspace_command_call(&state, &body, FINISHED_CALL_ID, TOOL_CMD) {
                Some(call) => {
                    proxy_cut_short_completed(&format!("resp-{}", Uuid::new_v4()), vec![call])
                }
                None => StatusCode::BAD_REQUEST.into_response(),
            };
        }
        // Four jobs on one thread, 50k input tokens per turn. The second job's first step
        // reports no usage, so Codex's first count of that turn repeats the restored total.
        // The fourth job's only response reports none at all.
        "per_turn_usage" => {
            let usage = json!({"input_tokens":50_000,"output_tokens":1_000,
                "total_tokens":51_000, "input_tokens_details":{"cached_tokens":45_000},
                "output_tokens_details":{"reasoning_tokens":250}});
            return match ordinal {
                2 => sse_with_usage(step_item(STEP_TEXT), Some(false), None),
                5 => sse_with_usage(answer_item(FINAL_TEXT), None, None),
                _ => sse_with_usage(answer_item(FINAL_TEXT), None, Some(usage)),
            };
        }
        // A routed job whose first attempt ends with no final message, so the runtime retries
        // it once. Each attempt reports its own usage.
        "retry_usage" => {
            let usage = |input: u64, cached: u64, output: u64| {
                json!({"input_tokens":input, "output_tokens":output,
                    "total_tokens":input + output, "input_tokens_details":{"cached_tokens":cached},
                    "output_tokens_details":{"reasoning_tokens":0}})
            };
            return match ordinal {
                1 => answer(
                    &json!({
                        "summary":"The user asks a direct question.",
                        "route":"direct", "reason":"Answer directly.",
                        "selectedSkills":[], "confidence":0.9,
                        "requiresContextLookup":false, "requiresCommandExecution":false,
                        "requiresWorkspaceFileChanges":false, "observationCommands":[]
                    })
                    .to_string(),
                ),
                2 => sse_output(None, None, Some(usage(30_000, 27_000, 600))),
                _ => sse_with_usage(
                    answer_item(&json!({"summary":FINAL_TEXT, "files":[]}).to_string()),
                    None,
                    Some(usage(12_000, 10_000, 400)),
                ),
            };
        }
        "transient" | "persistent" | "routing" => 503,
        "terminal_400" => 400,
        "terminal_401" => 401,
        "terminal_402" => 402,
        "terminal_403" => 403,
        "terminal_424" => 424,
        "cancel" | "timeout" => 200,
        "ambient_decline" => {
            if ordinal == 1 {
                return answer(
                    &json!({
                        "summary":"The conversation mentions project work.",
                        "route":"direct", "reason":"Evaluate the supplied conversation.",
                        "selectedSkills":[], "confidence":0.9,
                        "requiresContextLookup":false, "requiresCommandExecution":true,
                        "requiresWorkspaceFileChanges":true, "observationCommands":["pwd"]
                    })
                    .to_string(),
                );
            }
            return answer(
                &json!({"summary":"NO_RESPONSE", "files":[],
                "actions":[], "suggestions":[]})
                .to_string(),
            );
        }
        "tool_once" => {
            let supplied_history = body["input"].to_string();
            if !supplied_history.contains("TOOL_APPLIED") {
                return match workspace_command_call(&state, &body, "call-local-retry", TOOL_CMD) {
                    Some(call) => sse(call),
                    None => StatusCode::BAD_REQUEST.into_response(),
                };
            }
            503
        }
        other => {
            state
                .errors
                .lock()
                .unwrap()
                .push(format!("unknown scenario: {other}"));
            400
        }
    };
    if matches!(state.scenario.as_str(), "cancel" | "timeout") {
        fs::write(&state.request_ready, b"request arrived").unwrap();
        // No terminal event: cancel/timeout must stop the run without replaying it.
        let stream = futures_util::stream::pending::<
            Result<axum::response::sse::Event, std::convert::Infallible>,
        >();
        return axum::response::sse::Sse::new(stream).into_response();
    }
    (
        StatusCode::from_u16(code).unwrap(),
        Json(json!({"error":{"message":"local scripted failure","type":"fixture_error","code":"fixture_error"}})),
    )
        .into_response()
}

/// A completed call of the command tool the request offers, code mode's `exec` or else
/// `exec_command`, that runs `cmd` in the workspace. Records a fixture error when the request
/// offers neither.
fn workspace_command_call(
    state: &MockState,
    body: &Value,
    call_id: &str,
    cmd: &str,
) -> Option<Value> {
    let mut names = Vec::new();
    tool_names(&body["tools"], &mut names);
    for entry in body["input"].as_array().into_iter().flatten() {
        if entry["type"] == "additional_tools" {
            tool_names(&entry["tools"], &mut names);
        }
    }
    let id = format!("tool-{call_id}");
    if names.iter().any(|name| name == "exec") {
        let input = format!(
            "const result = await tools.exec_command({{cmd: {}, max_output_tokens: 1024}}); text(result);",
            json!(cmd)
        );
        return Some(json!({"type":"custom_tool_call","id":id,
            "call_id":call_id,"name":"exec","status":"completed","input":input}));
    }
    if names.iter().any(|name| name == "exec_command") {
        return Some(json!({"type":"function_call","id":id,
            "call_id":call_id,"name":"exec_command","status":"completed",
            "arguments":json!({"cmd":cmd,"max_output_tokens":1024}).to_string()}));
    }
    state.errors.lock().unwrap().push(format!(
        "fixture needs an offered exec or exec_command tool; received names: {names:?}"
    ));
    None
}

fn tool_names(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| tool_names(item, output)),
        Value::Object(map) => {
            if let Some(name) = map.get("name").and_then(Value::as_str) {
                output.push(name.to_owned());
            }
            map.values().for_each(|value| tool_names(value, output));
        }
        _ => {}
    }
}

async fn run_scenario(scenario: &str, expected_requests: usize) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let workspace = temp.path().join("workspace");
    let scratch = temp.path().join("tmp");
    for dir in [&codex_home, &workspace, &scratch] {
        fs::create_dir_all(dir)?;
    }
    fs::write(
        codex_home.join("auth.json"),
        json!({"OPENAI_API_KEY":API_KEY}).to_string(),
    )?;
    fs::write(
        codex_home.join("config.toml"),
        "cli_auth_credentials_store = \"file\"\nproject_doc_max_bytes = 0\n[features]\napps = false\nweb_search_request = false\nmulti_agent = false\n",
    )?;
    let state = Arc::new(MockState {
        scenario: scenario.to_string(),
        request_ready: temp.path().join("request-ready"),
        requests: Mutex::new(Vec::new()),
        errors: Mutex::new(Vec::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(responses))
        .route(
            "/v1/models",
            get(|| async { Json(json!({"object":"list","data":[]})) }),
        )
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let output_path = temp.path().join("child.log");
    let output = fs::File::create(&output_path)?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "isolated_retry_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env(CHILD_MARKER, scenario)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HOME", &home)
        .env("CODEX_HOME", &codex_home)
        .env("CODEX_AUTH_PATH", codex_home.join("auth.json"))
        .env("TMPDIR", &scratch)
        .env("LANG", "C.UTF-8")
        .env("OPENAI_BASE_URL", format!("{origin}/v1"))
        .env("OPENAI_API_KEY", API_KEY)
        .env("CODEX_API_KEY", API_KEY)
        .env("CODEX_MODEL", "gpt-6-luna")
        .env("CODEX_MODEL_PROVIDER", "openai")
        .env("CODEX_ENABLE_WEB_SEARCH", "false")
        .env("CODEX_RUNTIME_REASONING_EFFORT", "low")
        // The bounded proxy policy must win over these deliberately large values.
        .env("CODEX_MAX_RUN_RETRIES", "4")
        // The browser lane keeps the runtime's own stream-error cap. A cap of one allows one
        // error per sampling request, so counting across the whole turn aborts on the second.
        .env(
            "CODEX_MAX_STREAM_RETRIES",
            if scenario.starts_with("browser_step_429s") {
                "1"
            } else {
                "5"
            },
        )
        .env("CODEX_RETRY_BASE_DELAY_MS", "1")
        .env(
            "CODEX_RUN_TIMEOUT_SECONDS",
            if scenario == "timeout" { "10" } else { "20" },
        )
        .env("INSTAFY_RETRY_TEST_WORKSPACE", &workspace)
        .env("INSTAFY_RETRY_TEST_REQUEST_READY", &state.request_ready)
        .env("CONTROLLER_BASE_URL", &origin)
        .env("RUNTIME_ACCESS_TOKEN", "inert-local-runtime-token")
        .env("SPACE_ID", "90000000-0000-4000-8000-000000000001")
        .env("WORKSPACE_DIR", &workspace)
        .env("WORKSPACE_PROJECT_DIR", &workspace)
        .env("RUNTIME_STRICT_MODE", "0")
        .env("RUNTIME_DEV_ISOLATION", "0")
        .env("RUST_MIN_STACK", "67108864")
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::from(output));
    let mut child = command.spawn()?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > Duration::from_secs(45) {
            let _ = child.kill();
            let _ = child.wait();
            server.abort();
            bail!("local retry scenario {scenario} exceeded outer watchdog");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    server.abort();
    let diagnostics = fs::read_to_string(output_path)?;
    assert!(status.success(), "{scenario} child failed: {diagnostics}");
    assert_eq!(
        *state.errors.lock().unwrap(),
        Vec::<String>::new(),
        "mock fixture errors"
    );
    let requests = state.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        expected_requests,
        "{scenario}: {diagnostics}"
    );
    if scenario == "routing" {
        assert!(
            requests.iter().all(|r| r
                .pointer("/text/format/schema/properties/requiresContextLookup")
                .is_some()),
            "a failed routing request must not start a main request"
        );
    }
    if scenario == "ambient_decline" {
        assert!(
            requests[0]
                .pointer("/text/format/schema/properties/requiresContextLookup")
                .is_some()
        );
        assert!(
            requests[1]
                .pointer("/text/format/schema/properties/requiresContextLookup")
                .is_none()
        );
        assert_ne!(
            requests[1]["tool_choice"], "required",
            "the ambient participation decision must permit a tool-free decline"
        );
        let main_input = requests[1]["input"].to_string();
        assert!(main_input.contains("Earlier human context for the local decline fixture."));
        assert!(main_input.contains("NO_RESPONSE"));
    }
    if scenario.starts_with("browser_step_429s") {
        assert!(
            requests
                .iter()
                .skip(2)
                .all(|r| r["input"].to_string().contains(STEP_TEXT)),
            "the second step must continue the same session rather than replay the turn"
        );
    }
    if scenario == "incomplete_after_tool_call" {
        assert_eq!(fs::read_to_string(workspace.join("tool-count.txt"))?, "x");
        let continued = requests[1]["input"].as_array().context("request input")?;
        assert!(
            continued
                .iter()
                .any(|item| item["call_id"] == FINISHED_CALL_ID
                    && item["type"]
                        .as_str()
                        .is_some_and(|kind| kind.ends_with("_call_output"))
                    && item["output"].to_string().contains("TOOL_APPLIED")),
            "the follow-up must continue with the finished call's output: {continued:?}"
        );
    }
    if scenario == "tool_once" {
        assert_eq!(fs::read_to_string(workspace.join("tool-count.txt"))?, "x");
        assert!(
            requests
                .iter()
                .skip(1)
                .all(|r| r["input"].to_string().contains("TOOL_APPLIED")),
            "recovery must retain the completed tool result in the same session"
        );
    }
    Ok(())
}

macro_rules! scenario_test {
    ($name:ident, $scenario:literal, $requests:literal) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn $name() -> Result<()> {
            run_scenario($scenario, $requests).await
        }
    };
}

scenario_test!(
    persistent_503_has_two_attempts_without_outer_restart,
    "persistent",
    2
);
scenario_test!(transient_503_recovers_in_same_session, "transient", 2);
scenario_test!(transient_429_recovers_in_same_session, "transient_429", 2);
scenario_test!(
    persistent_429_is_bounded_and_reports_the_rate_limit,
    "persistent_429",
    2
);
scenario_test!(plan_usage_limit_429_is_not_retried, "usage_limit_429", 1);
scenario_test!(
    browser_turn_recovered_429s_do_not_accumulate_across_steps,
    "browser_step_429s",
    4
);
// The shapes the proxy streams in place of a transient 429, which codex retries by itself.
scenario_test!(
    transient_streamed_429_recovers_in_same_session,
    "transient_429_sse",
    2
);
scenario_test!(
    persistent_streamed_429_is_bounded_and_reports_the_rate_limit,
    "persistent_429_sse",
    2
);
scenario_test!(
    browser_turn_recovered_streamed_429s_do_not_accumulate_across_steps,
    "browser_step_429s_sse",
    4
);
// The shapes the proxy streams for a response the upstream stopped early.
scenario_test!(
    incomplete_max_output_tokens_is_not_resent,
    "incomplete_max_output_tokens",
    1
);
scenario_test!(
    incomplete_content_filter_is_not_resent,
    "incomplete_content_filter",
    1
);
scenario_test!(
    incomplete_after_tool_call_continues_with_its_output,
    "incomplete_after_tool_call",
    2
);
scenario_test!(terminal_400_is_not_retried, "terminal_400", 1);
scenario_test!(terminal_401_is_not_retried, "terminal_401", 1);
scenario_test!(terminal_402_is_not_retried, "terminal_402", 1);
scenario_test!(terminal_403_is_not_retried, "terminal_403", 1);
scenario_test!(terminal_424_is_not_retried, "terminal_424", 1);
scenario_test!(cancellation_does_not_restart_the_run, "cancel", 1);
scenario_test!(timeout_does_not_restart_the_run, "timeout", 1);
scenario_test!(
    completed_tool_is_not_replayed_after_stream_failure,
    "tool_once",
    3
);
scenario_test!(routing_failure_does_not_start_main_fallback, "routing", 2);
scenario_test!(
    ambient_decline_does_not_retry_for_routed_work_requirements,
    "ambient_decline",
    2
);
scenario_test!(
    turn_completed_reports_each_turn_of_a_resumed_thread,
    "per_turn_usage",
    5
);
scenario_test!(
    recovery_retry_usage_rows_carry_their_attempt,
    "retry_usage",
    3
);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Child entrypoint; outer tests supply an isolated environment and loopback proxy"]
async fn isolated_retry_child() -> Result<()> {
    let scenario = std::env::var(CHILD_MARKER).context("requires isolated parent harness")?;
    let home = std::env::var("HOME")?;
    let codex_home = std::env::var("CODEX_HOME")?;
    assert!(Path::new(&codex_home).starts_with(&home));
    assert_eq!(
        fs::read_to_string(Path::new(&codex_home).join("auth.json"))?,
        json!({"OPENAI_API_KEY":API_KEY}).to_string()
    );
    let workspace = std::env::var("INSTAFY_RETRY_TEST_WORKSPACE")?;
    if matches!(
        scenario.as_str(),
        "routing" | "ambient_decline" | "retry_usage"
    ) {
        return run_routing_job(&scenario).await;
    }
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.into(),
    });
    if scenario == "per_turn_usage" {
        return run_per_turn_usage_jobs(&client).await;
    }
    let cancel = JobCancelSignal::new();
    let cancel_on_request = scenario == "cancel";
    let signal = cancel.clone();
    let request_ready = PathBuf::from(std::env::var("INSTAFY_RETRY_TEST_REQUEST_READY")?);
    let canceller = cancel_on_request.then(|| {
        tokio::spawn(async move {
            // Cancel only after the server observes inference, avoiding startup races.
            while !request_ready.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            signal.cancel();
        })
    });
    let result = client
        .execute_with_options(
            "Run the supplied local diagnostic and finish with its result.",
            None,
            CodexRunOptions {
                disable_final_output_json_schema: true,
                allow_plain_text_final_fallback: true,
                suppress_contextual_instructions: true,
                cancel_signal: Some(cancel),
                // A browser session keeps Codex's default retries and the runtime's own
                // stream-error cap instead of the bounded proxy policy.
                expect_browser_session: scenario.starts_with("browser_step_429s"),
                ..Default::default()
            },
        )
        .await;
    if let Some(task) = canceller {
        task.abort();
    }
    if let Some(reason) = scenario
        .strip_prefix("incomplete_")
        .filter(|reason| *reason != "after_tool_call")
    {
        // The turn ends normally, its final answer the text that arrived and then the proxy's
        // notice, and reports its usage as any completed turn does, so the controller reconciles
        // it on its tokens.
        let output = result.context("a cut-short answer must end the turn normally")?;
        let answer = format!("{PARTIAL_TEXT}\n\n{}", cut_short_notice(reason));
        assert_eq!(output.final_json["summary"], answer);
        let agent_messages = output
            .events
            .iter()
            .filter(|event| {
                event["type"] == "item.completed" && event["item"]["type"] == "agent_message"
            })
            .filter_map(|event| event["item"]["text"].as_str())
            .collect::<Vec<_>>();
        assert!(
            !agent_messages.is_empty() && agent_messages.iter().all(|text| *text == answer),
            "one answer, the text that arrived and then the notice: {agent_messages:?}"
        );
        let completed = output
            .events
            .iter()
            .filter(|event| event["type"] == "turn.completed")
            .collect::<Vec<_>>();
        assert_eq!(completed.len(), 1, "{completed:?}");
        assert_eq!(completed[0]["usageScope"], "turn", "{completed:?}");
        assert_eq!(completed[0]["usage"]["input_tokens"], 10, "{completed:?}");
        assert_eq!(completed[0]["usage"]["output_tokens"], 5, "{completed:?}");
        // Keep the process alive beyond Codex's initial stream-retry backoff: nothing may be
        // sent again after the turn ended.
        tokio::time::sleep(Duration::from_millis(1200)).await;
    } else if matches!(
        scenario.as_str(),
        "transient"
            | "transient_429"
            | "transient_429_sse"
            | "browser_step_429s"
            | "browser_step_429s_sse"
            | "incomplete_after_tool_call"
    ) {
        assert_eq!(result?.final_json["summary"], FINAL_TEXT);
    } else {
        let error = result.expect_err("scripted failure must remain an error");
        let message = format!("{error:#}").to_ascii_lowercase();
        if scenario.starts_with("persistent_429") {
            // The final error must still say it was a rate limit so it can be classified.
            assert!(message.contains("429"), "{message}");
            assert!(message.contains("rate limit was reached"), "{message}");
        }
        if scenario == "usage_limit_429" {
            assert!(message.contains("usage limit"), "{message}");
        }
        if scenario == "cancel" {
            assert!(message.contains("lease lost"), "{message}");
        }
        if scenario == "timeout" {
            assert!(message.contains("timed out"), "{message}");
        }
        if scenario.starts_with("terminal_") || scenario == "cancel" {
            // Keep the process alive beyond Codex's initial stream-retry backoff:
            // returning an error must not leave a scheduled request running behind it.
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }
    }
    Ok(())
}

/// Runs four jobs on one persisted thread. Each job builds a fresh thread manager, so the
/// later ones resume the thread from the rollout, restoring Codex's running total.
async fn run_per_turn_usage_jobs(client: &CodexClient) -> Result<()> {
    let mut provider_conversation_state = None;
    let mut reported = Vec::new();
    for _ in 0..4 {
        let output = client
            .execute_with_options(
                "Run the supplied local diagnostic and finish with its result.",
                None,
                CodexRunOptions {
                    disable_final_output_json_schema: true,
                    allow_plain_text_final_fallback: true,
                    suppress_contextual_instructions: true,
                    persist_conversation_thread: true,
                    provider_conversation_state: provider_conversation_state.take(),
                    ..Default::default()
                },
            )
            .await?;
        assert_eq!(output.final_json["summary"], FINAL_TEXT);
        let state = output
            .provider_conversation_state
            .context("a persisted thread returns its state")?;
        let completed: Vec<&Value> = output
            .events
            .iter()
            .filter(|event| event["type"] == "turn.completed")
            .collect();
        assert_eq!(completed.len(), 1, "{completed:?}");
        reported.push(json!({
            "restoredFrom": state["defaultThreadRestoreSource"],
            "hasUsage": completed[0].get("usage").is_some(),
            "usageScope": completed[0]["usageScope"],
            "input": completed[0]["usage"]["input_tokens"],
            "cached": completed[0]["usage"]["cached_input_tokens"],
            "output": completed[0]["usage"]["output_tokens"],
            "threadInput": completed[0]["threadTotalUsage"]["input_tokens"],
        }));
        provider_conversation_state = Some(state);
    }
    let turn = |restored_from: &str, thread_input: u64| {
        json!({"restoredFrom":restored_from, "hasUsage":true, "usageScope":"turn",
            "input":50_000, "cached":45_000, "output":1_000, "threadInput":thread_input})
    };
    // A turn that reported no usage has no `usage`, which the controller reads as none
    // reported and keeps the flat reserve. A zero would refund it.
    let unreported = json!({"restoredFrom":"rollout", "hasUsage":false, "usageScope":null,
        "input":null, "cached":null, "output":null, "threadInput":150_000});
    assert_eq!(
        reported,
        [
            turn("new", 50_000),
            turn("rollout", 100_000),
            turn("rollout", 150_000),
            unreported
        ]
    );
    Ok(())
}

async fn run_routing_job(scenario: &str) -> Result<()> {
    use runtime_agent::config::Config;
    use runtime_agent::controller::{LeaseJob, Registration};
    use runtime_agent::jobs::{JobMessage, JobProcessor, JobProgress};
    use std::sync::atomic::AtomicBool;
    let config = Arc::new(Config::from_env()?);
    let origin = config.controller_base_url.clone();
    let registration = Registration {
        runtime_id: Uuid::new_v4(),
        agent_token: "inert-local-agent-token".into(),
        runtime_token: None,
        lease_url: origin.clone(),
        heartbeat_url: origin,
        stop_url: None,
        lease_id: None,
        proxy: None,
        lease_scope: None,
        tenant_projects: Vec::new(),
        workspace_manifest: None,
        parent_lease_id: None,
        agent_token_scopes: Vec::new(),
        agent_token_issued_at: None,
        agent_token_expires_at: None,
        agent_token_ttl: None,
    };
    let mut payload = json!({"prompt_text":"What is 3 plus 4?", "metadata":{}});
    if scenario == "ambient_decline" {
        payload = json!({
            "prompt_text":"Morgan, please update the project file later; I will coordinate with you.",
            "conversation_history":[{"role":"user", "content":"Earlier human context for the local decline fixture."}],
            "metadata":{"agent":{"handle":"fixture-agent", "displayName":"Fixture Agent"},
                "groupParticipation":{"decision":"agent_evaluation", "reason":"skill_mode_ambient", "enforcedBy":"runtime-controller"}}
        });
    }
    let job: LeaseJob = serde_json::from_value(json!({
        "id":Uuid::new_v4(), "intent":"feature", "project_id":config.project_id,
        "run_id":Uuid::new_v4(), "conversation_id":Uuid::new_v4(), "payload":payload
    }))?;
    let processor = JobProcessor::new(config);
    // The retry scenario streams, so the retry's rows also take the streamed path.
    let (sender, mut progress_messages) = tokio::sync::mpsc::unbounded_channel();
    let progress = (scenario == "retry_usage").then(|| JobProgress {
        sender,
        status: Arc::new(AtomicBool::new(true)),
    });
    let result = processor
        .run_apply_job(&registration, &job, false, progress, None, None)
        .await;
    if scenario == "retry_usage" {
        let execution = result?;
        assert_eq!(execution.summary, FINAL_TEXT);
        let usage_rows = |messages: &[JobMessage]| {
            messages
                .iter()
                .filter(|message| message.message_type.as_deref() == Some("token_usage"))
                .map(|message| {
                    let metadata = message.metadata.clone().unwrap_or_default();
                    json!({"attempt":metadata.get("attempt"), "usageScope":metadata["usageScope"],
                        "input":metadata["usage"]["input_tokens"]})
                })
                .collect::<Vec<_>>()
        };
        let mut streamed = Vec::new();
        while let Ok(message) = progress_messages.try_recv() {
            streamed.push(message);
        }
        // Each attempt streams its own per-turn row. The completion row and the ledger repeat
        // only the first, so the retry's row says which attempt it counts.
        let retry = json!({"attempt":2, "usageScope":"turn", "input":12_000});
        assert_eq!(
            usage_rows(&streamed),
            [
                json!({"attempt":null, "usageScope":"turn", "input":30_000}),
                retry.clone()
            ]
        );
        // A retried job delivers only the retry's messages.
        assert_eq!(usage_rows(&execution.messages), [retry]);
        return Ok(());
    }
    if scenario == "ambient_decline" {
        let execution = result?;
        assert_eq!(execution.summary, "NO_RESPONSE");
        assert!(
            !execution
                .artifacts
                .iter()
                .any(|artifact| artifact["kind"] == "routing/pre-observation"),
            "host work must wait for the ambient participation decision"
        );
        assert!(
            !execution
                .messages
                .iter()
                .chain(execution.final_messages.iter())
                .any(|message| message
                    .metadata
                    .as_ref()
                    .is_some_and(|metadata| metadata["kind"] == "codex_retry")),
            "a clean ambient decline must not trigger semantic recovery"
        );
    } else {
        assert!(result.is_err(), "routing transport failure must propagate");
    }
    Ok(())
}
