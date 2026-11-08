use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// How a job asks the controller whether it still holds its lease: true while it does.
pub type LeaseCheck = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

#[derive(Clone, Default)]
struct LeaseCheckSlot(Arc<Mutex<Option<LeaseCheck>>>);

impl std::fmt::Debug for LeaseCheckSlot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let set = self.0.lock().is_ok_and(|check| check.is_some());
        formatter.debug_tuple("LeaseCheckSlot").field(&set).finish()
    }
}

#[derive(Debug, Clone, Default)]
pub struct JobCancelSignal {
    canceled: Arc<AtomicBool>,
    shared_browser_shutdown_confirmed: Arc<AtomicBool>,
    /// Why the run's Shared Browser tools could not be confirmed gone, for
    /// the log line of the runtime exit that follows (a fixed token).
    shared_browser_shutdown_failure: Arc<Mutex<Option<&'static str>>>,
    notify: Arc<Notify>,
    lease_check: LeaseCheckSlot,
}

impl JobCancelSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        let notified = self.notify.notified();
        if self.is_canceled() {
            return;
        }
        notified.await;
    }

    /// Sets how the job asks the controller whether it still holds its lease
    /// ([`Self::lease_held`]).
    pub fn check_lease_with(&self, check: LeaseCheck) {
        if let Ok(mut slot) = self.lease_check.0.lock() {
            *slot = Some(check);
        }
    }

    /// Whether the job still holds its lease, asked of the controller now: a
    /// job hears of a Stop from its heartbeat, once a second, and in between it
    /// may have gone on to write its turn. False once it is cancelled, or when
    /// the controller says the lease is gone, which cancels it. Without a way
    /// to ask, what the job last heard.
    pub async fn lease_held(&self) -> bool {
        if self.is_canceled() {
            return false;
        }
        let check = self.lease_check.0.lock().ok().and_then(|slot| slot.clone());
        if let Some(check) = check
            && !check().await
        {
            self.cancel();
        }
        !self.is_canceled()
    }

    pub fn reset_shared_browser_shutdown_confirmation(&self) {
        self.shared_browser_shutdown_confirmed
            .store(false, Ordering::SeqCst);
        if let Ok(mut failure) = self.shared_browser_shutdown_failure.lock() {
            *failure = None;
        }
    }

    /// Records why the Shared Browser tools could not be confirmed gone; the
    /// first reason recorded stands.
    pub fn note_shared_browser_shutdown_failure(&self, reason: &'static str) {
        if let Ok(mut failure) = self.shared_browser_shutdown_failure.lock() {
            failure.get_or_insert(reason);
        }
    }

    pub fn shared_browser_shutdown_failure(&self) -> Option<&'static str> {
        self.shared_browser_shutdown_failure
            .lock()
            .ok()
            .and_then(|failure| *failure)
    }

    pub fn confirm_shared_browser_shutdown(&self) {
        self.shared_browser_shutdown_confirmed
            .store(true, Ordering::SeqCst);
    }

    pub fn shared_browser_shutdown_is_confirmed(&self) -> bool {
        self.shared_browser_shutdown_confirmed
            .load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_job_asks_whether_it_still_holds_its_lease() {
        // Without a way to ask, what it last heard.
        let signal = JobCancelSignal::new();
        assert!(signal.lease_held().await);

        // The controller says the lease is gone: the job is cancelled.
        let asked = Arc::new(AtomicBool::new(false));
        let held = Arc::new(AtomicBool::new(false));
        signal.check_lease_with(Arc::new({
            let asked = asked.clone();
            let held = held.clone();
            move || {
                asked.store(true, Ordering::SeqCst);
                let held = held.load(Ordering::SeqCst);
                Box::pin(async move { held })
            }
        }));
        held.store(true, Ordering::SeqCst);
        assert!(signal.lease_held().await);
        assert!(asked.load(Ordering::SeqCst));
        assert!(!signal.is_canceled());
        held.store(false, Ordering::SeqCst);
        assert!(!signal.clone().lease_held().await);
        assert!(signal.is_canceled());

        // Once cancelled, it does not ask again.
        asked.store(false, Ordering::SeqCst);
        held.store(true, Ordering::SeqCst);
        assert!(!signal.lease_held().await);
        assert!(!asked.load(Ordering::SeqCst));
    }
}
