//! Whether this process hosts Instafy's browser lazily, decided once at
//! startup, and the fixed settings a lazy host uses.
//!
//! Lazy mode needs the controller's attestation for this exact lease in the
//! launch metadata (`_instafyManagedBrowserHost`, written by the controller
//! for a covered space's own machine), Linux, no eager boot-time browser, and
//! the image's private browser stack. Without all of them nothing here
//! changes the process.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::anyhow;
use serde_json::Value as JsonValue;
use uuid::Uuid;

/// The launch-metadata key the controller attests a browser host with.
pub const ATTESTATION_KEY: &str = "_instafyManagedBrowserHost";
pub const ATTESTATION_VERSION: u64 = 1;
pub const LAZY_MODE: &str = "lazy";
/// The registration capability's version (`browserHost.version`).
pub const CAPABILITY_VERSION: u64 = 1;

/// The host's X display and loopback ports. They differ from the boot-time
/// browser's (`:1`, 5900, 9223, 9225, 9226), which the entrypoint reserves.
pub const HOST_DISPLAY: &str = ":47";
pub const HOST_CDP_PORT: u16 = 19223;
pub const HOST_VNC_PORT: u16 = 15900;
pub const HOST_EGRESS_PORT: u16 = 19226;

/// In the container's writable layer: not a workspace volume, and not under
/// `/tmp`, which model tools clean.
pub const HOST_ROOT: &str = "/var/lib/instafy/browser-host";
/// The host's private Node and Playwright, outside the `/usr/local` tree that
/// workspace tooling rewrites (`docker/runtime/Dockerfile`).
pub const HOST_NODE_BINARY: &str = "/opt/instafy/browser-host/bin/node";
pub const HOST_NODE_MODULES_ROOT: &str = "/opt/instafy/browser-host/node_modules";
pub const HOST_PLAYWRIGHT_PATH: &str = "/opt/instafy/browser-host/node_modules/playwright";
/// Debian's real Chromium binary, preferred over its shell wrapper.
pub const PINNED_CHROMIUM: &str = "/usr/lib/chromium/chromium";
pub const ENTRYPOINT_ENV: &str = "INSTAFY_RUNTIME_ENTRYPOINT";
pub const DEFAULT_ENTRYPOINT: &str = "/usr/local/bin/runtime-entrypoint";
/// The Node binary the Shared Browser controller runs with. Only
/// [`ALLOWED_SHARED_BROWSER_NODE_BINARIES`] are accepted.
pub const SHARED_BROWSER_NODE_BINARY_ENV: &str = "INSTAFY_SHARED_BROWSER_NODE_BINARY";

pub const START_BUDGET: Duration = Duration::from_secs(75);
pub const IDLE_STOP_AFTER: Duration = Duration::from_secs(15 * 60);
pub const IDLE_TICK: Duration = Duration::from_secs(30);
pub const STOP_GRACE: Duration = Duration::from_secs(10);
pub const PRESENCE_GRACE: Duration = Duration::from_secs(30);

const BROWSER_SESSION_ENV: &str = "INSTAFY_ENABLE_BROWSER_SESSION";
const PERSIST_ENV: &str = "INSTAFY_BROWSER_PROFILE_PERSIST";
const LEASE_ID_ENV: &str = "RUNTIME_LEASE_ID";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LazyMode {
    /// `INSTAFY_BROWSER_PROFILE_PERSIST=1`: the host keeps its profile.
    pub persist: bool,
}

#[derive(Clone, Debug)]
struct Captured {
    mode: LazyMode,
    entrypoint: PathBuf,
}

static MODE: OnceLock<Option<Captured>> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static FORCED: std::cell::RefCell<Option<Option<LazyMode>>> =
        const { std::cell::RefCell::new(None) };
}

/// What [`capture_process_mode`] decides from. Pure, so the attestation
/// matrix is testable without the process environment.
#[derive(Clone, Debug, Default)]
pub(crate) struct ModeInputs {
    pub is_linux: bool,
    pub browser_session: Option<String>,
    pub metadata: Option<String>,
    pub lease_id: Option<String>,
    pub persist: Option<String>,
    pub stack_present: bool,
}

impl ModeInputs {
    fn from_process(entrypoint: &Path) -> Self {
        let is_linux = cfg!(target_os = "linux");
        Self {
            is_linux,
            browser_session: std::env::var(BROWSER_SESSION_ENV).ok(),
            metadata: crate::config::captured_launch_metadata(),
            lease_id: std::env::var(LEASE_ID_ENV).ok(),
            persist: std::env::var(PERSIST_ENV).ok(),
            stack_present: is_linux && stack_present(entrypoint),
        }
    }
}

fn truthy(raw: Option<&str>) -> bool {
    raw.map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

fn stack_present(entrypoint: &Path) -> bool {
    is_executable_file(entrypoint)
        && is_executable_file(Path::new(HOST_NODE_BINARY))
        && Path::new(HOST_PLAYWRIGHT_PATH).is_dir()
}

fn entrypoint_path() -> PathBuf {
    std::env::var(ENTRYPOINT_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| Path::new(value).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ENTRYPOINT))
}

/// Whether the launch metadata attests this exact lease as a lazy browser
/// host. Mirrors the controller's `managed_browser_host_is_attested`.
pub(crate) fn metadata_attests_lease(metadata: Option<&str>, lease_id: Option<&str>) -> bool {
    let Some(lease_id) = lease_id.and_then(|raw| Uuid::parse_str(raw.trim()).ok()) else {
        return false;
    };
    let Some(metadata) = metadata.and_then(|raw| serde_json::from_str::<JsonValue>(raw).ok())
    else {
        return false;
    };
    let Some(attestation) = metadata
        .as_object()
        .and_then(|root| root.get(ATTESTATION_KEY))
        .and_then(JsonValue::as_object)
    else {
        return false;
    };
    attestation.get("version").and_then(JsonValue::as_u64) == Some(ATTESTATION_VERSION)
        && attestation.get("mode").and_then(JsonValue::as_str) == Some(LAZY_MODE)
        && attestation
            .get("generation")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            == Some(lease_id)
}

pub(crate) fn resolve_lazy_mode(inputs: &ModeInputs) -> Option<LazyMode> {
    if !inputs.is_linux || truthy(inputs.browser_session.as_deref()) {
        return None;
    }
    if !metadata_attests_lease(inputs.metadata.as_deref(), inputs.lease_id.as_deref()) {
        return None;
    }
    if !inputs.stack_present {
        return None;
    }
    Some(LazyMode {
        persist: inputs.persist.as_deref().map(str::trim) == Some("1"),
    })
}

/// The process environment a lazy host's agent runs with: `Some` sets the
/// key, `None` removes it. Origin, the Codex MCP copy and the legacy profile
/// code all read these, so setting them once before any thread starts makes
/// all three agree.
pub(crate) fn lazy_env_overrides(
    current: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, Option<String>)> {
    let mut overrides = vec![
        (
            "INSTAFY_PLAYWRIGHT_CDP_PORT",
            Some(HOST_CDP_PORT.to_string()),
        ),
        ("INSTAFY_PLAYWRIGHT_CDP_URL", None),
        ("INSTAFY_VNC_HOST", Some("127.0.0.1".to_string())),
        ("INSTAFY_VNC_PORT", Some(HOST_VNC_PORT.to_string())),
        // WebRTC is off on hosts in Phase 1: origin then refuses an offer
        // before it reads any relay credential, whatever the controller sent.
        ("INSTAFY_BROWSER_WEBRTC_ENABLED", Some("0".to_string())),
        ("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN", None),
        ("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON", None),
        ("INSTAFY_BROWSER_EGRESS_ISOLATION", Some("1".to_string())),
        ("INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV", None),
        (
            "INSTAFY_PLAYWRIGHT_PROFILE_DIR",
            Some(format!("{HOST_ROOT}/profile")),
        ),
        (
            "INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH",
            Some(HOST_PLAYWRIGHT_PATH.to_string()),
        ),
        (
            "INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT",
            Some(HOST_NODE_MODULES_ROOT.to_string()),
        ),
        (
            SHARED_BROWSER_NODE_BINARY_ENV,
            Some(HOST_NODE_BINARY.to_string()),
        ),
    ];
    if current("INSTAFY_BROWSER_PREFERRED_VIEWER")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("webrtc"))
    {
        overrides.push((
            "INSTAFY_BROWSER_PREFERRED_VIEWER",
            Some("cdp-screencast".to_string()),
        ));
    }
    overrides
}

/// Decides lazy mode once and, in lazy mode only, fixes the process
/// environment the host's readers use.
///
/// # Safety
///
/// Mutates the process environment. Call it before any other thread exists,
/// after `config::capture_and_scrub_launch_credentials`.
pub unsafe fn capture_process_mode() -> anyhow::Result<()> {
    let entrypoint = entrypoint_path();
    let inputs = ModeInputs::from_process(&entrypoint);
    // SAFETY: forwarded from the caller.
    unsafe { capture_with(inputs, entrypoint) }
}

/// # Safety
///
/// As [`capture_process_mode`].
pub(crate) unsafe fn capture_with(inputs: ModeInputs, entrypoint: PathBuf) -> anyhow::Result<()> {
    let mode = resolve_lazy_mode(&inputs);
    MODE.set(mode.map(|mode| Captured { mode, entrypoint }))
        .map_err(|_| anyhow!("the browser host mode was captured twice"))?;
    if mode.is_some() {
        for (key, value) in lazy_env_overrides(|key| std::env::var(key).ok()) {
            match value {
                // SAFETY: the caller guarantees no concurrent environment access.
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }
    Ok(())
}

/// The captured lazy mode, if any.
pub fn lazy_mode_settings() -> Option<LazyMode> {
    #[cfg(test)]
    if let Some(forced) = FORCED.with(|forced| *forced.borrow()) {
        return forced;
    }
    MODE.get()
        .and_then(Option::as_ref)
        .map(|captured| captured.mode)
}

/// The entrypoint the captured lazy mode checked.
pub(crate) fn captured_entrypoint() -> Option<PathBuf> {
    MODE.get()
        .and_then(Option::as_ref)
        .map(|captured| captured.entrypoint.clone())
}

pub fn lazy_mode() -> bool {
    lazy_mode_settings().is_some()
}

/// Whether this runtime may run Shared Browser turns at all: the boot-time
/// browser session, or a lazy host. Static; it never means the browser is
/// running.
pub fn shared_browser_capability_is_present() -> bool {
    truthy(std::env::var(BROWSER_SESSION_ENV).ok().as_deref()) || lazy_mode()
}

/// What this runtime reports at registration: `browserHost` in lazy mode.
pub fn registration_capability() -> Option<JsonValue> {
    lazy_mode().then(|| {
        serde_json::json!({
            "version": CAPABILITY_VERSION,
            "modes": [LAZY_MODE],
        })
    })
}

/// Forces [`lazy_mode`] on this thread until the guard drops. `#[tokio::test]`
/// runs on the current thread, so the override covers its tasks.
#[cfg(test)]
pub(crate) fn force_lazy_mode_for_tests(mode: Option<LazyMode>) -> ForcedLazyMode {
    let previous = FORCED.with(|forced| forced.replace(Some(mode)));
    ForcedLazyMode { previous }
}

#[cfg(test)]
pub(crate) struct ForcedLazyMode {
    previous: Option<Option<LazyMode>>,
}

#[cfg(test)]
impl Drop for ForcedLazyMode {
    fn drop(&mut self) {
        let previous = self.previous.take();
        FORCED.with(|forced| *forced.borrow_mut() = previous);
    }
}
