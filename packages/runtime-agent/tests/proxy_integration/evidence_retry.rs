//! The command-evidence retry through the real proxy with an inert, localhost
//! provider: the first attempt runs a shell command and answers, and the retry
//! answers with an empty code block. Which answer the job returns depends on
//! whether the first attempt ran a program or only printed its claimed output.

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_EVIDENCE_RETRY_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-evidence-retry-provider-key";
const WITNESS: &str = "EVIDENCE_RETRY_WITNESS_LINE";
const EMPTY_ANSWER: &str = "```\n```";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Case {
    /// A real read in a shape the recognizer does not credit.
    UnsupportedRead,
    /// Only literal output of the answer it then gives.
    EchoOnly,
}

impl Case {
    fn test_name(self) -> &'static str {
        match self {
            Self::UnsupportedRead => {
                "evidence_retry::an_empty_evidence_retry_keeps_the_answer_of_a_command_that_ran_via_proxy"
            }
            Self::EchoOnly => {
                "evidence_retry::an_empty_evidence_retry_replaces_an_answer_that_only_echoed_via_proxy"
            }
        }
    }

    fn command(self) -> String {
        match self {
            // awk is not a recognized formatting stage, so the read earns no
            // observation receipt and the retry runs.
            Self::UnsupportedRead => "cat reference.txt | awk '{print}'".to_string(),
            Self::EchoOnly => format!("echo {WITNESS}"),
        }
    }

    fn first_answer() -> String {
        format!("```\n{WITNESS}\n```")
    }
}

#[test]
fn an_empty_evidence_retry_keeps_the_answer_of_a_command_that_ran_via_proxy() -> Result<()> {
    run_isolated(Case::UnsupportedRead)
}

#[test]
fn an_empty_evidence_retry_replaces_an_answer_that_only_echoed_via_proxy() -> Result<()> {
    run_isolated(Case::EchoOnly)
}

fn run_isolated(case: Case) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, case.test_name(), "evidence-retry");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("evidence-retry-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("evidence-retry fixture panicked"))?
}

struct Provider {
    case: Case,
    requests: StdMutex<Vec<Value>>,
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
    json!({
        "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":json!({
            "summary":summary,"code":"","suggestions":[],"actions":[],"files":[]
        }).to_string()}]
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
    // The API-key proxy leg requests a complete JSON response.
    assert_eq!(body["stream"], false);
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body);
        requests.len() - 1
    };
    match index {
        0 => response(json!({
            "id":"tool_first_attempt","type":"function_call","name":"exec_command",
            "call_id":"call_first_attempt","status":"completed",
            "arguments":json!({"cmd":state.case.command(),"max_output_tokens":64}).to_string()
        })),
        1 => response(final_answer(&Case::first_answer())),
        // The evidence retry answers with an empty block and runs nothing.
        2 => response(final_answer(EMPTY_ANSWER)),
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
    fs::write(workspace.join("reference.txt"), format!("{WITNESS}\n"))?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-evidence-retry-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-evidence-retry-runtime-key"),
        ("CODEX_API_KEY", "inert-evidence-retry-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_SANDBOX_MODE", "workspace-write"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
        ("CODEX_RUN_TIMEOUT_SECONDS", "45"),
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
    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text":"Run one read-only shell command and paste its raw output in a code block.",
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{
                "workspaceFileChanges":false,"commandExecution":true,"genericMcpToolExecution":false
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
    let (sender, mut messages) = tokio::sync::mpsc::unbounded_channel();
    let execution = tokio::time::timeout(
        Duration::from_secs(90),
        processor.run_apply_job(
            &registration_for_live(Uuid::new_v4()),
            &job,
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
            }),
            None,
            None,
        ),
    )
    .await
    .context("evidence-retry job timed out")?
    .context("evidence-retry job failed")?;

    let mut retry_reasons = Vec::new();
    while let Ok(message) = messages.try_recv() {
        if let Some(metadata) = message.metadata
            && metadata.get("kind").and_then(Value::as_str) == Some("codex_retry")
        {
            retry_reasons.push(metadata["reason"].clone());
        }
    }
    assert_eq!(retry_reasons, vec![json!("missing_command_observation")]);
    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3, "command, first answer, retry answer");
    // The command really ran: its output went back to the model.
    let tool_output = requests[1]["input"]
        .as_array()
        .context("provider input items")?
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| item["output"].to_string())
        .collect::<String>();
    assert!(tool_output.contains(WITNESS), "tool output: {tool_output}");

    let artifact = |kind: &str| {
        execution
            .artifacts
            .iter()
            .any(|artifact| artifact.get("kind").and_then(Value::as_str) == Some(kind))
    };
    match case {
        Case::UnsupportedRead => {
            assert_eq!(execution.summary, Case::first_answer());
            assert!(artifact("codex/final-message-kept-from-attempt"));
        }
        Case::EchoOnly => {
            assert!(
                !execution.summary.contains(WITNESS),
                "summary: {}",
                execution.summary
            );
            assert!(!artifact("codex/final-message-kept-from-attempt"));
        }
    }
    // The retry still ran without accepted evidence either way.
    assert!(artifact("codex/command-observation-missing-after-retry"));

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
