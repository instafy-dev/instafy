//! A model's answer reaches the embedded Codex runtime while the provider still writes it,
//! through the real Instafy proxy. The provider is an inert localhost stub that sends the first
//! piece of the answer and holds the rest until the runtime has reported that piece.

use super::*;
use axum::body::Body;
use std::sync::atomic::AtomicBool;
use tokio::sync::Notify;

const CHILD: &str = "INSTAFY_PROXY_STREAM_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-proxy-stream-provider-key";
const FIRST: &str = "{\"summary\":\"The deployment is ready.";
const SECOND: &str =
    " Nothing else changed.\",\"code\":\"\",\"suggestions\":[],\"files\":[],\"actions\":[]}";

#[test]
fn a_streamed_answer_reaches_the_runtime_through_the_proxy_while_it_is_written() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "proxy_stream::a_streamed_answer_reaches_the_runtime_through_the_proxy_while_it_is_written",
            "proxy-stream",
        );
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("proxy-stream".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_turn())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("proxy-stream fixture panicked"))?
}

struct Provider {
    /// Opened by the runtime's first report of the answer's text.
    gate: Notify,
    /// Whether the runtime opened the gate, rather than the provider giving up waiting.
    opened_by_runtime: AtomicBool,
    requests: AtomicUsize,
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
    // The proxy asks the OpenAI API for a stream.
    assert_eq!(body.get("stream"), Some(&Value::Bool(true)));
    state.requests.fetch_add(1, Ordering::SeqCst);
    let response_id = format!("resp_{}", Uuid::new_v4());
    let item_id = format!("msg_{}", Uuid::new_v4());
    let item = |status: &str, text: &str| {
        json!({"id": item_id, "type": "message", "role": "assistant", "status": status,
            "content": [{"type": "output_text", "text": text, "annotations": []}]})
    };
    let full = format!("{FIRST}{SECOND}");
    let event = |value: Value| format!("data: {value}\n\n");
    let first = [
        event(
            json!({"type": "response.created", "response": {"id": response_id,
            "object": "response", "status": "in_progress", "model": "gpt-5.5", "output": []}}),
        ),
        event(
            json!({"type": "response.output_item.added", "output_index": 0,
            "item": item("in_progress", "")}),
        ),
        event(
            json!({"type": "response.output_text.delta", "item_id": item_id,
            "output_index": 0, "content_index": 0, "delta": FIRST}),
        ),
    ]
    .concat();
    let rest = [
        event(
            json!({"type": "response.output_text.delta", "item_id": item_id,
            "output_index": 0, "content_index": 0, "delta": SECOND}),
        ),
        event(
            json!({"type": "response.output_item.done", "output_index": 0,
            "item": item("completed", &full)}),
        ),
        event(
            json!({"type": "response.completed", "response": {"id": response_id,
            "object": "response", "status": "completed", "model": "gpt-5.5",
            "output": [item("completed", &full)],
            "usage": {"input_tokens": 40, "output_tokens": 12, "total_tokens": 52}}}),
        ),
    ]
    .concat();
    let chunks = futures_util::stream::unfold(0, move |step| {
        let (first, rest, state) = (first.clone(), rest.clone(), state.clone());
        async move {
            match step {
                0 => Some((Ok::<_, std::io::Error>(first), 1)),
                1 => {
                    if tokio::time::timeout(Duration::from_secs(15), state.gate.notified())
                        .await
                        .is_err()
                    {
                        eprintln!("[proxy-stream] the runtime never reported the first piece");
                    }
                    Some((Ok(rest), 2))
                }
                _ => None,
            }
        }
    });
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(chunks),
    )
        .into_response()
}

async fn run_turn() -> Result<()> {
    let _env = env_guard().await;
    let workspace = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({ "OPENAI_API_KEY": "inert-proxy-stream-runtime-key" }).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-proxy-stream-runtime-key"),
        ("CODEX_API_KEY", "inert-proxy-stream-runtime-key"),
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
        gate: Notify::new(),
        opened_by_runtime: AtomicBool::new(false),
        requests: AtomicUsize::new(0),
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
    // An API key without an endpoint of its own goes to the OpenAI API, here the stub.
    settings.push(EnvGuard::set(
        "CODEX_OPENAI_ENDPOINT",
        format!("http://{upstream}/v1/responses"),
    ));
    let port = reserve_port()?;
    let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
    let credentials = auth::Credentials::ApiKey {
        key: PROVIDER_KEY.to_string(),
        endpoint: None,
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

    let codex = CodexClient::from_env(workspace.path()).context("embedded Codex client")?;
    let first_piece_seen = Arc::new(AtomicBool::new(false));
    let mut on_event = {
        let state = state.clone();
        let first_piece_seen = first_piece_seen.clone();
        move |event: &Value| -> Result<()> {
            let text = event
                .pointer("/item/text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if event["type"] == "item.updated"
                && event.pointer("/item/type") == Some(&json!("agent_message"))
                && text.contains("The deployment is ready.")
                && !first_piece_seen.swap(true, Ordering::SeqCst)
            {
                state.opened_by_runtime.store(true, Ordering::SeqCst);
                state.gate.notify_one();
            }
            Ok(())
        }
    };
    let output = codex
        .execute_with_options(
            "Is the deployment ready? Don't change any files.",
            Some(&mut on_event),
            CodexRunOptions {
                disable_shell_tool: true,
                ..Default::default()
            },
        )
        .await
        .context("streamed turn through the proxy")?;

    assert!(
        state.opened_by_runtime.load(Ordering::SeqCst),
        "the runtime saw the first piece only after the provider finished"
    );
    assert_eq!(
        output.final_json["summary"],
        json!("The deployment is ready. Nothing else changed.")
    );
    assert_eq!(state.requests.load(Ordering::SeqCst), 1);

    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    drop(settings);
    Ok(())
}
