use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::request::Parts;
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
    authorize_request_claims, is_forwardable_request_header, parse_repo_segment, pick_shard_index,
    push_scope_assertion, required_scope, GIT_DELETE_RESULT_ABSENT, GIT_DELETE_RESULT_DELETED,
    GIT_DELETE_RESULT_HEADER, GIT_DELETE_SCOPE, GIT_PUSH_SCOPE_HEADER,
};
use runtime_contracts::AccessTokenClaims;

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
    let (_repo_dir, repo_name) = parse_repo_segment(parts.uri.path())?;
    let scope = required_scope(&parts.method, parts.uri.path(), parts.uri.query())?;

    // GIT_EDGE_SKIP_AUTH is a local Smart HTTP convenience. Destructive
    // requests remain authenticated even when that development switch is on.
    let claims = if request_requires_auth(state.config.skip_auth, scope) {
        let token = extract_token(&parts.headers)?;
        Some(
            state
                .validator
                .validate(&token, Some(&state.config.audience))
                .await?,
        )
    } else {
        None
    };
    forward(&state, parts, body, &repo_name, claims.as_ref()).await
}

/// Send a request on to its shard once `claims` (validated; `None` only
/// where no credential is needed) allow it. A push only a rolling save's
/// credential allows is marked with [`GIT_PUSH_SCOPE_HEADER`], so the
/// shard limits it; the client's own copy of that header never passes.
async fn forward(
    state: &AppState,
    parts: Parts,
    body: axum::body::Body,
    repo_name: &str,
    claims: Option<&AccessTokenClaims>,
) -> Result<axum::response::Response, ServiceError> {
    let uri = &parts.uri;
    let scope = required_scope(&parts.method, uri.path(), uri.query())?;
    let mut push_scope = None;
    if let Some(claims) = claims {
        authorize_request_claims(claims, &parts.method, uri.path(), uri.query(), repo_name)?;
        push_scope = push_scope_assertion(claims, scope);
    }

    let shard_idx = pick_shard_index(repo_name, state.config.shards.len());
    let shard_base = match state.config.routing_mode {
        GitEdgeRoutingMode::Hash => state
            .config
            .shards
            .get(shard_idx)
            .ok_or_else(|| ServiceError::internal("shard routing failed"))?
            .clone(),
        GitEdgeRoutingMode::Controller => resolve_shard_via_controller(state, repo_name).await?,
    };

    let response = proxy_request(
        &state.http,
        shard_base,
        &parts.method,
        &parts.headers,
        push_scope,
        uri,
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
    push_scope: Option<&str>,
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
        // Reserved edge-to-shard headers are never taken from the client.
        if !is_forwardable_request_header(name.as_str()) {
            continue;
        }
        let Ok(value_str) = value.to_str() else {
            continue;
        };
        req = req.header(name.as_str(), value_str);
    }
    if let Some(scope) = push_scope {
        req = req.header(GIT_PUSH_SCOPE_HEADER, scope);
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
    use git_service::routing::GIT_PERSIST_SCOPE;

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

    /// The shard receives the push-scope mark only from the edge itself: a
    /// client's copy is dropped, and the edge's own is sent once.
    #[tokio::test]
    async fn only_the_edge_marks_a_rolling_saves_push() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let shard =
            reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let received = tokio::spawn(async move {
            let mut heads = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await
                    .unwrap();
                heads.push(String::from_utf8_lossy(&request).to_ascii_lowercase());
            }
            heads
        });

        let client = reqwest::Client::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            GIT_PUSH_SCOPE_HEADER,
            axum::http::HeaderValue::from_static("forged"),
        );
        let uri: Uri = "/repo.git/git-receive-pack".parse().unwrap();
        for push_scope in [Some("git.persist"), None] {
            proxy_request(
                &client,
                shard.clone(),
                &Method::POST,
                &headers,
                push_scope,
                &uri,
                axum::body::Body::empty(),
            )
            .await
            .unwrap();
        }
        let heads = received.await.unwrap();
        let marks = |head: &str| {
            head.lines()
                .filter(|line| line.starts_with(&format!("{GIT_PUSH_SCOPE_HEADER}:")))
                .map(|line| line.trim_end().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            marks(&heads[0]),
            vec![format!("{GIT_PUSH_SCOPE_HEADER}: git.persist")]
        );
        assert!(marks(&heads[1]).is_empty(), "{}", heads[1]);
    }

    const PROJECT_ID: &str = "8ff62ca8-9150-4a4d-9940-6f2c922b2e4d";

    /// Validated claims of a Git grant for [`PROJECT_ID`] with `scopes`.
    fn claims(scopes: &[&str]) -> AccessTokenClaims {
        AccessTokenClaims {
            aud: "git".to_string(),
            sub: uuid::Uuid::new_v4().to_string(),
            project_id: PROJECT_ID.to_string(),
            origin_id: None,
            runtime_id: None,
            protocol: Some("git".to_string()),
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            lease_id: None,
            runtime_generation: None,
            run_id: None,
            iat: 1_700_000_000,
            exp: 1_700_000_600,
            jti: uuid::Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }
    }

    /// A shard that answers every request with an empty 200 and hands over
    /// each request head, lower-cased, in the order they came.
    async fn recording_shard() -> (reqwest::Url, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let shard =
            reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let (heads, received) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await
                    .unwrap();
                let _ = heads.send(String::from_utf8_lossy(&request).to_ascii_lowercase());
            }
        });
        (shard, received)
    }

    /// Git Edge marks exactly the pushes it lets through on a rolling
    /// save's token alone, both requests of one (the ref advertisement for
    /// receive-pack and the receive-pack POST): never an ordinary writer's
    /// push, a read, or a request without a credential. A client's own
    /// copy of the mark neither sets it nor clears it, and a request the
    /// claims do not allow never reaches the shard.
    #[tokio::test]
    async fn the_edge_marks_exactly_the_pushes_a_rolling_saves_grant_allows() {
        let (shard, mut received) = recording_shard().await;
        let state = AppState {
            config: Arc::new(GitEdgeConfig {
                bind_host: "127.0.0.1".to_string(),
                bind_port: 0,
                skip_auth: false,
                jwks_url: reqwest::Url::parse("http://127.0.0.1:9/jwks").unwrap(),
                audience: "git".to_string(),
                shards: vec![shard],
                routing_mode: GitEdgeRoutingMode::Hash,
                controller_url: None,
                controller_token: None,
                route_cache_seconds: 60,
            }),
            http: reqwest::Client::new(),
            validator: TokenValidator::new(
                reqwest::Client::new(),
                reqwest::Url::parse("http://127.0.0.1:9/jwks").unwrap(),
            ),
            route_cache: Arc::new(RwLock::new(std::collections::HashMap::new())),
        };
        let persist = claims(&["git.persist", "git.read"]);
        let persist_only = claims(&["git.persist"]);
        let write = claims(&["git.read", "git.write"]);
        let both = claims(&["git.persist", "git.write"]);
        let read = claims(&["git.read"]);
        let receive_post = (Method::POST, "/git-receive-pack");
        let receive_refs = (Method::GET, "/info/refs?service=git-receive-pack");
        let upload_post = (Method::POST, "/git-upload-pack");
        let upload_refs = (Method::GET, "/info/refs?service=git-upload-pack");
        let marked = Some(GIT_PERSIST_SCOPE);
        let cases: Vec<(Option<&AccessTokenClaims>, (Method, &str), Option<&str>)> = vec![
            (Some(&persist), receive_post.clone(), marked),
            (Some(&persist), receive_refs.clone(), marked),
            (Some(&persist_only), receive_post.clone(), marked),
            (Some(&persist_only), receive_refs.clone(), marked),
            (Some(&persist), upload_post.clone(), None),
            (Some(&persist), upload_refs.clone(), None),
            (Some(&write), receive_post.clone(), None),
            (Some(&write), receive_refs.clone(), None),
            (Some(&both), receive_post.clone(), None),
            (Some(&both), receive_refs.clone(), None),
            // No credential (GIT_EDGE_SKIP_AUTH): nothing to mark.
            (None, receive_post.clone(), None),
            (None, receive_refs.clone(), None),
        ];
        let marks = |head: &str| {
            head.lines()
                .filter(|line| line.starts_with(&format!("{GIT_PUSH_SCOPE_HEADER}:")))
                .map(|line| line.trim_end().to_string())
                .collect::<Vec<_>>()
        };
        let send = |grant: Option<&AccessTokenClaims>,
                    (method, suffix): (Method, &str),
                    forged: Option<&'static str>| {
            let mut request = axum::http::Request::builder()
                .method(method)
                .uri(format!("/{PROJECT_ID}.git{suffix}"));
            if let Some(forged) = forged {
                request = request.header(GIT_PUSH_SCOPE_HEADER, forged);
            }
            let (parts, body) = request
                .body(axum::body::Body::empty())
                .unwrap()
                .into_parts();
            let grant = grant.cloned();
            let state = state.clone();
            async move { forward(&state, parts, body, PROJECT_ID, grant.as_ref()).await }
        };
        for (grant, request, expected) in cases {
            for forged in [None, Some(GIT_PERSIST_SCOPE), Some("git.write"), Some("")] {
                let shape = format!(
                    "{:?} {} {} with {forged:?}",
                    grant.map(|grant| grant.scopes.clone()),
                    request.0,
                    request.1
                );
                send(grant, request.clone(), forged).await.unwrap();
                let head = received.recv().await.unwrap();
                assert!(
                    head.starts_with(&format!(
                        "{} /{PROJECT_ID}.git{}",
                        request.0.as_str().to_ascii_lowercase(),
                        request.1
                    )),
                    "{shape}: {head}"
                );
                let want: Vec<String> = expected
                    .map(|mark| format!("{GIT_PUSH_SCOPE_HEADER}: {mark}"))
                    .into_iter()
                    .collect();
                assert_eq!(marks(&head), want, "{shape}: {head}");
            }
        }

        // A push the claims do not allow is refused at the edge.
        for request in [receive_post, receive_refs] {
            let refused = send(Some(&read), request.clone(), Some(GIT_PERSIST_SCOPE)).await;
            assert_eq!(
                refused.expect_err("a read grant pushed").status_code(),
                StatusCode::FORBIDDEN
            );
        }
        send(Some(&read), upload_post, None).await.unwrap();
        let head = received.recv().await.unwrap();
        assert!(
            head.starts_with(&format!("post /{PROJECT_ID}.git/git-upload-pack")),
            "the refused pushes never reached the shard: {head}"
        );
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
