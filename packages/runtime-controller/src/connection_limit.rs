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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A dropped permit (a closed stream) gives its place back as soon as
    /// its release task runs, and keys count apart.
    #[tokio::test]
    async fn a_dropped_permit_gives_its_place_back() {
        let limiter = ConnectionLimiter::new();
        let first = limiter.try_acquire("user-a", 2).await.expect("first place");
        let _second = limiter
            .try_acquire("user-a", 2)
            .await
            .expect("second place");
        assert!(limiter.try_acquire("user-a", 2).await.is_none());
        assert!(limiter.try_acquire("user-b", 2).await.is_some());

        drop(first);
        let _again = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(permit) = limiter.try_acquire("user-a", 2).await {
                    break permit;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the dropped place comes back");
        assert!(limiter.try_acquire("user-a", 2).await.is_none());
    }
}
