//! The reply check through the real proxy with an inert, localhost provider. A turn that read a
//! page answers, then gets one more request on its own thread: the check, with the turn's own
//! instructions and tools and the turn's requests as its prefix, so the provider can serve all
//! of it but the check from its cache. The check's words replace the reply. A turn that read
//! nothing makes no such request. A check that calls a tool runs nothing and leaves the reply;
//! the check's words are finished as the turn's own reply was; and a Stop during the check ends
//! the turn with what the turn did.

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_REPLY_CHECK_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-reply-check-provider-key";
/// A web read the recognizer labels as one. Nothing serves that address, and the isolated
/// child's PATH has no `instafy`, so nothing is read from anywhere.
const READ: &str = "instafy web read http://127.0.0.1:9/lines --json";
const ANSWER: &str =
    "The old station is not a stop on the metro, so there is no metro ride from it.";
const CHECKED: &str =
    "Whether the old station is a metro stop: not checked. The line's page didn't load.";
const CHECK_OPENING: &str = "Before your reply goes to the person, check it once";
/// The file a command the check calls would write in the space.
const CHECK_WROTE: &str = "check-wrote.txt";
/// The runtime's own line, which a recovery pass ends its reply with when it changed nothing.
const NO_CHANGE_LINE: &str = "NO_FILE_CHANGES";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Case {
    /// The turn runs a web read, answers, and the check answers differently.
    ReadAPage,
    /// The turn answers without reading anything.
    ReadNothing,
    /// The check calls a command that would write a file in the space, instead of answering.
    CheckCallsATool,
    /// The turn asks for an integration, and the check's words end with the runtime's no-change
    /// line, as the thread's earlier recovery prompt asked.
    CheckRepeatsTheRuntimesLine,
    /// A required change was not made: the recovery pass says so with the runtime's no-change
    /// line, and the check, asked for the reply "in the same form", repeats it.
    RetryCheckRepeatsTheRuntimesLine,
    /// The person presses Stop while the check runs.
    StopDuringTheCheck,
}

impl Case {
    fn test_name(self) -> &'static str {
        match self {
            Self::ReadAPage => {
                "reply_check::a_turn_that_read_a_page_gets_its_reply_checked_on_its_own_thread_via_proxy"
            }
            Self::ReadNothing => {
                "reply_check::a_turn_that_read_nothing_makes_no_check_request_via_proxy"
            }
            Self::CheckCallsATool => {
                "reply_check::a_check_that_calls_a_tool_runs_nothing_and_keeps_the_reply_via_proxy"
            }
            Self::CheckRepeatsTheRuntimesLine => {
                "reply_check::the_checked_words_are_finished_as_the_turns_reply_was_via_proxy"
            }
            Self::RetryCheckRepeatsTheRuntimesLine => {
                "reply_check::a_recovery_passs_checked_words_lose_the_runtimes_line_via_proxy"
            }
            Self::StopDuringTheCheck => {
                "reply_check::a_stop_during_the_check_ends_the_turn_with_what_it_did_via_proxy"
            }
        }
    }

    /// Whether the person asked for a change, so a turn that changed nothing gets a recovery pass.
    fn requires_a_change(self) -> bool {
        self == Self::RetryCheckRepeatsTheRuntimesLine
    }
}

#[test]
fn a_turn_that_read_a_page_gets_its_reply_checked_on_its_own_thread_via_proxy() -> Result<()> {
    run_isolated(Case::ReadAPage)
}

#[test]
fn a_turn_that_read_nothing_makes_no_check_request_via_proxy() -> Result<()> {
    run_isolated(Case::ReadNothing)
}

#[test]
fn a_check_that_calls_a_tool_runs_nothing_and_keeps_the_reply_via_proxy() -> Result<()> {
    run_isolated(Case::CheckCallsATool)
}

#[test]
fn the_checked_words_are_finished_as_the_turns_reply_was_via_proxy() -> Result<()> {
    run_isolated(Case::CheckRepeatsTheRuntimesLine)
}

#[test]
fn a_recovery_passs_checked_words_lose_the_runtimes_line_via_proxy() -> Result<()> {
    run_isolated(Case::RetryCheckRepeatsTheRuntimesLine)
}

#[test]
fn a_stop_during_the_check_ends_the_turn_with_what_it_did_via_proxy() -> Result<()> {
    run_isolated(Case::StopDuringTheCheck)
}

fn run_isolated(case: Case) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, case.test_name(), "reply-check");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("reply-check-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_case(case))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("reply-check fixture panicked"))?
}

struct Provider {
    case: Case,
    requests: StdMutex<Vec<Value>>,
    /// The job's cancel signal: the person's Stop.
    stop: JobCancelSignal,
}

fn response(item: Value) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5","output":[item],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

fn final_answer(summary: &str) -> Value {
    final_answer_with_actions(summary, json!([]))
}

fn final_answer_with_actions(summary: &str, actions: Value) -> Value {
    json!({
        "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":json!({
            "summary":summary,"code":"","suggestions":[],"actions":actions,"files":[]
        }).to_string()}]
    })
}

fn command(id: &str, cmd: &str) -> Value {
    json!({
        "id":format!("tool_{id}"),"type":"function_call","name":"exec_command",
        "call_id":format!("call_{id}"),"status":"completed",
        "arguments":json!({"cmd":cmd,"max_output_tokens":64}).to_string()
    })
}

/// The text of the last user message of a request.
fn last_user_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|item| item["role"] == "user")
        .and_then(|item| item["content"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect()
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
        requests.len() - 1
    };
    let is_check = || last_user_text(&body).contains(CHECK_OPENING);
    match (state.case, index) {
        (Case::ReadNothing, 0) => response(final_answer(ANSWER)),
        (_, 0) => response(command("read", READ)),
        (Case::CheckRepeatsTheRuntimesLine, 1) => response(final_answer_with_actions(
            ANSWER,
            json!([{"type":"request_integration","provider":"github"}]),
        )),
        (_, 1) => response(final_answer(ANSWER)),
        (Case::RetryCheckRepeatsTheRuntimesLine, 2) => {
            assert!(!is_check(), "the third request is the recovery pass");
            response(final_answer(&format!("{ANSWER}\n{NO_CHANGE_LINE}")))
        }
        (Case::RetryCheckRepeatsTheRuntimesLine, 3) | (Case::CheckRepeatsTheRuntimesLine, 2) => {
            assert!(is_check(), "the last request is the check");
            response(final_answer(&format!("{CHECKED}\n{NO_CHANGE_LINE}")))
        }
        (Case::CheckCallsATool, 2) => {
            assert!(is_check(), "the third request is the check");
            response(command(
                "check",
                &format!("printf done-by-check > {CHECK_WROTE}"),
            ))
        }
        // Only a check whose command ran asks again, with the command's output.
        (Case::CheckCallsATool, 3) => response(final_answer(CHECKED)),
        (Case::StopDuringTheCheck, 2) => {
            assert!(is_check(), "the third request is the check");
            state.stop.cancel();
            sleep(Duration::from_secs(30)).await;
            response(final_answer(CHECKED))
        }
        (Case::ReadAPage, 2) => {
            assert!(is_check(), "the third request is the check");
            response(final_answer(CHECKED))
        }
        _ => panic!("unexpected extra provider request {index}"),
    }
}

async fn run_case(case: Case) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-reply-check-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-reply-check-runtime-key"),
        ("CODEX_API_KEY", "inert-reply-check-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_PERSIST_STRUCTURED_CONVERSATION_THREAD", "true"),
        ("CODEX_SANDBOX_MODE", "workspace-write"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
        ("CODEX_RUN_TIMEOUT_SECONDS", "45"),
        ("CODEX_RETRY_BASE_DELAY_MS", "10"),
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

    let stop = JobCancelSignal::new();
    let state = Arc::new(Provider {
        case,
        requests: StdMutex::new(Vec::new()),
        stop: stop.clone(),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream = listener.local_addr()?;
    let app = Router::new()
        .route("/backend-api/codex/responses", post(provider_request))
        .with_state(state.clone());
    let (stub_shutdown, stub_rx) = oneshot::channel();
    let stub_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stub_rx.await;
            })
            .await
    });
    let stub_guard = ChildGuard::new(stub_shutdown);
    let port = reserve_port()?;
    let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
    let credentials = auth::Credentials::ApiKey {
        key: PROVIDER_KEY.to_string(),
        endpoint: Some(format!("http://{upstream}/backend-api/codex/responses")),
        default_model: Some("gpt-5.5".to_string()),
    };
    let (proxy_shutdown, proxy_rx) = oneshot::channel();
    let proxy_task = tokio::spawn(proxy::run_proxy_with_shutdown(
        proxy_address,
        Some(credentials),
        async {
            let _ = proxy_rx.await;
        },
    ));
    let proxy_guard = ChildGuard::new(proxy_shutdown);
    wait_for_port(port).await?;
    settings.push(EnvGuard::set(
        "OPENAI_BASE_URL",
        format!("http://{proxy_address}/v1"),
    ));

    let processor = JobProcessor::new(Arc::new(Config {
        controller_base_url: Url::parse("http://127.0.0.1:9")?,
        controller_jwks_url: Url::parse("http://127.0.0.1:9/.well-known/jwks.json")?,
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
    }));
    let prompt = if case.requires_a_change() {
        "Add the metro ride from the old station to the page."
    } else {
        "How do I get to the old station by metro? Don't change any files."
    };
    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(Uuid::new_v4()),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text":prompt,
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{
                "workspaceFileChanges":case.requires_a_change(),"commandExecution":false,
                "genericMcpToolExecution":false
            }}
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
        lease_attempts: 1,
        grants: Vec::new(),
        grant_token: None,
    };
    // The turn streams its steps, as a person's turn does: a run that stops keeps them.
    let (sender, _streamed) = tokio::sync::mpsc::unbounded_channel();
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(90),
        processor.run_apply_job(
            &registration_for_live(Uuid::new_v4()),
            &job,
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
            }),
            Some(stop.clone()),
            None,
        ),
    )
    .await
    .context("reply-check job timed out")?;
    let requests = state.requests.lock().unwrap().clone();

    if case == Case::StopDuringTheCheck {
        let error = result.expect_err("a Stop during the check stops the turn");
        // The job loop tells a Stop by its lost lease, as during the turn.
        assert!(
            error
                .chain()
                .any(|cause| cause.to_string().contains("lease lost")),
            "{error:#}"
        );
        // It stops at once, not when the check would have answered.
        assert!(
            started.elapsed() < Duration::from_secs(25),
            "{:?}",
            started.elapsed()
        );
        // What the turn did stays with it, as a Stop during the turn keeps it: its run log.
        let artifacts = extract_job_failure_artifacts(&error).context("the turn's artifacts")?;
        let run_log = artifacts
            .iter()
            .find(|artifact| artifact["kind"] == "codex/run-log")
            .context("the turn's run log is kept")?;
        assert!(
            run_log.to_string().contains("turn.completed"),
            "the turn's own usage is in it: {run_log}"
        );
        assert_eq!(requests.len(), 3, "the read, the answer and the check");
        finish(settings, proxy_guard, stub_guard, proxy_task, stub_task).await?;
        return Ok(());
    }
    let execution = result.context("reply-check job failed")?;

    let check = |artifacts: &[Value]| {
        artifacts
            .iter()
            .find(|artifact| artifact["kind"] == "codex/reply-check")
            .cloned()
    };
    let usage_phases = execution
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "ai/task-usage")
        .and_then(|receipt| receipt["calls"].as_array())
        .into_iter()
        .flatten()
        .map(|call| call["phase"].as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    match case {
        Case::ReadAPage => {
            assert_eq!(requests.len(), 3, "the read, the answer and one check");
            assert_eq!(
                execution.summary, CHECKED,
                "the checked words are the reply"
            );
            let artifact = check(&execution.artifacts).context("a reply-check artifact")?;
            assert_eq!(artifact["metadata"]["outcome"], "changed");
            assert_eq!(artifact["before"], ANSWER);
            // The check is the answer's own thread, with the same instructions and tools: the
            // whole request before it is its prefix, so a provider serves that from its cache.
            let (answered, checked) = (&requests[1], &requests[2]);
            assert_eq!(checked["instructions"], answered["instructions"]);
            assert_eq!(checked["tools"], answered["tools"]);
            let before = answered["input"].as_array().context("answer input")?;
            let after = checked["input"].as_array().context("check input")?;
            assert!(after.len() > before.len());
            assert_eq!(
                &after[..before.len()],
                &before[..],
                "the turn is the prefix"
            );
            assert!(
                after[before.len()..]
                    .iter()
                    .any(|item| item.to_string().contains("The old station is not a stop")),
                "the turn's answer is on the thread the check reads"
            );
            // The check is measured apart from the turn: one finalization call.
            assert_eq!(usage_phases, ["main", "finalization"]);
            // The next turn resumes the thread that holds the checked reply.
            let state = execution
                .provider_conversation_state
                .context("persisted provider state")?;
            assert_eq!(state["defaultThreadRestoreSource"], "rollout");
        }
        Case::ReadNothing => {
            assert_eq!(requests.len(), 1, "no check for a turn that read nothing");
            assert_eq!(execution.summary, ANSWER);
            assert!(check(&execution.artifacts).is_none());
            assert_eq!(usage_phases, ["main"]);
        }
        Case::CheckCallsATool => {
            // The command never ran, and nothing asked the provider again with its output.
            assert!(
                !workspace.join(CHECK_WROTE).exists(),
                "a check's tool call never runs"
            );
            assert_eq!(requests.len(), 3, "the read, the answer and one check");
            assert_eq!(execution.summary, ANSWER, "the reply stays as it was");
            let artifact = check(&execution.artifacts).context("a reply-check artifact")?;
            assert_eq!(artifact["metadata"]["outcome"], "kept");
            assert_eq!(artifact["metadata"]["reason"], "tried_a_tool");
            assert_eq!(usage_phases, ["main", "finalization"]);
            // The check's request still offered the turn's tools: its prefix is the cached one.
            assert_eq!(requests[2]["tools"], requests[1]["tools"]);
        }
        Case::CheckRepeatsTheRuntimesLine => {
            assert_eq!(requests.len(), 3, "the read, the answer and one check");
            // The person reads the checked words as they read the turn's own: without the
            // runtime's line, and with the integration card's retry phrase.
            assert!(
                execution.summary.starts_with(CHECKED),
                "{}",
                execution.summary
            );
            assert!(
                !execution.summary.contains(NO_CHANGE_LINE),
                "{}",
                execution.summary
            );
            assert!(
                execution
                    .summary
                    .contains("Then reply `I connected Github. Retry now.`"),
                "{}",
                execution.summary
            );
            let artifact = check(&execution.artifacts).context("a reply-check artifact")?;
            assert_eq!(artifact["metadata"]["outcome"], "changed");
        }
        Case::RetryCheckRepeatsTheRuntimesLine => {
            assert_eq!(
                requests.len(),
                4,
                "the read, the answer, the recovery pass and one check"
            );
            assert_eq!(execution.summary, CHECKED, "{}", execution.summary);
            let artifact = check(&execution.artifacts).context("a reply-check artifact")?;
            assert_eq!(artifact["metadata"]["outcome"], "changed");
            assert_eq!(artifact["before"], ANSWER);
        }
        Case::StopDuringTheCheck => unreachable!(),
    }

    finish(settings, proxy_guard, stub_guard, proxy_task, stub_task).await
}

async fn finish(
    settings: Vec<EnvGuard>,
    proxy_guard: ChildGuard,
    stub_guard: ChildGuard,
    proxy_task: tokio::task::JoinHandle<Result<()>>,
    stub_task: tokio::task::JoinHandle<std::io::Result<()>>,
) -> Result<()> {
    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
