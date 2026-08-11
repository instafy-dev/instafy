use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::routing::{any, get};
use axum::Router;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::RwLock;
use tracing::info;

use git_service::auth::{extract_token, TokenValidator};
use git_service::config::{GitEdgeConfig, GitEdgeRoutingMode};
use git_service::error::ServiceError;
use git_service::routing::{
    parse_repo_segment, pick_shard_index, required_scope, GIT_DELETE_RESULT_ABSENT,
    GIT_DELETE_RESULT_DELETED, GIT_DELETE_RESULT_HEADER, GIT_DELETE_SCOPE,
};

#[derive(Clone)]
struct AppState {
    config: Arc<GitEdgeConfig>,
    http: reqwest::Client,
    validator: TokenValidator,
    route_cache: Arc<RwLock<std::collections::HashMap<String, CachedRoute>>>,
}

#[derive(Clone, Debug)]
struct CachedRoute {
    shard: reqwest::Url,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitShardRouteResponse {
    shard_url: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,git_service=info".to_string()),
        )
        .init();

    let config = Arc::new(GitEdgeConfig::from_env()?);
    let http = reqwest::Client::builder()
        .user_agent("instafy-git-edge/0.1")
        .build()?;
    let validator = TokenValidator::new(http.clone(), config.jwks_url.clone());

    let bind_host = config.bind_host.clone();
    let bind_port = config.bind_port;
    let shards = config.shards.clone();

    let state = AppState {
        config,
        http,
        validator,
        route_cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
    };

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/*path", any(handle_proxy))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", bind_host, bind_port).parse()?;
    info!(%addr, shards = ?shards, "git-edge listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app.into_make_service())
        .await
        .map_err(Into::into)
}

async fn handle_proxy(
    State(state): State<AppState>,
    request: Request,
) -> Result<axum::response::Response, ServiceError> {
    let (parts, body) = request.into_parts();
    let uri = parts.uri.clone();

    let path = uri.path().to_string();
    let (_repo_dir, repo_name) = parse_repo_segment(&path)?;
    let scope = required_scope(&parts.method, uri.path(), uri.query())?;

    // GIT_EDGE_SKIP_AUTH is a local Smart HTTP convenience. Destructive
    // requests remain authenticated even when that development switch is on.
    if request_requires_auth(state.config.skip_auth, scope) {
        let token = extract_token(&parts.headers)?;
        let claims = state
            .validator
            .validate(&token, Some(&state.config.audience))
            .await?;

        if claims.protocol.as_deref() != Some("git") {
            return Err(ServiceError::forbidden("token protocol mismatch"));
        }
        if claims.project_id != repo_name {
            return Err(ServiceError::forbidden("project mismatch"));
        }
        if !claims.scopes.iter().any(|value| value == scope) {
            return Err(ServiceError::forbidden(format!(
                "missing required scope {scope}"
            )));
        }
    }

    let shard_idx = pick_shard_index(&repo_name, state.config.shards.len());
    let shard_base = match state.config.routing_mode {
        GitEdgeRoutingMode::Hash => state
            .config
            .shards
            .get(shard_idx)
            .ok_or_else(|| ServiceError::internal("shard routing failed"))?
            .clone(),
        GitEdgeRoutingMode::Controller => resolve_shard_via_controller(&state, &repo_name).await?,
    };

    let response = proxy_request(
        &state.http,
        shard_base,
        &parts.method,
        &parts.headers,
        &uri,
        body,
    )
    .await?;
    if scope == GIT_DELETE_SCOPE {
        validate_delete_result(response)
    } else {
        Ok(response)
    }
}

fn request_requires_auth(skip_auth: bool, required_scope: &str) -> bool {
    !skip_auth || required_scope == GIT_DELETE_SCOPE
}

fn validate_delete_result(
    response: axum::response::Response,
) -> Result<axum::response::Response, ServiceError> {
    let expected_result = match response.status() {
        StatusCode::NO_CONTENT => GIT_DELETE_RESULT_DELETED,
        StatusCode::NOT_FOUND => GIT_DELETE_RESULT_ABSENT,
        _ => {
            return Err(ServiceError::bad_gateway(
                "git shard returned an invalid repository deletion status",
            ));
        }
    };

    let mut results = response.headers().get_all(GIT_DELETE_RESULT_HEADER).iter();
    let result = results
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| *value == expected_result);
    if result.is_none() || results.next().is_some() {
        return Err(ServiceError::bad_gateway(
            "git shard omitted the exact repository deletion acknowledgement",
        ));
    }

    Ok(response)
}

async fn resolve_shard_via_controller(
    state: &AppState,
    project_id: &str,
) -> Result<reqwest::Url, ServiceError> {
    let now = Instant::now();
    {
        let guard = state.route_cache.read().await;
        if let Some(entry) = guard.get(project_id) {
            if entry.expires_at > now {
                return Ok(entry.shard.clone());
            }
        }
    }

    let base = state.config.controller_url.clone().ok_or_else(|| {
        ServiceError::internal("controller routing enabled but controller URL is missing")
    })?;

    let mut url = base.clone();
    url.path_segments_mut()
        .map_err(|_| ServiceError::internal("invalid controller base URL"))?
        .extend(["projects", project_id, "git", "shard"]);

    let mut req = state.http.get(url);
    if let Some(token) = state.config.controller_token.as_deref() {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|error| {
        ServiceError::internal(format!("controller shard lookup failed: {error}"))
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(ServiceError::internal(format!(
            "controller shard lookup failed: status={status} body={text}"
        )));
    }

    let payload: GitShardRouteResponse = resp.json().await.map_err(|error| {
        ServiceError::internal(format!("invalid controller shard response: {error}"))
    })?;

    let shard = reqwest::Url::parse(payload.shard_url.trim()).map_err(|error| {
        ServiceError::internal(format!("invalid shardUrl from controller: {error}"))
    })?;

    let ttl = Duration::from_secs(state.config.route_cache_seconds);
    let mut guard = state.route_cache.write().await;
    guard.insert(
        project_id.to_string(),
        CachedRoute {
            shard: shard.clone(),
            expires_at: now + ttl,
        },
    );

    Ok(shard)
}

async fn proxy_request(
    client: &reqwest::Client,
    shard_base: reqwest::Url,
    method: &Method,
    headers: &HeaderMap,
    uri: &Uri,
    body: axum::body::Body,
) -> Result<axum::response::Response, ServiceError> {
    let mut upstream = shard_base.clone();
    let path = uri.path().trim_start_matches('/');
    upstream
        .path_segments_mut()
        .map_err(|_| ServiceError::internal("invalid shard base URL"))?
        .pop_if_empty()
        .extend(path.split('/'));
    upstream.set_query(uri.query());

    let body_stream = body.into_data_stream();
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| ServiceError::bad_request("invalid HTTP method"))?;
    let mut req = client.request(reqwest_method, upstream);

    for (name, value) in headers.iter() {
        if name == axum::http::header::HOST || name.as_str() == GIT_DELETE_RESULT_HEADER {
            continue;
        }
        let Ok(value_str) = value.to_str() else {
            continue;
        };
        req = req.header(name.as_str(), value_str);
    }

    req = req.body(reqwest::Body::wrap_stream(body_stream.map(|chunk| {
        chunk.map_err(|error| {
            io::Error::new(
                io::ErrorKind::Other,
                format!("upstream body error: {error}"),
            )
        })
    })));

    let resp = req
        .send()
        .await
        .map_err(|error| ServiceError::internal(format!("upstream request failed: {error}")))?;

    let status = resp.status();
    let mut out_headers = axum::http::HeaderMap::new();
    for (name, value) in resp.headers().iter() {
        let Ok(header_name) = axum::http::header::HeaderName::from_bytes(name.as_str().as_bytes())
        else {
            continue;
        };
        let Ok(header_value) = axum::http::HeaderValue::from_bytes(value.as_bytes()) else {
            continue;
        };
        out_headers.append(header_name, header_value);
    }

    let stream = resp
        .bytes_stream()
        .map(|item| item.map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error)));

    let mut response = axum::response::Response::new(axum::body::Body::from_stream(stream));
    *response.status_mut() = axum::http::StatusCode::from_u16(status.as_u16())
        .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
    *response.headers_mut() = out_headers;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_deletion_never_inherits_skip_auth() {
        assert!(request_requires_auth(false, "git.read"));
        assert!(!request_requires_auth(true, "git.read"));
        assert!(request_requires_auth(false, GIT_DELETE_SCOPE));
        assert!(request_requires_auth(true, GIT_DELETE_SCOPE));
    }

    fn upstream_delete_response(
        status: StatusCode,
        result: Option<&str>,
    ) -> axum::response::Response {
        let mut response = axum::response::Response::new(axum::body::Body::empty());
        *response.status_mut() = status;
        if let Some(result) = result {
            response.headers_mut().insert(
                GIT_DELETE_RESULT_HEADER,
                axum::http::HeaderValue::from_str(result).unwrap(),
            );
        }
        response
    }

    #[test]
    fn delete_proxy_requires_status_bound_new_shard_acknowledgement() {
        for (status, result) in [
            (StatusCode::NO_CONTENT, None),
            (StatusCode::NOT_FOUND, None),
            (StatusCode::NO_CONTENT, Some(GIT_DELETE_RESULT_ABSENT)),
            (StatusCode::NOT_FOUND, Some(GIT_DELETE_RESULT_DELETED)),
            (StatusCode::OK, Some(GIT_DELETE_RESULT_DELETED)),
        ] {
            let error = validate_delete_result(upstream_delete_response(status, result))
                .expect_err("unacknowledged delete response was accepted");
            assert_eq!(error.status_code(), StatusCode::BAD_GATEWAY);
        }

        let deleted = validate_delete_result(upstream_delete_response(
            StatusCode::NO_CONTENT,
            Some(GIT_DELETE_RESULT_DELETED),
        ))
        .expect("new shard deleted acknowledgement");
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            deleted
                .headers()
                .get(GIT_DELETE_RESULT_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(GIT_DELETE_RESULT_DELETED)
        );

        let absent = validate_delete_result(upstream_delete_response(
            StatusCode::NOT_FOUND,
            Some(GIT_DELETE_RESULT_ABSENT),
        ))
        .expect("new shard absent acknowledgement");
        assert_eq!(absent.status(), StatusCode::NOT_FOUND);

        let mut duplicated =
            upstream_delete_response(StatusCode::NO_CONTENT, Some(GIT_DELETE_RESULT_DELETED));
        duplicated.headers_mut().append(
            GIT_DELETE_RESULT_HEADER,
            axum::http::HeaderValue::from_static(GIT_DELETE_RESULT_DELETED),
        );
        assert_eq!(
            validate_delete_result(duplicated)
                .expect_err("duplicate delete acknowledgement was accepted")
                .status_code(),
            StatusCode::BAD_GATEWAY
        );
    }
}
