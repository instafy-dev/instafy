use anyhow::Result;
use std::env;
use std::fs;

use tunnel_broker::config::BrokerConfig;
use tunnel_broker::db::{
    connect_pool, ensure_ingress, list_active_rathole_bindings_for_ingress, run_migrations,
};
use tunnel_broker::ingress::render_rathole_server_config;

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = BrokerConfig::from_env()?;
    let pool = connect_pool(&cfg.database_url, cfg.database_pool_size).await?;
    run_migrations(&pool).await?;

    let ingress = ensure_ingress(&pool, &cfg).await?;
    let bindings = list_active_rathole_bindings_for_ingress(&pool, ingress.id).await?;
    let out = render_rathole_server_config(&cfg, &bindings);

    if let Ok(path) = env::var("RATHOLE_CONFIG_OUTPUT") {
        if !path.trim().is_empty() {
            fs::write(path.trim(), out)?;
            return Ok(());
        }
    }

    print!("{out}");
    Ok(())
}
