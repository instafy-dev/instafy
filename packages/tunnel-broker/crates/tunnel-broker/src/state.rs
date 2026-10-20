use crate::{config::BrokerConfig, routes::preview_auth::DecisionCache};
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
    pub preview_auth_cache: DecisionCache,
}

impl AppState {
    pub fn new(pool: PgPool, config: BrokerConfig) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                pool,
                config,
                http: Client::new(),
                preview_auth_cache: DecisionCache::new(),
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

    pub fn preview_auth_cache(&self) -> &DecisionCache {
        &self.inner.preview_auth_cache
    }
}

#[cfg(test)]
impl AppState {
    /// State whose pool never connects; for handlers that answer before touching Postgres.
    pub(crate) fn for_tests(config: BrokerConfig) -> Self {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy(&config.database_url)
            .expect("lazy pool");
        Self::new(pool, config)
    }
}
