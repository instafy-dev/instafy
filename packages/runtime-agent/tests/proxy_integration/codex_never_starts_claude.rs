//! Codex may not start the person's own `claude` (docs/Local-Engine-Turns.md, D22), through a
//! real turn with an inert, localhost provider: the model asks for `claude` by its bare name and
//! by an absolute path, and Codex refuses both before anything runs, with the harness's reason.
//! The same program under another name runs, so the refusal is the rule's and not the shell's.

use super::*;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_CODEX_NEVER_STARTS_CLAUDE_TEST_CHILD";
const TEST_NAME: &str =
    "codex_never_starts_claude::a_codex_turn_is_refused_claude_by_name_and_by_path_via_proxy";
const PROVIDER_KEY: &str = "inert-codex-never-starts-claude-provider-key";
/// What Codex says of a refused command: "`<command>` rejected: <the harness's reason>".
const REFUSED: &str = "rejected: This runtime does not let an agent start Claude Code.";

#[test]
fn a_codex_turn_is_refused_claude_by_name_and_by_path_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, TEST_NAME, "codex-never-starts-claude");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("codex-never-starts-claude-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_case())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("codex-never-starts-claude fixture panicked"))?
}

struct Provider {
    /// The commands the model asks for, in order.
    commands: Vec<String>,
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

fn tool_outputs(request: &Value) -> Vec<(String, String)> {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| {
            (
                item["call_id"].as_str().unwrap_or_default().to_string(),
                item["output"].to_string(),
            )
        })
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
    // Each request carries the outputs of the commands asked for so far: ask for the next one.
    let answered = tool_outputs(&body).len();
    state.requests.lock().unwrap().push(body);
    match state.commands.get(answered) {
        Some(command) => response(json!({
            "id":format!("tool_{answered}"),"type":"function_call","name":"exec_command",
            "call_id":format!("call_{answered}"),"status":"completed",
            "arguments":json!({ "cmd":command, "max_output_tokens":256 }).to_string()
        })),
        None => response(final_answer("Done.")),
    }
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let programs = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    // The same program twice: as `claude`, and under a name the rule does not hold.
    let ran = programs.path().join("ran");
    fs::create_dir_all(&ran)?;
    let bin = programs.path().join("bin");
    fs::create_dir_all(&bin)?;
    for name in ["claude", "not-claude"] {
        let program = bin.join(name);
        fs::write(
            &program,
            format!(
                "#!/bin/sh\ntouch '{}'\necho '{name} ran'\n",
                ran.join(name).display()
            ),
        )?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755))?;
    }
    let claude = bin.join("claude");
    let not_claude = bin.join("not-claude");
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-codex-never-starts-claude-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        (
            "OPENAI_API_KEY",
            "inert-codex-never-starts-claude-runtime-key",
        ),
        (
            "CODEX_API_KEY",
            "inert-codex-never-starts-claude-runtime-key",
        ),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_SANDBOX_MODE", "danger-full-access"),
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
    // `claude` resolves to the stand-in by name too.
    settings.push(EnvGuard::set(
        "PATH",
        format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        ),
    ));

    let state = Arc::new(Provider {
        commands: vec![
            "claude -p 'Tidy the README'".to_string(),
            format!("{} --version", claude.display()),
            format!("{} --version", not_claude.display()),
        ],
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
            "prompt_text":"Ask Claude Code to tidy the README, then report what happened.",
            "metadata":{
                "execution_mode":"apply","agentRoutingPreflight":{},
                "runtimeExpectations":{
                    "workspaceFileChanges":false,"commandExecution":true,"genericMcpToolExecution":false
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
        lease_attempts: 1,
        grants: Vec::new(),
        grant_token: None,
        engine: None,
    };
    let (sender, _messages) = tokio::sync::mpsc::unbounded_channel();
    tokio::time::timeout(
        Duration::from_secs(90),
        processor.run_apply_job(
            &registration_for_live(Uuid::new_v4()),
            &job,
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
                reply_draft: None,
            }),
            None,
            None,
        ),
    )
    .await
    .context("codex-never-starts-claude job timed out")?
    .context("codex-never-starts-claude job failed")?;

    let requests = state.requests.lock().unwrap().clone();
    let outputs: HashMap<String, String> = requests
        .last()
        .map(tool_outputs)
        .unwrap_or_default()
        .into_iter()
        .collect();
    assert_eq!(outputs.len(), 3, "an output for each command: {outputs:?}");
    for call in ["call_0", "call_1"] {
        let output = &outputs[call];
        assert!(output.contains(REFUSED), "{call}: {output}");
    }
    assert!(
        !ran.join("claude").exists(),
        "claude ran: {:?}",
        outputs["call_0"]
    );
    // The same program under another name runs.
    assert!(
        outputs["call_2"].contains("not-claude ran"),
        "{}",
        outputs["call_2"]
    );
    assert!(ran.join("not-claude").exists());

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
