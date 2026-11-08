//! A building turn whose change to two open pages is saved, through the real proxy with an inert,
//! localhost provider. In a local test (Nov 7) a map's note was made by a turn that ran no reload
//! of its own, and neither view of the map people had open showed the note, or its Undo, until it
//! was reloaded by hand. The runtime now sends the reload itself once a change is saved, as it
//! does after an Undo: one reload to each open site the save changed, after the save, from the
//! workspace, then the site's picture for its card. The page a binder serves (`instafy bind
//! serve`, with its `.bind/server.json`) takes it. A page no server takes it for is logged at the
//! info level, never as a warning, and nothing of it reaches the person: the reply, the turn's
//! steps and what it recorded are the turn's own.
//!
//! A Stop the controller takes after the model is done but before the save gets its lease refuses
//! that save. The turn then ends as a stopped turn whose change was never saved: the stop's report
//! records it, and the open sites it changed get their one reload with that report.

use super::*;
use axum::extract::Path as AxumPath;
use axum::routing::{get, put};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_agent::agent_executor::AgentExecutor;
use runtime_agent::controller::ControllerClient;
use runtime_contracts::AccessTokenClaims;
use std::io::Write as _;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_SAVED_CHANGE_RELOAD_TEST_CHILD";
const TEST_NAME: &str =
    "saved_change_reload::a_saved_change_reloads_each_open_site_it_changed_once_after_the_save";
const STOPPED_CHILD: &str = "INSTAFY_STOP_REFUSED_SAVE_RELOAD_TEST_CHILD";
const STOPPED_TEST_NAME: &str =
    "saved_change_reload::a_change_whose_save_a_stop_refused_is_reported_and_reloaded_once";
const PROVIDER_KEY: &str = "inert-saved-change-provider-key";
const KEY_ID: &str = "saved-change-reload";
/// A bound page, open in Studio, whose binder takes a reload.
const PAGE: &str = "sites/porto/app.js";
/// A map, open too, that no binder serves.
const MAP: &str = "seville/map.config.json";
const REQUEST: &str = "Put the opening hours on the Porto page and a note on the map's first day.";
const REPLY: &str = "I put the opening hours on the page and the note on the map's first day.";

/// How the turn's save goes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Case {
    /// The save takes the change.
    Saved,
    /// A Stop reached the controller once the model was done: it refuses the save's lease, and the
    /// job's heartbeat sets its cancel a moment later.
    StopRefusedTheSave,
}

#[test]
fn a_saved_change_reloads_each_open_site_it_changed_once_after_the_save() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, TEST_NAME, "saved-change-reload");
    }
    run_fixture(Case::Saved)
}

#[test]
fn a_change_whose_save_a_stop_refused_is_reported_and_reloaded_once() -> Result<()> {
    if std::env::var(STOPPED_CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(STOPPED_CHILD, STOPPED_TEST_NAME, "stop-refused-save-reload");
    }
    run_fixture(Case::StopRefusedTheSave)
}

fn run_fixture(case: Case) -> Result<()> {
    // What the runtime logs, from every thread: this fixture runs in a process of its own.
    let logs = Logs::default();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(logs.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish(),
    )?;
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("saved-change-reload-proxy".to_string())
        .stack_size(STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_case(logs, case))
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("saved-change reload fixture panicked"))?
}

/// What the runtime logged, as the test reads it.
#[derive(Clone, Default)]
struct Logs(Arc<StdMutex<Vec<u8>>>);

impl Logs {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Logs {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// One line, in order, in the file the stand-in `instafy` and the stand-in origin both write.
fn note(seen: &Path, line: &str) {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(seen)
        .expect("open the record of what ran");
    writeln!(file, "{line}").expect("write the record of what ran");
}

fn response(item: Value) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5","output":[item],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

/// The model writes both files with one command, then answers.
async fn provider_request(Json(body): Json<Value>) -> axum::response::Response {
    let input = body["input"].as_array().cloned().unwrap_or_default();
    let start = input
        .iter()
        .rposition(|item| item["role"] == "user")
        .unwrap_or(0);
    let ran = input[start..]
        .iter()
        .any(|item| item["type"] == "function_call_output");
    if ran {
        return response(json!({
            "id":format!("msg_{}", Uuid::new_v4()),"type":"message","role":"assistant",
            "status":"completed","phase":"final_answer",
            "content":[{"type":"output_text","text":REPLY}]
        }));
    }
    response(json!({
        "id":"tool_write","type":"function_call","name":"exec_command",
        "call_id":"call_write","status":"completed",
        "arguments":json!({
            "cmd":format!(
                "printf '%s\\n' 'hours: \"10:00-19:00\"' > {PAGE} && printf '%s\\n' '{{\"note\":\"Book the Alcazar tickets ahead.\"}}' > {MAP}"
            ),
            "max_output_tokens":64
        }).to_string()
    }))
}

struct Controller {
    case: Case,
    jwks: Value,
    origin: String,
    seen: PathBuf,
    /// The job's cancel, as its heartbeat sets it once the controller says the job was stopped.
    stop: JobCancelSignal,
    /// The steps and notes the turn sent to the chat.
    steps: StdMutex<Vec<Value>>,
    stopped_reports: StdMutex<Vec<Value>>,
    pictures: StdMutex<Vec<(String, String)>>,
}

async fn jwks(State(state): State<Arc<Controller>>) -> Json<Value> {
    Json(state.jwks.clone())
}

async fn lease_acquire(State(state): State<Arc<Controller>>) -> axum::response::Response {
    if state.case == Case::StopRefusedTheSave {
        // The job was stopped: its token no longer gets the lease, and its heartbeat, which asks
        // every second, learns of the Stop a moment after this answer.
        note(&state.seen, "lease refused");
        let stop = state.stop.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(300)).await;
            stop.cancel();
        });
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "job token is no longer active" })),
        )
            .into_response();
    }
    Json(json!({ "leaseId": Uuid::new_v4() })).into_response()
}

async fn stopped_report(
    State(state): State<Arc<Controller>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    note(&state.seen, "stop reported");
    state.stopped_reports.lock().unwrap().push(body);
    Json(json!({ "ok": true }))
}

/// The save's last step: the workspace lease goes back once the change is applied and saved.
async fn lease_release(State(state): State<Arc<Controller>>) -> Json<Value> {
    note(&state.seen, "saved");
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

async fn job_message(State(state): State<Arc<Controller>>, Json(body): Json<Value>) -> Json<Value> {
    state.steps.lock().unwrap().push(body);
    Json(json!({ "ok": true }))
}

async fn preview_picture(
    State(state): State<Arc<Controller>>,
    AxumPath((project, preview)): AxumPath<(String, String)>,
) -> Json<Value> {
    state.pictures.lock().unwrap().push((project, preview));
    Json(json!({ "ok": true }))
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

async fn run_case(logs: Logs, case: Case) -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    for (file, text) in [(PAGE, "hours: \"Not checked\"\n"), (MAP, "{}\n")] {
        fs::create_dir_all(workspace.join(file).parent().unwrap())?;
        fs::write(workspace.join(file), text)?;
    }
    git_in(&workspace, &["init", "-q", "-b", "main"])?;
    git_in(&workspace, &["add", PAGE, MAP])?;
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
    // The page's binder: `instafy bind command` finds it by this file.
    fs::create_dir_all(workspace.join("sites/porto/.bind"))?;
    fs::write(workspace.join("sites/porto/.bind/server.json"), "{}")?;

    // Both pages are open: the page's card with a picture older than the change, and the map's
    // with none.
    let home = PathBuf::from(std::env::var("HOME")?);
    fs::create_dir_all(home.join(".instafy"))?;
    let picture_before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as f64
        - 60_000.0;
    fs::write(
        home.join(".instafy/cli-preview-state.json"),
        json!({ "version": 1, "previews": [
            {
                "previewId": "preview-porto",
                "projectId": project_id.to_string(),
                "title": "Livraria Lello",
                "localPort": 4173,
                "path": "/",
                "pid": std::process::id(),
                "siteDir": "sites/porto",
                "pictureAt": picture_before,
            },
            {
                "previewId": "preview-seville",
                "projectId": project_id.to_string(),
                "title": "3 days in Seville",
                "localPort": 4174,
                "path": "/",
                "pid": std::process::id(),
                "siteDir": "seville",
                "noThumbnail": true,
            },
        ]})
        .to_string(),
    )?;
    // A stand-in `instafy`: like the binder, `bind command` is taken for a folder a binder
    // serves and refused for any other; a check keeps a picture of the page.
    let seen = home.join("seen");
    let bin = home.join("bin");
    fs::create_dir_all(&bin)?;
    fs::write(
        bin.join("instafy"),
        format!(
            r#"#!/bin/sh
seen='{seen}'
if [ "$1" = bind ] && [ "$2" = command ]; then
  echo "reload $3 $4 $5 | cwd=$(pwd -P)" >> "$seen"
  if [ -f "$3/.bind/server.json" ]; then
    echo '{{"ok":true,"viewers":2}}'
    exit 0
  fi
  echo "instafy-bind: no running binder for $3" >&2
  exit 1
fi
if [ "$1" != preview ] || [ "$2" != check ]; then
  echo "other $*" >> "$seen"
  exit 0
fi
echo "check $*" >> "$seen"
picture=
while [ $# -gt 0 ]; do
  case "$1" in
    --picture-to) picture=$2; shift ;;
  esac
  shift
done
printf '\377\330\377\340card' > "$picture"
printf '{{"previewId":"preview-porto","description":"Livraria Lello","takenAt":%s}}' "$(date +%s)000" > "$picture.json"
"#,
            seen = seen.display()
        ),
    )?;
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(bin.join("instafy"), fs::Permissions::from_mode(0o755))?;
    }

    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-saved-change-runtime-key"}).to_string(),
    )?;
    let mut settings = vec![EnvGuard::set(
        "PATH",
        format!("{}:{}", bin.display(), std::env::var("PATH")?),
    )];
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-saved-change-runtime-key"),
        ("CODEX_API_KEY", "inert-saved-change-runtime-key"),
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

    let (upstream, stub_guard, stub_task) =
        serve(Router::new().route("/backend-api/codex/responses", post(provider_request))).await?;
    let (origin, origin_guard, origin_task) = serve(
        Router::new()
            .route("/apply", post(origin_apply))
            .route("/git/sync", post(origin_git_sync)),
    )
    .await?;

    // The controller signs the job's workspace token, lends the save its lease and the origin's
    // address, and records what the chat gets.
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| anyhow::anyhow!("generate a signing key"))?;
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| anyhow::anyhow!("read the signing key"))?;
    let controller = Arc::new(Controller {
        case,
        jwks: json!({ "keys": [{
            "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
            "kid": KEY_ID, "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        }] }),
        origin,
        seen: seen.clone(),
        stop: JobCancelSignal::new(),
        steps: StdMutex::new(Vec::new()),
        stopped_reports: StdMutex::new(Vec::new()),
        pictures: StdMutex::new(Vec::new()),
    });
    let (controller_url, controller_guard, controller_task) = serve(
        Router::new()
            .route("/.well-known/jwks.json", get(jwks))
            .route("/lease/acquire", post(lease_acquire))
            .route("/lease/release", post(lease_release))
            .route("/access_token", post(access_token))
            .route("/agent/message", post(job_message))
            .route("/agent/stopped", post(stopped_report))
            .route(
                "/projects/:project/previews/:preview/thumbnail",
                put(preview_picture),
            )
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

    let config = Arc::new(Config {
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
        runtime_access_token: Some("inert-saved-change-runtime-token".to_string()),
        parent_dispositions_runtime_on_shutdown: false,
    });
    let client = Arc::new(ControllerClient::new(&config)?);
    let executor = AgentExecutor::new(config.clone());
    executor.send_card_pictures_with(client.clone());
    let registration = registration_for_live(Uuid::new_v4());
    let run_id = Uuid::new_v4();
    let issued_at = chrono::Utc::now().timestamp();
    let mut header = Header::new(Algorithm::EdDSA);
    header.kid = Some(KEY_ID.to_string());
    let workspace_token = jsonwebtoken::encode(
        &header,
        &AccessTokenClaims {
            aud: registration.runtime_id.to_string(),
            sub: "job:saved-change-reload".to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: Some(registration.runtime_id.to_string()),
            protocol: None,
            scopes: vec![
                "workspace.lease.write".to_string(),
                "origin.token.mint".to_string(),
            ],
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
    )?;
    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(run_id),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text": REQUEST,
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{
                "workspaceFileChanges":true,"commandExecution":false,"genericMcpToolExecution":false
            }}
        }),
        proxy: None,
        controller_token: None,
        controller_token_scopes: None,
        controller_token_expires_at: None,
        workspace_token: Some(workspace_token),
        workspace_token_scopes: Some(vec![
            "workspace.lease.write".to_string(),
            "origin.token.mint".to_string(),
        ]),
        workspace_token_expires_at: None,
        lease_attempts: 1,
        grants: Vec::new(),
        grant_token: None,
    };

    // The turn, as the job loop runs it.
    let result = tokio::time::timeout(
        Duration::from_secs(90),
        executor.run_apply_with_progress(
            client.clone(),
            &registration,
            &job,
            Some(controller.stop.clone()),
            None,
        ),
    )
    .await
    .context("the turn did not end")?;
    let execution = match case {
        Case::Saved => {
            let execution = result?;
            assert_eq!(execution.summary, REPLY);
            assert!(
                execution
                    .artifacts
                    .iter()
                    .any(|artifact| artifact["kind"] == "origin/apply"),
                "the turn's change was saved: {:?}",
                execution.artifacts
            );
            Some(execution)
        }
        Case::StopRefusedTheSave => {
            let error = match result {
                Ok(execution) => anyhow::bail!("the turn finished: {}", execution.summary),
                Err(error) => error,
            };
            // Not a failed save: a stopped turn, which the job loop reports nothing more for.
            assert!(
                runtime_agent::agent_executor::is_lease_lost(&error),
                "it ends as a stopped turn: {error:#}"
            );
            // Its one end report records the change it kept, as never saved.
            let reports = controller.stopped_reports.lock().unwrap().clone();
            assert_eq!(reports.len(), 1, "one end report: {reports:?}");
            assert_eq!(reports[0]["job_id"], json!(job.id.to_string()));
            assert_eq!(
                reports[0]["artifacts"][0]["metadata"]["stoppedBeforeSave"], true,
                "{}",
                reports[0]
            );
            let mut files: Vec<String> = reports[0]["artifacts"][0]["files"]
                .as_array()
                .context("the report lists the turn's files")?
                .iter()
                .filter_map(|file| file["workspacePath"].as_str().map(str::to_string))
                .collect();
            files.sort();
            assert_eq!(files, [MAP, PAGE], "{}", reports[0]);
            None
        }
    };

    // The page is pictured again once its reload was sent.
    let deadline = Instant::now() + Duration::from_secs(30);
    while controller.pictures.lock().unwrap().is_empty() {
        anyhow::ensure!(
            Instant::now() < deadline,
            "the changed page was not pictured again: {}",
            fs::read_to_string(&seen).unwrap_or_default()
        );
        sleep(Duration::from_millis(50)).await;
    }
    sleep(Duration::from_millis(500)).await;
    let lines: Vec<String> = fs::read_to_string(&seen)?
        .lines()
        .map(str::to_string)
        .collect();
    let workspace_real = workspace.canonicalize()?;
    let reload = |site: &str| {
        format!(
            "reload {site} reload {{}} | cwd={}",
            workspace_real.display()
        )
    };
    let at = |line: &str| lines.iter().position(|seen| seen == line);
    // One save, then one reload for each open site it changed, from the workspace: the turn's
    // own skills send none. A change whose save a Stop refused is saved by nothing: its reload
    // goes with the stop's report.
    let (saved_count, after) = match case {
        Case::Saved => (1, "saved"),
        Case::StopRefusedTheSave => (0, "stop reported"),
    };
    assert_eq!(
        lines.iter().filter(|line| line.as_str() == "saved").count(),
        saved_count,
        "{lines:#?}"
    );
    assert!(at(after).is_some(), "{lines:#?}");
    for site in ["./sites/porto", "./seville"] {
        assert_eq!(
            lines.iter().filter(|line| **line == reload(site)).count(),
            1,
            "one reload of {site}: {lines:#?}"
        );
        assert!(
            at(after) < at(&reload(site)),
            "the reload of {site} comes after {after}: {lines:#?}"
        );
    }
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("reload "))
            .count(),
        2,
        "{lines:#?}"
    );
    // The check's own page never takes the reload halfway through its picture.
    let first_check = lines.iter().position(|line| line.starts_with("check "));
    assert!(
        first_check.is_some() && at(&reload("./sites/porto")) < first_check,
        "{lines:#?}"
    );
    assert_eq!(
        controller.pictures.lock().unwrap().clone(),
        vec![(project_id.to_string(), "preview-porto".to_string())]
    );

    // The map, which no binder serves, keeps its open views as they are: a line in the log at
    // the info level, no warning, and nothing in the chat.
    let logged = logs.text();
    let refused = logged
        .lines()
        .find(|line| line.contains("no binder took the reload of a changed site"))
        .unwrap_or_else(|| panic!("the refused reload is logged: {logged}"));
    assert!(
        refused.contains(" INFO ") && refused.contains("site=\"./seville\""),
        "{refused}"
    );
    assert!(
        logged.lines().any(|line| line
            .contains("sent the reload of a changed site to its open views")
            && line.contains("site=\"./sites/porto\"")
            && line.contains("viewers=Some(2)")),
        "{logged}"
    );
    for line in logged.lines().filter(|line| line.contains("reload")) {
        assert!(
            !line.contains(" WARN ") && !line.contains(" ERROR "),
            "{line}"
        );
    }
    let said = |value: &Value| value.to_string().to_ascii_lowercase();
    for step in controller.steps.lock().unwrap().iter() {
        assert!(
            !said(step).contains("reload") && !said(step).contains("binder"),
            "{step}"
        );
    }
    for message in execution
        .iter()
        .flat_map(|execution| execution.messages.iter().chain(&execution.final_messages))
    {
        let words = message.content.to_ascii_lowercase();
        assert!(
            !words.contains("reload") && !words.contains("binder"),
            "{}",
            message.content
        );
    }

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
