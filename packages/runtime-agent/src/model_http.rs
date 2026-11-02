//! Direct model requests use the same distinction as native Codex: connection/read inactivity
//! are bounded; only an explicit task budget limits total execution.
use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::time::Duration;

const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn read_timeout() -> Duration {
    std::env::var("CODEX_MODEL_READ_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_READ_TIMEOUT)
}

pub(crate) fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .context("failed to build scoped worker proxy client")
}

pub(crate) async fn post_json(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    request: &Value,
    idle: Duration,
) -> Result<(reqwest::StatusCode, Value)> {
    // Non-streaming completion endpoints may produce no bytes while reasoning. This is a
    // generous inactivity allowance, not the old two-minute total response deadline.
    let response = tokio::time::timeout(
        idle,
        client
            .post(endpoint)
            .bearer_auth(api_key)
            .json(request)
            .send(),
    )
    .await
    .context("scoped worker proxy stalled before response headers")?
    .context("scoped worker proxy request failed")?;
    read_json(response, idle, MAX_RESPONSE_BYTES).await
}

async fn read_json(
    mut response: reqwest::Response,
    idle: Duration,
    max_bytes: usize,
) -> Result<(reqwest::StatusCode, Value)> {
    let status = response.status();
    let mut body = Vec::new();
    loop {
        let chunk = tokio::time::timeout(idle, response.chunk())
            .await
            .context("scoped worker proxy response stalled")?
            .context("failed to read scoped worker proxy response")?;
        let Some(chunk) = chunk else { break };
        if chunk.len() > max_bytes.saturating_sub(body.len()) {
            bail!("scoped worker proxy response exceeded its {max_bytes}-byte memory limit");
        }
        body.extend_from_slice(&chunk);
    }
    let value =
        serde_json::from_slice(&body).context("failed to parse scoped worker proxy response")?;
    Ok((status, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, routing::post};
    use futures_util::stream;

    async fn fixture(delay: Duration, pieces: usize) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/",
            post(move || async move {
                Body::from_stream(stream::unfold(0, move |index| async move {
                    if index >= pieces {
                        return None;
                    }
                    tokio::time::sleep(delay).await;
                    let text = if index == 0 {
                        "[0"
                    } else if index + 1 == pieces {
                        "]"
                    } else {
                        ",0"
                    };
                    Some((Ok::<_, std::io::Error>(text), index + 1))
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}/"), task)
    }

    #[tokio::test]
    async fn active_response_can_outlast_its_read_inactivity_budget() {
        let (url, server) = fixture(Duration::from_millis(100), 12).await;
        let started = std::time::Instant::now();
        let idle = Duration::from_millis(750);
        let result = post_json(&client().unwrap(), &url, "inert", &Value::Null, idle).await;
        server.abort();
        assert!(started.elapsed() > idle);
        assert_eq!(result.unwrap().1.as_array().unwrap().len(), 11);
    }

    #[tokio::test]
    async fn a_stalled_response_fails_instead_of_waiting_forever() {
        let (url, server) = fixture(Duration::from_secs(5), 2).await;
        let result = post_json(
            &client().unwrap(),
            &url,
            "inert",
            &Value::Null,
            Duration::from_millis(50),
        )
        .await;
        server.abort();
        assert!(format!("{:#}", result.unwrap_err()).contains("stalled"));
    }

    #[tokio::test]
    async fn continuously_growing_body_has_a_memory_bound() {
        let (url, server) = fixture(Duration::from_millis(1), 12).await;
        let response = client().unwrap().post(url).send().await.unwrap();
        let result = read_json(response, Duration::from_secs(1), 4).await;
        server.abort();
        assert!(format!("{:#}", result.unwrap_err()).contains("memory limit"));
    }
}
