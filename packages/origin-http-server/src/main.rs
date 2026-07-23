use std::env;
use std::path::PathBuf;
use std::process;
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use origin_http_server::config::ServerConfig;
use origin_http_server::server::OriginHttpServer;

#[tokio::main]
async fn main() {
    if let Err(error) = real_main().await {
        error!("{error:?}");
        process::exit(1);
    }
}

async fn real_main() -> Result<()> {
    init_tracing()?;
    let config = load_config()?;
    let mut server = OriginHttpServer::new(config.clone())?;

    let start = server.start().await?;
    info!(
        address = %start.address,
        project = %config.project_id,
        origin = %config.origin_id,
        "origin HTTP server listening"
    );

    tokio::signal::ctrl_c()
        .await
        .context("failed to install ctrl-c handler")?;

    info!("origin HTTP server shutting down");
    server.stop_flushing_workspace().await?;
    Ok(())
}

fn init_tracing() -> Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();

    Ok(())
}

fn load_config() -> Result<ServerConfig> {
    let multi_tenant = matches!(
        read_env("ORIGIN_MULTI_TENANT")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    );

    let project_id = if multi_tenant {
        read_env("ORIGIN_PROJECT_ID")
            .and_then(|value| Uuid::parse_str(&value).ok())
            .unwrap_or_else(Uuid::nil)
    } else {
        parse_uuid_env("ORIGIN_PROJECT_ID")?
    };

    let origin_id = if multi_tenant {
        read_env("ORIGIN_ID")
            .and_then(|value| Uuid::parse_str(&value).ok())
            .unwrap_or_else(Uuid::nil)
    } else {
        parse_uuid_env("ORIGIN_ID")?
    };
    let workspace_root =
        PathBuf::from(read_env("ORIGIN_WORKSPACE_ROOT").unwrap_or_else(|| ".".to_string()));
    let git_remote_url = read_env("ORIGIN_GIT_REMOTE_URL").filter(|value| !value.is_empty());
    let git_remote_base_url =
        read_env("ORIGIN_GIT_REMOTE_BASE_URL").filter(|value| !value.is_empty());
    let git_branch = read_env("ORIGIN_GIT_BRANCH").unwrap_or_else(|| "main".to_string());
    let git_remote_name =
        read_env("ORIGIN_GIT_REMOTE_NAME").unwrap_or_else(|| "origin".to_string());
    let git_author_name =
        read_env("ORIGIN_GIT_AUTHOR_NAME").unwrap_or_else(|| "instafy-origin".to_string());
    let git_author_email =
        read_env("ORIGIN_GIT_AUTHOR_EMAIL").unwrap_or_else(|| "origin@instafy.dev".to_string());
    let bind_host = read_env("ORIGIN_BIND_HOST").unwrap_or_else(|| "0.0.0.0".to_string());
    let bind_port: u16 = read_env("ORIGIN_BIND_PORT")
        .as_deref()
        .unwrap_or("54332")
        .parse()
        .context("invalid ORIGIN_BIND_PORT")?;
    let controller_base =
        read_env("ORIGIN_CONTROLLER_URL").unwrap_or_else(|| "http://127.0.0.1:8788".to_string());
    let controller_base_url: reqwest::Url = controller_base
        .trim_end_matches('/')
        .parse()
        .context("invalid ORIGIN_CONTROLLER_URL")?;
    let jwks_url: reqwest::Url = match read_env("ORIGIN_JWKS_URL") {
        Some(value) => value.parse().context("invalid ORIGIN_JWKS_URL")?,
        None => controller_base_url
            .join(".well-known/jwks.json")
            .context("invalid ORIGIN_CONTROLLER_URL")?,
    };

    let controller_internal_token =
        read_env("ORIGIN_INTERNAL_TOKEN").filter(|value| !value.is_empty());

    let skip_auth = matches!(
        read_env("ORIGIN_SKIP_AUTH")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes"
    );

    let presence_interval_ms: u64 = read_env("ORIGIN_PRESENCE_INTERVAL_MS")
        .as_deref()
        .unwrap_or("20000")
        .parse()
        .context("invalid ORIGIN_PRESENCE_INTERVAL_MS")?;

    let enable_presence_heartbeat = read_env("ORIGIN_ENABLE_PRESENCE_HEARTBEAT")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(true);

    let max_archive_bytes: u64 = read_env("ORIGIN_MAX_ARCHIVE_BYTES")
        .as_deref()
        // Match the controller's import ceiling by default. Operators can
        // raise this deliberately, but direct fs.write clients no longer get
        // an implicit one-gigabyte in-memory upload allowance.
        .unwrap_or("134217728")
        .parse()
        .context("invalid ORIGIN_MAX_ARCHIVE_BYTES")?;

    let staging_base = read_env("ORIGIN_STAGING_ROOT").map(PathBuf::from);

    Ok(ServerConfig {
        project_id,
        origin_id,
        workspace_root,
        git_remote_url,
        git_branch,
        git_remote_name,
        git_author_name,
        git_author_email,
        bind_host,
        bind_port,
        controller_base_url,
        controller_internal_token,
        jwks_url,
        skip_auth,
        enable_presence_heartbeat,
        presence_interval: Duration::from_millis(presence_interval_ms),
        max_archive_bytes,
        staging_base,
        multi_tenant,
        git_remote_base_url,
    })
}

fn read_env(name: &str) -> Option<String> {
    env::var(name).ok().map(|value| value.trim().to_string())
}

fn parse_uuid_env(name: &str) -> Result<Uuid> {
    let value = read_env(name).context(format!("{name} must be set"))?;
    Uuid::parse_str(&value).context(format!("invalid {name} UUID"))
}
