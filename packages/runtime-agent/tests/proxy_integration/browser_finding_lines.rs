//! A browser turn whose findings go back to the building turn, that read pages and ended with no
//! finding lines, through the real proxy with an inert, localhost provider. A comparison's
//! browser turn read seven pages and answered with a summary, a build request and no finding
//! lines; Studio and the controller hand back only on a note of finding lines that names a page
//! read, so nothing was built, twice, while its reply said "I'm passing the findings to the
//! comparison-page build." (a local test, Nov 3). The runtime's wrap-up pass asks the turn, on its
//! own thread, for those lines only; with still none, the turn's note holds its reply and the
//! pages its own steps opened. Either way the hand-back goes and the turn posts no words of its
//! own. A build request that nothing acts on is said in the reply, never dropped without a word.
//!
//! The provider stands in for the model: the browser turn's answer is the comparison's, and the
//! wrap-up pass answers with lines, or with none. No browser runs here: what the turn's steps
//! opened is given as the run reports it (`CodexRunOutput::browser_pages`).

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

#[test]
fn a_hand_back_turn_with_no_finding_lines_gets_them_from_the_wrap_up_pass_via_proxy() -> Result<()>
{
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_finding_lines::a_hand_back_turn_with_no_finding_lines_gets_them_from_the_wrap_up_pass_via_proxy",
            "browser-finding-lines",
        );
    }
    run_on_a_large_stack(Pass::WritesLines)
}

#[test]
fn a_hand_back_turn_whose_wrap_up_pass_writes_none_hands_back_its_pages_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "browser_finding_lines::a_hand_back_turn_whose_wrap_up_pass_writes_none_hands_back_its_pages_via_proxy",
            "browser-finding-lines-none",
        );
    }
    run_on_a_large_stack(Pass::WritesNone)
}

/// What the provider's wrap-up pass answers.
#[derive(Clone, Copy, PartialEq)]
enum Pass {
    WritesLines,
    WritesNone,
}

fn run_on_a_large_stack(pass: Pass) -> Result<()> {
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
                .block_on(run_case(pass))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("browser finding lines fixture panicked"))?
}

struct Provider {
    pass: Pass,
    requests: StdMutex<Vec<Value>>,
}

fn final_answer(summary: &str, actions: Value) -> axum::response::Response {
    let text = json!({ "summary": summary, "code": "", "actions": actions, "files": [] }).to_string();
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
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find(|item| item["role"] == "user")
        .and_then(|item| item["content"].as_array())
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
    if last_user_text(&body).contains(PASS_OPENING) {
        return match state.pass {
            Pass::WritesLines => {
                final_answer(&format!("{READ_13}\n{READ_REVIEW}"), json!([]))
            }
            Pass::WritesNone => final_answer("I read the maker's pages and two reviews.", json!([])),
        };
    }
    // The browser turn: the comparison's answer, a build request and no finding line.
    final_answer(
        PROMISED_BUILD,
        json!([{ "type": "request_build", "continueBuilding": true, "task": "Build the comparison page." }]),
    )
}

/// A browser turn's job as the controller leases it: it carries on a card the routing step
/// posted for the person's own message, and its findings go back to the building turn when
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

async fn run_case(pass: Pass) -> Result<()> {
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
        pass,
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

    let client = CodexClient::new(CodexConfig {
        workspace_dir: workspace.clone(),
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
    let job = browser_job(project_id, true);
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
    let passes: Vec<&Value> = requests
        .iter()
        .filter(|request| last_user_text(request).contains(PASS_OPENING))
        .collect();
    assert_eq!(passes.len(), 1, "one wrap-up pass");
    let pass_request = passes[0];
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
    assert_eq!(turn_request["reasoning"]["effort"], "medium", "{turn_request}");
    // No tool is required first: the lines are its answer.
    assert_ne!(pass_request["tool_choice"], "required", "{pass_request}");
    // Its run log follows the turn's, so the turn is billed from its first run only.
    assert!(
        artifacts.iter().any(|artifact| artifact["kind"] == "codex/run-log"
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
    assert_eq!(phases, ["finalization"], "{receipt}");

    let lines = match pass {
        Pass::WritesLines => format!("{READ_13}\n{READ_REVIEW}"),
        // With still none, the pages the turn's own steps opened.
        Pass::WritesNone => format!(
            "{{\"url\":\"{}\"}}\n{{\"url\":\"{}\"}}",
            OPENED[0], OPENED[1]
        ),
    };
    assert_eq!(summary, format!("{PROMISED_BUILD}\n\n{lines}"));
    assert!(!summary.contains(NOT_MADE), "a hand-back follows: {summary}");

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

    // A routed turn that hands nothing back gets no pass, and its build request, which nothing
    // acts on after it opened pages, is said in its reply.
    let routed = browser_job(project_id, false);
    let mut summary = PROMISED_BUILD.to_string();
    let artifacts = end_browser_turn_answer(
        &client,
        &routed,
        BrowserTurnAnswer {
            options: &options,
            thread: Some(thread),
            used_the_browser: true,
            pages,
            final_json: &turn.final_json,
        },
        &mut summary,
        &TaskUsage::default(),
    )
    .await;
    assert!(artifacts.is_empty(), "{artifacts:?}");
    assert_eq!(summary, format!("{PROMISED_BUILD}\n\n{NOT_MADE}"));
    assert_eq!(
        state
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| last_user_text(request).contains(PASS_OPENING))
            .count(),
        1,
        "no pass for a turn that hands nothing back"
    );

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}
