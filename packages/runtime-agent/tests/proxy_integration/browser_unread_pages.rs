//! A browser turn whose findings go back to the building turn and that ended naming pages its
//! request still needs (its unread line), through the real proxy with an inert, localhost
//! provider. Told to read every page the request needs, a comparison's browser turn read the
//! maker's home page, one model's page and one review, and ended: the page was built with four of
//! its fifteen facts, and only the person's "Fill in what's still missing." filled fourteen (a
//! local test, Nov 6). The runtime runs the turn once more on its own thread, told only those
//! pages, before the build. That second pass's own unread line starts no third, a Stop between
//! the passes ends the message there, and a turn that paused for the person, had a step refused
//! or answers a question gets no second pass.
//!
//! The provider stands in for the model: the turn's answer reads two pages and names three
//! unread, and the second pass reads those three and names one more unread.

use super::*;
use runtime_agent::codex::CodexConfig;
use runtime_agent::jobs::{
    BrowserTurnAnswer, UnreadPagesPass, end_browser_turn_answer, move_findings_into_details,
    read_the_unread_pages,
};
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
const READ_13: &str = r#"{"url": "https://maker.example/laptop-13", "title": "Laptop 13", "facts": ["Battery: 74 Wh"]}"#;
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

#[derive(Clone, Copy, PartialEq, Debug)]
enum Case {
    /// The turn names three unread pages, and nothing stops the second pass.
    Reads,
    /// The person presses Stop once the turn has answered.
    StopBetween,
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
    if last_user_text(&body).contains(SECOND_PASS_OPENING) {
        final_answer(&second_answer())
    } else {
        final_answer(&first_answer())
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

    two_passes(&workspace, project_id, &state, case).await?;

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
    let pass = |stopped_for_the_person: bool, refused_a_step: bool| UnreadPagesPass {
        options: &options,
        thread: Some(thread.clone()),
        used_the_browser: true,
        stopped_for_the_person,
        refused_a_step,
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
        let read = read_the_unread_pages(
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
            read_the_unread_pages(&client, &job, pass(false, false), &mut summary, &task_usage)
                .await;
        assert!(read.artifacts.is_empty(), "{:?}", read.artifacts);
        // Not even started: a pass the Stop would only cut short is no end of the message.
        assert!(task_usage.artifact().is_none(), "no pass was started");
        assert!(!read.stopped_for_the_person);
        assert_eq!(summary, first_lines);
        assert!(second_passes(state).is_empty(), "no pass after a Stop");
        assert_eq!(state.requests.lock().unwrap().len(), 1, "the turn only");
        return Ok(());
    }

    let mut summary = first_answer();
    let task_usage = TaskUsage::default();
    let read = tokio::time::timeout(
        Duration::from_secs(60),
        read_the_unread_pages(&client, &job, pass(false, false), &mut summary, &task_usage),
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
        "https://maker.example/laptop-13",
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
    assert!(!read.stopped_for_the_person);
    // The turn ends with every page both passes read, after the words of the last, and with no
    // unread line: the second pass's starts no third.
    let lines = [READ_HOME, READ_13, READ_12, READ_16, READ_12_REVIEW].join("\n");
    assert_eq!(summary, format!("{SECOND_WORDS}\n\n{lines}"));
    assert!(!summary.contains(STILL_UNREAD), "{summary}");

    // The end of the turn asks for nothing more: it has its lines.
    let artifacts = end_browser_turn_answer(
        &client,
        &job,
        BrowserTurnAnswer {
            options: &options,
            thread: Some(thread.clone()),
            used_the_browser: true,
            stopped_for_the_person: false,
            pages: Vec::new(),
            final_json: &turn.final_json,
        },
        &mut summary,
        &TaskUsage::default(),
    )
    .await;
    assert!(artifacts.is_empty(), "{artifacts:?}");
    assert_eq!(state.requests.lock().unwrap().len(), 2, "no third pass");

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
