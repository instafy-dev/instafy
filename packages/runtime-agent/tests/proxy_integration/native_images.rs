//! A chat image attached to the turn's message reaches the provider as image
//! input, through the real proxy with an inert, localhost provider. The next
//! turn resumes the thread, which already holds the image, and neither sends
//! it again nor tells the agent to open it again.

use super::*;
use axum::extract::Path as AxumPath;
use axum::routing::get;
use base64::Engine as _;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_NATIVE_IMAGES_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-native-images-provider-key";
/// A 1x1 PNG.
const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const NAME: &str = "6a000000-0000-4000-8000-000000000001.png";
const FIRST_PROMPT: &str = "Describe the attached image in one sentence. Don't change any files.";
const SECOND_PROMPT: &str = "Which color was the image? Don't change any files.";

#[test]
fn an_attached_image_reaches_the_provider_as_image_input_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "native_images::an_attached_image_reaches_the_provider_as_image_input_via_proxy",
            "native-images",
        );
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("native-images-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_turns())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("native-images fixture panicked"))?
}

struct Provider {
    requests: StdMutex<Vec<Value>>,
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
    state.requests.lock().unwrap().push(body);
    let answer = json!({
        "summary": "The image is a single pixel.", "code": "", "files": [], "actions": []
    });
    Json(json!({
        "id": format!("resp_{}", Uuid::new_v4()), "object": "response",
        "status": "completed", "model": "gpt-5.5",
        "output": [{
            "id": format!("msg_{}", Uuid::new_v4()), "type": "message", "role": "assistant",
            "status": "completed", "phase": "final_answer",
            "content": [{ "type": "output_text", "text": answer.to_string() }]
        }],
        "usage": { "input_tokens": 70, "output_tokens": 10, "total_tokens": 80 }
    }))
    .into_response()
}

async fn attachment_object(AxumPath(object): AxumPath<String>) -> axum::response::Response {
    assert_eq!(object, "shot");
    base64::engine::general_purpose::STANDARD
        .decode(PNG_BASE64)
        .expect("fixture PNG")
        .into_response()
}

async fn run_turns() -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    fs::create_dir_all(workspace_root.path().join(project_id.to_string()))?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-native-images-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-native-images-runtime-key"),
        ("CODEX_API_KEY", "inert-native-images-runtime-key"),
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
        requests: StdMutex::new(Vec::new()),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream = listener.local_addr()?;
    let app = Router::new()
        .route("/backend-api/codex/responses", post(provider_request))
        .route("/object/:object", get(attachment_object))
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
    let attachment = json!({
        "kind": "image",
        "storagePath": format!("{project_id}/{conversation_id}/{NAME}"),
        "fileName": "gateway-check-b.png",
        "mimeType": "image/png"
    });
    let downloads = json!([{
        "name": NAME,
        "url": format!("http://{upstream}/object/shot?token=inert"),
    }]);

    let first = JobProcessor::new(config.clone())
        .run_apply_job(
            &registration,
            &job(
                project_id,
                conversation_id,
                json!({
                    "prompt_text": FIRST_PROMPT,
                    "attachment_downloads": downloads,
                    "metadata": metadata(json!([attachment])),
                }),
            ),
            true,
            None,
            None,
            None,
        )
        .await
        .context("attached-image job")?;
    let saved = first
        .provider_conversation_state
        .context("persisted provider state")?;

    // The follow-up offers the earlier message's image from the history; the
    // resumed thread already holds it.
    let second = JobProcessor::new(config)
        .run_apply_job(
            &registration,
            &job(
                project_id,
                conversation_id,
                json!({
                    "prompt_text": SECOND_PROMPT,
                    "provider_conversation_state": saved.clone(),
                    "attachment_downloads": downloads,
                    "conversation_history": [
                        { "role": "user", "content": FIRST_PROMPT,
                          "metadata": { "attachments": [attachment] } },
                        { "role": "assistant", "content": "The image is a single pixel." }
                    ],
                    "metadata": metadata(json!([])),
                }),
            ),
            true,
            None,
            None,
            None,
        )
        .await
        .context("follow-up job")?;
    let resumed = second
        .provider_conversation_state
        .context("resumed provider state")?;
    assert_eq!(resumed["defaultThreadId"], saved["defaultThreadId"]);

    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2, "one sampling request per turn");

    // The image follows the prompt in the same user message, labelled
    // `[Image #1]`, as a data URL rather than a path.
    let (message, images) = image_message(&requests[0]).context("a user message with an image")?;
    assert_eq!(images.len(), 1);
    let parts = message["content"].as_array().unwrap();
    assert_eq!(parts[0]["type"], "input_text");
    let text = parts[0]["text"].as_str().unwrap_or_default();
    assert!(text.contains(FIRST_PROMPT), "the prompt comes first");
    assert!(
        text.contains(&format!(
            "- [Image #1] workspacePath: .instafy/attachments/{conversation_id}/{NAME}"
        )),
        "the prompt lists the image as [Image #1]"
    );
    assert!(!text.contains("filename/path context"));
    assert!(parts.iter().any(|part| {
        part["text"]
            .as_str()
            .is_some_and(|text| text.starts_with("<image name=[Image #1]"))
    }));
    let image_url = images[0]["image_url"].as_str().unwrap_or_default();
    assert!(
        image_url.starts_with("data:image/png;base64,"),
        "the image is sent inline, not as a path or URL"
    );
    assert!(!image_url.contains("token=inert"));

    // The resumed thread holds the first message's image once; the follow-up
    // adds none, and its prompt does not send the agent to open it again.
    let follow_up = user_text(&requests[1], SECOND_PROMPT).context("the follow-up prompt")?;
    assert!(
        follow_up.contains(
            "If you already saw one in this conversation, do not open it again; call the `view_image` tool only on one you have not seen"
        ),
        "the follow-up offers the earlier image only if it was not seen"
    );
    assert!(
        !follow_up.contains("Before answering, call the `view_image` tool"),
        "the follow-up does not require opening the earlier image again"
    );
    let resent = input_images(&requests[1]);
    assert_eq!(resent.len(), 1);
    // `assert!` rather than `assert_eq!`: a failure must not print image bytes.
    assert!(
        resent[0]["image_url"] == images[0]["image_url"],
        "the resumed thread holds the same image"
    );

    // Each turn's prompt context records what it sent.
    assert_eq!(native_image_inputs(&first.artifacts), Some(1));
    assert_eq!(native_image_inputs(&second.artifacts), None);

    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}

fn metadata(attachments: Value) -> Value {
    json!({
        "execution_mode": "apply",
        "agentRoutingPreflight": {},
        "attachments": attachments,
        "runtimeExpectations": {
            "workspaceFileChanges": false,
            "commandExecution": false,
            "genericMcpToolExecution": false
        }
    })
}

fn job(project_id: Uuid, conversation_id: Uuid, payload: Value) -> LeaseJob {
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(conversation_id),
        session_id: None,
        credential_id: None,
        payload,
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

/// `nativeImageInputs` of the run's first `codex/prompt-context` artifact.
fn native_image_inputs(artifacts: &[Value]) -> Option<u64> {
    artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "codex/prompt-context")
        .expect("a prompt-context artifact")
        .pointer("/metadata/nativeImageInputs")
        .and_then(Value::as_u64)
}

fn input_images(request: &Value) -> Vec<Value> {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "input_image")
        .cloned()
        .collect()
}

/// The text of the request's user message that contains `prompt`.
fn user_text(request: &Value, prompt: &str) -> Option<String> {
    request["input"].as_array()?.iter().rev().find_map(|item| {
        let text = item["content"]
            .as_array()?
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<String>();
        (item["role"] == "user" && text.contains(prompt)).then_some(text)
    })
}

/// The user message that carries an image, and its images.
fn image_message(request: &Value) -> Option<(Value, Vec<Value>)> {
    request["input"].as_array()?.iter().find_map(|item| {
        let images = input_images(&json!({ "input": [item] }));
        (item["role"] == "user" && !images.is_empty()).then(|| (item.clone(), images))
    })
}
