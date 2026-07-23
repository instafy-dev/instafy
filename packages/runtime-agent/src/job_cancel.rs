use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

#[derive(Debug, Clone, Default)]
pub struct JobCancelSignal {
    canceled: Arc<AtomicBool>,
    shared_browser_shutdown_confirmed: Arc<AtomicBool>,
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
