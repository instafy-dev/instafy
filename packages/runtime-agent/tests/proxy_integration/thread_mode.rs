//! A building thread keeps one mode, so each of its requests begins as its first did and is
//! served from the provider's cache: a chat from a recorded local test (Nov 6), replayed through
//! the real proxy with an inert, localhost provider. A map, whose turn changed no file it was
//! asked to (`strict_structured`), then a note on it, a change (`plain_text_write`). In the
//! recorded chat the note resumed the map's thread, replaced its base instructions mid-thread,
//! and its first request, 52.5k tokens, was sent again uncached. The note starts a new thread
//! now, from the chat's replay, which holds the map's request and reply, and the next change
//! resumes the note's thread with no instructions replaced.
//!
//! A note that fails after it left the map's thread saves no thread. Its job reports the state it
//! ran on, so a question after it, of the map's mode, starts a new thread from the replay, which
//! holds the failed note, rather than resume the map's thread, which never saw it.

use super::*;
use runtime_agent::jobs::{JobExecution, failed_job_proxy_metadata};
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_THREAD_MODE_TEST_CHILD";
const PROVIDER_KEY: &str = "inert-thread-mode-provider-key";
const MAP: &str = "Make me a map for 3 days in Seville.";
const MAPPED: &str = "I made a 3-day map of Seville.";
const NOTE: &str = "Add a note under day 1: book the palace ahead.";
const NOTED: &str = "Added the note under day 1.";
const TITLE: &str = "Make the title bigger.";
const TITLED: &str = "Made the title bigger.";
const QUESTION: &str = "Which day has the palace?";
const ANSWERED: &str = "Day 1 has the palace.";
/// What the provider answers the note with when it fails.
const REFUSED: &str = "The note's request was refused upstream.";
const SITE: &str = "sites/seville/app.js";
/// What a request carries when a run replaces its thread's base instructions.
const REPLACED: &str = "replace the previous base instructions";

#[test]
fn a_building_thread_keeps_one_mode_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "thread_mode::a_building_thread_keeps_one_mode_via_proxy",
            "thread-mode",
        );
    }
    on_a_large_stack(false)
}

#[test]
fn a_failed_turn_leaves_the_thread_it_left_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(
            CHILD,
            "thread_mode::a_failed_turn_leaves_the_thread_it_left_via_proxy",
            "thread-mode-failed",
        );
    }
    on_a_large_stack(true)
}

fn on_a_large_stack(note_fails: bool) -> Result<()> {
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("thread-mode-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_case(note_fails))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("thread-mode fixture panicked"))?
}

struct Provider {
    requests: StdMutex<Vec<Value>>,
    /// The provider refuses the note's requests.
    note_fails: bool,
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

/// The texts of a request's input item.
fn item_text(item: &Value) -> String {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect()
}

/// The text of the last user message of a request: the turn's prompt.
fn last_user_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .and_then(|input| input.iter().rev().find(|item| item["role"] == "user"))
        .map(item_text)
        .unwrap_or_default()
}

/// Every text a request sends: its thread's earlier turns, then this one.
fn input_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .into_iter()
        .flatten()
        .map(item_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a request begins with: the base instructions of its thread.
fn first_item(request: &Value) -> Value {
    request["input"][0].clone()
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

async fn provider_request(
    State(state): State<Arc<Provider>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    state.requests.lock().unwrap().push(body.clone());
    if state.note_fails && asks(&body, NOTE) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {
                "message": REFUSED, "type": "invalid_request_error", "param": null, "code": null,
            }})),
        )
            .into_response();
    }
    let (write, reply) = if asks(&body, MAP) {
        (
            format!("mkdir -p sites/seville && printf 'day 1\\n' > {SITE}"),
            MAPPED,
        )
    } else if asks(&body, NOTE) {
        (format!("printf 'note: book ahead\\n' >> {SITE}"), NOTED)
    } else if asks(&body, QUESTION) {
        (format!("cat {SITE}"), ANSWERED)
    } else {
        (format!("printf 'title: large\\n' >> {SITE}"), TITLED)
    };
    match commands_run(&body) {
        0 => response(command("write", &write)),
        // The map's turn and the question answer in the turn's final JSON; a change, in words.
        _ if asks(&body, MAP) || asks(&body, QUESTION) => response(message(
            &json!({"summary": reply, "code": "", "suggestions": [], "files": [], "actions": []})
                .to_string(),
        )),
        _ => response(message(reply)),
    }
}

fn person(words: &str, run: &str) -> Value {
    json!({"role": "user", "content": words, "runId": run})
}

fn reply(words: &str, run: &str) -> Value {
    json!({"role": "assistant", "content": words, "runId": run, "metadata": {"jobId": format!("job-{run}")}})
}

/// A turn the routing step sent straight to the building thread, with how much it changes. A map
/// the person asks for is files, but the routing step may say it changes none, as it did in the
/// recorded chat: its turn then runs in `strict_structured`. A turn that may change files runs in
/// `plain_text_write`. This test's folder is no repository, where a turn can't count its
/// changes, so none is required.
fn direct(change: &str) -> Value {
    json!({"execution_mode":"apply","agentRoutingPreflight":{"workspaceFileChangeRequirement":change}})
}

fn job(
    project_id: Uuid,
    conversation_id: Uuid,
    prompt: &str,
    metadata: Value,
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
            "metadata": metadata,
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

async fn run_case(note_fails: bool) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(&workspace)?;
    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-thread-mode-runtime-key"}).to_string(),
    )?;
    let mut settings = vec![EnvGuard::remove("CODEX_BASE_INSTRUCTIONS")];
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-thread-mode-runtime-key"),
        ("CODEX_API_KEY", "inert-thread-mode-runtime-key"),
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
        note_fails,
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
    let conversation_id = Uuid::new_v4();
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

    // The map: the chat's first turn, which the routing step said changes nothing.
    let mut chat = vec![person(MAP, "run-1")];
    let map = run(job(
        project_id,
        conversation_id,
        MAP,
        direct("none"),
        chat.clone(),
        None,
    ))
    .await
    .context("the map's turn failed")?;
    assert_eq!(map.summary, MAPPED);
    let map_thread = map
        .provider_conversation_state
        .context("the map's building thread")?;

    chat.push(reply(MAPPED, "run-1"));
    chat.push(person(NOTE, "run-2"));
    if note_fails {
        a_question_after_a_failed_note(
            &run,
            &state,
            job_for(project_id, conversation_id),
            chat,
            map_thread,
        )
        .await?;
    } else {
        a_note_then_a_change(
            &run,
            &state,
            job_for(project_id, conversation_id),
            chat,
            map_thread,
        )
        .await?;
    }

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    proxy_task.await??;
    stub_task.await??;
    Ok(())
}

/// A job of this chat: its prompt, routing, history and saved state.
fn job_for(
    project_id: Uuid,
    conversation_id: Uuid,
) -> impl Fn(&str, Value, Vec<Value>, Option<Value>) -> LeaseJob {
    move |prompt, metadata, history, thread| {
        job(
            project_id,
            conversation_id,
            prompt,
            metadata,
            history,
            thread,
        )
    }
}

/// The note fails after it left the map's thread; the question after it is of the map's mode.
async fn a_question_after_a_failed_note<R, F>(
    run: &R,
    state: &Provider,
    job: impl Fn(&str, Value, Vec<Value>, Option<Value>) -> LeaseJob,
    mut chat: Vec<Value>,
    map_thread: Value,
) -> Result<()>
where
    R: Fn(LeaseJob) -> F,
    F: std::future::Future<Output = Result<JobExecution>>,
{
    let failed = run(job(
        NOTE,
        direct("conditional"),
        chat.clone(),
        Some(map_thread.clone()),
    ))
    .await
    .expect_err("the note's turn fails");
    // The controller hands the next turn the newest state a job reported: the failed note's
    // when it reported one, the map's otherwise.
    let reported = failed_job_proxy_metadata(&failed);
    let next_state = reported
        .as_ref()
        .map(|metadata| metadata["conversation"].clone())
        .unwrap_or_else(|| map_thread.clone());
    chat.push(json!({
        "role": "assistant", "content": REFUSED, "runId": "run-2",
        "metadata": {"jobId": "job-run-2", "source": "agent", "outcome": "failed", "messageType": "error"},
    }));
    chat.push(person(QUESTION, "run-3"));
    let answered = run(job(
        QUESTION,
        direct("none"),
        chat.clone(),
        Some(next_state),
    ))
    .await
    .context("the question's turn failed")?;
    assert_eq!(answered.summary, ANSWERED);
    let question_thread = answered
        .provider_conversation_state
        .context("the question's building thread")?;
    // A new thread, from the replay, not the map's, which never saw the note.
    assert_ne!(
        question_thread["defaultThreadId"], map_thread["defaultThreadId"],
        "the note reported {reported:?}"
    );
    assert_eq!(question_thread["defaultThreadRestoreSource"], "new");
    assert_eq!(question_thread["defaultThreadMode"], "structured");
    let requests = state.requests.lock().unwrap().clone();
    let question = requests
        .iter()
        .find(|request| asks(request, QUESTION))
        .context("the question's request")?;
    let prompt = last_user_text(question);
    assert!(
        !prompt.contains("The provider thread was restored successfully"),
        "{prompt}"
    );
    // The replay holds the note the person asked for, and its failure.
    assert!(prompt.contains(NOTE), "{prompt}");
    assert!(prompt.contains(REFUSED), "{prompt}");
    Ok(())
}

/// The note, a change, on the map's saved state, then another change.
async fn a_note_then_a_change<R, F>(
    run: &R,
    state: &Provider,
    job: impl Fn(&str, Value, Vec<Value>, Option<Value>) -> LeaseJob,
    mut chat: Vec<Value>,
    map_thread: Value,
) -> Result<()>
where
    R: Fn(LeaseJob) -> F,
    F: std::future::Future<Output = Result<JobExecution>>,
{
    let note = run(job(
        NOTE,
        direct("conditional"),
        chat.clone(),
        Some(map_thread.clone()),
    ))
    .await
    .context("the note's turn failed")?;
    assert_eq!(note.summary, NOTED);
    let note_thread = note
        .provider_conversation_state
        .context("the note's building thread")?;
    // A new thread, not the map's.
    assert_ne!(
        note_thread["defaultThreadId"], map_thread["defaultThreadId"],
        "the note's state: {note_thread}; the map's: {map_thread}"
    );
    assert_eq!(note_thread["defaultThreadRestoreSource"], "new");

    // The next change resumes the note's thread.
    chat.push(reply(NOTED, "run-2"));
    chat.push(person(TITLE, "run-3"));
    let titled = run(job(
        TITLE,
        direct("conditional"),
        chat.clone(),
        Some(note_thread.clone()),
    ))
    .await
    .context("the title's turn failed")?;
    assert_eq!(titled.summary, TITLED);
    let title_thread = titled
        .provider_conversation_state
        .context("the title's building thread")?;
    assert_eq!(
        title_thread["defaultThreadId"],
        note_thread["defaultThreadId"]
    );
    assert_eq!(title_thread["defaultThreadRestoreSource"], "rollout");
    // Each saved state names the mode its thread runs in.
    assert_eq!(map_thread["defaultThreadMode"], "structured");
    assert_eq!(note_thread["defaultThreadMode"], "plain_text_write");
    assert_eq!(title_thread["defaultThreadMode"], "plain_text_write");

    let requests = state.requests.lock().unwrap().clone();
    let of = |words: &str| -> Vec<&Value> {
        requests
            .iter()
            .filter(|request| asks(request, words))
            .collect()
    };
    let (map_requests, note_requests, title_requests) = (of(MAP), of(NOTE), of(TITLE));
    assert_eq!(map_requests.len(), 2, "the map's write and its reply");
    assert_eq!(note_requests.len(), 2, "the note's write and its reply");
    assert_eq!(title_requests.len(), 2, "the title's write and its reply");
    // No request replaces its thread's base instructions.
    for request in &requests {
        let text = input_text(request);
        assert!(!text.contains(REPLACED), "{text}");
    }
    // The two modes begin with other base instructions: the note's thread begins with its own,
    // and so does each request the title's turn sends on it.
    assert_ne!(first_item(map_requests[0]), first_item(note_requests[0]));
    for request in note_requests.iter().chain(&title_requests) {
        assert_eq!(first_item(request), first_item(note_requests[0]));
    }
    // A new thread's replay of the chat: the map's request and its reply.
    let note_text = input_text(note_requests[0]);
    assert!(note_text.contains(MAPPED), "{note_text}");
    assert_eq!(
        last_user_text(note_requests[0]).matches(MAP).count(),
        1,
        "the replay's: {note_text}"
    );
    // The title's turn resumes it: the note's turn is in its thread.
    let title_text = input_text(title_requests[0]);
    assert!(
        title_text.contains(&format!("\n\nLatest user request:\n{NOTE}")),
        "{title_text}"
    );
    assert!(
        last_user_text(title_requests[0]).contains("The provider thread was restored successfully"),
        "{title_text}"
    );
    Ok(())
}

/// A routing step's cache key, the same for every chat: in a file of its own, run with these.
#[path = "routing_cache_key.rs"]
mod routing_cache_key;
