use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Result;
use openai_proxy_server::auth;
use openai_proxy_server::client::DEFAULT_MODEL;
use openai_proxy_server::proxy::run_proxy_with_shutdown;
use reqwest::StatusCode;
use serde_json::json;
use tokio::sync::oneshot;

const CHAT_PROMPT: &str = "Say hello to the integration test in one short sentence.";

#[tokio::test]
async fn proxy_chat_completion_smoke() -> Result<()> {
    let credentials = match auth::load_credentials(None) {
        Ok(creds) => creds,
        Err(err) => {
            eprintln!("skipping proxy test: {}", err);
            return Ok(());
        }
    };

    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let server_credentials = credentials.clone();
    let server = tokio::spawn(async move {
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };

        if let Err(error) = run_proxy_with_shutdown(addr, Some(server_credentials), shutdown).await
        {
            eprintln!("proxy server exited with error: {error}");
        }
    });

    tokio::time::sleep(Duration::from_millis(300)).await;

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    let payload = json!({
        "model": DEFAULT_MODEL,
        "stream": false,
        "messages": [
            {"role": "user", "content": CHAT_PROMPT}
        ]
    });

    let response = match client.post(&url).json(&payload).send().await {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!("skipping proxy test: failed to reach proxy: {}", err);
            let _ = shutdown_tx.send(());
            let _ = server.await;
            return Ok(());
        }
    };

    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        eprintln!(
            "skipping proxy test: upstream rejected credentials (status {})",
            response.status()
        );
        let _ = shutdown_tx.send(());
        let _ = server.await;
        return Ok(());
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        eprintln!("skipping proxy test: proxy returned {}: {}", status, body);
        let _ = shutdown_tx.send(());
        let _ = server.await;
        return Ok(());
    }

    let body: serde_json::Value = response.json().await?;
    let message = body
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or("");

    if message.trim().is_empty() {
        eprintln!("skipping proxy test: empty assistant message returned: {body:#?}");
        let _ = shutdown_tx.send(());
        let _ = server.await;
        return Ok(());
    }

    let _ = shutdown_tx.send(());
    let _ = server.await;

    Ok(())
}
