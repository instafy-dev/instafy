use serde::{Deserialize, Serialize};

use crate::config::ServerConfig;
use crate::error::OriginError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitAccessTokenRequest<'a> {
    scopes: &'a [&'a str],
    #[serde(skip_serializing_if = "Option::is_none")]
    ttl_seconds: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitAccessTokenResponse {
    token: String,
    expires_in: i64,
}

#[derive(Debug)]
pub struct MintedGitToken {
    pub token: String,
    pub expires_in: i64,
}

pub async fn mint_git_access_token(
    client: &reqwest::Client,
    config: &ServerConfig,
    project_id: uuid::Uuid,
    scopes: &[&str],
    origin_access_token: Option<&str>,
) -> Result<Option<MintedGitToken>, OriginError> {
    let mut token_candidates = Vec::new();
    let requests_write = scopes
        .iter()
        .any(|scope| scope.trim().eq_ignore_ascii_case("git.write"));
    let caller_token = origin_access_token
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if requests_write {
        // The controller's internal credential is shared by the gateway and
        // is not bound to a user's active workspace lease. Never use it to
        // mint git.write: only the exact fs.write bearer that authorized this
        // origin request may be exchanged for the short-lived Git child.
        let token = caller_token.ok_or_else(|| {
            OriginError::unauthorized("origin fs.write token is required to mint git.write access")
        })?;
        token_candidates.push(token);
    } else {
        // Keep machine bootstrap/fetch behavior for read-only Git access.
        if let Some(token) = config
            .controller_internal_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            token_candidates.push(token);
        }

        if let Some(token) = caller_token {
            token_candidates.push(token);
        }
    }

    if token_candidates.is_empty() {
        return Ok(None);
    }

    let mut url = config.controller_base_url.clone();
    url.path_segments_mut()
        .map_err(|_| OriginError::internal("controller base url missing path segments"))?
        .extend(["projects", &project_id.to_string(), "git", "access_token"]);

    let mut last_error: Option<OriginError> = None;

    for (index, token) in token_candidates.iter().enumerate() {
        let response = client
            .post(url.clone())
            .bearer_auth(token)
            .json(&GitAccessTokenRequest {
                scopes,
                ttl_seconds: Some(if requests_write { 60 } else { 600 }),
            })
            .send()
            .await
            .map_err(|error| OriginError::internal(format!("git token request failed: {error}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let error = OriginError::internal(format!(
                "git token request failed: status={status} body={body}"
            ));

            let should_try_next = index + 1 < token_candidates.len()
                && matches!(
                    status,
                    reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
                );
            if should_try_next {
                last_error = Some(error);
                continue;
            }
            return Err(error);
        }

        let payload: GitAccessTokenResponse = response.json().await.map_err(|error| {
            OriginError::internal(format!("git token response parse failed: {error}"))
        })?;

        if payload.token.trim().is_empty() {
            return Err(OriginError::internal("git token response missing token"));
        }

        return Ok(Some(MintedGitToken {
            token: payload.token,
            expires_in: payload.expires_in,
        }));
    }

    match last_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::mint_git_access_token;

    use crate::config::ServerConfig;
    use axum::extract::{Path, State};
    use axum::http::{header, HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex;
    use uuid::Uuid;

    #[derive(Clone, Default)]
    struct ControllerStubState {
        calls: Arc<Mutex<Vec<String>>>,
    }

    async fn handle_git_access_token(
        State(state): State<ControllerStubState>,
        Path(_project_id): Path<String>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let auth_header = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();

        state.calls.lock().await.push(auth_header.clone());

        if auth_header == "Bearer internal-token" {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "message": "unauthorized" })),
            );
        }

        if auth_header == "Bearer privileged-internal-token" {
            return (
                StatusCode::OK,
                Json(json!({ "token": "service-git-token", "expiresIn": 600 })),
            );
        }

        if auth_header == "Bearer user-token" {
            return (
                StatusCode::OK,
                Json(json!({ "token": "git-token", "expiresIn": 600 })),
            );
        }

        (
            StatusCode::FORBIDDEN,
            Json(json!({ "message": "unexpected token" })),
        )
    }

    fn build_config(project_id: Uuid, controller_base_url: reqwest::Url) -> ServerConfig {
        ServerConfig {
            project_id,
            origin_id: Uuid::new_v4(),
            workspace_root: PathBuf::from("."),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".to_string(),
            git_remote_name: "origin".to_string(),
            git_author_name: "instafy-origin".to_string(),
            git_author_email: "origin@instafy.dev".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            controller_base_url: controller_base_url.clone(),
            controller_internal_token: Some("internal-token".to_string()),
            controller_token_source: None,
            jwks_url: controller_base_url,
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: std::time::Duration::from_secs(10),
            max_archive_bytes: 1024,
            staging_base: None,
            multi_tenant: false,
        }
    }

    async fn start_controller_stub() -> (
        ControllerStubState,
        reqwest::Url,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let state = ControllerStubState::default();
        let app = Router::new()
            .route(
                "/projects/:project_id/git/access_token",
                post(handle_git_access_token),
            )
            .with_state(state.clone());

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("server");
        });

        (
            state,
            reqwest::Url::parse(&format!("http://{addr}")).expect("url"),
            shutdown_tx,
            server,
        )
    }

    #[tokio::test]
    async fn read_token_mint_falls_back_to_origin_token_on_unauthorized() {
        let state = ControllerStubState::default();
        let app = Router::new()
            .route(
                "/projects/:project_id/git/access_token",
                post(handle_git_access_token),
            )
            .with_state(state.clone());

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("server");
        });

        let project_id = Uuid::new_v4();
        let config = build_config(
            project_id,
            reqwest::Url::parse(&format!("http://{}", addr)).expect("url"),
        );

        let client = reqwest::Client::new();
        let minted = mint_git_access_token(
            &client,
            &config,
            project_id,
            &["git.read"],
            Some("user-token"),
        )
        .await
        .expect("mint token")
        .expect("expected token");

        assert_eq!(minted.token, "git-token");
        assert_eq!(minted.expires_in, 600);

        let calls = state.calls.lock().await.clone();
        assert_eq!(
            calls,
            vec![
                "Bearer internal-token".to_string(),
                "Bearer user-token".to_string()
            ]
        );

        let _ = shutdown_tx.send(());
        let _ = server.await;
    }

    #[tokio::test]
    async fn mint_git_access_token_uses_origin_token_when_internal_missing() {
        let state = ControllerStubState::default();
        let app = Router::new()
            .route(
                "/projects/:project_id/git/access_token",
                post(handle_git_access_token),
            )
            .with_state(state.clone());

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("server");
        });

        let project_id = Uuid::new_v4();
        let mut config = build_config(
            project_id,
            reqwest::Url::parse(&format!("http://{}", addr)).expect("url"),
        );
        config.controller_internal_token = None;

        let client = reqwest::Client::new();
        let minted = mint_git_access_token(
            &client,
            &config,
            project_id,
            &["git.read"],
            Some("user-token"),
        )
        .await
        .expect("mint token")
        .expect("expected token");

        assert_eq!(minted.token, "git-token");

        let calls = state.calls.lock().await.clone();
        assert_eq!(calls, vec!["Bearer user-token".to_string()]);

        let _ = shutdown_tx.send(());
        let _ = server.await;
    }

    #[tokio::test]
    async fn git_write_uses_only_origin_token_even_when_internal_can_mint() {
        let (state, controller_url, shutdown_tx, server) = start_controller_stub().await;
        let project_id = Uuid::new_v4();
        let mut config = build_config(project_id, controller_url);
        config.controller_internal_token = Some("privileged-internal-token".to_string());

        let minted = mint_git_access_token(
            &reqwest::Client::new(),
            &config,
            project_id,
            &["git.read", "git.write"],
            Some("user-token"),
        )
        .await
        .expect("mint token")
        .expect("expected token");

        assert_eq!(minted.token, "git-token");
        assert_eq!(
            state.calls.lock().await.as_slice(),
            ["Bearer user-token".to_string()]
        );

        let _ = shutdown_tx.send(());
        let _ = server.await;
    }

    #[tokio::test]
    async fn git_write_without_origin_token_fails_before_internal_exchange() {
        let (state, controller_url, shutdown_tx, server) = start_controller_stub().await;
        let project_id = Uuid::new_v4();
        let mut config = build_config(project_id, controller_url);
        config.controller_internal_token = Some("privileged-internal-token".to_string());

        let error = mint_git_access_token(
            &reqwest::Client::new(),
            &config,
            project_id,
            &["git.write"],
            None,
        )
        .await
        .expect_err("git.write without a caller token must fail closed");

        assert!(error
            .to_string()
            .contains("origin fs.write token is required"));
        assert!(state.calls.lock().await.is_empty());

        let _ = shutdown_tx.send(());
        let _ = server.await;
    }

    #[tokio::test]
    async fn rejected_git_write_origin_token_never_falls_back_to_internal() {
        let (state, controller_url, shutdown_tx, server) = start_controller_stub().await;
        let project_id = Uuid::new_v4();
        let mut config = build_config(project_id, controller_url);
        config.controller_internal_token = Some("privileged-internal-token".to_string());

        mint_git_access_token(
            &reqwest::Client::new(),
            &config,
            project_id,
            &["git.write"],
            Some("stale-origin-token"),
        )
        .await
        .expect_err("a rejected caller token must not fall back to internal auth");

        assert_eq!(
            state.calls.lock().await.as_slice(),
            ["Bearer stale-origin-token".to_string()]
        );

        let _ = shutdown_tx.send(());
        let _ = server.await;
    }
}
