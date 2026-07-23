use anyhow::{Context, Result, bail};
use openai_proxy_server::auth;
use openai_proxy_server::client::CodexClient;
use serde_json::to_string_pretty;
use std::env;
use std::io::{self, Read};

#[tokio::main]
async fn main() -> Result<()> {
    let prompt = collect_prompt()?;
    let credentials = auth::load_credentials(None).context("unable to load credentials")?;
    let mut client = CodexClient::new(credentials).context("failed to create client")?;

    let completion = client
        .complete(&prompt)
        .await
        .context("backend request failed")?;

    if let Some(text) = completion.text.as_deref() {
        println!("{}", text);
    } else {
        println!("{}", to_string_pretty(&completion.raw)?);
    }

    Ok(())
}

fn collect_prompt() -> Result<String> {
    let mut args = env::args().skip(1);
    let prompt = args
        .by_ref()
        .take_while(|token| token != "--")
        .collect::<Vec<_>>()
        .join(" ");

    if !prompt.trim().is_empty() {
        return Ok(prompt);
    }

    let mut buffer = String::new();
    if io::stdin().read_to_string(&mut buffer).is_ok() {
        if !buffer.trim().is_empty() {
            return Ok(buffer);
        }
    }

    bail!("Provide a prompt as CLI arguments or pipe it via stdin.")
}
