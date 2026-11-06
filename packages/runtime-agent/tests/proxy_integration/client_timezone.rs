//! The person's time zone through a real turn, with an inert, localhost provider: the command
//! the turn runs sees it as `TZ`, while the date the turn is told, and the zone named beside it,
//! stay the machine's, as in every other lane. A zone set for the whole process moved the date and
//! not its name: at 23:00 UTC a browser turn read 2026-11-06 "in Etc/UTC", while the routing step
//! read 2026-11-05 (a local test, Nov 5).

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_CLIENT_TIMEZONE_TEST_CHILD";
const TEST_NAME: &str = "client_timezone::a_turns_command_sees_the_persons_time_zone_and_the_turn_keeps_the_machines_date_via_proxy";
const PROVIDER_KEY: &str = "inert-client-timezone-provider-key";
const ZONE_LINE: &str = "PERSONS_ZONE=";

#[test]
fn a_turns_command_sees_the_persons_time_zone_and_the_turn_keeps_the_machines_date_via_proxy()
-> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, TEST_NAME, "client-timezone");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("client-timezone-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("client-timezone fixture panicked"))?
}

/// A zone whose date today is not this machine's, so a turn dated by the person's zone would
/// show: of two zones 26 hours apart, one always has another date.
fn a_zone_whose_date_is_not_the_machines() -> &'static str {
    use chrono::{FixedOffset, Local, Utc};
    let now = Utc::now();
    let machine = now.with_timezone(&Local).format("%Y-%m-%d").to_string();
    [
        ("Etc/GMT-14", FixedOffset::east_opt(14 * 3600)),
        ("Etc/GMT+12", FixedOffset::west_opt(12 * 3600)),
    ]
    .into_iter()
    .find_map(|(zone, offset)| {
        let date = now.with_timezone(&offset?).format("%Y-%m-%d").to_string();
        (date != machine).then_some(zone)
    })
    .expect("two zones 26 hours apart never share a date")
}

fn machine_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

struct Provider {
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
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body);
        requests.len() - 1
    };
    if index == 0 {
        response(json!({
            "id":"tool_zone","type":"function_call","name":"exec_command",
            "call_id":"call_zone","status":"completed",
            "arguments":json!({
                "cmd":format!("printf '{ZONE_LINE}%s\\n' \"$TZ\""),
                "max_output_tokens":64
            }).to_string()
        }))
    } else {
        response(final_answer(&format!("```\n{ZONE_LINE}\n```")))
    }
}

/// The date and the zone a request tells the model, from its environment context.
fn told(request: &Value, element: &str) -> Option<String> {
    let text = request.to_string();
    let open = format!("<{element}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&format!("</{element}>"))?;
    Some(text[start..end].to_string())
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let zone = a_zone_whose_date_is_not_the_machines();
    let date_before = machine_date();
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-client-timezone-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-client-timezone-runtime-key"),
        ("CODEX_API_KEY", "inert-client-timezone-runtime-key"),
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
    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text":"Run one read-only shell command that prints the TZ variable, and paste its raw output in a code block.",
            "metadata":{
                "execution_mode":"apply","agentRoutingPreflight":{},
                "client":{"timezone":zone,"locale":"en-US"},
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
    .context("client-timezone job timed out")?
    .context("client-timezone job failed")?;
    let date_after = machine_date();

    let requests = state.requests.lock().unwrap().clone();
    assert!(requests.len() >= 2, "a command and an answer");
    // The command saw the person's zone.
    let tool_output = requests[1]["input"]
        .as_array()
        .context("provider input items")?
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| item["output"].to_string())
        .collect::<String>();
    assert!(
        tool_output.contains(&format!("{ZONE_LINE}{zone}")),
        "tool output: {tool_output}"
    );
    // The turn is dated by this machine's clock, beside this machine's zone: never the person's
    // date under another zone's name.
    let date = told(&requests[0], "current_date").context("the turn's date")?;
    assert!(
        date == date_before || date == date_after,
        "told {date}; the machine's date is {date_before}"
    );
    let named = told(&requests[0], "timezone").context("the turn's zone")?;
    assert_ne!(named, zone, "the zone named beside the date");

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
