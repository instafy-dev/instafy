use super::*;
use axum::{Router, extract::State, routing::post};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug)]
enum TaskKind {
    Heartbeat,
    SecretsRefresh,
}

enum BackgroundTask {
    Heartbeat(HeartbeatTask),
    SecretsRefresh(SecretsRefreshTask),
}

impl BackgroundTask {
    fn spawn(kind: TaskKind, controller: &BlockedController) -> Self {
        let client = controller.client.clone();
        let registration = controller.registration.clone();
        let job_id = Uuid::new_v4();
        match kind {
            TaskKind::Heartbeat => {
                Self::Heartbeat(HeartbeatTask::spawn(client, registration, job_id, 5, None))
            }
            TaskKind::SecretsRefresh => Self::SecretsRefresh(SecretsRefreshTask::spawn(
                client,
                registration,
                job_id,
                5,
                Arc::new(Mutex::new(HashSet::new())),
            )),
        }
    }

    async fn shutdown(self) {
        match self {
            Self::Heartbeat(task) => task.shutdown().await,
            Self::SecretsRefresh(task) => task.shutdown().await,
        }
    }
}

struct BlockedController {
    client: Arc<ControllerClient>,
    registration: Registration,
    requests: mpsc::Receiver<()>,
    server: JoinHandle<()>,
    _workspace: tempfile::TempDir,
}

impl BlockedController {
    async fn start() -> Self {
        async fn block_request(
            State(requests): State<mpsc::Sender<()>>,
        ) -> axum::Json<serde_json::Value> {
            requests.send(()).await.expect("record request");
            pending().await
        }

        let (request_sender, requests) = mpsc::channel(4);
        let router = Router::new()
            .route("/agent/heartbeat", post(block_request))
            .route("/agent/secrets", post(block_request))
            .with_state(request_sender);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock controller");
        let base_url = reqwest::Url::parse(&format!(
            "http://{}",
            listener.local_addr().expect("controller address")
        ))
        .expect("controller URL");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("mock controller");
        });
        let workspace = tempfile::tempdir().expect("workspace");
        let config = Config {
            controller_base_url: base_url.clone(),
            controller_jwks_url: base_url.join("/.well-known/jwks.json").unwrap(),
            project_id: Uuid::new_v4(),
            runtime_id: None,
            runtime_lease_id: None,
            provider: "test".into(),
            runtime_version: "test".into(),
            capabilities: json!({}),
            metadata: json!({}),
            lease_scope: None,
            workspace_manifest: None,
            tenant_projects: Vec::new(),
            parent_lease_id: None,
            poll_interval: Duration::from_secs(1),
            lease_max_jobs: 1,
            lease_seconds: 60,
            heartbeat_seconds: 60,
            workspace_root: workspace.path().to_path_buf(),
            project_workspace_override: None,
            strict_mode: false,
            dev_isolation_mode: true,
            display_name: None,
            origin: None,
            codex_bin: None,
            require_codex_bin: false,
            runtime_access_token: None,
            parent_dispositions_runtime_on_shutdown: false,
        };
        let registration = Registration {
            runtime_id: Uuid::new_v4(),
            agent_token: "inert-test-agent".into(),
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
            client: Arc::new(ControllerClient::new(&config).expect("controller client")),
            registration,
            requests,
            server,
            _workspace: workspace,
        }
    }
}

impl Drop for BlockedController {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn job_background_tasks_stop_before_their_first_poll() {
    for kind in [TaskKind::Heartbeat, TaskKind::SecretsRefresh] {
        let mut controller = BlockedController::start().await;
        let task = BackgroundTask::spawn(kind, &controller);

        // Do not yield between spawn and shutdown: the stop must survive until
        // the newly spawned task first observes it.
        tokio::time::timeout(Duration::from_secs(2), task.shutdown())
            .await
            .unwrap_or_else(|_| panic!("{kind:?} missed shutdown before its first poll"));
        assert!(controller.requests.try_recv().is_err());
    }
}

#[tokio::test]
async fn job_background_tasks_stop_while_waiting_for_the_next_tick() {
    for kind in [TaskKind::Heartbeat, TaskKind::SecretsRefresh] {
        let mut controller = BlockedController::start().await;
        let task = BackgroundTask::spawn(kind, &controller);
        // Let the immediate first tick be skipped and the periodic wait start.
        tokio::task::yield_now().await;

        tokio::time::timeout(Duration::from_secs(2), task.shutdown())
            .await
            .unwrap_or_else(|_| panic!("{kind:?} did not stop during its periodic wait"));
        assert!(controller.requests.try_recv().is_err());
    }
}

#[tokio::test]
async fn job_background_tasks_stop_during_a_blocked_controller_request() {
    for kind in [TaskKind::Heartbeat, TaskKind::SecretsRefresh] {
        let mut controller = BlockedController::start().await;
        let task = BackgroundTask::spawn(kind, &controller);
        tokio::time::timeout(Duration::from_secs(10), controller.requests.recv())
            .await
            .expect("periodic request should start")
            .expect("controller should observe the request");

        // The controller never returns a response. Shutdown must interrupt the
        // request and join the task, without waiting for the HTTP timeout or a
        // later tick. Dropping the stop notification here wedged the lease loop.
        tokio::time::timeout(Duration::from_secs(2), task.shutdown())
            .await
            .unwrap_or_else(|_| panic!("{kind:?} did not stop during its controller request"));
        assert!(controller.requests.try_recv().is_err());
    }
}
