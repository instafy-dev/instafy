//! Each chat's page stays its own: two chats of one space, through the real proxy with an inert,
//! localhost provider. A chat builds a comparison of the Framework laptops; a new chat then asks
//! for "a simple comparison page of the Framework Laptop 13 and 16 from what you already know,
//! without browsing." In a local test (Nov 7) that second turn read the rule on whose page it may
//! change, listed the space's pages, took the first chat's comparison for the page to change and
//! wrote its own data over it; its "Fill in what's still missing." then filled that folder again.
//! Nothing had told it which chat made which folder.
//!
//! Each turn that may write files is now told the space's pages, each made in this chat or in
//! another, from the space's record of its pages: `instafy preview open` writes the chat each
//! page's card went to in `.instafy/pages/pages.json`, in the space's own folder (here the test
//! records each card as the CLI does: its own test covers the CLI). That record is kept with the
//! space's folder, not in the home folder: a stopped space's next machine starts with a new home
//! folder, so the turns here run with no CLI state in their home at all (the controller keeps
//! which chat made each page for a machine that starts without the folder's record, and these
//! jobs carry none of its pages). The stand-in model does what the instructions it gets say, and
//! what the model in that test did when they said nothing: it starts its own folder for a page
//! another chat made, and changes the folder its own chat made. The first chat's page is then
//! unchanged byte for byte, the new chat's fill-in fills its own folder, and a long chat whose page
//! has left the history it sends still sees the page as its own.
//!
//! Told so, a new chat's turn still deleted the first chat's data and typed it again with a stray
//! "+", and that page was broken until a later turn mended it in passing (a local test, Nov 9). So
//! a page made in another chat is read-only here, and the runtime holds it: in a space whose
//! repository is its `.instafy/.git`, as a hosted space's is, the second case's stand-in model
//! breaks the first chat's page whatever it is told, and what its steps changed there goes back as
//! the turn found it. What no step of the turn wrote there stays: a viewer's click the page's own
//! server writes meanwhile. A scheduled run has no chat to ask in, and changes the page it names.

use super::*;
use runtime_agent::jobs::JobExecution;
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
/// The new chat, pointing at the first chat's page.
const POINTED: &str = "Add the weight of each one to the laptop comparison.";
const POINTED_REPLY: &str = "I added each one's weight to the comparison.";
/// The new chat again, while the first chat adds its weights.
const AGAIN: &str = "Start the comparison again from what you already know.";
const AGAIN_REPLY: &str = "I started the comparison again.";
/// What the first chat adds to its own page, beside its data.
const THEIR_WEIGHTS: &str = "{\"Laptop 12\":\"1.3 kg\"}\n";
/// Where the first chat's page keeps what its viewers' clicks record, as saved, and a click its
/// page's server writes there while the new chat's turn runs.
const THEIR_RECORDS: &str = "data/records/read_offer.json";
const NO_RECORDS: &str = "[]\n";
const CLICKED: &str = "[{\"ref\":\"laptop:12\",\"price\":\"1049 EUR\"}]\n";
/// A scheduled run the first chat set up for its page: it runs in a conversation of its own.
const PRICES: &str = "Every morning, add today's prices to the laptop comparison.";
const PRICED: &str = "I added today's prices to the comparison.";
const PRICES_LINE: &str = "{\"Laptop 12\":\"1049 EUR\"}\n";
/// The runtime's line when a turn changed the first chat's page.
const NOT_CHANGED: &str =
    "I didn't change “Framework Laptop 12, 13 and 16”: it was made in another chat.";

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

const HELD_CHILD: &str = "INSTAFY_PAGES_HELD_FOR_THEIR_CHATS_TEST_CHILD";

#[test]
fn a_page_another_chat_made_stays_as_its_last_save_holds_it_via_proxy() -> Result<()> {
    if std::env::var(HELD_CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            HELD_CHILD,
            "pages_of_their_own_chats::a_page_another_chat_made_stays_as_its_last_save_holds_it_via_proxy",
            "pages-held-for-their-chats",
        );
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("pages-held-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_held_case())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("held pages fixture panicked"))?
}

const SCHEDULED_CHILD: &str = "INSTAFY_PAGES_SCHEDULED_RUN_TEST_CHILD";

#[test]
fn a_scheduled_run_changes_the_page_it_names_via_proxy() -> Result<()> {
    if std::env::var(SCHEDULED_CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            SCHEDULED_CHILD,
            "pages_of_their_own_chats::a_scheduled_run_changes_the_page_it_names_via_proxy",
            "pages-scheduled-run",
        );
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("pages-scheduled-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_scheduled_case())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("scheduled run fixture panicked"))?
}

struct Provider {
    requests: StdMutex<Vec<Value>>,
    /// The stand-in model breaks the first chat's page whatever it is told, as the model in the
    /// local test did, and makes its own page too.
    breaks_their_page: bool,
    /// Holds the first chat's request to add its weights until the test lets it go: that turn is
    /// under way when the new chat's message comes.
    weights_gate: tokio::sync::Notify,
    /// A viewer's click on the first chat's page, which its page's server writes when the new
    /// chat's turn begins: the file and what it records.
    click: StdMutex<Option<(PathBuf, String)>>,
}

impl Provider {
    fn new(breaks_their_page: bool) -> Arc<Self> {
        Arc::new(Self {
            requests: StdMutex::new(Vec::new()),
            breaks_their_page,
            weights_gate: tokio::sync::Notify::new(),
            click: StdMutex::new(None),
        })
    }
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

/// How many steps (commands and patches) the turn ran so far.
fn steps_run(request: &Value) -> usize {
    let input = request["input"].as_array().cloned().unwrap_or_default();
    let start = input
        .iter()
        .rposition(|item| item["role"] == "user")
        .unwrap_or(0);
    input[start..]
        .iter()
        .filter(|item| {
            matches!(
                item["type"].as_str(),
                Some("function_call_output" | "custom_tool_call_output")
            )
        })
        .count()
}

/// The stand-in model's patch, in the form the turn offers its patch tool.
fn patch(request: &Value, id: &str, patch: &str) -> Value {
    let offered_as_function = request["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|tool| tool["name"] == "apply_patch" && tool["type"] == "function");
    if offered_as_function {
        json!({
            "id":format!("tool_{id}"),"type":"function_call","name":"apply_patch",
            "call_id":format!("call_{id}"),"status":"completed",
            "arguments":json!({ "input": patch }).to_string()
        })
    } else {
        json!({
            "id":format!("tool_{id}"),"type":"custom_tool_call","name":"apply_patch",
            "call_id":format!("call_{id}"),"status":"completed","input":patch
        })
    }
}

/// The first chat's data deleted, then typed again from memory with a stray "+" on a line, as the
/// local test's was: two patches, and a page that no longer reads.
fn break_their_data(request: &Value) -> Vec<Value> {
    vec![
        patch(
            request,
            "delete",
            &format!("*** Begin Patch\n*** Delete File: {THEIRS}/data.json\n*** End Patch\n"),
        ),
        patch(
            request,
            "retype",
            &format!(
                "*** Begin Patch\n*** Add File: {THEIRS}/data.json\n+{{\"title\":\"{THEIR_TITLE}\",\"items\":[\n+  \"Laptop 13\"\n++  ],\n+}}\n*** End Patch\n"
            ),
        ),
    ]
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
    if state.breaks_their_page {
        return breaking_request(&state, &body).await;
    }
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
    let steps = vec![command("write", &write)];
    match steps.get(steps_run(&body)) {
        Some(step) => response(step.clone()),
        None => response(message(reply)),
    }
}

/// The stand-in model of the second case: it breaks the first chat's page whatever it is told.
async fn breaking_request(state: &Provider, body: &Value) -> axum::response::Response {
    let (steps, reply) = if asks(body, COMPARE) {
        (
            vec![command(
                "write",
                &format!(
                    "mkdir -p {THEIRS}/data/records && printf '%s\\n' '{}' > {THEIRS}/data.json && printf '%s\\n' '{}' > {THEIRS}/{THEIR_RECORDS}",
                    THEIR_DATA.trim_end(),
                    NO_RECORDS.trim_end()
                ),
            )],
            COMPARED,
        )
    } else if asks(body, PRICES) {
        (
            vec![command(
                "prices",
                &format!(
                    "printf '%s\\n' '{}' > {THEIRS}/prices.json",
                    PRICES_LINE.trim_end()
                ),
            )],
            PRICED,
        )
    } else if asks(body, FROM_MEMORY) {
        if steps_run(body) == 0
            && let Some((file, click)) = state.click.lock().unwrap().take()
        {
            fs::write(file, click).expect("the click is written");
        }
        let mut steps = break_their_data(body);
        steps.push(command(
            "own",
            &format!(
                "mkdir -p {OWN} && printf '%s\\n' '{}' > {OWN}/data.json",
                OWN_DATA.trim_end()
            ),
        ));
        (steps, REMEMBERED)
    } else if asks(body, POINTED) {
        (
            vec![command(
                "weigh",
                &format!(
                    "printf '{}' >> {THEIRS}/data.json",
                    WEIGHED_LINE.replace('\n', "\\n")
                ),
            )],
            POINTED_REPLY,
        )
    } else if asks(body, WEIGHTS) {
        if steps_run(body) == 0 {
            state.weights_gate.notified().await;
        }
        (
            vec![command(
                "weights",
                &format!(
                    "printf '%s\\n' '{}' > {THEIRS}/weights.json",
                    THEIR_WEIGHTS.trim_end()
                ),
            )],
            WEIGHED,
        )
    } else {
        // The new chat starts the comparison again over the first chat's page, its weights too.
        let mut steps = break_their_data(body);
        steps.push(patch(
            body,
            "reweigh",
            &format!(
                "*** Begin Patch\n*** Update File: {THEIRS}/weights.json\n@@\n-{}\n+{{}}\n*** End Patch\n",
                THEIR_WEIGHTS.trim_end()
            ),
        ));
        (steps, AGAIN_REPLY)
    };
    match steps.get(steps_run(body)) {
        Some(step) => response(step.clone()),
        None => response(message(reply)),
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
        engine: None,
    }
}

/// The card a page's turn posts with `instafy preview open`, written down in the space's record of
/// its pages as the CLI writes it: newest first, with the chat the card went to, which another
/// chat's open of the same folder keeps.
fn record_card(workspace: &Path, conversation_id: Uuid, folder: &str, title: &str) -> Result<()> {
    let file = workspace.join(".instafy/pages/pages.json");
    let mut pages = fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|record| record["pages"].as_array().cloned())
        .unwrap_or_default();
    let maker = pages
        .iter()
        .find(|page| page["folder"] == folder)
        .map(|page| page["conversationId"].clone())
        .unwrap_or_else(|| json!(conversation_id.to_string()));
    pages.retain(|page| page["folder"] != folder);
    pages.insert(
        0,
        json!({
            "folder": folder,
            "title": title,
            "conversationId": maker,
            "server": ["instafy", "bind"],
            "openedAt": "2026-11-08T00:00:00.000Z",
        }),
    );
    fs::create_dir_all(workspace.join(".instafy/pages"))?;
    fs::write(&file, json!({ "version": 1, "pages": pages }).to_string())?;
    Ok(())
}

/// The space a case's turns run in, with the stand-in model behind the real proxy.
struct Space {
    project_id: Uuid,
    workspace: PathBuf,
    state: Arc<Provider>,
    processor: JobProcessor,
    registration: Registration,
    settings: Vec<EnvGuard>,
    stub: (ChildGuard, tokio::task::JoinHandle<std::io::Result<()>>),
    proxy: (ChildGuard, tokio::task::JoinHandle<Result<()>>),
    _runtime_home: TempDir,
    _workspace_root: TempDir,
}

impl Space {
    async fn start(state: Arc<Provider>) -> Result<Self> {
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
        Ok(Self {
            project_id,
            workspace,
            state,
            processor,
            registration: registration_for_live(Uuid::new_v4()),
            settings,
            stub: (stub_guard, stub_task),
            proxy: (proxy_guard, proxy_task),
            _runtime_home: runtime_home,
            _workspace_root: workspace_root,
        })
    }

    async fn run(&self, job: LeaseJob) -> Result<JobExecution> {
        tokio::time::timeout(
            Duration::from_secs(60),
            self.processor
                .run_apply_job(&self.registration, &job, true, None, None, None),
        )
        .await
        .context("the turn timed out")?
    }

    async fn finish(self) -> Result<()> {
        drop(self.settings);
        let (proxy_guard, proxy_task) = self.proxy;
        let (stub_guard, stub_task) = self.stub;
        drop(proxy_guard);
        drop(stub_guard);
        proxy_task.await??;
        stub_task.await??;
        Ok(())
    }
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let home = PathBuf::from(std::env::var("HOME")?);
    let space = Space::start(Provider::new(false)).await?;
    let (project_id, workspace, state) = (space.project_id, space.workspace.clone(), &space.state);
    let run = |job: LeaseJob| space.run(job);
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
    record_card(&workspace, first_chat, THEIRS, THEIR_TITLE)?;

    // The space stopped and woke on a new machine: no CLI state in its home folder, only the
    // space's own record of its pages. A new chat asks for a comparison of two of the same laptops,
    // from what Octo knows.
    assert!(!home.join(".instafy/cli-preview-state.json").exists());
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
        prompt.contains("- A request for a new page starts a new folder, even on the same subject. A page made for the person in another chat (a map, a comparison, a page to share) is read-only here: the person changes it in that chat.\n- The space's pages:\n"),
        "{prompt}"
    );
    assert!(
        prompt.contains(&format!(
            "  - \"{THEIR_TITLE}\", in `{THEIRS}/`: made in another chat, read-only here.\n"
        )),
        "{prompt}"
    );
    // The first chat's page is as it was, byte for byte, and the new chat's page is in a folder of
    // its own.
    assert_eq!(read(THEIRS)?, THEIR_DATA.as_bytes());
    assert_eq!(read(OWN)?, OWN_DATA.as_bytes());
    record_card(&workspace, new_chat, OWN, OWN_TITLE)?;

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

    space.finish().await
}

/// A change the routing step sent straight to the building thread, which must change files, as the
/// local test's message was routed: in a space whose repository counts a turn's changes.
fn required_job(
    project_id: Uuid,
    conversation_id: Uuid,
    prompt: &str,
    history: Vec<Value>,
) -> LeaseJob {
    let mut job = job(project_id, conversation_id, prompt, history, None);
    job.payload["metadata"] = json!({
        "execution_mode": "apply",
        "agentRoutingPreflight": { "workspaceFileChangeRequirement": "required" },
        "runtimeExpectations": { "workspaceFileChanges": true },
    });
    job
}

/// `git` in the space's own repository, its `.instafy/.git`, as a hosted space keeps it.
fn space_git(workspace: &Path, args: &[&str]) -> Result<()> {
    let git_dir = workspace.join(".instafy/.git").display().to_string();
    let work_tree = workspace.display().to_string();
    let mut all = vec![
        "--git-dir",
        git_dir.as_str(),
        "--work-tree",
        work_tree.as_str(),
    ];
    all.extend_from_slice(args);
    git_in(workspace, &all)
}

/// A turn's save, as the space's origin commits a turn's files.
fn save(workspace: &Path) -> Result<()> {
    space_git(workspace, &["add", "--", "sites"])?;
    space_git(
        workspace,
        &[
            "-c",
            "user.name=Instafy Test",
            "-c",
            "user.email=test@instafy.invalid",
            "commit",
            "-q",
            "-m",
            "saved",
        ],
    )
}

/// The files a turn's reply lists, as Studio's file list, its card and Undo read them.
fn turn_files(execution: &JobExecution) -> Vec<String> {
    execution
        .artifacts
        .iter()
        .filter(|artifact| artifact["kind"] == "apply/files")
        .flat_map(|artifact| artifact["files"].as_array().cloned().unwrap_or_default())
        .filter_map(|file| file["workspacePath"].as_str().map(str::to_string))
        .collect()
}

/// What a turn's artifacts record of a write the runtime held back.
fn blocked(execution: &JobExecution) -> Option<Value> {
    execution
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "write-scope/read-only-blocked")
        .cloned()
}

async fn run_held_case() -> Result<()> {
    let _env = env_guard().await;
    let space = Space::start(Provider::new(true)).await?;
    let (project_id, workspace) = (space.project_id, space.workspace.clone());
    fs::create_dir_all(workspace.join(".instafy"))?;
    space_git(&workspace, &["init", "-q", "-b", "main"])?;
    let (first_chat, new_chat) = (Uuid::new_v4(), Uuid::new_v4());
    let read = |path: &str| fs::read(workspace.join(path));
    let their_data = format!("{THEIRS}/data.json");

    // The first chat's comparison, saved, and its card.
    let compared = space
        .run(required_job(
            project_id,
            first_chat,
            COMPARE,
            vec![person(COMPARE, "run-1")],
        ))
        .await
        .context("the comparison's turn failed")?;
    assert_eq!(compared.summary, COMPARED);
    assert_eq!(read(&their_data)?, THEIR_DATA.as_bytes());
    let their_records = format!("{THEIRS}/{THEIR_RECORDS}");
    assert_eq!(read(&their_records)?, NO_RECORDS.as_bytes());
    save(&workspace)?;
    record_card(&workspace, first_chat, THEIRS, THEIR_TITLE)?;

    // A new chat asks for its own comparison. Its turn is told the first chat's page is read-only
    // here, deletes that page's data and types it again broken anyway, then makes its own page.
    // As it begins, a viewer's click on the first chat's page is written there by that page's
    // server, which saves it itself a moment later: no step of the turn wrote it.
    *space.state.click.lock().unwrap() =
        Some((workspace.join(&their_records), CLICKED.to_string()));
    let remembered = space
        .run(required_job(
            project_id,
            new_chat,
            FROM_MEMORY,
            vec![person(FROM_MEMORY, "run-2")],
        ))
        .await
        .context("the new chat's turn failed")?;
    let requests = space.state.requests.lock().unwrap().clone();
    let prompt = requests
        .iter()
        .find(|request| asks(request, FROM_MEMORY))
        .map(last_user_text)
        .context("the new chat's request")?;
    assert!(
        prompt.contains(&format!(
            "is read-only here: the person changes it in that chat.\n- The space's pages:\n  - \"{THEIR_TITLE}\", in `{THEIRS}/`: made in another chat, read-only here.\n"
        )),
        "{prompt}"
    );
    // The first chat's data is as its last save holds it, byte for byte, and the click is kept;
    // the new chat's page is in a folder of its own; the reply says which page it didn't change.
    assert_eq!(read(&their_data)?, THEIR_DATA.as_bytes());
    assert_eq!(read(&their_records)?, CLICKED.as_bytes());
    assert_eq!(read(&format!("{OWN}/data.json"))?, OWN_DATA.as_bytes());
    assert_eq!(remembered.summary, format!("{REMEMBERED}\n\n{NOT_CHANGED}"));
    let held = blocked(&remembered).context("the held write")?;
    assert_eq!(held["metadata"]["changedPaths"], json!([their_data]));
    assert_eq!(held["metadata"]["restoredPaths"], json!([their_data]));
    assert_eq!(
        held["metadata"]["readOnlyPaths"],
        json!([format!("{THEIRS}/")])
    );
    // No file of the first chat's page in the new chat's reply, the click's neither, so no card
    // names it and no Undo takes it back there.
    let files = turn_files(&remembered);
    assert!(files.contains(&format!("{OWN}/data.json")), "{files:?}");
    assert!(
        !files
            .iter()
            .any(|file| file.starts_with(&format!("{THEIRS}/"))),
        "{files:?}"
    );
    save(&workspace)?;
    record_card(&workspace, new_chat, OWN, OWN_TITLE)?;

    // The new chat points at the first chat's page. The page stays as it was, the runtime's line is
    // the reply (the turn's words told of a change no one can see), and the turn is not run again
    // for the change it couldn't keep.
    let before = space.state.requests.lock().unwrap().len();
    let pointed = space
        .run(required_job(
            project_id,
            new_chat,
            POINTED,
            vec![
                person(FROM_MEMORY, "run-2"),
                reply(REMEMBERED, "run-2"),
                person(POINTED, "run-3"),
            ],
        ))
        .await
        .context("the pointed turn failed")?;
    assert_eq!(read(&their_data)?, THEIR_DATA.as_bytes());
    assert_eq!(pointed.summary, NOT_CHANGED);
    assert!(!pointed.summary.contains(POINTED_REPLY));
    assert!(blocked(&pointed).is_some());
    let files = turn_files(&pointed);
    assert!(
        !files
            .iter()
            .any(|file| file.starts_with(&format!("{THEIRS}/"))),
        "{files:?}"
    );
    let asked = space.state.requests.lock().unwrap()[before..]
        .iter()
        .filter(|request| asks(request, POINTED))
        .count();
    assert_eq!(asked, 2, "one step and the answer, with no second run");

    // The first chat adds its weights to its own page, and while that turn is under way, the new
    // chat's next message breaks the page's data again and writes over those weights. The runtime
    // runs them one after the other: the first chat's weights, not saved yet when the new chat's
    // turn begins, are back as that turn found them, and the data the new chat broke is as its
    // last save holds it.
    let weights = format!("{THEIRS}/weights.json");
    let first = space.run(required_job(
        project_id,
        first_chat,
        WEIGHTS,
        vec![
            person(COMPARE, "run-1"),
            reply(COMPARED, "run-1"),
            person(WEIGHTS, "run-4"),
        ],
    ));
    let second = async {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !space
            .state
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| asks(request, WEIGHTS))
        {
            anyhow::ensure!(
                Instant::now() < deadline,
                "the first chat's turn never asked"
            );
            sleep(Duration::from_millis(20)).await;
        }
        let (again, ()) = tokio::join!(
            space.run(required_job(
                project_id,
                new_chat,
                AGAIN,
                vec![person(AGAIN, "run-5")],
            )),
            async {
                sleep(Duration::from_millis(200)).await;
                space.state.weights_gate.notify_one();
            }
        );
        again
    };
    let (weighed, again) = tokio::join!(first, second);
    let (weighed, again) = (
        weighed.context("the first chat's turn failed")?,
        again.context("the new chat's turn failed")?,
    );
    assert_eq!(weighed.summary, WEIGHED);
    assert_eq!(read(&weights)?, THEIR_WEIGHTS.as_bytes());
    assert_eq!(read(&their_data)?, THEIR_DATA.as_bytes());
    assert_eq!(again.summary, NOT_CHANGED);
    let held = blocked(&again).context("the held write")?;
    assert_eq!(
        held["metadata"]["restoredPaths"],
        json!([their_data, weights])
    );
    let files = turn_files(&again);
    assert!(
        !files
            .iter()
            .any(|file| file.starts_with(&format!("{THEIRS}/"))),
        "{files:?}"
    );
    space.finish().await
}

/// A scheduled run the first chat set up for its page runs in a conversation of its own. It has no
/// chat to ask in, so it reads neither the rule nor the space's pages, and nothing holds the page
/// for it: its prices stay.
async fn run_scheduled_case() -> Result<()> {
    let _env = env_guard().await;
    let space = Space::start(Provider::new(true)).await?;
    let (project_id, workspace) = (space.project_id, space.workspace.clone());
    fs::create_dir_all(workspace.join(".instafy"))?;
    space_git(&workspace, &["init", "-q", "-b", "main"])?;
    let first_chat = Uuid::new_v4();
    let compared = space
        .run(required_job(
            project_id,
            first_chat,
            COMPARE,
            vec![person(COMPARE, "run-1")],
        ))
        .await
        .context("the comparison's turn failed")?;
    assert_eq!(compared.summary, COMPARED);
    save(&workspace)?;
    record_card(&workspace, first_chat, THEIRS, THEIR_TITLE)?;

    let mut scheduled = required_job(
        project_id,
        Uuid::new_v4(),
        PRICES,
        vec![person(PRICES, "run-2")],
    );
    scheduled.payload["metadata"]["automation"] =
        json!({ "id": "morning-prices", "name": "Morning prices" });
    let priced = space
        .run(scheduled)
        .await
        .context("the scheduled run failed")?;
    assert_eq!(priced.summary, PRICED);
    assert_eq!(
        fs::read(workspace.join(format!("{THEIRS}/prices.json")))?,
        PRICES_LINE.as_bytes()
    );
    assert!(blocked(&priced).is_none());
    let files = turn_files(&priced);
    assert!(
        files.contains(&format!("{THEIRS}/prices.json")),
        "{files:?}"
    );
    let prompt = space
        .state
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|request| asks(request, PRICES))
        .map(last_user_text)
        .context("the scheduled run's request")?;
    assert!(!prompt.contains("The space's pages"), "{prompt}");
    assert!(!prompt.contains("is read-only here"), "{prompt}");

    space.finish().await
}
