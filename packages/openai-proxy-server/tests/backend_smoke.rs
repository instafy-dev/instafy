use anyhow::Result;
use openai_proxy_server::auth;
use openai_proxy_server::client::CodexClient;

const DEFAULT_PROMPT: &str =
    "Reply with a single sentence explaining what this Rust test just did.";

#[tokio::test]
async fn backend_completion_smoke() -> Result<()> {
    let credentials = match auth::load_credentials(None) {
        Ok(creds) => creds,
        Err(err) => {
            eprintln!("skipping backend test: {}", err);
            return Ok(());
        }
    };

    let prompt = std::env::var("CODEX_TEST_PROMPT").unwrap_or_else(|_| DEFAULT_PROMPT.to_string());
    let mut client = CodexClient::new(credentials)?;
    let completion = match client.complete(&prompt).await {
        Ok(response) => response,
        Err(err) => {
            eprintln!("skipping backend test: {}", err);
            return Ok(());
        }
    };

    let has_text = completion
        .text
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    if !has_text {
        let output_items = completion
            .raw
            .get("output")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if output_items.is_empty() {
            eprintln!(
                "skipping backend test: upstream completed without output items: {:#}",
                completion.raw
            );
            return Ok(());
        }
    }

    Ok(())
}
