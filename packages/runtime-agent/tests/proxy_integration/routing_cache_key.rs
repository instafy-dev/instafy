//! The routing step's cache key, through real turns with the real proxy and an inert, localhost
//! provider. A routing step is a new thread each time, and under its thread's key a provider
//! served none of the start every routing step repeats from its cache: in a local test (Nov 7)
//! each of 16 routing steps sent about 10k tokens, 0 to 23% of them cached, though about 95% of
//! each was the start the routing step before it sent. Two chats' routing steps now carry one
//! key, made from the routing instructions and the model, and send the same start; a chat's plan
//! group comes after it. A building turn keeps its own thread's key.

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_ROUTING_CACHE_KEY_TEST_CHILD";
const TEST_NAME: &str = "thread_mode::routing_cache_key::two_chats_routing_steps_send_one_cache_key_and_one_start_via_proxy";
const PROVIDER_KEY: &str = "inert-routing-cache-key-provider-key";
const ROUTING_OPENING: &str = "Instafy routing preflight.";
const LATEST_REQUEST: &str = "Latest user request:";
const PACKING: &str = "What should I pack for a weekend in Lisbon?";
const PROGRESS: &str = "How far along is the launch plan?";
/// The plan group of the second chat's team, which its routing step names.
const GROUP: &str = "8beaf901-8c46-49d9-a08b-c8e0043d5dc2";

#[test]
fn two_chats_routing_steps_send_one_cache_key_and_one_start_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, TEST_NAME, "routing-cache-key");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("routing-cache-key-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("routing-cache-key fixture panicked"))?
}

/// A request the provider got: its `session-id` header (the thread that sent it) and its body.
type Received = (Option<String>, Value);

struct Provider {
    requests: StdMutex<Vec<Received>>,
}

fn response(text: String) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5","output":[{
            "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
            "status":"completed","phase":"final_answer",
            "content":[{"type":"output_text","text":text}]
        }],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

/// The text of the request's last user message: a routing step's prompt, or a turn's message.
fn last_user_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .and_then(|input| input.iter().rev().find(|item| item["role"] == "user"))
        .and_then(|item| item["content"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect()
}

fn is_routing(request: &Value) -> bool {
    last_user_text(request).contains(ROUTING_OPENING)
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let session = headers
        .get("session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let routing = is_routing(&body);
    state.requests.lock().unwrap().push((session, body));
    if routing {
        return response(
            json!({
                "summary":"The person asks a question this chat can answer.","route":"direct",
                "reason":"No tool or page is needed.","selectedSkills":[],"confidence":100,
                "requiresContextLookup":false,"requiresCommandExecution":false,
                "workspaceFileChangeRequirement":"none","observationCommands":[],
                "workerQuestionReply":null
            })
            .to_string(),
        );
    }
    response(
        json!({"summary":"Here is my answer.","code":"","suggestions":[],"actions":[],"files":[]})
            .to_string(),
    )
}

/// What the model reads of a request item: the item's own id, and the time and the turn it was
/// made in, which name it in its thread and are no text the model reads, are left out (as the
/// routing check's dump leaves them out), and so is the day's date it was told, which turns over
/// at midnight.
fn as_cached(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| !matches!(key.as_str(), "id" | "create_time" | "turn_id"))
                .map(|(key, entry)| (key.clone(), as_cached(entry)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(as_cached).collect()),
        Value::String(text) => match (text.find("<current_date>"), text.find("</current_date>")) {
            (Some(open), Some(close)) if open < close => {
                Value::String(format!("{}<current_date>{}", &text[..open], &text[close..]))
            }
            _ => value.clone(),
        },
        _ => value.clone(),
    }
}

fn job(chat: Uuid, prompt: &str, history: Value) -> LeaseJob {
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: None,
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(chat),
        session_id: None,
        credential_id: None,
        // No `agentRoutingPreflight`: the message's route is not decided yet, so its job takes
        // the routing step first.
        payload: json!({
            "prompt_text":prompt,
            "conversation_history":history,
            "metadata":{
                "execution_mode":"apply",
                "runtimeExpectations":{
                    "workspaceFileChanges":false,"commandExecution":false,
                    "genericMcpToolExecution":false
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
    }
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-routing-cache-key-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-routing-cache-key-runtime-key"),
        ("CODEX_API_KEY", "inert-routing-cache-key-runtime-key"),
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
    // Two chats of one space: a question, and a chat whose team plan is under way.
    let packing = job(
        Uuid::new_v4(),
        PACKING,
        json!([{"role":"user","content":PACKING,"runId":"run-packing"}]),
    );
    let progress = job(
        Uuid::new_v4(),
        PROGRESS,
        json!([
            {"role":"user","content":"Plan the launch with a team.","runId":"run-plan"},
            {"role":"assistant","content":"The team is on it.","runId":"run-plan",
             "metadata":{"multiAgentPlan":{"groupId":GROUP}}},
            {"role":"user","content":PROGRESS,"runId":"run-progress"}
        ]),
    );
    for (label, job) in [("packing", &packing), ("progress", &progress)] {
        let mut job = job.clone();
        job.project_id = Some(project_id);
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
        .with_context(|| format!("the {label} job timed out"))?
        .with_context(|| format!("the {label} job failed"))?;
    }

    let requests = state.requests.lock().unwrap().clone();
    let routing_step = |words: &str| -> Result<&Received> {
        requests
            .iter()
            .find(|(_, request)| is_routing(request) && last_user_text(request).contains(words))
            .with_context(|| format!("no routing step for {words:?}"))
    };
    let building_turn = |words: &str| -> Result<&Received> {
        requests
            .iter()
            .find(|(_, request)| !is_routing(request) && last_user_text(request).contains(words))
            .with_context(|| format!("no building turn for {words:?}"))
    };
    let (packing_session, packing_routing) = routing_step(PACKING)?;
    let (progress_session, progress_routing) = routing_step(PROGRESS)?;
    let key = |request: &Value| request["prompt_cache_key"].as_str().map(str::to_string);

    // One key for both chats' routing steps, and not either thread's own.
    let routing_key = key(packing_routing).context("the routing step sent no cache key")?;
    assert_eq!(
        key(progress_routing).as_deref(),
        Some(routing_key.as_str()),
        "the two chats' routing steps carry different cache keys"
    );
    for session in [packing_session, progress_session] {
        assert_ne!(
            session.as_deref(),
            Some(routing_key.as_str()),
            "a routing step's key is its thread's"
        );
    }

    // The same start: everything the provider reads ahead of the routing prompt, then the
    // prompt's start up to the message. The second chat's plan group comes after it.
    let without_input = |request: &Value| {
        let mut head = request.clone();
        let map = head.as_object_mut().expect("a request is an object");
        map.remove("input");
        map.remove("prompt_cache_key");
        head
    };
    assert_eq!(
        without_input(packing_routing),
        without_input(progress_routing),
        "the two routing steps differ ahead of their input"
    );
    let input = |request: &Value| request["input"].as_array().cloned().unwrap_or_default();
    let (packing_input, progress_input) = (input(packing_routing), input(progress_routing));
    assert_eq!(packing_input.len(), progress_input.len());
    let ahead = packing_input.len() - 1;
    for (index, (one, other)) in packing_input[..ahead]
        .iter()
        .zip(&progress_input[..ahead])
        .enumerate()
    {
        assert_eq!(
            as_cached(one),
            as_cached(other),
            "input item {index} ahead of the routing prompt differs"
        );
    }
    let packing_prompt = last_user_text(packing_routing);
    let progress_prompt = last_user_text(progress_routing);
    let start = &packing_prompt[..packing_prompt
        .find(LATEST_REQUEST)
        .context("the routing prompt names no message")?];
    assert!(
        start.contains(ROUTING_OPENING) && start.len() > 4_000,
        "the routing prompt's start is not its instructions: {start:?}"
    );
    assert!(
        progress_prompt.starts_with(start),
        "the second chat's routing prompt does not open with the first's start"
    );
    assert!(
        progress_prompt[start.len()..].contains(GROUP),
        "the second chat's plan group is not after the start"
    );

    // Each building turn keeps its own thread's key, as before: its `session-id`'s.
    let (packing_turn_session, packing_turn) = building_turn(PACKING)?;
    let (progress_turn_session, progress_turn) = building_turn(PROGRESS)?;
    let packing_turn_key = key(packing_turn).context("a building turn sent no cache key")?;
    let progress_turn_key = key(progress_turn).context("a building turn sent no cache key")?;
    assert_eq!(
        packing_turn_session.as_deref(),
        Some(packing_turn_key.as_str())
    );
    assert_eq!(
        progress_turn_session.as_deref(),
        Some(progress_turn_key.as_str())
    );
    assert_ne!(packing_turn_key, progress_turn_key);
    assert_ne!(packing_turn_key, routing_key);
    assert_ne!(progress_turn_key, routing_key);

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
