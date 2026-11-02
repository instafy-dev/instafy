//! A chat turn's reply reaches its draft while the model still writes it:
//! the embedded Codex runtime reads a provider that streams the answer in
//! pieces over seconds, and the job's draft holds each piece's summary text
//! well before the next piece is sent. All traffic passes through the real
//! Instafy proxy to an inert localhost SSE provider; no external model is called.

use super::*;
use futures_util::StreamExt;
use std::sync::Mutex as StdMutex;
use tokio::sync::watch;

use runtime_agent::jobs::ReplyDraft;

const CHILD: &str = "INSTAFY_REPLY_DRAFT_STREAM_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-reply-draft-provider-key";
const FIRST: &str = "{\"summary\":\"The deployment is ready.";
const SECOND: &str =
    " Nothing else changed.\",\"code\":\"\",\"suggestions\":[],\"files\":[],\"actions\":[]}";
const SUMMARY: &str = "The deployment is ready. Nothing else changed.";
const PAUSE: Duration = Duration::from_millis(1_500);

#[test]
fn a_streamed_answer_reaches_the_reply_draft_piece_by_piece() -> Result<()> {
    run_fixture(
        false,
        "reply_draft_stream::a_streamed_answer_reaches_the_reply_draft_piece_by_piece",
    )
}

#[test]
fn a_plain_final_answer_reaches_the_reply_draft_piece_by_piece() -> Result<()> {
    run_fixture(
        true,
        "reply_draft_stream::a_plain_final_answer_reaches_the_reply_draft_piece_by_piece",
    )
}

fn run_fixture(plain: bool, test_name: &str) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, test_name, "reply-draft-stream");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("reply-draft-stream".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_turn(plain))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("reply-draft-stream fixture panicked"))?
}

#[derive(Default)]
struct Provider {
    plain: bool,
    /// When each answer piece went out.
    sent: StdMutex<Vec<Instant>>,
}

fn sse(event: Value) -> Event {
    Event::default().data(event.to_string())
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    headers: HeaderMap,
    Json(_body): Json<Value>,
) -> axum::response::Response {
    assert_eq!(
        headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some(format!("Bearer {PROVIDER_KEY}").as_str())
    );
    let first_text = if state.plain {
        "The deployment is ready."
    } else {
        FIRST
    };
    let second_text = if state.plain {
        " Nothing else changed."
    } else {
        SECOND
    };
    let full_text = format!("{first_text}{second_text}");
    let response_id = format!("resp_{}", Uuid::new_v4());
    let item_id = format!("msg_{}", Uuid::new_v4());
    let item = |text: &str| {
        json!({
            "id": item_id, "type": "message", "role": "assistant", "status": "completed",
            "phase": "final_answer",
            "content": [{ "type": "output_text", "text": text }],
        })
    };
    let response = |status: &str| {
        json!({
            "id": response_id, "object": "response", "status": status, "model": "gpt-5.5",
            "output": if status == "completed" { json!([item(&full_text)]) } else { json!([]) },
            "usage": { "input_tokens": 40, "output_tokens": 12, "total_tokens": 52 },
        })
    };
    let opening = vec![
        sse(json!({ "type": "response.created", "response": response("in_progress") })),
        sse(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "id": item_id, "type": "message", "role": "assistant", "status": "in_progress", "phase": "final_answer", "content": [] },
        })),
    ];
    let delta = |text: &str| {
        sse(json!({
            "type": "response.output_text.delta",
            "item_id": item_id, "output_index": 0, "content_index": 0, "delta": text,
        }))
    };
    let first = delta(first_text);
    let second = delta(second_text);
    let closing = vec![
        sse(
            json!({ "type": "response.output_item.done", "output_index": 0, "item": item(&full_text) }),
        ),
        sse(json!({ "type": "response.completed", "response": response("completed") })),
    ];
    let events = stream::iter(opening.into_iter().map(Ok::<Event, Infallible>))
        .chain(stream::once({
            let state = state.clone();
            async move {
                state.sent.lock().unwrap().push(Instant::now());
                Ok(first)
            }
        }))
        .chain(stream::once({
            let state = state.clone();
            async move {
                sleep(PAUSE).await;
                state.sent.lock().unwrap().push(Instant::now());
                Ok(second)
            }
        }))
        .chain(stream::iter(closing.into_iter().map(Ok)));
    Sse::new(events).into_response()
}

async fn run_turn(plain: bool) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    fs::create_dir_all(workspace_root.path().join(project_id.to_string()))?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({ "OPENAI_API_KEY": PROVIDER_KEY }).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("PROXY_STREAM_PASSTHROUGH", "true"),
        ("OPENAI_API_KEY", PROVIDER_KEY),
        ("CODEX_API_KEY", PROVIDER_KEY),
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
        plain,
        ..Provider::default()
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream = listener.local_addr()?;
    let app = Router::new()
        .route("/v1/responses", post(provider_request))
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
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{upstream}/v1/responses"),
    ));
    let port = reserve_port()?;
    let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
    let (proxy_shutdown, proxy_rx) = oneshot::channel();
    let proxy_task = tokio::spawn(proxy::run_proxy_with_shutdown(
        proxy_address,
        Some(auth::Credentials::ApiKey {
            key: PROVIDER_KEY.to_string(),
            endpoint: None,
            default_model: Some("gpt-5.5".to_string()),
        }),
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
    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(Uuid::new_v4()),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": "Is the deployment ready? Don't change any files.",
            "metadata": {
                "execution_mode": "apply",
                "replyContext": if plain { json!({"kind":"message_selection","action":"summarize"}) } else { Value::Null },
                "agentRoutingPreflight": {},
                "runtimeExpectations": {
                    "workspaceFileChanges": false,
                    "commandExecution": false,
                    "genericMcpToolExecution": false,
                },
            },
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

    // Every draft the job writes, and when.
    let (draft_sender, mut drafts) = watch::channel(ReplyDraft::default());
    let observed = Arc::new(StdMutex::new(Vec::<(Instant, String)>::new()));
    let watcher = tokio::spawn({
        let observed = observed.clone();
        async move {
            while drafts.changed().await.is_ok() {
                let text = drafts.borrow_and_update().text.clone();
                observed.lock().unwrap().push((Instant::now(), text));
            }
        }
    });
    let (sender, _messages) = tokio::sync::mpsc::unbounded_channel();
    let execution = JobProcessor::new(config)
        .run_apply_job(
            &registration_for_live(Uuid::new_v4()),
            &job,
            true,
            Some(JobProgress {
                sender,
                status: Arc::new(AtomicBool::new(true)),
                reply_draft: Some(draft_sender),
            }),
            None,
            None,
        )
        .await
        .context("streamed chat job")?;
    watcher.await?;
    assert_eq!(execution.summary, SUMMARY);

    let sent = state.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2, "the provider sent the answer in two pieces");
    let observed = observed.lock().unwrap().clone();
    let first_piece = observed
        .iter()
        .find(|(_, text)| text == "The deployment is ready.")
        .context("a draft of the first piece alone")?;
    println!(
        "[reply-draft] first piece drafted {:?} after the provider sent it",
        first_piece.0.duration_since(sent[0])
    );
    assert!(
        first_piece.0 < sent[1],
        "the first piece was drafted before the second was sent: {observed:?}"
    );
    assert!(
        first_piece.0.duration_since(sent[0]) < Duration::from_secs(1),
        "the first piece was drafted within a second of being sent"
    );
    assert_eq!(
        observed.last().map(|(_, text)| text.as_str()),
        Some(SUMMARY)
    );

    drop(proxy_guard);
    proxy_task.await??;
    drop(stub_guard);
    stub_task.await??;
    drop(settings);
    Ok(())
}
