//! Each chat's page stays its own: two chats of one space, through the real proxy with an inert,
//! localhost provider. A chat builds a comparison of the Framework laptops; a new chat then asks
//! for "a simple comparison page of the Framework Laptop 13 and 16 from what you already know,
//! without browsing." In a local test (Nov 7) that second turn read the rule on whose page it may
//! change, listed the space's pages, took the first chat's comparison for the page to change and
//! wrote its own data over it; its "Fill in what's still missing." then filled that folder again.
//! Nothing had told it which chat made which folder.
//!
//! Each turn that may write files is now told the space's pages, each made in this chat or in
//! another, from the chat `instafy preview open` recorded with each page's card (here the test
//! records each card as the CLI does: its own test covers the CLI). The stand-in model does what
//! the instructions it gets say, and what the model in that test did when they said nothing: it
//! starts its own folder for a page another chat made, and changes the folder its own chat made.
//! The first chat's page is then unchanged byte for byte, the new chat's fill-in fills its own
//! folder, and a long chat whose page has left the history it sends still sees the page as its own.

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_PAGES_OF_THEIR_OWN_CHATS_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-pages-provider-key";
/// The first chat's request, and the page it makes.
const COMPARE: &str = "Compare the latest Framework laptops on a page.";
const COMPARED: &str = "I made a comparison of the Framework Laptop 12, 13 and 16.";
const THEIRS: &str = "sites/framework-laptops";
const THEIR_TITLE: &str = "Framework Laptop 12, 13 and 16";
const THEIR_DATA: &str = "{\"title\":\"Framework Laptop 12, 13 and 16\",\"items\":[\"Laptop 12\",\"Laptop 13\",\"Laptop 16\"]}\n";
/// The new chat's request, its own page, and its fill-in.
const FROM_MEMORY: &str = "Make a simple comparison page of the Framework Laptop 13 and 16 from what you already know, without browsing.";
const REMEMBERED: &str = "I made a comparison of the Framework Laptop 13 and 16 from what I know.";
const OWN: &str = "sites/framework-13-16";
const OWN_TITLE: &str = "Framework Laptop 13 vs 16";
const OWN_DATA: &str = "{\"title\":\"Framework Laptop 13 vs 16\",\"from\":\"memory\"}\n";
const FILL_IN: &str = "Fill in what's still missing.";
const FILLED: &str = "I filled in what was missing.";
const FILLED_LINE: &str = "filled: prices and weights\n";
/// The first chat, much later: its page has left the history it sends.
const WEIGHTS: &str = "Add the weight of each one.";
const WEIGHED: &str = "I added each one's weight.";
const WEIGHED_LINE: &str = "weights: added\n";
/// Where the stand-in model starts a page when it can't tell which folder is its own.
const NEW_FOLDER: &str = "sites/framework-laptops-2";

#[test]
fn a_new_chat_builds_its_own_page_and_leaves_another_chats_page_as_it_is_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "pages_of_their_own_chats::a_new_chat_builds_its_own_page_and_leaves_another_chats_page_as_it_is_via_proxy",
            "pages-of-their-own-chats",
        );
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("pages-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("pages fixture panicked"))?
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

fn message(text: &str) -> Value {
    json!({
        "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":text}]
    })
}

fn command(id: &str, cmd: &str) -> Value {
    json!({
        "id":format!("tool_{id}"),"type":"function_call","name":"exec_command",
        "call_id":format!("call_{id}"),"status":"completed",
        "arguments":json!({"cmd":cmd,"max_output_tokens":256}).to_string()
    })
}

/// The text of the last user message of a request: the turn's prompt.
fn last_user_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .and_then(|input| input.iter().rev().find(|item| item["role"] == "user"))
        .map(|item| {
            item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .collect()
        })
        .unwrap_or_default()
}

/// How many commands the turn ran so far.
fn commands_run(request: &Value) -> usize {
    let input = request["input"].as_array().cloned().unwrap_or_default();
    let start = input
        .iter()
        .rposition(|item| item["role"] == "user")
        .unwrap_or(0);
    input[start..]
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .count()
}

/// Which turn a request is, by what its prompt asks last.
fn asks(request: &Value, words: &str) -> bool {
    last_user_text(request).contains(&format!("\n\nLatest user request:\n{words}"))
}

/// What a turn's instructions say about the page in `folder`: made in this chat (true), in another
/// (false), or nothing.
fn made_here(prompt: &str, folder: &str) -> Option<bool> {
    let line = prompt
        .lines()
        .find(|line| line.contains(&format!("in `{folder}/`:")))?;
    Some(line.ends_with(": made in this chat."))
}

/// The folder a turn's instructions say this chat made, if any.
fn own_folder(prompt: &str) -> Option<String> {
    prompt
        .lines()
        .filter(|line| line.ends_with(": made in this chat."))
        .find_map(|line| {
            let (_, rest) = line.split_once("in `")?;
            let (folder, _) = rest.split_once("/`")?;
            Some(folder.to_string())
        })
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    state.requests.lock().unwrap().push(body.clone());
    let prompt = last_user_text(&body);
    let (write, reply) = if asks(&body, COMPARE) {
        (
            format!(
                "mkdir -p {THEIRS} && printf '%s\\n' '{}' > {THEIRS}/data.json",
                THEIR_DATA.trim_end()
            ),
            COMPARED,
        )
    } else if asks(&body, FROM_MEMORY) {
        // A new page: its own folder when the comparison there is another chat's. Told nothing, the
        // model in the local test took that folder for the page to change.
        let folder = if made_here(&prompt, THEIRS) == Some(false) {
            OWN
        } else {
            THEIRS
        };
        (
            format!(
                "mkdir -p {folder} && printf '%s\\n' '{}' > {folder}/data.json",
                OWN_DATA.trim_end()
            ),
            REMEMBERED,
        )
    } else if asks(&body, FILL_IN) {
        // The page this chat made; told nothing, the one comparison it had written.
        let folder = own_folder(&prompt).unwrap_or_else(|| THEIRS.to_string());
        (
            format!(
                "printf '{}' >> {folder}/data.json",
                FILLED_LINE.replace('\n', "\\n")
            ),
            FILLED,
        )
    } else {
        // The page this chat made; told nothing, and with the page gone from its history, it can't
        // tell which folder is its own: a new one.
        let folder = own_folder(&prompt).unwrap_or_else(|| NEW_FOLDER.to_string());
        (
            format!(
                "mkdir -p {folder} && printf '{}' >> {folder}/data.json",
                WEIGHED_LINE.replace('\n', "\\n")
            ),
            WEIGHED,
        )
    };
    match commands_run(&body) {
        0 => response(command("write", &write)),
        _ => response(message(reply)),
    }
}

fn person(words: &str, run: &str) -> Value {
    json!({"role": "user", "content": words, "runId": run})
}

fn reply(words: &str, run: &str) -> Value {
    json!({"role": "assistant", "content": words, "runId": run, "metadata": {"jobId": format!("job-{run}")}})
}

/// A change the routing step sent straight to the building thread. This test's folder is no
/// repository, where a turn can't count its changes, so none is required.
fn direct() -> Value {
    json!({"execution_mode":"apply","agentRoutingPreflight":{"workspaceFileChangeRequirement":"conditional"}})
}

fn job(
    project_id: Uuid,
    conversation_id: Uuid,
    prompt: &str,
    history: Vec<Value>,
    thread: Option<Value>,
) -> LeaseJob {
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(conversation_id),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": prompt,
            "provider_conversation_state": thread,
            "metadata": direct(),
            "conversation_history": history,
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

/// The card a page's turn posts with `instafy preview open`, recorded in the CLI's state file as the
/// CLI records it: newest first, with the chat the card went to.
fn record_card(
    home: &Path,
    project_id: Uuid,
    conversation_id: Uuid,
    folder: &str,
    title: &str,
) -> Result<()> {
    let file = home.join(".instafy/cli-preview-state.json");
    let mut previews = fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|state| state["previews"].as_array().cloned())
        .unwrap_or_default();
    previews.insert(
        0,
        json!({
            "previewId": format!("preview-{}", previews.len() + 1),
            "projectId": project_id.to_string(),
            "title": title,
            "localPort": 20_000 + previews.len(),
            "path": "/",
            "controllerUrl": "http://127.0.0.1:9",
            "pid": -1,
            "siteDir": folder,
            "conversationId": conversation_id.to_string(),
        }),
    );
    fs::create_dir_all(home.join(".instafy"))?;
    fs::write(
        &file,
        json!({ "version": 1, "previews": previews }).to_string(),
    )?;
    Ok(())
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let home = PathBuf::from(std::env::var("HOME")?);
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-pages-runtime-key"}).to_string(),
    )?;
    let mut settings = vec![EnvGuard::remove("CODEX_BASE_INSTRUCTIONS")];
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-pages-runtime-key"),
        ("CODEX_API_KEY", "inert-pages-runtime-key"),
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
    let registration = registration_for_live(Uuid::new_v4());
    let run = |job: LeaseJob| {
        let processor = &processor;
        let registration = &registration;
        async move {
            tokio::time::timeout(
                Duration::from_secs(60),
                processor.run_apply_job(registration, &job, true, None, None, None),
            )
            .await
            .context("the turn timed out")?
        }
    };
    let (first_chat, new_chat) = (Uuid::new_v4(), Uuid::new_v4());
    let read = |folder: &str| fs::read(workspace.join(folder).join("data.json"));

    // The first chat's comparison, and its card.
    let compared = run(job(
        project_id,
        first_chat,
        COMPARE,
        vec![person(COMPARE, "run-1")],
        None,
    ))
    .await
    .context("the comparison's turn failed")?;
    assert_eq!(compared.summary, COMPARED);
    assert_eq!(read(THEIRS)?, THEIR_DATA.as_bytes());
    record_card(&home, project_id, first_chat, THEIRS, THEIR_TITLE)?;

    // A new chat asks for a comparison of two of the same laptops, from what Octo knows.
    let new_chat_history = vec![person(FROM_MEMORY, "run-2")];
    let remembered = run(job(
        project_id,
        new_chat,
        FROM_MEMORY,
        new_chat_history.clone(),
        None,
    ))
    .await
    .context("the new chat's turn failed")?;
    assert_eq!(remembered.summary, REMEMBERED);
    let requests = state.requests.lock().unwrap().clone();
    let asked = requests
        .iter()
        .find(|request| asks(request, FROM_MEMORY))
        .context("the new chat's request")?;
    let prompt = last_user_text(asked);
    assert!(
        prompt.contains("- A request for a new page starts a new folder, even on the same subject. A page another chat made changes only when the person points at that page (\"the laptop comparison\", \"that page\").\n- The space's pages:\n"),
        "{prompt}"
    );
    assert!(
        prompt.contains(&format!(
            "  - \"{THEIR_TITLE}\", in `{THEIRS}/`: made in another chat.\n"
        )),
        "{prompt}"
    );
    // The first chat's page is as it was, byte for byte, and the new chat's page is in a folder of
    // its own.
    assert_eq!(read(THEIRS)?, THEIR_DATA.as_bytes());
    assert_eq!(read(OWN)?, OWN_DATA.as_bytes());
    record_card(&home, project_id, new_chat, OWN, OWN_TITLE)?;

    // The new chat's fill-in, on its thread: its own page.
    let thread = remembered
        .provider_conversation_state
        .context("the new chat's building thread")?;
    let mut history = new_chat_history;
    history.push(reply(REMEMBERED, "run-2"));
    history.push(person(FILL_IN, "run-3"));
    let filled = run(job(project_id, new_chat, FILL_IN, history, Some(thread)))
        .await
        .context("the fill-in's turn failed")?;
    assert_eq!(filled.summary, FILLED);
    let requests = state.requests.lock().unwrap().clone();
    let asked = requests
        .iter()
        .find(|request| asks(request, FILL_IN))
        .context("the fill-in's request")?;
    let prompt = last_user_text(asked);
    assert_eq!(made_here(&prompt, OWN), Some(true), "{prompt}");
    assert_eq!(made_here(&prompt, THEIRS), Some(false), "{prompt}");
    assert_eq!(read(THEIRS)?, THEIR_DATA.as_bytes());
    assert_eq!(read(OWN)?, format!("{OWN_DATA}{FILLED_LINE}").as_bytes());

    // Much later in the first chat: the history it sends holds only its latest messages, none about
    // its page. The page is still its own.
    let mut long_chat: Vec<Value> = (0..40)
        .flat_map(|n| {
            let run = format!("run-a{n}");
            [
                person(&format!("Question {n} about something else."), &run),
                reply(&format!("Answer {n}."), &run),
            ]
        })
        .collect();
    long_chat.push(person(WEIGHTS, "run-a40"));
    let weighed = run(job(project_id, first_chat, WEIGHTS, long_chat, None))
        .await
        .context("the long chat's turn failed")?;
    assert_eq!(weighed.summary, WEIGHED);
    let requests = state.requests.lock().unwrap().clone();
    let asked = requests
        .iter()
        .find(|request| asks(request, WEIGHTS))
        .context("the long chat's request")?;
    let prompt = last_user_text(asked);
    assert!(
        !prompt.contains(COMPARE),
        "the page has left its history: {prompt}"
    );
    assert_eq!(made_here(&prompt, THEIRS), Some(true), "{prompt}");
    assert_eq!(made_here(&prompt, OWN), Some(false), "{prompt}");
    assert_eq!(
        read(THEIRS)?,
        format!("{THEIR_DATA}{WEIGHED_LINE}").as_bytes()
    );
    assert_eq!(read(OWN)?, format!("{OWN_DATA}{FILLED_LINE}").as_bytes());
    assert!(!workspace.join(NEW_FOLDER).exists());

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
