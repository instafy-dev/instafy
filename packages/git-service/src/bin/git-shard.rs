use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::routing::{any, get};
use axum::Router;
use tracing::{debug, info, warn};

use git_service::config::GitShardConfig;
use git_service::error::ServiceError;
use git_service::events::{
    build_push_event_payload, diff_refs, dispatch_push_event, is_receive_pack_request,
    snapshot_refs,
};
use git_service::git_http_backend::run_git_http_backend;
use git_service::repo::ensure_repo_exists;
use git_service::routing::parse_repo_segment;

#[derive(Clone)]
struct AppState {
    config: Arc<GitShardConfig>,
    webhook_http: reqwest::Client,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,git_service=info".to_string()),
        )
        .init();

    let config = Arc::new(GitShardConfig::from_env()?);
    tokio::fs::create_dir_all(&config.repo_root).await?;

    let bind_host = config.bind_host.clone();
    let bind_port = config.bind_port;
    let repo_root = config.repo_root.clone();

    let app_state = AppState {
        config,
        webhook_http: reqwest::Client::builder()
            .user_agent("instafy-git-shard/0.1")
            .build()?,
    };

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/*path", any(handle_git))
        .with_state(app_state);

    let addr: SocketAddr = format!("{}:{}", bind_host, bind_port).parse()?;
    info!(%addr, repo_root = ?repo_root, "git-shard listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app.into_make_service())
        .await
        .map_err(Into::into)
}

async fn handle_git(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ServiceError> {
    let (parts, body) = request.into_parts();

    let path = parts.uri.path().to_string();
    let (repo_dir, _repo_name) = parse_repo_segment(&path)?;
    let config = state.config.clone();

    // Ensure repo exists (optionally auto-init). This is blocking filesystem/git work.
    let repo_dir_for_init = repo_dir.clone();
    tokio::task::spawn_blocking(move || ensure_repo_exists(&config, &repo_dir_for_init))
        .await
        .map_err(|error| ServiceError::internal(format!("repo init task failed: {error}")))??;

    let track_push_event =
        state.config.events_webhook.is_some() && is_receive_pack_request(&parts.method, &parts.uri);
    let refs_before = if track_push_event {
        capture_refs_snapshot(&state.config.repo_root.join(&repo_dir)).await
    } else {
        None
    };

    let repo_root = state
        .config
        .repo_root
        .to_str()
        .ok_or_else(|| ServiceError::internal("repo root is not valid utf-8"))?
        .to_string();

    let response =
        run_git_http_backend(&repo_root, &parts.method, &parts.uri, &parts.headers, body).await;

    if let Err(error) = &response {
        warn!(?error, "git-shard request failed");
    }

    if track_push_event
        && response
            .as_ref()
            .map(|resp| resp.status().is_success())
            .unwrap_or(false)
    {
        let refs_after = capture_refs_snapshot(&state.config.repo_root.join(&repo_dir)).await;
        if let (Some(before), Some(after), Some(webhook)) =
            (refs_before, refs_after, state.config.events_webhook.clone())
        {
            let updates = diff_refs(&before, &after);
            if let Some(payload) =
                build_push_event_payload(&repo_dir, &state.config.default_branch, updates)
            {
                let client = state.webhook_http.clone();
                tokio::spawn(async move {
                    if let Err(error) = dispatch_push_event(&client, &webhook, &payload).await {
                        warn!(
                            ?error,
                            repo = %payload.repo,
                            project_id = ?payload.project_id,
                            "git push webhook dispatch failed"
                        );
                    } else {
                        debug!(
                            repo = %payload.repo,
                            project_id = ?payload.project_id,
                            updates = payload.updates.len(),
                            "git push webhook dispatched"
                        );
                    }
                });
            }
        }
    }

    response
}

async fn capture_refs_snapshot(
    repo_path: &PathBuf,
) -> Option<std::collections::BTreeMap<String, String>> {
    let repo_path_for_log = repo_path.clone();
    let repo_path_for_task = repo_path.clone();
    match tokio::task::spawn_blocking(move || snapshot_refs(&repo_path_for_task)).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            warn!(?error, repo = %repo_path_for_log.display(), "failed to snapshot refs");
            None
        }
        Err(error) => {
            warn!(?error, repo = %repo_path_for_log.display(), "refs snapshot task failed");
            None
        }
    }
}
