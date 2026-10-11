//! Bounds on the controller's proxied requests to origins and speech tunnels
//! (`AppState::origin_proxy_client`): a connect timeout, and an idle timeout
//! on the answer instead of a total deadline. A large file or a slow answer
//! that keeps arriving goes on; an upstream that has gone quiet does not hold
//! the request forever.

use std::fmt;
use std::time::Duration;

use axum::body::Bytes;

/// How long the controller waits to connect to an origin or a speech tunnel
/// it proxies to.
pub(crate) const ORIGIN_PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a proxied request may go without receiving anything: its response
/// headers, or the next chunk of its body. Above the origin's own longest wait
/// before it answers (a publish budget of 60 seconds).
pub(crate) const ORIGIN_PROXY_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Why a proxied answer could not be read.
#[derive(Debug)]
pub(crate) enum ProxyReadError {
    /// Nothing arrived for this long.
    Idle(Duration),
    Upstream(reqwest::Error),
}

impl fmt::Display for ProxyReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProxyReadError::Idle(idle) => write!(
                formatter,
                "no response from upstream for {} seconds",
                idle.as_secs()
            ),
            ProxyReadError::Upstream(error) => write!(formatter, "{error}"),
        }
    }
}

/// Sends `request`, giving up when its response headers do not arrive within
/// `idle`.
pub(crate) async fn send_within_idle(
    request: reqwest::RequestBuilder,
    idle: Duration,
) -> Result<reqwest::Response, ProxyReadError> {
    match tokio::time::timeout(idle, request.send()).await {
        Ok(result) => result.map_err(ProxyReadError::Upstream),
        Err(_) => Err(ProxyReadError::Idle(idle)),
    }
}

/// The next chunk of `response`'s body, giving up when none arrives within
/// `idle`.
pub(crate) async fn next_chunk_within_idle(
    response: &mut reqwest::Response,
    idle: Duration,
) -> Result<Option<Bytes>, ProxyReadError> {
    match tokio::time::timeout(idle, response.chunk()).await {
        Ok(result) => result.map_err(ProxyReadError::Upstream),
        Err(_) => Err(ProxyReadError::Idle(idle)),
    }
}

/// `response`'s whole body, giving up when it goes `idle` between chunks.
pub(crate) async fn read_body_within_idle(
    mut response: reqwest::Response,
    idle: Duration,
) -> Result<Bytes, ProxyReadError> {
    let mut body = Vec::new();
    while let Some(chunk) = next_chunk_within_idle(&mut response, idle).await? {
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;
    use futures_util::stream;

    /// A local upstream with `/silent` that answers after `delay`, and
    /// `/trickle` that streams eight chunks `gap` apart.
    async fn upstream(delay: Duration, gap: Duration) -> String {
        let router = Router::new()
            .route(
                "/silent",
                get(move || async move {
                    tokio::time::sleep(delay).await;
                    "late"
                }),
            )
            .route(
                "/trickle",
                get(move || async move {
                    let chunks = stream::unfold(0u8, move |sent| async move {
                        if sent == 8 {
                            return None;
                        }
                        tokio::time::sleep(gap).await;
                        Some((Ok::<_, std::io::Error>(Bytes::from_static(b"x")), sent + 1))
                    });
                    Body::from_stream(chunks)
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        format!("http://{address}")
    }

    /// An upstream that sends nothing is given up on after the idle timeout.
    #[tokio::test]
    async fn a_silent_upstream_is_given_up_on_once_idle() {
        let base = upstream(Duration::from_secs(5), Duration::ZERO).await;
        let client = reqwest::Client::new();
        let error = send_within_idle(
            client.get(format!("{base}/silent")),
            Duration::from_millis(200),
        )
        .await
        .expect_err("idle");
        assert!(matches!(error, ProxyReadError::Idle(_)), "{error}");
    }

    /// An answer that keeps arriving runs past the idle timeout: it is no
    /// total deadline.
    #[tokio::test]
    async fn an_answer_that_keeps_arriving_runs_past_the_idle_timeout() {
        let idle = Duration::from_millis(300);
        let base = upstream(Duration::ZERO, Duration::from_millis(100)).await;
        let client = reqwest::Client::new();
        let started = std::time::Instant::now();
        let response = send_within_idle(client.get(format!("{base}/trickle")), idle)
            .await
            .expect("headers");
        let body = read_body_within_idle(response, idle).await.expect("body");
        assert_eq!(body.as_ref(), b"xxxxxxxx");
        assert!(started.elapsed() > idle, "{:?}", started.elapsed());
    }

    /// A body that stops between chunks is given up on.
    #[tokio::test]
    async fn a_body_that_goes_quiet_is_given_up_on() {
        let base = upstream(Duration::ZERO, Duration::from_millis(500)).await;
        let client = reqwest::Client::new();
        let response = send_within_idle(
            client.get(format!("{base}/trickle")),
            Duration::from_secs(2),
        )
        .await
        .expect("headers");
        let error = read_body_within_idle(response, Duration::from_millis(200))
            .await
            .expect_err("idle");
        assert!(matches!(error, ProxyReadError::Idle(_)), "{error}");
    }
}
