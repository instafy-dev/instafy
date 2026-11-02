//! A building turn the person stops, through the real proxy with an inert,
//! localhost provider. The model's edit of a page it sent before the turn
//! learned of the Stop runs; the Stop then reaches the turn (its cancel, as the
//! job's heartbeat sets it) while the model is answering, and the turn ends on
//! its lost lease. As the job loop does, the runtime then sends the one end
//! report of what the turn changed, and the card of the site it changed gets
//! a new picture.

use super::*;
use axum::extract::Path as AxumPath;
use axum::routing::put;
use runtime_agent::agent_executor::{AgentExecutor, is_lease_lost};
use runtime_agent::controller::ControllerClient;
use std::sync::Mutex as StdMutex;

const CHILD: &str = "INSTAFY_STOPPED_TURN_TEST_CHILD";
const TEST_NAME: &str =
    "stopped_turn::a_stopped_building_turn_reports_the_edit_it_made_and_pictures_its_site_again";
const PROVIDER_KEY: &str = "inert-stopped-turn-provider-key";
const PAGE: &str = "sites/porto/app.js";
const SAVED_PAGE: &str = "hours: \"Not checked\"\n";
const EDITED_PAGE: &str = "hours: \"Hours not found\"\n";

#[test]
fn a_stopped_building_turn_reports_the_edit_it_made_and_pictures_its_site_again() -> Result<()> {
    if std::env::var(CHILD).as_deref() != Ok("1") {
        return run_isolated_fixture(CHILD, TEST_NAME, "stopped-turn");
    }
    const STACK: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .name("stopped-turn-proxy".to_string())
        .stack_size(STACK)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK)
                .build()?
                .block_on(run_case())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("stopped-turn fixture panicked"))?
}

struct Provider {
    requests: StdMutex<Vec<Value>>,
    /// The job's cancel: set as the turn's heartbeat sets it after a Stop.
    stop: JobCancelSignal,
    /// Lets the request the Stop cut off end, once the test is done.
    released: JobCancelSignal,
}

fn response(item: Value) -> axum::response::Response {
    Json(json!({
        "id":format!("resp_{}", Uuid::new_v4()),"object":"response","status":"completed",
        "model":"gpt-5.5","output":[item],
        "usage":{"input_tokens":42,"output_tokens":12,"total_tokens":54}
    }))
    .into_response()
}

async fn provider_request(
    State(state): State<Arc<Provider>>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body);
        requests.len() - 1
    };
    match index {
        // The edit the model sent after the press, before the turn knew.
        0 => response(json!({
            "id":"tool_edit","type":"function_call","name":"exec_command",
            "call_id":"call_edit","status":"completed",
            "arguments":json!({
                "cmd":format!("printf '%s\\n' '{}' > {PAGE}", EDITED_PAGE.trim_end()),
                "max_output_tokens":64
            }).to_string()
        })),
        // The Stop reaches the turn while the model answers: the turn loses its
        // lease and never reads this answer.
        _ => {
            state.stop.cancel();
            state.released.cancelled().await;
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "the turn was stopped" })),
            )
                .into_response()
        }
    }
}

#[derive(Default)]
struct Controller {
    stopped_reports: StdMutex<Vec<Value>>,
    pictures: StdMutex<Vec<(String, String)>>,
}

async fn stopped_report(
    State(state): State<Arc<Controller>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.stopped_reports.lock().unwrap().push(body);
    Json(json!({ "ok": true }))
}

async fn job_message() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn preview_picture(
    State(state): State<Arc<Controller>>,
    AxumPath((project, preview)): AxumPath<(String, String)>,
) -> Json<Value> {
    state.pictures.lock().unwrap().push((project, preview));
    Json(json!({ "ok": true }))
}

async fn run_case() -> Result<()> {
    let _env = env_guard().await;
    let workspace_root = TempDir::new()?;
    let runtime_home = TempDir::new()?;
    let project_id = Uuid::new_v4();
    let workspace = workspace_root.path().join(project_id.to_string());
    fs::create_dir_all(workspace.join("sites/porto"))?;
    fs::write(workspace.join(PAGE), SAVED_PAGE)?;
    git_in(&workspace, &["init", "-q", "-b", "main"])?;
    git_in(&workspace, &["add", PAGE])?;
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

    // The open preview of the page's site, with a picture older than the
    // edit, and a stand-in `instafy` whose check keeps a new one.
    let home = PathBuf::from(std::env::var("HOME")?);
    fs::create_dir_all(home.join(".instafy"))?;
    let picture_before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as f64
        - 60_000.0;
    fs::write(
        home.join(".instafy/cli-preview-state.json"),
        json!({ "version": 1, "previews": [{
            "previewId": "preview-1",
            "projectId": project_id.to_string(),
            "title": "Livraria Lello",
            "localPort": 4173,
            "path": "/",
            "pid": std::process::id(),
            "siteDir": "sites/porto",
            "pictureAt": picture_before,
        }]})
        .to_string(),
    )?;
    let bin = home.join("bin");
    fs::create_dir_all(&bin)?;
    fs::write(
        bin.join("instafy"),
        r#"#!/bin/sh
picture=
while [ $# -gt 0 ]; do
  case "$1" in
    --picture-to) picture=$2; shift ;;
  esac
  shift
done
printf '\377\330\377\340card' > "$picture"
printf '{"previewId":"preview-1","description":"Livraria Lello","takenAt":%s}' "$(date +%s)000" > "$picture.json"
"#,
    )?;
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(bin.join("instafy"), fs::Permissions::from_mode(0o755))?;
    }

    let auth_path = runtime_home.path().join("auth.json");
    fs::write(
        &auth_path,
        json!({"OPENAI_API_KEY":"inert-stopped-turn-runtime-key"}).to_string(),
    )?;
    let mut settings = vec![EnvGuard::set(
        "PATH",
        format!("{}:{}", bin.display(), std::env::var("PATH")?),
    )];
    for (key, value) in [
        ("PROXY_REQUIRE_CONTROLLER_AUTH", "false"),
        ("PROXY_REQUIRE_CREDENTIAL_CLAIM", "false"),
        ("OPENAI_API_KEY", "inert-stopped-turn-runtime-key"),
        ("CODEX_API_KEY", "inert-stopped-turn-runtime-key"),
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

    let provider = Arc::new(Provider {
        requests: StdMutex::new(Vec::new()),
        stop: JobCancelSignal::new(),
        released: JobCancelSignal::new(),
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let upstream = listener.local_addr()?;
    let app = Router::new()
        .route("/backend-api/codex/responses", post(provider_request))
        .with_state(provider.clone());
    let (stub_shutdown, stub_rx) = oneshot::channel();
    let stub_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stub_rx.await;
            })
            .await
    });
    let stub_guard = ChildGuard::new(stub_shutdown);

    let controller = Arc::new(Controller::default());
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let controller_url = Url::parse(&format!("http://{}", listener.local_addr()?))?;
    let app = Router::new()
        .route("/agent/message", post(job_message))
        .route("/agent/stopped", post(stopped_report))
        .route(
            "/projects/:project/previews/:preview/thumbnail",
            put(preview_picture),
        )
        .with_state(controller.clone());
    let (controller_shutdown, controller_rx) = oneshot::channel();
    let controller_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = controller_rx.await;
            })
            .await
    });
    let controller_guard = ChildGuard::new(controller_shutdown);

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
        runtime_access_token: Some("inert-stopped-turn-runtime-token".to_string()),
        parent_dispositions_runtime_on_shutdown: false,
    });
    let client = Arc::new(ControllerClient::new(&config)?);
    let executor = AgentExecutor::new(config.clone());
    executor.send_card_pictures_with(client.clone());
    let job = LeaseJob {
        id: Uuid::new_v4(),
        intent: Some("feature".to_string()),
        project_id: Some(project_id),
        run_id: Some(Uuid::new_v4()),
        conversation_id: None,
        session_id: None,
        credential_id: None,
        payload: json!({
            "prompt_text":"Put the opening hours you found on the Livraria page.",
            "metadata":{"execution_mode":"apply","agentRoutingPreflight":{},"runtimeExpectations":{
                "workspaceFileChanges":true,"commandExecution":false,"genericMcpToolExecution":false
            }}
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
    };
    let registration = registration_for_live(Uuid::new_v4());

    // The turn, as the job loop runs it.
    let result = tokio::time::timeout(
        Duration::from_secs(90),
        executor.run_apply_with_progress(
            client.clone(),
            &registration,
            &job,
            Some(provider.stop.clone()),
            None,
        ),
    )
    .await
    .context("the stopped turn did not end")?;
    let error = match result {
        Ok(execution) => anyhow::bail!("the turn finished: {}", execution.summary),
        Err(error) => error,
    };
    assert!(
        is_lease_lost(&error),
        "it ends on its lost lease: {error:#}"
    );
    // The edit sent before the turn knew of the Stop ran.
    assert_eq!(fs::read_to_string(workspace.join(PAGE))?, EDITED_PAGE);

    // What the job loop does with a lost lease.
    executor
        .processor()
        .report_stopped_turn(&client, &registration, &job, &error)
        .await;

    let reports = controller.stopped_reports.lock().unwrap().clone();
    assert_eq!(reports.len(), 1, "one end report: {reports:?}");
    let report = &reports[0];
    assert_eq!(report["job_id"], json!(job.id.to_string()));
    assert_eq!(report["message_type"], "file_change");
    assert_eq!(report["metadata"]["paths"], json!([PAGE]));
    assert!(report["metadata"]["activity"].is_object(), "{report}");
    let files = report["artifacts"][0]["files"]
        .as_array()
        .context("the report lists the turn's files")?;
    assert_eq!(files.len(), 1, "{report}");
    assert_eq!(files[0]["workspacePath"], PAGE);
    assert_eq!(files[0]["changeType"], "changed");

    // The card of the page's site gets a new picture.
    let deadline = Instant::now() + Duration::from_secs(30);
    while controller.pictures.lock().unwrap().is_empty() {
        anyhow::ensure!(
            Instant::now() < deadline,
            "the stopped turn's site was not pictured again"
        );
        sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        controller.pictures.lock().unwrap().clone(),
        vec![(project_id.to_string(), "preview-1".to_string())]
    );

    provider.released.cancel();
    drop(settings);
    drop(proxy_guard);
    drop(stub_guard);
    drop(controller_guard);
    proxy_task.await??;
    stub_task.await??;
    controller_task.await??;
    Ok(())
}
