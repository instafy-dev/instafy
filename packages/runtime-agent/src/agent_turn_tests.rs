//! The job loop records how each job's turn ended, which decides whether a
//! stop sets that turn's local commits aside (`AgentExecutor::turn_interrupted`).
//! Driven end to end against a stand-in controller.

use super::*;
use axum::{Json, Router, extract::State, http::StatusCode as AxumStatusCode, routing::post};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Clone, Default)]
struct StandIn {
    lease_lost: Arc<AtomicBool>,
    heartbeats: Arc<AtomicUsize>,
    completions: Arc<AtomicUsize>,
    handoff_rejected: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

async fn heartbeat(State(stand_in): State<StandIn>) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    stand_in.heartbeats.fetch_add(1, Ordering::SeqCst);
    if stand_in.lease_lost.load(Ordering::SeqCst) {
        (AxumStatusCode::CONFLICT, "job lease no longer held").into_response()
    } else {
        Json(json!({})).into_response()
    }
}

async fn secrets() -> Json<serde_json::Value> {
    Json(json!({ "env": {}, "inventory": [] }))
}

async fn complete(
    State(stand_in): State<StandIn>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    stand_in
        .requests
        .lock()
        .push(json!({"endpoint":"complete", "body":body}));
    stand_in.completions.fetch_add(1, Ordering::SeqCst);
    Json(json!({ "ok": true }))
}

async fn user_input_request(
    State(stand_in): State<StandIn>,
    Json(body): Json<serde_json::Value>,
) -> (AxumStatusCode, Json<serde_json::Value>) {
    stand_in
        .requests
        .lock()
        .push(json!({"endpoint":"input", "body":body}));
    if stand_in.handoff_rejected.load(Ordering::SeqCst) {
        return (
            AxumStatusCode::CONFLICT,
            Json(json!({"error":"lease no longer held"})),
        );
    }
    (
        AxumStatusCode::OK,
        Json(json!({"requestId":"ef235459-986c-43a3-8333-e005e2bd0390", "status":"pending"})),
    )
}

struct Harness {
    stand_in: StandIn,
    config: Arc<Config>,
    client: Arc<ControllerClient>,
    registration: Registration,
    server: JoinHandle<()>,
    _workspace: tempfile::TempDir,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Harness {
    async fn start() -> Self {
        let stand_in = StandIn::default();
        let app = Router::new()
            .route("/agent/heartbeat", post(heartbeat))
            .route("/agent/secrets", post(secrets))
            .route("/agent/complete", post(complete))
            .route(
                "/agent/jobs/:job_id/user-input-requests",
                post(user_input_request),
            )
            .with_state(stand_in.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url: reqwest::Url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let workspace = tempfile::tempdir().unwrap();
        let config = Config {
            controller_base_url: base_url.clone(),
            controller_jwks_url: base_url.join("/.well-known/jwks.json").unwrap(),
            project_id: Uuid::new_v4(),
            runtime_id: None,
            runtime_lease_id: None,
            provider: "test-runtime".into(),
            runtime_version: "0.0.1".into(),
            capabilities: json!({}),
            metadata: json!({}),
            lease_scope: None,
            workspace_manifest: None,
            tenant_projects: Vec::new(),
            parent_lease_id: None,
            poll_interval: Duration::from_millis(10),
            lease_wait: Duration::ZERO,
            lease_max_jobs: 1,
            lease_seconds: 120,
            heartbeat_seconds: 60,
            workspace_root: workspace.path().to_path_buf(),
            project_workspace_override: None,
            strict_mode: false,
            dev_isolation_mode: true,
            display_name: None,
            origin: None,
            codex_bin: None,
            require_codex_bin: false,
            runtime_access_token: Some("inert-test-runtime-token".into()),
            parent_dispositions_runtime_on_shutdown: false,
        };
        let registration = Registration {
            runtime_id: Uuid::new_v4(),
            agent_token: "inert-test-agent-token".into(),
            runtime_token: None,
            lease_url: base_url.join("/agent/lease").unwrap(),
            heartbeat_url: base_url.join("/agent/heartbeat").unwrap(),
            stop_url: None,
            lease_id: None,
            proxy: None,
            lease_scope: None,
            tenant_projects: Vec::new(),
            workspace_manifest: None,
            parent_lease_id: None,
            agent_token_scopes: Vec::new(),
            agent_token_issued_at: None,
            agent_token_expires_at: None,
            agent_token_ttl: None,
        };
        Self {
            stand_in,
            client: Arc::new(ControllerClient::new(&config).unwrap()),
            config: Arc::new(config),
            registration,
            server,
            _workspace: workspace,
        }
    }

    /// A job the runtime refuses at once (its execution mode is not
    /// implemented): it ends on its own, without running a turn.
    fn job(&self) -> LeaseJob {
        LeaseJob {
            id: Uuid::new_v4(),
            intent: None,
            project_id: Some(self.config.project_id),
            run_id: None,
            conversation_id: None,
            session_id: None,
            credential_id: None,
            payload: json!({ "metadata": { "execution_mode": "plan_only" } }),
            proxy: None,
            controller_token: None,
            controller_token_scopes: None,
            controller_token_expires_at: None,
            workspace_token: None,
            workspace_token_scopes: None,
            workspace_token_expires_at: None,
            lease_attempts: 1,
        }
    }
}

#[tokio::test]
async fn the_job_loop_records_whether_a_turn_was_interrupted() {
    let harness = Harness::start().await;

    // A job that ends on its own leaves nothing interrupted.
    let executor = Arc::new(AgentExecutor::new(harness.config.clone()));
    RuntimeAgent::handle_job(
        harness.client.clone(),
        executor.clone(),
        &harness.registration,
        harness.job(),
        0,
        Arc::new(Mutex::new(HashSet::new())),
    )
    .await
    .unwrap();
    assert_eq!(harness.stand_in.completions.load(Ordering::SeqCst), 1);
    assert!(!executor.turn_interrupted(), "a finished turn");

    // A job whose lease is lost before its turn runs (it waits for the
    // process environment another job holds, and its heartbeat says the
    // lease is gone) is interrupted, and is not completed.
    harness.stand_in.lease_lost.store(true, Ordering::SeqCst);
    let executor = Arc::new(AgentExecutor::new(harness.config.clone()));
    let held = JOB_PROCESS_ENV_LOCK.lock().await;
    let task = tokio::spawn({
        let client = harness.client.clone();
        let executor = executor.clone();
        let registration = harness.registration.clone();
        let job = harness.job();
        async move {
            RuntimeAgent::handle_job(
                client,
                executor,
                &registration,
                job,
                6,
                Arc::new(Mutex::new(HashSet::new())),
            )
            .await
        }
    });
    // The first heartbeat runs at once; the periodic one (every 5 s) cancels
    // the job.
    let deadline = Instant::now() + Duration::from_secs(20);
    while harness.stand_in.heartbeats.load(Ordering::SeqCst) < 2 {
        assert!(Instant::now() < deadline, "no periodic heartbeat");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Let the heartbeat task act on the refusal before the job may go on.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(executor.turn_interrupted(), "still running");
    drop(held);
    task.await.unwrap().unwrap();
    assert!(executor.turn_interrupted(), "a turn that lost its lease");
    assert_eq!(
        harness.stand_in.completions.load(Ordering::SeqCst),
        1,
        "the lost job is not completed"
    );
}

fn question_execution() -> JobExecution {
    JobExecution {
        summary: "Your choice is needed.".into(),
        suggested_replies: Vec::new(),
        provider: "test".into(),
        artifacts: vec![json!({"kind":"agent/user-input-request",
            "questions":[{"id":"tone", "header":"Tone", "question":"Which tone?"}],
            "continuationNote":"Write the owned poem after the decision."})],
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: Vec::new(),
    }
}

#[tokio::test]
async fn worker_question_registers_before_completion_and_keeps_controller_identity() {
    let harness = Harness::start().await;
    let mut job = harness.job();
    job.payload = json!({"metadata":{"multiAgentPlan":{"role":"worker", "groupId":"group"}}});
    RuntimeAgent::complete_job(
        &harness.client,
        &harness.registration,
        &job,
        question_execution(),
    )
    .await;
    let requests = harness.stand_in.requests.lock();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["endpoint"], "input");
    assert_eq!(
        requests[0]["body"]["runtimeId"],
        harness.registration.runtime_id.to_string()
    );
    assert_eq!(requests[1]["endpoint"], "complete");
    assert_eq!(requests[1]["body"]["outcome"], "succeeded");
    assert_eq!(
        requests[1]["body"]["artifacts"][0]["requestId"],
        "ef235459-986c-43a3-8333-e005e2bd0390"
    );
}

#[tokio::test]
async fn rejected_worker_question_fails_once_without_reporting_completion() {
    let harness = Harness::start().await;
    harness
        .stand_in
        .handoff_rejected
        .store(true, Ordering::SeqCst);
    let mut job = harness.job();
    job.payload = json!({"metadata":{"multiAgentPlan":{"role":"worker", "groupId":"group"}}});
    RuntimeAgent::complete_job(
        &harness.client,
        &harness.registration,
        &job,
        question_execution(),
    )
    .await;
    let requests = harness.stand_in.requests.lock();
    assert_eq!(
        requests.len(),
        2,
        "registration failure must not silently retry"
    );
    assert_eq!(requests[0]["endpoint"], "input");
    assert_eq!(requests[1]["body"]["outcome"], "failed");
    assert!(
        requests[1]["body"]["artifacts"][0]
            .get("requestId")
            .is_none()
    );
}

#[tokio::test]
async fn untracked_job_cannot_publish_a_worker_question() {
    let harness = Harness::start().await;
    RuntimeAgent::complete_job(
        &harness.client,
        &harness.registration,
        &harness.job(),
        question_execution(),
    )
    .await;
    let requests = harness.stand_in.requests.lock();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["endpoint"], "complete");
    assert_eq!(requests[0]["body"]["outcome"], "failed");
}
