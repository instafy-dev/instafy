use std::convert::Infallible;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use axum::routing::post;
use futures_util::stream;
use openai_proxy_server::{auth, proxy};
use reqwest::Url;
use runtime_agent::codex::{CodexClient, CodexRunOptions};
use runtime_agent::config::Config;
use runtime_agent::controller::{LeaseJob, Registration};
use runtime_agent::jobs::{
    JobProcessor, extract_job_failure_artifacts, extract_job_failure_message,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::sync::oneshot;
use tokio::time::{Instant, sleep};
use uuid::Uuid;

static ENV_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

async fn env_guard() -> tokio::sync::MutexGuard<'static, ()> {
    ENV_MUTEX.get_or_init(|| Mutex::new(())).lock().await
}

struct EnvGuard {
    key: String,
    old: Option<String>,
}

impl EnvGuard {
    fn set(key: &str, value: impl AsRef<str>) -> Self {
        let old = std::env::var(key).ok();
        unsafe { std::env::set_var(key, value.as_ref()) };
        Self {
            key: key.to_string(),
            old,
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(ref value) = self.old {
            unsafe { std::env::set_var(&self.key, value) };
        } else {
            unsafe { std::env::remove_var(&self.key) };
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

const PROXY_RESPONSE_FIXTURE: &str = include_str!("fixtures/proxy_responses_success.sse");

#[derive(Clone, Copy)]
enum StubResponse {
    Success,
    HttpError(u16),
}

struct StubState {
    workspace: PathBuf,
    expected_token: String,
    expected_account_id: Option<String>,
    responses: Vec<StubResponse>,
    request_index: AtomicUsize,
}

impl StubState {
    fn new(
        workspace: PathBuf,
        expected_token: String,
        expected_account_id: Option<String>,
        responses: Vec<StubResponse>,
    ) -> Self {
        assert!(
            !responses.is_empty(),
            "stub server must be configured with at least one response"
        );
        Self {
            workspace,
            expected_token,
            expected_account_id,
            responses,
            request_index: AtomicUsize::new(0),
        }
    }

    fn next_response(&self) -> StubResponse {
        let index = self.request_index.fetch_add(1, Ordering::SeqCst);
        *self
            .responses
            .get(index)
            .or_else(|| self.responses.last())
            .expect("stub responses configuration missing fallback")
    }
}

async fn spawn_stub_chatgpt_server_with_responses(
    workspace: PathBuf,
    expected_token: String,
    expected_account_id: Option<String>,
    responses: Vec<StubResponse>,
) -> Result<(SocketAddr, oneshot::Sender<()>, Arc<StubState>)> {
    let state = Arc::new(StubState::new(
        workspace,
        expected_token,
        expected_account_id,
        responses,
    ));
    let app = Router::new()
        .route("/backend-api/codex/responses", post(handle_stub_chatgpt))
        .with_state(state.clone());

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("failed to bind stub ChatGPT listener")?;
    let addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        {
            eprintln!("[proxy-integration] stub ChatGPT server exited with error: {error}");
        }
    });

    Ok((addr, shutdown_tx, state))
}

async fn spawn_stub_chatgpt_server(
    workspace: PathBuf,
    expected_token: String,
    expected_account_id: Option<String>,
) -> Result<(SocketAddr, oneshot::Sender<()>)> {
    let (addr, shutdown, _) = spawn_stub_chatgpt_server_with_responses(
        workspace,
        expected_token,
        expected_account_id,
        vec![StubResponse::Success],
    )
    .await?;
    Ok((addr, shutdown))
}

async fn handle_stub_chatgpt(
    State(state): State<Arc<StubState>>,
    headers: HeaderMap,
    Json(_payload): Json<Value>,
) -> impl IntoResponse {
    println!("[stub] received proxy request");
    let expected_header = format!("Bearer {}", state.expected_token);
    let auth_value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    println!(
        "[stub] auth header present: {}",
        if auth_value.is_empty() { "no" } else { "yes" }
    );
    assert_eq!(
        auth_value, expected_header,
        "proxy forwarded unexpected authorization header"
    );
    let account_id_header = headers
        .get("chatgpt-account-id")
        .or_else(|| headers.get("ChatGPT-Account-Id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|value| !value.is_empty());
    println!(
        "[stub] account id header: {:?} (expected {:?})",
        account_id_header, state.expected_account_id
    );
    match (&state.expected_account_id, account_id_header.as_ref()) {
        (Some(expected), Some(actual)) => assert_eq!(
            actual, expected,
            "proxy forwarded unexpected chatgpt account id header"
        ),
        (None, None) => {}
        (None, Some(actual)) => panic!(
            "proxy forwarded unexpected chatgpt account id header: {}",
            actual
        ),
        (Some(expected), None) => panic!(
            "proxy omitted chatgpt account id header; expected {}",
            expected
        ),
    }
    match state.next_response() {
        StubResponse::Success => {
            let target_file = state.workspace.join("abc.md");
            if let Some(parent) = target_file.parent() {
                if let Err(error) = fs::create_dir_all(parent) {
                    panic!("failed to prepare stub workspace directory: {error}");
                }
            }
            if let Err(error) = fs::write(&target_file, "xyz\n") {
                panic!(
                    "failed to write stub file {}: {error}",
                    target_file.display()
                );
            }
            println!(
                "[stub] wrote file {} exists={}",
                target_file.display(),
                target_file.exists()
            );

            let payloads = load_fixture_payloads();

            let stream = stream::iter(payloads.into_iter().map(|payload| {
                println!("[stub] sending data: {}", payload);
                Ok::<Event, Infallible>(Event::default().data(payload))
            }));

            Sse::new(stream).into_response()
        }
        StubResponse::HttpError(code) => {
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (
                status,
                Json(json!({
                    "error": format!("stubbed failure with status {code}")
                })),
            )
                .into_response()
        }
    }
}

fn load_fixture_payloads() -> Vec<String> {
    PROXY_RESPONSE_FIXTURE
        .split("\n\n")
        .filter_map(|chunk| {
            let data = chunk
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(|value| value.trim()))
                .collect::<Vec<_>>();

            if data.is_empty() {
                return None;
            }

            Some(data.join("\n"))
        })
        .collect()
}

fn count_playwright_cli_command_executions(artifacts: &[Value]) -> usize {
    artifacts
        .iter()
        .filter(|artifact| {
            artifact
                .get("kind")
                .and_then(Value::as_str)
                .map(|kind| kind == "codex/run-log")
                .unwrap_or(false)
        })
        .flat_map(|artifact| {
            artifact
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter(|event| is_playwright_cli_command_execution_event(event))
        .count()
}

fn count_playwright_cli_command_executions_in_events(events: &[Value]) -> usize {
    events
        .iter()
        .filter(|event| is_playwright_cli_command_execution_event(event))
        .count()
}

fn count_command_executions_in_events(events: &[Value]) -> usize {
    events
        .iter()
        .filter(|event| {
            event
                .pointer("/item/type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "command_execution")
        })
        .count()
}

fn is_playwright_cli_command_execution_event(event: &Value) -> bool {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        event_type,
        "item.started" | "item.updated" | "item.completed"
    ) {
        return false;
    }

    let Some(item) = event.get("item").and_then(Value::as_object) else {
        return false;
    };
    if item
        .get("type")
        .and_then(Value::as_str)
        .map(|kind| kind != "command_execution")
        .unwrap_or(true)
    {
        return false;
    }

    // Heuristic: Playwright CLI runs connect to the shared headed browser via CDP.
    // Detect the CDP attach snippet in the logged command payload.
    serde_json::to_string(event)
        .unwrap_or_default()
        .contains("connectOverCDP")
}

fn count_mcp_tool_calls_in_events_by_tool_prefix(events: &[Value], tool_prefix: &str) -> usize {
    events
        .iter()
        .filter(|event| {
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(
                event_type,
                "item.started" | "item.updated" | "item.completed"
            ) {
                return false;
            }

            let Some(item) = event.get("item").and_then(Value::as_object) else {
                return false;
            };
            if item
                .get("type")
                .and_then(Value::as_str)
                .map(|kind| kind != "mcp_tool_call")
                .unwrap_or(true)
            {
                return false;
            }

            item.get("tool")
                .and_then(Value::as_str)
                .map(|tool| tool.to_ascii_lowercase().starts_with(tool_prefix))
                .unwrap_or(false)
        })
        .count()
}

fn dump_codex_events_tail(label: &str, events: &[Value]) {
    let total_events = events.len();
    let playwright_cli_calls = count_playwright_cli_command_executions_in_events(events);
    let tail = events
        .iter()
        .rev()
        .take(12)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    eprintln!(
        "[{label}] events={} playwright_cli_calls={} tail={}",
        total_events,
        playwright_cli_calls,
        serde_json::to_string_pretty(&tail).unwrap_or_else(|_| "[]".to_string())
    );
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\"', "\\\"")
}

fn extract_browser_thread_id(state: &Value) -> Option<String> {
    state
        .as_object()
        .and_then(|map| map.get("browserThreadId").or_else(|| map.get("threadId")))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn dump_job_failure_debug(error: &anyhow::Error) {
    if let Some(message) = extract_job_failure_message(error) {
        eprintln!("[live-browser-sim] structured failure message: {message}");
    }
    let Some(artifacts) = extract_job_failure_artifacts(error) else {
        eprintln!("[live-browser-sim] no structured artifacts attached to failure");
        return;
    };
    eprintln!(
        "[live-browser-sim] structured artifacts: {} (playwright_cli_calls={})",
        artifacts.len(),
        count_playwright_cli_command_executions(artifacts)
    );
    let artifact_kinds = artifacts
        .iter()
        .filter_map(|artifact| {
            artifact
                .get("kind")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    eprintln!("[live-browser-sim] artifact kinds: {:?}", artifact_kinds);

    let mut codex_log_found = false;
    for artifact in artifacts.iter() {
        if artifact
            .get("kind")
            .and_then(Value::as_str)
            .map(|kind| kind == "codex/run-log")
            .unwrap_or(false)
        {
            codex_log_found = true;
            if let Some(events) = artifact.get("events").and_then(Value::as_array) {
                let total_events = events.len();
                let tail = events
                    .iter()
                    .rev()
                    .take(8)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>();
                eprintln!(
                    "[live-browser-sim] codex/run-log events={} tail={}",
                    total_events,
                    serde_json::to_string_pretty(&tail).unwrap_or_else(|_| "[]".to_string())
                );
            }
        } else {
            eprintln!(
                "[live-browser-sim] artifact detail: {}",
                serde_json::to_string_pretty(artifact).unwrap_or_else(|_| "{}".to_string())
            );
        }
    }
    if !codex_log_found {
        eprintln!("[live-browser-sim] no codex/run-log artifact found");
    }
}

fn locate_codex_home() -> Result<PathBuf> {
    let home = std::env::var("HOME").context("$HOME environment variable is not set")?;
    let source_dir = Path::new(&home).join(".codex");
    let source_auth = source_dir.join("auth.json");

    if !source_auth.exists() {
        anyhow::bail!(
            "Codex credentials not found at {}; run `codex login` before executing this test.",
            source_auth.display()
        );
    }

    Ok(source_dir)
}

fn reserve_port() -> Result<u16> {
    let socket = std::net::TcpListener::bind(("127.0.0.1", 0))
        .context("failed to bind ephemeral port for proxy")?;
    let port = socket.local_addr()?.port();
    drop(socket);
    Ok(port)
}

async fn wait_for_port(port: u16) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if Instant::now() > deadline {
            anyhow::bail!(
                "proxy did not start listening on port {} within timeout",
                port
            );
        }

        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(stream) => {
                drop(stream);
                return Ok(());
            }
            Err(_) => sleep(Duration::from_millis(100)).await,
        }
    }
}

#[test]
fn codex_embedded_via_proxy_creates_file() -> Result<()> {
    const STACK_SIZE: usize = 32 * 1024 * 1024;
    let handle = std::thread::Builder::new()
        .name("codex-embedded-proxy-test".to_string())
        .stack_size(STACK_SIZE)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(STACK_SIZE)
                .build()
                .expect("failed to build tokio runtime for proxy test");
            runtime.block_on(codex_embedded_via_proxy_creates_file_inner())
        })
        .context("failed to spawn proxy test thread")?;

    handle
        .join()
        .map_err(|_| anyhow::anyhow!("proxy test thread panicked"))?
}

async fn codex_embedded_via_proxy_creates_file_inner() -> Result<()> {
    let _env_guard = env_guard().await;
    let codex_home = locate_codex_home()?;
    let auth_path = codex_home.join("auth.json");

    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;
    let tokens = proxy_auth_json
        .get("tokens")
        .and_then(Value::as_object)
        .context("auth.json missing tokens; run `codex login`")?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .context("auth.json tokens missing access_token; run `codex login`")?;
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Value::Object(ref mut obj) = proxy_auth_json {
        obj.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)
        .context("failed to write sanitized proxy auth.json")?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{}", proxy_port)
        .parse()
        .context("failed to parse proxy address")?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let credentials = auth::load_credentials(Some(&proxy_auth_path))
        .context("failed to load Codex credentials")?;

    let workspace_dir = TempDir::new().context("failed to create workspace directory")?;
    let _workspace_root = workspace_dir.path().to_path_buf();
    let runtime_codex_home =
        TempDir::new().context("failed to create temporary runtime Codex home directory")?;
    let runtime_auth_path = runtime_codex_home.path().join("auth.json");
    fs::write(
        &runtime_auth_path,
        json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
    )
    .context("failed to write runtime auth.json with dummy API key")?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn({
        let proxy_credentials = credentials.clone();
        async move {
            proxy::run_proxy_with_shutdown(proxy_addr, Some(proxy_credentials), async move {
                let _ = shutdown_rx.await;
            })
            .await
        }
    });
    let proxy_guard = ChildGuard::new(shutdown_tx);

    wait_for_port(proxy_port).await?;

    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_codex_api_key = EnvGuard::set("CODEX_API_KEY", "integration-proxy-dummy-key");
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_project = EnvGuard::set("SPACE_ID", project_id.to_string());
    let _guard_workspace = EnvGuard::set(
        "WORKSPACE_DIR",
        _workspace_root.as_os_str().to_string_lossy(),
    );
    let _guard_runtime_type = EnvGuard::set("RUNTIME_TYPE", "integration-runtime");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "integration-test");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home = EnvGuard::set(
        "CODEX_HOME",
        runtime_codex_home.path().as_os_str().to_string_lossy(),
    );
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_auth_path.as_os_str().to_string_lossy(),
    );

    let config = Config::from_env().context("failed to load runtime-agent config in test")?;
    let config = std::sync::Arc::new(config);
    let processor = JobProcessor::new(config.clone());

    let project_workspace = config.workspace_root.join(project_id.to_string());
    fs::create_dir_all(&project_workspace).with_context(|| {
        format!(
            "failed to prepare project workspace {:?}",
            project_workspace
        )
    })?;

    let (stub_addr, stub_shutdown) = spawn_stub_chatgpt_server(
        project_workspace.clone(),
        access_token.clone(),
        account_id.clone(),
    )
    .await
    .context("failed to start stub ChatGPT server")?;
    let stub_guard = ChildGuard::new(stub_shutdown);
    let stub_base = format!("http://{}", stub_addr);
    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("{}/backend-api/codex/responses", stub_base),
    );
    let _guard_proxy_chatgpt_endpoint = EnvGuard::set(
        "CODEX_PROXY_CHATGPT_ENDPOINT",
        format!("{}/backend-api/codex/responses", stub_base),
    );

    let registration = registration_for_live(runtime_id);

    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let prompt = "Create a markdown file named abc.md that contains only the text \"xyz\". Overwrite existing content if needed.";

    let job = LeaseJob {
        id: job_id,
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(run_id),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": prompt,
            "metadata": {
                "execution_mode": "apply",
                "runtimeExpectations": {
                    "workspaceFileChanges": true
                }
            }
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
    };

    let execution = tokio::time::timeout(
        Duration::from_secs(300),
        processor.run_apply_job(&registration, &job, true, None, None, None),
    )
    .await
    .context("proxy-backed embedded job timed out")?
    .map_err(|error| {
        eprintln!("[test] run_apply_job error: {error}");
        eprintln!("[test] run_apply_job debug: {error:?}");
        for (idx, cause) in error.chain().enumerate() {
            eprintln!("[test]   cause {idx}: {cause}");
        }
        error
    })
    .context("proxy-backed embedded job failed")?;

    assert_eq!(
        execution.summary, "Created abc.md with the requested contents.",
        "stub run should surface the fixture-provided summary"
    );

    let apply_artifact = execution
        .artifacts
        .iter()
        .find(|artifact| {
            artifact
                .get("kind")
                .and_then(|value| value.as_str())
                .map(|kind| kind == "apply/files")
                .unwrap_or(false)
        })
        .unwrap_or_else(|| {
            eprintln!("[test] execution artifacts: {:#?}", execution.artifacts);
            panic!(
                "apply/files artifact missing from execution metadata: {:?}",
                execution.artifacts
            )
        });

    let files = apply_artifact
        .get("files")
        .and_then(|value| value.as_array())
        .unwrap_or_else(|| {
            panic!(
                "apply/files artifact missing files array: {:?}",
                apply_artifact
            )
        });
    assert_eq!(
        files.len(),
        1,
        "apply/files artifact should include a single file description: {:?}",
        files
    );

    let file_entry = &files[0];
    let file_path = file_entry
        .get("path")
        .and_then(|value| value.as_str())
        .expect("apply/files entry missing path");
    assert_eq!(
        file_path, "abc.md",
        "unexpected file path in apply artifact"
    );

    let workspace_path = file_entry
        .get("workspacePath")
        .and_then(|value| value.as_str())
        .expect("apply/files entry missing workspacePath");
    assert_eq!(
        workspace_path, "abc.md",
        "apply/files entry target workspace path mismatch"
    );

    let change_type = file_entry
        .get("change")
        .and_then(|value| value.get("type"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            file_entry
                .get("changeType")
                .and_then(|value| value.as_str())
        })
        .unwrap_or_else(|| {
            panic!(
                "apply/files entry missing change metadata: {:?}",
                file_entry
            )
        });
    assert_eq!(
        change_type, "created",
        "apply/files entry should record a created change: {:?}",
        file_entry
    );

    drop(stub_guard);
    drop(proxy_guard);

    let proxy_result = proxy_task
        .await
        .context("proxy task join failed")?
        .context("proxy server returned error");
    proxy_result?;

    Ok(())
}

#[test]
fn codex_embedded_retries_after_stream_error() -> Result<()> {
    const STACK_SIZE: usize = 32 * 1024 * 1024;
    let handle = std::thread::Builder::new()
        .name("codex-embedded-retry-test".to_string())
        .stack_size(STACK_SIZE)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(STACK_SIZE)
                .build()
                .expect("failed to build tokio runtime for retry test");
            runtime.block_on(codex_embedded_retries_after_stream_error_inner())
        })
        .context("failed to spawn retry test thread")?;

    handle
        .join()
        .map_err(|_| anyhow::anyhow!("retry test thread panicked"))?
}

async fn codex_embedded_retries_after_stream_error_inner() -> Result<()> {
    let _env_guard = env_guard().await;
    let codex_home = locate_codex_home()?;
    let auth_path = codex_home.join("auth.json");

    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;
    let tokens = proxy_auth_json
        .get("tokens")
        .and_then(Value::as_object)
        .context("auth.json missing tokens; run `codex login`")?;
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .context("auth.json tokens missing access_token; run `codex login`")?;
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Value::Object(ref mut obj) = proxy_auth_json {
        obj.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)
        .context("failed to write sanitized proxy auth.json")?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{}", proxy_port)
        .parse()
        .context("failed to parse proxy address")?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let credentials = auth::load_credentials(Some(&proxy_auth_path))
        .context("failed to load Codex credentials")?;

    let workspace_dir = TempDir::new().context("failed to create workspace directory")?;
    let workspace_root = workspace_dir.path().to_path_buf();
    let runtime_codex_home =
        TempDir::new().context("failed to create temporary runtime Codex home directory")?;
    let runtime_auth_path = runtime_codex_home.path().join("auth.json");
    let runtime_auth_mode = std::env::var("LIVE_BROWSER_DIRECT_AUTH_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "api_key".to_string());
    if runtime_auth_mode == "chatgpt_tokens" {
        let mut runtime_auth_json = proxy_auth_json.clone();
        if let Value::Object(ref mut obj) = runtime_auth_json {
            obj.remove("OPENAI_API_KEY");
        }
        fs::write(
            &runtime_auth_path,
            serde_json::to_string(&runtime_auth_json)?,
        )
        .context("failed to write runtime auth.json with chatgpt tokens")?;
    } else {
        fs::write(
            &runtime_auth_path,
            json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
        )
        .context("failed to write runtime auth.json with dummy API key")?;
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn({
        let proxy_credentials = credentials.clone();
        async move {
            proxy::run_proxy_with_shutdown(proxy_addr, Some(proxy_credentials), async move {
                let _ = shutdown_rx.await;
            })
            .await
        }
    });
    let proxy_guard = ChildGuard::new(shutdown_tx);

    wait_for_port(proxy_port).await?;

    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_codex_api_key = EnvGuard::set("CODEX_API_KEY", "integration-proxy-dummy-key");
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_project = EnvGuard::set("SPACE_ID", project_id.to_string());
    let _guard_workspace = EnvGuard::set(
        "WORKSPACE_DIR",
        workspace_root.as_os_str().to_string_lossy(),
    );
    let _guard_runtime_type = EnvGuard::set("RUNTIME_TYPE", "integration-runtime");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "integration-test");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home = EnvGuard::set(
        "CODEX_HOME",
        runtime_codex_home.path().as_os_str().to_string_lossy(),
    );
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_auth_path.as_os_str().to_string_lossy(),
    );

    let config = Config::from_env().context("failed to load runtime-agent config in retry test")?;
    let config = std::sync::Arc::new(config);
    let processor = JobProcessor::new(config.clone());

    let project_workspace = config.workspace_root.join(project_id.to_string());
    fs::create_dir_all(&project_workspace).with_context(|| {
        format!(
            "failed to prepare project workspace {:?}",
            project_workspace
        )
    })?;

    let (stub_addr, stub_shutdown, stub_state) = spawn_stub_chatgpt_server_with_responses(
        project_workspace.clone(),
        access_token.clone(),
        account_id.clone(),
        vec![StubResponse::HttpError(502), StubResponse::Success],
    )
    .await
    .context("failed to start stub ChatGPT server with retry behavior")?;
    let stub_guard = ChildGuard::new(stub_shutdown);
    let stub_base = format!("http://{}", stub_addr);
    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("{}/backend-api/codex/responses", stub_base),
    );
    let _guard_proxy_chatgpt_endpoint = EnvGuard::set(
        "CODEX_PROXY_CHATGPT_ENDPOINT",
        format!("{}/backend-api/codex/responses", stub_base),
    );

    let registration = registration_for_live(runtime_id);

    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let prompt = "Create a markdown file named abc.md that contains only the text \"xyz\". Overwrite existing content if needed.";

    let job = LeaseJob {
        id: job_id,
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(run_id),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": prompt,
            "metadata": {
                "execution_mode": "apply"
            }
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
    };

    let execution = tokio::time::timeout(
        Duration::from_secs(300),
        processor.run_apply_job(&registration, &job, true, None, None, None),
    )
    .await
    .context("retry scenario job timed out")?
    .map_err(|error| {
        eprintln!("[retry-test] run_apply_job error: {error}");
        eprintln!("[retry-test] run_apply_job debug: {error:?}");
        for (idx, cause) in error.chain().enumerate() {
            eprintln!("[retry-test]   cause {idx}: {cause}");
        }
        error
    })
    .context("retry scenario job failed")?;

    assert_eq!(
        execution.summary, "Created abc.md with the requested contents.",
        "retry scenario should still surface the fixture-provided summary"
    );

    let request_attempts = stub_state.request_index.load(Ordering::SeqCst);
    assert!(
        request_attempts >= 2,
        "proxy should have been retried at least once, observed {} request(s)",
        request_attempts
    );

    let generated_file = project_workspace.join("abc.md");
    assert!(
        generated_file.exists(),
        "retry scenario did not create expected file at {}",
        generated_file.display()
    );

    drop(stub_guard);
    drop(proxy_guard);

    let proxy_result = proxy_task
        .await
        .context("proxy task join failed")?
        .context("proxy server returned error");
    proxy_result?;

    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_proxy_live_creates_file() -> Result<()> {
    let _env_guard = env_guard().await;
    if std::env::var("RUN_LIVE_PROXY_TEST").ok().as_deref() != Some("1") {
        eprintln!(
            "[live-proxy-test] skipping (set RUN_LIVE_PROXY_TEST=1 to enable this integration check)"
        );
        return Ok(());
    }

    let auth_path = locate_codex_home()?.join("auth.json");
    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;

    let tokens = proxy_auth_json
        .get("tokens")
        .and_then(Value::as_object)
        .context("auth.json missing tokens; run `codex login`")?;
    if tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .is_none()
    {
        eprintln!(
            "[live-proxy-test] skipping (auth.json tokens missing access_token; run `codex login`)",
        );
        return Ok(());
    }

    if let Value::Object(ref mut obj) = proxy_auth_json {
        obj.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)
        .context("failed to write sanitized proxy auth.json")?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{proxy_port}")
        .parse()
        .context("failed to parse proxy address")?;

    let credentials = auth::load_credentials(Some(&proxy_auth_path))
        .context("failed to load Codex credentials")?;

    let workspace_dir = TempDir::new().context("failed to create workspace directory")?;
    let workspace_root = workspace_dir.path().to_path_buf();
    let runtime_codex_home =
        TempDir::new().context("failed to create temporary runtime Codex home directory")?;
    let runtime_auth_path = runtime_codex_home.path().join("auth.json");
    fs::write(
        &runtime_auth_path,
        json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
    )
    .context("failed to write runtime auth.json with dummy API key")?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn({
        let credentials = credentials.clone();
        async move {
            proxy::run_proxy_with_shutdown(proxy_addr, Some(credentials), async move {
                let _ = shutdown_rx.await;
            })
            .await
        }
    });
    let proxy_guard = ChildGuard::new(shutdown_tx);

    wait_for_port(proxy_port).await?;

    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{proxy_addr}/backend-api/codex/responses"),
    );
    let _guard_proxy_endpoint = EnvGuard::set("CODEX_PROXY_CHATGPT_ENDPOINT", "");
    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_openai_api_key = EnvGuard::set("OPENAI_API_KEY", "integration-proxy-dummy-key");
    let _guard_workspace = EnvGuard::set(
        "WORKSPACE_DIR",
        workspace_root.as_os_str().to_string_lossy(),
    );
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let _guard_project = EnvGuard::set("SPACE_ID", project_id.to_string());
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_runtime_type = EnvGuard::set("RUNTIME_TYPE", "integration-runtime-live");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "integration-test-live");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home = EnvGuard::set(
        "CODEX_HOME",
        runtime_codex_home.path().as_os_str().to_string_lossy(),
    );
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_auth_path.as_os_str().to_string_lossy(),
    );

    let config = Config::from_env().context("failed to load runtime-agent config in live test")?;
    let config = std::sync::Arc::new(config);
    let processor = JobProcessor::new(config.clone());

    let project_workspace = config.workspace_root.join(project_id.to_string());
    fs::create_dir_all(&project_workspace).with_context(|| {
        format!(
            "failed to prepare live project workspace {:?}",
            project_workspace
        )
    })?;

    let job_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let prompt = "Create a markdown file named abc.md that contains only the text \"xyz\". Overwrite existing content if needed.";

    let job = LeaseJob {
        id: job_id,
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(run_id),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": prompt,
            "metadata": {
                "execution_mode": "apply"
            }
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
    };

    let execution = tokio::time::timeout(
        Duration::from_secs(300),
        processor.run_apply_job(
            &registration_for_live(runtime_id),
            &job,
            true,
            None,
            None,
            None,
        ),
    )
    .await
    .context("live proxy job timed out")??;

    let generated_file = config
        .workspace_root
        .join(project_id.to_string())
        .join("abc.md");

    if !generated_file.exists() {
        eprintln!(
            "[live-proxy-test] generated file not found at {}",
            generated_file.display()
        );
        eprintln!("[live-proxy-test] job summary: {}", execution.summary);
        eprintln!("[live-proxy-test] job artifacts: {:?}", execution.artifacts);
        anyhow::bail!("live proxy test did not create expected file");
    }

    println!(
        "[live-proxy-test] generated file at {} ({} bytes)",
        generated_file.display(),
        fs::metadata(&generated_file)?.len()
    );

    drop(proxy_guard);

    let proxy_result = proxy_task
        .await
        .context("proxy task join failed")?
        .context("proxy server returned error");
    proxy_result?;

    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn codex_proxy_live_browser_prompt_simulation() -> Result<()> {
    let _env_guard = env_guard().await;
    if std::env::var("RUN_LIVE_BROWSER_SIM_TEST").ok().as_deref() != Some("1") {
        eprintln!(
            "[live-browser-sim] skipping (set RUN_LIVE_BROWSER_SIM_TEST=1 to enable this simulation)"
        );
        return Ok(());
    }

    let auth_path = locate_codex_home()?.join("auth.json");
    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;

    let tokens = proxy_auth_json
        .get("tokens")
        .and_then(Value::as_object)
        .context("auth.json missing tokens; run `codex login`")?;
    if tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .is_none()
    {
        eprintln!(
            "[live-browser-sim] skipping (auth.json tokens missing access_token; run `codex login`)",
        );
        return Ok(());
    }

    if let Value::Object(ref mut obj) = proxy_auth_json {
        obj.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)
        .context("failed to write sanitized proxy auth.json")?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{proxy_port}")
        .parse()
        .context("failed to parse proxy address")?;
    let credentials = auth::load_credentials(Some(&proxy_auth_path))
        .context("failed to load Codex credentials")?;

    let workspace_dir = TempDir::new().context("failed to create workspace directory")?;
    let workspace_root = workspace_dir.path().to_path_buf();
    let runtime_codex_home =
        TempDir::new().context("failed to create temporary runtime Codex home directory")?;
    let runtime_auth_path = runtime_codex_home.path().join("auth.json");
    let runtime_auth_mode = std::env::var("LIVE_BROWSER_DIRECT_AUTH_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "api_key".to_string());
    if runtime_auth_mode == "chatgpt_tokens" {
        let mut runtime_auth_json = proxy_auth_json.clone();
        if let Value::Object(ref mut obj) = runtime_auth_json {
            obj.remove("OPENAI_API_KEY");
        }
        fs::write(
            &runtime_auth_path,
            serde_json::to_string(&runtime_auth_json)?,
        )
        .context("failed to write runtime auth.json with chatgpt tokens")?;
    } else {
        fs::write(
            &runtime_auth_path,
            json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
        )
        .context("failed to write runtime auth.json with dummy API key")?;
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_addr, Some(credentials), async move {
            let _ = shutdown_rx.await;
        })
        .await
    });
    let proxy_guard = ChildGuard::new(shutdown_tx);

    wait_for_port(proxy_port).await?;

    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{proxy_addr}/backend-api/codex/responses"),
    );
    let _guard_proxy_endpoint = EnvGuard::set("CODEX_PROXY_CHATGPT_ENDPOINT", "");
    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_openai_api_key = if runtime_auth_mode == "chatgpt_tokens" {
        EnvGuard::set("OPENAI_API_KEY", "")
    } else {
        EnvGuard::set("OPENAI_API_KEY", "integration-proxy-dummy-key")
    };
    let _guard_workspace = EnvGuard::set(
        "WORKSPACE_DIR",
        workspace_root.as_os_str().to_string_lossy(),
    );
    let _guard_project = EnvGuard::set("PROJECT_ID", project_id.to_string());
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_runtime_type = EnvGuard::set("RUNTIME_TYPE", "integration-runtime-live-browser-sim");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "integration-test-live");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home = EnvGuard::set(
        "CODEX_HOME",
        runtime_codex_home.path().as_os_str().to_string_lossy(),
    );
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_auth_path.as_os_str().to_string_lossy(),
    );

    let runtime_flavor = std::env::var("LIVE_BROWSER_SIM_RUNTIME_FLAVOR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "base".to_string());
    let _guard_runtime_flavor = EnvGuard::set("INSTAFY_RUNTIME_FLAVOR", &runtime_flavor);

    let config = Config::from_env().context("failed to load runtime-agent config in live test")?;
    let config = std::sync::Arc::new(config);
    let processor = JobProcessor::new(config.clone());

    let project_workspace = config.workspace_root.join(project_id.to_string());
    fs::create_dir_all(&project_workspace).with_context(|| {
        format!(
            "failed to prepare live project workspace {:?}",
            project_workspace
        )
    })?;

    let prompt = std::env::var("LIVE_BROWSER_SIM_PROMPT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Open a browser session and go to example.com".to_string());
    let expect_playwright_cli = std::env::var("LIVE_BROWSER_SIM_EXPECT_PLAYWRIGHT_CLI")
        .ok()
        .as_deref()
        == Some("1");
    let expected_provider = std::env::var("LIVE_BROWSER_SIM_EXPECT_PROVIDER")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let codex_config_path = runtime_codex_home.path().join("config.toml");
    if let Ok(codex_config_preview) = fs::read_to_string(&codex_config_path) {
        eprintln!(
            "[live-browser-sim] preflight CODEX_HOME={} config.toml:\n{}",
            runtime_codex_home.path().display(),
            codex_config_preview
        );
    }

    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": prompt,
            "metadata": {
                "execution_mode": "apply"
            }
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
    };

    let execution = tokio::time::timeout(
        Duration::from_secs(300),
        processor.run_apply_job(
            &registration_for_live(runtime_id),
            &job,
            true,
            None,
            None,
            None,
        ),
    )
    .await
    .context("live browser simulation job timed out")?
    .map_err(|error| {
        eprintln!("[live-browser-sim] run_apply_job error: {error}");
        eprintln!("[live-browser-sim] run_apply_job debug: {error:?}");
        for (idx, cause) in error.chain().enumerate() {
            eprintln!("[live-browser-sim]   cause {idx}: {cause}");
        }
        dump_job_failure_debug(&error);
        error
    })?;

    let playwright_cli_calls = count_playwright_cli_command_executions(&execution.artifacts);
    eprintln!(
        "[live-browser-sim] provider={} runtime_flavor={} playwright_cli_calls={} summary={}",
        execution.provider, runtime_flavor, playwright_cli_calls, execution.summary
    );

    if let Some(expected) = expected_provider.as_deref() {
        assert_eq!(
            execution.provider, expected,
            "unexpected provider for browser simulation"
        );
    }

    if expect_playwright_cli {
        assert!(
            playwright_cli_calls > 0,
            "expected Playwright CLI command executions, observed none. provider={} summary={}",
            execution.provider,
            execution.summary
        );
    }

    drop(proxy_guard);

    let proxy_result = proxy_task
        .await
        .context("proxy task join failed")?
        .context("proxy server returned error");
    proxy_result?;

    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn codex_proxy_live_browser_prompt_direct_codex_client_probe() -> Result<()> {
    let _env_guard = env_guard().await;
    if std::env::var("RUN_LIVE_BROWSER_DIRECT_PROBE_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        eprintln!(
            "[live-browser-direct] skipping (set RUN_LIVE_BROWSER_DIRECT_PROBE_TEST=1 to enable this probe)"
        );
        return Ok(());
    }

    let auth_path = locate_codex_home()?.join("auth.json");
    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;

    let tokens = proxy_auth_json
        .get("tokens")
        .and_then(Value::as_object)
        .context("auth.json missing tokens; run `codex login`")?;
    if tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .is_none()
    {
        eprintln!(
            "[live-browser-direct] skipping (auth.json tokens missing access_token; run `codex login`)",
        );
        return Ok(());
    }

    if let Value::Object(ref mut obj) = proxy_auth_json {
        obj.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)
        .context("failed to write sanitized proxy auth.json")?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{proxy_port}")
        .parse()
        .context("failed to parse proxy address")?;
    let credentials = auth::load_credentials(Some(&proxy_auth_path))
        .context("failed to load Codex credentials")?;

    let workspace_dir = TempDir::new().context("failed to create workspace directory")?;
    let workspace_root = workspace_dir.path().to_path_buf();
    let runtime_codex_home =
        TempDir::new().context("failed to create temporary runtime Codex home directory")?;
    let runtime_auth_path = runtime_codex_home.path().join("auth.json");
    let runtime_auth_mode = std::env::var("LIVE_BROWSER_DIRECT_AUTH_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "api_key".to_string());
    if runtime_auth_mode == "chatgpt_tokens" {
        let mut runtime_auth_json = proxy_auth_json.clone();
        if let Value::Object(ref mut obj) = runtime_auth_json {
            obj.remove("OPENAI_API_KEY");
        }
        fs::write(
            &runtime_auth_path,
            serde_json::to_string(&runtime_auth_json)?,
        )
        .context("failed to write runtime auth.json with chatgpt tokens")?;
    } else {
        fs::write(
            &runtime_auth_path,
            json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
        )
        .context("failed to write runtime auth.json with dummy API key")?;
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_addr, Some(credentials), async move {
            let _ = shutdown_rx.await;
        })
        .await
    });
    let proxy_guard = ChildGuard::new(shutdown_tx);

    wait_for_port(proxy_port).await?;

    let project_id = Uuid::new_v4();
    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{proxy_addr}/backend-api/codex/responses"),
    );
    let _guard_proxy_endpoint = EnvGuard::set("CODEX_PROXY_CHATGPT_ENDPOINT", "");
    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_openai_api_key = if runtime_auth_mode == "chatgpt_tokens" {
        EnvGuard::set("OPENAI_API_KEY", "")
    } else {
        EnvGuard::set("OPENAI_API_KEY", "integration-proxy-dummy-key")
    };
    let _guard_workspace = EnvGuard::set(
        "WORKSPACE_DIR",
        workspace_root.as_os_str().to_string_lossy(),
    );
    let _guard_project = EnvGuard::set("PROJECT_ID", project_id.to_string());
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_runtime_type =
        EnvGuard::set("RUNTIME_TYPE", "integration-runtime-live-browser-direct");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "integration-test-live");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home = EnvGuard::set(
        "CODEX_HOME",
        runtime_codex_home.path().as_os_str().to_string_lossy(),
    );
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_auth_path.as_os_str().to_string_lossy(),
    );

    let runtime_flavor = std::env::var("LIVE_BROWSER_DIRECT_RUNTIME_FLAVOR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "base".to_string());
    let _guard_runtime_flavor = EnvGuard::set("INSTAFY_RUNTIME_FLAVOR", &runtime_flavor);

    let project_workspace = workspace_root.join(project_id.to_string());
    fs::create_dir_all(&project_workspace).with_context(|| {
        format!(
            "failed to prepare live project workspace {:?}",
            project_workspace
        )
    })?;

    let browser_request = std::env::var("LIVE_BROWSER_DIRECT_PROMPT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Open a browser session and go to example.com".to_string());
    let expect_playwright_cli = std::env::var("LIVE_BROWSER_DIRECT_EXPECT_PLAYWRIGHT_CLI")
        .ok()
        .as_deref()
        == Some("1");
    let disable_shell_tool = std::env::var("LIVE_BROWSER_DIRECT_DISABLE_SHELL")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .map(|value| !matches!(value.as_str(), "0" | "false" | "no"))
        .unwrap_or(false);

    let prompt = browser_request.clone();

    let codex_client = CodexClient::from_env(&project_workspace)
        .context("failed to construct direct Codex client for live browser probe")?;

    let codex_config_path = runtime_codex_home.path().join("config.toml");
    let codex_config_preview = fs::read_to_string(&codex_config_path)
        .unwrap_or_else(|_| "<missing config.toml>".to_string());
    eprintln!(
        "[live-browser-direct] preflight CODEX_HOME={} runtime_auth_mode={} disable_shell_tool={} config.toml:\n{}",
        runtime_codex_home.path().display(),
        runtime_auth_mode,
        disable_shell_tool,
        codex_config_preview
    );

    let direct_timeout_secs = std::env::var("LIVE_BROWSER_DIRECT_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(300);
    let output_result = tokio::time::timeout(
        Duration::from_secs(direct_timeout_secs),
        codex_client.execute_with_options(
            &prompt,
            None,
            CodexRunOptions {
                disable_shell_tool,
                expect_browser_session: true,
                expect_mcp_tools: false,
                persist_conversation_thread: true,
                ..Default::default()
            },
        ),
    )
    .await
    .context("direct codex browser probe timed out")?;

    let output = match output_result {
        Ok(output) => Some(output),
        Err(error) => {
            return Err(error);
        }
    };

    let (playwright_cli_calls, summary) = if let Some(output) = output.as_ref() {
        let playwright_cli_calls =
            count_playwright_cli_command_executions_in_events(&output.events);
        let summary = output
            .final_json
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("<missing summary>")
            .to_string();
        (playwright_cli_calls, summary)
    } else {
        (0usize, "<probe aborted before final JSON>".to_string())
    };
    eprintln!(
        "[live-browser-direct] runtime_flavor={} playwright_cli_calls={} summary={}",
        runtime_flavor, playwright_cli_calls, summary
    );

    let mut followup_playwright_cli_calls = 0usize;
    if let Some(first_output) = output.as_ref()
        && let Some(first_state) = first_output.provider_conversation_state.clone()
    {
        let followup_request = std::env::var("LIVE_BROWSER_DIRECT_FOLLOWUP_PROMPT")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                "Read the page title from the existing browser session and reply only with the title.".to_string()
            });
        let followup_output = tokio::time::timeout(
            Duration::from_secs(direct_timeout_secs),
            codex_client.execute_with_options(
                &followup_request,
                None,
                CodexRunOptions {
                    disable_shell_tool,
                    disable_final_output_json_schema: false,
                    expect_browser_session: true,
                    expect_mcp_tools: false,
                    persist_conversation_thread: true,
                    provider_conversation_state: Some(first_state.clone()),
                    allow_plain_text_final_fallback: false,
                    cancel_signal: None,
                    ..Default::default()
                },
            ),
        )
        .await
        .context("direct codex browser follow-up probe timed out")??;

        followup_playwright_cli_calls =
            count_playwright_cli_command_executions_in_events(&followup_output.events);
        let followup_summary = followup_output
            .final_json
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("<missing summary>")
            .to_string();
        let first_thread = extract_browser_thread_id(&first_state);
        let second_thread = followup_output
            .provider_conversation_state
            .as_ref()
            .and_then(extract_browser_thread_id);
        eprintln!(
            "[live-browser-direct] followup playwright_cli_calls={} summary={} first_thread={:?} second_thread={:?}",
            followup_playwright_cli_calls, followup_summary, first_thread, second_thread
        );
        if first_thread.is_some() && second_thread.is_some() {
            assert_eq!(
                first_thread, second_thread,
                "expected follow-up run to reuse the same browser thread"
            );
        }
    }

    if playwright_cli_calls == 0
        && let Some(output) = output.as_ref()
    {
        dump_codex_events_tail("live-browser-direct", &output.events);
    }

    if expect_playwright_cli {
        assert!(
            playwright_cli_calls > 0,
            "expected Playwright CLI command executions in direct codex probe, observed none. summary={summary}"
        );
        assert!(
            followup_playwright_cli_calls > 0,
            "expected Playwright CLI command executions in direct codex follow-up probe, observed none"
        );
    }

    drop(proxy_guard);

    let proxy_result = proxy_task
        .await
        .context("proxy task join failed")?
        .context("proxy server returned error");
    proxy_result?;

    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn codex_proxy_direct_custom_mcp_server_probe() -> Result<()> {
    let _env_guard = env_guard().await;
    if std::env::var("RUN_CUSTOM_MCP_DIRECT_PROBE_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        eprintln!(
            "[custom-mcp-direct] skipping (set RUN_CUSTOM_MCP_DIRECT_PROBE_TEST=1 to enable this probe)"
        );
        return Ok(());
    }

    let auth_path = locate_codex_home()?.join("auth.json");
    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;

    let tokens = proxy_auth_json
        .get("tokens")
        .and_then(Value::as_object)
        .context("auth.json missing tokens; run `codex login`")?;
    if tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .is_none()
    {
        eprintln!(
            "[custom-mcp-direct] skipping (auth.json tokens missing access_token; run `codex login`)",
        );
        return Ok(());
    }

    if let Value::Object(ref mut obj) = proxy_auth_json {
        obj.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)
        .context("failed to write sanitized proxy auth.json")?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{proxy_port}")
        .parse()
        .context("failed to parse proxy address")?;
    let credentials = auth::load_credentials(Some(&proxy_auth_path))
        .context("failed to load Codex credentials")?;

    let workspace_dir = TempDir::new().context("failed to create workspace directory")?;
    let workspace_root = workspace_dir.path().to_path_buf();
    let runtime_codex_home =
        TempDir::new().context("failed to create temporary runtime Codex home directory")?;
    let runtime_auth_path = runtime_codex_home.path().join("auth.json");
    fs::write(
        &runtime_auth_path,
        json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
    )
    .context("failed to write runtime auth.json with dummy API key")?;

    let config_path = runtime_codex_home.path().join("config.toml");
    let path_env = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_string());
    let config_toml = format!(
        r#"[mcp_servers.probe]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything", "stdio"]
env = {{ PATH = "{}" }}
required = true
startup_timeout_sec = 45
tool_timeout_sec = 20

project_doc_max_bytes = 0
"#,
        escape_toml_string(&path_env),
    );
    fs::write(&config_path, config_toml).context("failed to write probe config.toml")?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_addr, Some(credentials), async move {
            let _ = shutdown_rx.await;
        })
        .await
    });
    let proxy_guard = ChildGuard::new(shutdown_tx);

    wait_for_port(proxy_port).await?;

    let project_id = Uuid::new_v4();
    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{proxy_addr}/backend-api/codex/responses"),
    );
    let _guard_proxy_endpoint = EnvGuard::set("CODEX_PROXY_CHATGPT_ENDPOINT", "");
    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_openai_api_key = EnvGuard::set("OPENAI_API_KEY", "integration-proxy-dummy-key");
    let _guard_workspace = EnvGuard::set(
        "WORKSPACE_DIR",
        workspace_root.as_os_str().to_string_lossy(),
    );
    let _guard_project = EnvGuard::set("PROJECT_ID", project_id.to_string());
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_runtime_type = EnvGuard::set("RUNTIME_TYPE", "integration-runtime-custom-mcp");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "integration-test-custom-mcp");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home = EnvGuard::set(
        "CODEX_HOME",
        runtime_codex_home.path().as_os_str().to_string_lossy(),
    );
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_auth_path.as_os_str().to_string_lossy(),
    );
    let project_workspace = workspace_root.join(project_id.to_string());
    fs::create_dir_all(&project_workspace).with_context(|| {
        format!(
            "failed to prepare custom mcp project workspace {:?}",
            project_workspace
        )
    })?;

    let prompt = std::env::var("CUSTOM_MCP_DIRECT_PROMPT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            "Call mcp__probe__echo with {\"message\":\"hello\"} and reply with only Echo: hello."
                .to_string()
        });

    let codex_client = CodexClient::from_env(&project_workspace)
        .context("failed to construct direct Codex client for custom MCP probe")?;

    let output = tokio::time::timeout(
        Duration::from_secs(180),
        codex_client.execute(&prompt, None),
    )
    .await
    .context("custom mcp direct probe timed out")??;

    let probe_mcp_calls = count_mcp_tool_calls_in_events_by_tool_prefix(&output.events, "echo");
    let summary = output
        .final_json
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("<missing summary>");
    eprintln!(
        "[custom-mcp-direct] probe_mcp_calls={} summary={}",
        probe_mcp_calls, summary
    );

    if probe_mcp_calls == 0 {
        dump_codex_events_tail("custom-mcp-direct", &output.events);
    }

    assert!(
        probe_mcp_calls > 0,
        "expected at least one custom MCP tool call, observed none. summary={summary}"
    );

    drop(proxy_guard);

    let proxy_result = proxy_task
        .await
        .context("proxy task join failed")?
        .context("proxy server returned error");
    proxy_result?;

    Ok(())
}

struct PersonalBrowserMcpProbeState {
    expected_token: String,
    expected_project_id: String,
    completed_calls: AtomicUsize,
}

const PERSONAL_BROWSER_MCP_PROBE_URL: &str = "https://example.test/personal";

async fn handle_personal_browser_mcp_probe(
    State(state): State<Arc<PersonalBrowserMcpProbeState>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> axum::response::Response {
    let expected_authorization = format!("Bearer {}", state.expected_token);
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(expected_authorization.as_str())
        || headers
            .get("x-instafy-project-id")
            .and_then(|value| value.to_str().ok())
            != Some(state.expected_project_id.as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    match payload.get("method").and_then(Value::as_str) {
        Some(method) if method.starts_with("notifications/") => {
            StatusCode::ACCEPTED.into_response()
        }
        Some("initialize") => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "instafy-personal-browser", "version": "1.0.0" },
                }
            })),
        )
            .into_response(),
        Some("tools/list") => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [{
                        "name": "snapshot",
                        "description": "Read the visible Personal Browser page.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": false
                        }
                    }]
                }
            })),
        )
            .into_response(),
        Some("tools/call")
            if payload.pointer("/params/name").and_then(Value::as_str) == Some("snapshot") =>
        {
            state.completed_calls.fetch_add(1, Ordering::SeqCst);
            let snapshot = json!({
                "status": { "state": "ready" },
                "url": PERSONAL_BROWSER_MCP_PROBE_URL,
                "title": "Personal Browser MCP probe",
                "visibleText": "Personal Browser dedicated tool reached",
                "elements": [],
            });
            (
                StatusCode::OK,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": snapshot.to_string() }],
                        "structuredContent": snapshot,
                        "isError": false,
                    }
                })),
            )
                .into_response()
        }
        _ => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "Method not found" }
            })),
        )
            .into_response(),
    }
}

#[test]
fn codex_proxy_direct_personal_browser_mcp_probe() -> Result<()> {
    const RUNTIME_AGENT_STACK_SIZE: usize = 16 * 1024 * 1024;
    let handle = std::thread::Builder::new()
        .name("personal-browser-mcp-direct-probe".to_string())
        .stack_size(RUNTIME_AGENT_STACK_SIZE)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(RUNTIME_AGENT_STACK_SIZE)
                .build()
                .expect("failed to build production-shaped runtime for Personal Browser probe");
            runtime.block_on(codex_proxy_direct_personal_browser_mcp_probe_inner())
        })
        .context("failed to spawn Personal Browser probe thread")?;

    handle
        .join()
        .map_err(|_| anyhow::anyhow!("Personal Browser probe thread panicked"))?
}

async fn codex_proxy_direct_personal_browser_mcp_probe_inner() -> Result<()> {
    let _env_guard = env_guard().await;
    if std::env::var("RUN_PERSONAL_BROWSER_MCP_DIRECT_PROBE_TEST")
        .ok()
        .as_deref()
        != Some("1")
    {
        eprintln!(
            "[personal-browser-mcp-direct] skipping (set RUN_PERSONAL_BROWSER_MCP_DIRECT_PROBE_TEST=1 to enable this probe)"
        );
        return Ok(());
    }

    let auth_path = locate_codex_home()?.join("auth.json");
    let auth_contents =
        fs::read_to_string(&auth_path).context("failed to read host auth.json for proxy setup")?;
    let mut proxy_auth_json: Value =
        serde_json::from_str(&auth_contents).context("failed to parse host auth.json")?;
    if proxy_auth_json
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        eprintln!("[personal-browser-mcp-direct] skipping (run `codex login` first)");
        return Ok(());
    }
    if let Value::Object(ref mut object) = proxy_auth_json {
        object.remove("OPENAI_API_KEY");
    }

    let proxy_auth_dir = TempDir::new().context("failed to create proxy credential directory")?;
    let proxy_auth_path = proxy_auth_dir.path().join("auth.json");
    fs::write(&proxy_auth_path, serde_json::to_string(&proxy_auth_json)?)?;
    let credentials = auth::load_credentials(Some(&proxy_auth_path))?;

    let proxy_port = reserve_port()?;
    let proxy_addr: SocketAddr = format!("127.0.0.1:{proxy_port}").parse()?;
    let (proxy_shutdown_tx, proxy_shutdown_rx) = oneshot::channel::<()>();
    let proxy_task = tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_addr, Some(credentials), async move {
            let _ = proxy_shutdown_rx.await;
        })
        .await
    });
    let proxy_guard = ChildGuard::new(proxy_shutdown_tx);

    let project_id = Uuid::new_v4();
    let personal_token = format!("personal-probe-{}", Uuid::new_v4());
    let mcp_state = Arc::new(PersonalBrowserMcpProbeState {
        expected_token: personal_token.clone(),
        expected_project_id: project_id.to_string(),
        completed_calls: AtomicUsize::new(0),
    });
    let mcp_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let mcp_addr = mcp_listener.local_addr()?;
    let (mcp_shutdown_tx, mcp_shutdown_rx) = oneshot::channel::<()>();
    let mcp_app = Router::new()
        .route("/mcp", post(handle_personal_browser_mcp_probe))
        .with_state(mcp_state.clone());
    let mcp_task = tokio::spawn(async move {
        axum::serve(mcp_listener, mcp_app.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = mcp_shutdown_rx.await;
            })
            .await
    });
    let mcp_guard = ChildGuard::new(mcp_shutdown_tx);

    wait_for_port(proxy_port).await?;
    let workspace_dir = TempDir::new()?;
    let runtime_codex_home = TempDir::new()?;
    fs::write(
        runtime_codex_home.path().join("auth.json"),
        json!({ "OPENAI_API_KEY": "integration-proxy-dummy-key" }).to_string(),
    )?;
    fs::write(
        runtime_codex_home.path().join("config.toml"),
        "project_doc_max_bytes = 0\n",
    )?;

    let _guard_chatgpt_endpoint = EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{proxy_addr}/backend-api/codex/responses"),
    );
    let _guard_proxy_endpoint = EnvGuard::set("CODEX_PROXY_CHATGPT_ENDPOINT", "");
    let _guard_openai_base = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _guard_openai_api_key = EnvGuard::set("OPENAI_API_KEY", "integration-proxy-dummy-key");
    let _guard_workspace = EnvGuard::set("WORKSPACE_DIR", workspace_dir.path().to_string_lossy());
    let _guard_project = EnvGuard::set("PROJECT_ID", project_id.to_string());
    let _guard_agent_key = EnvGuard::set("AGENT_LOGIN_KEY", "integration-agent-key");
    let _guard_runtime_token = EnvGuard::set("RUNTIME_ACCESS_TOKEN", "integration-runtime-token");
    let _guard_origin_id = EnvGuard::set("ORIGIN_ID", Uuid::new_v4().to_string());
    let _guard_runtime_type = EnvGuard::set("RUNTIME_TYPE", "desktop");
    let _guard_runtime_version = EnvGuard::set("RUNTIME_VERSION", "personal-mcp-probe");
    let _guard_strict = EnvGuard::set("RUNTIME_STRICT_MODE", "0");
    let _guard_isolation = EnvGuard::set("RUNTIME_DEV_ISOLATION", "0");
    let _guard_codex_home =
        EnvGuard::set("CODEX_HOME", runtime_codex_home.path().to_string_lossy());
    let _guard_codex_auth = EnvGuard::set(
        "CODEX_AUTH_PATH",
        runtime_codex_home
            .path()
            .join("auth.json")
            .to_string_lossy(),
    );
    let _guard_personal_url = EnvGuard::set(
        "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
        format!("http://{mcp_addr}"),
    );
    let _guard_personal_token =
        EnvGuard::set("INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN", &personal_token);
    let _guard_personal_project = EnvGuard::set(
        "INSTAFY_PERSONAL_BROWSER_PROJECT_ID",
        project_id.to_string(),
    );
    let probe_binary =
        std::env::current_exe().context("failed to resolve the Personal Browser probe binary")?;
    let _guard_runtime_bin =
        EnvGuard::set("INSTAFY_RUNTIME_AGENT_BIN", probe_binary.to_string_lossy());

    let project_workspace = workspace_dir.path().join(project_id.to_string());
    fs::create_dir_all(&project_workspace)?;
    let codex_client = CodexClient::from_env(&project_workspace)
        .context("failed to construct Personal Browser Codex client")?;
    let output = tokio::time::timeout(
        Duration::from_secs(180),
        codex_client.execute_with_options(
            "Use the Personal Browser snapshot tool, read the URL from its result, and set the final JSON summary field to exactly that observed URL with no other text.",
            None,
            CodexRunOptions {
                disable_shell_tool: true,
                expect_browser_session: true,
                personal_browser: true,
                require_first_tool_call: true,
                ..Default::default()
            },
        ),
    )
    .await
    .context("Personal Browser MCP direct probe timed out")??;

    let completed_calls = mcp_state.completed_calls.load(Ordering::SeqCst);
    let reported_url = output
        .final_json
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if completed_calls == 0 || reported_url != PERSONAL_BROWSER_MCP_PROBE_URL {
        dump_codex_events_tail("personal-browser-mcp-direct", &output.events);
    }
    assert!(
        completed_calls > 0,
        "model did not execute the dedicated Personal Browser MCP tool; summary={}",
        output
            .final_json
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("<missing>")
    );
    assert_eq!(
        reported_url, PERSONAL_BROWSER_MCP_PROBE_URL,
        "Personal Browser direct probe did not report the exact URL observed through the dedicated MCP snapshot tool"
    );
    assert_eq!(
        count_command_executions_in_events(&output.events),
        0,
        "Personal Browser direct probe unexpectedly exposed a command tool"
    );

    drop(mcp_guard);
    mcp_task.await.context("MCP probe task join failed")??;
    drop(proxy_guard);
    proxy_task.await.context("proxy task join failed")??;
    Ok(())
}

#[derive(Default)]
struct AstraUpgradeStub {
    bounded_browser: bool,
    requests: Mutex<Vec<Value>>,
    root_steps: AtomicUsize,
    child_requests: AtomicUsize,
    responses_lite_requests: AtomicUsize,
}

fn declared_fixture_tools(tools: &Value) -> Vec<(Option<String>, String)> {
    let mut declared = Vec::new();
    for tool in tools.as_array().into_iter().flatten() {
        if tool["type"] == "namespace" {
            let namespace = tool["name"].as_str().map(str::to_string);
            for (_, name) in declared_fixture_tools(&tool["tools"]) {
                declared.push((namespace.clone(), name));
            }
        } else if let Some(name) = tool["name"].as_str() {
            declared.push((None, name.to_string()));
        } else if let Some(kind) = tool["type"].as_str() {
            // Provider-native tools such as web_search and tool_search have
            // no name field and must still participate in boundary checks.
            declared.push((None, kind.to_string()));
        }
    }
    declared
}

fn astra_fixture_tools(request: &Value) -> &Value {
    request["input"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["type"] == "additional_tools"))
        .map(|item| &item["tools"])
        .unwrap_or(&request["tools"])
}

async fn handle_astra_upgrade_stub(
    State(state): State<Arc<AstraUpgradeStub>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    // This endpoint has only synthetic credentials and is reachable through
    // the real Instafy proxy, never as the runtime's configured provider URL.
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some("Bearer fixture-upstream-key")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if headers
        .get("x-openai-internal-codex-responses-lite")
        .and_then(|value| value.to_str().ok())
        == Some("true")
    {
        state.responses_lite_requests.fetch_add(1, Ordering::SeqCst);
    }
    let serialized_input = payload
        .get("input")
        .map(Value::to_string)
        .unwrap_or_default();
    let is_root = serialized_input.contains("ASTRA_ROOT_FIXTURE");
    let reviewer_completed = serialized_input.contains("REVIEWER_COMPLETE");
    let declared_tools = declared_fixture_tools(astra_fixture_tools(&payload));
    let snapshot_tool = declared_tools
        .iter()
        .find(|(_, name)| name == "snapshot" || name.ends_with("__snapshot"));
    let snapshot_returned = payload["input"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item["type"] == "function_call_output"
                && item["call_id"] == "astra-snapshot"
                && item["output"]
                    .to_string()
                    .contains(PERSONAL_BROWSER_MCP_PROBE_URL)
        })
    });
    state.requests.lock().await.push(payload);
    let output = if state.bounded_browser {
        if state.root_steps.fetch_add(1, Ordering::SeqCst) == 0 {
            let Some((namespace, name)) = snapshot_tool else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": {"message": format!(
                        "bounded browser fixture requires a directly advertised snapshot tool; got {declared_tools:?}"
                    )}})),
                )
                    .into_response();
            };
            let mut call = json!({
                "type": "function_call", "call_id": "astra-snapshot", "name": name,
                "arguments": "{}",
            });
            if let Some(namespace) = namespace {
                call["namespace"] = json!(namespace);
            }
            call
        } else {
            // A synthetic final answer must depend on the actual broker result;
            // otherwise a missing tool declaration can look like browser success.
            if !snapshot_returned {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": {"message":
                        "bounded browser fixture did not receive its MCP snapshot result"
                    }})),
                )
                    .into_response();
            }
            json!({
                "id": "astra-browser-final", "type": "message", "role": "assistant", "phase": "final_answer",
                "content": [{"type": "output_text", "text": json!({"summary": PERSONAL_BROWSER_MCP_PROBE_URL, "files": [], "actions": []}).to_string()}],
            })
        }
    } else if is_root {
        let step = state.root_steps.fetch_add(1, Ordering::SeqCst);
        match step {
            0 => json!({
                "type": "custom_tool_call", "call_id": "astra-exec", "name": "exec",
                "input": "text(await tools.exec_command({cmd: \"printf astra_code_mode_marker > astra-proof.txt; cat astra-proof.txt\", login: false, max_output_tokens: 1000}));",
            }),
            1 => json!({
                "type": "function_call", "call_id": "astra-spawn", "namespace": "collaboration", "name": "spawn_agent",
                "arguments": json!({"task_name": "reviewer", "message": "ASTRA_REVIEWER_FIXTURE: finish the isolated review with the fixture result.", "fork_turns": "none"}).to_string(),
            }),
            2 => json!({
                "type": "function_call", "call_id": "astra-wait", "namespace": "collaboration", "name": "wait_agent",
                "arguments": json!({"timeout_ms": 10000}).to_string(),
            }),
            3 => json!({
                "type": "function_call", "call_id": "astra-list", "namespace": "collaboration", "name": "list_agents",
                "arguments": "{}",
            }),
            _ if !reviewer_completed && step < 8 => json!({
                "type": "function_call", "call_id": format!("astra-wait-{step}"), "namespace": "collaboration", "name": "wait_agent",
                "arguments": json!({"timeout_ms": 10000}).to_string(),
            }),
            _ => json!({
                "id": "astra-final", "type": "message", "role": "assistant", "phase": "final_answer",
                "content": [{"type": "output_text", "text": "{\"summary\":\"Astra execution and review complete\",\"files\":[],\"actions\":[]}"}],
            }),
        }
    } else {
        state.child_requests.fetch_add(1, Ordering::SeqCst);
        json!({
            "id": "reviewer-final", "type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": "REVIEWER_COMPLETE"}],
        })
    };
    let response = json!({
        "id": Uuid::new_v4().to_string(), "object": "response", "status": "completed", "model": "gpt-6-astra",
        "output": [output],
        "usage": {"input_tokens": 25, "output_tokens": 25, "total_tokens": 50},
    });
    // The real proxy requests a complete JSON response for API-key upstreams,
    // then converts that response to SSE for the embedded Codex client.
    Json(response).into_response()
}

/// Secret-free, deterministic integration proof against the exact embedded
/// engine. Unlike the opt-in live probes, this never loads host auth.json.
#[test]
fn codex_astra_upgrade_executes_code_mode_and_native_review_through_proxy() -> Result<()> {
    run_astra_upgrade_proxy_fixture(false)
}

#[test]
fn codex_astra_bounded_browser_uses_only_browser_tools_through_proxy() -> Result<()> {
    run_astra_upgrade_proxy_fixture(true)
}

fn run_astra_upgrade_proxy_fixture(bounded_browser: bool) -> Result<()> {
    const STACK_SIZE: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("astra-upgrade-proxy-fixture".to_string())
        .stack_size(STACK_SIZE)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_stack_size(STACK_SIZE)
                .enable_all()
                .build()?
                .block_on(codex_astra_upgrade_proxy_fixture(bounded_browser))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("Astra upgrade fixture thread panicked"))?
}

async fn codex_astra_upgrade_proxy_fixture(bounded_browser: bool) -> Result<()> {
    let _env_lock = env_guard().await;
    let workspace = TempDir::new()?;
    let codex_home = TempDir::new()?;
    fs::write(
        codex_home.path().join("config.toml"),
        "model = \"gpt-6-astra\"\nmodel_reasoning_effort = \"max\"\nproject_doc_max_bytes = 0\n",
    )?;
    fs::write(
        codex_home.path().join("auth.json"),
        json!({"OPENAI_API_KEY": "fixture-runtime-proxy-key"}).to_string(),
    )?;
    let _isolated_env = [
        (
            "CODEX_HOME",
            codex_home.path().to_string_lossy().to_string(),
        ),
        (
            "CODEX_AUTH_PATH",
            codex_home
                .path()
                .join("auth.json")
                .to_string_lossy()
                .to_string(),
        ),
        ("CODEX_MODEL", "gpt-6-astra".to_string()),
        ("CODEX_MODEL_PROVIDER", "openai".to_string()),
        ("CODEX_RUNTIME_REASONING_EFFORT", "max".to_string()),
        ("CODEX_AGENT_REASONING_EFFORT", String::new()),
        ("OPENAI_API_KEY", "fixture-runtime-proxy-key".to_string()),
        ("CODEX_API_KEY", "fixture-runtime-proxy-key".to_string()),
        ("CODEX_MAX_RUN_RETRIES", "0".to_string()),
        ("CODEX_RUN_TIMEOUT_SECONDS", "90".to_string()),
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "0".to_string()),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "0".to_string()),
        ("PROXY_CONTROLLER_BASE_URL", String::new()),
        ("CONTROLLER_BASE_URL", String::new()),
        ("CONTROLLER_INTERNAL_TOKEN", String::new()),
        ("PROXY_CREDENTIAL_LEASE_TOKEN", String::new()),
        ("PROXY_SIGNING_SECRET", String::new()),
    ]
    .into_iter()
    .map(|(key, value)| EnvGuard::set(key, value))
    .collect::<Vec<_>>();

    let browser_fixture = if bounded_browser {
        let project_id = Uuid::new_v4().to_string();
        let browser_state = Arc::new(PersonalBrowserMcpProbeState {
            expected_token: "fixture-browser-token".to_string(),
            expected_project_id: project_id.clone(),
            completed_calls: AtomicUsize::new(0),
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let guard = ChildGuard::new(shutdown_tx);
        let state = browser_state.clone();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/mcp", post(handle_personal_browser_mcp_probe))
                    .with_state(state),
            )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        });
        let env = vec![
            EnvGuard::set(
                "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
                format!("http://{address}"),
            ),
            EnvGuard::set(
                "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
                "fixture-browser-token",
            ),
            EnvGuard::set("INSTAFY_PERSONAL_BROWSER_PROJECT_ID", project_id),
            EnvGuard::set(
                "INSTAFY_RUNTIME_AGENT_BIN",
                std::env::current_exe()?.to_string_lossy(),
            ),
        ];
        Some((browser_state, guard, task, env))
    } else {
        None
    };
    let state = Arc::new(AstraUpgradeStub {
        bounded_browser,
        ..Default::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream_address = listener.local_addr()?;
    let (upstream_tx, upstream_rx) = oneshot::channel();
    let upstream_guard = ChildGuard::new(upstream_tx);
    let upstream_state = state.clone();
    let upstream_task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/responses", post(handle_astra_upgrade_stub))
                .with_state(upstream_state),
        )
        .with_graceful_shutdown(async move {
            let _ = upstream_rx.await;
        })
        .await
    });
    let proxy_port = reserve_port()?;
    let proxy_addr = SocketAddr::from(([127, 0, 0, 1], proxy_port));
    let credentials = auth::Credentials::ApiKey {
        key: "fixture-upstream-key".to_string(),
        endpoint: Some(format!("http://{upstream_address}/responses")),
        default_model: None,
    };
    let (proxy_tx, proxy_rx) = oneshot::channel();
    let proxy_guard = ChildGuard::new(proxy_tx);
    let proxy_task = tokio::spawn(async move {
        proxy::run_proxy_with_shutdown(proxy_addr, Some(credentials), async move {
            let _ = proxy_rx.await;
        })
        .await
    });
    wait_for_port(proxy_port).await?;
    let _proxy_url = EnvGuard::set("OPENAI_BASE_URL", format!("http://{proxy_addr}/v1"));
    let _proxy_root = EnvGuard::set("PROXY_BASE_URL", format!("http://{proxy_addr}"));
    let host_program = PathBuf::from(env!("CARGO_BIN_EXE_codex-code-mode-host"));
    assert!(
        host_program.is_file(),
        "build the companion code-mode host before running the fixture: {}",
        host_program.display()
    );
    let client = CodexClient::new(runtime_agent::codex::CodexConfig {
        workspace_dir: workspace.path().to_path_buf(),
    })
    .with_code_mode_host_program(host_program);
    let prompt = if bounded_browser {
        "ASTRA_ROOT_FIXTURE: use the dedicated Personal Browser snapshot tool, then report the exact URL returned by that tool."
    } else {
        "ASTRA_ROOT_FIXTURE: run the local proof command, spawn the isolated native reviewer, wait, inspect its status, and finish."
    };
    let output = client
        .execute_with_options(
            prompt,
            None,
            CodexRunOptions {
                disable_shell_tool: bounded_browser,
                expect_browser_session: bounded_browser,
                personal_browser: bounded_browser,
                reasoning_effort: Some(codex_protocol::openai_models::ReasoningEffort::High),
                require_first_tool_call: true,
                ..Default::default()
            },
        )
        .await?;

    if bounded_browser {
        assert_eq!(output.final_json["summary"], PERSONAL_BROWSER_MCP_PROBE_URL);
        assert_eq!(count_command_executions_in_events(&output.events), 0);
        assert_eq!(
            browser_fixture
                .as_ref()
                .unwrap()
                .0
                .completed_calls
                .load(Ordering::SeqCst),
            1
        );
    } else {
        assert_eq!(
            fs::read_to_string(workspace.path().join("astra-proof.txt"))?,
            "astra_code_mode_marker"
        );
        assert_eq!(
            output.final_json["summary"],
            "Astra execution and review complete"
        );
        assert!(
            output
                .events
                .iter()
                .any(|event| event["item"]["type"] == "command_execution"
                    && event["item"]["status"] == "completed"
                    && event["item"]["exit_code"] == 0)
        );
        assert!(
            output
                .events
                .iter()
                .any(|event| event["item"]["type"] == "sub_agent_activity"
                    && event["item"]["agent_path"] == "/root/reviewer"
                    && event["item"]["activity"] == "started")
        );
        assert!(
            output
                .events
                .iter()
                .any(|event| event["item"]["type"] == "collab_tool_call"
                    && event["item"]["tool"] == "wait"
                    && event["item"]["status"] == "completed")
        );
        assert!(
            state.child_requests.load(Ordering::SeqCst) >= 1,
            "native reviewer never sampled through proxy"
        );
    }
    let requests = state.requests.lock().await;
    assert!(requests.len() >= if bounded_browser { 2 } else { 6 });
    assert_eq!(
        state.responses_lite_requests.load(Ordering::SeqCst),
        requests.len(),
        "proxy lost the Responses Lite transport header"
    );
    for request in requests.iter() {
        assert_eq!(request["model"], "gpt-6-astra");
        assert_eq!(
            request["reasoning"]["effort"], "max",
            "explicit max changed before reaching the fixture provider"
        );
        assert_eq!(request["reasoning"]["context"], "all_turns");
        assert_eq!(
            request["parallel_tool_calls"], false,
            "Responses Lite must retain its wire-level serial flag even when model metadata supports parallel tools"
        );
        assert!(
            request.get("tools").is_none(),
            "proxy injected tools into a Responses Lite request"
        );
        let first_item = &request["input"][0];
        assert_eq!(first_item["type"], "additional_tools");
        assert_eq!(first_item["role"], "developer");
        assert_eq!(request["input"][1]["role"], "developer");
    }
    assert_eq!(requests[0]["tool_choice"], "required");
    let tools = declared_fixture_tools(astra_fixture_tools(&requests[0]));
    if bounded_browser {
        assert!(
            tools
                .iter()
                .any(|(_, name)| name == "snapshot" || name.ends_with("__snapshot"))
        );
        // Core MCP resource helpers address the same single allowed server;
        // every other tool must be the browser's advertised snapshot action.
        assert!(
            tools.iter().all(|(_, name)| name == "snapshot"
                || name.ends_with("__snapshot")
                || matches!(
                    name.as_str(),
                    "list_mcp_resources" | "list_mcp_resource_templates" | "read_mcp_resource"
                )),
            "bounded browser exposed tools outside its MCP capability: {tools:?}"
        );
        assert!(
            requests.iter().any(
                |request| request["input"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["type"]
                        == "function_call_output"
                        && item["call_id"] == "astra-snapshot"
                        && item["output"]
                            .to_string()
                            .contains(PERSONAL_BROWSER_MCP_PROBE_URL)))
            )
        );
    } else {
        assert!(
            tools.iter().any(
                |(namespace, name)| namespace.as_deref() == Some("collaboration")
                    && name == "spawn_agent"
            ),
            "Astra v2 tools missing: {tools:?}"
        );
        assert!(!tools.iter().any(|(_, name)| name == "close_agent"));
        assert!(
            requests.iter().any(|request| {
                let input = request["input"].to_string();
                input.contains("ASTRA_REVIEWER_FIXTURE") && !input.contains("ASTRA_ROOT_FIXTURE")
            }),
            "fresh reviewer inherited parent context"
        );
        assert!(
            requests.iter().any(
                |request| request["input"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["type"]
                        == "custom_tool_call_output"
                        && item["call_id"] == "astra-exec"
                        && item["output"]
                            .to_string()
                            .contains("astra_code_mode_marker")))
            ),
            "code mode did not return real command output to the provider"
        );
        assert!(
            requests
                .iter()
                .any(|request| request["input"].to_string().contains("REVIEWER_COMPLETE")),
            "reviewer report was not delivered to parent"
        );
    }
    drop(requests);
    drop(proxy_guard);
    proxy_task.await??;
    drop(upstream_guard);
    upstream_task.await??;
    if let Some((_, guard, task, _env)) = browser_fixture {
        drop(guard);
        task.await??;
    }
    Ok(())
}

fn registration_for_live(runtime_id: Uuid) -> Registration {
    Registration {
        runtime_id,
        agent_token: "integration-agent-token".to_string(),
        runtime_token: None,
        lease_url: Url::parse("http://127.0.0.1/lease").unwrap(),
        heartbeat_url: Url::parse("http://127.0.0.1/heartbeat").unwrap(),
        stop_url: None,
        lease_id: None,
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
