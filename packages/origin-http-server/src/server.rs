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
            if let Err(error) = send_presence_beat(
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

            if let Err(error) = send_presence_beat(
                &client,
                &presence_url_clone,
                &config,
                "online",
                metadata.clone(),
            )
            .await
            {
                // Retry immediately on 404 to smooth startup races (register → beat ordering)
                let maybe_404 = error
                    .downcast_ref::<reqwest::Error>()
                    .and_then(|e| e.status())
                    .map(|s| s == reqwest::StatusCode::NOT_FOUND)
                    .unwrap_or(false);
                if maybe_404 {
                    time::sleep(std::time::Duration::from_millis(250)).await;
                    if let Err(retry_err) = send_presence_beat(
                        &client,
                        &presence_url_clone,
                        &config,
                        "online",
                        metadata.clone(),
                    )
                    .await
                    {
                        warn!(?retry_err, "presence heartbeat retry failed");
                    }
                } else {
                    warn!(?error, "presence heartbeat failed");
                }
            }

            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        if let Err(error) = send_presence_beat(
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

async fn send_presence_beat(
    client: &reqwest::Client,
    url: &Url,
    config: &ServerConfig,
    status: &str,
    metadata: Arc<RwLock<JsonValue>>,
) -> Result<()> {
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

    client
        .post(url.clone())
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .context("presence heartbeat request failed")?
        .error_for_status()
        .context("presence heartbeat returned error status")?;

    Ok(())
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
