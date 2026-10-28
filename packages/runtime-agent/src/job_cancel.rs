use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

#[derive(Debug, Clone, Default)]
pub struct JobCancelSignal {
    canceled: Arc<AtomicBool>,
    shared_browser_shutdown_confirmed: Arc<AtomicBool>,
    /// Why the run's Shared Browser tools could not be confirmed gone, for
    /// the log line of the runtime exit that follows (a fixed token).
    shared_browser_shutdown_failure: Arc<Mutex<Option<&'static str>>>,
    notify: Arc<Notify>,
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
