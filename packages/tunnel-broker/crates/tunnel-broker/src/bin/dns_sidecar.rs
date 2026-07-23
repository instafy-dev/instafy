use anyhow::{Context, Result};
use std::env;
use std::time::Duration;
use tokio::time::interval;
use tracing::{info, warn};

use tunnel_broker::config::BrokerConfig;
use tunnel_broker::db::{connect_pool, ensure_dns_node, ensure_pdns_domain, run_migrations};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = BrokerConfig::from_env()?;
    let pool = connect_pool(&cfg.database_url, cfg.database_pool_size).await?;
    run_migrations(&pool).await?;

    let hostname = env::var("DNS_NODE_HOSTNAME")
        .context("DNS_NODE_HOSTNAME env var missing")?
        .trim()
        .to_string();
    if hostname.is_empty() {
        anyhow::bail!("DNS_NODE_HOSTNAME cannot be empty");
    }

    let ipv4 = env::var("DNS_NODE_IPV4")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let ipv6 = env::var("DNS_NODE_IPV6")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let refresh_seconds = env::var("DNS_NODE_REFRESH_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30)
        .max(5);

    info!(
        dns_hostname = %hostname,
        ipv4 = ?ipv4,
        ipv6 = ?ipv6,
        refresh_seconds,
        "starting dns sidecar"
    );

    let mut ticker = interval(Duration::from_secs(refresh_seconds));
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if let Err(error) = sync_once(&pool, &cfg, &hostname, ipv4.clone(), ipv6.clone()).await {
                    warn!(?error, "dns sidecar sync failed");
                }
            }
            _ = tokio::signal::ctrl_c() => {
                info!("dns sidecar received shutdown signal");
                break;
            }
        }
    }

    Ok(())
}

async fn sync_once(
    pool: &sqlx::PgPool,
    cfg: &BrokerConfig,
    hostname: &str,
    ipv4: Option<String>,
    ipv6: Option<String>,
) -> Result<()> {
    let record = ensure_dns_node(pool, hostname, ipv4, ipv6).await?;
    let _ = ensure_pdns_domain(pool, cfg).await?;
    info!(
        dns_hostname = %record.hostname,
        ipv4 = ?record.ipv4,
        ipv6 = ?record.ipv6,
        "dns node ensured"
    );
    Ok(())
}
