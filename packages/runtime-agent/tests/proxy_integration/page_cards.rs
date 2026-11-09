//! A page a building turn made by hand gets its card before the reply, through the real proxy with
//! an inert, localhost provider. In a local test (Nov 9) a new chat's fill-in wrote
//! `sites/framework-13-vs-16/index.html` by hand and posted no card, and the next turn filled that
//! page from the maker's pages: nobody could open it, and the row under each reply named the
//! folder. The runtime now takes the card's step for such a page at the turn's end, once its
//! change is saved: the binder's card step (`instafy bind card <folder> --json`), the step a check
//! that passes takes, with the turn's own credential, so the card goes to the turn's chat (which
//! names the turn's files by its title) and the space's record of its pages holds the page for
//! this chat. Here a stand-in `instafy` notes that step and writes the record's row as the CLI
//! does; the binder's own test covers the step's title and command, and the CLI's covers the row.
//!
//! A page whose card is in the chat, another chat's page, a page that was there before the turn
//! (which the space's record may not know: its card opened before the record began, or another
//! chat's page whose card was never posted), a turn stopped once its change was saved and a turn
//! that only answers get no card, and a card that could not be posted leaves the reply as the
//! turn wrote it. A page the recovery pass made, after a first pass that changed nothing, gets
//! its card as well: that pass ends the turn.

use super::*;
use axum::routing::get;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_contracts::AccessTokenClaims;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_PAGE_CARDS_TEST_CHILD";
const TEST_NAME: &str =
    "page_cards::a_page_a_turn_made_by_hand_gets_its_card_before_the_reply_via_proxy";
const PROVIDER_KEY: &str = "inert-page-cards-provider-key";
const KEY_ID: &str = "page-cards";
/// The turns, what each one's model writes, and its reply.
const MADE: &str =
    "Make a simple comparison page of the Framework Laptop 13 and 16 from what you already know.";
const NEW_PAGE: &str = "sites/framework-13-vs-16";
const NEW_TITLE: &str = "Framework Laptop 13 vs 16";
const MADE_REPLY: &str = "I made a simple comparison of the Framework Laptop 13 and 16.";
const EARLIER: &str = "Add the ferry times to the old day-trip page.";
const EARLIER_PAGE: &str = "sites/day-trip";
const EARLIER_TITLE: &str = "A day in Aveiro";
const EARLIER_REPLY: &str = "I added the ferry times.";
const MINE: &str = "Add the opening hours to the Porto page.";
const MINE_PAGE: &str = "sites/porto";
const MINE_REPLY: &str = "I added the opening hours.";
const THEIRS: &str = "Put the weights on the laptop comparison.";
const THEIR_PAGE: &str = "sites/laptops";
const THEIRS_REPLY: &str = "I put the weights on it.";
const STOPPED: &str = "Make a packing list page.";
const STOPPED_PAGE: &str = "sites/packing";
const STOPPED_REPLY: &str = "I made a packing list.";
const QUESTION: &str = "Which of the two is lighter?";
const QUESTION_REPLY: &str = "The Laptop 13 is lighter.";
const FAILS: &str = "Make a page of the Porto bookshops.";
const FAILS_PAGE: &str = "sites/bookshops";
const FAILS_REPLY: &str = "I made a page of the Porto bookshops.";
const RETRIED: &str = "Make a page of the Porto viewpoints.";
const RETRIED_PAGE: &str = "sites/viewpoints";
const RETRIED_TITLE: &str = "Porto viewpoints";
const RETRIED_REPLY: &str = "I made a page of the Porto viewpoints.";
/// The recovery pass's own words, after a first pass that changed none of a required change's
/// files (as after any first pass it follows).
const RECOVERY_PASS: &str = "Retry the latest user request now.";

#[test]
fn a_page_a_turn_made_by_hand_gets_its_card_before_the_reply_via_proxy() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, TEST_NAME, "page-cards");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("page-cards-proxy".to_string())
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
        .map_err(|_| anyhow::anyhow!("page cards fixture panicked"))?
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

/// A required change's answer, in the final form such a turn asks for.
fn final_json(text: &str) -> Value {
    message(&json!({ "summary": text, "code": "", "files": [], "actions": [] }).to_string())
}

/// A page written by hand, in one command: no binder, no check, no card.
fn write_page(folder: &str, title: &str) -> Value {
    json!({
        "id":"tool_write","type":"function_call","name":"exec_command",
        "call_id":"call_write","status":"completed",
        "arguments":json!({
            "cmd":format!(
                "mkdir -p {folder} && printf '%s\\n' '<!doctype html><title>{title}</title><h1>{title}</h1>' > {folder}/index.html"
            ),
            "max_output_tokens":64
        }).to_string()
    })
}

/// What a turn asks last, and whether it ran its command yet.
async fn provider_request(Json(body): Json<Value>) -> axum::response::Response {
    let input = body["input"].as_array().cloned().unwrap_or_default();
    let start = input
        .iter()
        .rposition(|item| item["role"] == "user")
        .unwrap_or(0);
    let asked: String = input
        .get(start)
        .and_then(|item| item["content"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|part| part["text"].as_str().map(str::to_string))
        .collect();
    let asks = |words: &str| asked.contains(&format!("\n\nLatest user request:\n{words}"));
    let ran = input[start..]
        .iter()
        .any(|item| item["type"] == "function_call_output");
    // The viewpoints page is made only by the recovery pass: its first pass changes nothing.
    if asks(RETRIED) {
        return if !asked.contains(RECOVERY_PASS) || ran {
            response(final_json(RETRIED_REPLY))
        } else {
            response(write_page(RETRIED_PAGE, RETRIED_TITLE))
        };
    }
    let (page, reply) = if asks(MADE) {
        (Some((NEW_PAGE, NEW_TITLE)), MADE_REPLY)
    } else if asks(EARLIER) {
        (Some((EARLIER_PAGE, EARLIER_TITLE)), EARLIER_REPLY)
    } else if asks(MINE) {
        (Some((MINE_PAGE, "Porto bookshops")), MINE_REPLY)
    } else if asks(THEIRS) {
        (
            Some((THEIR_PAGE, "Three latest Framework laptops")),
            THEIRS_REPLY,
        )
    } else if asks(STOPPED) {
        (Some((STOPPED_PAGE, "Packing list")), STOPPED_REPLY)
    } else if asks(FAILS) {
        (Some((FAILS_PAGE, "Porto bookshops")), FAILS_REPLY)
    } else {
        (None, QUESTION_REPLY)
    };
    match page {
        Some((folder, title)) if !ran => response(write_page(folder, title)),
        _ => response(message(reply)),
    }
}

struct Controller {
    jwks: Value,
    origin: String,
    /// A Stop that reaches the controller once the turn's change is saved, before the job's
    /// heartbeat hears of it: from the save's last step on, the controller says the job's lease is
    /// gone.
    stop_after_the_save: StdMutex<Option<Arc<AtomicBool>>>,
}

async fn jwks(State(state): State<Arc<Controller>>) -> Json<Value> {
    Json(state.jwks.clone())
}

async fn lease_acquire() -> Json<Value> {
    Json(json!({ "leaseId": Uuid::new_v4() }))
}

/// The save's last step: the workspace lease goes back once the change is applied and saved.
async fn lease_release(State(state): State<Arc<Controller>>) -> Json<Value> {
    if let Some(stopped) = state.stop_after_the_save.lock().unwrap().take() {
        stopped.store(true, Ordering::SeqCst);
    }
    Json(json!({}))
}

async fn access_token(State(state): State<Arc<Controller>>) -> Json<Value> {
    Json(json!({
        "originId": Uuid::new_v4(),
        "endpoint": state.origin,
        "mode": "hosted",
        "token": "origin-token",
    }))
}

async fn origin_apply() -> Json<Value> {
    Json(json!({ "rev": "applied", "baseRev": "base" }))
}

async fn origin_git_sync() -> Json<Value> {
    Json(json!({ "rev": "gitrev", "baseRev": "gitbase" }))
}

/// Serves `app` on a loopback port of its own until the guard is dropped.
async fn serve(app: Router) -> Result<(String, ChildGuard, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let url = format!("http://{}", listener.local_addr()?);
    let (shutdown, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("serve a stand-in");
    });
    Ok((url, ChildGuard::new(shutdown), task))
}

/// The space's record of its pages, with a row for each (folder, title, chat).
fn record_pages(workspace: &Path, pages: &[(&str, &str, Uuid)]) -> Result<()> {
    let rows: Vec<Value> = pages
        .iter()
        .map(|(folder, title, chat)| {
            json!({
                "folder": folder, "title": title, "conversationId": chat.to_string(),
                "server": ["instafy", "bind"], "openedAt": "2026-11-09T00:30:00.000Z",
            })
        })
        .collect();
    fs::write(
        workspace.join(".instafy/pages/pages.json"),
        json!({ "version": 1, "pages": rows }).to_string(),
    )?;
    Ok(())
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    // This chat's page and another chat's, both with their cards, and a page from before the
    // space's record of its pages.
    for (folder, title) in [
        (MINE_PAGE, "Porto bookshops"),
        (THEIR_PAGE, "Three latest Framework laptops"),
        (EARLIER_PAGE, EARLIER_TITLE),
    ] {
        fs::create_dir_all(workspace.join(folder))?;
        fs::write(
            workspace.join(folder).join("index.html"),
            format!("<!doctype html><title>{title}</title>\n"),
        )?;
    }
    git_in(&workspace, &["init", "-q", "-b", "main"])?;
    git_in(&workspace, &["add", "sites"])?;
    git_in(
        &workspace,
        &[
            "-c",
            "user.name=Instafy Test",
            "-c",
            "user.email=test@instafy.invalid",
            "commit",
            "-q",
            "-m",
            "main",
        ],
    )?;
    // The record's folder is saved by nothing, as the CLI keeps it.
    fs::create_dir_all(workspace.join(".instafy/pages"))?;
    fs::write(workspace.join(".instafy/pages/.gitignore"), "*\n")?;

    // A stand-in `instafy`: it notes the card step, where it ran and with which credentials and
    // settings, and as the CLI does for a card it posts, writes the page in the space's record
    // for the chat it was given; the bookshops page's card can't be posted.
    let home = PathBuf::from(std::env::var("HOME")?);
    let seen = home.join("seen");
    let bin = home.join("bin");
    fs::create_dir_all(&bin)?;
    fs::write(
        bin.join("instafy"),
        format!(
            r#"#!/bin/sh
seen='{seen}'
echo "ran $* | cwd=$(pwd -P) | job=${{CONTROLLER_ACCESS_TOKEN:-}} | chat=${{INSTAFY_CONVERSATION_ID:-}} | space=${{SPACE_ID:-}} | controller=${{CONTROLLER_BASE_URL:-}} | model=${{CODEX_API_KEY:-}}${{OPENAI_API_KEY:-}} | secret=${{BOOKING_PARTNER:-}}" >> "$seen"
if [ "$1 $2" != "bind card" ]; then exit 0; fi
folder=${{3#./}}
if [ "$folder" = '{fails}' ]; then
  echo '{{"posted":false,"title":"Porto bookshops","error":"the preview could not start"}}'
  exit 1
fi
title=$(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' "$folder/index.html" | head -n 1)
printf '{{"version":1,"pages":[{{"folder":"%s","title":"%s","conversationId":"%s","server":["instafy","bind"],"openedAt":"2026-11-09T00:43:40.000Z"}}]}}\n' "$folder" "$title" "$INSTAFY_CONVERSATION_ID" > .instafy/pages/pages.json
printf '{{"posted":true,"title":"%s","command":"instafy preview open","answer":{{"status":"live"}}}}\n' "$title"
"#,
            seen = seen.display(),
            fails = FAILS_PAGE,
        ),
    )?;
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(bin.join("instafy"), fs::Permissions::from_mode(0o755))?;
    }

    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-page-cards-runtime-key"}).to_string(),
    )?;
    let mut settings = vec![EnvGuard::set(
        "PATH",
        format!("{}:{}", bin.display(), std::env::var("PATH")?),
    )];
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-page-cards-runtime-key"),
        ("CODEX_API_KEY", "inert-page-cards-runtime-key"),
        ("CODEX_MODEL", "gpt-5.5"),
        ("CODEX_MODEL_PROVIDER", "openai"),
        ("CODEX_DISABLED", "false"),
        ("CODEX_SANDBOX_MODE", "workspace-write"),
        ("CODEX_ENABLE_WEB_SEARCH", "false"),
        ("CODEX_RUNTIME_REASONING_EFFORT", "low"),
        ("CODEX_RUN_TIMEOUT_SECONDS", "45"),
        // a secret the space granted its turns: the card's step never gets it
        ("BOOKING_PARTNER", "granted-secret"),
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

    let (upstream, stub_guard, stub_task) =
        serve(Router::new().route("/backend-api/codex/responses", post(provider_request))).await?;
    let (origin, origin_guard, origin_task) = serve(
        Router::new()
            .route("/apply", post(origin_apply))
            .route("/git/sync", post(origin_git_sync)),
    )
    .await?;

    // The controller signs each turn's own token and its workspace token, and lends the save its
    // lease and the origin's address.
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| anyhow::anyhow!("generate a signing key"))?;
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| anyhow::anyhow!("read the signing key"))?;
    let controller = Arc::new(Controller {
        jwks: json!({ "keys": [{
            "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
            "kid": KEY_ID, "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        }] }),
        origin,
        stop_after_the_save: StdMutex::new(None),
    });
    let (controller_url, controller_guard, controller_task) = serve(
        Router::new()
            .route("/.well-known/jwks.json", get(jwks))
            .route("/lease/acquire", post(lease_acquire))
            .route("/lease/release", post(lease_release))
            .route("/access_token", post(access_token))
            .with_state(controller.clone()),
    )
    .await?;
    let controller_url = Url::parse(&controller_url)?;

    let port = reserve_port()?;
    let proxy_address = SocketAddr::from(([127, 0, 0, 1], port));
    let credentials = auth::Credentials::ApiKey {
        key: PROVIDER_KEY.to_string(),
        endpoint: Some(format!("{upstream}/backend-api/codex/responses")),
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
    // The runtime's own setting, which a turn's commands read too (the proxy reads it as well, so
    // it is set once the proxy runs).
    settings.push(EnvGuard::set(
        "CONTROLLER_BASE_URL",
        controller_url.as_str().trim_end_matches('/'),
    ));

    let processor = JobProcessor::new(Arc::new(Config {
        controller_base_url: controller_url.clone(),
        controller_jwks_url: controller_url.join("/.well-known/jwks.json")?,
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
    let sign = |run_id: Uuid, scopes: &[&str]| -> Result<String> {
        let issued_at = chrono::Utc::now().timestamp();
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(KEY_ID.to_string());
        Ok(jsonwebtoken::encode(
            &header,
            &AccessTokenClaims {
                aud: registration.runtime_id.to_string(),
                sub: "job:page-cards".to_string(),
                project_id: project_id.to_string(),
                origin_id: None,
                runtime_id: Some(registration.runtime_id.to_string()),
                protocol: None,
                scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
                lease_id: None,
                runtime_generation: None,
                run_id: Some(run_id.to_string()),
                iat: issued_at,
                exp: issued_at + 300,
                jti: Uuid::new_v4().to_string(),
                prefer_runtime: None,
                actor_label: None,
                browser_session_id: None,
            },
            &EncodingKey::from_ed_der(pkcs8.as_ref()),
        )?)
    };
    let chat = Uuid::new_v4();
    let another_chat = Uuid::new_v4();
    // One turn of the chat: its job, with its own token and its save's.
    let turn_requiring = |prompt: &str, requirement: &str| -> Result<(LeaseJob, String)> {
        let run_id = Uuid::new_v4();
        let token = sign(run_id, &["prompt.execute"])?;
        let job = LeaseJob {
            id: Uuid::new_v4(),
            intent: Some("feature".to_string()),
            project_id: Some(project_id),
            run_id: Some(run_id),
            conversation_id: Some(chat),
            session_id: None,
            credential_id: None,
            payload: json!({
                "prompt_text": prompt,
                "metadata": {"execution_mode":"apply","agentRoutingPreflight":{"workspaceFileChangeRequirement":requirement}},
            }),
            proxy: None,
            controller_token: Some(token.clone()),
            controller_token_scopes: Some(vec!["prompt.execute".to_string()]),
            controller_token_expires_at: None,
            workspace_token: Some(sign(
                run_id,
                &["workspace.lease.write", "origin.token.mint"],
            )?),
            workspace_token_scopes: Some(vec![
                "workspace.lease.write".to_string(),
                "origin.token.mint".to_string(),
            ]),
            workspace_token_expires_at: None,
            lease_attempts: 1,
            grants: Vec::new(),
            grant_token: None,
        };
        Ok((job, token))
    };
    let turn = |prompt: &str| turn_requiring(prompt, "conditional");
    let run = |job: LeaseJob, cancel: Option<JobCancelSignal>| {
        let processor = &processor;
        let registration = &registration;
        async move {
            tokio::time::timeout(
                Duration::from_secs(90),
                processor.run_apply_job(registration, &job, true, None, cancel, None),
            )
            .await
            .context("the turn timed out")?
        }
    };
    let ran = || -> Vec<String> {
        fs::read_to_string(&seen)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    };
    let workspace_real = workspace.canonicalize()?;
    let card_step = |folder: &str, token: &str| {
        format!(
            "ran bind card ./{folder} --json | cwd={} | job={token} | chat={chat} | space={project_id} | controller={} | model= | secret=",
            workspace_real.display(),
            controller_url.as_str().trim_end_matches('/'),
        )
    };
    let record = || -> Result<Value> {
        Ok(serde_json::from_str(&fs::read_to_string(
            workspace.join(".instafy/pages/pages.json"),
        )?)?)
    };

    // A page written by hand, with no card: the turn's card step, once, from the workspace, with
    // the turn's own token, chat and space, and none of the model's keys or the space's secrets.
    // It ran before the turn's reply, which is the turn's own.
    let (job, token) = turn(MADE)?;
    let made = run(job, None).await.context("the page's turn failed")?;
    assert_eq!(made.summary, MADE_REPLY);
    assert_eq!(ran(), vec![card_step(NEW_PAGE, &token)]);
    // The space's record holds the page for this chat, by its title: the next turn of any chat
    // reads it as this chat's page, and it gets no second card.
    let row = &record()?["pages"][0];
    assert_eq!(
        (&row["folder"], &row["title"], &row["conversationId"]),
        (
            &json!(NEW_PAGE),
            &json!(NEW_TITLE),
            &json!(chat.to_string())
        ),
        "{row}"
    );
    for message in made.messages.iter().chain(&made.final_messages) {
        let words = message.content.to_ascii_lowercase();
        assert!(
            !words.contains("card") && !words.contains("preview"),
            "{}",
            message.content
        );
    }

    // A page that was there before the turn, with no row in the record: its card may be in a chat
    // already, opened before the record began, or it may be another chat's page whose card was
    // never posted. A turn that changes it doesn't card it, nor take it for its chat.
    let (job, _) = turn(EARLIER)?;
    let earlier = run(job, None)
        .await
        .context("the turn that changed an earlier page failed")?;
    assert_eq!(earlier.summary, EARLIER_REPLY);
    assert_eq!(
        fs::read_to_string(workspace.join(EARLIER_PAGE).join("index.html"))?,
        format!("<!doctype html><title>{EARLIER_TITLE}</title><h1>{EARLIER_TITLE}</h1>\n")
    );
    assert_eq!(ran().len(), 1, "{:#?}", ran());
    let rows = record()?;
    let folders: Vec<&Value> = rows["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| &row["folder"])
        .collect();
    assert_eq!(folders, vec![&json!(NEW_PAGE)], "{rows}");

    // This chat's page, whose card is in the chat, and another chat's page: no card.
    record_pages(
        &workspace,
        &[
            (NEW_PAGE, NEW_TITLE, chat),
            (MINE_PAGE, "Porto bookshops", chat),
            (THEIR_PAGE, "Three latest Framework laptops", another_chat),
        ],
    )?;
    for (prompt, reply) in [(MINE, MINE_REPLY), (THEIRS, THEIRS_REPLY)] {
        let (job, _) = turn(prompt)?;
        let done = run(job, None)
            .await
            .with_context(|| format!("the turn \"{prompt}\" failed"))?;
        assert_eq!(done.summary, reply);
    }
    assert_eq!(ran().len(), 1, "{:#?}", ran());

    // A Stop that reaches the controller once the turn's change is saved, before the job's
    // heartbeat hears of it: the turn asks the controller, and posts no card.
    let (job, _) = turn(STOPPED)?;
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = JobCancelSignal::new();
    let lease_gone = stopped.clone();
    stop.check_lease_with(Arc::new(move || {
        let lease_gone = lease_gone.clone();
        Box::pin(async move { !lease_gone.load(Ordering::SeqCst) })
    }));
    *controller.stop_after_the_save.lock().unwrap() = Some(stopped.clone());
    let _ = run(job, Some(stop.clone())).await;
    assert!(
        stopped.load(Ordering::SeqCst),
        "the Stop came with the save"
    );
    assert!(workspace.join(STOPPED_PAGE).join("index.html").is_file());
    assert_eq!(ran().len(), 1, "{:#?}", ran());
    assert!(stop.is_canceled(), "the turn heard of the Stop");

    // A turn that only answers: no card.
    let (job, _) = turn(QUESTION)?;
    let answered = run(job, None).await.context("the question's turn failed")?;
    assert_eq!(answered.summary, QUESTION_REPLY);
    assert_eq!(ran().len(), 1, "{:#?}", ran());

    // A card that can't be posted: the step ran, and the reply is the turn's own, with nothing of
    // the card in it.
    let (job, token) = turn(FAILS)?;
    let failed = run(job, None).await.context("the bookshops turn failed")?;
    assert_eq!(failed.summary, FAILS_REPLY);
    assert_eq!(ran().last(), Some(&card_step(FAILS_PAGE, &token)));
    assert_eq!(ran().len(), 2, "{:#?}", ran());
    for message in failed.messages.iter().chain(&failed.final_messages) {
        let words = message.content.to_ascii_lowercase();
        assert!(
            !words.contains("card")
                && !words.contains("preview")
                && !words.contains("could not start"),
            "{}",
            message.content
        );
    }

    // A required change whose first pass changed nothing, and whose recovery pass made the page:
    // the card step runs at the end of that pass, before its reply.
    let (job, token) = turn_requiring(RETRIED, "required")?;
    let retried = run(job, None).await.context("the viewpoints turn failed")?;
    assert_eq!(retried.summary, RETRIED_REPLY);
    assert!(
        workspace.join(RETRIED_PAGE).join("index.html").is_file(),
        "the recovery pass made the page"
    );
    assert_eq!(ran().last(), Some(&card_step(RETRIED_PAGE, &token)));
    assert_eq!(ran().len(), 3, "{:#?}", ran());
    let row = &record()?["pages"][0];
    assert_eq!(
        (&row["folder"], &row["title"], &row["conversationId"]),
        (
            &json!(RETRIED_PAGE),
            &json!(RETRIED_TITLE),
            &json!(chat.to_string())
        ),
        "{row}"
    );

    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    drop(origin_guard);
    drop(controller_guard);
    proxy_task.await??;
    stub_task.await?;
    origin_task.await?;
    controller_task.await?;
    Ok(())
}
