//! A team lane's turn nearing its hard limit is steered once to wrap up, while its tool still
//! runs, and its note on what is left becomes its continuation request (`agent/turn-continuation`).
//! Every command's time is in `agent/turn-timings`. A turn the limit stops leaves its edits
//! unsaved, and the continuation's save counts them. Through the real proxy with an inert,
//! localhost provider; the shell commands are real.

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_TURN_WRAP_UP_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-turn-wrap-up-provider-key";
const NOTE: &str = "left: day texts for Kyoto, then validate";

#[derive(Clone, Copy, PartialEq)]
enum Case {
    /// The wrap-up steer comes while a long step runs; the agent leaves its note and ends.
    WrapUp,
    /// No wrap-up (turned off); the hard limit stops the turn mid-command.
    TimeLimit,
    /// A writing lane is stopped at its limit after it wrote one file; its continuation writes
    /// another, and its save holds both.
    ContinuedWrite,
}

impl Case {
    fn test_name(self) -> &'static str {
        match self {
            Self::WrapUp => {
                "turn_wrap_up::a_team_job_near_its_time_limit_is_told_to_wrap_up_and_its_note_asks_for_a_continuation_via_proxy"
            }
            Self::TimeLimit => {
                "turn_wrap_up::a_team_job_stopped_at_its_time_limit_keeps_its_run_log_and_asks_for_a_continuation_via_proxy"
            }
            Self::ContinuedWrite => {
                "turn_wrap_up::a_continuation_saves_what_the_turn_it_continues_wrote_before_its_time_limit_via_proxy"
            }
        }
    }
}

#[test]
fn a_team_job_near_its_time_limit_is_told_to_wrap_up_and_its_note_asks_for_a_continuation_via_proxy()
-> Result<()> {
    run(Case::WrapUp)
}

#[test]
fn a_team_job_stopped_at_its_time_limit_keeps_its_run_log_and_asks_for_a_continuation_via_proxy()
-> Result<()> {
    run(Case::TimeLimit)
}

#[test]
fn a_continuation_saves_what_the_turn_it_continues_wrote_before_its_time_limit_via_proxy()
-> Result<()> {
    run(Case::ContinuedWrite)
}

fn run(case: Case) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, case.test_name(), "turn-wrap-up");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("turn-wrap-up-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("turn wrap-up fixture panicked"))?
}

struct Provider {
    case: Case,
    requests: StdMutex<Vec<Value>>,
}

fn respond(item: Value) -> axum::response::Response {
    let response = json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed","model":"gpt-5.5",
        "output":[item],
        "usage":{"input_tokens":90,"output_tokens":10,"total_tokens":100}
    });
    Json(response).into_response()
}

fn shell(id: &str, cmd: &str) -> Value {
    json!({
        "id":format!("tool_{id}"),"type":"function_call","name":"exec_command","call_id":id,"status":"completed",
        "arguments":json!({"cmd":cmd,"yield_time_ms":30000,"max_output_tokens":64}).to_string()
    })
}

fn input_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .chain(item["output"].as_str())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body.clone());
        requests.len() - 1
    };
    if state.case == Case::TimeLimit {
        assert_eq!(index, 0, "the turn is stopped during its first step");
        return respond(shell("stuck_step", "sleep 40; echo never"));
    }
    if state.case == Case::ContinuedWrite {
        return match index {
            // the first turn writes one day, then is stopped in its next step
            0 => respond(shell(
                "first_day",
                "printf 'day one\\n' > day-1.md && sleep 40; echo never",
            )),
            // its continuation writes the next day and ends
            1 => respond(shell("second_day", "printf 'day two\\n' > day-2.md")),
            2 => respond(json!({
                "id":format!("msg_{}",Uuid::new_v4()),"type":"message","role":"assistant",
                "status":"completed","phase":"final_answer",
                "content":[{"type":"output_text","text":json!({
                    "summary":"Wrote day two.","code":"","files":[],"actions":[]
                }).to_string()}]
            })),
            _ => panic!("unexpected extra provider request {index}"),
        };
    }
    match index {
        // a long step: the wrap-up comes while it runs
        0 => respond(shell("long_step", "sleep 7; echo step-done")),
        1 => {
            // the steer reached the model with the step's output
            let text = input_text(&body);
            assert!(
                text.contains("[Instafy runtime] This turn stops in"),
                "no wrap-up note in: {text}"
            );
            respond(shell(
                "note",
                &format!(
                    "printf '%s\\n' '{NOTE}' > \"$INSTAFY_TURN_CONTINUE_FILE\" && printf 'timed\\n' && printf '{{\"tool\":\"fixture\",\"step\":\"warm-up\",\"ms\":12}}\\n' >> \"$INSTAFY_STEP_TIMINGS_FILE\""
                ),
            ))
        }
        2 => respond(json!({
            "id":format!("msg_{}",Uuid::new_v4()),"type":"message","role":"assistant",
            "status":"completed","phase":"final_answer",
            "content":[{"type":"output_text","text":json!({
                "summary":"Saved the map so far; a new turn finishes the day texts.","code":"","files":[],"actions":[]
            }).to_string()}]
        })),
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
        json!({"OPENAI_API_KEY":"inert-turn-wrap-up-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-turn-wrap-up-runtime-key"),
        ("CODEX_API_KEY", "inert-turn-wrap-up-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_SANDBOX_MODE", "workspace-write"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
    ] {
        settings.push(EnvGuard::set(key, value));
    }
    match case {
        // a 24 s turn, steered 20 s before its end: while `sleep 7` (from ~0 s) still runs
        Case::WrapUp => {
            settings.push(EnvGuard::set("CODEX_RUN_TIMEOUT_SECONDS", "24"));
            settings.push(EnvGuard::set("INSTAFY_TURN_WRAP_UP_SECONDS", "20"));
        }
        // a 6 s turn with no wrap-up: `sleep 40` is still running when it ends
        Case::TimeLimit | Case::ContinuedWrite => {
            settings.push(EnvGuard::set("CODEX_RUN_TIMEOUT_SECONDS", "6"));
            settings.push(EnvGuard::set("INSTAFY_TURN_WRAP_UP_SECONDS", "0"));
        }
    }
    settings.push(EnvGuard::set(
        "CODEX_HOME",
        runtime_home.path().to_string_lossy(),
    ));
    settings.push(EnvGuard::set(
        "CODEX_AUTH_PATH",
        auth_path.to_string_lossy(),
    ));

    let state = Arc::new(Provider {
        case,
        requests: StdMutex::new(Vec::new()),
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

    let config = Arc::new(Config {
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
    });
    let registration = registration_for_live(Uuid::new_v4());
    let processor = JobProcessor::new(config);
    if case == Case::ContinuedWrite {
        let result = continued_write(&processor, &registration, &workspace, project_id).await;
        drop(proxy_guard);
        drop(stub_guard);
        proxy_task.await??;
        stub_task.await??;
        drop(settings);
        return result;
    }
    let (sender, _messages) = tokio::sync::mpsc::unbounded_channel();
    let result = processor
        .run_apply_job(
            &registration,
            &team_job(project_id),
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
            }),
            None,
            None,
        )
        .await;
    if case == Case::TimeLimit {
        let error = result.expect_err("the hard limit stops the turn");
        assert!(
            format!("{error:#}").contains("Codex run timed out"),
            "{error:#}"
        );
        let artifacts = extract_job_failure_artifacts(&error).context("artifacts kept")?;
        let run_log = artifacts
            .iter()
            .find(|artifact| artifact["kind"] == "codex/run-log")
            .context("the run log is kept")?;
        assert!(
            run_log["events"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|event| event["item"]["command"]
                    .as_str()
                    .is_some_and(|text| text.contains("sleep 40"))),
            "the run log shows the command it was stopped in"
        );
        let request = artifacts
            .iter()
            .find(|artifact| artifact["kind"] == "agent/turn-continuation")
            .context("a continuation request")?;
        assert_eq!(request["endedBy"], "time_limit");
        assert!(
            request["note"]
                .as_str()
                .is_some_and(|note| note.contains("sleep 40") && note.contains("still running")),
            "{request}"
        );
        drop(proxy_guard);
        drop(stub_guard);
        proxy_task.await??;
        stub_task.await??;
        drop(settings);
        return Ok(());
    }
    let execution = result.context("team job near its time limit")?;

    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3, "step, note, final answer");
    let request = execution
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "agent/turn-continuation")
        .context("a continuation request")?;
    assert_eq!(request["requested"], true);
    assert_eq!(request["endedBy"], "agent");
    assert_eq!(request["note"], NOTE);
    let timings = execution
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "agent/turn-timings")
        .context("turn timings")?;
    let commands = timings["commands"].as_array().context("timed commands")?;
    let long = commands
        .iter()
        .find(|command| {
            command["command"]
                .as_str()
                .is_some_and(|text| text.contains("sleep 7"))
        })
        .context("the long step is timed")?;
    assert!(long["ms"].as_u64().unwrap_or(0) >= 6_500, "{long}");
    assert_eq!(timings["wrapUp"]["steered"], true);
    assert!(timings["wrapUp"]["atMs"].as_u64().unwrap_or(0) >= 3_500);
    assert_eq!(
        timings["steps"][0]["step"], "warm-up",
        "steps the tools reported"
    );
    let run_log = execution
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "codex/run-log")
        .context("run log")?;
    assert!(
        run_log["events"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|event| event["type"] == "item.completed" && event["atMs"].as_u64().is_some()),
        "run log events carry their time"
    );

    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    drop(settings);
    Ok(())
}

/// Turn 1 of a writing lane writes day-1.md and is stopped at its limit; turn 2, its
/// continuation, writes day-2.md. Turn 2's save holds both: nothing saved turn 1's edit.
async fn continued_write(
    processor: &JobProcessor,
    registration: &Registration,
    workspace: &Path,
    project_id: Uuid,
) -> Result<()> {
    fs::write(workspace.join("base.md"), "base\n")?;
    git_in(workspace, &["init", "-q", "-b", "main"])?;
    git_in(workspace, &["add", "base.md"])?;
    git_in(
        workspace,
        &[
            "-c",
            "user.name=Instafy Test",
            "-c",
            "user.email=test@instafy.invalid",
            "commit",
            "-q",
            "-m",
            "main",
        ],
    )?;
    let mut first = team_job(project_id);
    first.payload["prompt_text"] = json!("Write the day files.");
    first.payload["metadata"]["runtimeExpectations"]["workspaceFileChanges"] = json!(true);
    let record = |job: &LeaseJob| {
        workspace
            .join(".git/instafy-turn-baselines")
            .join(format!("{}.json", job.id))
    };
    let (sender, _messages) = tokio::sync::mpsc::unbounded_channel();
    let error = processor
        .run_apply_job(
            registration,
            &first,
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
            }),
            None,
            None,
        )
        .await
        .expect_err("the hard limit stops the first turn");
    let artifacts = extract_job_failure_artifacts(&error).context("artifacts kept")?;
    assert!(
        artifacts
            .iter()
            .any(|artifact| artifact["kind"] == "agent/turn-continuation"),
        "the stopped turn asks to continue"
    );
    assert_eq!(fs::read_to_string(workspace.join("day-1.md"))?, "day one\n");
    assert!(
        record(&first).is_file(),
        "the stopped turn keeps the record of how its folder began"
    );

    let mut next = team_job(project_id);
    next.payload = first.payload.clone();
    next.payload["metadata"]["multiAgentPlan"]["continuation"] =
        json!({"of": first.id.to_string(), "turn": 1, "last": false, "endedBy": "time_limit"});
    let (sender, _messages) = tokio::sync::mpsc::unbounded_channel();
    let execution = processor
        .run_apply_job(
            registration,
            &next,
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
            }),
            None,
            None,
        )
        .await
        .context("the continuation turn")?;
    let files = execution
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "apply/files")
        .and_then(|artifact| artifact["files"].as_array())
        .context("apply/files")?;
    let paths: Vec<&str> = files
        .iter()
        .filter_map(|file| file["workspacePath"].as_str())
        .collect();
    assert!(paths.contains(&"day-2.md"), "its own edit: {paths:?}");
    assert!(
        paths.contains(&"day-1.md"),
        "the edit of the turn it continues: {paths:?}"
    );
    assert!(!paths.contains(&"base.md"), "{paths:?}");
    assert!(
        !record(&next).exists(),
        "the continuation's end removes its own record"
    );
    Ok(())
}

fn team_job(project_id: Uuid) -> LeaseJob {
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("multi_agent_plan".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(Uuid::new_v4()),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text":"Summarize the lodging sources in the workspace.",
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},
                "multiAgentPlan":{"role":"worker","groupId":Uuid::new_v4()},
                "runtimeExpectations":{"workspaceFileChanges":false,"commandExecution":false,"genericMcpToolExecution":false}}
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
        lease_attempts: 1,
    }
}
