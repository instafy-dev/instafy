use std::env;
use std::net::SocketAddr;

use anyhow::{Context, Result};
use openai_proxy_server::auth;
use openai_proxy_server::proxy;

#[tokio::main]
async fn main() -> Result<()> {
    let addr: SocketAddr = env::var("CODEX_PROXY_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_string())
        .parse()
        .context("invalid CODEX_PROXY_ADDR; expected host:port")?;

    let credentials = match auth::load_credentials(None) {
        Ok(creds) => Some(creds),
        Err(error) => {
            eprintln!(
                "[proxy] unable to load local credentials: {error}; continuing without static upstream credentials"
            );
            None
        }
    };

    proxy::run_proxy(addr, credentials)
        .await
        .context("proxy server terminated")
}
