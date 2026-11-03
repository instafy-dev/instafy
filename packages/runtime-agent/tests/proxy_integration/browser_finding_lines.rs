//! A browser turn whose findings go back to the building turn, that read pages and ended with no
//! finding lines, through the real proxy with an inert, localhost provider. A comparison's
//! browser turn read seven pages and answered with a summary, a build request and no finding
//! lines; Studio and the controller hand back only on a note of finding lines that names a page
//! read, so nothing was built, twice, while its reply said "I'm passing the findings to the
//! comparison-page build." (a local test, Nov 3). The runtime's wrap-up pass asks the turn, on its
//! own thread, for those lines only; with still none, the turn's note holds its reply and the
//! pages its own steps opened. Either way the hand-back goes and the turn posts no words of its
//! own. A build request that nothing acts on is said in the reply, never dropped without a word.
//! A turn that stopped on a step that is the person's keeps its reply as it wrote it.
//!
//! The provider stands in for the model: the browser turn's answer is the comparison's, and the
//! wrap-up pass answers with lines, with none, or after a step it was told not to take. The first
//! cases call the runtime's end of a browser turn directly, with what the turn's steps opened as
//! the run reports it (`CodexRunOutput::browser_pages`). The last run whole jobs through the job
//! processor, with a stand-in for the browser on the person's device: its turns keep no thread,
//! so they get no pass, and the pages come from what that browser reported for each step.

use super::*;
use runtime_agent::codex::CodexConfig;
use runtime_agent::jobs::{BrowserTurnAnswer, end_browser_turn_answer, move_findings_into_details};
use runtime_agent::task_usage::TaskUsage;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_BROWSER_FINDING_LINES_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-finding-lines-provider-key";
/// What the browser turn was asked: the person's own message, which the routing step sent there.
const REQUEST: &str = "Compare the three latest laptops from maker.example: processor, battery, weight and price, with two independent reviews each, as a comparison page.";
/// The browser turn's answer, which promises a build and names no page.
const PROMISED_BUILD: &str = "Read the maker's pages and two reviews. I'm passing the findings to the comparison-page build.";
/// The opening of the wrap-up pass's request (runtime-agent `FINDING_LINES_PASS_PROMPT`).
const PASS_OPENING: &str = "Your answer has no finding lines, and the building turn makes what the person asked for only from them.";
const READ_13: &str = r#"{"url": "https://maker.example/laptop-13", "title": "Laptop 13", "facts": ["Battery: 74 Wh"]}"#;
const READ_REVIEW: &str = r#"{"url": "https://reviews.example/laptop-13", "title": "Laptop 13 review", "facts": ["Battery lasted 20 hours"]}"#;
/// The pages the browser turn's own steps opened, as the run reports them.
const OPENED: [&str; 2] = [
    "https://maker.example/laptop-13",
    "https://reviews.example/laptop-13",
];
/// What the runtime says when a build request is not acted on (runtime-agent
/// `BUILD_NOT_MADE_LINE`).
const NOT_MADE: &str = "I haven't made it yet: ask me to, and I'll use what I found.";
/// The opening of a routing step's request, which no browser turn makes.
const ROUTING_OPENING: &str = "Instafy routing preflight.";

#[test]
fn a_hand_back_turn_with_no_finding_lines_gets_them_from_the_wrap_up_pass_via_proxy() -> Result<()>
{
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_hand_back_turn_with_no_finding_lines_gets_them_from_the_wrap_up_pass_via_proxy",
            "browser-finding-lines",
        );
    }
    run_on_a_large_stack(Case::Pass(Pass::WritesLines))
}

#[test]
fn a_hand_back_turn_whose_wrap_up_pass_writes_none_hands_back_its_pages_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_hand_back_turn_whose_wrap_up_pass_writes_none_hands_back_its_pages_via_proxy",
            "browser-finding-lines-none",
        );
    }
    run_on_a_large_stack(Case::Pass(Pass::WritesNone))
}

/// The pass is told to use no tool. One that took a step anyway answered from more than the pages
/// the turn read: its lines are not used, and the note holds the pages the turn opened.
#[test]
fn a_wrap_up_pass_that_takes_a_step_is_not_used_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_wrap_up_pass_that_takes_a_step_is_not_used_via_proxy",
            "browser-finding-lines-step",
        );
    }
    run_on_a_large_stack(Case::Pass(Pass::TakesAStep))
}

/// A hand-back turn in the browser on the person's device, run whole: it opened the maker's page
/// and answered with a build request and no finding line. It is offered no build request, since
/// a build comes after it. Its turn keeps no thread, so it gets no pass; its note holds its reply
/// and the page that browser reported, so the hand-back goes, and it posts no words of its own.
/// A routed turn that hands nothing back is offered the build request, and its own, asked for
/// after it opened a page, is said in its reply: nothing acts on it.
#[test]
fn a_device_browser_turn_with_no_finding_lines_hands_back_the_page_it_opened_via_proxy()
-> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_device_browser_turn_with_no_finding_lines_hands_back_the_page_it_opened_via_proxy",
            "browser-finding-lines-device",
        );
    }
    run_on_a_large_stack(Case::Device(Device::Reads))
}

/// The same when the page is opened on the runtime's retry of a first answer that used no browser.
#[test]
fn a_device_browser_turns_retry_hands_back_the_page_it_opened_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_device_browser_turns_retry_hands_back_the_page_it_opened_via_proxy",
            "browser-finding-lines-device-retry",
        );
    }
    run_on_a_large_stack(Case::Device(Device::ReadsOnRetry))
}

/// A hand-back turn that opened a page and then paused for the person to sign in: its reply says
/// what they do next, so it stays in the chat as the turn wrote it, with no page taken for its
/// findings. Studio never hands back a paused turn, so with its reply moved to a note the person
/// would read nothing.
#[test]
fn a_device_browser_turn_that_paused_for_the_person_keeps_its_reply_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_device_browser_turn_that_paused_for_the_person_keeps_its_reply_via_proxy",
            "browser-finding-lines-device-pause",
        );
    }
    run_on_a_large_stack(Case::Device(Device::Pauses))
}

/// A hand-back turn whose page showed a secret stops there and tells the person which control
/// shows it: that reply stays theirs.
#[test]
fn a_device_browser_turn_that_met_a_secret_keeps_its_reply_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_hand_back::finding_lines::a_device_browser_turn_that_met_a_secret_keeps_its_reply_via_proxy",
            "browser-finding-lines-device-secret",
        );
    }
    run_on_a_large_stack(Case::Device(Device::MeetsASecret))
}

/// Which case a fixture runs.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Case {
    /// The runtime's end of a browser turn, called with the turn's thread, and what the pass
    /// does.
    Pass(Pass),
    /// A whole browser turn in the browser on the person's device, and what it does.
    Device(Device),
}

/// What the provider's wrap-up pass answers.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Pass {
    WritesLines,
    WritesNone,
    /// It runs a command, then writes lines.
    TakesAStep,
}

/// What a whole browser turn on the person's device does.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Device {
    /// It opens the maker's page and answers with a build request and no finding line.
    Reads,
    /// Its first answer uses no browser; the runtime's retry opens the page and answers so.
    ReadsOnRetry,
    /// It opens the maker's page, then pauses for the person to sign in.
    Pauses,
    /// The page it opens shows a secret, which it stops at.
    MeetsASecret,
}

fn run_on_a_large_stack(case: Case) -> Result<()> {
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("browser-finding-lines-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("browser finding lines fixture panicked"))?
}

struct Provider {
    case: Case,
    requests: StdMutex<Vec<Value>>,
}

fn response(output: Value) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5",
        "output":[output],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

fn final_answer(summary: &str, actions: Value) -> axum::response::Response {
    let text =
        json!({ "summary": summary, "code": "", "actions": actions, "files": [] }).to_string();
    response(json!({
        "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
        "status":"completed","phase":"final_answer",
        "content":[{"type":"output_text","text":text}]
    }))
}

/// The model's call of the shell, which the pass was told not to make.
fn command(id: &str, cmd: &str) -> axum::response::Response {
    response(json!({
        "id":format!("tool_{id}"),"type":"function_call","name":"exec_command",
        "call_id":format!("call_{id}"),"status":"completed",
        "arguments":json!({"cmd":cmd,"max_output_tokens":256}).to_string()
    }))
}

/// The model's call of a tool of the browser on the person's device.
fn device_step(id: &str, tool: &str, arguments: Value) -> axum::response::Response {
    response(json!({
        "id":format!("fc_{id}"),"type":"function_call","status":"completed",
        "call_id":format!("call_{id}"),"namespace":DEVICE_NAMESPACE,"name":tool,
        "arguments":arguments.to_string()
    }))
}

fn last_user_index(request: &Value) -> Option<usize> {
    request["input"]
        .as_array()?
        .iter()
        .rposition(|item| item["role"] == "user")
}

/// The text of the last user message of a request: the run's prompt.
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

/// How many of its calls the run sent back the output of since its prompt.
fn step_outputs(request: &Value) -> usize {
    let start = last_user_index(request).unwrap_or(0);
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .skip(start)
        .filter(|item| item["type"] == "function_call_output")
        .count()
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

/// The words the runtime's retry of a browser turn on the person's device opens with.
const DEVICE_RETRY: &str = "IMPORTANT PERSONAL BROWSER RETRY REQUIREMENT:";

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
    let steps = step_outputs(&body);
    match state.case {
        Case::Pass(pass) if turn.contains(PASS_OPENING) => match (pass, steps) {
            (Pass::WritesLines, _) => final_answer(&format!("{READ_13}\n{READ_REVIEW}"), json!([])),
            (Pass::WritesNone, _) => {
                final_answer("I read the maker's pages and two reviews.", json!([]))
            }
            (Pass::TakesAStep, 0) => command("pass-step", "printf checked"),
            (Pass::TakesAStep, _) => final_answer(&format!("{READ_13}\n{READ_REVIEW}"), json!([])),
        },
        // A browser turn's answer: the comparison's, a build request and no finding line.
        Case::Pass(_) => final_answer(
            PROMISED_BUILD,
            json!([{ "type": "request_build", "continueBuilding": true, "task": "Build the comparison page." }]),
        ),
        // No browser turn takes a routing step or, on the person's device, a pass: answer it so
        // the run ends, and the test fails on the request it made.
        Case::Device(_) if turn.contains(ROUTING_OPENING) || turn.contains(PASS_OPENING) => {
            final_answer("unexpected", json!([]))
        }
        Case::Device(device) => {
            let retry = turn.contains(DEVICE_RETRY);
            match (device, retry, steps) {
                // A first answer that used no browser, which the runtime tries again.
                (Device::ReadsOnRetry, false, _) => final_answer(
                    "I'll compare the three laptops on a page once I have read them.",
                    json!([]),
                ),
                (_, _, 0) => device_step("open", "navigate", json!({ "url": DEVICE_PAGE })),
                (Device::Pauses, _, 1) => {
                    device_step("pause", "request_human_input", json!({ "indices": [0] }))
                }
                (Device::Pauses, _, _) => final_answer(PAUSE_WORDS, json!([])),
                (Device::MeetsASecret, _, _) => final_answer(SECRET_WORDS, json!([])),
                (Device::Reads | Device::ReadsOnRetry, _, _) => final_answer(
                    PROMISED_BUILD,
                    json!([{ "type": "request_build", "continueBuilding": true, "task": "Build the comparison page." }]),
                ),
            }
        }
    }
}

/// What a routed browser turn that hands nothing back is offered, and no other (runtime-agent
/// `BUILD_REQUEST_LINE`).
const BUILD_REQUEST_OFFER: &str = "answer with the action `{type: 'request_build'}` alone";

/// A browser turn's job as the controller leases it: read-only, it carries on a card the routing
/// step posted for the person's own message, and its findings go back to the building turn when
/// `hands_back`.
fn browser_job(project_id: Uuid, transport: &str, hands_back: bool) -> LeaseJob {
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
                "browserTransport": transport,
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

fn execution(summary: String) -> runtime_agent::jobs::JobExecution {
    runtime_agent::jobs::JobExecution {
        summary,
        suggested_replies: Vec::new(),
        provider: "codex-embedded".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: Vec::new(),
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
        json!({"OPENAI_API_KEY":"inert-finding-lines-runtime-key"}).to_string(),
    )?;
    let mut settings = Vec::new();
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-finding-lines-runtime-key"),
        ("CODEX_API_KEY", "inert-finding-lines-runtime-key"),
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
    // The turn's own effort, not an operator's runtime-wide one, which would win over both.
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

    match case {
        Case::Pass(pass) => {
            end_of_a_turn_with_its_thread(&workspace, project_id, &state, pass).await?
        }
        Case::Device(device) => {
            a_whole_device_turn(&workspace_root, project_id, &state, device, &mut settings).await?
        }
    }

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}

/// The requests of the wrap-up pass the provider saw.
fn passes(state: &Provider) -> Vec<Value> {
    state
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| last_user_text(request).contains(PASS_OPENING))
        .cloned()
        .collect()
}

async fn end_of_a_turn_with_its_thread(
    workspace: &Path,
    project_id: Uuid,
    state: &Provider,
    pass: Pass,
) -> Result<()> {
    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.to_path_buf(),
    });
    // The browser turn's run, at a managed chat turn's effort, on a thread of its own that the
    // pass resumes.
    let options = CodexRunOptions {
        persist_conversation_thread: true,
        reasoning_effort: Some(codex_protocol::openai_models::ReasoningEffort::Medium),
        ..Default::default()
    };
    let turn = tokio::time::timeout(
        Duration::from_secs(60),
        client.execute_with_options(REQUEST, None, options.clone()),
    )
    .await
    .context("the browser turn timed out")??;
    assert_eq!(turn.final_json["summary"], PROMISED_BUILD);
    let thread = turn
        .provider_conversation_state
        .clone()
        .context("the browser turn's thread")?;
    let pages: Vec<String> = OPENED.iter().map(|page| page.to_string()).collect();

    // Its findings go back to the building turn: the pass asks its own thread for the lines.
    let job = browser_job(project_id, "shared", true);
    let mut summary = PROMISED_BUILD.to_string();
    let task_usage = TaskUsage::default();
    let artifacts = tokio::time::timeout(
        Duration::from_secs(60),
        end_browser_turn_answer(
            &client,
            &job,
            BrowserTurnAnswer {
                options: &options,
                thread: Some(thread.clone()),
                used_the_browser: true,
                stopped_for_the_person: false,
                pages: pages.clone(),
                final_json: &turn.final_json,
            },
            &mut summary,
            &task_usage,
        ),
    )
    .await
    .context("the wrap-up pass timed out")?;

    let requests = state.requests.lock().unwrap().clone();
    let pass_requests = passes(state);
    // One pass: one request, or for the pass that took a step, that step's and the next.
    let expected = if pass == Pass::TakesAStep { 2 } else { 1 };
    assert_eq!(pass_requests.len(), expected, "one wrap-up pass");
    let pass_request = &pass_requests[0];
    // On the browser turn's own thread: it holds the turn's request and its answer.
    let earlier = input_text(pass_request);
    assert!(earlier.contains(REQUEST), "{earlier}");
    assert!(earlier.contains(PROMISED_BUILD), "{earlier}");
    // Asked for the finding lines alone, at low effort.
    let asked = last_user_text(pass_request);
    assert!(
        asked.contains("Answer again with only your finding lines in `summary`"),
        "{asked}"
    );
    assert!(asked.contains("Use no tool, open no page and write no other words."));
    assert_eq!(pass_request["reasoning"]["effort"], "low", "{pass_request}");
    let turn_request = requests
        .iter()
        .find(|request| !last_user_text(request).contains(PASS_OPENING))
        .context("the browser turn's request")?;
    assert_eq!(
        turn_request["reasoning"]["effort"], "medium",
        "{turn_request}"
    );
    // No tool is required first: the lines are its answer.
    assert_ne!(pass_request["tool_choice"], "required", "{pass_request}");
    // Its run log follows the turn's, so the turn is billed from its first run only.
    assert!(
        artifacts
            .iter()
            .any(|artifact| artifact["kind"] == "codex/run-log"
                && artifact["metadata"]["purpose"] == "finding-lines-wrap-up"),
        "{artifacts:?}"
    );
    let receipt = task_usage.artifact().context("the pass's usage receipt")?;
    let phases: Vec<&str> = receipt["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| call["phase"].as_str())
        .collect();
    assert!(
        !phases.is_empty() && phases.iter().all(|phase| *phase == "finalization"),
        "{receipt}"
    );

    let opened_lines = format!(
        "{{\"url\":\"{}\"}}\n{{\"url\":\"{}\"}}",
        OPENED[0], OPENED[1]
    );
    let lines = match pass {
        Pass::WritesLines => format!("{READ_13}\n{READ_REVIEW}"),
        // With still none, the pages the turn's own steps opened.
        Pass::WritesNone => opened_lines.clone(),
        // The pass ran a command: its lines are not used.
        Pass::TakesAStep => {
            assert_eq!(
                step_outputs(&pass_requests[1]),
                1,
                "the step, then the lines"
            );
            opened_lines.clone()
        }
    };
    assert_eq!(summary, format!("{PROMISED_BUILD}\n\n{lines}"));
    assert!(
        !summary.contains(NOT_MADE),
        "a hand-back follows: {summary}"
    );

    // The turn posts no reply bubble: its words and its lines go into its note, which names the
    // pages read that Studio and the controller hand back on.
    let mut ended = execution(summary);
    move_findings_into_details(&job, &mut ended);
    assert_eq!(ended.summary, "", "no reply bubble");
    assert_eq!(ended.final_messages.len(), 1);
    assert_eq!(
        ended.final_messages[0].content,
        format!("{PROMISED_BUILD}\n\n{lines}")
    );
    assert_eq!(
        ended.final_messages[0].metadata.as_ref().unwrap()["browserFindings"],
        json!({ "pages": 2, "pagesRead": 2 })
    );
    let passes_so_far = passes(state).len();

    // A routed turn that hands nothing back gets no pass, and its build request, which nothing
    // acts on after it opened pages, is said in its reply.
    let routed = browser_job(project_id, "shared", false);
    let mut summary = PROMISED_BUILD.to_string();
    let artifacts = end_browser_turn_answer(
        &client,
        &routed,
        BrowserTurnAnswer {
            options: &options,
            thread: Some(thread.clone()),
            used_the_browser: true,
            stopped_for_the_person: false,
            pages: pages.clone(),
            final_json: &turn.final_json,
        },
        &mut summary,
        &TaskUsage::default(),
    )
    .await;
    assert!(artifacts.is_empty(), "{artifacts:?}");
    assert_eq!(summary, format!("{PROMISED_BUILD}\n\n{NOT_MADE}"));
    assert_eq!(
        passes(state).len(),
        passes_so_far,
        "no pass for a turn that hands nothing back"
    );

    // A turn that stopped on a step of the person's is left as it wrote it: no pass, no page
    // lines and no word about a build, whatever its answer asked.
    let words = "Sign in on the highlighted fields, then choose Let Octo continue.";
    for hands_back in [true, false] {
        let mut summary = words.to_string();
        let artifacts = end_browser_turn_answer(
            &client,
            &browser_job(project_id, "shared", hands_back),
            BrowserTurnAnswer {
                options: &options,
                thread: Some(thread.clone()),
                used_the_browser: true,
                stopped_for_the_person: true,
                pages: pages.clone(),
                final_json: &turn.final_json,
            },
            &mut summary,
            &TaskUsage::default(),
        )
        .await;
        assert!(artifacts.is_empty(), "{artifacts:?}");
        assert_eq!(summary, words);
    }
    assert_eq!(
        passes(state).len(),
        passes_so_far,
        "no pass for a turn that stopped for the person"
    );
    Ok(())
}

/// The namespace the turn calls the browser on the person's device in.
const DEVICE_NAMESPACE: &str = "mcp__instafy_personal_browser";
const DEVICE_TOKEN: &str = "inert-finding-lines-device-token";
/// The page the turn opens there, and the address that browser reports for the step.
const DEVICE_PAGE: &str = "https://maker.example/laptop-13";
/// What a turn that paused for the person to sign in replies.
const PAUSE_WORDS: &str = "Sign in on the highlighted fields in the browser on this device, then choose Let Octo continue.";
/// What a turn whose page showed a secret replies.
const SECRET_WORDS: &str = "This page shows a key under \"API keys\". I didn't copy it: open that section yourself to see it.";

/// The stand-in for the browser on the person's device: its tools, and each step's result with
/// the page the step left the tab on, as that browser reports it.
struct DeviceBrowser {
    project_id: Uuid,
    secret: bool,
    calls: StdMutex<Vec<String>>,
}

async fn device_browser(
    State(state): State<Arc<DeviceBrowser>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> axum::response::Response {
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(format!("Bearer {DEVICE_TOKEN}").as_str())
        && headers
            .get("x-instafy-project-id")
            .and_then(|value| value.to_str().ok())
            == Some(state.project_id.to_string().as_str());
    if !authorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let schema = |properties: Value, required: Value| json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false });
    let result = match payload.get("method").and_then(Value::as_str) {
        Some(method) if method.starts_with("notifications/") => {
            return StatusCode::ACCEPTED.into_response();
        }
        Some("initialize") => json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "instafy-personal-browser", "version": "1.0.0" },
        }),
        Some("tools/list") => json!({ "tools": [
            {
                "name": "navigate",
                "description": "Open an approved page in the browser.",
                "inputSchema": schema(json!({ "url": { "type": "string" } }), json!(["url"])),
            },
            {
                "name": "snapshot",
                "description": "Read the visible page.",
                "inputSchema": schema(json!({}), json!([])),
            },
            {
                "name": "request_human_input",
                "description": "Ask the person to fill the highlighted fields. This ends the turn.",
                "inputSchema": schema(
                    json!({ "indices": { "type": "array", "items": { "type": "integer" } } }),
                    json!(["indices"]),
                ),
            },
        ]}),
        Some("tools/call") => {
            let tool = payload
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            state.calls.lock().unwrap().push(tool.clone());
            let structured = match tool.as_str() {
                "request_human_input" => json!({
                    "humanInputRequired": true,
                    "message": "The person fills the highlighted fields and starts a fresh turn.",
                }),
                _ => json!({
                    "url": DEVICE_PAGE,
                    "title": "Laptop 13",
                    "visibleText": "Laptop 13. Battery: 74 Wh. Sign in",
                    "interactiveElements": [{ "index": 0, "role": "textbox", "label": "Email" }],
                    "secretScreen": state.secret,
                    "activity": { "step": tool, "url": DEVICE_PAGE },
                }),
            };
            json!({
                "content": [{ "type": "text", "text": structured.to_string() }],
                "structuredContent": structured,
                "isError": false,
            })
        }
        _ => {
            return Json(json!({ "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": "Method not found" } }))
            .into_response();
        }
    };
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

async fn a_whole_device_turn(
    workspace_root: &TempDir,
    project_id: Uuid,
    state: &Provider,
    device: Device,
    settings: &mut Vec<EnvGuard>,
) -> Result<()> {
    let browser = Arc::new(DeviceBrowser {
        project_id,
        secret: device == Device::MeetsASecret,
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
    let browser_guard = ChildGuard::new(browser_shutdown);
    settings.push(EnvGuard::set(
        "INSTAFY_PERSONAL_BROWSER_CONTROL_URL",
        format!("http://{address}"),
    ));
    settings.push(EnvGuard::set(
        "INSTAFY_PERSONAL_BROWSER_CONTROL_TOKEN",
        DEVICE_TOKEN,
    ));
    settings.push(EnvGuard::set(
        "INSTAFY_PERSONAL_BROWSER_PROJECT_ID",
        project_id.to_string(),
    ));
    settings.push(EnvGuard::set(
        "INSTAFY_RUNTIME_AGENT_BIN",
        std::env::current_exe()?.to_string_lossy(),
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
    let job = browser_job(project_id, "desktop-personal", true);
    let mut ended = tokio::time::timeout(
        Duration::from_secs(90),
        processor.run_apply_job(
            &registration_for_live(Uuid::new_v4()),
            &job,
            true,
            None,
            None,
            None,
        ),
    )
    .await
    .context("the browser turn timed out")?
    .context("the browser turn failed")?;

    let requests = state.requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .all(|request| !last_user_text(request).contains(ROUTING_OPENING)),
        "a browser turn takes no routing step"
    );
    // Its turn keeps no thread, so it gets no pass.
    assert!(passes(state).is_empty(), "no pass on the person's device");
    // A routed turn whose findings go back to the building turn is offered no build request:
    // a build comes after it already.
    for request in &requests {
        assert!(
            !input_text(request).contains(BUILD_REQUEST_OFFER),
            "{request}"
        );
    }
    let calls = browser.calls.lock().unwrap().clone();
    assert_eq!(
        calls.first().map(String::as_str),
        Some("navigate"),
        "{calls:?}"
    );
    if device == Device::ReadsOnRetry {
        assert!(
            requests
                .iter()
                .any(|request| last_user_text(request).contains(DEVICE_RETRY)),
            "the runtime tried the turn again in the browser"
        );
    }

    // As the runtime ends each turn (`agent::complete_job`).
    let summary = ended.summary.clone();
    move_findings_into_details(&job, &mut ended);
    let notes: Vec<&runtime_agent::jobs::JobMessage> = ended
        .final_messages
        .iter()
        .filter(|message| {
            message
                .metadata
                .as_ref()
                .is_some_and(|metadata| metadata.get("browserFindings").is_some())
        })
        .collect();
    match device {
        Device::Reads | Device::ReadsOnRetry => {
            let line = format!("{{\"url\":\"{DEVICE_PAGE}\"}}");
            assert_eq!(summary, format!("{PROMISED_BUILD}\n\n{line}"));
            assert_eq!(ended.summary, "", "no reply bubble");
            assert_eq!(notes.len(), 1, "{:?}", ended.final_messages);
            assert_eq!(notes[0].content, format!("{PROMISED_BUILD}\n\n{line}"));
            assert_eq!(
                notes[0].metadata.as_ref().unwrap()["browserFindings"],
                json!({ "pages": 1, "pagesRead": 1 })
            );
        }
        Device::Pauses | Device::MeetsASecret => {
            let words = if device == Device::Pauses {
                assert_eq!(calls, ["navigate", "request_human_input"]);
                PAUSE_WORDS
            } else {
                SECRET_WORDS
            };
            assert_eq!(summary, words, "its reply is left as it wrote it");
            assert_eq!(ended.summary, words, "the person reads it");
            assert!(notes.is_empty(), "{:?}", ended.final_messages);
        }
    }

    if device == Device::Reads {
        // A routed turn that hands nothing back is offered the build request. Its own, asked for
        // after it opened a page, is one nothing acts on: its reply says so, and it gets no pass.
        let before = state.requests.lock().unwrap().len();
        let routed = browser_job(project_id, "desktop-personal", false);
        let mut answered = tokio::time::timeout(
            Duration::from_secs(90),
            processor.run_apply_job(
                &registration_for_live(Uuid::new_v4()),
                &routed,
                true,
                None,
                None,
                None,
            ),
        )
        .await
        .context("the routed browser turn timed out")?
        .context("the routed browser turn failed")?;
        let offered = state.requests.lock().unwrap()[before..].to_vec();
        assert!(!offered.is_empty());
        for request in &offered {
            assert!(
                input_text(request).contains(BUILD_REQUEST_OFFER),
                "{request}"
            );
        }
        assert!(
            passes(state).is_empty(),
            "no pass for a turn that hands nothing back"
        );
        let said = format!("{PROMISED_BUILD}\n\n{NOT_MADE}");
        assert_eq!(answered.summary, said);
        move_findings_into_details(&routed, &mut answered);
        assert_eq!(answered.summary, said, "the person reads it");
    }

    drop(browser_guard);
    browser_task.await??;
    Ok(())
}
