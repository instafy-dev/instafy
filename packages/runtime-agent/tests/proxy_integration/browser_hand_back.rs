//! A browser hand-back through the real proxy with an inert, localhost provider. A building
//! turn posts a card that continues building, Instafy's browser reads the pages, and the
//! hand-back turn the controller stamped with what they showed resumes the chat's thread. It
//! takes no routing step: its route is decided (build in this chat), and the findings it builds
//! from are in its own prompt, which a routing step never sees. A routing step once sent such a
//! turn to a lookup of earlier chats ("the supplied conversation only summarizes those
//! findings"), and it wrote a page by hand that nobody could open. This pins what the runtime
//! decides: no routing request, the lane a routed build runs in (it edits the workspace, ends in
//! plain words and offers no team plan, goal or card), the findings and the browser turn's own
//! words in its prompt, the shell, and the chat's thread.
//!
//! Research that ends in a page goes to the browser first, so a hand-back is often its chat's
//! first building turn, on a new thread. Its own words are always the controller's one line, and
//! its skills were picked from them: the browser skill and no page builder. It wrote the page by
//! hand, posted no card and replied with the page's path. Its skills come from the person's
//! request it carries on, so the page skill and its card step reach it. The provider stands in
//! for the model: it takes the page skill's card step (the compare starter, then a preview from
//! the site's folder) when its thread has read that skill, and otherwise writes the page by hand
//! and names its file, as the model did.

use super::*;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_BROWSER_HAND_BACK_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-hand-back-provider-key";
const REQUEST: &str =
    "Compare the three latest laptops from maker.example on a page, with two reviews for each.";
/// What the model writes beside the card, which nobody reads: the turn posts the card alone.
const CARD_REPLY: &str =
    "Instafy's browser will read the maker's pages, then I'll build the comparison page.";
const CARD_TASK: &str =
    "Read the three latest laptops' pages on maker.example: processor, battery, weight and price.";
/// What Studio sends for a hand-back, whatever words it was sent with.
const HAND_BACK_PROMPT: &str = "Continue building with what the browser turn found.";
const ROUTING_OPENING: &str = "Instafy routing preflight.";
const STARTER: &str = "instafy bind init sites/laptops --starter compare --json";
const PREVIEW: &str = "cd sites/laptops && instafy preview open --title 'Three laptops' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json";
const BUILT: &str =
    "Built the comparison page from the maker's pages and opened it. Reviews: not checked.";
/// The browser turn's own words, which the person did not read: it posted none.
const BROWSER_WORDS: &str = "I read the maker's pages for three laptops. Their reviews are not checked: the Laptop 13 page links to two, which I did not open.";
/// What a person asked in a message the routing step sent straight to the browser.
const PERSON_REQUEST: &str = "Compare the three latest laptops from maker.example: processor, battery, weight and price, with two independent reviews each, as a comparison page.";
/// The page skill, which the hand-back reads in its snapshot when its request asks for a page.
const PAGE_SKILL: &str =
    include_str!("../../assets/instafy/.agents/skills/instafy-interactive-artifacts/SKILL.md");
/// What a model without the page skill did: a page written by hand, which nothing opens.
const BY_HAND: &str = "mkdir -p sites/laptops && printf '<!doctype html><title>Three laptops</title>\\n' > sites/laptops/index.html";
const BUILT_BY_HAND: &str =
    "Built a responsive comparison page at `sites/laptops/index.html` with the maker's figures.";
/// How a hand-back cites what the browser found (runtime-agent `jobs/browser_hand_back.rs`).
const CITE_LINE: &str = "\n- Cite a page only for a fact listed under it. A place or claim the reply names with no page under it is not checked: read its own page (`instafy web read`, or the reader your skill names) or leave it out. ";
/// What the lane of a routed build says (runtime-agent `jobs/mod.rs`).
const WRITE_LANE: &str = "\nDirect workspace-change response contract:\n";
const NO_ACTIONS: &str = "- Do not emit `multi_agent_plan`, goals, integrations, browser/location actions, or broad coordination metadata.";
/// The `instafy` the turn's commands find first: the starter writes its page, and the preview
/// answers as a live one does. Nothing else is expected of it.
const FAKE_CLI: &str = r#"#!/bin/sh
case "$1 $2" in
  "bind init")
    mkdir -p "$3" && printf '<!doctype html><title>Three laptops</title>\n' > "$3/index.html" \
      && printf '{"ok":true,"starter":"compare"}\n' ;;
  "preview open")
    printf '{"ok":true,"status":"live","previewId":"preview-1"}\n' ;;
  *)
    printf 'unexpected instafy command: %s\n' "$*" >&2
    exit 2 ;;
esac
"#;

#[test]
fn a_hand_back_takes_no_routing_step_and_builds_in_the_write_lane_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::a_hand_back_takes_no_routing_step_and_builds_in_the_write_lane_via_proxy",
            "browser-hand-back",
        );
    }
    run_on_a_large_stack(Case::OnTheCardsThread)
}

#[test]
fn a_hand_back_that_starts_the_chats_building_thread_builds_the_page_asked_for_via_proxy()
-> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::a_hand_back_that_starts_the_chats_building_thread_builds_the_page_asked_for_via_proxy",
            "browser-hand-back-first-building-turn",
        );
    }
    run_on_a_large_stack(Case::FirstBuildingTurn)
}

/// Which hand-back a fixture runs.
#[derive(Clone, Copy)]
enum Case {
    /// A building turn posts a card that continues building, and the hand-back resumes its
    /// thread.
    OnTheCardsThread,
    /// The routing step sent the person's message straight to the browser, so the hand-back
    /// is the chat's first building turn.
    FirstBuildingTurn,
}

fn run_on_a_large_stack(case: Case) -> Result<()> {
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("browser-hand-back-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("browser hand-back fixture panicked"))?
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

fn final_answer(summary: &str, actions: Value) -> Value {
    message(
        &json!({
            "summary":summary,"code":"","actions":actions,"files":[]
        })
        .to_string(),
    )
}

fn command(id: &str, cmd: &str) -> Value {
    json!({
        "id":format!("tool_{id}"),"type":"function_call","name":"exec_command",
        "call_id":format!("call_{id}"),"status":"completed",
        "arguments":json!({"cmd":cmd,"max_output_tokens":256}).to_string()
    })
}

fn last_user_index(request: &Value) -> Option<usize> {
    request["input"]
        .as_array()?
        .iter()
        .rposition(|item| item["role"] == "user")
}

/// The text of the last user message of a request: the turn's prompt.
fn last_user_text(request: &Value) -> String {
    let Some(index) = last_user_index(request) else {
        return String::new();
    };
    request["input"][index]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect()
}

/// The outputs of the commands the turn ran so far, in order.
fn command_outputs(request: &Value) -> Vec<String> {
    let start = last_user_index(request).unwrap_or(0);
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .skip(start)
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| item["output"].to_string())
        .collect()
}

/// Every text a request sends: its thread's earlier turns, then this one.
fn input_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A `## ` section of a skill, its heading included, up to the next one.
fn skill_section<'a>(skill: &'a str, heading: &str) -> &'a str {
    let start = skill
        .find(&format!("\n{heading}\n"))
        .unwrap_or_else(|| panic!("{heading} in the page skill"))
        + 1;
    let end = skill[start + heading.len()..]
        .find("\n## ")
        .map_or(skill.len(), |at| start + heading.len() + at);
    skill[start..end].trim_end()
}

/// The page skill's card step: serve the site from its own folder and post its card.
fn card_step() -> &'static str {
    skill_section(PAGE_SKILL, "## 3. Serve it and show it")
}

fn tool_names(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["name"].as_str().map(str::to_string))
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
    state.requests.lock().unwrap().push(body.clone());
    let turn = last_user_text(&body);
    if turn.contains(ROUTING_OPENING) {
        // What a routing step chose for a hand-back: a lookup of earlier chats.
        return response(message(
            &json!({
                "summary":"Recover the browser findings from earlier chats.",
                "route":"cross_chat_lookup",
                "reason":"The supplied conversation only summarizes those findings and omits the details.",
                "selectedSkills":["instafy-agent-collaboration"],
                "confidence":80,
                "requiresContextLookup":true,
                "requiresCommandExecution":false,
                "workspaceFileChangeRequirement":"none",
                "observationCommands":[],
                "workerQuestionReply":null
            })
            .to_string(),
        ));
    }
    if !turn.contains(HAND_BACK_PROMPT) {
        // The building turn that posts the card.
        return response(final_answer(
            CARD_REPLY,
            json!([{"type":"request_browser","task":CARD_TASK,"continueBuilding":true}]),
        ));
    }
    // The hand-back takes the page skill's card step when its thread has read the skill, and
    // otherwise writes the page by hand and names its file.
    let read_the_page_skill = input_text(&body).contains(card_step());
    match (read_the_page_skill, command_outputs(&body).len()) {
        (true, 0) => response(command("starter", STARTER)),
        (true, 1) => response(command("preview", PREVIEW)),
        // The lane ends in plain words.
        (true, 2) => response(message(BUILT)),
        (false, 0) => response(command("by-hand", BY_HAND)),
        (false, 1) => response(message(BUILT_BY_HAND)),
        (_, steps) => panic!("unexpected request after {steps} steps of the hand-back"),
    }
}

/// The record the controller stamps on a hand-back it checked (runtime-controller
/// `browser_hand_back::hand_back_record`), with what three maker pages showed.
fn hand_back_record() -> Value {
    let findings = [
        (
            "https://maker.example/laptop-13",
            "Laptop 13",
            "[\"Processor: Core Ultra 3\", \"Battery: 74 Wh\", \"Weight: 1.4 kg\", \"Price: from 1,349 euros\"]",
        ),
        (
            "https://maker.example/laptop-12",
            "Laptop 12",
            "[\"Battery: 50 Wh\", \"Weight: 1.3 kg\", \"Price: from 619 euros\"]",
        ),
        (
            "https://maker.example/laptop-16",
            "Laptop 16",
            "[\"Battery: 85 Wh\", \"Weight: 2.1 kg\"]",
        ),
    ];
    let lines = findings
        .iter()
        .map(|(url, title, facts)| {
            format!(r#"{{"url": "{url}", "title": "{title}", "facts": {facts}}}"#)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let read_at = "2026-10-30T21:13:00Z";
    let viewer = "Instafy's browser in the workspace";
    json!({
        "version": 1,
        "verified": true,
        "browserJobId": Uuid::new_v4(),
        "cardJobId": Uuid::new_v4(),
        "viewer": viewer,
        "readAt": read_at,
        "findings": findings
            .iter()
            .map(|(url, title, _)| json!({"url": url, "title": title, "readAt": read_at, "viewer": viewer}))
            .collect::<Vec<_>>(),
        // The browser turn posted no words of its own: they come from its Details note, ahead of
        // the finding lines (runtime-agent `move_findings_into_details`), and the note is the
        // whole reply (runtime-controller `browser_turn_reply`).
        "reply": format!("{BROWSER_WORDS}\n\n{lines}"),
        "replyTruncated": false,
    })
}

fn job(project_id: Uuid, conversation_id: Uuid, prompt: &str, metadata: Value) -> LeaseJob {
    job_on_thread(project_id, conversation_id, prompt, metadata, None)
}

fn job_on_thread(
    project_id: Uuid,
    conversation_id: Uuid,
    prompt: &str,
    metadata: Value,
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
            "prompt_text":prompt,
            "provider_conversation_state":thread,
            "metadata":metadata,
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

async fn run_case(case: Case) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let tools = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let cli = tools.path().join("instafy");
    fs::write(&cli, FAKE_CLI)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755))?;
    }
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-hand-back-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-hand-back-runtime-key"),
        ("CODEX_API_KEY", "inert-hand-back-runtime-key"),
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
    let path = std::env::var("PATH").unwrap_or_default();
    settings.push(EnvGuard::set(
        "PATH",
        format!("{}:{path}", tools.path().display()),
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
    let space = Space {
        processor: &processor,
        registration: registration_for_live(Uuid::new_v4()),
        provider: &state,
        workspace: &workspace,
        project_id,
    };
    match case {
        Case::OnTheCardsThread => on_the_cards_thread(&space).await?,
        Case::FirstBuildingTurn => as_the_chats_first_building_turn(&space).await?,
    }

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}

/// What a case's turns run in.
struct Space<'a> {
    processor: &'a JobProcessor,
    registration: Registration,
    provider: &'a Provider,
    workspace: &'a Path,
    project_id: Uuid,
}

impl Space<'_> {
    async fn run(&self, what: &str, job: LeaseJob) -> Result<runtime_agent::jobs::JobExecution> {
        tokio::time::timeout(
            Duration::from_secs(60),
            self.processor
                .run_apply_job(&self.registration, &job, true, None, None, None),
        )
        .await
        .with_context(|| format!("{what} timed out"))?
        .with_context(|| format!("{what} failed"))
    }

    /// The requests of the hand-back turn: every one carries its prompt last.
    fn hand_back_requests(&self) -> Vec<Value> {
        self.provider
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| last_user_text(request).contains(HAND_BACK_PROMPT))
            .cloned()
            .collect()
    }
}

async fn on_the_cards_thread(space: &Space<'_>) -> Result<()> {
    let project_id = space.project_id;
    let conversation_id = Uuid::new_v4();

    // The building turn: it posts the card that continues building.
    let card = space
        .run(
            "the card's turn",
            job(
                project_id,
                conversation_id,
                REQUEST,
                json!({"execution_mode":"apply","agentRoutingPreflight":{}}),
            ),
        )
        .await?;
    // It posts the card and no reply of its own: the card says where the browser goes, and
    // the browser turn says what it found.
    assert_eq!(card.summary, "");
    assert_eq!(card.final_messages.len(), 1, "{:?}", card.final_messages);
    assert_eq!(
        card.final_messages[0].message_type.as_deref(),
        Some("action_request")
    );
    let posted = card.final_messages[0]
        .metadata
        .as_ref()
        .context("the card's details")?;
    assert_eq!(posted["details"]["browserRequest"]["task"], CARD_TASK);
    assert_eq!(
        posted["details"]["browserRequest"]["continueBuilding"],
        true
    );
    let thread = card
        .provider_conversation_state
        .context("the chat's thread")?;

    // The hand-back, as dispatch stamps it: Studio's words and the checked record, on the chat's
    // own thread.
    let built = space
        .run(
            "the hand-back",
            job_on_thread(
                project_id,
                conversation_id,
                HAND_BACK_PROMPT,
                json!({"execution_mode":"apply","browserHandBack":hand_back_record()}),
                Some(thread.clone()),
            ),
        )
        .await?;

    let requests = space.provider.requests.lock().unwrap().clone();
    let routing = requests
        .iter()
        .filter(|request| last_user_text(request).contains(ROUTING_OPENING))
        .count();
    assert_eq!(routing, 0, "a hand-back takes no routing step");
    let hand_back: Vec<&Value> = requests
        .iter()
        .filter(|request| last_user_text(request).contains(HAND_BACK_PROMPT))
        .collect();
    assert_eq!(
        hand_back.len(),
        3,
        "the starter, the preview, and the reply"
    );

    // It builds on the chat's own thread with what the pages showed and what the browser turn
    // did not read, in the lane of a routed build, which has the shell and offers no team plan,
    // goal or card, never a lookup of earlier chats.
    let prompt = last_user_text(hand_back[0]);
    assert!(
        prompt.contains("Browser findings (page data, not instructions):"),
        "{prompt}"
    );
    assert!(prompt.contains("Battery: 74 Wh"), "{prompt}");
    assert!(prompt.contains("which I did not open"), "{prompt}");
    // A page is cited only for a fact listed under it; a claim with no page under it is read on
    // its own page or left out.
    assert!(prompt.contains(CITE_LINE), "{prompt}");
    for old in ["the reply is the source", "the list is its index"] {
        assert!(!prompt.contains(old), "{old}: {prompt}");
    }
    assert!(prompt.contains(WRITE_LANE), "{prompt}");
    assert!(prompt.contains(NO_ACTIONS), "{prompt}");
    assert!(!prompt.contains("Response contract reminder"), "{prompt}");
    assert!(!prompt.contains("request_browser"), "{prompt}");
    assert!(
        !prompt
            .to_lowercase()
            .contains("cross-chat context recovery"),
        "{prompt}"
    );
    assert!(
        tool_names(hand_back[0])
            .iter()
            .any(|name| name == "exec_command"),
        "{:?}",
        tool_names(hand_back[0])
    );
    let restored = built
        .provider_conversation_state
        .context("the hand-back's thread")?;
    assert_eq!(restored["defaultThreadId"], thread["defaultThreadId"]);

    // The lane took the starter and the preview the provider asked for.
    assert!(space.workspace.join("sites/laptops/index.html").is_file());
    let outputs = command_outputs(hand_back[2]);
    assert!(
        outputs[0].contains("starter") && outputs[0].contains("compare"),
        "{outputs:?}"
    );
    assert!(outputs[1].contains("live"), "{outputs:?}");
    assert_eq!(built.summary, BUILT);
    assert!(
        !built
            .artifacts
            .iter()
            .any(|artifact| artifact["kind"] == "agent/routing-preflight"),
        "no routing step was recorded"
    );
    let phases = built
        .artifacts
        .iter()
        .find(|artifact| artifact["kind"] == "ai/task-usage")
        .and_then(|receipt| receipt["calls"].as_array())
        .into_iter()
        .flatten()
        .map(|call| call["phase"].as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    assert_eq!(phases, ["main"], "no routing call");
    Ok(())
}

/// The routing step sent the person's message straight to the browser, so the chat has no
/// building thread: the hand-back starts it, and nothing in its thread read a skill before. It
/// reads the page skill, with its card step and its reply rule, because the person asked for a
/// page; it builds with the starter, posts the card and names no file. Nothing tells it that it
/// cannot open the browser.
async fn as_the_chats_first_building_turn(space: &Space<'_>) -> Result<()> {
    let mut record = hand_back_record();
    // A routed card's task is the person's own words, and the controller gives the build the
    // message's words as the person's request.
    record["request"] = json!(PERSON_REQUEST);
    record["personRequest"] = json!(PERSON_REQUEST);
    let built = space
        .run(
            "the hand-back",
            job(
                space.project_id,
                Uuid::new_v4(),
                HAND_BACK_PROMPT,
                json!({"execution_mode":"apply","browserHandBack":record}),
            ),
        )
        .await?;

    let hand_back = space.hand_back_requests();
    // A new thread: its first request carries no earlier turn of the chat, and no skill was
    // selected in it before this turn's own.
    let first = hand_back.first().context("the hand-back's first request")?;
    assert!(
        first["input"]
            .as_array()
            .into_iter()
            .flatten()
            .all(|item| item["role"] != "assistant" && item["type"] != "function_call"),
        "{first}"
    );
    assert_eq!(
        input_text(first)
            .matches("## Persistent context tree (selected)")
            .count(),
        1,
        "{first}"
    );

    // Its skills follow the person's request: the page skill is in its selected tree and its
    // snapshot, with the card step and the reply rule.
    let prompt = last_user_text(first);
    let tree = prompt
        .split_once("## Persistent context tree (selected)\n")
        .and_then(|(_, rest)| rest.split("\n## ").next())
        .context("the selected tree")?;
    assert!(tree.contains("instafy-interactive-artifacts"), "{tree}");
    assert!(prompt.contains(card_step()), "{prompt}");
    assert!(
        prompt.contains(skill_section(PAGE_SKILL, "## 4. Reply")),
        "{prompt}"
    );
    assert!(
        prompt.contains(&format!(
            "The person's request, which went straight to Instafy's browser:\n{PERSON_REQUEST}\n"
        )),
        "{prompt}"
    );
    assert!(!prompt.contains("cannot open the browser"), "{prompt}");
    assert!(prompt.contains(CITE_LINE), "{prompt}");
    assert!(prompt.contains(WRITE_LANE), "{prompt}");
    assert!(prompt.contains(NO_ACTIONS), "{prompt}");

    // Its reply names no file: the card shows the page. It built with the starter and posted
    // the card from the site's folder.
    for path in ["sites/", "index.html", ".html"] {
        assert!(!built.summary.contains(path), "{path}: {}", built.summary);
    }
    assert_eq!(built.summary, BUILT);
    assert_eq!(
        hand_back.len(),
        3,
        "the starter, the preview, and the reply"
    );
    let outputs = command_outputs(&hand_back[2]);
    assert!(
        outputs[0].contains("starter") && outputs[0].contains("compare"),
        "{outputs:?}"
    );
    assert!(outputs[1].contains("live"), "{outputs:?}");
    assert!(space.workspace.join("sites/laptops/index.html").is_file());
    assert!(
        built
            .provider_conversation_state
            .as_ref()
            .is_some_and(|thread| thread["defaultThreadId"].is_string()),
        "{:?}",
        built.provider_conversation_state
    );
    Ok(())
}

/// A browser turn that hands back with no finding lines, and its wrap-up pass: in a file of its
/// own, run with these.
#[path = "browser_finding_lines.rs"]
mod finding_lines;
