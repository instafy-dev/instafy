//! Instafy's browser on a hosted space's own machine, started on demand.
//!
//! When the controller attests this lease as a lazy browser host (see
//! [`mode`]), the agent runs no browser at boot. Origin's browser routes ask
//! this module to start one (`runtime-entrypoint start-browser-host`) when
//! someone opens the browser, the host stops again after 15 idle minutes, and
//! Shared Browser turns run only while it is Ready. Without the attestation
//! nothing here does anything.

pub mod mode;
pub mod process;
pub mod supervisor;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use origin_http_server::browser_host::{
    BrowserHostCallerFacts, BrowserHostControl, BrowserHostHandle, BrowserHostRefusal,
    BrowserHostSnapshot,
};

pub use mode::{
    LazyMode, capture_process_mode, lazy_mode, lazy_mode_settings, registration_capability,
    shared_browser_capability_is_present,
};
pub use supervisor::{BrowserHost, HostConfig, JobActivityGuard};

use crate::controller::ControllerClient;

static HOST: OnceLock<Arc<BrowserHost>> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEST_HOST: std::cell::RefCell<Option<Arc<BrowserHost>>> =
        const { std::cell::RefCell::new(None) };
}

/// The process's host, when this process runs one.
fn current() -> Option<Arc<BrowserHost>> {
    #[cfg(test)]
    if let Some(host) = TEST_HOST.with(|host| host.borrow().clone()) {
        return Some(host);
    }
    HOST.get().cloned()
}

/// Publishes the process's host in lazy mode; does nothing otherwise or when
/// already installed. Call once from the agent, inside the Tokio runtime.
/// The controller client is where PR-5b restores and saves the profile.
pub fn install(_client: Arc<ControllerClient>) {
    if !lazy_mode() || HOST.get().is_some() {
        return;
    }
    let Some(entrypoint) = mode::captured_entrypoint() else {
        return;
    };
    let _ = HOST.set(BrowserHost::spawn(HostConfig::for_process(entrypoint)));
}

/// What origin's browser routes call; `None` without a host.
pub fn origin_handle() -> Option<BrowserHostHandle> {
    current().map(|host| Arc::new(OriginAdapter(host)) as BrowserHostHandle)
}

/// Whether the host is running and answering on CDP.
pub fn is_ready() -> bool {
    current().is_some_and(|host| host.is_ready())
}

/// Held for a whole Shared Browser job; `None` without a host.
pub fn job_activity() -> Option<JobActivityGuard> {
    current().map(|host| host.job_activity())
}

/// Fails closed after a Shared Browser turn whose end could not be confirmed:
/// the host is killed and refuses to start until the process exits.
pub fn poison() {
    if let Some(host) = current() {
        host.poison();
    }
}

/// Kills the host's group at once, without a save.
pub fn kill_now() {
    if let Some(host) = current() {
        host.kill_now();
    }
}

/// Stops the host for the runtime's shutdown within `budget`.
pub async fn shutdown(budget: Duration) {
    if let Some(host) = current() {
        host.shutdown(budget).await;
    }
}

/// The Shared Browser job gate: a Shared Browser job runs on the boot-time
/// browser session, or on a lazy host that is Ready. The activity guard is
/// taken before the readiness check, so an idle stop can never land between
/// the two.
pub(crate) fn admit_shared_browser_job(
    explicit_shared_browser_execution: bool,
    runtime_is_browser_session: bool,
) -> anyhow::Result<Option<JobActivityGuard>> {
    let guard = if explicit_shared_browser_execution {
        job_activity()
    } else {
        None
    };
    if explicit_shared_browser_execution && !runtime_is_browser_session && !is_ready() {
        anyhow::bail!(if lazy_mode() {
            "Instafy's browser is not open on this space's machine. Open it, then try again."
        } else {
            "Shared Browser job was routed to a runtime without INSTAFY_ENABLE_BROWSER_SESSION"
        });
    }
    Ok(guard)
}

struct OriginAdapter(Arc<BrowserHost>);

impl BrowserHostControl for OriginAdapter {
    fn snapshot(&self) -> BrowserHostSnapshot {
        self.0.snapshot()
    }

    fn caller_facts(&self, subject: &str) -> BrowserHostCallerFacts {
        self.0.caller_facts(subject)
    }

    fn request_start(&self, subject: &str) -> Result<BrowserHostSnapshot, BrowserHostRefusal> {
        self.0.request_start(subject)
    }

    fn note_seen(&self, subject: &str) {
        self.0.note_seen(subject)
    }
}

/// Makes `host` this thread's process host until the guard drops.
#[cfg(test)]
pub(crate) fn install_host_for_tests(host: Arc<BrowserHost>) -> TestHostGuard {
    let previous = TEST_HOST.with(|slot| slot.replace(Some(host)));
    TestHostGuard { previous }
}

#[cfg(test)]
pub(crate) struct TestHostGuard {
    previous: Option<Arc<BrowserHost>>,
}

#[cfg(test)]
impl Drop for TestHostGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        TEST_HOST.with(|slot| *slot.borrow_mut() = previous);
    }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
pub(crate) mod test_support;
