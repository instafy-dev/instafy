use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub(crate) struct RateLimitExceeded {
    pub(crate) retry_after: Duration,
}

#[derive(Clone, Default)]
pub(crate) struct RateLimiter {
    inner: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

impl RateLimiter {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn enforce(
        &self,
        key: impl Into<String>,
        max_requests: usize,
        window: Duration,
    ) -> Result<(), RateLimitExceeded> {
        if max_requests == 0 {
            return Ok(());
        }

        let now = Instant::now();
        let window = window.max(Duration::from_secs(1));
        let window_start = now - window;
        let key = key.into();

        let mut guard = self.inner.lock().await;
        let entries = guard.entry(key).or_default();
        entries.retain(|timestamp| *timestamp > window_start);

        if entries.len() >= max_requests {
            let oldest = entries.first().copied().unwrap_or_else(|| now - window);
            let retry_after = oldest
                .checked_add(window)
                .and_then(|ready_at| ready_at.checked_duration_since(now))
                .unwrap_or_else(|| Duration::from_secs(1));
            return Err(RateLimitExceeded { retry_after });
        }

        entries.push(now);
        Ok(())
    }
}
