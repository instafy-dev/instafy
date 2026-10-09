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
use crate::hosted::{park_legacy_checkouts, HostedGatewayConfig, HostedState, MirrorCache};
use crate::route_auth::RouteAuth;
use crate::routes::{self, AppState};
use serde_json::Value as JsonValue;

/// The durable-stop marker: written into a hosted checkout's repository by a
/// shutdown whose final state was durable (its flush left nothing
/// local-only, so canonical holds everything the folder held),
/// holding [`crate::working_state::DURABLE_MARKER`], and removed when an
/// origin starts there. Checkout eviction keeps any checkout without it: the
/// runtime that last used it crashed, was killed, could not save, or left
/// work only this node holds. A Desktop folder or a checkout without a
/// remote never gets it.
///
/// Every shutdown decides it again: it is removed before the shutdown's
/// flush and written back only by a durable answer, so a marker another
/// runtime on the same folder left, or one the workspace wrote itself,
/// never outlives a shutdown that was not durable or could not run. Taking
/// the workspace lock removes it too, so a sibling runtime that saves,
/// publishes or refreshes after another's durable stop clears that stop's
/// verdict. That bounds a sibling's exposure only while its rolling saves
/// get grants: its next tick that gets one clears the marker (about one
/// save interval while grants succeed). With saves off, or once its ticks
/// ended (a refused grant, an expired token), a sibling killed without a
/// shutdown of its own can leave its edits since its last save under
/// another runtime's marker until eviction, or until a pool-retirement
/// drain reads the checkout as clean (the marker and no local recovery
/// ref) and the node is deleted. It sits in a directory the workspace can
/// write, so it is a hint for eviction to combine with what it can check
/// itself, never proof on its own.
pub const CLEAN_STOP_MARKER: &str = ".instafy/.git/instafy-stopped-clean";

/// How long a shutdown waits for a rolling save to let the workspace go.
const SHUTDOWN_LOCK_WAIT: Duration = Duration::from_secs(10);

pub(crate) fn clear_clean_stop_marker(workspace_root: &std::path::Path) {
    match crate::workspace_fs::WorkspaceDir::open(workspace_root)
        .and_then(|workspace| workspace.remove(CLEAN_STOP_MARKER))
    {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warn!(%error, "could not clear the clean-stop marker"),
    }
}

/// Write [`CLEAN_STOP_MARKER`] when the folder's state after a shutdown's
/// flush is durable; otherwise remove any, so eviction keeps the checkout.
/// That flush has just stored a local copy of everything canonical does not
/// hold: it stores no `unsaved` copy only where the folder's last confirmed
/// save holds the same work, and none of work already pushed (or dismissed
/// by a person). So the stop is durable exactly when nothing is local-only,
/// whether or not this process ever saved: with rolling saves off, or when
/// a stop's own save failed and its `unsaved` copy was pushed instead.
fn record_durable_stop(
    ctx: &crate::publish::PublishContext<'_>,
    memory: &crate::working_state::WorkingMemory,
) {
    match crate::working_state::local_state(ctx, memory) {
        Ok(state) if state.local_only == 0 => {
            let mut marker: &[u8] = crate::working_state::DURABLE_MARKER;
            if let Err(error) = crate::workspace_fs::WorkspaceDir::open(ctx.workspace_root)
                .and_then(|workspace| workspace.replace_file(CLEAN_STOP_MARKER, &mut marker, false))
            {
                warn!(%error, "could not record the durable stop");
            }
        }
        Ok(state) => {
            clear_clean_stop_marker(ctx.workspace_root);
            info!(
                local_only = state.local_only,
                unsaved = state.unsaved,
                "the stop is not durable; the checkout keeps its work for the next start"
            )
        }
        Err(error) => {
            clear_clean_stop_marker(ctx.workspace_root);
            warn!(error = %format!("{error:#}"), "could not read the working state at shutdown")
        }
    }
}

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
    state: Option<AppState>,
    /// Set for a multi-tenant gateway, which serves the hosted routes.
    hosted: Option<Arc<HostedGatewayConfig>>,
    /// The gateway's cache sweeper, stopped with the server.
    sweeper: Option<JoinHandle<()>>,
}

pub struct ServerStart {
    pub address: SocketAddr,
}

/// Lets the process hosting a single-tenant origin bring the checkout up to
/// date without a write credential, under the same locks the routes take.
#[derive(Clone)]
pub struct CheckoutRefresher {
    state: AppState,
}

impl CheckoutRefresher {
    /// Fetch canonical `main` with the origin's own read credential and move
    /// the checkout to it when the checkout holds nothing unpublished.
    /// Nothing is pushed.
    pub async fn refresh_read_only(
        &self,
    ) -> Result<crate::publish::PublishReport, crate::error::OriginError> {
        routes::refresh_checkout_read_only(&self.state).await
    }
}

/// Lets the process hosting a single-tenant origin ask what its working
/// folder holds that canonical does not, in process: no network, no
/// credential, no lock (see [`crate::working_state::local_state`]).
#[derive(Clone)]
pub struct WorkingStateReader {
    state: AppState,
}

impl WorkingStateReader {
    pub async fn state(
        &self,
    ) -> Result<crate::working_state::WorkingState, crate::error::OriginError> {
        let state = self.state.clone();
        tokio::task::spawn_blocking(move || {
            let mut config = (*state.config).clone();
            config.workspace_root = state.workspace_root.as_ref().clone();
            config.git_remote_url = config.git_remote_url_for_project(config.project_id);
            crate::working_state::local_state(
                &crate::publish::PublishContext {
                    config: &config,
                    workspace_root: state.workspace_root.as_path(),
                    token: None,
                    can_write: false,
                },
                &state.working_memory,
            )
            .map_err(|error| crate::error::OriginError::internal(format!("{error:#}")))
        })
        .await
        .map_err(|error| {
            crate::error::OriginError::internal(format!("working state task failed: {error}"))
        })?
    }
}

impl OriginHttpServer {
    /// An origin for `config`. A multi-tenant gateway gets the default
    /// gateway settings; use [`Self::new_hosted`] to choose them.
    pub fn new(config: ServerConfig) -> Result<Self> {
        if config.multi_tenant {
            return Self::new_hosted(config, HostedGatewayConfig::default());
        }
        Self::build(config, None)
    }

    /// The multi-tenant gateway: `config` must be multi-tenant and pass
    /// [`ServerConfig::validate_multi_tenant`].
    pub fn new_hosted(config: ServerConfig, hosted: HostedGatewayConfig) -> Result<Self> {
        if !config.multi_tenant {
            anyhow::bail!("the hosted gateway needs a multi-tenant configuration");
        }
        config.validate_multi_tenant()?;
        Self::build(config, Some(Arc::new(hosted)))
    }

    fn build(config: ServerConfig, hosted: Option<Arc<HostedGatewayConfig>>) -> Result<Self> {
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
            state: None,
            hosted,
            sweeper: None,
        })
    }

    /// The read-only checkout refresh for this origin, once it has started.
    /// `None` for a multi-tenant gateway, whose checkouts are not this
    /// process's to move.
    pub fn checkout_refresher(&self) -> Option<CheckoutRefresher> {
        if self.config.multi_tenant {
            return None;
        }
        self.state.clone().map(|state| CheckoutRefresher { state })
    }

    /// The in-process [`WorkingStateReader`] of a hosted checkout with a
    /// canonical remote, once the origin has started. `None` for a Desktop
    /// folder, a checkout without a remote and the multi-tenant gateway:
    /// their folders never take rolling saves.
    pub fn working_state_reader(&self) -> Option<WorkingStateReader> {
        if self.config.multi_tenant
            || !self.config.hosted_checkout
            || self
                .config
                .git_remote_url_for_project(self.config.project_id)
                .is_none()
        {
            return None;
        }
        self.state.clone().map(|state| WorkingStateReader { state })
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
        if self.config.hosted_checkout && !self.config.multi_tenant {
            // From now on the checkout holds work only this process can keep.
            clear_clean_stop_marker(&self.config.workspace_root);
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

        if !self.config.multi_tenant
            && crate::git::instafy_git_dir(&self.config.workspace_root).is_dir()
        {
            // Fetch namespaces a call that died left behind keep recovery
            // commits reachable for good; remove the stale ones in the
            // background, so a held lock never delays the listener.
            let root = self.config.workspace_root.clone();
            tokio::task::spawn_blocking(move || {
                let removed = crate::recovery_view::sweep_stale_fetches(
                    &crate::workspace_git::WorkspaceGit::new(&root, None),
                );
                if removed > 0 {
                    info!(removed, "removed refs left by interrupted recovery fetches");
                }
            });
        }

        let token_validator =
            TokenValidator::new(self.http_client.clone(), self.config.jwks_url.clone());

        let router = match self.hosted.clone() {
            Some(hosted) => {
                self.hosted_router(hosted, token_validator, &canonical_root)
                    .await?
            }
            None => {
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
                self.state = Some(state.clone());
                routes::router(state)
            }
        };

        let router = router.layer(
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

    /// The gateway's routes. Before anything is served, every working copy
    /// the stateful gateway left in the root is moved to `.legacy/`, so an
    /// older image started on this volume later clones fresh instead of
    /// saving old drafts; a failure stops the start.
    async fn hosted_router(
        &mut self,
        hosted: Arc<HostedGatewayConfig>,
        token_validator: TokenValidator,
        root: &std::path::Path,
    ) -> Result<axum::Router> {
        let parked_root = root.to_path_buf();
        let parked = tokio::task::spawn_blocking(move || park_legacy_checkouts(&parked_root))
            .await
            .context("moving old gateway working copies failed")?
            .context("could not move old gateway working copies to .legacy; refusing to start")?;
        if !parked.moved.is_empty() || parked.removed_empty > 0 {
            info!(
                moved = parked.moved.len(),
                removed_empty = parked.removed_empty,
                "moved old gateway working copies out of the workspace root"
            );
        }
        let cache_root = root.to_path_buf();
        let config = self.config.clone();
        let http = self.http_client.clone();
        let max_bytes = hosted.cache_max_bytes;
        let cache = tokio::task::spawn_blocking(move || {
            MirrorCache::open(&cache_root, config, http, max_bytes)
        })
        .await
        .context("opening the mirror cache failed")?
        .context("could not open the mirror cache")?;
        let cache = Arc::new(cache);
        self.sweeper = Some(cache.spawn_sweeper());
        let state = HostedState::new(
            RouteAuth {
                config: self.config.clone(),
                token_validator,
                http_client: self.http_client.clone(),
            },
            cache,
        );
        Ok(crate::hosted::router(state))
    }

    /// Last chance to keep work when the process stops. Hosted runtime
    /// checkouts only: a Desktop folder belongs to the user and keeps its
    /// files. Nothing reaches `main` from here. Finished local commits are
    /// kept on a local `unpublished` recovery ref (and stay on the branch for
    /// the next refresh to publish), and unsaved edits (or the whole turn,
    /// when `turn_active`) on local `unsaved` refs, all without any network
    /// call. A machine credential cannot mint `git.write`, so those refs are
    /// pushed by the next publish or refresh. The controller calls
    /// `POST /git/flush` with a write credential before it stops a runtime;
    /// this is the fallback for stops it did not drive. It raises the stop
    /// flag, so a rolling save in flight gives up, and waits up to
    /// [`SHUTDOWN_LOCK_WAIT`] for the workspace rather than skipping, so an
    /// unfinished turn always steps back. It writes [`CLEAN_STOP_MARKER`]
    /// only when the folder's final state is durable. Best-effort and
    /// time-boxed, so shutdown never outlasts the stop grace period.
    async fn flush_workspace_before_shutdown(&self, turn_active: bool) {
        if self.config.multi_tenant || !self.config.hosted_checkout {
            return;
        }
        // Only this shutdown's own durable answer leaves a marker: one left
        // by another runtime on this folder, or by the workspace, goes now,
        // whether or not the flush below runs.
        let root = self.config.workspace_root.clone();
        let _ = tokio::task::spawn_blocking(move || clear_clean_stop_marker(&root)).await;
        let Some(remote_url) = self
            .config
            .git_remote_url_for_project(self.config.project_id)
        else {
            return;
        };
        let (memory, stop) = match self.state.as_ref() {
            Some(state) => (state.working_memory.clone(), Some(state.stop_flag.clone())),
            None => (crate::working_state::WorkingMemory::default(), None),
        };
        if let Some(stop) = stop.as_ref() {
            // The process is ending: the flag stays up for good.
            std::mem::forget(stop.raise());
        }
        let mut config = (*self.config).clone();
        config.git_remote_url = Some(remote_url);
        let flush = tokio::task::spawn_blocking(move || {
            let workspace_root = config.workspace_root.clone();
            let Some(_lock) = crate::workspace_lock::acquire_workspace_apply_lock_within(
                &workspace_root,
                SHUTDOWN_LOCK_WAIT,
            )?
            else {
                return Err(crate::error::OriginError::conflict(
                    "the workspace stayed busy; skipping the shutdown flush",
                ));
            };
            let ctx = crate::publish::PublishContext {
                config: &config,
                workspace_root: workspace_root.as_path(),
                token: None,
                can_write: false,
            };
            let report = crate::publish::flush_at_shutdown(&ctx, turn_active)?;
            record_durable_stop(&ctx, &memory);
            Ok(report)
        });
        match tokio::time::timeout(std::time::Duration::from_secs(25), flush).await {
            Ok(Ok(Ok(report))) => {
                info!(
                    parked = report.recovery_refs.len(),
                    unpushed = report.unpushed_refs,
                    "kept workspace changes before shutdown"
                );
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
        self.stop_inner(None).await
    }

    /// Graceful machine shutdown: keep unsaved workspace changes on local
    /// recovery refs, then stop.
    pub async fn stop_flushing_workspace(&mut self) -> Result<()> {
        self.stop_inner(Some(false)).await
    }

    /// Like [`Self::stop_flushing_workspace`], for a stop that interrupted a
    /// turn: the turn's local commits are parked instead of published later.
    pub async fn stop_flushing_workspace_during_turn(&mut self, turn_active: bool) -> Result<()> {
        self.stop_inner(Some(turn_active)).await
    }

    /// The working folder's in-process memory and stop flag, for tests that
    /// drive a save next to a shutdown.
    #[cfg(test)]
    pub(crate) fn app_state(&self) -> Option<AppState> {
        self.state.clone()
    }

    async fn stop_inner(&mut self, flush: Option<bool>) -> Result<()> {
        if let Some(turn_active) = flush {
            self.flush_workspace_before_shutdown(turn_active).await;
        }
        self.state = None;
        if let Some(sweeper) = self.sweeper.take() {
            sweeper.abort();
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
            hosted_checkout: false,
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

#[cfg(test)]
mod hosted_start_tests {
    use super::*;

    fn gateway_config(root: &std::path::Path) -> ServerConfig {
        ServerConfig {
            project_id: uuid::Uuid::nil(),
            origin_id: uuid::Uuid::nil(),
            workspace_root: root.to_path_buf(),
            git_remote_url: None,
            git_remote_base_url: Some("http://127.0.0.1:1".into()),
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "instafy-origin".into(),
            git_author_email: "gateway@instafy.dev".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1/".parse().expect("base url"),
            controller_internal_token: None,
            controller_token_source: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().expect("jwks url"),
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 1024 * 1024,
            staging_base: None,
            multi_tenant: true,
            hosted_checkout: false,
        }
    }

    #[test]
    fn a_gateway_with_one_repository_for_every_space_does_not_start() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = gateway_config(dir.path());
        config.git_remote_url = Some("http://127.0.0.1:1/one.git".into());
        let error = OriginHttpServer::new(config.clone())
            .err()
            .expect("refused");
        assert!(format!("{error:#}").contains("ORIGIN_GIT_REMOTE_URL"));
        assert!(
            OriginHttpServer::new_hosted(config, HostedGatewayConfig::default()).is_err(),
            "the gateway constructor checks too"
        );

        let mut config = gateway_config(dir.path());
        config.git_remote_base_url = None;
        let error = OriginHttpServer::new(config).err().expect("refused");
        assert!(format!("{error:#}").contains("ORIGIN_GIT_REMOTE_BASE_URL"));

        let mut config = gateway_config(dir.path());
        config.multi_tenant = false;
        assert!(OriginHttpServer::new_hosted(config, HostedGatewayConfig::default()).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_gateway_moves_old_working_copies_before_it_listens() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let space = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(root.join(&space).join(".instafy/.git")).unwrap();
        std::fs::write(root.join(&space).join("draft.md"), "draft\n").unwrap();

        let mut server = OriginHttpServer::new(gateway_config(&root)).unwrap();
        let start = server.start().await.unwrap();

        assert!(!root.join(&space).exists());
        assert_eq!(
            std::fs::read_to_string(root.join(".legacy").join(&space).join("draft.md")).unwrap(),
            "draft\n"
        );
        let health = reqwest::get(format!("http://{}/healthz", start.address))
            .await
            .unwrap();
        assert_eq!(health.status(), reqwest::StatusCode::OK);
        // No browser routes on the gateway.
        let browser = reqwest::get(format!("http://{}/browser/capabilities", start.address))
            .await
            .unwrap();
        assert_eq!(browser.status(), reqwest::StatusCode::NOT_FOUND);
        assert!(server.checkout_refresher().is_none());
        server.stop().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_gateway_that_cannot_move_old_working_copies_does_not_listen() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let space = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(root.join(&space)).unwrap();
        std::fs::write(root.join(&space).join("draft.md"), "draft\n").unwrap();
        // `.legacy` is a file: nothing can be moved into it.
        std::fs::write(root.join(".legacy"), "not a folder").unwrap();

        let mut server = OriginHttpServer::new(gateway_config(&root)).unwrap();
        let error = server.start().await.err().expect("the start fails");

        assert!(format!("{error:#}").contains(".legacy"), "{error:#}");
        assert!(server.address.is_none(), "nothing was bound");
        assert!(root.join(&space).join("draft.md").is_file());
    }
}
