//! A browser turn whose findings go back to the building turn and that ended naming pages its
//! request still needs (its unread line), through the real proxy with an inert, localhost
//! provider. Told to read every page the request needs, a comparison's browser turn read the
//! maker's home page, one model's page and one review, and ended: the page was built with four of
//! its fifteen facts, and only the person's "Fill in what's still missing." filled fourteen (a
//! local test, Nov 6). The runtime runs the turn once more on its own thread, told only those
//! pages, before the build. That second pass's own unread line starts no third, a Stop between
//! the passes ends the message there, and a turn that paused for the person, had a step refused
//! or answers a question gets no second pass. Nor does a turn whose answer holds no finding line:
//! the wrap-up pass asks for the lines of the pages it read. Each pass's lines are its own: a
//! second pass that wrote none keeps the pages it opened, and one that stopped for the person
//! ends the turn with its words while the turn's note keeps the first pass's lines.
//!
//! The provider stands in for the model: the turn's answer reads two pages and names three
//! unread, and the second pass reads those three and names one more unread. In the last cases
//! the second pass takes a step in a stand-in for the browser on the person's device
//! (`finding_lines`), which its run is given as the turn's own run is.

use super::finding_lines::{
    DEVICE_PAGE, DEVICE_TOKEN, DeviceBrowser, device_browser, device_step, step_outputs,
};
use super::*;
use runtime_agent::codex::CodexConfig;
use runtime_agent::jobs::{BrowserTurnAnswer, end_browser_turn_answer, move_findings_into_details};
use runtime_agent::task_usage::TaskUsage;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_BROWSER_UNREAD_PAGES_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-unread-pages-provider-key";
/// What the browser turn was asked: the person's own message, which the routing step sent there.
const REQUEST: &str = "Compare the three latest laptops from maker.example: processor, battery, weight and price, with two independent reviews each, as a comparison page.";
/// The opening of the second pass's request (runtime-agent `unread_pages_prompt`).
const SECOND_PASS_OPENING: &str = "Your unread line named pages this request still needs:";
const FIRST_WORDS: &str = "Read 2 pages on maker.example.";
const READ_HOME: &str = r#"{"url": "https://maker.example/", "title": "Laptops", "facts": ["Lists the Laptop 12, 13 and 16."]}"#;
const READ_13: &str = r#"{"url": "https://maker.example/laptops/13", "title": "Laptop 13", "facts": ["Battery: 74 Wh"]}"#;
/// The pages the turn's unread line names.
const UNREAD: [&str; 3] = [
    "Laptop 12's own page",
    "Laptop 16's own page",
    "https://reviews.example/laptop-12",
];
const SECOND_WORDS: &str = "Read 3 more pages on maker.example and reviews.example.";
const READ_12: &str = r#"{"url": "https://maker.example/laptop-12", "title": "Laptop 12", "facts": ["Weight: 1.3 kg"]}"#;
const READ_16: &str = r#"{"url": "https://maker.example/laptop-16", "title": "Laptop 16", "facts": ["Battery: 85 Wh"]}"#;
const READ_12_REVIEW: &str = r#"{"url": "https://reviews.example/laptop-12", "title": "Laptop 12 review", "facts": ["Battery lasted 11 hours"]}"#;
/// What the second pass names unread in its turn.
const STILL_UNREAD: &str = "a second review of the Laptop 16";
/// The opening of the wrap-up pass's request (runtime-agent `FINDING_LINES_PASS_PROMPT`).
const PASS_OPENING: &str = "Your answer has no finding lines";
/// What a second pass that paused for the person to sign in replies.
const PAUSE_WORDS: &str =
    "Sign in on the review site's highlighted fields, then choose Let Octo continue.";
/// What a second pass that read the device's page replies, with no finding line.
const SECOND_PROSE: &str = "I read the Laptop 12's own page.";

fn unread_line(pages: &[&str]) -> String {
    json!({ "unread": pages }).to_string()
}

/// The turn's answer: its words, two pages read, and the three it didn't open.
fn first_answer() -> String {
    format!(
        "{FIRST_WORDS}\n{READ_HOME}\n{READ_13}\n{}",
        unread_line(&UNREAD)
    )
}

/// The second pass's answer: the three pages, and one it still didn't open.
fn second_answer() -> String {
    format!(
        "{SECOND_WORDS}\n{READ_12}\n{READ_16}\n{READ_12_REVIEW}\n{}",
        unread_line(&[STILL_UNREAD])
    )
}

#[test]
fn a_turn_that_names_unread_pages_reads_only_those_once_more_before_the_build_via_proxy()
-> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::unread_pages::a_turn_that_names_unread_pages_reads_only_those_once_more_before_the_build_via_proxy",
            "browser-unread-pages",
        );
    }
    run_on_a_large_stack(Case::Reads)
}

#[test]
fn a_stop_between_the_passes_ends_the_message_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::unread_pages::a_stop_between_the_passes_ends_the_message_via_proxy",
            "browser-unread-pages-stop",
        );
    }
    run_on_a_large_stack(Case::StopBetween)
}

/// A turn whose answer names unread pages and no finding line gets no second pass: the wrap-up
/// pass asks for the lines of the pages it read. Told those pages, a second pass's lines would
/// have kept the wrap-up from asking, and the pages the turn read would reach no note and no
/// build.
#[test]
fn a_turn_that_wrote_no_finding_line_gets_the_wrap_up_not_a_second_pass_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::unread_pages::a_turn_that_wrote_no_finding_line_gets_the_wrap_up_not_a_second_pass_via_proxy",
            "browser-unread-pages-no-lines",
        );
    }
    run_on_a_large_stack(Case::FirstWritesNoLines)
}

/// A second pass that pauses for the person: they read what they do next, and the turn's note
/// keeps the lines of the pages its first pass read, which a later building turn reads. Before,
/// the pause's words replaced the turn's whole answer, and those pages were lost.
#[test]
fn a_second_pass_that_pauses_keeps_the_first_pass_findings_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::unread_pages::a_second_pass_that_pauses_keeps_the_first_pass_findings_via_proxy",
            "browser-unread-pages-pause",
        );
    }
    run_on_a_large_stack(Case::SecondPassPauses)
}

/// A second pass that opens a page and answers with no finding line: the page its step opened
/// joins the turn's lines, by address, as the end of a turn with none does.
#[test]
fn a_second_pass_with_no_finding_line_keeps_the_page_it_opened_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::unread_pages::a_second_pass_with_no_finding_line_keeps_the_page_it_opened_via_proxy",
            "browser-unread-pages-prose",
        );
    }
    run_on_a_large_stack(Case::SecondPassWritesNoLines)
}

/// A page the turn's unread line names, which the browser refused to open because no message or
/// page gave its address, and which the turn also wrote as a page with no page there: it is no
/// finding, and stays among the pages the second pass reads. Told only "undefined" of such a
/// refusal, a comparison's browser part wrote the address as `no-page`, which also took it out of
/// its unread line, and its page said Tom's Hardware "had no page at the address checked" (a
/// local test, Nov 7).
#[test]
fn an_address_refused_as_not_given_stays_unread_and_is_no_finding_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::unread_pages::an_address_refused_as_not_given_stays_unread_and_is_no_finding_via_proxy",
            "browser-unread-pages-not-given",
        );
    }
    run_on_a_large_stack(Case::RefusedAddress)
}

/// The address the browser refused for the turn's step, and the line the turn wrote for it.
const REFUSED: &str = "https://reviews.example/laptop-12";
const REFUSED_AS_NO_PAGE: &str =
    r#"{"url": "https://reviews.example/laptop-12", "stopped": "no-page"}"#;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Case {
    /// The turn names three unread pages, and nothing stops the second pass.
    Reads,
    /// The turn also writes an address the browser refused it as a page with no page there.
    RefusedAddress,
    /// The person presses Stop once the turn has answered.
    StopBetween,
    /// The turn's answer names unread pages and holds no finding line.
    FirstWritesNoLines,
    /// The second pass pauses for the person to sign in, on the device's browser.
    SecondPassPauses,
    /// The second pass opens a page on the device's browser and writes no finding line.
    SecondPassWritesNoLines,
}

impl Case {
    /// Whether its second pass takes a step in the browser on the person's device.
    fn on_the_device(self) -> bool {
        matches!(self, Case::SecondPassPauses | Case::SecondPassWritesNoLines)
    }
}

fn run_on_a_large_stack(case: Case) -> Result<()> {
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("browser-unread-pages-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("browser unread pages fixture panicked"))?
}

struct Provider {
    case: Case,
    requests: StdMutex<Vec<Value>>,
}

fn final_answer(summary: &str) -> axum::response::Response {
    let text = json!({ "summary": summary, "code": "", "actions": [], "files": [] }).to_string();
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5",
        "output":[{
            "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
            "status":"completed","phase":"final_answer",
            "content":[{"type":"output_text","text":text}]
        }],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

/// The text of the last user message of a request: the run's prompt.
fn last_user_text(request: &Value) -> String {
    let Some(input) = request["input"].as_array() else {
        return String::new();
    };
    let Some(index) = input.iter().rposition(|item| item["role"] == "user") else {
        return String::new();
    };
    input[index]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
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
    if turn.contains(PASS_OPENING) {
        return final_answer(&format!("{READ_HOME}\n{READ_13}"));
    }
    if !turn.contains(SECOND_PASS_OPENING) {
        return match state.case {
            Case::FirstWritesNoLines => {
                final_answer(&format!("{FIRST_WORDS}\n{}", unread_line(&UNREAD)))
            }
            Case::RefusedAddress => final_answer(&format!(
                "{FIRST_WORDS}\n{READ_HOME}\n{READ_13}\n{REFUSED_AS_NO_PAGE}\n{}",
                unread_line(&UNREAD)
            )),
            _ => final_answer(&first_answer()),
        };
    }
    match (state.case, step_outputs(&body)) {
        (Case::SecondPassPauses, 0) => {
            device_step("pause", "request_human_input", json!({ "indices": [0] }))
        }
        (Case::SecondPassPauses, _) => final_answer(PAUSE_WORDS),
        (Case::SecondPassWritesNoLines, 0) => {
            device_step("open", "navigate", json!({ "url": DEVICE_PAGE }))
        }
        (Case::SecondPassWritesNoLines, _) => final_answer(SECOND_PROSE),
        _ => final_answer(&second_answer()),
    }
}

/// A browser turn's job as the controller leases it: read-only, it carries on a card the routing
/// step posted for the person's own message, and its findings go back to the building turn when
/// `hands_back`.
fn browser_job(project_id: Uuid, hands_back: bool) -> LeaseJob {
    LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: Some(Uuid::new_v4()),
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": REQUEST,
            "browser_hand_back_reads_note": true,
            "metadata": {
                "browserTransport": "shared",
                "browserRequestOf": "job:00000000-0000-4000-8000-0000000000a1",
                "browserHandsBack": hands_back,
                "browserCardTurn": {
                    "version": 1,
                    "cardJobId": "00000000-0000-4000-8000-0000000000a1",
                    "routed": true,
                },
                "writeScope": { "mode": "read_only" },
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
        json!({"OPENAI_API_KEY":"inert-unread-pages-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-unread-pages-runtime-key"),
        ("CODEX_API_KEY", "inert-unread-pages-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_PERSIST_STRUCTURED_CONVERSATION_THREAD", "true"),
        ("CODEX_SANDBOX_MODE", "workspace-write"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUN_TIMEOUT_SECONDS", "45"),
        ("CODEX_RETRY_BASE_DELAY_MS", "10"),
    ] {
        settings.push(EnvGuard::set(key, value));
    }
    settings.push(EnvGuard::remove("CODEX_RUNTIME_REASONING_EFFORT"));
    settings.push(EnvGuard::remove("CODEX_AGENT_REASONING_EFFORT"));
    settings.push(EnvGuard::set(
        "CODEX_HOME",
        runtime_home.path().to_string_lossy(),
    ));
    settings.push(EnvGuard::set(
        "CODEX_AUTH_PATH",
        auth_path.to_string_lossy(),
    ));

    let state = Arc::new(Provider {
        case,
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

    // The browser on the person's device, which a second pass that takes a step uses.
    let mut device = None;
    if case.on_the_device() {
        let browser = Arc::new(DeviceBrowser {
            project_id,
            secret: false,
            calls: StdMutex::new(Vec::new()),
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let app = Router::new()
            .route("/mcp", post(device_browser))
            .with_state(browser.clone());
        let (browser_shutdown, browser_rx) = oneshot::channel();
        let browser_task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = browser_rx.await;
                })
                .await
        });
        for (key, value) in [
            (
                "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
                format!("http://{address}"),
            ),
            (
                "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
                DEVICE_TOKEN.to_string(),
            ),
            (
                "INSTAFY_PERSONAL_BROWSER_PROJECT_ID",
                project_id.to_string(),
            ),
            (
                "INSTAFY_RUNTIME_AGENT_BIN",
                std::env::current_exe()?.to_string_lossy().into_owned(),
            ),
        ] {
            settings.push(EnvGuard::set(key, value));
        }
        device = Some((browser, ChildGuard::new(browser_shutdown), browser_task));
    }

    match case {
        Case::Reads | Case::StopBetween => two_passes(&workspace, project_id, &state, case).await?,
        Case::RefusedAddress => refused_address(&workspace, project_id, &state).await?,
        Case::FirstWritesNoLines => no_lines_no_second_pass(&workspace, project_id, &state).await?,
        Case::SecondPassPauses | Case::SecondPassWritesNoLines => {
            let calls = second_pass_on_the_device(&workspace, project_id, &state, case).await?;
            let browser = &device.as_ref().context("the device's browser")?.0;
            let expected = if case == Case::SecondPassPauses {
                "request_human_input"
            } else {
                "navigate"
            };
            assert_eq!(*browser.calls.lock().unwrap(), [expected], "{calls}");
        }
    }

    if let Some((_, guard, task)) = device {
        drop(guard);
        task.await??;
    }
    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}

/// The requests of the second pass the provider saw.
fn second_passes(state: &Provider) -> Vec<Value> {
    state
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| last_user_text(request).contains(SECOND_PASS_OPENING))
        .cloned()
        .collect()
}

async fn two_passes(
    workspace: &Path,
    project_id: Uuid,
    state: &Provider,
    case: Case,
) -> Result<()> {
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.to_path_buf(),
    });
    let stop = JobCancelSignal::new();
    // The browser turn's run, at a managed chat turn's effort, on a thread of its own that the
    // second pass resumes.
    let options = CodexRunOptions {
        persist_conversation_thread: true,
        reasoning_effort: Some(codex_protocol::openai_models::ReasoningEffort::Medium),
        cancel_signal: Some(stop.clone()),
        ..Default::default()
    };
    let turn = tokio::time::timeout(
        Duration::from_secs(60),
        client.execute_with_options(REQUEST, None, options.clone()),
    )
    .await
    .context("the browser turn timed out")??;
    assert_eq!(turn.final_json["summary"], first_answer());
    let thread = turn
        .provider_conversation_state
        .clone()
        .context("the browser turn's thread")?;
    let job = browser_job(project_id, true);
    let pass = |stopped_for_the_person: bool, refused_a_step: bool| BrowserTurnAnswer {
        options: &options,
        thread: Some(thread.clone()),
        used_the_browser: true,
        stopped_for_the_person,
        refused_a_step,
        pages: Vec::new(),
        not_given: Vec::new(),
        final_json: &turn.final_json,
        progress: None,
        runtime_id: Uuid::nil(),
        paused_already: false,
    };
    let first_lines = format!("{FIRST_WORDS}\n{READ_HOME}\n{READ_13}");

    // A turn that paused for the person, or had a step refused as theirs, gets no second pass,
    // and neither does a question's turn, whose reply is the answer; none of them keeps its
    // unread line.
    for (job, stopped, refused) in [
        (&job, true, false),
        (&job, false, true),
        (&browser_job(project_id, false), false, false),
    ] {
        let mut summary = first_answer();
        let task_usage = TaskUsage::default();
        let read = end_browser_turn_answer(
            &client,
            job,
            pass(stopped, refused),
            &mut summary,
            &task_usage,
        )
        .await;
        assert!(read.artifacts.is_empty(), "{:?}", read.artifacts);
        assert!(task_usage.artifact().is_none(), "no pass was started");
        assert_eq!(summary, first_lines);
    }
    assert!(second_passes(state).is_empty(), "no second pass");

    if case == Case::StopBetween {
        // The person pressed Stop once the turn answered: no second pass, and the turn ends with
        // what it read.
        stop.cancel();
        let mut summary = first_answer();
        let task_usage = TaskUsage::default();
        let read =
            end_browser_turn_answer(&client, &job, pass(false, false), &mut summary, &task_usage)
                .await;
        assert!(read.artifacts.is_empty(), "{:?}", read.artifacts);
        // Not even started: a pass the Stop would only cut short is no end of the message.
        assert!(task_usage.artifact().is_none(), "no pass was started");
        assert!(read.messages.is_empty());
        assert_eq!(summary, first_lines);
        assert!(second_passes(state).is_empty(), "no pass after a Stop");
        assert_eq!(state.requests.lock().unwrap().len(), 1, "the turn only");
        return Ok(());
    }

    let mut summary = first_answer();
    let task_usage = TaskUsage::default();
    let read = tokio::time::timeout(
        Duration::from_secs(60),
        end_browser_turn_answer(&client, &job, pass(false, false), &mut summary, &task_usage),
    )
    .await
    .context("the second pass timed out")?;
    // Exactly one more pass, on the turn's own thread, told only the pages it named.
    let passes = second_passes(state);
    assert_eq!(passes.len(), 1, "one second pass");
    assert_eq!(state.requests.lock().unwrap().len(), 2);
    let asked = last_user_text(&passes[0]);
    assert!(
        asked.contains(&serde_json::to_string(&UNREAD).unwrap()),
        "{asked}"
    );
    for read_already in [
        "https://maker.example/laptops/13",
        "https://maker.example/\"",
    ] {
        assert!(!asked.contains(read_already), "{read_already}: {asked}");
    }
    let earlier = input_text(&passes[0]);
    assert!(earlier.contains(REQUEST), "{earlier}");
    assert!(earlier.contains(FIRST_WORDS), "{earlier}");
    // Its run log follows the turn's, so the turn is billed from its first run only.
    assert!(
        read.artifacts
            .iter()
            .any(|artifact| artifact["kind"] == "codex/run-log"
                && artifact["metadata"]["purpose"] == "unread-pages"),
        "{:?}",
        read.artifacts
    );
    let receipt = task_usage.artifact().context("the pass's usage receipt")?;
    let phases: Vec<&str> = receipt["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| call["phase"].as_str())
        .collect();
    assert!(
        !phases.is_empty() && phases.iter().all(|phase| *phase == "recovery"),
        "{receipt}"
    );
    // The turn ends with every page both passes read, after the words of both, and with no
    // unread line: the second pass's starts no third, and with its lines the end of the turn
    // asks for nothing more.
    let lines = [READ_HOME, READ_13, READ_12, READ_16, READ_12_REVIEW].join("\n");
    assert_eq!(
        summary,
        format!("{FIRST_WORDS}\n\n{SECOND_WORDS}\n\n{lines}")
    );
    assert!(!summary.contains(STILL_UNREAD), "{summary}");
    assert_eq!(state.requests.lock().unwrap().len(), 2, "no third pass");
    assert!(
        read.artifacts
            .iter()
            .all(|artifact| artifact["metadata"]["purpose"] != "finding-lines-wrap-up"),
        "{:?}",
        read.artifacts
    );

    // Then the build: the turn's note names every page read, which the hand-back goes on.
    let mut ended = runtime_agent::jobs::JobExecution {
        summary,
        suggested_replies: Vec::new(),
        provider: "codex-embedded".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: Vec::new(),
    };
    move_findings_into_details(&job, &mut ended);
    assert_eq!(ended.summary, "", "no reply bubble");
    assert_eq!(ended.final_messages.len(), 1);
    assert_eq!(
        ended.final_messages[0].metadata.as_ref().unwrap()["browserFindings"],
        json!({ "pages": 5, "pagesRead": 5 })
    );
    Ok(())
}

/// The turn wrote an address the browser refused it (`not_given`) as a page with no page there:
/// the second pass is told to read it with the other two, its line goes, and the turn ends with
/// every page both passes read.
async fn refused_address(workspace: &Path, project_id: Uuid, state: &Provider) -> Result<()> {
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.to_path_buf(),
    });
    let options = CodexRunOptions {
        persist_conversation_thread: true,
        reasoning_effort: Some(codex_protocol::openai_models::ReasoningEffort::Medium),
        ..Default::default()
    };
    let turn = the_turn(&client, &options).await?;
    let mut answer = its_answer(&options, &turn)?;
    answer.not_given = vec![REFUSED.to_string()];
    let mut summary = turn.final_json["summary"]
        .as_str()
        .context("the turn's answer")?
        .to_string();
    assert!(summary.contains(REFUSED_AS_NO_PAGE), "{summary}");
    let task_usage = TaskUsage::default();
    tokio::time::timeout(
        Duration::from_secs(60),
        end_browser_turn_answer(
            &client,
            &browser_job(project_id, true),
            answer,
            &mut summary,
            &task_usage,
        ),
    )
    .await
    .context("the second pass timed out")?;
    let passes = second_passes(state);
    assert_eq!(passes.len(), 1, "one second pass");
    let asked = last_user_text(&passes[0]);
    assert!(
        asked.contains(&serde_json::to_string(&UNREAD).unwrap()),
        "{asked}"
    );
    let lines = [READ_HOME, READ_13, READ_12, READ_16, READ_12_REVIEW].join("\n");
    assert_eq!(
        summary,
        format!("{FIRST_WORDS}\n\n{SECOND_WORDS}\n\n{lines}")
    );
    assert!(!summary.contains("no-page"), "{summary}");
    Ok(())
}

/// The browser turn's run, on a thread of its own that a pass resumes, and its answer as the end
/// of the turn reads it.
async fn the_turn(
    client: &CodexClient,
    options: &CodexRunOptions,
) -> Result<runtime_agent::codex::CodexRunOutput> {
    tokio::time::timeout(
        Duration::from_secs(60),
        client.execute_with_options(REQUEST, None, options.clone()),
    )
    .await
    .context("the browser turn timed out")?
}

/// The answer of a browser turn whose findings go back to the building turn, as its job ends it.
fn its_answer<'a>(
    options: &'a CodexRunOptions,
    turn: &'a runtime_agent::codex::CodexRunOutput,
) -> Result<BrowserTurnAnswer<'a>> {
    Ok(BrowserTurnAnswer {
        options,
        thread: Some(
            turn.provider_conversation_state
                .clone()
                .context("the browser turn's thread")?,
        ),
        used_the_browser: true,
        stopped_for_the_person: false,
        refused_a_step: false,
        pages: vec!["https://maker.example/".to_string()],
        not_given: Vec::new(),
        final_json: &turn.final_json,
        progress: None,
        runtime_id: Uuid::nil(),
        paused_already: false,
    })
}

async fn no_lines_no_second_pass(
    workspace: &Path,
    project_id: Uuid,
    state: &Provider,
) -> Result<()> {
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.to_path_buf(),
    });
    let options = CodexRunOptions {
        persist_conversation_thread: true,
        ..Default::default()
    };
    let turn = the_turn(&client, &options).await?;
    let mut summary = turn.final_json["summary"]
        .as_str()
        .context("the turn's answer")?
        .to_string();
    assert_eq!(summary, format!("{FIRST_WORDS}\n{}", unread_line(&UNREAD)));
    let job = browser_job(project_id, true);
    let ended = tokio::time::timeout(
        Duration::from_secs(60),
        end_browser_turn_answer(
            &client,
            &job,
            its_answer(&options, &turn)?,
            &mut summary,
            &TaskUsage::default(),
        ),
    )
    .await
    .context("the end of the turn timed out")?;
    assert!(second_passes(state).is_empty(), "no second pass");
    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2, "the turn, then the wrap-up pass");
    assert!(last_user_text(&requests[1]).contains(PASS_OPENING));
    assert!(
        ended
            .artifacts
            .iter()
            .any(|artifact| artifact["metadata"]["purpose"] == "finding-lines-wrap-up"),
        "{:?}",
        ended.artifacts
    );
    // The pages the turn read reach its note, and its unread line is gone.
    assert_eq!(summary, format!("{FIRST_WORDS}\n\n{READ_HOME}\n{READ_13}"));
    Ok(())
}

/// A second pass that takes a step in the browser on the person's device: it pauses for the
/// person to sign in, or opens a page and answers with no finding line. Returns the calls that
/// browser saw, for the message of a failed check.
async fn second_pass_on_the_device(
    workspace: &Path,
    project_id: Uuid,
    state: &Provider,
    case: Case,
) -> Result<String> {
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.to_path_buf(),
    });
    let options = CodexRunOptions {
        persist_conversation_thread: true,
        personal_browser: true,
        project_id: Some(project_id),
        ..Default::default()
    };
    let turn = the_turn(&client, &options).await?;
    let mut summary = first_answer();
    let job = browser_job(project_id, true);
    let ended = tokio::time::timeout(
        Duration::from_secs(60),
        end_browser_turn_answer(
            &client,
            &job,
            its_answer(&options, &turn)?,
            &mut summary,
            &TaskUsage::default(),
        ),
    )
    .await
    .context("the second pass timed out")?;
    let passes = second_passes(state);
    assert_eq!(
        passes.len(),
        2,
        "one second pass: its step, then its answer"
    );
    // No wrap-up pass: each pass's lines are its own.
    assert!(
        state
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| !last_user_text(request).contains(PASS_OPENING)),
        "no wrap-up pass"
    );
    let first_lines = format!("{READ_HOME}\n{READ_13}");
    let mut done = runtime_agent::jobs::JobExecution {
        summary: summary.clone(),
        suggested_replies: Vec::new(),
        provider: "codex-embedded".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: ended.messages.clone(),
        messages_streamed: false,
        final_messages: Vec::new(),
    };
    move_findings_into_details(&job, &mut done);
    let note = done
        .final_messages
        .first()
        .map(|message| message.content.clone())
        .unwrap_or_default();
    match case {
        Case::SecondPassPauses => {
            // The person reads what they do next, and the note keeps what the first pass read.
            assert_eq!(summary, format!("{PAUSE_WORDS}\n\n{first_lines}"));
            assert_eq!(done.summary, PAUSE_WORDS);
            assert_eq!(note, first_lines);
        }
        _ => {
            // The page its step opened joins the turn's lines, by address.
            let opened = format!("{{\"url\":\"{DEVICE_PAGE}\"}}");
            assert_eq!(
                summary,
                format!("{FIRST_WORDS}\n\n{SECOND_PROSE}\n\n{first_lines}\n{opened}")
            );
            assert_eq!(done.summary, "", "a hand-back follows: no reply bubble");
            assert_eq!(
                note,
                format!("{FIRST_WORDS}\n\n{SECOND_PROSE}\n\n{first_lines}\n{opened}")
            );
        }
    }
    Ok(format!("{:?}", ended.messages.len()))
}
