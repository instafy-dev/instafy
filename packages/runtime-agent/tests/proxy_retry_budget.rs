//! Local-only retry contract tests. Every embedded Codex run is in an env-cleared
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

struct MockState {
    scenario: String,
    request_ready: PathBuf,
    requests: Mutex<Vec<Value>>,
    errors: Mutex<Vec<String>>,
}

fn sse(mut item: Value) -> Response {
    let response_id = format!("resp-{}", Uuid::new_v4());
    item["id"] = json!(format!("item-{}", Uuid::new_v4()));
    if item.get("call_id").is_some() {
        item["call_id"] = json!(format!("call-{}", Uuid::new_v4()));
    }
    let response = json!({
        "id":response_id, "object":"response", "status":"completed",
        "model":"gpt-6-luna", "output":[item.clone()],
        "usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,
            "input_tokens_details":{"cached_tokens":0},
            "output_tokens_details":{"reasoning_tokens":0}}
    });
    let events = [
        json!({"type":"response.created","response":{"id":response_id,"status":"in_progress","model":"gpt-6-luna","output":[]}}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":response}),
    ];
    let body = events
        .into_iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    ([("content-type", "text/event-stream")], body).into_response()
}

fn answer(text: &str) -> Response {
    sse(
        json!({"type":"message","id":"msg-local-retry","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":text,"annotations":[]}]}),
    )
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
        "transient" if ordinal > 1 => return answer(FINAL_TEXT),
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
                let mut names = Vec::new();
                tool_names(&body["tools"], &mut names);
                for entry in body["input"].as_array().into_iter().flatten() {
                    if entry["type"] == "additional_tools" {
                        tool_names(&entry["tools"], &mut names);
                    }
                }
                if names.iter().any(|name| name == "exec") {
                    return sse(json!({"type":"custom_tool_call","id":"tool-local-retry",
                        "call_id":"call-local-retry","name":"exec","status":"completed",
                        "input":"const result = await tools.exec_command({cmd: \"printf x >> tool-count.txt; printf TOOL_APPLIED\", max_output_tokens: 1024}); text(result);"}));
                }
                if names.iter().any(|name| name == "exec_command") {
                    return sse(json!({"type":"function_call","id":"tool-local-retry",
                        "call_id":"call-local-retry","name":"exec_command","status":"completed",
                        "arguments":json!({"cmd":"printf x >> tool-count.txt; printf TOOL_APPLIED","max_output_tokens":1024}).to_string()}));
                }
                state.errors.lock().unwrap().push(format!(
                    "fixture needs an offered exec or exec_command tool; received names: {names:?}"
                ));
                return StatusCode::BAD_REQUEST.into_response();
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
        .env("CODEX_MAX_STREAM_RETRIES", "5")
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
    if matches!(scenario.as_str(), "routing" | "ambient_decline") {
        return run_routing_job(&scenario).await;
    }
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.into(),
    });
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
                ..Default::default()
            },
        )
        .await;
    if let Some(task) = canceller {
        task.abort();
    }
    if scenario == "transient" {
        assert_eq!(result?.final_json["summary"], FINAL_TEXT);
    } else {
        let error = result.expect_err("scripted failure must remain an error");
        let message = format!("{error:#}").to_ascii_lowercase();
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

async fn run_routing_job(scenario: &str) -> Result<()> {
    use runtime_agent::config::Config;
    use runtime_agent::controller::{LeaseJob, Registration};
    use runtime_agent::jobs::JobProcessor;
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
    let result = processor
        .run_apply_job(&registration, &job, false, None, None, None)
        .await;
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
