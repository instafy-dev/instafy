//! A browser card a turn wrote that is refused for what its task says, through the real proxy
//! with an inert, localhost provider. A score question's answer read the league's text-only page,
//! said "I've opened a browser check of the official results." and wrote a card naming no page:
//! refused, with no retry beside the page it read, that line stood with no card and no browser
//! behind it (a local test, Nov 19). The turn now runs once more, told why, while its line reads
//! "Working…": the person gets the retry's card, which names its page, and never the first
//! answer's line. A turn with a card left to post is not run again: it posts that card, and never
//! the refused one.
//!
//! A retry's card that opens a page the turn found itself waits for the person, and the retry's
//! words show above it: a return policy's retry handed over the shop's own page and wrote what a
//! search result said, and the person read only the card (a local test, Nov 20). A retry's card
//! refused too is left out, and its words, told to stand alone, are all the person reads.
//!
//! The first answer's words go from the reply being written as the retry begins: they were
//! written for a card that never came. Any other answer asked for again stays until the retry's
//! words replace it (`pages_of_their_own_chats`).
//!
//! The retry fixes only the card: a price question's first attempt read the shop's page, and its
//! retry, on a thread of its own and told to "search first", read it all again (a local test,
//! Nov 20). It now runs on the first attempt's own thread, which holds what that attempt read,
//! with no shell and no web search, told which rule its card broke and what to name instead. A
//! first attempt that looked nothing up has nothing to write the card from: its retry keeps the
//! shell, told to find the page first.

// The proxy fixtures of `tests/proxy_integration.rs`, as the evidence retry's own tests use them.
use crate::*;
use runtime_agent::jobs::ReplyDraft;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_REFUSED_CARD_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-refused-card-provider-key";
const RESULTS_PAGE: &str = "https://scores.example/2026-11-18";
const FIRST_LINE: &str = "I've opened a browser check of the official results.";
const NAMES_NO_PAGE: &str = "Check the official results for the team's game on November 18, 2026, and tell me who won and the final score.";
const NAMES_ITS_PAGE: &str =
    "Open https://scores.example/2026-11-18 and read the team's final score.";
/// A return policy asked beside the person's details, and the shop's own page a search found.
const POLICY_REQUEST: &str = "My email is ana@example.com and my order is 123-4567. What is the shop's return policy for it?";
const POLICY_NO_PAGE: &str = "Check the shop's return policy for my order.";
const POLICY_PAGE: &str = "Open https://shop.example/help/returns and explain the return policy that may apply to my order. Do not use or submit my email address or order number.";
const POLICY_WORDS: &str = "I found the shop's official returns page, but its site refused a direct read. A search result says unopened items can be returned within 365 days with proof of purchase; I couldn't check the full terms. The card opens the official page.";
/// A hotel asked for dates, and the retry's own card naming no page either.
const HOTEL_REQUEST: &str =
    "Find a hotel in the old town for 15 to 17 January, 2 adults, under 140 euros a night.";
const HOTEL_NO_PAGE: &str = "Check hotel availability in the old town for 15 to 17 January for 2 adults under 140 euros a night.";
const HOTEL_WORDS: &str = "One hotel's listing showed 139 euros a night in the search results, but its own page couldn't be read, so the dates and the price for two adults aren't confirmed.";
/// What the hotel's first answer said of a card that never came, and what a retry not told that
/// its words may stand alone says again.
const HOTEL_OPENED: &str =
    "I've opened a browser check for those dates; no reservation will be made.";
const STAND_ALONE: &str =
    "If this card is refused too, only your words show: make them stand alone.";
/// A price question whose first attempt read the shop's page, which the reader refused, then
/// wrote a card naming no page. The command stands in for the read and writes nothing, so the
/// turn changed no file.
const PRICE_REQUEST: &str = "What does the vacuum cost at the shop?";
const READ_OUTPUT: &str = "SHOP_PAGE_NOT_READ: the search page of the shop refused a direct read";
const READ_COMMAND: &str =
    "printf 'SHOP_PAGE_NOT_READ: the search page of the shop refused a direct read'";
const PRICE_HAND_OVER: &str = "I'm handing the shop's page to the browser to check the price.";
const PRICE_NO_PAGE: &str = "Check the vacuum's price at the shop.";
/// The retry's card names the shop's home page, as told for a page whose address would be a guess.
const PRICE_HOME_PAGE: &str = "Open https://shop.example and find the vacuum's price.";
const PRICE_WORDS: &str = "I couldn't read the vacuum's price on the shop's site.";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Case {
    /// The answer's one card names no page, beside the page it read.
    TheOnlyCard,
    /// A card that names its page stands beside the refused one.
    ACardLeft,
    /// The retry hands over a page the turn found itself, with what it read of it.
    AWaitingCard,
    /// The retry's card names no page either.
    RefusedTwice,
    /// The first attempt read a page before its card named none: the retry fixes only the card.
    AfterARead,
}

impl Case {
    fn test_name(self) -> &'static str {
        match self {
            Self::TheOnlyCard => {
                "evidence_retry::refused_card::a_turn_whose_only_card_is_refused_runs_once_more_and_posts_the_retrys_card_via_proxy"
            }
            Self::ACardLeft => {
                "evidence_retry::refused_card::a_turn_with_a_card_left_posts_it_and_never_the_refused_one_via_proxy"
            }
            Self::AWaitingCard => {
                "evidence_retry::refused_card::a_retrys_card_that_waits_for_the_person_shows_the_retrys_words_above_it_via_proxy"
            }
            Self::RefusedTwice => {
                "evidence_retry::refused_card::a_retry_whose_card_is_refused_too_ends_in_its_words_alone_via_proxy"
            }
            Self::AfterARead => {
                "evidence_retry::refused_card::a_refused_cards_retry_adds_no_search_and_no_read_via_proxy"
            }
        }
    }

    /// The provider request the retry sends: after the first answer, which follows a read for
    /// the case that reads first.
    fn retry_index(self) -> usize {
        if self == Self::AfterARead { 2 } else { 1 }
    }

    /// The person's message.
    fn request(self) -> &'static str {
        match self {
            Self::TheOnlyCard | Self::ACardLeft => {
                "Who won the team's game last night, and what was the final score?"
            }
            Self::AWaitingCard => POLICY_REQUEST,
            Self::RefusedTwice => HOTEL_REQUEST,
            Self::AfterARead => PRICE_REQUEST,
        }
    }

    fn payload(self) -> Value {
        let mut payload = json!({
            "prompt_text":self.request(),
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{
                "workspaceFileChanges":false,"commandExecution":false,"genericMcpToolExecution":false
            }}
        });
        // A chat of one person, as the controller leases its turn: the history ends with the
        // message, and it is what a card may name for Studio to open it by itself.
        if matches!(
            self,
            Self::AWaitingCard | Self::RefusedTwice | Self::AfterARead
        ) {
            payload["conversation_history"] = json!([{"role":"user","content":self.request()}]);
            payload["metadata"]["groupParticipation"] = json!({
                "decision":"respond","reason":"single_human_conversation",
                "participantCount":1,"enforcedBy":"runtime-controller"
            });
        }
        payload
    }

    /// The retry's answer, told why the first one's card was refused. The stand-in model writes
    /// words that stand alone only when its request says its card may be refused too
    /// (`stand_alone`): otherwise it points at the card again, as the hotel's retry did.
    fn retry_answer(self, stand_alone: bool) -> Option<Value> {
        let answer = |summary: &str, task: &str| {
            json!({
                "summary":summary,"code":"","suggestions":[],"files":[],
                "actions":[{"type":"request_browser","task":task}],
            })
        };
        match self {
            // It hands over the page it read by its address.
            Self::TheOnlyCard => Some(answer("", NAMES_ITS_PAGE)),
            Self::ACardLeft => None,
            Self::AWaitingCard => Some(answer(POLICY_WORDS, POLICY_PAGE)),
            Self::RefusedTwice if stand_alone => Some(answer(HOTEL_WORDS, HOTEL_NO_PAGE)),
            Self::RefusedTwice => Some(answer(HOTEL_OPENED, HOTEL_NO_PAGE)),
            Self::AfterARead => Some(answer(PRICE_WORDS, PRICE_HOME_PAGE)),
        }
    }

    /// The cards the person gets, by their tasks.
    fn cards(self) -> Vec<String> {
        match self {
            Self::TheOnlyCard | Self::ACardLeft => vec![NAMES_ITS_PAGE.to_string()],
            Self::AWaitingCard => vec![POLICY_PAGE.to_string()],
            Self::RefusedTwice => Vec::new(),
            Self::AfterARead => vec![PRICE_HOME_PAGE.to_string()],
        }
    }

    fn first_answer(self) -> Value {
        let no_page = match self {
            Self::TheOnlyCard | Self::ACardLeft => NAMES_NO_PAGE,
            Self::AWaitingCard => POLICY_NO_PAGE,
            Self::RefusedTwice => HOTEL_NO_PAGE,
            Self::AfterARead => PRICE_NO_PAGE,
        };
        let mut actions = vec![json!({
            "type":"request_browser","task":no_page,
            "browserLocation":"auto","continueBuilding":null
        })];
        if self == Self::ACardLeft {
            actions.push(json!({"type":"request_browser","task":NAMES_ITS_PAGE}));
        }
        let (summary, files) = match self {
            Self::TheOnlyCard | Self::ACardLeft => (
                format!(
                    "I couldn't verify the result from the league's text-only score page. {FIRST_LINE}"
                ),
                json!([{"change":"read","path":RESULTS_PAGE}]),
            ),
            Self::AWaitingCard => (
                "I'll check the shop's return information for your order.".to_string(),
                json!([]),
            ),
            Self::RefusedTwice => (HOTEL_OPENED.to_string(), json!([])),
            Self::AfterARead => (PRICE_HAND_OVER.to_string(), json!([])),
        };
        json!({
            "summary":summary,"code":"","suggestions":[],
            "files":files,
            "actions":actions,
        })
    }
}

#[test]
fn a_turn_whose_only_card_is_refused_runs_once_more_and_posts_the_retrys_card_via_proxy()
-> Result<()> {
    run_isolated(Case::TheOnlyCard)
}

#[test]
fn a_turn_with_a_card_left_posts_it_and_never_the_refused_one_via_proxy() -> Result<()> {
    run_isolated(Case::ACardLeft)
}

#[test]
fn a_retrys_card_that_waits_for_the_person_shows_the_retrys_words_above_it_via_proxy() -> Result<()>
{
    run_isolated(Case::AWaitingCard)
}

#[test]
fn a_retry_whose_card_is_refused_too_ends_in_its_words_alone_via_proxy() -> Result<()> {
    run_isolated(Case::RefusedTwice)
}

#[test]
fn a_refused_cards_retry_adds_no_search_and_no_read_via_proxy() -> Result<()> {
    run_isolated(Case::AfterARead)
}

fn run_isolated(case: Case) -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, case.test_name(), "refused-card");
    }

    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("refused-card-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("refused-card fixture panicked"))?
}

struct Provider {
    case: Case,
    requests: StdMutex<Vec<Value>>,
    /// The reply being written, as the person's chat shows it, and what it showed as the
    /// retry's request reached the model.
    draft: tokio::sync::watch::Receiver<ReplyDraft>,
    draft_as_the_retry_began: StdMutex<Option<ReplyDraft>>,
}

fn response(item: Value) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5","output":[item],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

fn final_answer(answer: &Value) -> Value {
    json!({
        "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":answer.to_string()}]
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
    let stand_alone = body["input"].to_string().contains(STAND_ALONE);
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body);
        requests.len() - 1
    };
    if index == state.case.retry_index() {
        *state.draft_as_the_retry_began.lock().unwrap() = Some(state.draft.borrow().clone());
    }
    match (state.case, index) {
        // The first attempt reads first: the command stands in for the reader.
        (Case::AfterARead, 0) => response(json!({
            "id":"tool_first_read","type":"function_call","name":"exec_command",
            "call_id":"call_first_read","status":"completed",
            "arguments":json!({"cmd":READ_COMMAND,"max_output_tokens":64}).to_string()
        })),
        (Case::AfterARead, 1) => response(final_answer(&Case::AfterARead.first_answer())),
        (case, 0) => response(final_answer(&case.first_answer())),
        (case, index)
            if index == case.retry_index() && case.retry_answer(stand_alone).is_some() =>
        {
            response(final_answer(&case.retry_answer(stand_alone).unwrap()))
        }
        (case, _) => panic!("unexpected extra provider request {index} for {case:?}"),
    }
}

async fn run_case(case: Case) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-refused-card-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-refused-card-runtime-key"),
        ("CODEX_API_KEY", "inert-refused-card-runtime-key"),
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

    let (draft_sender, draft) = tokio::sync::watch::channel(ReplyDraft::default());
    let state = Arc::new(Provider {
        case,
        requests: StdMutex::new(Vec::new()),
        draft,
        draft_as_the_retry_began: StdMutex::new(None),
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
        // A chat's message keeps its thread, which its first attempt starts.
        conversation_id: (case == Case::AfterARead).then(Uuid::new_v4),
        session_id: None,
        credential_id: None,
        payload: case.payload(),
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
    let (sender, mut messages) = tokio::sync::mpsc::unbounded_channel();
    let execution = tokio::time::timeout(
        Duration::from_secs(90),
        processor.run_apply_job(
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
        ),
    )
    .await
    .context("refused-card job timed out")?
    .context("refused-card job failed")?;

    let mut streamed = Vec::new();
    while let Ok(message) = messages.try_recv() {
        streamed.push(message);
    }
    let retries: Vec<(Value, Value)> = streamed
        .iter()
        .filter_map(|message| message.metadata.as_ref())
        .filter(|metadata| metadata.get("kind").and_then(Value::as_str) == Some("codex_retry"))
        .map(|metadata| {
            (
                metadata["reason"].clone(),
                metadata["activity"]["live"].clone(),
            )
        })
        .collect();
    let retry_lines: Vec<&str> = streamed
        .iter()
        .filter(|message| {
            message
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("kind"))
                .and_then(Value::as_str)
                == Some("codex_retry")
        })
        .map(|message| message.content.as_str())
        .collect();
    // Every card the turn posted, settled or streamed with its answer, by its task.
    let cards: Vec<String> = execution
        .final_messages
        .iter()
        .chain(&streamed)
        .filter(|message| message.message_type.as_deref() == Some("action_request"))
        .filter_map(|message| {
            message
                .metadata
                .as_ref()?
                .pointer("/details/browserRequest/task")?
                .as_str()
                .map(str::to_string)
        })
        .collect();
    let requests = state.requests.lock().unwrap().clone();
    // The first answer's words were written for a card that never came: they are gone from the
    // reply being written as the retry begins, not left there until the retry's words come.
    if case != Case::ACardLeft {
        let shown = state
            .draft_as_the_retry_began
            .lock()
            .unwrap()
            .clone()
            .context("the retry's request reached the model")?;
        assert!(shown.segment > 0, "the first answer was drafted: {shown:?}");
        assert_eq!(shown.text, "", "{shown:?}");
    }
    match case {
        Case::AWaitingCard | Case::RefusedTwice => {
            assert_eq!(
                retries,
                vec![(json!("refused_browser_card"), json!("Working"))]
            );
            assert_eq!(requests.len(), 2, "the first answer, then the retry's");
            let retry_input = requests[1]["input"].to_string();
            assert!(
                retry_input.contains(STAND_ALONE),
                "retry input: {retry_input}"
            );
            // Its first attempt answered at once and looked nothing up: the retry keeps the shell
            // to read or find the page its card names.
            let tools = requests[1]["tools"].to_string();
            assert!(tools.contains("\"exec_command\""), "{tools}");
            // What the retry found is the reply: above the card that waits for the person, or
            // alone when its card was refused too. Never the first answer's words.
            let words = if case == Case::AWaitingCard {
                POLICY_WORDS
            } else {
                HOTEL_WORDS
            };
            // Told its card may be refused too, the retry's words stand alone: never the line
            // that a browser check was opened, which the stand-in model writes again untold.
            assert_eq!(execution.summary, words);
        }
        Case::TheOnlyCard => {
            // Nothing failed that the person saw: the line reads "Working…".
            assert_eq!(
                retries,
                vec![(json!("refused_browser_card"), json!("Working"))]
            );
            assert_eq!(requests.len(), 2, "the first answer, then the retry's");
            // The retry was told why its card was refused, and what to name instead. Its first
            // attempt answered at once and looked nothing up, so it is told to find the page
            // first, and keeps the shell to read it.
            let retry_input = requests[1]["input"].to_string();
            assert!(
                retry_input.contains("`request_browser` card was refused for what its task says. Fix the card:")
                    && retry_input.contains("For a page whose address you would only guess, such as a site's search page, name that site's home page.")
                    && retry_input.contains("This turn read and searched nothing yet: find the page first"),
                "retry input: {retry_input}"
            );
            assert!(
                !retry_input.contains("searches and reads are done"),
                "retry input: {retry_input}"
            );
            let tools = requests[1]["tools"].to_string();
            assert!(tools.contains("\"exec_command\""), "{tools}");
            // The person reads none of the first answer's words for a card that never came.
            let said: Vec<&str> = std::iter::once(execution.summary.as_str())
                .chain(execution.final_messages.iter().map(|m| m.content.as_str()))
                .collect();
            assert!(
                said.iter().all(|words| !words.contains(FIRST_LINE)),
                "{said:?}"
            );
        }
        Case::ACardLeft => {
            assert!(retries.is_empty(), "{retries:?}");
            assert_eq!(requests.len(), 1, "one answer, not run again");
        }
        Case::AfterARead => {
            assert_eq!(
                retries,
                vec![(json!("refused_browser_card"), json!("Working"))]
            );
            // The line names the rule the card broke and what the retry names instead.
            assert_eq!(
                retry_lines,
                [
                    "Retrying: the browser card named no page by its address. The retry names each page it opens, or the site's home page for an address it would only guess."
                ]
            );
            assert_eq!(
                requests.len(),
                3,
                "the read, the first answer, then the retry's"
            );
            let retry = &requests[2];
            let retry_input = retry["input"].to_string();
            // The first attempt's own thread: what it read is in the retry's input.
            assert!(
                retry_input.contains(READ_OUTPUT),
                "retry input: {retry_input}"
            );
            for words in [
                "- It named no page it opens.",
                "name that site's home page",
                "This turn's searches and reads are done: do not search or read any page again.",
            ] {
                assert!(retry_input.contains(words), "{words}: {retry_input}");
            }
            // It has no shell and no web search: it can't read or search again.
            let tools = retry["tools"].to_string();
            for tool in ["\"exec_command\"", "\"exec\"", "\"shell\"", "web_search"] {
                assert!(!tools.contains(tool), "{tool}: {tools}");
            }
            // The one read in its input is the first attempt's.
            let outputs = retry["input"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["type"] == "function_call_output")
                .count();
            assert_eq!(outputs, 1, "retry input: {retry_input}");
            assert_eq!(execution.summary, PRICE_WORDS);
        }
    }
    // A card posted names its page, and a refused one is never posted.
    assert_eq!(cards, case.cards());

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
