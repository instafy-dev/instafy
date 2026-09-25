//! Offline HTTP contract tests: every credential is inert and every upstream is loopback.
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use anyhow::Result;
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use openai_proxy_server::{auth::Credentials, proxy::run_proxy_with_shutdown};
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;

struct EnvGuard(Vec<(String, Option<String>)>);
impl EnvGuard {
    fn isolated() -> Self {
        let mut guard = Self(Vec::new());
        for key in [
            "PROXY_CONTROLLER_BASE_URL",
            "CONTROLLER_BASE_URL",
            "PROXY_REQUIRE_CONTROLLER_AUTH",
            "PROXY_REQUIRE_CREDENTIAL_CLAIM",
            "CODEX_DEBUG_HTTP",
            "PROXY_DEBUG_STREAM",
        ] {
            guard.set(key, "");
        }
        guard
    }
    fn set(&mut self, key: &str, value: &str) {
        self.0.push((key.into(), std::env::var(key).ok()));
        unsafe {
            std::env::set_var(key, value);
        }
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.0.iter().rev() {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone)]
struct Reply {
    status: StatusCode,
    body: String,
    retry_after: Option<&'static str>,
}
impl Reply {
    fn error(status: StatusCode) -> Self {
        Self { status, body: json!({"error":{"message":"private-token controller credential lease renewal failed token_expired"}}).to_string(), retry_after: None }
    }
    fn success() -> Self {
        Self { status: StatusCode::OK, body: json!({"id":"response-local", "model":"fixture-model", "status":"completed", "output":[{"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"local answer"}]}]}).to_string(), retry_after: None }
    }
}
#[derive(Clone)]
struct Mock {
    replies: Arc<Mutex<VecDeque<Reply>>>,
    calls: Arc<AtomicUsize>,
    auth: Arc<Mutex<Vec<String>>>,
}
async fn upstream(State(mock): State<Mock>, headers: HeaderMap) -> axum::response::Response {
    mock.calls.fetch_add(1, Ordering::SeqCst);
    mock.auth.lock().unwrap().push(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .into(),
    );
    let reply = mock
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected additional upstream attempt");
    let mut response = (reply.status, reply.body).into_response();
    if let Some(value) = reply.retry_after {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, value.parse().unwrap());
    }
    response
}
async fn mock_server(replies: Vec<Reply>) -> Result<(String, Mock, Server)> {
    let mock = Mock {
        replies: Arc::new(Mutex::new(replies.into())),
        calls: Arc::new(AtomicUsize::new(0)),
        auth: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/v1/responses", listener.local_addr()?);
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .route("/v1/audio/speech", post(upstream))
        .route("/v1/audio/transcriptions", post(upstream))
        .with_state(mock.clone());
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    Ok((endpoint, mock, server))
}
async fn proxy(credentials: Credentials) -> Result<(SocketAddr, Server)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    drop(listener);
    let server = Server(tokio::spawn(async move {
        run_proxy_with_shutdown(addr, Some(credentials), std::future::pending::<()>())
            .await
            .unwrap();
    }));
    for _ in 0..100 {
        if reqwest::get(format!("http://{addr}/healthz")).await.is_ok() {
            return Ok((addr, server));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("local proxy did not start")
}
fn api_credentials(endpoint: String) -> Credentials {
    Credentials::ApiKey {
        key: "inert-fixture-key".into(),
        endpoint: Some(endpoint),
        default_model: None,
    }
}
fn chatgpt_credentials(refresh: bool) -> Credentials {
    Credentials::ChatGpt {
        access_token: "inert-old-access".into(),
        refresh_token: refresh.then(|| "inert-refresh".into()),
        account_id: None,
        default_model: None,
        auth_path: None,
    }
}
async fn request(addr: SocketAddr) -> Result<reqwest::Response> {
    Ok(reqwest::Client::new()
        .post(format!("http://{addr}/v1/responses"))
        .json(&json!({"model":"fixture-model", "input":"local test", "stream":false}))
        .send()
        .await?)
}
async fn assert_error(
    response: reqwest::Response,
    status: StatusCode,
    retryable: bool,
    code: &str,
) -> Result<()> {
    assert_eq!(response.status(), status);
    let body: Value = response.json().await?;
    assert_eq!(body["error"]["type"], "upstream_error");
    assert_eq!(body["error"]["retryable"], retryable);
    assert_eq!(body["error"]["code"], code);
    let serialized = body.to_string();
    for private in [
        "private-token",
        "inert-old-access",
        "inert-refresh",
        "127.0.0.1",
        "controller credential lease renewal failed",
    ] {
        assert!(
            !serialized.contains(private),
            "provider details leaked: {body}"
        );
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn http_statuses_are_preserved_without_proxy_retry_or_body_reflection() -> Result<()> {
    let _env = EnvGuard::isolated();
    for (status, retryable, code) in [
        (StatusCode::BAD_REQUEST, false, "upstream_http_error"),
        (
            StatusCode::UNAUTHORIZED,
            false,
            "upstream_authentication_error",
        ),
        (StatusCode::FORBIDDEN, false, "upstream_access_denied"),
        (StatusCode::TOO_MANY_REQUESTS, true, "upstream_rate_limit"),
        (StatusCode::SERVICE_UNAVAILABLE, true, "upstream_http_error"),
    ] {
        let (endpoint, mock, _upstream) = mock_server(vec![Reply::error(status)]).await?;
        let (addr, _proxy) = proxy(api_credentials(endpoint)).await?;
        assert_error(request(addr).await?, status, retryable, code).await?;
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn temporary_failure_preserves_retry_after_and_next_attempt_recovers() -> Result<()> {
    let _env = EnvGuard::isolated();
    for status in [
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let mut failure = Reply::error(status);
        failure.retry_after = Some("2");
        let (endpoint, mock, _upstream) = mock_server(vec![failure, Reply::success()]).await?;
        let (addr, _proxy) = proxy(api_credentials(endpoint)).await?;
        let response = request(addr).await?;
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::RETRY_AFTER], "2");
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
        assert_eq!(request(addr).await?.status(), StatusCode::OK);
        assert_eq!(mock.calls.load(Ordering::SeqCst), 2);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn malformed_success_and_connection_failure_are_retryable_gateway_errors() -> Result<()> {
    let _env = EnvGuard::isolated();
    for body in ["private-token invalid JSON", "{}"] {
        let (endpoint, mock, _upstream) = mock_server(vec![Reply {
            status: StatusCode::OK,
            body: body.into(),
            retry_after: None,
        }])
        .await?;
        let (addr, _proxy) = proxy(api_credentials(endpoint)).await?;
        assert_error(
            request(addr).await?,
            StatusCode::BAD_GATEWAY,
            true,
            "upstream_invalid_response",
        )
        .await?;
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    let closed = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/v1/responses", closed.local_addr()?);
    drop(closed);
    let (addr, _proxy) = proxy(api_credentials(endpoint)).await?;
    assert_error(
        request(addr).await?,
        StatusCode::BAD_GATEWAY,
        true,
        "upstream_transport_error",
    )
    .await?;
    Ok(())
}

#[tokio::test]
#[serial]
async fn structured_http_and_stream_quota_exhaustion_are_terminal() -> Result<()> {
    let mut env = EnvGuard::isolated();
    for field in ["code", "type"] {
        let mut quota = Reply::error(StatusCode::TOO_MANY_REQUESTS);
        let mut body = json!({"error":{"code":null, "message":"private-token"}});
        body["error"][field] = json!("insufficient_quota");
        quota.body = body.to_string();
        let (endpoint, mock, _upstream) = mock_server(vec![quota]).await?;
        let (addr, _proxy) = proxy(api_credentials(endpoint)).await?;
        assert_error(
            request(addr).await?,
            StatusCode::PAYMENT_REQUIRED,
            false,
            "upstream_insufficient_quota",
        )
        .await?;
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    for (code, expected_status, retryable, expected_code) in [
        (
            "insufficient_quota",
            StatusCode::PAYMENT_REQUIRED,
            false,
            "upstream_insufficient_quota",
        ),
        (
            "invalid_api_key",
            StatusCode::UNAUTHORIZED,
            false,
            "upstream_authentication_error",
        ),
        (
            "rate_limit_exceeded",
            StatusCode::TOO_MANY_REQUESTS,
            true,
            "upstream_rate_limit",
        ),
        (
            "unknown_provider_failure",
            StatusCode::BAD_GATEWAY,
            true,
            "upstream_stream_error",
        ),
    ] {
        let body = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"type":"response.failed", "response":{"error":{"code":code, "message":"private-token"}}})
        );
        let (endpoint, mock, _upstream) = mock_server(vec![Reply {
            status: StatusCode::OK,
            body,
            retry_after: None,
        }])
        .await?;
        env.set("CODEX_PROXY_CHATGPT_ENDPOINT", &endpoint);
        let (addr, _proxy) = proxy(chatgpt_credentials(false)).await?;
        assert_error(
            request(addr).await?,
            expected_status,
            retryable,
            expected_code,
        )
        .await?;
        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn chatgpt_refresh_is_once_and_preserves_terminal_failure_or_recovery() -> Result<()> {
    let mut env = EnvGuard::isolated();
    for (refresh_succeeds, final_succeeds) in [(true, true), (true, false), (false, false)] {
        let refresh_reply = if refresh_succeeds {
            Reply {
                status: StatusCode::OK,
                body: json!({"access_token":"inert-new-access"}).to_string(),
                retry_after: None,
            }
        } else {
            Reply::error(StatusCode::UNAUTHORIZED)
        };
        let (refresh_endpoint, refresh_mock, _refresh_server) =
            mock_server(vec![refresh_reply]).await?;
        env.set("CODEX_REFRESH_TOKEN_URL_OVERRIDE", &refresh_endpoint);
        let mut replies = vec![Reply::error(StatusCode::UNAUTHORIZED)];
        if refresh_succeeds {
            replies.push(if final_succeeds {
                Reply {
                    status: StatusCode::OK,
                    body: include_str!("fixtures/responses_success.sse").into(),
                    retry_after: None,
                }
            } else {
                Reply::error(StatusCode::UNAUTHORIZED)
            });
        }
        let (endpoint, mock, _upstream) = mock_server(replies).await?;
        env.set("CODEX_PROXY_CHATGPT_ENDPOINT", &endpoint);
        let (addr, _proxy) = proxy(chatgpt_credentials(true)).await?;
        let response = request(addr).await?;
        if final_succeeds {
            assert_eq!(response.status(), StatusCode::OK);
        } else if refresh_succeeds {
            assert_error(
                response,
                StatusCode::UNAUTHORIZED,
                false,
                "upstream_authentication_error",
            )
            .await?;
        } else {
            assert_error(
                response,
                StatusCode::FAILED_DEPENDENCY,
                false,
                "upstream_credential_refresh_failed",
            )
            .await?;
        }
        assert_eq!(refresh_mock.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            mock.calls.load(Ordering::SeqCst),
            if refresh_succeeds { 2 } else { 1 }
        );
        let auth = mock.auth.lock().unwrap();
        assert_eq!(auth[0], "Bearer inert-old-access");
        if refresh_succeeds {
            assert_eq!(auth[1], "Bearer inert-new-access");
        }
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn forbidden_chatgpt_request_does_not_refresh_even_with_expired_token_text() -> Result<()> {
    let mut env = EnvGuard::isolated();
    let (refresh_endpoint, refresh_mock, _refresh_server) = mock_server(vec![]).await?;
    env.set("CODEX_REFRESH_TOKEN_URL_OVERRIDE", &refresh_endpoint);
    let (endpoint, mock, _upstream) =
        mock_server(vec![Reply::error(StatusCode::FORBIDDEN)]).await?;
    env.set("CODEX_PROXY_CHATGPT_ENDPOINT", &endpoint);
    let (addr, _proxy) = proxy(chatgpt_credentials(true)).await?;
    assert_error(
        request(addr).await?,
        StatusCode::FORBIDDEN,
        false,
        "upstream_access_denied",
    )
    .await?;
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    assert_eq!(refresh_mock.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
#[serial]
async fn audio_routes_preserve_typed_status_retry_headers_and_safe_errors() -> Result<()> {
    let _env = EnvGuard::isolated();
    for route in ["speech", "transcriptions"] {
        for (status, retryable, code) in [
            (
                StatusCode::UNAUTHORIZED,
                false,
                "upstream_authentication_error",
            ),
            (StatusCode::FORBIDDEN, false, "upstream_access_denied"),
            (StatusCode::TOO_MANY_REQUESTS, true, "upstream_rate_limit"),
            (StatusCode::SERVICE_UNAVAILABLE, true, "upstream_http_error"),
        ] {
            let mut failure = Reply::error(status);
            failure.retry_after = Some("3");
            let (endpoint, mock, _upstream) = mock_server(vec![failure]).await?;
            let (addr, _proxy) = proxy(api_credentials(endpoint)).await?;
            let request = reqwest::Client::new().post(format!("http://{addr}/v1/audio/{route}"));
            let response = if route == "speech" {
                request
                    .json(&json!({"model":"inert", "input":"hello"}))
                    .send()
                    .await?
            } else {
                request
                    .header("content-type", "audio/wav")
                    .body("inert audio")
                    .send()
                    .await?
            };
            if retryable {
                assert_eq!(response.headers()[header::RETRY_AFTER], "3");
            } else {
                assert!(response.headers().get(header::RETRY_AFTER).is_none());
            }
            assert_error(response, status, retryable, code).await?;
            assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
        }
    }
    Ok(())
}
