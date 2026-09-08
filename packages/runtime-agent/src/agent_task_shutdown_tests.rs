use super::*;
use axum::{Json, Router, extract::State, http::Uri, routing::post};
use tokio::sync::mpsc;

#[derive(Clone)]
struct ControllerState {
    requests: mpsc::UnboundedSender<String>,
    release_response: ShutdownSignal,
    secret_key: String,
}

async fn delayed_response(
    State(state): State<ControllerState>,
    uri: Uri,
) -> Json<serde_json::Value> {
    state.requests.send(uri.path().to_string()).unwrap();
    state.release_response.cancelled().await;
    Json(json!({ "env": { state.secret_key: "inert-test-value" }, "inventory": [] }))
}

struct TestController {
    client: Arc<ControllerClient>,
    registration: Registration,
    requests: mpsc::UnboundedReceiver<String>,
    release_response: ShutdownSignal,
    secret_key: String,
    server: JoinHandle<()>,
    _workspace: tempfile::TempDir,
}

impl Drop for TestController {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl TestController {
    async fn new() -> Self {
        let (requests, receiver) = mpsc::unbounded_channel();
        let release_response = ShutdownSignal::new();
        let secret_key = format!("INSTAFY_SHUTDOWN_TEST_{}", Uuid::new_v4().simple());
        let app = Router::new()
            .route("/agent/heartbeat", post(delayed_response))
            .route("/agent/secrets", post(delayed_response))
            .with_state(ControllerState {
                requests,
                release_response: release_response.clone(),
                secret_key: secret_key.clone(),
            });
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
            client: Arc::new(ControllerClient::new(&config).unwrap()),
            registration,
            requests: receiver,
            release_response,
            secret_key,
            server,
            _workspace: workspace,
        }
    }

    async fn next_request(&mut self, path: &str) {
        let received = tokio::time::timeout(Duration::from_secs(10), self.requests.recv())
            .await
            .expect("periodic request should reach the local controller")
            .unwrap();
        assert_eq!(received, path);
    }
}

#[tokio::test]
async fn periodic_task_shutdown_before_first_poll_is_sticky() {
    let mut controller = TestController::new().await;
    let heartbeat = HeartbeatTask::spawn(
        controller.client.clone(),
        controller.registration.clone(),
        Uuid::new_v4(),
        5,
        None,
    );
    // No yield between spawn and shutdown: the stop arrives before the task
    // has registered its first waiter.
    tokio::time::timeout(Duration::from_secs(1), heartbeat.shutdown())
        .await
        .expect("heartbeat shutdown must not need a second notification");
    let secrets = SecretsRefreshTask::spawn(
        controller.client.clone(),
        controller.registration.clone(),
        Uuid::new_v4(),
        5,
        Arc::new(Mutex::new(HashSet::new())),
    );
    tokio::time::timeout(Duration::from_secs(1), secrets.shutdown())
        .await
        .expect("secrets shutdown must not need a second notification");
    assert!(controller.requests.try_recv().is_err());
}

#[tokio::test]
async fn periodic_task_shutdown_cancels_in_flight_heartbeat() {
    let mut controller = TestController::new().await;
    let lease_lost = JobCancelSignal::new();
    let task = HeartbeatTask::spawn(
        controller.client.clone(),
        controller.registration.clone(),
        Uuid::new_v4(),
        5,
        Some(lease_lost.clone()),
    );
    controller.next_request("/agent/heartbeat").await;
    tokio::time::timeout(Duration::from_secs(1), task.shutdown())
        .await
        .expect("job cleanup must finish even while the heartbeat response is stalled");
    assert!(
        !lease_lost.is_canceled(),
        "normal shutdown is not lease loss"
    );
    controller.release_response.cancel();
    assert!(controller.requests.try_recv().is_err());
}

#[tokio::test]
async fn periodic_task_shutdown_cancels_in_flight_secrets_without_applying_late_response() {
    let mut controller = TestController::new().await;
    let managed_keys = Arc::new(Mutex::new(HashSet::new()));
    let task = SecretsRefreshTask::spawn(
        controller.client.clone(),
        controller.registration.clone(),
        Uuid::new_v4(),
        5,
        managed_keys.clone(),
    );
    controller.next_request("/agent/secrets").await;
    tokio::time::timeout(Duration::from_secs(1), task.shutdown())
        .await
        .expect("secrets shutdown must not wait for the HTTP response");
    controller.release_response.cancel();
    tokio::task::yield_now().await;
    assert!(managed_keys.lock().is_empty());
    assert!(std::env::var_os(&controller.secret_key).is_none());
    assert!(controller.requests.try_recv().is_err());
}
