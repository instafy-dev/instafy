//! A granted turn, end to end without a model key: a leased job that holds a device grant runs
//! through the job processor, the real proxy and an inert localhost provider that scripts the
//! model's tool calls, and the real `provider-mcp` broker calls a stub controller.

use super::*;
use axum::extract::Path as AxumPath;
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_GRANTED_TURNS_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-granted-turn-provider-key";
const GRANT_TOKEN: &str = "grant-token-of-this-turn";
const NAMESPACE: &str = "mcp__instafy_provider";
const INSTRUCTIONS: &str = "Use the example device's tools only when the person asks.";
const PROMPT: &str = "Read the device's state.";
const SUMMARY: &str = "The device is idle.";

/// Runs `turn` in this binary's isolated child, on a production-sized stack.
fn isolated(
    test_name: &str,
    turn: fn() -> Pin<Box<dyn Future<Output = Result<()>>>>,
) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, test_name, "granted-turns");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("granted-turns-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(turn())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("granted turn fixture panicked"))?
}

#[test]
fn a_granted_turn_calls_its_device_tools_through_the_broker_and_nothing_else_via_proxy()
-> Result<()> {
    isolated(
        "granted_turns::a_granted_turn_calls_its_device_tools_through_the_broker_and_nothing_else_via_proxy",
        || Box::pin(a_granted_turn()),
    )
}

#[test]
fn a_granted_turn_that_ends_without_its_answer_is_not_run_again_via_proxy() -> Result<()> {
    isolated(
        "granted_turns::a_granted_turn_that_ends_without_its_answer_is_not_run_again_via_proxy",
        || Box::pin(a_granted_turn_without_its_answer()),
    )
}

#[test]
fn a_granted_turn_whose_answer_quotes_an_upstream_error_answers_with_it_via_proxy() -> Result<()> {
    isolated(
        "granted_turns::a_granted_turn_whose_answer_quotes_an_upstream_error_answers_with_it_via_proxy",
        || Box::pin(a_granted_turn_answering_with_an_upstream_error()),
    )
}

#[test]
fn a_granted_turn_whose_model_fails_upstream_fails_once_via_proxy() -> Result<()> {
    isolated(
        "granted_turns::a_granted_turn_whose_model_fails_upstream_fails_once_via_proxy",
        || Box::pin(a_granted_turn_failing_upstream()),
    )
}

#[test]
fn a_canceled_granted_turn_ends_only_once_its_broker_is_gone_via_proxy() -> Result<()> {
    isolated(
        "granted_turns::a_canceled_granted_turn_ends_only_once_its_broker_is_gone_via_proxy",
        || Box::pin(a_canceled_granted_turn()),
    )
}

/// The stub controller: what the broker sent it, and the broker it saw.
struct Controller {
    calls: StdMutex<Vec<(Option<String>, String, Value)>>,
    broker_pids: StdMutex<Vec<i32>>,
    /// Holds every device-tool call open, as a device that has not answered yet.
    hold_calls: bool,
    call_arrived: tokio::sync::Notify,
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// The test's own children running `provider-mcp`: the broker Codex started for the turn.
#[cfg(not(target_os = "linux"))]
fn running_brokers() -> Vec<i32> {
    let output = std::process::Command::new("/usr/bin/pgrep")
        .args(["-P", &std::process::id().to_string(), "-f", "provider-mcp"])
        .output()
        .expect("pgrep");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

/// The test's own children running `provider-mcp`, read from `/proc`, which every Linux runner
/// has, rather than from `pgrep`, which a minimal one may not.
#[cfg(target_os = "linux")]
fn running_brokers() -> Vec<i32> {
    let parent = std::process::id() as i32;
    fs::read_dir("/proc")
        .expect("/proc")
        .flatten()
        .filter_map(|entry| {
            let pid: i32 = entry.file_name().to_str()?.parse().ok()?;
            let stat = fs::read_to_string(entry.path().join("stat")).ok()?;
            let command = fs::read(entry.path().join("cmdline")).ok()?;
            (parent_in_stat(&stat) == Some(parent)
                && String::from_utf8_lossy(&command).contains("provider-mcp"))
            .then_some(pid)
        })
        .collect()
}

/// The parent pid in a `/proc/<pid>/stat` line, `pid (comm) state ppid ...`, whose `comm` may
/// itself hold spaces and parentheses.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parent_in_stat(stat: &str) -> Option<i32> {
    stat[stat.rfind(')')? + 1..]
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[test]
fn a_proc_stat_line_names_its_parent_whatever_the_command_name() {
    assert_eq!(
        parent_in_stat("4242 (runtime-agent) S 4100 4242 4100 0"),
        Some(4100)
    );
    assert_eq!(parent_in_stat("4243 (a) b) (c) R 17 4243 17 0"), Some(17));
    assert_eq!(parent_in_stat("garbage"), None);
}

fn process_exists(pid: i32) -> bool {
    // SAFETY: signal 0 only checks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn provider_tool_call(
    State(controller): State<Arc<Controller>>,
    AxumPath(project_id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    controller
        .broker_pids
        .lock()
        .unwrap()
        .extend(running_brokers());
    controller.calls.lock().unwrap().push((
        bearer(&headers),
        format!("call {project_id}"),
        body.clone(),
    ));
    if controller.hold_calls {
        controller.call_arrived.notify_one();
        std::future::pending::<()>().await;
    }
    Json(json!({ "ok": true, "outcome": "succeeded", "state": "idle" }))
}

/// The scripted model.
struct Provider {
    requests: StdMutex<Vec<Value>>,
    script: Script,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Script {
    /// Call the device's state tool, then answer.
    Answer,
    /// Call the device's state tool, then end the turn on a progress note with no answer, on
    /// every run of the request.
    ProgressNoteOnly,
    /// Call the device's state tool, then answer with a device error's text, which reads like
    /// an upstream error, on every run of the request.
    AnswerQuotingAnUpstreamError,
    /// Call the device's state tool; every later request then fails upstream with a 502.
    UpstreamFailure,
}

const PROGRESS_NOTE: &str = "Checking the device now.";
const QUOTED_UPSTREAM_ERROR: &str =
    "The device answered: unexpected status 502 Bad Gateway: upstream request failed.";

fn response(output: Value) -> axum::response::Response {
    Json(json!({
        "id": format!("resp_{}", Uuid::new_v4()), "object": "response",
        "status": "completed", "model": "gpt-5.5",
        "output": [output],
        "usage": { "input_tokens": 70, "output_tokens": 10, "total_tokens": 80 }
    }))
    .into_response()
}

fn tool_call(call_id: &str, name: &str, arguments: Value) -> axum::response::Response {
    response(json!({
        "id": format!("fc_{call_id}"), "type": "function_call", "status": "completed",
        "call_id": call_id, "namespace": NAMESPACE, "name": name,
        "arguments": arguments.to_string(),
    }))
}

/// The output the turn sent back for one of the model's calls.
fn call_output(request: &Value, call_id: &str) -> Option<String> {
    request["input"].as_array()?.iter().find_map(|item| {
        (item["type"] == "function_call_output" && item["call_id"] == call_id)
            .then(|| item["output"].to_string())
    })
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
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body.clone());
        requests.len()
    };
    if state.script == Script::UpstreamFailure {
        return if index == 1 {
            tool_call("call_state", "example_state_read", json!({}))
        } else {
            (StatusCode::BAD_GATEWAY, "upstream request failed").into_response()
        };
    }
    if state.script == Script::AnswerQuotingAnUpstreamError {
        return if index % 2 == 1 {
            tool_call(
                &format!("call_state_{index}"),
                "example_state_read",
                json!({}),
            )
        } else {
            let answer =
                json!({ "summary": QUOTED_UPSTREAM_ERROR, "code": "", "files": [], "actions": [] });
            response(json!({
                "id": format!("msg_{}", Uuid::new_v4()), "type": "message",
                "role": "assistant", "status": "completed", "phase": "final_answer",
                "content": [{ "type": "output_text", "text": answer.to_string() }]
            }))
        };
    }
    if state.script == Script::ProgressNoteOnly {
        return if index % 2 == 1 {
            tool_call(
                &format!("call_state_{index}"),
                "example_state_read",
                json!({}),
            )
        } else {
            response(json!({
                "id": format!("msg_{}", Uuid::new_v4()), "type": "message",
                "role": "assistant", "status": "completed", "phase": "commentary",
                "content": [{ "type": "output_text", "text": PROGRESS_NOTE }]
            }))
        };
    }
    match index {
        1 => tool_call("call_state", "example_state_read", json!({})),
        _ => {
            let output = call_output(&body, "call_state").unwrap_or_default();
            assert!(
                output.contains("idle"),
                "the state reached the model: {output}"
            );
            let answer = json!({ "summary": SUMMARY, "code": "", "files": [], "actions": [] });
            response(json!({
                "id": format!("msg_{}", Uuid::new_v4()), "type": "message",
                "role": "assistant", "status": "completed", "phase": "final_answer",
                "content": [{ "type": "output_text", "text": answer.to_string() }]
            }))
        }
    }
}

/// A stub controller and a scripted provider behind the real proxy, and a job leased with a
/// device grant and its token.
struct Rig {
    controller: Arc<Controller>,
    provider: Arc<Provider>,
    config: Arc<Config>,
    registration: Registration,
    job: LeaseJob,
    _settings: Vec<EnvGuard>,
    _dirs: (TempDir, TempDir),
    guards: Vec<ChildGuard>,
    tasks: Vec<tokio::task::JoinHandle<Result<()>>>,
}

impl Rig {
    async fn start(hold_calls: bool, script: Script) -> Result<Self> {
        // macOS assesses a freshly linked executable on its first launch, which can take longer
        // than the broker's 10 s startup budget; let that happen before the turn starts.
        let warmed = std::process::Command::new(env!("CARGO_BIN_EXE_runtime-agent"))
            .arg("--version")
            .output()?;
        anyhow::ensure!(warmed.status.success(), "runtime-agent --version failed");
        let workspace_root = TempDir::new()?;
        let runtime_home = TempDir::new()?;
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        fs::create_dir_all(workspace_root.path().join(project_id.to_string()))?;
        let auth_path = runtime_home.path().join("auth.json");
        fs::write(
            &auth_path,
            json!({"OPENAI_API_KEY":"inert-granted-turn-runtime-key"}).to_string(),
        )?;
        let mut settings = Vec::new();
        for (key, value) in [
            ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
            ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
            ("OPENAI_API_KEY", "inert-granted-turn-runtime-key"),
            ("CODEX_API_KEY", "inert-granted-turn-runtime-key"),
            ("CODEX_MODEL", "gpt-5.5"),
            ("CODEX_MODEL_PROVIDER", "openai"),
            ("CODEX_DISABLED", "false"),
            ("CODEX_PERSIST_STRUCTURED_CONVERSATION_THREAD", "true"),
            ("CODEX_SANDBOX_MODE", "workspace-write"),
            ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
            ("CODEX_RUN_TIMEOUT_SECONDS", "60"),
        ] {
            settings.push(EnvGuard::set(key, value));
        }
        settings.push(EnvGuard::set(
            "CODEX_HOME",
            runtime_home.path().to_string_lossy(),
        ));
        settings.push(EnvGuard::set(
            "CODEX_AUTH_PATH",
            auth_path.to_string_lossy(),
        ));
        let mut guards = Vec::new();
        let mut tasks: Vec<tokio::task::JoinHandle<Result<()>>> = Vec::new();

        let controller = Arc::new(Controller {
            calls: StdMutex::new(Vec::new()),
            broker_pids: StdMutex::new(Vec::new()),
            hold_calls,
            call_arrived: tokio::sync::Notify::new(),
        });
        let controller_listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let controller_address = controller_listener.local_addr()?;
        let controller_app = Router::new()
            .route(
                "/projects/:project_id/provider-tools/call",
                post(provider_tool_call),
            )
            .with_state(controller.clone());
        let (shutdown, rx) = oneshot::channel();
        tasks.push(tokio::spawn(async move {
            axum::serve(controller_listener, controller_app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .map_err(Into::into)
        }));
        guards.push(ChildGuard::new(shutdown));

        let provider = Arc::new(Provider {
            requests: StdMutex::new(Vec::new()),
            script,
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let upstream = listener.local_addr()?;
        let app = Router::new()
            .route("/backend-api/codex/responses", post(provider_request))
            .with_state(provider.clone());
        let (shutdown, rx) = oneshot::channel();
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .map_err(Into::into)
        }));
        guards.push(ChildGuard::new(shutdown));
        let port = reserve_port()?;
        let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
        let credentials = auth::Credentials::ApiKey {
            key: PROVIDER_KEY.to_string(),
            endpoint: Some(format!("http://{upstream}/backend-api/codex/responses")),
            default_model: Some("gpt-5.5".to_string()),
        };
        let (shutdown, rx) = oneshot::channel();
        tasks.push(tokio::spawn(async move {
            proxy::run_proxy_with_shutdown(proxy_address, Some(credentials), async {
                let _ = rx.await;
            })
            .await
        }));
        guards.push(ChildGuard::new(shutdown));
        wait_for_port(port).await?;
        settings.push(EnvGuard::set(
            "OPENAI_BASE_URL",
            format!("http://{proxy_address}/v1"),
        ));

        let config = Arc::new(Config {
            controller_base_url: Url::parse(&format!("http://{controller_address}/"))?,
            controller_jwks_url: Url::parse(&format!("http://{controller_address}/jwks"))?,
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
            workspace_root: workspace_root.path().to_path_buf(),
            project_workspace_override: None,
            strict_mode: false,
            dev_isolation_mode: false,
            display_name: None,
            origin: None,
            codex_bin: None,
            require_codex_bin: false,
            runtime_access_token: None,
            parent_dispositions_runtime_on_shutdown: false,
        });
        let mut registration = registration_for_live(Uuid::new_v4());
        registration.lease_id = Some(Uuid::new_v4());
        // A job as the controller leases a granted turn: delivered once, with the grant's tools
        // as the device published them and the job's grant token.
        let job: LeaseJob = serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "intent": "feature",
            "project_id": project_id,
            "run_id": Uuid::new_v4(),
            "conversation_id": conversation_id,
            "payload": {
                "prompt_text": PROMPT,
                "metadata": { "execution_mode": "apply" },
                "delivery": { "atMostOnce": true },
            },
            "lease_attempts": 1,
            "grants": [{
                "providerId": "example-device",
                "instructions": INSTRUCTIONS,
                "tools": [
                    { "name": "example.state.read", "description": "Reads the device's state.",
                      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } },
                    { "name": "example.part.move", "description": "Moves the device's part.",
                      "inputSchema": { "type": "object", "properties": { "to": { "type": "number" } } } },
                ],
            }],
            "grant_token": GRANT_TOKEN,
        }))?;

        Ok(Self {
            controller,
            provider,
            config,
            registration,
            job,
            _settings: settings,
            _dirs: (workspace_root, runtime_home),
            guards,
            tasks,
        })
    }

    async fn stop(mut self) -> Result<()> {
        self.guards.clear();
        for task in self.tasks.drain(..) {
            task.await??;
        }
        Ok(())
    }
}

async fn a_granted_turn() -> Result<()> {
    let _env = env_guard().await;
    let rig = Rig::start(false, Script::Answer).await?;
    let execution = JobProcessor::new(rig.config.clone())
        .with_provider_mcp_program(PathBuf::from(env!("CARGO_BIN_EXE_runtime-agent")))
        .run_apply_job(&rig.registration, &rig.job, true, None, None, None)
        .await
        .context("granted turn")?;
    assert_eq!(execution.summary, SUMMARY);

    // Two model requests: no routing preflight ran before the turn.
    let requests = rig.provider.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2, "one request per step of the script");
    // The model saw the broker's tools directly, described by the device's catalog, and no
    // shell, patch, image, web or other server's tool.
    let tools = requests[0]["tools"].as_array().context("tools")?;
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    for name in &names {
        assert!(
            matches!(
                *name,
                NAMESPACE
                    | "list_mcp_resources"
                    | "list_mcp_resource_templates"
                    | "read_mcp_resource"
            ),
            "the granted turn offered {name}: {names:?}"
        );
    }
    let device = tools
        .iter()
        .find(|tool| tool["name"] == NAMESPACE)
        .context("the broker's tools")?;
    assert_eq!(device["description"], json!(INSTRUCTIONS));
    let mut device_tools: Vec<&str> = device["tools"]
        .as_array()
        .context("device tools")?
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    device_tools.sort_unstable();
    assert_eq!(device_tools, ["example_part_move", "example_state_read"]);
    let first = requests[0].to_string();
    // Nothing from the workspace reaches a granted turn.
    assert!(!first.contains("Project preferences snapshot"));
    // The grant token never reaches the model.
    for request in &requests {
        assert!(!request.to_string().contains(GRANT_TOKEN));
    }

    // The broker called the controller with the grant's token, once per model call.
    let calls = rig.controller.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "{calls:?}");
    let expected_bearer = Some(format!("Bearer {GRANT_TOKEN}"));
    assert!(calls.iter().all(|(auth, _, _)| *auth == expected_bearer));

    // The broker that served the turn is gone now that the turn is over.
    let brokers = rig.controller.broker_pids.lock().unwrap().clone();
    assert_eq!(brokers.len(), 1, "one broker served the turn: {brokers:?}");
    assert!(!process_exists(brokers[0]), "the broker outlived its turn");
    rig.stop().await
}

/// A turn that called the device and then ended on a progress note, with no answer, fails and
/// says so; the runtime's fallback text is never its reply. Running the request again, as a
/// recovery retry or a finalization pass would, starts from the person's words on a fresh
/// thread and calls the device a second time with nobody asking.
async fn a_granted_turn_without_its_answer() -> Result<()> {
    let _env = env_guard().await;
    let rig = Rig::start(false, Script::ProgressNoteOnly).await?;
    let result = JobProcessor::new(rig.config.clone())
        .with_provider_mcp_program(PathBuf::from(env!("CARGO_BIN_EXE_runtime-agent")))
        .run_apply_job(&rig.registration, &rig.job, true, None, None, None)
        .await;
    let calls = rig.controller.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "the device was called once: {calls:?}");
    let requests = rig.provider.requests.lock().unwrap().len();
    assert_eq!(requests, 2, "the turn ran once: its call, then its note");
    let error = match result {
        Ok(execution) => anyhow::bail!(
            "a granted turn without its answer succeeded with {:?}",
            execution.summary
        ),
        Err(error) => error,
    };
    assert_eq!(
        extract_job_failure_message(&error),
        Some(
            "The turn ended without an answer. It was not run again, because it may already \
             have acted."
        ),
        "{error:#}"
    );
    rig.stop().await
}

/// A turn that called the device and then answered with an error the device reported, in words
/// that read like an upstream failure, answers with them, once: a turn that may already have
/// acted is never retried. A real upstream failure fails the run before any summary exists; the
/// answer's text is not read for one.
async fn a_granted_turn_answering_with_an_upstream_error() -> Result<()> {
    let _env = env_guard().await;
    let rig = Rig::start(false, Script::AnswerQuotingAnUpstreamError).await?;
    let execution = JobProcessor::new(rig.config.clone())
        .with_provider_mcp_program(PathBuf::from(env!("CARGO_BIN_EXE_runtime-agent")))
        .run_apply_job(&rig.registration, &rig.job, true, None, None, None)
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "a granted turn that answered failed: {}",
                extract_job_failure_message(&error)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{error:#}"))
            )
        })?;
    assert_eq!(execution.summary, QUOTED_UPSTREAM_ERROR);
    let calls = rig.controller.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "the device was called once: {calls:?}");
    let requests = rig.provider.requests.lock().unwrap().len();
    assert_eq!(requests, 2, "the turn ran once: its call, then its answer");
    rig.stop().await
}

/// A turn whose model fails upstream after it called the device fails with that error, and the
/// device is not called again: the run is not replayed, and no summary exists to be read.
async fn a_granted_turn_failing_upstream() -> Result<()> {
    let _env = env_guard().await;
    let rig = Rig::start(false, Script::UpstreamFailure).await?;
    let result = JobProcessor::new(rig.config.clone())
        .with_provider_mcp_program(PathBuf::from(env!("CARGO_BIN_EXE_runtime-agent")))
        .run_apply_job(&rig.registration, &rig.job, true, None, None, None)
        .await;
    let error = match result {
        Ok(execution) => anyhow::bail!(
            "a granted turn that failed upstream succeeded with {:?}",
            execution.summary
        ),
        Err(error) => error,
    };
    let calls = rig.controller.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1, "the device was called once: {calls:?}");
    let requests = rig.provider.requests.lock().unwrap().len();
    assert!(
        requests >= 2,
        "the call, then the failed request: {requests}"
    );
    assert!(
        format!("{error:#}").contains("502 Bad Gateway"),
        "{error:#}"
    );
    rig.stop().await
}

async fn a_canceled_granted_turn() -> Result<()> {
    let _env = env_guard().await;
    let rig = Rig::start(true, Script::Answer).await?;
    // A broker that ignores SIGTERM, the signal Codex's own MCP shutdown sends first. It lives
    // in Cargo's target directory, which runs executables, unlike a `noexec` temp directory.
    let scripts = TempDir::new_in(env!("CARGO_TARGET_TMPDIR"))?;
    let broker = scripts.path().join("stubborn-provider-mcp");
    fs::write(
        &broker,
        format!(
            "#!/bin/sh\ntrap '' TERM\nexec '{}' \"$@\"\n",
            env!("CARGO_BIN_EXE_runtime-agent")
        ),
    )?;
    fs::set_permissions(&broker, fs::Permissions::from_mode(0o755))?;

    let cancel = JobCancelSignal::new();
    let processor = JobProcessor::new(rig.config.clone()).with_provider_mcp_program(broker.clone());
    let mut turn = Box::pin(processor.run_apply_job(
        &rig.registration,
        &rig.job,
        true,
        None,
        Some(cancel.clone()),
        None,
    ));
    // The device holds the model's first call open; the turn is canceled meanwhile, as its
    // heartbeat reports when someone cancels it from web chat.
    tokio::select! {
        result = &mut turn => anyhow::bail!("the turn ended before its call: {:?}", result.err()),
        _ = rig.controller.call_arrived.notified() => {}
    }
    let brokers = rig.controller.broker_pids.lock().unwrap().clone();
    assert_eq!(brokers.len(), 1, "one broker holds the call: {brokers:?}");
    assert!(process_exists(brokers[0]));
    let canceled_at = Instant::now();
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(10), &mut turn)
        .await
        .context("the canceled turn must end")?;
    let error = result.err().context("a canceled turn fails")?;
    assert!(
        error
            .chain()
            .any(|cause| cause.to_string().contains("lease lost")),
        "{error:#}"
    );
    // By the time the turn reports, its broker, which ignores SIGTERM and is still waiting
    // for the device, is gone.
    assert!(
        !process_exists(brokers[0]),
        "the broker outlived its canceled turn"
    );
    let elapsed = canceled_at.elapsed();
    assert!(
        elapsed < Duration::from_secs(5),
        "the canceled turn took {elapsed:?} to end"
    );
    drop(turn);
    rig.stop().await
}
