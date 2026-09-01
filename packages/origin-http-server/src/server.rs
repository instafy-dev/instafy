use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::Url;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;
use tokio::time::{self, MissedTickBehavior};
use tower::ServiceBuilder;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::auth::TokenValidator;
use crate::config::ServerConfig;
use crate::config::CONTROLLER_TOKEN_REFRESH_TIMEOUT;
use crate::config::MAX_APPLY_MANIFEST_BYTES;
use crate::git;
use crate::git_tokens;
use crate::routes::{self, AppState};
use serde_json::Value as JsonValue;

pub struct OriginHttpServer {
    config: Arc<ServerConfig>,
    http_client: reqwest::Client,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_handle: Option<JoinHandle<()>>,
    presence_tx: Option<oneshot::Sender<()>>,
    presence_handle: Option<JoinHandle<()>>,
    address: Option<SocketAddr>,
    presence_url: Option<Url>,
    presence_metadata: Arc<RwLock<JsonValue>>,
}

pub struct ServerStart {
    pub address: SocketAddr,
}

impl OriginHttpServer {
    pub fn new(config: ServerConfig) -> Result<Self> {
        if config.multi_tenant {
            crate::apply::validate_multi_tenant_apply_fd_contract()
                .context("origin apply file-descriptor contract is not satisfied")?;
        }
        let http_client = reqwest::Client::builder()
            .user_agent("instafy-origin-http/0.1")
            .timeout(Duration::from_secs(20))
            .build()
            .context("failed to construct HTTP client")?;

        let default_metadata = serde_json::json!({
            "source": "origin-http-server"
        });
        Ok(Self {
            config: Arc::new(config),
            http_client,
            shutdown_tx: None,
            server_handle: None,
            presence_tx: None,
            presence_handle: None,
            address: None,
            presence_url: None,
            presence_metadata: Arc::new(RwLock::new(default_metadata)),
        })
    }

    pub async fn start(&mut self) -> Result<ServerStart> {
        if self.server_handle.is_some() {
            anyhow::bail!("origin server already started");
        }

        tokio::fs::create_dir_all(&self.config.workspace_root)
            .await
            .with_context(|| {
                format!(
                    "failed to create workspace root at {:?}",
                    self.config.workspace_root
                )
            })?;

        let canonical_root = self
            .canonicalize_workspace_root()
            .await
            .context("failed to canonicalize workspace root")?;
        if canonical_root != self.config.workspace_root {
            let mut canonical_config = (*self.config).clone();
            canonical_config.workspace_root = canonical_root.clone();
            self.config = Arc::new(canonical_config);
        }

        if !self.config.multi_tenant {
            if let Some(remote_url) = self
                .config
                .git_remote_url_for_project(self.config.project_id)
            {
                let token = git_tokens::mint_git_access_token(
                    &self.http_client,
                    self.config.as_ref(),
                    self.config.project_id,
                    &["git.read"],
                    None,
                )
                .await
                .map(|value| value.map(|minted| minted.token))
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                let mut config = (*self.config).clone();
                config.git_remote_url = Some(remote_url);
                tokio::task::spawn_blocking(move || {
                    git::ensure_git_checkout(&config, token.as_deref())
                })
                .await
                .context("git workspace checkout task failed")?
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            }
        }

        let token_validator =
            TokenValidator::new(self.http_client.clone(), self.config.jwks_url.clone());

        let commit_url = self
            .config
            .controller_commit_receipt_url()
            .ok()
            .filter(|_| self.config.controller_internal_token.is_some());

        let state = AppState::new(
            self.config.clone(),
            token_validator,
            self.http_client.clone(),
            canonical_root,
            commit_url,
        )
        .context("failed to open workspace root capability")?;

        let router = routes::router(state).layer(
            ServiceBuilder::new()
                .layer(TraceLayer::new_for_http().make_span_with(
                    |request: &axum::http::Request<axum::body::Body>| {
                        // Origin access tokens can be carried in query strings
                        // for browser-native image/media requests. Never record
                        // the query in tracing output.
                        tracing::info_span!(
                            "http_request",
                            method = %request.method(),
                            path = %request.uri().path(),
                            version = ?request.version(),
                        )
                    },
                ))
                .layer(RequestBodyLimitLayer::new(self.body_limit())),
        );

        let listener = TcpListener::bind((self.config.bind_host.as_str(), self.config.bind_port))
            .await
            .with_context(|| {
                format!(
                    "failed to bind origin server to {}:{}",
                    self.config.bind_host, self.config.bind_port
                )
            })?;

        let local_addr = listener
            .local_addr()
            .context("failed to determine listener address")?;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server =
            axum::serve(listener, router.into_make_service()).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });

        let handle = tokio::spawn(async move {
            if let Err(error) = server.await {
                warn!(?error, "origin HTTP server exited with error");
            }
        });

        self.spawn_presence().await?;

        self.address = Some(local_addr);
        self.shutdown_tx = Some(shutdown_tx);
        self.server_handle = Some(handle);

        Ok(ServerStart {
            address: local_addr,
        })
    }

    /// Final WIP checkpoint. Workspaces are git-canonical working copies on an
    /// ephemeral node disk: after-run syncs cover finished work, but a graceful
    /// stop (idle pause, credit stop, node drain) may hold uncommitted changes
    /// from an in-flight session. Push them before the container dies so a
    /// later node replacement cannot lose them. Best-effort and time-boxed —
    /// shutdown must never hang past the container's stop grace period.
    async fn flush_workspace_before_shutdown(&self) {
        if self.config.multi_tenant {
            return;
        }
        let Some(remote_url) = self
            .config
            .git_remote_url_for_project(self.config.project_id)
        else {
            return;
        };

        // Only flush when there is genuinely something to save: a clean tree
        // must not touch git at all (no alignment, no push) — a machine that
        // was merely behind the remote would otherwise checkpoint stale
        // contents over externally pushed commits.
        let dirty_check_root = self.config.workspace_root.clone();
        let dirty = tokio::task::spawn_blocking(move || {
            git::list_dirty_files(dirty_check_root.as_path(), None)
        })
        .await;
        match dirty {
            Ok(Ok(entries)) if entries.is_empty() => return,
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                warn!(?error, "shutdown flush: dirty check failed; skipping flush");
                return;
            }
            Err(join_error) => {
                warn!(?join_error, "shutdown flush: dirty check task failed");
                return;
            }
        }

        let token = match git_tokens::mint_git_access_token(
            &self.http_client,
            self.config.as_ref(),
            self.config.project_id,
            &["git.read", "git.write"],
            None,
        )
        .await
        {
            Ok(Some(minted)) => minted.token,
            Ok(None) => {
                warn!("shutdown flush: no caller-bound git write credential; skipping flush");
                return;
            }
            Err(error) => {
                warn!(?error, "shutdown flush: failed to mint git token");
                return;
            }
        };
        let mut config = (*self.config).clone();
        config.git_remote_url = Some(remote_url);
        let flush = tokio::task::spawn_blocking(move || {
            let workspace_root = config.workspace_root.clone();
            // No pre-alignment: WIP is committed on the local HEAD and the
            // push loop rebases onto the remote tip if it moved, preserving
            // external commits instead of reverting them.
            git::commit_and_push_dirty_without_align(
                &config,
                workspace_root.as_path(),
                "instafy: checkpoint before machine stop",
                Some(token.as_str()),
            )
        });
        match tokio::time::timeout(std::time::Duration::from_secs(25), flush).await {
            Ok(Ok(Ok(commit))) => {
                info!(commit = %commit, "flushed workspace changes before shutdown");
            }
            Ok(Ok(Err(error))) => warn!(?error, "shutdown workspace flush failed"),
            Ok(Err(join_error)) => warn!(?join_error, "shutdown workspace flush task failed"),
            Err(_) => warn!("shutdown workspace flush timed out"),
        }
    }

    /// Stop WITHOUT flushing — for error-path cleanup (e.g. registration
    /// failure) where the controller may be unreachable and no user work is
    /// at stake.
    pub async fn stop(&mut self) -> Result<()> {
        self.stop_inner(false).await
    }

    /// Graceful machine shutdown: checkpoint uncommitted workspace changes to
    /// the canonical git remote, then stop.
    pub async fn stop_flushing_workspace(&mut self) -> Result<()> {
        self.stop_inner(true).await
    }

    async fn stop_inner(&mut self, flush: bool) -> Result<()> {
        if flush {
            self.flush_workspace_before_shutdown().await;
        }
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }

        if let Some(handle) = self.server_handle.take() {
            if let Err(error) = handle.await {
                warn!(?error, "origin HTTP server task join failed");
            }
        }

        if let Some(tx) = self.presence_tx.take() {
            let _ = tx.send(());
        }

        if let Some(handle) = self.presence_handle.take() {
            if let Err(error) = handle.await {
                warn!(?error, "origin presence task join failed");
            }
        }

        if let Some(url) = self.presence_url.clone() {
            if let Err(error) = beat_with_recovery(
                &self.http_client,
                &url,
                &self.config,
                "offline",
                self.presence_metadata.clone(),
            )
            .await
            {
                warn!(?error, "failed to send offline presence beat");
            }
        }

        Ok(())
    }

    fn body_limit(&self) -> usize {
        // Allow archive plus manifest/form overhead.
        let extra = (MAX_APPLY_MANIFEST_BYTES as u64).saturating_add(4 * 1024 * 1024);
        let total = self.config.max_archive_bytes.saturating_add(extra);
        total.min(usize::MAX as u64) as usize
    }

    async fn canonicalize_workspace_root(&self) -> Result<PathBuf> {
        let path = self.config.workspace_root.clone();
        tokio::task::spawn_blocking(move || std::fs::canonicalize(path))
            .await
            .context("workspace canonicalization task failed")?
            .with_context(|| "failed to canonicalize workspace root")
    }

    async fn spawn_presence(&mut self) -> Result<()> {
        if self.config.multi_tenant {
            return Ok(());
        }
        if !self.config.enable_presence_heartbeat {
            return Ok(());
        }

        if self.config.current_controller_token().is_none() {
            return Ok(());
        }

        let presence_url = match self.config.controller_presence_url() {
            Ok(url) => url,
            Err(error) => {
                warn!(
                    ?error,
                    "presence heartbeat disabled: controller presence URL unavailable"
                );
                return Ok(());
            }
        };

        let (tx, mut rx) = oneshot::channel::<()>();
        let config = self.config.clone();
        let client = self.http_client.clone();
        let presence_url_clone = presence_url.clone();
        let metadata = self.presence_metadata.clone();

        let interval = self.config.presence_interval;
        let handle = tokio::spawn(async move {
            let mut ticker = time::interval(interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

            if let Err(error) = beat_with_recovery(
                &client,
                &presence_url_clone,
                &config,
                "online",
                metadata.clone(),
            )
            .await
            {
                warn!(?error, "presence heartbeat failed");
            }

            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        if let Err(error) = beat_with_recovery(
                            &client,
                            &presence_url_clone,
                            &config,
                            "online",
                            metadata.clone(),
                        )
                        .await
                        {
                            warn!(?error, "presence heartbeat failed");
                        }
                    }
                    _ = &mut rx => break,
                }
            }
        });

        self.presence_tx = Some(tx);
        self.presence_handle = Some(handle);
        self.presence_url = Some(presence_url);
        Ok(())
    }
}

/// How the controller answered a single presence beat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BeatOutcome {
    Accepted,
    Rejected(reqwest::StatusCode),
}

/// One beat, plus the two recoveries a long-lived presence loop needs:
///
/// * 404 — a startup race between `origin/register` and the first beat; retried
///   once after a short pause, as before;
/// * 401/403 — the controller credential lapsed. Ask the runtime agent to renew
///   it (issue #144) and retry exactly once with whatever it publishes. When no
///   renewal arrives we return the error and let the next tick try again, so a
///   dead credential costs one extra request per interval instead of a spin.
async fn beat_with_recovery(
    client: &reqwest::Client,
    url: &Url,
    config: &ServerConfig,
    status: &str,
    metadata: Arc<RwLock<JsonValue>>,
) -> Result<()> {
    beat_with_recovery_within(
        client,
        url,
        config,
        status,
        metadata,
        CONTROLLER_TOKEN_REFRESH_TIMEOUT,
    )
    .await
}

async fn beat_with_recovery_within(
    client: &reqwest::Client,
    url: &Url,
    config: &ServerConfig,
    status: &str,
    metadata: Arc<RwLock<JsonValue>>,
    refresh_timeout: Duration,
) -> Result<()> {
    match send_presence_beat(client, url, config, status, metadata.clone()).await? {
        BeatOutcome::Accepted => Ok(()),
        BeatOutcome::Rejected(rejected)
            if rejected == reqwest::StatusCode::UNAUTHORIZED
                || rejected == reqwest::StatusCode::FORBIDDEN =>
        {
            warn!(
                %rejected,
                "presence beat rejected; requesting a controller token renewal"
            );
            if !config.refresh_controller_token(refresh_timeout).await {
                anyhow::bail!(
                    "presence beat rejected with {rejected} and no renewed controller token arrived"
                );
            }
            match send_presence_beat(client, url, config, status, metadata).await? {
                BeatOutcome::Accepted => {
                    info!("presence heartbeat recovered with a renewed controller token");
                    Ok(())
                }
                BeatOutcome::Rejected(retried) => anyhow::bail!(
                    "presence beat still rejected after a controller token renewal: status={retried}"
                ),
            }
        }
        BeatOutcome::Rejected(reqwest::StatusCode::NOT_FOUND) => {
            // Smooth the startup race (register -> beat ordering).
            time::sleep(Duration::from_millis(250)).await;
            match send_presence_beat(client, url, config, status, metadata).await? {
                BeatOutcome::Accepted => Ok(()),
                BeatOutcome::Rejected(retried) => {
                    anyhow::bail!("presence beat returned error status {retried}")
                }
            }
        }
        BeatOutcome::Rejected(rejected) => {
            anyhow::bail!("presence beat returned error status {rejected}")
        }
    }
}

async fn send_presence_beat(
    client: &reqwest::Client,
    url: &Url,
    config: &ServerConfig,
    status: &str,
    metadata: Arc<RwLock<JsonValue>>,
) -> Result<BeatOutcome> {
    // Resolved per beat: registration renewals in the embedding runtime agent
    // update the shared source, and a spawn-time snapshot would 401 forever
    // once the original token expires (issue #144).
    let Some(token) = config.current_controller_token() else {
        anyhow::bail!("presence beat skipped: no controller token available");
    };
    let current_metadata = {
        let guard = metadata.read().await;
        guard.clone()
    };
    let payload = serde_json::json!({
        "projectId": config.project_id,
        "originId": config.origin_id,
        "status": status,
        "metadata": current_metadata,
    });

    let response = client
        .post(url.clone())
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .context("presence heartbeat request failed")?;

    let status_code = response.status();
    if status_code.is_success() {
        Ok(BeatOutcome::Accepted)
    } else {
        Ok(BeatOutcome::Rejected(status_code))
    }
}

impl OriginHttpServer {
    pub async fn set_presence_metadata(&self, metadata: JsonValue) {
        if metadata.is_null() {
            return;
        }
        let mut guard = self.presence_metadata.write().await;
        *guard = metadata;
    }

    pub fn presence_metadata_handle(&self) -> Arc<RwLock<JsonValue>> {
        self.presence_metadata.clone()
    }
}

#[cfg(test)]
mod presence_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode as AxumStatus};
    use axum::routing::post;
    use axum::Router;
    use tokio::net::TcpListener;

    use crate::config::ControllerTokenStore;

    use super::*;

    const REFRESH_TIMEOUT: Duration = Duration::from_secs(5);
    const NO_OWNER_TIMEOUT: Duration = Duration::from_millis(50);

    #[derive(Clone)]
    struct MockController {
        /// Only this bearer is accepted; everything else gets the production
        /// 401 the runtime saw on `origin/presence/beat`.
        accepted: Arc<std::sync::RwLock<String>>,
        bearers: Arc<std::sync::Mutex<Vec<Option<String>>>>,
        calls: Arc<AtomicUsize>,
    }

    async fn beat_handler(
        State(state): State<MockController>,
        headers: HeaderMap,
        body: String,
    ) -> (AxumStatus, String) {
        let _ = body;
        state.calls.fetch_add(1, Ordering::SeqCst);
        let presented = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        state.bearers.lock().unwrap().push(presented.clone());

        let expected = format!(
            "Bearer {}",
            state.accepted.read().unwrap_or_else(|p| p.into_inner())
        );
        if presented.as_deref() == Some(expected.as_str()) {
            (AxumStatus::OK, "{}".to_string())
        } else {
            (
                AxumStatus::UNAUTHORIZED,
                r#"{"message":"agent token expired"}"#.to_string(),
            )
        }
    }

    async fn spawn_mock_controller(state: MockController) -> Url {
        let router = Router::new()
            .route("/presence/beat", post(beat_handler))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock controller");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });
        format!("http://{addr}/presence/beat")
            .parse()
            .expect("presence url")
    }

    fn presence_config(source: Option<crate::config::SharedControllerToken>) -> ServerConfig {
        ServerConfig {
            project_id: uuid::Uuid::new_v4(),
            origin_id: uuid::Uuid::new_v4(),
            workspace_root: PathBuf::from("/tmp"),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "Instafy".into(),
            git_author_email: "instafy@example.invalid".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1/".parse().expect("base url"),
            controller_internal_token: Some("spawn-time-token".into()),
            controller_token_source: source,
            jwks_url: "http://127.0.0.1:1/jwks".parse().expect("jwks url"),
            skip_auth: false,
            enable_presence_heartbeat: true,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 1024,
            staging_base: None,
            multi_tenant: false,
        }
    }

    fn metadata() -> Arc<RwLock<JsonValue>> {
        Arc::new(RwLock::new(serde_json::json!({"source": "test"})))
    }

    fn mock(accepted: &str) -> MockController {
        MockController {
            accepted: Arc::new(std::sync::RwLock::new(accepted.to_string())),
            bearers: Arc::new(std::sync::Mutex::new(Vec::new())),
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// A beat the controller accepts must not touch the renewal machinery at
    /// all: one request, no refresh request raised.
    #[tokio::test]
    async fn an_accepted_beat_sends_exactly_one_request() {
        let store: crate::config::SharedControllerToken =
            Arc::new(ControllerTokenStore::new(Some("good-token".into())));
        let controller = mock("good-token");
        let url = spawn_mock_controller(controller.clone()).await;
        let config = presence_config(Some(store.clone()));

        beat_with_recovery_within(
            &reqwest::Client::new(),
            &url,
            &config,
            "online",
            metadata(),
            REFRESH_TIMEOUT,
        )
        .await
        .expect("beat accepted");

        assert_eq!(controller.calls.load(Ordering::SeqCst), 1);
        assert_eq!(store.generation(), 0, "no renewal should have been needed");
    }

    /// Reproduces instafy-dev/instafy#144: the presence loop 401s because the
    /// credential it is handed has lapsed. It must pull a renewal through the
    /// shared source and retry with the token the renewal published — without
    /// the process restarting.
    #[tokio::test]
    async fn a_rejected_beat_renews_and_retries_once() {
        let store: crate::config::SharedControllerToken =
            Arc::new(ControllerTokenStore::new(Some("expired-token".into())));
        let controller = mock("renewed-token");
        let url = spawn_mock_controller(controller.clone()).await;
        let config = presence_config(Some(store.clone()));

        // Stands in for the runtime agent's registration/renewal task.
        let owner = store.clone();
        let registrations = Arc::new(AtomicUsize::new(0));
        let counter = registrations.clone();
        tokio::spawn(async move {
            loop {
                owner.refresh_requested().await;
                counter.fetch_add(1, Ordering::SeqCst);
                owner.store("renewed-token".into());
            }
        });

        beat_with_recovery_within(
            &reqwest::Client::new(),
            &url,
            &config,
            "online",
            metadata(),
            REFRESH_TIMEOUT,
        )
        .await
        .expect("beat recovers after the renewal");

        assert_eq!(
            controller.calls.load(Ordering::SeqCst),
            2,
            "one rejected beat plus exactly one retry"
        );
        assert_eq!(registrations.load(Ordering::SeqCst), 1);
        let bearers = controller.bearers.lock().unwrap().clone();
        assert_eq!(
            bearers,
            vec![
                Some("Bearer expired-token".to_string()),
                Some("Bearer renewed-token".to_string()),
            ]
        );
    }

    /// The other half of "exactly once": when a renewal never lands, the beat
    /// must fail out to the caller rather than retrying. The loop's own tick is
    /// the only thing that may try again.
    #[tokio::test]
    async fn a_rejected_beat_does_not_retry_when_no_renewal_arrives() {
        let store: crate::config::SharedControllerToken =
            Arc::new(ControllerTokenStore::new(Some("expired-token".into())));
        let controller = mock("renewed-token");
        let url = spawn_mock_controller(controller.clone()).await;
        let config = presence_config(Some(store));

        let error = beat_with_recovery_within(
            &reqwest::Client::new(),
            &url,
            &config,
            "online",
            metadata(),
            NO_OWNER_TIMEOUT,
        )
        .await
        .expect_err("no renewal, so the beat fails");

        assert!(
            format!("{error:#}").contains("no renewed controller token arrived"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            controller.calls.load(Ordering::SeqCst),
            1,
            "the rejected beat must not be retried without a fresh credential"
        );
    }

    /// A renewal that lands but is still rejected must stop after that single
    /// retry instead of asking for renewal again.
    #[tokio::test]
    async fn a_beat_rejected_after_renewal_stops_retrying() {
        let store: crate::config::SharedControllerToken =
            Arc::new(ControllerTokenStore::new(Some("expired-token".into())));
        let controller = mock("never-issued-token");
        let url = spawn_mock_controller(controller.clone()).await;
        let config = presence_config(Some(store.clone()));

        let owner = store.clone();
        let registrations = Arc::new(AtomicUsize::new(0));
        let counter = registrations.clone();
        tokio::spawn(async move {
            loop {
                owner.refresh_requested().await;
                counter.fetch_add(1, Ordering::SeqCst);
                owner.store("still-wrong-token".into());
            }
        });

        let error = beat_with_recovery_within(
            &reqwest::Client::new(),
            &url,
            &config,
            "online",
            metadata(),
            REFRESH_TIMEOUT,
        )
        .await
        .expect_err("the renewed token is rejected too");

        assert!(
            format!("{error:#}").contains("still rejected after a controller token renewal"),
            "unexpected error: {error:#}"
        );
        assert_eq!(controller.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            registrations.load(Ordering::SeqCst),
            1,
            "one renewal per beat, not a renewal loop"
        );
    }

    /// Guards the pre-existing startup-race behavior: a 404 is still retried
    /// once after a short pause, and does not consume a token renewal.
    #[tokio::test]
    async fn a_404_beat_is_retried_without_requesting_a_renewal() {
        #[derive(Clone)]
        struct NotFoundThenOk {
            calls: Arc<AtomicUsize>,
        }
        async fn handler(State(state): State<NotFoundThenOk>, body: String) -> AxumStatus {
            let _ = body;
            if state.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                AxumStatus::NOT_FOUND
            } else {
                AxumStatus::OK
            }
        }

        let state = NotFoundThenOk {
            calls: Arc::new(AtomicUsize::new(0)),
        };
        let router = Router::new()
            .route("/presence/beat", post(handler))
            .with_state(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });
        let url: Url = format!("http://{addr}/presence/beat")
            .parse()
            .expect("presence url");

        let store: crate::config::SharedControllerToken =
            Arc::new(ControllerTokenStore::new(Some("token".into())));
        let config = presence_config(Some(store.clone()));

        beat_with_recovery_within(
            &reqwest::Client::new(),
            &url,
            &config,
            "online",
            metadata(),
            NO_OWNER_TIMEOUT,
        )
        .await
        .expect("the 404 retry still succeeds");

        assert_eq!(state.calls.load(Ordering::SeqCst), 2);
        assert_eq!(store.generation(), 0, "a 404 is not a credential problem");
    }
}
