use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{any, get};
use axum::Router;
use tracing::{debug, info, warn};

use git_service::auth::{extract_token, TokenValidator};
use git_service::config::GitShardConfig;
use git_service::error::ServiceError;
use git_service::events::{
    build_push_event_payload, diff_refs, dispatch_push_event, is_receive_pack_request,
    snapshot_refs,
};
use git_service::git_http_backend::run_git_http_backend;
use git_service::repo::{delete_bare_repo, ensure_repo_exists};
use git_service::routing::{
    is_exact_repo_root_delete, parse_repo_segment, GIT_DELETE_RESULT_ABSENT,
    GIT_DELETE_RESULT_DELETED, GIT_DELETE_RESULT_HEADER, GIT_DELETE_SCOPE,
};
use runtime_contracts::{
    AccessTokenClaims, GIT_DELETE_TOKEN_SUBJECT, GIT_DELETE_TOKEN_TTL_SECONDS,
};

#[derive(Clone)]
struct AppState {
    config: Arc<GitShardConfig>,
    webhook_http: reqwest::Client,
    delete_validator: TokenValidator,
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

    let http = reqwest::Client::builder()
        .user_agent("instafy-git-shard/0.1")
        .build()?;
    let delete_validator = TokenValidator::new(http.clone(), config.jwks_url.clone());
    let app_state = AppState {
        config,
        webhook_http: http,
        delete_validator,
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
    let (repo_dir, repo_name) = parse_repo_segment(&path)?;
    let config = state.config.clone();

    // DELETE is intentionally not part of Git Smart HTTP. Handle the one
    // authenticated edge shape before the auto-init path so cleanup cannot
    // recreate an already-absent repository.
    if is_exact_repo_root_delete(&parts.method, &path, parts.uri.query())? {
        authorize_repository_delete(&state, &parts.headers, &repo_name).await?;
        return handle_authorized_repository_delete(config, repo_dir).await;
    }

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

async fn authorize_repository_delete(
    state: &AppState,
    headers: &HeaderMap,
    repo_name: &str,
) -> Result<(), ServiceError> {
    let token = extract_token(headers)?;
    let claims = state
        .delete_validator
        .validate(&token, Some(&state.config.audience))
        .await?;
    validate_repository_delete_claims(&claims, repo_name)
}

fn validate_repository_delete_claims(
    claims: &AccessTokenClaims,
    repo_name: &str,
) -> Result<(), ServiceError> {
    if claims.protocol.as_deref() != Some("git") {
        return Err(ServiceError::forbidden("token protocol mismatch"));
    }
    if claims.project_id != repo_name {
        return Err(ServiceError::forbidden("project mismatch"));
    }
    if claims.sub != GIT_DELETE_TOKEN_SUBJECT {
        return Err(ServiceError::forbidden(
            "repository deletion token subject mismatch",
        ));
    }
    if claims.scopes.as_slice() != [GIT_DELETE_SCOPE] {
        return Err(ServiceError::forbidden(
            "repository deletion requires exact git.delete scope",
        ));
    }
    if claims.origin_id.is_some()
        || claims.runtime_id.is_some()
        || claims.lease_id.is_some()
        || claims.runtime_generation.is_some()
        || claims.run_id.is_some()
        || claims.prefer_runtime.is_some()
        || claims.actor_label.is_some()
        || claims.browser_session_id.is_some()
    {
        return Err(ServiceError::forbidden(
            "repository deletion token must be controller-scoped",
        ));
    }
    if claims.exp.checked_sub(claims.iat) != Some(GIT_DELETE_TOKEN_TTL_SECONDS) {
        return Err(ServiceError::forbidden(
            "repository deletion token lifetime mismatch",
        ));
    }
    Ok(())
}

async fn handle_authorized_repository_delete(
    config: Arc<GitShardConfig>,
    repo_dir: String,
) -> Result<axum::response::Response, ServiceError> {
    let result = tokio::task::spawn_blocking(move || delete_bare_repo(&config, &repo_dir))
        .await
        .map_err(|error| ServiceError::internal(format!("repo delete task failed: {error}")))?;

    match result {
        Ok(()) => Ok(repository_delete_response(
            StatusCode::NO_CONTENT,
            GIT_DELETE_RESULT_DELETED,
        )),
        Err(ServiceError::NotFound(_)) => Ok(repository_delete_response(
            StatusCode::NOT_FOUND,
            GIT_DELETE_RESULT_ABSENT,
        )),
        Err(error) => Err(error),
    }
}

fn repository_delete_response(
    status: StatusCode,
    result: &'static str,
) -> axum::response::Response {
    let mut response = axum::response::Response::new(Body::empty());
    *response.status_mut() = status;
    response.headers_mut().insert(
        GIT_DELETE_RESULT_HEADER,
        axum::http::HeaderValue::from_static(result),
    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    fn test_state(repo_root: PathBuf, auto_init: bool) -> AppState {
        let config = Arc::new(GitShardConfig {
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            repo_root,
            auto_init,
            default_branch: "main".to_string(),
            jwks_url: reqwest::Url::parse("http://127.0.0.1/jwks").unwrap(),
            audience: "git".to_string(),
            events_webhook: None,
        });
        let http = reqwest::Client::new();
        AppState {
            delete_validator: TokenValidator::new(http.clone(), config.jwks_url.clone()),
            config,
            webhook_http: http,
        }
    }

    fn valid_delete_claims(project_id: uuid::Uuid) -> AccessTokenClaims {
        AccessTokenClaims {
            aud: "git".to_string(),
            sub: GIT_DELETE_TOKEN_SUBJECT.to_string(),
            project_id: project_id.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: Some("git".to_string()),
            scopes: vec![GIT_DELETE_SCOPE.to_string()],
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: 1_700_000_000,
            exp: 1_700_000_000 + GIT_DELETE_TOKEN_TTL_SECONDS,
            jti: uuid::Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }
    }

    #[test]
    fn shard_delete_claims_are_exact_and_controller_scoped() {
        let project_id = uuid::Uuid::new_v4();
        let claims = valid_delete_claims(project_id);
        let project_name = project_id.to_string();
        validate_repository_delete_claims(&claims, &project_name).expect("exact delete claims");

        macro_rules! reject_binding {
            ($label:literal, $field:ident, $value:expr) => {{
                let mut candidate = claims.clone();
                candidate.$field = $value;
                assert!(
                    validate_repository_delete_claims(&candidate, &project_name).is_err(),
                    "{} binding was accepted",
                    $label
                );
            }};
        }

        let mut read = claims.clone();
        read.scopes = vec!["git.read".to_string()];
        assert!(validate_repository_delete_claims(&read, &project_name).is_err());

        let mut mixed = claims.clone();
        mixed.scopes.push("git.read".to_string());
        assert!(validate_repository_delete_claims(&mixed, &project_name).is_err());

        let mut wrong_protocol = claims.clone();
        wrong_protocol.protocol = Some("http".to_string());
        assert!(validate_repository_delete_claims(&wrong_protocol, &project_name).is_err());

        let mut wrong_subject = claims.clone();
        wrong_subject.sub = uuid::Uuid::new_v4().to_string();
        assert!(validate_repository_delete_claims(&wrong_subject, &project_name).is_err());

        let mut long_lived = claims.clone();
        long_lived.exp += 1;
        assert!(validate_repository_delete_claims(&long_lived, &project_name).is_err());

        reject_binding!("origin", origin_id, Some(uuid::Uuid::new_v4().to_string()));
        reject_binding!(
            "runtime",
            runtime_id,
            Some(uuid::Uuid::new_v4().to_string())
        );
        reject_binding!("lease", lease_id, Some(uuid::Uuid::new_v4().to_string()));
        reject_binding!(
            "runtime generation",
            runtime_generation,
            Some(uuid::Uuid::new_v4().to_string())
        );
        reject_binding!("run", run_id, Some(uuid::Uuid::new_v4().to_string()));
        reject_binding!(
            "preferred runtime",
            prefer_runtime,
            Some(uuid::Uuid::new_v4().to_string())
        );
        reject_binding!("actor label", actor_label, Some("operator".to_string()));
        reject_binding!(
            "browser session",
            browser_session_id,
            Some("browser-session".to_string())
        );

        assert!(
            validate_repository_delete_claims(&claims, &uuid::Uuid::new_v4().to_string()).is_err()
        );
    }

    #[tokio::test]
    async fn unauthenticated_delete_never_auto_initializes_a_missing_repository(
    ) -> anyhow::Result<()> {
        let temp_root = unique_temp_dir("instafy-git-shard-delete-missing");
        let repo_root = temp_root.join("repos");
        std::fs::create_dir_all(&repo_root)?;
        let project_id = uuid::Uuid::new_v4();
        let repo_path = repo_root.join(format!("{project_id}.git"));
        let state = test_state(repo_root, true);

        let result = handle_git(
            State(state),
            Request::builder()
                .method("DELETE")
                .uri(format!("/{project_id}.git"))
                .body(Body::empty())?,
        )
        .await;

        assert!(matches!(result, Err(ServiceError::Unauthorized(_))));
        assert!(!repo_path.exists());

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[tokio::test]
    async fn exact_delete_returns_no_content_then_not_found() -> anyhow::Result<()> {
        let temp_root = unique_temp_dir("instafy-git-shard-delete-existing");
        let repo_root = temp_root.join("repos");
        std::fs::create_dir_all(&repo_root)?;
        let project_id = uuid::Uuid::new_v4();
        let repo_dir = format!("{project_id}.git");
        let repo_path = repo_root.join(&repo_dir);
        let state = test_state(repo_root, true);
        ensure_repo_exists(state.config.as_ref(), &repo_dir)?;

        let response =
            handle_authorized_repository_delete(state.config.clone(), repo_dir.clone()).await?;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response
                .headers()
                .get(GIT_DELETE_RESULT_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(GIT_DELETE_RESULT_DELETED)
        );
        assert!(!repo_path.exists());

        let repeated = handle_authorized_repository_delete(state.config, repo_dir).await?;
        assert_eq!(repeated.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            repeated
                .headers()
                .get(GIT_DELETE_RESULT_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(GIT_DELETE_RESULT_ABSENT)
        );
        assert!(!repo_path.exists());

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }

    #[tokio::test]
    async fn nearby_delete_path_fails_before_auto_init() -> anyhow::Result<()> {
        let temp_root = unique_temp_dir("instafy-git-shard-delete-nearby");
        let repo_root = temp_root.join("repos");
        std::fs::create_dir_all(&repo_root)?;
        let project_id = uuid::Uuid::new_v4();
        let repo_path = repo_root.join(format!("{project_id}.git"));
        let state = test_state(repo_root, true);

        let result = handle_git(
            State(state),
            Request::builder()
                .method("DELETE")
                .uri(format!("/{project_id}.git/info/refs"))
                .body(Body::empty())?,
        )
        .await;

        assert!(matches!(result, Err(ServiceError::BadRequest(_))));
        assert!(!repo_path.exists());

        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }
}
