use crate::config::BrokerConfig;
use reqwest::Client;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    pub pool: PgPool,
    pub config: BrokerConfig,
    pub http: Client,
}

impl AppState {
    pub fn new(pool: PgPool, config: BrokerConfig) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                pool,
                config,
                http: Client::new(),
            }),
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.inner.pool
    }

    pub fn config(&self) -> &BrokerConfig {
        &self.inner.config
    }

    pub fn http(&self) -> &Client {
        &self.inner.http
    }
}
