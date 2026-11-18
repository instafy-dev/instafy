use anyhow::Result;
use axum::Router;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use tunnel_broker::{
    connect_pool, ensure_ingress, ensure_pdns_domain, router, run_migrations, AppState,
    BrokerConfig,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "tunnel_broker=info,axum::rejection=debug,tower_http=info".into()
            }),
        )
        .init();

    let config = BrokerConfig::from_env()?;
    let pool = connect_pool(&config.database_url, config.database_pool_size).await?;
    run_migrations(&pool).await?;

    let _ = ensure_pdns_domain(&pool, &config).await?;
    if config.ingress_ipv4.is_some() || config.ingress_ipv6.is_some() {
        let _ = ensure_ingress(&pool, &config).await?;
    }
    let state = AppState::new(pool, config.clone());

    let app = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind(&config.http_bind).await?;
    tracing::info!(addr = %config.http_bind, "starting tunnel broker");

    axum::serve(listener, app.into_make_service()).await?;
    Ok(())
}

fn build_router(state: AppState) -> Router {
    router(state).layer(TraceLayer::new_for_http())
}
