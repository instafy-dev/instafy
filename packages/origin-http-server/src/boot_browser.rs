//! Instafy's browser on a browser session machine, started at boot.
//!
//! On such a machine the entrypoint launches Chromium once at boot (or the
//! process hosting this origin launches it after restoring a saved profile),
//! and that process keeps it running: when Chromium exits it starts it again,
//! within a bounded budget, and gives up once the budget is used. It hands the
//! origin a [`BootBrowserHandle`] through
//! [`crate::server::OriginHttpServer::set_boot_browser`] so the origin says
//! which of those it is, instead of answering as if Chromium were there.
//!
//! With a handle, the page, page-command and pixel/input transports answer
//! 503 before any CDP request or WebSocket upgrade while Chromium is not
//! running ([`crate::browser_host::BrowserHostReady`]):
//!
//! - `browser_restarting` (`Retry-After: 2`) while it is being started again;
//! - `browser_stopped` once the process has given up on it. Only a restart of
//!   the machine starts it again.
//!
//! Without a handle (Desktop, a lazy browser host, the multi-tenant gateway)
//! nothing here applies.

use std::sync::Arc;

use crate::error::OriginError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootBrowserState {
    /// Chromium runs, or the process has not seen it start yet.
    Running,
    /// Chromium exited and is being started again.
    Restarting,
    /// Chromium exited too often and is not started again until the machine
    /// restarts.
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BootBrowserSnapshot {
    pub state: BootBrowserState,
}

/// Implemented by the process that keeps Chromium running. It must not await,
/// block on I/O, or take a lock held across an await.
pub trait BootBrowserStatus: Send + Sync + 'static {
    fn snapshot(&self) -> BootBrowserSnapshot;
}

pub type BootBrowserHandle = Arc<dyn BootBrowserStatus>;

/// 503 from a guarded browser transport while Chromium is started again.
pub const BOOT_BROWSER_RESTARTING_CODE: &str = "browser_restarting";
/// 503 from a guarded browser transport once Chromium is no longer started
/// again.
pub const BOOT_BROWSER_STOPPED_CODE: &str = "browser_stopped";
/// How long a client waits before it asks again while Chromium restarts.
pub const BOOT_BROWSER_RETRY_AFTER_SECONDS: u64 = 2;

/// The refusal a guarded transport answers with, or `None` while Chromium
/// runs. Each message is fixed text.
pub(crate) fn refusal(handle: &dyn BootBrowserStatus) -> Option<OriginError> {
    match handle.snapshot().state {
        BootBrowserState::Running => None,
        BootBrowserState::Restarting => Some(OriginError::retry_later(
            BOOT_BROWSER_RESTARTING_CODE,
            "Instafy's browser stopped and is starting again",
            BOOT_BROWSER_RETRY_AFTER_SECONDS,
        )),
        BootBrowserState::Stopped => Some(OriginError::with_report(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            BOOT_BROWSER_STOPPED_CODE,
            "Instafy's browser stopped and was not started again; restart this space's machine to open it",
            serde_json::json!({}),
        )),
    }
}
