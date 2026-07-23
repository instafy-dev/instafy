use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub(crate) struct ConnectionLimiter {
    inner: Arc<Mutex<HashMap<String, usize>>>,
}

impl ConnectionLimiter {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn try_acquire(
        &self,
        key: impl Into<String>,
        max_connections: usize,
    ) -> Option<ConnectionPermit> {
        if max_connections == 0 {
            return None;
        }

        let key = key.into();
        let mut guard = self.inner.lock().await;
        let count = guard.entry(key.clone()).or_insert(0);
        if *count >= max_connections {
            return None;
        }

        *count += 1;
        Some(ConnectionPermit {
            key,
            limiter: self.clone(),
        })
    }

    async fn release(&self, key: &str) {
        let mut guard = self.inner.lock().await;
        let Some(count) = guard.get_mut(key) else {
            return;
        };

        if *count <= 1 {
            guard.remove(key);
        } else {
            *count -= 1;
        }
    }
}

pub(crate) struct ConnectionPermit {
    key: String,
    limiter: ConnectionLimiter,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        let key = self.key.clone();
        let limiter = self.limiter.clone();
        tokio::spawn(async move {
            limiter.release(&key).await;
        });
    }
}
