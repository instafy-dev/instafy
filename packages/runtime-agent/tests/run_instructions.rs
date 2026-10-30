//! Every turn reads its own run's instructions: on a fresh provider thread, and on a thread a
//! later turn resumes from its rollout. A chat's turns share one thread, and a card's Shared
//! Browser turn resumes the chat's default thread, so a run's lane text, browser policy and turn
//! note must reach a resumed thread too, once, and only when they change.
//!
//! Real job processor and real proxy (the ChatGPT transport, and the API-key one for chain T), an
//! inert localhost provider, the real `provider-mcp` broker for a granted turn and the real
//! Shared Browser MCP server. This target is built with `harness = false`: Codex starts
//! `current_exe()` as `shared-browser-mcp` for a Shared Browser turn, which a libtest binary
//! cannot serve. The binary re-runs itself in a child with an emptied environment and an owned
//! HOME and TMPDIR, so host credentials are never consulted.
//!
//! What a request carries: the proxy moves every developer message of `input`, joined in history
//! order, and Codex's own instructions into one user-role message at `input[0]`. A run's
//! instructions are developer messages tagged `<instafy_run_instructions>`, a turn's note
//! `<instafy_turn_notes>`; so both reach the provider inside `input[0]` and nowhere else.
//!
//! Lanes this host cannot run (the owner-local browser, and a Shared Browser run that starts in
//! routine browsing: both need Linux-only trust checks) put their text into the same run text
//! as every other part, so chain S varies a Shared Browser turn's text through its environment
//! override instead. Shared Browser, MCP and write turns end without the tool evidence their
//! lanes require (no browser, no project MCP server, no file change) and fail after their
//! recovery run; for the chat's next turn the test saves the state a successful turn would have
//! saved.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::ffi::OsString;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use axum::Router;
use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use axum::routing::{get, post};
use futures_util::stream;
use openai_proxy_server::{auth, proxy};
use reqwest::Url;
use runtime_agent::config::Config;
use runtime_agent::controller::{LeaseJob, Registration};
use runtime_agent::jobs::JobProcessor;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

const TEST_NAME: &str = "every_turn_reads_its_own_run_instructions";
const CHILD: &str = "INSTAFY_RUN_INSTRUCTIONS_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-run-instructions-provider-key";
const ACCOUNT: &str = "inert-run-instructions-account";
const OPAQUE: &str = "inert-opaque-run-instructions-checkpoint+/=";
const INITIATOR: &str = "6f0c0d5e-2c38-4a83-9d3e-6ad1f6d2b0a1";
const GRANT_TOKEN: &str = "grant-token-of-this-test-turn";

const RUN_OPEN: &str = "<instafy_run_instructions>";
const RUN_CLOSE: &str = "</instafy_run_instructions>";
const NOTE_OPEN: &str = "<instafy_turn_notes>";
const NOTE_CLOSE: &str = "</instafy_turn_notes>";
const REPLACE: &str = "These run instructions replace all run instructions given earlier in this conversation, including the ones it started with. All other instructions still apply.";
const NOTE_WITHDRAWAL: &str = "Earlier turn notes in this conversation no longer apply.";

/// The texts a run's instructions are made of, each by a distinctive substring.
const MARKERS: &[(&str, &str)] = &[
    ("STRUCTURED", "Instafy Studio structured execution run:"),
    ("PLAIN_FINAL", "Instafy Studio focused execution run:"),
    ("PLAIN_WRITE", "Instafy Studio workspace task:"),
    ("MCP_MODE", "MCP-focused run:"),
    ("GRANTED", "Granted device turn:"),
    ("BROWSER_MODE", "Browser/UI execution run:"),
    (
        "SHARED_POLICY",
        "Shared Browser transport (managed runtime policy):",
    ),
    (
        "SHARED_ASK_LINE",
        "By default, the authenticated initiating user approves each site",
    ),
    (
        "SHARED_ROUTINE_LINE",
        "This run starts in routine browsing:",
    ),
    (
        "PERSONAL_POLICY",
        "Personal Browser transport (managed runtime policy):",
    ),
    (
        "LOCAL_POLICY",
        "Owner-local browser observation (self-hosted runtime policy):",
    ),
    (
        "PAGE_LEFT_LINE",
        "The page this turn starts on was left open by a task in another chat.",
    ),
    ("PROBE_ASK", "PROBE-APPROVAL-START-ASK"),
    ("PROBE_ROUTINE", "PROBE-APPROVAL-START-ROUTINE"),
];

fn needle(marker: &str) -> &'static str {
    MARKERS
        .iter()
        .find(|(name, _)| *name == marker)
        .map(|(_, needle)| *needle)
        .unwrap_or_else(|| panic!("unknown marker {marker}"))
}

fn main() -> Result<()> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    // Codex starts this binary as the Shared Browser MCP server of a Shared Browser turn.
    if runtime_agent::shared_browser::is_shared_browser_mcp_command(&args) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return runtime.block_on(runtime_agent::shared_browser::run_mcp_stdio());
    }
    if std::env::var(CHILD).as_deref() == Ok("1") {
        return run_in_child();
    }
    let args: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if args.iter().any(|arg| arg == "--list") {
        println!("{TEST_NAME}: test");
        return Ok(());
    }
    // `cargo test <filter>` passes its filter to every test binary: run only when it names this test.
    let exact = args.iter().any(|arg| arg == "--exact");
    let filters: Vec<&String> = args.iter().filter(|arg| !arg.starts_with('-')).collect();
    let selected = filters.is_empty()
        || filters.iter().any(|filter| {
            if exact {
                filter.as_str() == TEST_NAME
            } else {
                TEST_NAME.contains(filter.as_str())
            }
        });
    if !selected {
        println!("test result: ok. 0 passed; 0 failed; 1 filtered out");
        return Ok(());
    }
    println!("test {TEST_NAME} ...");
    run_isolated_child()?;
    println!("test {TEST_NAME} ... ok");
    Ok(())
}

fn run_in_child() -> Result<()> {
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("run-instructions".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(4)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_chains())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("run-instructions fixture panicked"))?
}

/// Re-runs this binary with an emptied environment and an owned HOME and TMPDIR, so nothing
/// reads the host's Codex login or config.
fn run_isolated_child() -> Result<()> {
    let isolated = TempDir::new()?;
    let home = isolated.path().join("home");
    let scratch = isolated.path().join("tmp");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&scratch)?;
    let output_path = isolated.path().join("child-output.txt");
    let output = fs::File::create(&output_path)?;
    let mut child = std::process::Command::new(std::env::current_exe()?)
        .env_clear()
        .env(CHILD, "1")
        .env("HOME", &home)
        .env("TMPDIR", &scratch)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("SHELL", "/bin/sh")
        .env("LANG", "C.UTF-8")
        .env("RUST_MIN_STACK", "33554432")
        .current_dir(&home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(output.try_clone()?))
        .stderr(std::process::Stdio::from(output))
        .spawn()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(1500);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            bail!(
                "the run-instructions fixture timed out:\n{}",
                fs::read_to_string(&output_path)?
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    ensure!(
        status.success(),
        "the run-instructions fixture failed ({status}):\n{}",
        fs::read_to_string(&output_path)?
    );
    Ok(())
}

fn set_env(key: &str, value: impl AsRef<std::ffi::OsStr>) {
    // SAFETY: the fixture runs one job at a time; the job processor reads its settings from the
    // process environment the same way the proxy_integration fixtures set them.
    unsafe { std::env::set_var(key, value) };
}

fn remove_env(key: &str) {
    // SAFETY: as in `set_env`.
    unsafe { std::env::remove_var(key) };
}

#[derive(Clone, Copy, Debug)]
enum Step {
    Final { total_tokens: u64 },
    Fail502,
    ExecCommand { total_tokens: u64 },
}

struct Provider {
    label: StdMutex<String>,
    scripts: StdMutex<HashMap<String, VecDeque<Step>>>,
    requests: StdMutex<Vec<(String, Value)>>,
}

fn fixture_response(
    streams: bool,
    item: Value,
    total_tokens: u64,
    empty_final_output: bool,
) -> axum::response::Response {
    let id = format!("resp_{}", Uuid::new_v4());
    let response = json!({
        "id":id,"object":"response","status":"completed","model":"gpt-5.5",
        "output": if empty_final_output && streams { vec![] } else { vec![item.clone()] },
        "usage":{"input_tokens":total_tokens - 10,"output_tokens":10,"total_tokens":total_tokens}
    });
    if !streams {
        // The API-key leg asks for one JSON body.
        return Json(response).into_response();
    }
    let events = [
        json!({"type":"response.created","response":{"id":id,"status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":response}),
    ];
    Sse::new(stream::iter(events.into_iter().map(|event| {
        Ok::<Event, Infallible>(Event::default().data(event.to_string()))
    })))
    .into_response()
}

fn final_item(label: &str) -> Value {
    json!({
        "id":format!("msg_{}",Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":json!({
            "summary":format!("Turn {label} completed."),"code":"","files":[],"actions":[]
        }).to_string()}]
    })
}

fn is_compaction_request(body: &Value) -> bool {
    body["input"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["type"] == "compaction_trigger")
    })
}

fn carries_compaction(body: &Value) -> bool {
    body["input"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["type"] == "compaction"))
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    assert_eq!(
        headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some(format!("Bearer {PROVIDER_KEY}").as_str())
    );
    let streams = body["stream"].as_bool().unwrap_or(true);
    let label = state.label.lock().unwrap().clone();
    state
        .requests
        .lock()
        .unwrap()
        .push((label.clone(), body.clone()));
    if is_compaction_request(&body) {
        return fixture_response(
            streams,
            json!({"type":"compaction","encrypted_content":OPAQUE}),
            80,
            true,
        );
    }
    let step = state
        .scripts
        .lock()
        .unwrap()
        .get_mut(&label)
        .and_then(VecDeque::pop_front)
        .unwrap_or(Step::Final { total_tokens: 80 });
    match step {
        Step::Final { total_tokens } => {
            fixture_response(streams, final_item(&label), total_tokens, false)
        }
        Step::Fail502 => (StatusCode::BAD_GATEWAY, "upstream request failed").into_response(),
        Step::ExecCommand { total_tokens } => fixture_response(
            streams,
            json!({
                "id":format!("fc_{}", Uuid::new_v4().simple()),"type":"function_call","name":"exec_command",
                "call_id":format!("call_{}", Uuid::new_v4().simple()),"status":"completed",
                "arguments":json!({"cmd":"printf RUN_INSTRUCTIONS_TOOL_WITNESS","max_output_tokens":64}).to_string()
            }),
            total_tokens,
            false,
        ),
    }
}

/// The Personal Browser's desktop broker, as the proxy_integration Personal Browser probe
/// stubs it: one `snapshot` tool.
async fn personal_browser_mcp(Json(payload): Json<Value>) -> axum::response::Response {
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    match payload.get("method").and_then(Value::as_str) {
        Some(method) if method.starts_with("notifications/") => {
            StatusCode::ACCEPTED.into_response()
        }
        Some("initialize") => Json(json!({
            "jsonrpc":"2.0","id":id,"result":{
                "protocolVersion":"2025-06-18",
                "capabilities":{"tools":{"listChanged":false}},
                "serverInfo":{"name":"instafy-personal-browser","version":"1.0.0"}
            }
        }))
        .into_response(),
        Some("tools/list") => Json(json!({
            "jsonrpc":"2.0","id":id,"result":{"tools":[{
                "name":"snapshot","description":"Read the visible Personal Browser page.",
                "inputSchema":{"type":"object","properties":{},"additionalProperties":false}
            }]}
        }))
        .into_response(),
        _ => Json(json!({
            "jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}
        }))
        .into_response(),
    }
}

async fn controller_fallback() -> axum::response::Response {
    StatusCode::NOT_FOUND.into_response()
}

async fn provider_tool_call(Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": true, "outcome": "succeeded", "state": "idle" }))
}

async fn search_messages() -> Json<Value> {
    Json(json!({ "matches": [], "nextCursor": null, "hasMore": false }))
}

fn reserve_port() -> Result<u16> {
    let socket = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = socket.local_addr()?.port();
    drop(socket);
    Ok(port)
}

async fn wait_for_port(port: u16) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        ensure!(
            tokio::time::Instant::now() < deadline,
            "proxy did not listen on {port}"
        );
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn registration(lease: bool) -> Registration {
    Registration {
        runtime_id: Uuid::new_v4(),
        agent_token: "integration-agent-token".to_string(),
        runtime_token: None,
        lease_url: Url::parse("http://127.0.0.1/lease").unwrap(),
        heartbeat_url: Url::parse("http://127.0.0.1/heartbeat").unwrap(),
        stop_url: None,
        lease_id: lease.then(Uuid::new_v4),
        proxy: None,
        lease_scope: None,
        tenant_projects: Vec::new(),
        workspace_manifest: None,
        parent_lease_id: None,
        agent_token_scopes: vec![
            "agent.lease".into(),
            "agent.heartbeat".into(),
            "agent.complete".into(),
        ],
        agent_token_issued_at: Some("2024-01-01T00:00:00Z".into()),
        agent_token_expires_at: Some("2024-01-01T01:00:00Z".into()),
        agent_token_ttl: Some(3600),
    }
}

fn runtime_config(
    workspace_root: &Path,
    project_id: Uuid,
    controller: &str,
) -> Result<Arc<Config>> {
    Ok(Arc::new(Config {
        controller_base_url: Url::parse(controller)?,
        controller_jwks_url: Url::parse(&format!("{controller}.well-known/jwks.json"))?,
        project_id,
        runtime_id: None,
        runtime_lease_id: None,
        provider: "test-runtime".to_string(),
        runtime_version: "test".to_string(),
        capabilities: json!({}),
        metadata: json!({}),
        lease_scope: None,
        workspace_manifest: None,
        tenant_projects: Vec::new(),
        parent_lease_id: None,
        poll_interval: Duration::from_millis(10),
        lease_wait: Duration::ZERO,
        lease_max_jobs: 1,
        lease_seconds: 30,
        heartbeat_seconds: 30,
        workspace_root: workspace_root.to_path_buf(),
        project_workspace_override: None,
        strict_mode: false,
        dev_isolation_mode: false,
        display_name: None,
        origin: None,
        codex_bin: None,
        require_codex_bin: false,
        runtime_access_token: None,
        parent_dispositions_runtime_on_shutdown: false,
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lane {
    /// An ordinary chat turn: the structured lane (the browser lane on a runtime with a
    /// boot-time browser).
    Default,
    /// Web chat's Summarize on a selected message: the plain final lane.
    PlainFinal,
    /// A turn that must change workspace files: the plain write lane.
    PlainWrite,
    /// A turn whose metadata expects generic MCP tool execution.
    Mcp,
    /// A Shared Browser turn on the given page.
    Shared(&'static str),
    /// A Personal Browser turn (the desktop's browser).
    Personal,
    /// A turn that holds a device grant.
    Granted,
}

struct Spec {
    conversation: Uuid,
    lane: Lane,
    previous: Option<Value>,
    /// INSTAFY_ENABLE_BROWSER_SESSION for this job: a runtime with a boot-time browser.
    browser_session_runtime: bool,
    /// CODEX_BROWSER_MODE_DEVELOPER_INSTRUCTIONS for this job, and the marker it carries.
    browser_lane_override: Option<(&'static str, &'static str)>,
    /// The harness has no browser or project MCP server, so these lanes' jobs end without the
    /// tool evidence they require and fail after their recovery run. For the chat's next turn
    /// the test then saves the state a successful turn would have saved: the thread of the
    /// job's first run (from its rollout), or the stored state when that run resumed it.
    emulate_success: bool,
    /// Send this job through the API-key proxy instead of the ChatGPT one.
    api_key: bool,
    script: Vec<Step>,
}

impl Spec {
    fn new(conversation: Uuid, lane: Lane, previous: Option<Value>) -> Self {
        Self {
            conversation,
            lane,
            previous,
            browser_session_runtime: matches!(lane, Lane::Shared(_)),
            browser_lane_override: None,
            emulate_success: matches!(lane, Lane::Shared(_) | Lane::Mcp | Lane::PlainWrite),
            api_key: false,
            script: Vec::new(),
        }
    }

    /// The markers of the run text this turn must read.
    fn expected_markers(&self) -> Vec<&'static str> {
        let mut markers = match self.lane {
            Lane::Default if self.browser_session_runtime => vec!["BROWSER_MODE"],
            Lane::Default => vec!["STRUCTURED"],
            Lane::PlainFinal => vec!["PLAIN_FINAL"],
            Lane::PlainWrite => vec!["PLAIN_WRITE"],
            Lane::Mcp => vec!["MCP_MODE"],
            Lane::Granted => vec!["GRANTED"],
            Lane::Shared(_) => vec!["SHARED_POLICY", "BROWSER_MODE", "SHARED_ASK_LINE"],
            Lane::Personal => vec!["PERSONAL_POLICY", "BROWSER_MODE"],
        };
        if let Some((_, marker)) = self.browser_lane_override {
            markers.push(marker);
        }
        markers
    }
}

/// One job of a chain, and every provider request it made.
struct Turn {
    label: &'static str,
    lane: Lane,
    expected: Vec<&'static str>,
    requests: Vec<Value>,
    /// The provider state the job saved, or why it failed.
    outcome: std::result::Result<Option<Value>, String>,
}

struct Harness {
    provider: Arc<Provider>,
    config: Arc<Config>,
    granted_config: Arc<Config>,
    project_id: Uuid,
    runtime_home: PathBuf,
    personal_mcp: SocketAddr,
    chatgpt_proxy: String,
    api_key_proxy: String,
    turns: Vec<Turn>,
}

fn rollout_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rollout_files(&path, out);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            out.push(path);
        }
    }
}

/// `rollout-<timestamp>-<thread id>.jsonl`
fn rollout_thread_id(path: &Path) -> Option<String> {
    let name = path.file_stem()?.to_str()?;
    (name.len() >= 36).then(|| name[name.len() - 36..].to_string())
}

impl Harness {
    fn lease_job(&self, label: &str, spec: &Spec) -> Result<LeaseJob> {
        let mut metadata = json!({
            "execution_mode":"apply","agentRoutingPreflight":{},
            "runtimeExpectations":{
                "workspaceFileChanges": spec.lane == Lane::PlainWrite,
                "commandExecution":false,
                "genericMcpToolExecution": spec.lane == Lane::Mcp
            }
        });
        match spec.lane {
            Lane::Shared(page) => {
                metadata["browserTransport"] = json!("shared");
                metadata["browserPageId"] = json!(page);
                metadata["browserConsentVersion"] = json!(1);
            }
            Lane::Personal => metadata["browserTransport"] = json!("desktop-personal"),
            Lane::PlainFinal => {
                metadata["replyContext"] = json!({"kind":"message_selection","action":"summarize"});
            }
            Lane::Default | Lane::PlainWrite | Lane::Mcp | Lane::Granted => {}
        }
        let mut job = json!({
            "id": Uuid::new_v4(),
            "intent": "feature",
            "project_id": self.project_id,
            "run_id": Uuid::new_v4(),
            "conversation_id": spec.conversation,
            "payload": {
                "prompt_text": format!("[[{label}]] Find the opening hours of the city museum and report them."),
                "provider_conversation_state": spec.previous,
                "user_id": INITIATOR,
                "metadata": metadata,
            },
            "lease_attempts": 1,
        });
        if spec.lane == Lane::Granted {
            job["grants"] = json!([{
                "providerId": "example-device",
                "instructions": "Use the example device's tools only when the person asks.",
                "tools": [
                    { "name": "example.state.read", "description": "Reads the device's state.",
                      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } },
                ],
            }]);
            job["grant_token"] = json!(GRANT_TOKEN);
        }
        Ok(serde_json::from_value(job)?)
    }

    fn processor(&self, lane: Lane) -> JobProcessor {
        let config = if lane == Lane::Granted {
            self.granted_config.clone()
        } else {
            self.config.clone()
        };
        JobProcessor::new(config)
            .with_provider_mcp_program(PathBuf::from(env!("CARGO_BIN_EXE_runtime-agent")))
    }

    /// Runs one job; returns the provider state the next turn of its chat gets.
    async fn run(&mut self, label: &'static str, spec: Spec) -> Option<Value> {
        let processor = self.processor(spec.lane);
        let job = self.lease_job(label, &spec).expect("job");
        *self.provider.label.lock().unwrap() = label.to_string();
        self.provider
            .scripts
            .lock()
            .unwrap()
            .insert(label.to_string(), spec.script.iter().copied().collect());
        if spec.browser_session_runtime {
            set_env("INSTAFY_ENABLE_BROWSER_SESSION", "true");
        } else {
            remove_env("INSTAFY_ENABLE_BROWSER_SESSION");
        }
        match spec.browser_lane_override {
            Some((text, _)) => set_env("CODEX_BROWSER_MODE_DEVELOPER_INSTRUCTIONS", text),
            None => remove_env("CODEX_BROWSER_MODE_DEVELOPER_INSTRUCTIONS"),
        }
        set_env(
            "OPENAI_BASE_URL",
            if spec.api_key {
                &self.api_key_proxy
            } else {
                &self.chatgpt_proxy
            },
        );
        if spec.lane == Lane::Personal {
            set_env(
                "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
                format!("http://{}", self.personal_mcp),
            );
            set_env(
                "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
                "personal-test-token",
            );
            set_env(
                "INSTAFY_PERSONAL_BROWSER_PROJECT_ID",
                self.project_id.to_string(),
            );
            set_env(
                "INSTAFY_RUNTIME_AGENT_BIN",
                env!("CARGO_BIN_EXE_runtime-agent"),
            );
        }
        let mut rollouts_before = Vec::new();
        rollout_files(&self.runtime_home.join("sessions"), &mut rollouts_before);
        let before = self.provider.requests.lock().unwrap().len();
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(240),
            processor.run_apply_job(
                &registration(spec.lane == Lane::Granted),
                &job,
                true,
                None,
                None,
                None,
            ),
        )
        .await;
        for key in [
            "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
            "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
            "INSTAFY_PERSONAL_BROWSER_PROJECT_ID",
            "INSTAFY_RUNTIME_AGENT_BIN",
            "CODEX_BROWSER_MODE_DEVELOPER_INSTRUCTIONS",
        ] {
            remove_env(key);
        }
        set_env("OPENAI_BASE_URL", &self.chatgpt_proxy);
        let requests: Vec<Value> = self.provider.requests.lock().unwrap()[before..]
            .iter()
            .map(|(_, body)| body.clone())
            .collect();
        let mut created = Vec::new();
        rollout_files(&self.runtime_home.join("sessions"), &mut created);
        created.retain(|path| !rollouts_before.contains(path));
        created.sort();
        let tag = format!("[[{label}]]");
        let started_thread = created
            .into_iter()
            .find(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(&tag)));
        let outcome = match result {
            Ok(Ok(execution)) => Ok(execution.provider_conversation_state),
            Ok(Err(error)) => Err(format!("{error:#}").chars().take(400).collect()),
            Err(_) => Err("the job timed out".to_string()),
        };
        let next_state = match &outcome {
            Ok(Some(state)) => Some(state.clone()),
            _ if spec.emulate_success => Some(emulated_state(&spec, started_thread.as_deref())),
            _ => spec.previous.clone(),
        };
        println!(
            "JOB {label} {:?}: {} request(s) in {:.1}s, {}",
            spec.lane,
            requests.len(),
            started.elapsed().as_secs_f64(),
            match &outcome {
                Ok(_) => "completed".to_string(),
                Err(error) => format!("failed: {error}"),
            }
        );
        self.turns.push(Turn {
            label,
            lane: spec.lane,
            expected: spec.expected_markers(),
            requests,
            outcome,
        });
        next_state
    }

    fn turn(&self, label: &str) -> &Turn {
        self.turns
            .iter()
            .find(|turn| turn.label == label)
            .unwrap_or_else(|| panic!("no turn {label}"))
    }
}

/// The state a successful turn saves: a thread its first run started, or the stored state's
/// thread, which a resumed run keeps.
fn emulated_state(spec: &Spec, started_thread: Option<&Path>) -> Value {
    let mut map = spec
        .previous
        .clone()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let Some(rollout) = started_thread else {
        return Value::Object(map);
    };
    let thread = rollout_thread_id(rollout).unwrap_or_default();
    let rollout = rollout.display().to_string();
    let browser =
        spec.browser_session_runtime || matches!(spec.lane, Lane::Shared(_) | Lane::Personal);
    map.insert("provider".into(), json!("codex-embedded"));
    map.insert("version".into(), json!(2));
    if browser {
        map.insert("browserThreadId".into(), json!(thread));
        map.insert("browserRolloutPath".into(), json!(rollout));
        map.insert("browserThreadRestoreFailed".into(), json!(false));
    } else {
        map.insert("defaultThreadId".into(), json!(thread));
        map.insert("threadId".into(), json!(thread));
        map.insert("defaultRolloutPath".into(), json!(rollout));
        map.insert("rolloutPath".into(), json!(rollout));
        map.insert("defaultThreadRestoreFailed".into(), json!(false));
    }
    map.insert("historyReplayRequired".into(), json!(false));
    Value::Object(map)
}

async fn serve(
    listener: TcpListener,
    app: Router,
    shutdowns: &mut Vec<oneshot::Sender<()>>,
    tasks: &mut Vec<tokio::task::JoinHandle<Result<()>>>,
) {
    let (tx, rx) = oneshot::channel::<()>();
    shutdowns.push(tx);
    tasks.push(tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .map_err(anyhow::Error::from)
    }));
}

async fn start_proxy(
    credentials: auth::Credentials,
    shutdowns: &mut Vec<oneshot::Sender<()>>,
    tasks: &mut Vec<tokio::task::JoinHandle<Result<()>>>,
) -> Result<String> {
    let port = reserve_port()?;
    let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
    let (tx, rx) = oneshot::channel::<()>();
    shutdowns.push(tx);
    tasks.push(tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_address, Some(credentials), async {
            let _ = rx.await;
        })
        .await
    }));
    wait_for_port(port).await?;
    Ok(format!("http://{proxy_address}/v1"))
}

async fn run_chains() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(
            "runtime_agent::codex=warn,runtime_agent::jobs=warn",
        ))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
    // macOS assesses a freshly linked executable on its first launch, which can outlast the
    // granted broker's startup budget (as granted_turns does, launch it once first).
    let warmed = std::process::Command::new(env!("CARGO_BIN_EXE_runtime-agent"))
        .arg("--version")
        .output()?;
    ensure!(warmed.status.success(), "runtime-agent --version failed");
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let browser_dir = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    // Give the workspace its own repository so Codex's project-doc search stops there, as it
    // does in a real space.
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&workspace)
        .output()?;
    ensure!(init.status.success(), "git init failed");
    fs::write(
        runtime_home.path().join("config.toml"),
        "model_auto_compact_token_limit = 100000\n",
    )?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-run-instructions-runtime-key"}).to_string(),
    )?;
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-run-instructions-runtime-key"),
        ("CODEX_API_KEY", "inert-run-instructions-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_PERSIST_STRUCTURED_CONVERSATION_THREAD", "true"),
        ("CODEX_SANDBOX_MODE", "workspace-write"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
        ("CODEX_RUN_TIMEOUT_SECONDS", "60"),
        ("CODEX_RETRY_BASE_DELAY_MS", "50"),
        ("INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS", "5000"),
    ] {
        set_env(key, value);
    }
    set_env("CODEX_HOME", runtime_home.path());
    set_env("CODEX_AUTH_PATH", &auth_path);
    // The Shared Browser's files, under this test's own directory; no browser listens on the
    // DevTools address, and the Playwright paths do not exist (no browser step runs).
    let closed_port = reserve_port()?;
    set_env(
        "INSTAFY_BROWSER_AGENT_CONTROL_FILE",
        browser_dir.path().join("agent-control.json"),
    );
    set_env(
        "INSTAFY_SHARED_BROWSER_APPROVAL_DIR",
        browser_dir.path().join("approvals"),
    );
    set_env(
        "INSTAFY_BROWSER_ACTIONS_FILE",
        browser_dir.path().join("actions.jsonl"),
    );
    set_env(
        "INSTAFY_PLAYWRIGHT_CDP_URL",
        format!("http://127.0.0.1:{closed_port}"),
    );
    set_env(
        "INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH",
        browser_dir.path().join("absent/playwright"),
    );
    set_env(
        "INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT",
        browser_dir.path().join("absent/node_modules"),
    );

    let provider = Arc::new(Provider {
        label: StdMutex::new(String::new()),
        scripts: StdMutex::new(HashMap::new()),
        requests: StdMutex::new(Vec::new()),
    });
    let mut shutdowns = Vec::new();
    let mut tasks = Vec::new();

    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream = listener.local_addr()?;
    let app = Router::new()
        .route("/backend-api/codex/responses", post(provider_request))
        .with_state(provider.clone());
    serve(listener, app, &mut shutdowns, &mut tasks).await;
    let endpoint = format!("http://{upstream}/backend-api/codex/responses");
    set_env("CODEX_PROXY_CHATGPT_ENDPOINT", &endpoint);
    set_env("CODEX_CHATGPT_ENDPOINT", &endpoint);

    let personal_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let personal_mcp = personal_listener.local_addr()?;
    serve(
        personal_listener,
        Router::new().route("/mcp", post(personal_browser_mcp)),
        &mut shutdowns,
        &mut tasks,
    )
    .await;

    let controller_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let controller_address = controller_listener.local_addr()?;
    serve(
        controller_listener,
        Router::new()
            .route(
                "/projects/:project_id/provider-tools/call",
                post(provider_tool_call),
            )
            .route("/search/messages", get(search_messages))
            .fallback(controller_fallback),
        &mut shutdowns,
        &mut tasks,
    )
    .await;

    let chatgpt_proxy = start_proxy(
        auth::Credentials::ChatGpt {
            access_token: PROVIDER_KEY.to_string(),
            refresh_token: None,
            account_id: Some(ACCOUNT.to_string()),
            default_model: Some("gpt-5.5".to_string()),
            auth_path: None,
        },
        &mut shutdowns,
        &mut tasks,
    )
    .await?;
    let api_key_proxy = start_proxy(
        auth::Credentials::ApiKey {
            key: PROVIDER_KEY.to_string(),
            endpoint: Some(endpoint.clone()),
            default_model: Some("gpt-5.5".to_string()),
        },
        &mut shutdowns,
        &mut tasks,
    )
    .await?;
    set_env("OPENAI_BASE_URL", &chatgpt_proxy);

    let mut harness = Harness {
        provider: provider.clone(),
        config: runtime_config(workspace_root.path(), project_id, "http://127.0.0.1:9/")?,
        granted_config: runtime_config(
            workspace_root.path(),
            project_id,
            &format!("http://{controller_address}/"),
        )?,
        project_id,
        runtime_home: runtime_home.path().to_path_buf(),
        personal_mcp,
        chatgpt_proxy,
        api_key_proxy,
        turns: Vec::new(),
    };
    run_every_chain(&mut harness).await;

    for tx in shutdowns {
        let _ = tx.send(());
    }
    for task in tasks {
        let _ = task.await;
    }
    check(&harness)
}

async fn run_every_chain(harness: &mut Harness) {
    // A and X: the card path. An ordinary turn starts the chat's default thread; the card's
    // Shared Browser turn has no browser thread of its own and resumes the default one. X is
    // another chat on the same page: X1 starts on the page A2 left, X2 on its own; then A3
    // starts on the page X left.
    let ca = Uuid::new_v4();
    let cx = Uuid::new_v4();
    let a1 = harness.run("A1", Spec::new(ca, Lane::Default, None)).await;
    let a2 = harness
        .run("A2", Spec::new(ca, Lane::Shared("page-one"), a1))
        .await;
    let x1 = harness
        .run("X1", Spec::new(cx, Lane::Shared("page-one"), None))
        .await;
    harness
        .run("X2", Spec::new(cx, Lane::Shared("page-one"), x1))
        .await;
    let a3 = harness
        .run("A3", Spec::new(ca, Lane::Shared("page-one"), a2))
        .await;
    harness.run("A4", Spec::new(ca, Lane::Default, a3)).await;

    // U: an unchanged lane on a resumed thread.
    let cu = Uuid::new_v4();
    let u1 = harness.run("U1", Spec::new(cu, Lane::Default, None)).await;
    harness.run("U2", Spec::new(cu, Lane::Default, u1)).await;

    // C: a runtime with a boot-time browser, where an ordinary turn is a browser-mode turn and
    // shares the browser thread a Shared Browser turn started.
    let cc = Uuid::new_v4();
    let c1 = harness
        .run("C1", Spec::new(cc, Lane::Shared("page-two"), None))
        .await;
    let mut c2 = Spec::new(cc, Lane::Default, c1);
    c2.browser_session_runtime = true;
    harness.run("C2", c2).await;

    // S: two Shared Browser turns on one browser thread whose run text differs (the
    // environment override stands in for the approval-start line, which this host cannot vary).
    let cs = Uuid::new_v4();
    let mut s1 = Spec::new(cs, Lane::Shared("page-three"), None);
    s1.browser_lane_override = Some((
        "Browser/UI execution run:\n- PROBE-APPROVAL-START-ASK: this run's approvals start in Ask.",
        "PROBE_ASK",
    ));
    let s1 = harness.run("S1", s1).await;
    let mut s2 = Spec::new(cs, Lane::Shared("page-three"), s1);
    s2.browser_lane_override = Some((
        "Browser/UI execution run:\n- PROBE-APPROVAL-START-ROUTINE: this run starts in routine browsing.",
        "PROBE_ROUTINE",
    ));
    harness.run("S2", s2).await;

    // D: an ordinary turn starts the default thread; a granted turn follows.
    let cd = Uuid::new_v4();
    let d1 = harness.run("D1", Spec::new(cd, Lane::Default, None)).await;
    harness.run("D2", Spec::new(cd, Lane::Granted, d1)).await;

    // E: ordinary, then MCP, Summarize and a write turn, on one default thread.
    let ce = Uuid::new_v4();
    let e1 = harness.run("E1", Spec::new(ce, Lane::Default, None)).await;
    let e2 = harness.run("E2", Spec::new(ce, Lane::Mcp, e1)).await;
    let e3 = harness.run("E3", Spec::new(ce, Lane::PlainFinal, e2)).await;
    harness.run("E4", Spec::new(ce, Lane::PlainWrite, e3)).await;

    // P: ordinary, then a Personal Browser turn (always on a thread of its own), then ordinary.
    let cp = Uuid::new_v4();
    let p1 = harness.run("P1", Spec::new(cp, Lane::Default, None)).await;
    let p2 = harness
        .run("P2", Spec::new(cp, Lane::Personal, p1.clone()))
        .await;
    harness
        .run("P3", Spec::new(cp, Lane::Default, p2.or(p1)))
        .await;

    // K: native compaction. K2 (Summarize) compacts mid-turn; K3 (ordinary) follows and ends
    // above the compaction limit; K4 (a card's Shared Browser turn) compacts before it starts.
    let ck = Uuid::new_v4();
    let k1 = harness.run("K1", Spec::new(ck, Lane::Default, None)).await;
    let mut k2 = Spec::new(ck, Lane::PlainFinal, k1);
    k2.script = vec![Step::ExecCommand {
        total_tokens: 200_000,
    }];
    let k2 = harness.run("K2", k2).await;
    let mut k3 = Spec::new(ck, Lane::Default, k2);
    k3.script = vec![Step::Final {
        total_tokens: 200_000,
    }];
    let k3 = harness.run("K3", k3).await;
    let k4 = harness
        .run("K4", Spec::new(ck, Lane::Shared("page-four"), k3))
        .await;
    harness.run("K5", Spec::new(ck, Lane::Default, k4)).await;

    // R: a turn on a resumed thread fails before the model answers; the person's retry follows.
    let cr = Uuid::new_v4();
    let r1 = harness.run("R1", Spec::new(cr, Lane::Default, None)).await;
    let mut r5 = Spec::new(cr, Lane::PlainFinal, r1);
    r5.script = vec![Step::Fail502; 2];
    let r5 = harness.run("R5", r5).await;
    harness.run("R6", Spec::new(cr, Lane::PlainFinal, r5)).await;

    // T: the API-key transport, a fresh thread and a resumed lane change.
    let ct = Uuid::new_v4();
    let mut t1 = Spec::new(ct, Lane::Default, None);
    t1.api_key = true;
    let t1 = harness.run("T1", t1).await;
    let mut t2 = Spec::new(ct, Lane::PlainFinal, t1);
    t2.api_key = true;
    harness.run("T2", t2).await;
}

fn item_text(item: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = item["content"].as_array() {
        for part in content {
            if let Some(text) = part["text"].as_str() {
                parts.push(text.to_string());
            }
        }
    }
    for key in ["output", "arguments", "encrypted_content"] {
        match &item[key] {
            Value::String(text) => parts.push(text.clone()),
            Value::Array(values) => {
                for value in values {
                    if let Some(text) = value["text"].as_str() {
                        parts.push(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    parts.join("\n")
}

/// I(r): the text of a request's `input[0]`, the user-role message the proxy builds from every
/// developer message of the request and Codex's instructions.
fn instructions_text(request: &Value) -> String {
    let first = &request["input"][0];
    assert_eq!(
        first["role"], "user",
        "the proxy puts the instructions first"
    );
    item_text(first)
}

/// Each tagged block's body, in order.
fn blocks<'a>(text: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(close) else {
            break;
        };
        found.push(after[..end].trim());
        rest = &after[end + close.len()..];
    }
    found
}

fn run_blocks(request: &Value) -> Vec<String> {
    blocks(&instructions_text(request), RUN_OPEN, RUN_CLOSE)
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn note_blocks(request: &Value) -> Vec<String> {
    blocks(&instructions_text(request), NOTE_OPEN, NOTE_CLOSE)
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn count(text: &str, marker: &str) -> usize {
    text.matches(needle(marker)).count()
}

/// The requests that sample under the turn's run text: a remote compaction request summarizes
/// the thread's history as it was before this turn's context was recorded.
fn sampling_requests(turn: &Turn) -> impl Iterator<Item = (usize, &Value)> {
    turn.requests
        .iter()
        .enumerate()
        .filter(|(_, request)| !is_compaction_request(request))
}

fn first_sampling_request(turn: &Turn) -> &Value {
    sampling_requests(turn)
        .next()
        .map(|(_, request)| request)
        .unwrap_or_else(|| panic!("{} made no sampling request", turn.label))
}

fn check(harness: &Harness) -> Result<()> {
    for turn in &harness.turns {
        ensure!(
            sampling_requests(turn).next().is_some(),
            "{} ({:?}) made no sampling request: {:?}",
            turn.label,
            turn.lane,
            turn.outcome
        );
    }
    // Turns that must complete do. R5 fails before the model answers.
    for label in [
        "A1", "A4", "U1", "U2", "C2", "D1", "E1", "E3", "P1", "P3", "K1", "K2", "K3", "K5", "R1",
        "R6", "T1", "T2",
    ] {
        let turn = harness.turn(label);
        ensure!(turn.outcome.is_ok(), "{label} failed: {:?}", turn.outcome);
    }
    ensure!(
        harness.turn("R5").outcome.is_err(),
        "R5 must fail before the model answers"
    );

    // Phase 1: every request reads its own run's text.
    for turn in &harness.turns {
        for (index, request) in sampling_requests(turn) {
            let text = instructions_text(request);
            let missing: Vec<String> = turn
                .expected
                .iter()
                .filter(|marker| count(&text, marker) == 0)
                .map(|marker| format!("{marker} occurs 0 times"))
                .collect();
            ensure!(
                missing.is_empty(),
                "{}#{index} ({:?}) does not read its run's instructions: {}",
                turn.label,
                turn.lane,
                missing.join(", ")
            );
        }
    }

    // Phase 2: how the text is delivered.
    for turn in &harness.turns {
        for (index, request) in turn.requests.iter().enumerate() {
            // (i) Only inside input[0]: Codex sent them as developer messages.
            for (position, item) in request["input"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .skip(1)
            {
                let text = item_text(item);
                ensure!(
                    !text.contains(RUN_OPEN) && !text.contains(NOTE_OPEN),
                    "{}#{index}: input[{position}] carries run instructions outside the instruction message",
                    turn.label
                );
            }
        }
        for (index, request) in sampling_requests(turn) {
            let blocks = run_blocks(request);
            let last = blocks
                .last()
                .with_context(|| format!("{}#{index} carries no run instructions", turn.label))?;
            // (ii) The last block is this run's text and nothing of another run's.
            for (marker, _) in MARKERS {
                ensure!(
                    (count(last, marker) > 0) == turn.expected.contains(marker),
                    "{}#{index}: the last run block {} {marker}",
                    turn.label,
                    if turn.expected.contains(marker) {
                        "lacks"
                    } else {
                        "carries"
                    }
                );
            }
            // (iii) A block after others replaces them.
            ensure!(
                blocks.len() == 1 || last.starts_with(REPLACE),
                "{}#{index}: the last of {} run blocks does not replace the earlier ones",
                turn.label,
                blocks.len()
            );
        }
    }

    // (iv) How many blocks a thread holds at each turn's first request: one per change of run
    // text, and none added when it stays the same.
    for (label, expected) in [
        ("A1", 1),
        ("A2", 2),
        ("X1", 1),
        ("X2", 1),
        ("A3", 2),
        ("A4", 3),
        ("U1", 1),
        ("U2", 1),
        ("C1", 1),
        ("C2", 2),
        ("S1", 1),
        ("S2", 2),
        ("D1", 1),
        ("D2", 2),
        ("E1", 1),
        ("E2", 2),
        ("E3", 3),
        ("E4", 4),
        ("P1", 1),
        ("P2", 1),
        ("P3", 1),
        ("K1", 1),
        ("K2", 2),
        ("K3", 2),
        ("K5", 2),
        ("R1", 1),
        ("R5", 2),
        ("R6", 2),
        ("T1", 1),
        ("T2", 2),
    ] {
        let blocks = run_blocks(first_sampling_request(harness.turn(label)));
        ensure!(
            blocks.len() == expected,
            "{label}'s first request holds {} run blocks, not {expected}",
            blocks.len()
        );
    }
    // An unchanged turn leaves the instructions exactly as they were: the cached prefix stays.
    let u1 = harness.turn("U1");
    let u2 = harness.turn("U2");
    ensure!(
        instructions_text(first_sampling_request(u2))
            == instructions_text(u1.requests.last().expect("U1 request")),
        "U2 changed the thread's instructions"
    );
    let u1_state = u1
        .outcome
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .context("U1 state")?;
    let u2_state = u2
        .outcome
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .context("U2 state")?;
    ensure!(u2_state["defaultThreadRestoreSource"] == "rollout");
    ensure!(u2_state["defaultThreadId"] == u1_state["defaultThreadId"]);
    // A Personal Browser turn runs on a thread of its own and leaves the chat's thread as it was.
    let p3 = harness.turn("P3");
    for request in &p3.requests {
        ensure!(
            count(&request["input"].to_string(), "PERSONAL_POLICY") == 0,
            "P3 reads the Personal Browser policy"
        );
    }
    // Native compaction: K2 compacts mid-turn and goes on with its own text alone; K4 compacts
    // before it starts and then reads its own text alone.
    for (label, compaction_index) in [("K2", 1), ("K4", 0)] {
        let turn = harness.turn(label);
        ensure!(
            turn.requests
                .get(compaction_index)
                .is_some_and(is_compaction_request),
            "{label}#{compaction_index} is not a compaction request"
        );
        let after = turn
            .requests
            .iter()
            .find(|request| carries_compaction(request) && !is_compaction_request(request))
            .with_context(|| format!("{label} made no request after its compaction"))?;
        let blocks = run_blocks(after);
        ensure!(
            blocks.len() == 1 && !blocks[0].starts_with(REPLACE),
            "{label}'s first request after its compaction holds {} run blocks: {blocks:?}",
            blocks.len()
        );
    }
    // A retry of a failed turn neither repeats nor loses that turn's text.
    for request in &harness.turn("R5").requests {
        ensure!(
            run_blocks(request).len() == 2,
            "an R5 request holds other than 2 run blocks"
        );
    }
    ensure!(
        count(
            &instructions_text(first_sampling_request(harness.turn("R6"))),
            "PLAIN_FINAL"
        ) == 1,
        "R6 reads the focused lane's text other than once"
    );

    // (v) A note holds for its turn only.
    for turn in &harness.turns {
        let expected = match turn.label {
            "X1" | "A3" => 1,
            "X2" | "A4" => 2,
            _ => 0,
        };
        for (index, request) in sampling_requests(turn) {
            let notes = note_blocks(request);
            ensure!(
                notes.len() == expected,
                "{}#{index} holds {} turn notes, not {expected}",
                turn.label,
                notes.len()
            );
            let last = notes.last().map(String::as_str);
            match turn.label {
                "X1" | "A3" => ensure!(
                    last.is_some_and(|note| count(note, "PAGE_LEFT_LINE") == 1),
                    "{}#{index}: the turn is not told that another chat left its page",
                    turn.label
                ),
                "X2" | "A4" => ensure!(
                    last == Some(NOTE_WITHDRAWAL),
                    "{}#{index}: the earlier turn's note is not withdrawn",
                    turn.label
                ),
                _ => {}
            }
        }
    }
    println!("every turn read its own run instructions");
    Ok(())
}
