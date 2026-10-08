//! Native compaction through the real proxy with an inert, localhost provider.
//! The mid-turn edit checks sampling-boundary refresh, beyond the original
//! prompt-boundary preference guarantee. Opaque fixture bytes are never decoded.

use super::*;
use sha2::{Digest, Sha256};
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_NATIVE_COMPACTION_TEST_CHILD";
const INITIAL: &str = "Prefer concise explanations with a verification note.";
const CORRECTED: &str = "Prefer a detailed explanation followed by a short conclusion.";
const OPAQUE: &str = "inert-opaque-compaction-checkpoint+/=";
const PROVIDER_KEY: &str = "inert-native-compaction-provider-key";
const ACCOUNT: &str = "inert-native-compaction-account";
const TOOL_WITNESS: &str = "NATIVE_COMPACTION_TOOL_EXECUTED";

#[derive(Clone, Copy)]
enum Transport {
    ChatGpt,
    ApiKey,
}

impl Transport {
    fn test_name(self) -> &'static str {
        match self {
            Self::ChatGpt => {
                "native_compaction::native_compaction_refreshes_preferences_and_cold_resumes_via_proxy"
            }
            Self::ApiKey => {
                "native_compaction::native_compaction_refreshes_preferences_and_cold_resumes_via_api_key_proxy"
            }
        }
    }

    fn streams(self) -> bool {
        matches!(self, Self::ChatGpt)
    }
}

#[test]
fn native_compaction_refreshes_preferences_and_cold_resumes_via_proxy() -> Result<()> {
    run_isolated(Transport::ChatGpt)
}

#[test]
fn native_compaction_refreshes_preferences_and_cold_resumes_via_api_key_proxy() -> Result<()> {
    run_isolated(Transport::ApiKey)
}

fn run_isolated(transport: Transport) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, transport.test_name(), "native-compaction");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("native-compaction-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_lifecycle(transport))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("native-compaction fixture panicked"))?
}

struct Provider {
    transport: Transport,
    workspace: PathBuf,
    requests: StdMutex<Vec<Value>>,
}

fn write_preferences(workspace: &Path, preference: &str) -> Result<()> {
    fs::write(
        workspace.join("INSTAFY.md"),
        format!(
            "# Project\n\n## Project preferences\n{preference}\n\n## Facts\nLocal fixture only.\n"
        ),
    )?;
    Ok(())
}

fn fixture_response(
    transport: Transport,
    item: Value,
    total_tokens: u64,
    empty_final_output: bool,
) -> axum::response::Response {
    let id = format!("resp_{}", Uuid::new_v4());
    let response = json!({
        "id":id,"object":"response","status":"completed","model":"gpt-5.5",
        "output": if empty_final_output && transport.streams() { vec![] } else { vec![item.clone()] },
        "usage":{"input_tokens":total_tokens - 10,"output_tokens":10,"total_tokens":total_tokens}
    });
    if !transport.streams() {
        // The API-key proxy leg requests a complete JSON response. It must
        // preserve the same opaque item through its typed output parser.
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

fn final_item() -> Value {
    json!({
        "id":format!("msg_{}",Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":json!({
            "summary":"Local compaction fixture completed.","code":"","files":[],"actions":[]
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
    assert_eq!(
        headers
            .get("chatgpt-account-id")
            .and_then(|v| v.to_str().ok()),
        state.transport.streams().then_some(ACCOUNT)
    );
    assert_eq!(
        body["stream"],
        state.transport.streams(),
        "exercise the credential's actual proxy transport"
    );
    let index = {
        let mut requests = state.requests.lock().unwrap();
        let index = requests.len();
        requests.push(body.clone());
        index
    };
    let compaction = body["input"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["type"] == "compaction_trigger")
    });
    match index {
        0 => {
            assert!(!compaction, "the first request must be normal sampling");
            // The command itself is inert. Reported usage forces Codex's native
            // mid-turn threshold after its actual tool output is recorded.
            fixture_response(
                state.transport,
                json!({
                    "id":"tool_before_compaction","type":"function_call","name":"exec_command",
                    "call_id":"call_before_compaction","status":"completed",
                    "arguments":json!({"cmd":format!("printf {TOOL_WITNESS}"),"max_output_tokens":64}).to_string()
                }),
                200_000,
                false,
            )
        }
        1 => {
            assert!(
                compaction,
                "high usage must trigger real native v2 compaction"
            );
            write_preferences(&state.workspace, CORRECTED).expect("change fixture preferences");
            // For ChatGPT, deliberately absent from completed.output: this
            // requires the real proxy's streamed-item merger. API-key JSON
            // carries the opaque item in output instead.
            fixture_response(
                state.transport,
                json!({"type":"compaction","encrypted_content":OPAQUE}),
                80,
                true,
            )
        }
        2 | 3 => {
            assert!(
                !compaction,
                "continuation and cold resume are ordinary sampling"
            );
            fixture_response(state.transport, final_item(), 80, false)
        }
        _ => panic!("unexpected extra provider request {index}"),
    }
}

async fn run_lifecycle(transport: Transport) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    write_preferences(&workspace, INITIAL)?;
    fs::write(
        runtime_home.path().join("config.toml"),
        "model_auto_compact_token_limit = 100000\n",
    )?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-native-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-native-runtime-key"),
        ("CODEX_API_KEY", "inert-native-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_PERSIST_STRUCTURED_CONVERSATION_THREAD", "true"),
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
        transport,
        workspace: workspace.clone(),
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
    settings.push(EnvGuard::set(
        "CODEX_PROXY_CHATGPT_ENDPOINT",
        format!("http://{upstream}/backend-api/codex/responses"),
    ));
    settings.push(EnvGuard::set(
        "CODEX_CHATGPT_ENDPOINT",
        format!("http://{upstream}/backend-api/codex/responses"),
    ));
    let port = reserve_port()?;
    let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
    let credentials = match transport {
        Transport::ChatGpt => auth::Credentials::ChatGpt {
            access_token: PROVIDER_KEY.to_string(),
            refresh_token: None,
            account_id: Some(ACCOUNT.to_string()),
            default_model: Some("gpt-5.5".to_string()),
            auth_path: None,
        },
        Transport::ApiKey => auth::Credentials::ApiKey {
            key: PROVIDER_KEY.to_string(),
            endpoint: Some(format!("http://{upstream}/backend-api/codex/responses")),
            default_model: Some("gpt-5.5".to_string()),
        },
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
    let first = JobProcessor::new(config.clone())
        .run_apply_job(
            &registration,
            &job(project_id, conversation_id, None),
            true,
            None,
            None,
            None,
        )
        .await
        .context("initial compaction job")?;
    let saved = first
        .provider_conversation_state
        .context("persisted provider state")?;
    let rollout = PathBuf::from(
        saved["defaultRolloutPath"]
            .as_str()
            .context("persisted rollout path")?,
    );
    assert!(
        rollout.starts_with(runtime_home.path()),
        "rollout must stay in disposable runtime home"
    );
    assert!(rollout.is_file());

    // A new processor constructs a fresh CodexClient/ThreadManager. No in-memory
    // thread is available: opaque compaction must survive legacy rollout resume.
    fs::write(
        workspace.join("INSTAFY.md"),
        "# Project\n\n## Facts\nLocal fixture only.\n",
    )?;
    let resumed = JobProcessor::new(config)
        .run_apply_job(
            &registration,
            &job(project_id, conversation_id, Some(saved.clone())),
            true,
            None,
            None,
            None,
        )
        .await
        .context("cold-resumed removal job")?;
    let restored = resumed
        .provider_conversation_state
        .context("resumed provider state")?;
    assert_eq!(restored["defaultThreadId"], saved["defaultThreadId"]);
    assert_eq!(restored["defaultThreadRestoreSource"], "rollout");
    assert_eq!(restored["defaultThreadRestoreFailed"], false);
    assert_eq!(restored["historyReplayRequired"], false);

    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(
        requests.len(),
        4,
        "sampling, compaction, continuation, cold resume"
    );
    assert_eq!(
        input_text(&requests[0]).matches(INITIAL).count(),
        1,
        "initial current snapshot must not be duplicated"
    );
    assert_current_snapshot(&requests[0], project_id, "loaded", INITIAL);
    assert!(
        input_text(&requests[1]).contains(TOOL_WITNESS),
        "compaction follows a completed real tool call"
    );
    for request in &requests[2..] {
        let opaque = request["input"]
            .as_array()
            .context("provider input items")?
            .iter()
            .filter(|item| item["type"] == "compaction")
            .collect::<Vec<_>>();
        assert_eq!(
            opaque.len(),
            1,
            "opaque checkpoint survives without duplication"
        );
        assert_eq!(opaque[0]["encrypted_content"], OPAQUE);
    }
    assert_current_snapshot(&requests[3], project_id, "empty", "");
    // Check this last so the initial red run still proves proxy transport and
    // cold resume. Prefix-only delivery keeps A here and cannot refresh to B.
    assert_current_snapshot(&requests[2], project_id, "loaded", CORRECTED);

    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}

fn job(project_id: Uuid, conversation_id: Uuid, previous: Option<Value>) -> LeaseJob {
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(conversation_id),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text":"Report the local fixture result without changing workspace files.",
            "provider_conversation_state":previous,
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{
                "workspaceFileChanges":false,"commandExecution":false,"genericMcpToolExecution":false
            }}
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: None,
        workspace_token_scopes: None,
        workspace_token_expires_at: None,
    }
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

fn assert_current_snapshot(request: &Value, project: Uuid, state: &str, content: &str) {
    let text = input_text(request);
    let revision = format!("sha256:{:x}", Sha256::digest(content.as_bytes()));
    let scope = format!("Project: {project}\nSource: INSTAFY.md#Project preferences\n");
    let expected = format!(
        "Project: {project}\nSource: INSTAFY.md#Project preferences\nState: {state}\nRevision: {revision}"
    );
    assert!(
        text.contains(&expected),
        "sampling request is missing current {state} preference snapshot ({revision}); initial_present={}, corrected_present={}, source_present={}",
        text.contains(INITIAL),
        text.contains(CORRECTED),
        text.contains("Source: INSTAFY.md#Project preferences")
    );
    // Older snapshots may remain as history. The latest block for this exact
    // project/source must be the current one, with scoped replacement semantics.
    assert_eq!(text.rfind(&scope), text.rfind(&expected));
    let current_item = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|item| {
            item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|part| {
                    part["text"]
                        .as_str()
                        .is_some_and(|text| text.contains(&expected))
                })
        })
        .expect("current snapshot belongs to a visible message");
    assert_eq!(
        current_item["role"], "user",
        "project text must not gain developer authority"
    );
    if !content.is_empty() {
        assert!(text.contains(content));
    } else {
        assert!(text.contains(
            "Withdraw prior defaults for this project/source only; keep other preferences."
        ));
    }
}
