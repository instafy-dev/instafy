use std::borrow::Cow;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use rmcp::ErrorData as McpError;
use rmcp::ServiceExt;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, JsonObject, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use serde_json::Map as JsonMap;
use serde_json::Value as JsonValue;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::job_cancel::JobCancelSignal;

pub const ACTIONS_FILE_ENV: &str = "INSTAFY_BROWSER_ACTIONS_FILE";
pub const BROWSER_SESSION_ENV: &str = "INSTAFY_ENABLE_BROWSER_SESSION";
pub const CDP_PORT_ENV: &str = "INSTAFY_PLAYWRIGHT_CDP_PORT";
pub const CDP_URL_ENV: &str = "INSTAFY_PLAYWRIGHT_CDP_URL";
pub const PLAYWRIGHT_MODULE_PATH_ENV: &str = "INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH";
pub const TRUSTED_NODE_MODULES_ROOT_ENV: &str = "INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT";
pub const PAGE_ID_ENV: &str = "INSTAFY_SHARED_BROWSER_PAGE_ID";
pub const AGENT_CONTROL_FILE_ENV: &str = "INSTAFY_BROWSER_AGENT_CONTROL_FILE";
pub const APPROVAL_DIR_ENV: &str = "INSTAFY_SHARED_BROWSER_APPROVAL_DIR";
pub const APPROVAL_TIMEOUT_MS_ENV: &str = "INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS";
/// The space's own copy of the web-research skill's link-only list. The
/// controller enforces the sites and wrappers it adds on top of the bundled
/// list; it can never remove one.
pub const SPACE_LINK_ONLY_FILE_ENV: &str = "INSTAFY_SHARED_BROWSER_SPACE_LINK_ONLY_FILE";
pub const MCP_COMMAND: &str = "shared-browser-mcp";
pub(crate) const DEFAULT_ACTIONS_FILE: &str = "/tmp/instafy/playwright/actions.jsonl";
const DEFAULT_AGENT_CONTROL_FILE: &str = "/run/instafy/browser/agent-control.json";
const DEFAULT_APPROVAL_DIR: &str = "/run/instafy/browser/approvals";
const AGENT_CONTROL_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);
const AGENT_CONTROL_TTL: Duration = Duration::from_secs(12);
const AGENT_CONTROL_DISPLAY_NAME_MAX_BYTES: usize = 80;
const SHARED_BROWSER_SCRIPT: &str = include_str!("../assets/shared-browser-cli.js");
const SHARED_BROWSER_APPROVAL_SCRIPT: &str = include_str!("../assets/shared-browser-approval.js");
// Redaction, step classification, the page's secret checks and the form
// submission a step makes, shared with the Desktop Personal Browser. The
// package holds plain scripts, so the source is embedded as-is.
const BROWSER_REDACTION_SCRIPT: &str = include_str!("../../browser-action-policy/redaction.js");
const BROWSER_ACTION_POLICY_SCRIPT: &str =
    include_str!("../../browser-action-policy/actionPolicy.js");
const BROWSER_PAGE_CAPTURE_SCRIPT: &str =
    include_str!("../../browser-action-policy/pageCapture.js");
const BROWSER_FORM_SUBMISSION_SCRIPT: &str =
    include_str!("../../browser-action-policy/formSubmission.js");
// The sites the web-research skill keeps link-only. Octo never opens them in
// any tab; the controller enforces the skill's list, it does not own it. The
// matching (wrappers, host spelling) is the package's linkOnly.js, which
// `instafy web read` and the Desktop Personal Browser use too.
const LINK_ONLY_SITES_DATA: &str = include_str!(
    "../assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json"
);
const BROWSER_LINK_ONLY_SCRIPT: &str = include_str!("../../browser-action-policy/linkOnly.js");

const DEFAULT_SHARED_BROWSER_NODE_BINARY: &str = "/usr/bin/node";
/// The Node binaries the Shared Browser controller may run with: the image's
/// default, or a lazy browser host's private copy.
const ALLOWED_SHARED_BROWSER_NODE_BINARIES: [&str; 2] = [
    DEFAULT_SHARED_BROWSER_NODE_BINARY,
    crate::browser_host::mode::HOST_NODE_BINARY,
];
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const MAX_URL_CHARS: usize = 4_096;
/// The stand-in site a navigation path is checked against before the page,
/// which the controller resolves it against, is known.
const NAVIGATION_PATH_FORM_ORIGIN: &str = "https://path.invalid/";
const MAX_TEXT_CHARS: usize = 16_384;
const MAX_TARGET_INDEX: u64 = 199;
const SNAPSHOT_ID_CHARS: usize = 64;
const MAX_SCROLL_DELTA: f64 = 10_000.0;
const MAX_PAGE_ID_BYTES: usize = 256;
const SHARED_BROWSER_CONSENT_VERSION: u64 = 1;
const APPROVAL_DIRECTORY_MAX_ENTRIES: usize = 16;
// `withhold-next.json` records the document a key change or "may show a
// secret" step ran on, so the page it opens stays withheld; it is run-scoped
// like the rest of this directory.
//
// `tabs.json` lists the tabs Octo opened in the run (written by the
// controller script) and `kept-tabs.json` the ones the person kept (written by
// the origin). The guard reads both when the run ends, to close the rest.
//
// `leftover-tabs.json` is the one file that outlives a run: Octo's tabs from
// an earlier run that could not be closed yet (that run ended without a
// confirmed shutdown, or the browser did not answer). It grants nothing; the
// origin badges those tabs as Octo's, and the next confirmed shutdown or
// browser start closes them (see `close_agent_tabs_at`).
const APPROVAL_FIXED_FILES: [&str; 7] = [
    "request.json",
    "decision.json",
    "state.json",
    "withhold-next.json",
    AGENT_TABS_FILE,
    KEPT_AGENT_TABS_FILE,
    LEFTOVER_AGENT_TABS_FILE,
];
const AGENT_TABS_FILE: &str = "tabs.json";
const KEPT_AGENT_TABS_FILE: &str = "kept-tabs.json";
const LEFTOVER_AGENT_TABS_FILE: &str = "leftover-tabs.json";
/// The most leftover tabs the record holds: a few runs' worth of tabs that
/// could not be closed. The oldest go first.
const MAX_LEFTOVER_AGENT_TABS: usize = 4 * MAX_AGENT_TABS;
/// The most tabs of its own Octo may have open in one run, next to the page
/// the person chose. `assets/shared-browser-approval.js` (`MAX_AGENT_TABS`)
/// and the origin hold the same bound.
pub(crate) const MAX_AGENT_TABS: usize = 3;
const AGENT_TABS_FILE_MAX_BYTES: u64 = 8 * 1024;
/// How long closing one of Octo's tabs at the end of a run may take. CDP is
/// on loopback, so a slower answer is a stuck browser.
const AGENT_TAB_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_CDP_PORT: u16 = 9223;
const TERMINAL_APPROVAL_FAILURE_CODES: [&str; 10] = [
    "human_input_required",
    "approval_denied",
    "approval_timeout",
    "approval_stale",
    "approval_stale_or_replayed",
    "approval_authority_revoked",
    "approval_storage_invalid",
    "approval_protocol_invalid",
    "approval_state_invalid",
    "approval_state_full",
];
/// The terminal code a run stops on when Instafy's browser, or the run's own
/// tab, went away: [`BROWSER_UNAVAILABLE_STREAK_LIMIT`] tool calls in a row
/// could not reach it. Not an approval code: nothing in a command's error
/// text can set it, only the controller's exit code.
const BROWSER_UNAVAILABLE_CODE: &str = "browser_unavailable";
/// The exit code of `assets/shared-browser-cli.js` when it could not connect
/// to the browser over CDP, the run's page target is gone, or the browser
/// closed under the command. The script's `BROWSER_UNAVAILABLE_EXIT_CODE`
/// must stay equal to it.
const BROWSER_UNAVAILABLE_EXIT_CODE: i32 = 75;
/// Tool calls in a row that may find the browser unavailable before the run
/// stops using it. Two, so one slow connect under load does not end a turn,
/// while a browser that is gone ends it within seconds instead of the model
/// retrying for minutes.
const BROWSER_UNAVAILABLE_STREAK_LIMIT: u32 = 2;
/// How long a person has to answer the prompts of one Shared Browser tool
/// call, as `assets/shared-browser-approval.js` reads it. The script's
/// `DEFAULT_APPROVAL_WAIT_MS` and `MAX_APPROVAL_WAIT_MS`, and the origin's
/// request lifetime cap, must stay equal to these.
pub(crate) const DEFAULT_APPROVAL_WAIT: Duration = Duration::from_secs(120);
pub(crate) const MAX_APPROVAL_WAIT: Duration = Duration::from_secs(300);
const MIN_APPROVAL_WAIT: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const UNCONFIRMED_BROWSER_SHUTDOWN_EXIT_CODE: i32 = 70;
const ALLOWED_PRESS_KEYS: [&str; 15] = [
    "Enter",
    "Tab",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Backspace",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    " ",
    "Space",
];

/// How a Shared Browser run's approval state starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApprovalStart {
    /// The person approves each site, and each step unless they allow routine
    /// browsing at the first site prompt.
    Ask,
    /// Routine browsing from the start: sites, reading, plain links, menus,
    /// ordinary clicks, typing that does not submit and non-activation keys
    /// run without prompts. Named risky steps, commit buttons, risky
    /// addresses, submissions and Enter/Space still ask.
    Routine,
}

/// The approval start of every Shared Browser run in this process. Runs on a
/// lazy browser host start in routine browsing: the controller attests that
/// host only for a covered space's own machine, and this process captures it
/// once at startup. Job metadata, tool arguments and the model never choose
/// it. Every other runtime starts in Ask.
pub(crate) fn run_approval_start() -> ApprovalStart {
    if crate::browser_host::lazy_mode() {
        ApprovalStart::Routine
    } else {
        ApprovalStart::Ask
    }
}

/// The approval budget the script uses for an
/// `INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS` value, clamped the same way.
/// A value this side cannot read counts as the maximum, so a tool timeout
/// sized from it never falls short of the script's budget.
pub(crate) fn approval_wait_budget(raw: Option<&str>) -> Duration {
    let Some(raw) = raw else {
        return DEFAULT_APPROVAL_WAIT;
    };
    match raw.trim().parse::<f64>() {
        Ok(millis) if millis.is_finite() => Duration::from_millis(millis.floor().clamp(
            MIN_APPROVAL_WAIT.as_millis() as f64,
            MAX_APPROVAL_WAIT.as_millis() as f64,
        ) as u64),
        Ok(_) => DEFAULT_APPROVAL_WAIT,
        Err(_) => MAX_APPROVAL_WAIT,
    }
}

/// Runtime-local authority marker consumed by origin-http-server. The marker
/// never contains page contents, typed text, or credentials; it only tells the
/// browser input arbiter that an exact Shared Browser job currently owns the
/// runtime-wide control lane.
pub struct SharedBrowserAgentControlGuard {
    path: PathBuf,
    approval_dir: PathBuf,
    /// Where the browser's DevTools HTTP endpoint listens, to close Octo's
    /// tabs when the run ends. None when it is not a loopback HTTP address.
    cdp_base: Option<(String, u16)>,
    owner_id: String,
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: String,
    active: Arc<AtomicBool>,
    marker_io: Arc<Mutex<()>>,
    shutdown_confirmation: JobCancelSignal,
    heartbeat: JoinHandle<()>,
    /// Closes the windows pages in Octo's tabs open by themselves while the
    /// run holds the browser (see [`close_windows_opened_from_agent_tabs`]).
    window_watch: Option<JoinHandle<()>>,
}

#[cfg(test)]
static RUNTIME_RECYCLE_REQUESTED: AtomicBool = AtomicBool::new(false);

fn recycle_runtime_after_unconfirmed_browser_shutdown() {
    // A lazy browser host fails closed without ending the machine: the host
    // is killed and refuses to start again until the process exits, and the
    // marker stays in place, so origin keeps refusing human input.
    if crate::browser_host::lazy_mode() {
        crate::browser_host::poison();
        return;
    }
    #[cfg(test)]
    {
        RUNTIME_RECYCLE_REQUESTED.store(true, Ordering::SeqCst);
    }
    #[cfg(not(test))]
    {
        // runtime-agent and origin share this process. Exiting leaves the
        // authority marker in place while simultaneously killing every model,
        // MCP, origin, and browser-helper task in the container. Process
        // startup clears the old marker before a new origin can accept input.
        std::process::exit(UNCONFIRMED_BROWSER_SHUTDOWN_EXIT_CODE);
    }
}

fn agent_control_file_path() -> PathBuf {
    std::env::var(AGENT_CONTROL_FILE_ENV)
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_AGENT_CONTROL_FILE))
}

fn approval_dir_path() -> PathBuf {
    std::env::var(APPROVAL_DIR_ENV)
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_APPROVAL_DIR))
}

/// Clear authority left by an earlier runtime-agent process before this
/// process starts its origin server. The origin and job executor live in the
/// same process, so process startup is the one safe boundary at which a
/// leftover marker cannot represent a still-running browser turn.
pub fn clear_stale_agent_control_marker_on_startup() -> Result<()> {
    clear_stale_agent_control_marker_on_startup_for_mode(
        runtime_runs_shared_browser_turns(),
        &agent_control_file_path(),
        &approval_dir_path(),
    )
}

/// The boot-time browser session or a lazy browser host: either may have
/// left a marker from an earlier process.
fn runtime_runs_shared_browser_turns() -> bool {
    browser_session_enabled(std::env::var(BROWSER_SESSION_ENV).ok().as_deref())
        || crate::browser_host::lazy_mode()
}

fn clear_stale_agent_control_marker_on_startup_for_mode(
    browser_session_enabled: bool,
    marker_path: &Path,
    approval_dir: &Path,
) -> Result<()> {
    clear_stale_agent_control_marker_at_startup(
        browser_session_enabled,
        marker_path,
        approval_dir,
        cdp_endpoint_from_env().as_ref(),
    )
}

/// [`clear_stale_agent_control_marker_on_startup_for_mode`] with the DevTools
/// endpoint given, so a test reaches the same closing.
fn clear_stale_agent_control_marker_at_startup(
    browser_session_enabled: bool,
    marker_path: &Path,
    approval_dir: &Path,
    cdp_base: Option<&(String, u16)>,
) -> Result<()> {
    if !browser_session_enabled {
        return Ok(());
    }
    // The run that held the browser when the last process ended without a
    // confirmed shutdown may have left tabs of Octo's open. They are read
    // before the run's own records are revoked, then closed now if the
    // browser answers; those that stay open join the leftover record, so they
    // stay badged as Octo's and close at the next confirmed shutdown or
    // browser start.
    let mut run_tabs = Vec::new();
    if let Some(binding) = stale_marker_binding(marker_path) {
        match agent_tabs_to_close(approval_dir, &binding) {
            Ok(tabs) => run_tabs = tabs,
            Err(error) => tracing::warn!(
                ?error,
                "Shared Browser could not read the tabs Octo opened before the restart; they stay open as ordinary tabs"
            ),
        }
    }
    clear_stale_agent_control_marker(marker_path)?;
    prepare_clean_approval_directory(approval_dir)?;
    close_agent_tabs_and_settle_leftovers(approval_dir, cdp_base, run_tabs);
    Ok(())
}

/// The run a marker or a record is bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RunBinding {
    owner_id: String,
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: String,
}

/// The run a marker left by an earlier process was bound to, when it can be
/// read. It proves only which run's tab record is that run's own.
fn stale_marker_binding(path: &Path) -> Option<RunBinding> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4 * 1024 {
        return None;
    }
    let marker: JsonValue = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if marker.get("version").and_then(JsonValue::as_u64) != Some(2) {
        return None;
    }
    let text = |key: &str| marker.get(key).and_then(JsonValue::as_str);
    Some(RunBinding {
        owner_id: Uuid::parse_str(text("ownerId")?).ok()?.to_string(),
        run_id: Uuid::parse_str(text("runId")?).ok()?,
        initiator_user_id: Uuid::parse_str(text("initiatorUserId")?).ok()?,
        browser_page_id: validate_page_id(text("browserPageId")?).ok()?,
    })
}

fn clear_stale_agent_control_marker(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to clear stale Shared Browser agent-control marker {}",
                path.display()
            )
        }),
    }
}

fn prepare_clean_approval_directory(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("Shared Browser approval directory must be an absolute runtime-local path");
    }
    std::fs::create_dir_all(path).with_context(|| {
        format!(
            "failed to create Shared Browser approval directory {}",
            path.display()
        )
    })?;
    let metadata = std::fs::symlink_metadata(path).with_context(|| {
        format!(
            "failed to inspect Shared Browser approval directory {}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!(
            "Shared Browser approval path {} must be a real directory",
            path.display()
        );
    }
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).with_context(|| {
        format!(
            "failed to protect Shared Browser approval directory {}",
            path.display()
        )
    })?;

    let entries = std::fs::read_dir(path)
        .with_context(|| {
            format!(
                "failed to list Shared Browser approval directory {}",
                path.display()
            )
        })?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| {
            format!(
                "failed to read Shared Browser approval directory {}",
                path.display()
            )
        })?;
    if entries.len() > APPROVAL_DIRECTORY_MAX_ENTRIES {
        bail!(
            "Shared Browser approval directory {} exceeds its bounded entry count",
            path.display()
        );
    }
    for entry in entries {
        let file_name = entry.file_name();
        let file_name = file_name
            .to_str()
            .context("Shared Browser approval directory contains a non-UTF-8 entry")?;
        let known = APPROVAL_FIXED_FILES.contains(&file_name)
            || file_name.starts_with(".instafy-approval-");
        if !known {
            bail!("Shared Browser approval directory contains unsupported entry {file_name}");
        }
        let metadata = std::fs::symlink_metadata(entry.path()).with_context(|| {
            format!(
                "failed to inspect Shared Browser approval entry {}",
                entry.path().display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!(
                "Shared Browser approval entry {} must be a regular file",
                entry.path().display()
            );
        }
        // Every run-scoped file is revoked. The leftover record names tabs
        // that may still be open and grants nothing, so it stays.
        if file_name == LEFTOVER_AGENT_TABS_FILE {
            continue;
        }
        std::fs::remove_file(entry.path()).with_context(|| {
            format!(
                "failed to revoke Shared Browser approval entry {}",
                entry.path().display()
            )
        })?;
    }
    Ok(())
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn normalized_agent_control_display_name(raw: &str) -> String {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut end = normalized.len().min(AGENT_CONTROL_DISPLAY_NAME_MAX_BYTES);
    while end > 0 && !normalized.is_char_boundary(end) {
        end -= 1;
    }
    let bounded = normalized[..end].to_string();
    if bounded.is_empty() {
        "Assistant".to_string()
    } else {
        bounded
    }
}

fn write_agent_control_marker(
    path: &Path,
    owner_id: &str,
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: &str,
    display_name: &str,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create Shared Browser agent-control directory {}",
                parent.display()
            )
        })?;
        #[cfg(unix)]
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).with_context(
            || {
                format!(
                    "failed to protect Shared Browser agent-control directory {}",
                    parent.display()
                )
            },
        )?;
    }
    let expires_at_ms = unix_time_millis()
        .saturating_add(AGENT_CONTROL_TTL.as_millis().try_into().unwrap_or(u64::MAX));
    let payload = serde_json::to_vec(&json!({
        "version": 2,
        "ownerId": owner_id,
        "runId": run_id,
        "initiatorUserId": initiator_user_id,
        "browserPageId": browser_page_id,
        "displayName": display_name,
        "expiresAtMs": expires_at_ms,
    }))?;
    let temp_path = path.with_extension(format!("{}.tmp", owner_id));
    publish_private_file(
        &temp_path,
        path,
        &payload,
        "Shared Browser agent-control marker",
    )
}

/// Writes `payload` to a new owner-only file at `temp_path`, syncs it and
/// renames it over `path`.
fn publish_private_file(temp_path: &Path, path: &Path, payload: &[u8], what: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(temp_path)
        .with_context(|| format!("failed to create {what} {}", temp_path.display()))?;
    file.write_all(payload)
        .with_context(|| format!("failed to write {what} {}", temp_path.display()))?;
    file.sync_all()
        .with_context(|| format!("failed to sync {what} {}", temp_path.display()))?;
    drop(file);
    #[cfg(unix)]
    std::fs::set_permissions(temp_path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to protect {what} {}", temp_path.display()))?;
    std::fs::rename(temp_path, path)
        .with_context(|| format!("failed to publish {what} {}", path.display()))?;
    Ok(())
}

/// Starts the run's approval state in routine browsing, bound to the exact
/// authority the marker will carry. The approval scripts read this file as
/// the run's state; they reject it if any binding differs from the marker.
#[cfg(test)]
fn write_routine_approval_state(
    approval_dir: &Path,
    owner_id: &str,
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: &str,
) -> Result<()> {
    write_starting_approval_state(
        approval_dir,
        owner_id,
        run_id,
        initiator_user_id,
        browser_page_id,
        &[],
        true,
    )
}

/// Starts the run's approval state with sites already approved on the page
/// the person chose and, when `routine_browsing_allowed`, in routine
/// browsing, bound to the exact authority the marker will carry.
fn write_starting_approval_state(
    approval_dir: &Path,
    owner_id: &str,
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: &str,
    approved_origins: &[String],
    routine_browsing_allowed: bool,
) -> Result<()> {
    let payload = serde_json::to_vec(&json!({
        "version": 1,
        "ownerId": owner_id,
        "runId": run_id,
        "initiatorUserId": initiator_user_id,
        "browserPageId": browser_page_id,
        "approvedOrigins": approved_origins,
        "consumedApprovalIds": [],
        "routineBrowsingAllowed": routine_browsing_allowed,
    }))?;
    // The temporary name uses the prefix the approval directory cleanup
    // accepts, so a write cut short is revoked with the rest of the run.
    publish_private_file(
        &approval_dir.join(format!(".instafy-approval-{owner_id}")),
        &approval_dir.join("state.json"),
        &payload,
        "Shared Browser approval state",
    )
}

/// How long after a run ends a run that continues it may still take over its
/// approvals: the ten minutes a manual browser step stays open.
const CONTINUATION_WINDOW: Duration = Duration::from_secs(10 * 60);
/// The most sites one run approves on its page (the script's
/// `MAX_APPROVED_ORIGINS`).
const MAX_APPROVED_ORIGINS: usize = 32;
const APPROVAL_STATE_FILE: &str = "state.json";
const APPROVAL_STATE_MAX_BYTES: u64 = 16 * 1024;

/// What the last run to hold the browser left for a run that continues it:
/// the sites the person approved on the page they chose, and routine browsing
/// when they allowed it. Octo's own tabs closed with that run, and the sites
/// approved in them went with them. Kept in this process only, so a runtime
/// that starts again (and its browser, whose page ids are new) carries
/// nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
struct EndedRunGrants {
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: String,
    approved_origins: Vec<String>,
    routine_browsing_allowed: bool,
    ended_at: std::time::Instant,
}

/// The last ended run's grants, by approval directory (one per runtime; a
/// test has its own).
static ENDED_RUN_GRANTS: Mutex<Option<std::collections::HashMap<PathBuf, EndedRunGrants>>> =
    Mutex::new(None);

fn with_ended_run_grants<T>(
    operation: impl FnOnce(&mut std::collections::HashMap<PathBuf, EndedRunGrants>) -> T,
) -> T {
    let mut guard = ENDED_RUN_GRANTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(guard.get_or_insert_with(Default::default))
}

/// Records what the run that just let go of the browser leaves for a run
/// that continues it, or that it leaves nothing.
fn store_ended_run_grants(approval_dir: &Path, grants: Option<EndedRunGrants>) {
    with_ended_run_grants(|records| match grants {
        Some(grants) => {
            records.insert(approval_dir.to_path_buf(), grants);
        }
        None => {
            records.remove(approval_dir);
        }
    });
}

fn forget_ended_run_grants(approval_dir: &Path) {
    with_ended_run_grants(|records| {
        records.remove(approval_dir);
    });
}

/// The run's own approval state, read the way the approval script writes it.
/// A state that is missing, bound to another run or not well formed leaves
/// nothing to carry.
fn ended_run_grants(approval_dir: &Path, binding: &RunBinding) -> Option<EndedRunGrants> {
    let state = read_run_record_bounded(
        approval_dir,
        APPROVAL_STATE_FILE,
        &[1],
        binding,
        APPROVAL_STATE_MAX_BYTES,
    )
    .ok()
    .flatten()?;
    let origins = state.get("approvedOrigins")?.as_array()?;
    if origins.len() > MAX_APPROVED_ORIGINS {
        return None;
    }
    let mut approved_origins = Vec::with_capacity(origins.len());
    for origin in origins {
        let origin = origin.as_str()?;
        if !is_normalized_web_origin(origin) || approved_origins.iter().any(|seen| seen == origin) {
            return None;
        }
        approved_origins.push(origin.to_string());
    }
    let routine_browsing_allowed = match state.get("routineBrowsingAllowed") {
        None => false,
        Some(value) => value.as_bool()?,
    };
    Some(EndedRunGrants {
        run_id: binding.run_id,
        initiator_user_id: binding.initiator_user_id,
        browser_page_id: binding.browser_page_id.clone(),
        approved_origins,
        routine_browsing_allowed,
        ended_at: std::time::Instant::now(),
    })
}

/// `https://example.test` or `http://127.0.0.1:8080`, exactly as a browser
/// serializes an origin.
fn is_normalized_web_origin(raw: &str) -> bool {
    raw.len() <= 512
        && reqwest::Url::parse(raw).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.has_host()
                && url.origin().ascii_serialization() == raw
        })
}

/// What a new run starts with from the run it continues. Studio's Let AI
/// continue names that run (`browserContinuesRunId`) after the person took
/// over or did a manual step; the grants carry only when it is the last run
/// that held this browser, for the same person on the same page, and ended
/// less than [`CONTINUATION_WINDOW`] ago. Any new run uses up the record, so
/// a run in between, another person, another page or a restarted browser
/// starts with nothing, as every other run does.
fn take_continued_run_grants(
    approval_dir: &Path,
    continues_run_id: Option<Uuid>,
    initiator_user_id: Uuid,
    browser_page_id: &str,
) -> Option<EndedRunGrants> {
    let grants = with_ended_run_grants(|records| records.remove(approval_dir))?;
    (continues_run_id == Some(grants.run_id)
        && grants.initiator_user_id == initiator_user_id
        && grants.browser_page_id == browser_page_id
        && grants.ended_at.elapsed() <= CONTINUATION_WINDOW)
        .then_some(grants)
}

/// The run a Shared Browser job continues, as Studio's Let AI continue names
/// it. A value that is not one UUID names none.
pub fn continued_run_id_from_payload(payload: &JsonValue) -> Option<Uuid> {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| metadata.get("browserContinuesRunId"))
        .and_then(JsonValue::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
}

fn remove_owned_agent_control_marker(
    path: &Path,
    expected_owner_id: &str,
    expected_run_id: Uuid,
    expected_initiator_user_id: Uuid,
    expected_browser_page_id: &str,
) -> Result<()> {
    remove_owned_agent_control_marker_with(
        path,
        expected_owner_id,
        expected_run_id,
        expected_initiator_user_id,
        expected_browser_page_id,
        |path| std::fs::remove_file(path),
    )
}

fn remove_owned_agent_control_marker_with(
    path: &Path,
    expected_owner_id: &str,
    expected_run_id: Uuid,
    expected_initiator_user_id: Uuid,
    expected_browser_page_id: &str,
    remove_file: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<()> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to read Shared Browser agent-control marker {} before release",
                    path.display()
                )
            });
        }
    };
    let marker: JsonValue = serde_json::from_str(&raw).with_context(|| {
        format!(
            "failed to parse Shared Browser agent-control marker {} before release",
            path.display()
        )
    })?;
    let marker_object = marker
        .as_object()
        .context("Shared Browser agent-control marker must be an object before release")?;
    let expected_keys = [
        "version",
        "ownerId",
        "runId",
        "initiatorUserId",
        "browserPageId",
        "displayName",
        "expiresAtMs",
    ];
    if marker_object.len() != expected_keys.len()
        || expected_keys
            .iter()
            .any(|key| !marker_object.contains_key(*key))
    {
        bail!("Shared Browser agent-control marker schema changed unexpectedly before release");
    }
    let actual_owner_id = marker
        .get("ownerId")
        .and_then(JsonValue::as_str)
        .context("Shared Browser agent-control marker is missing its owner")?;
    if actual_owner_id != expected_owner_id {
        bail!("Shared Browser agent-control marker owner changed unexpectedly before release");
    }
    if marker.get("version").and_then(JsonValue::as_u64) != Some(2)
        || marker
            .get("runId")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            != Some(expected_run_id)
        || marker
            .get("initiatorUserId")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
            != Some(expected_initiator_user_id)
        || marker.get("browserPageId").and_then(JsonValue::as_str) != Some(expected_browser_page_id)
    {
        bail!(
            "Shared Browser agent-control marker run, user, or page binding changed unexpectedly before release"
        );
    }
    match remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to remove Shared Browser agent-control marker {}",
                path.display()
            )
        }),
    }
}

impl SharedBrowserAgentControlGuard {
    /// Publishes a job's agent control. The run's approval start is this
    /// process's own decision (an attested browser host starts in routine
    /// browsing), never the job's or the model's, and its state is written
    /// before any Codex or MCP process starts. `continues_run_id` is the run
    /// Studio's Let AI continue names: its grants carry over only as
    /// [`take_continued_run_grants`] allows.
    pub(crate) fn acquire(
        run_id: Uuid,
        initiator_user_id: Uuid,
        browser_page_id: &str,
        display_name: &str,
        continues_run_id: Option<Uuid>,
        cancel_signal: JobCancelSignal,
    ) -> Result<Self> {
        let mut guard = Self::acquire_at(
            agent_control_file_path(),
            approval_dir_path(),
            run_id,
            initiator_user_id,
            browser_page_id,
            display_name,
            continues_run_id,
            cancel_signal,
        )?;
        guard.start_window_watch();
        Ok(guard)
    }

    /// [`Self::acquire`] at explicit paths, so a test reaches the same
    /// approval-start decision a job does.
    #[allow(clippy::too_many_arguments)]
    fn acquire_at(
        path: PathBuf,
        approval_dir: PathBuf,
        run_id: Uuid,
        initiator_user_id: Uuid,
        browser_page_id: &str,
        display_name: &str,
        continues_run_id: Option<Uuid>,
        cancel_signal: JobCancelSignal,
    ) -> Result<Self> {
        Self::acquire_continuing(
            path,
            approval_dir,
            run_approval_start(),
            run_id,
            initiator_user_id,
            browser_page_id,
            display_name,
            continues_run_id,
            cancel_signal,
            AGENT_CONTROL_HEARTBEAT_INTERVAL,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn acquire_with_path(
        path: PathBuf,
        approval_dir: PathBuf,
        approval_start: ApprovalStart,
        run_id: Uuid,
        initiator_user_id: Uuid,
        browser_page_id: &str,
        display_name: &str,
        cancel_signal: JobCancelSignal,
        heartbeat_interval: Duration,
    ) -> Result<Self> {
        Self::acquire_continuing(
            path,
            approval_dir,
            approval_start,
            run_id,
            initiator_user_id,
            browser_page_id,
            display_name,
            None,
            cancel_signal,
            heartbeat_interval,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn acquire_continuing(
        path: PathBuf,
        approval_dir: PathBuf,
        approval_start: ApprovalStart,
        run_id: Uuid,
        initiator_user_id: Uuid,
        browser_page_id: &str,
        display_name: &str,
        continues_run_id: Option<Uuid>,
        cancel_signal: JobCancelSignal,
        heartbeat_interval: Duration,
    ) -> Result<Self> {
        if !path.is_absolute() {
            bail!("Shared Browser agent-control marker must use an absolute runtime-local path");
        }
        let owner_id = Uuid::new_v4().to_string();
        let display_name = normalized_agent_control_display_name(display_name);
        let browser_page_id = validate_page_id(browser_page_id)?;
        cancel_signal.reset_shared_browser_shutdown_confirmation();
        // Every new run uses up what the last one left; only the run that
        // continues it, on the same page for the same person, takes it.
        let continued = take_continued_run_grants(
            &approval_dir,
            continues_run_id,
            initiator_user_id,
            &browser_page_id,
        );
        prepare_clean_approval_directory(&approval_dir)?;
        // The starting state goes in before the marker, so no approval script
        // can act for this run without it, and a failed write ends the job
        // before anything holds the browser.
        let routine_browsing_allowed = approval_start == ApprovalStart::Routine
            || continued
                .as_ref()
                .is_some_and(|grants| grants.routine_browsing_allowed);
        let approved_origins = continued
            .map(|grants| grants.approved_origins)
            .unwrap_or_default();
        if routine_browsing_allowed || !approved_origins.is_empty() {
            write_starting_approval_state(
                &approval_dir,
                &owner_id,
                run_id,
                initiator_user_id,
                &browser_page_id,
                &approved_origins,
                routine_browsing_allowed,
            )?;
        }
        if let Err(error) = write_agent_control_marker(
            &path,
            &owner_id,
            run_id,
            initiator_user_id,
            &browser_page_id,
            &display_name,
        ) {
            // Nothing holds this run's authority, so its state is revoked too.
            let _ = prepare_clean_approval_directory(&approval_dir);
            return Err(error);
        }

        let active = Arc::new(AtomicBool::new(true));
        let marker_io = Arc::new(Mutex::new(()));
        let heartbeat_path = path.clone();
        let heartbeat_owner_id = owner_id.clone();
        let heartbeat_display_name = display_name;
        let marker_browser_page_id = browser_page_id.clone();
        let heartbeat_browser_page_id = browser_page_id;
        let heartbeat_active = active.clone();
        let heartbeat_marker_io = Arc::clone(&marker_io);
        let heartbeat_cancel_signal = cancel_signal.clone();
        let heartbeat = tokio::spawn(async move {
            let mut interval = tokio::time::interval(heartbeat_interval);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // The first marker was written synchronously above. Skip Tokio's
            // immediate first tick so it is not redundantly rewritten.
            interval.tick().await;
            loop {
                interval.tick().await;
                if !heartbeat_active.load(Ordering::SeqCst) {
                    break;
                }
                let result = {
                    let Ok(_marker_io) = heartbeat_marker_io.lock() else {
                        tracing::error!(
                            "Shared Browser agent-control marker lock was poisoned; cancelling the browser turn"
                        );
                        heartbeat_cancel_signal.cancel();
                        break;
                    };
                    // Recheck under the same lock used by Drop. Once Drop sets
                    // active=false and acquires this lock, no heartbeat can
                    // publish a marker after the confirmed removal.
                    if !heartbeat_active.load(Ordering::SeqCst) {
                        break;
                    }
                    write_agent_control_marker(
                        &heartbeat_path,
                        &heartbeat_owner_id,
                        run_id,
                        initiator_user_id,
                        &heartbeat_browser_page_id,
                        &heartbeat_display_name,
                    )
                };
                if let Err(error) = result {
                    tracing::error!(
                        ?error,
                        "Shared Browser agent-control heartbeat failed; cancelling the browser turn"
                    );
                    // Cancel on the first failed refresh, leaving the previous
                    // marker in place while fail-closed turn teardown runs.
                    // Origin treats marker presence (even past its liveness
                    // deadline) as authoritative until this guard explicitly
                    // removes it after Codex has fully shut down.
                    heartbeat_cancel_signal.cancel();
                    break;
                }
            }
        });

        Ok(Self {
            path,
            approval_dir,
            cdp_base: cdp_endpoint_from(
                std::env::var(CDP_URL_ENV).ok().as_deref(),
                std::env::var(CDP_PORT_ENV).ok().as_deref(),
            ),
            owner_id,
            run_id,
            initiator_user_id,
            browser_page_id: marker_browser_page_id,
            active,
            marker_io,
            shutdown_confirmation: cancel_signal,
            heartbeat,
            window_watch: None,
        })
    }

    fn binding(&self) -> RunBinding {
        RunBinding {
            owner_id: self.owner_id.clone(),
            run_id: self.run_id,
            initiator_user_id: self.initiator_user_id,
            browser_page_id: self.browser_page_id.clone(),
        }
    }

    /// Starts closing the windows Octo's tabs open by themselves, for as
    /// long as this guard lives. Without a loopback DevTools address there is
    /// nothing to watch; the controller still closes such windows before
    /// each step.
    fn start_window_watch(&mut self) {
        if self.window_watch.is_some() {
            return;
        }
        let Some(cdp_base) = self.cdp_base.clone() else {
            return;
        };
        self.window_watch = Some(tokio::spawn(close_windows_opened_from_agent_tabs(
            cdp_base,
            self.approval_dir.clone(),
            self.binding(),
        )));
    }
}

/// How long the window watch waits before it connects to the browser again.
const WINDOW_WATCH_RETRY: Duration = Duration::from_secs(1);
/// How many windows opened from Octo's tabs the watch remembers, so a window
/// one of them opens in turn is closed too.
const WINDOW_WATCH_MAX_REMEMBERED: usize = 64;

/// While a run holds the browser, a page in one of Octo's tabs can open
/// another window by itself between steps (a timer, or a script still holding
/// the activation of Octo's last click). Such a window is not one of Octo's
/// tabs: nothing records, counts, badges or closes it, and Octo cannot use it.
/// So it is closed as soon as the browser reports it, and so is any window it
/// opens in turn. Windows opened by the page the person chose, or by any other
/// tab, are left alone. Runs until the guard aborts it, connecting again when
/// the browser's DevTools endpoint goes away.
async fn close_windows_opened_from_agent_tabs(
    cdp_base: (String, u16),
    approval_dir: PathBuf,
    binding: RunBinding,
) {
    let mut from_agent_tabs = Vec::new();
    loop {
        if let Err(error) =
            watch_windows_once(&cdp_base, &approval_dir, &binding, &mut from_agent_tabs).await
        {
            tracing::debug!(
                ?error,
                "Shared Browser window watch lost the browser; connecting again"
            );
        }
        tokio::time::sleep(WINDOW_WATCH_RETRY).await;
    }
}

/// One connection of the window watch: target discovery on the browser's
/// loopback DevTools endpoint, which also reports the windows already open.
async fn watch_windows_once(
    cdp_base: &(String, u16),
    approval_dir: &Path,
    binding: &RunBinding,
    from_agent_tabs: &mut Vec<String>,
) -> Result<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (host, port) = cdp_base;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(AGENT_TAB_CLOSE_TIMEOUT)
        .build()?;
    let version: JsonValue = client
        .get(format!("http://{host}:{port}/json/version"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    // Only the path of the browser's own address is used: the socket goes to
    // the same loopback endpoint.
    let path = version
        .get("webSocketDebuggerUrl")
        .and_then(JsonValue::as_str)
        .and_then(|raw| reqwest::Url::parse(raw).ok())
        .map(|url| url.path().to_string())
        .filter(|path| {
            path.strip_prefix("/devtools/browser/").is_some_and(|id| {
                !id.is_empty()
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        })
        .context("the browser reported no DevTools socket")?;
    let (mut socket, _) =
        tokio_tungstenite::connect_async(format!("ws://{host}:{port}{path}")).await?;
    socket
        .send(Message::Text(
            json!({ "id": 1, "method": "Target.setDiscoverTargets", "params": { "discover": true } })
                .to_string(),
        ))
        .await?;
    let mut next_id = 2u64;
    while let Some(message) = socket.next().await {
        let Message::Text(text) = message? else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<JsonValue>(&text) else {
            continue;
        };
        if event.get("method").and_then(JsonValue::as_str) != Some("Target.targetCreated") {
            continue;
        }
        let info = &event["params"]["targetInfo"];
        let (Some("page"), Some(target_id), Some(opener_id)) = (
            info.get("type").and_then(JsonValue::as_str),
            info.get("targetId").and_then(JsonValue::as_str),
            info.get("openerId").and_then(JsonValue::as_str),
        ) else {
            continue;
        };
        if validate_page_id(target_id).is_err() || target_id == binding.browser_page_id {
            continue;
        }
        // The run's record as it is now: Octo's tabs, kept ones included. One
        // that cannot be read names no tab, and nothing is closed.
        let agent_tabs = run_agent_tabs(approval_dir, binding).unwrap_or_default();
        if agent_tabs.iter().any(|tab_id| tab_id == target_id) {
            continue;
        }
        let opened_from_agent_tab = agent_tabs.iter().any(|tab_id| tab_id == opener_id)
            || from_agent_tabs.iter().any(|id| id == opener_id);
        if !opened_from_agent_tab {
            continue;
        }
        from_agent_tabs.push(target_id.to_string());
        let excess = from_agent_tabs
            .len()
            .saturating_sub(WINDOW_WATCH_MAX_REMEMBERED);
        from_agent_tabs.drain(..excess);
        tracing::info!(
            target_id,
            "Shared Browser closed a window that one of Octo's tabs opened by itself"
        );
        socket
            .send(Message::Text(
                json!({ "id": next_id, "method": "Target.closeTarget", "params": { "targetId": target_id } })
                    .to_string(),
            ))
            .await?;
        // A window comes to the front when it opens. Once it is closed, the
        // tab Octo acts on (else the run's page) comes back to the front,
        // never a neighbouring person's tab.
        let front = read_run_record(approval_dir, AGENT_TABS_FILE, &[1, 2], binding)
            .ok()
            .flatten()
            .and_then(|record| {
                record
                    .get("currentTabId")
                    .and_then(JsonValue::as_str)
                    .and_then(|id| validate_page_id(id).ok())
            })
            .unwrap_or_else(|| binding.browser_page_id.clone());
        socket
            .send(Message::Text(
                json!({ "id": next_id + 1, "method": "Target.activateTarget", "params": { "targetId": front } })
                    .to_string(),
            ))
            .await?;
        next_id += 2;
    }
    Ok(())
}

impl SharedBrowserAgentControlGuard {
    /// This run's tabs that the person did not keep, which the run's end
    /// closes.
    fn agent_tabs_to_close(&self) -> Vec<String> {
        match agent_tabs_to_close(&self.approval_dir, &self.binding()) {
            Ok(tabs) => tabs,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "Shared Browser could not read the tabs Octo opened; they stay open as ordinary tabs"
                );
                Vec::new()
            }
        }
    }
}

/// `earlier` followed by the tabs of `later` it does not name yet, bounded to
/// the newest [`MAX_LEFTOVER_AGENT_TABS`].
fn merge_agent_tabs(earlier: Vec<String>, later: Vec<String>) -> Vec<String> {
    let mut merged = earlier;
    for tab_id in later {
        if !merged.contains(&tab_id) {
            merged.push(tab_id);
        }
    }
    let excess = merged.len().saturating_sub(MAX_LEFTOVER_AGENT_TABS);
    merged.drain(..excess);
    merged
}

/// Closes `run_tabs` and the leftover tabs of earlier runs, then settles the
/// leftover record: the tabs this pass closed (or found gone) leave it, and
/// the run's tabs that are still open join it.
///
/// The origin also rewrites the record, when a person keeps a leftover tab.
/// So the record is read again once the pass is over, under the approval
/// directory's lock that the origin takes too, and only this pass's change
/// is applied to it: a tab a person kept meanwhile is never put back, and a
/// tab another pass added meanwhile is never dropped.
fn close_agent_tabs_and_settle_leftovers(
    approval_dir: &Path,
    cdp_base: Option<&(String, u16)>,
    run_tabs: Vec<String>,
) {
    let earlier = read_leftover_agent_tabs(approval_dir);
    let attempted = merge_agent_tabs(earlier.clone(), run_tabs);
    if attempted.is_empty() {
        return;
    }
    let still_open = close_agent_tabs_at(cdp_base, attempted.clone());
    let settled = lock_approval_directory(approval_dir).and_then(|_lock| {
        let current = read_leftover_agent_tabs(approval_dir);
        let not_closed_here =
            |tab_id: &String| !attempted.contains(tab_id) || still_open.contains(tab_id);
        let joining = still_open
            .iter()
            .filter(|tab_id| !earlier.contains(tab_id))
            .cloned()
            .collect();
        let next = merge_agent_tabs(
            current.into_iter().filter(not_closed_here).collect(),
            joining,
        );
        write_leftover_agent_tabs(approval_dir, &next)
    });
    if let Err(error) = settled {
        tracing::warn!(
            ?error,
            "Shared Browser could not record Octo's tabs that are still open"
        );
    }
}

/// The approval directory's lock, held while it lives (`flock` on the
/// directory itself, so the directory holds no lock file). runtime-agent and
/// the origin each take it around reading and publishing the leftover
/// record, the one record both of them rewrite.
struct ApprovalDirectoryLock {
    #[cfg(unix)]
    _directory: std::fs::File,
}

#[cfg(unix)]
fn lock_approval_directory(approval_dir: &Path) -> Result<ApprovalDirectoryLock> {
    use std::os::fd::AsRawFd;

    let directory = std::fs::File::open(approval_dir)
        .context("failed to open the Shared Browser approval directory to lock it")?;
    loop {
        // SAFETY: `flock` on a descriptor this function owns. Closing it,
        // when the lock is dropped, releases the lock.
        if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(ApprovalDirectoryLock {
                _directory: directory,
            });
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error).context("failed to lock the Shared Browser approval directory");
        }
    }
}

#[cfg(not(unix))]
fn lock_approval_directory(_approval_dir: &Path) -> Result<ApprovalDirectoryLock> {
    Ok(ApprovalDirectoryLock {})
}

/// Closes each tab through the browser's loopback DevTools endpoint and
/// returns the tabs that may still be open. A tab that closed, or that the
/// browser no longer has, is done with. Once the endpoint cannot be reached,
/// the rest are kept without another attempt, so a browser that is down
/// costs one bounded wait.
fn close_agent_tabs_at(cdp_base: Option<&(String, u16)>, tabs: Vec<String>) -> Vec<String> {
    if tabs.is_empty() {
        return tabs;
    }
    let Some((host, port)) = cdp_base else {
        tracing::warn!(
            tabs = tabs.len(),
            "Shared Browser has no loopback DevTools address; Octo's tabs stay open, badged as Octo's"
        );
        return tabs;
    };
    let mut remaining = Vec::new();
    let mut reachable = true;
    for tab_id in tabs {
        if !reachable {
            remaining.push(tab_id);
            continue;
        }
        match close_browser_tab(host, *port, &tab_id) {
            Ok(()) => {}
            Err(failure) => {
                tracing::warn!(
                    error = ?failure.error,
                    tab_id,
                    "Shared Browser could not close one of Octo's tabs; it stays open, badged as Octo's"
                );
                reachable = !failure.unreachable;
                remaining.push(tab_id);
            }
        }
    }
    remaining
}

/// The DevTools endpoint of this process's browser, from the environment the
/// controller script reads.
fn cdp_endpoint_from_env() -> Option<(String, u16)> {
    cdp_endpoint_from(
        std::env::var(CDP_URL_ENV).ok().as_deref(),
        std::env::var(CDP_PORT_ENV).ok().as_deref(),
    )
}

/// After Instafy's browser starts: the leftover tabs of earlier runs are
/// closed, or found gone (a browser that started again has none of them).
/// Blocking, with bounded waits; call it off the async executor.
pub(crate) fn close_leftover_agent_tabs_after_browser_start() {
    if !runtime_runs_shared_browser_turns() {
        return;
    }
    close_agent_tabs_and_settle_leftovers(
        &approval_dir_path(),
        cdp_endpoint_from_env().as_ref(),
        Vec::new(),
    );
}

/// The leftover record: Octo's tabs from earlier runs that may still be
/// open. One that cannot be read safely names no tab.
fn read_leftover_agent_tabs(approval_dir: &Path) -> Vec<String> {
    let path = approval_dir.join(LEFTOVER_AGENT_TABS_FILE);
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return Vec::new();
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > AGENT_TABS_FILE_MAX_BYTES
    {
        return Vec::new();
    }
    let Some(record) = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<JsonValue>(&bytes).ok())
    else {
        return Vec::new();
    };
    if record.get("version").and_then(JsonValue::as_u64) != Some(1) {
        return Vec::new();
    }
    let Some(tabs) = record.get("tabs").and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    let mut leftovers = Vec::new();
    for tab in tabs.iter().take(MAX_LEFTOVER_AGENT_TABS) {
        let Some(tab_id) = tab
            .get("tabId")
            .and_then(JsonValue::as_str)
            .and_then(|id| validate_page_id(id).ok())
        else {
            return Vec::new();
        };
        leftovers.push(tab_id);
    }
    merge_agent_tabs(Vec::new(), leftovers)
}

/// Publishes the leftover record, owner-only, or removes it when no tab is
/// left. It names each tab by its id only: the number a tab had belonged to
/// its run, which has ended.
fn write_leftover_agent_tabs(approval_dir: &Path, tabs: &[String]) -> Result<()> {
    let path = approval_dir.join(LEFTOVER_AGENT_TABS_FILE);
    if tabs.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("failed to clear the leftover tab record"),
        };
    }
    let payload = serde_json::to_vec(&json!({
        "version": 1,
        "tabs": tabs
            .iter()
            .map(|tab_id| json!({ "tabId": tab_id }))
            .collect::<Vec<_>>(),
    }))?;
    // The temporary name uses the prefix the approval directory cleanup
    // accepts, so a write cut short is revoked with the rest.
    publish_private_file(
        &approval_dir.join(format!(".instafy-approval-leftover-{}", Uuid::new_v4())),
        &path,
        &payload,
        "Shared Browser leftover tab record",
    )
}

/// The DevTools HTTP endpoint the controller script connects to
/// (`INSTAFY_PLAYWRIGHT_CDP_URL`, else port `INSTAFY_PLAYWRIGHT_CDP_PORT` or
/// 9223 on 127.0.0.1), when it is a credential-free loopback HTTP address.
fn cdp_endpoint_from(url: Option<&str>, port: Option<&str>) -> Option<(String, u16)> {
    let raw = match url.map(str::trim).filter(|value| !value.is_empty()) {
        Some(url) => url.to_string(),
        None => {
            let port = match port.map(str::trim).filter(|value| !value.is_empty()) {
                Some(port) => port.parse::<u16>().ok()?,
                None => DEFAULT_CDP_PORT,
            };
            format!("http://127.0.0.1:{port}")
        }
    };
    let parsed = reqwest::Url::parse(&raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "ws")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let raw_host = parsed.host_str()?;
    let host = if raw_host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1".to_string()
    } else {
        match raw_host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .ok()?
        {
            std::net::IpAddr::V4(address) if address.is_loopback() => address.to_string(),
            std::net::IpAddr::V6(address) if address.is_loopback() => format!("[{address}]"),
            _ => return None,
        }
    };
    Some((host, parsed.port_or_known_default()?))
}

/// One of the run's own records in its approval directory, when it is a
/// bounded regular file of one of `versions` bound to `binding`.
fn read_run_record(
    approval_dir: &Path,
    name: &str,
    versions: &[u64],
    binding: &RunBinding,
) -> Result<Option<JsonValue>> {
    read_run_record_bounded(
        approval_dir,
        name,
        versions,
        binding,
        AGENT_TABS_FILE_MAX_BYTES,
    )
}

/// [`read_run_record`] for a record of at most `max_bytes`.
fn read_run_record_bounded(
    approval_dir: &Path,
    name: &str,
    versions: &[u64],
    binding: &RunBinding,
    max_bytes: u64,
) -> Result<Option<JsonValue>> {
    let path = approval_dir.join(name);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("failed to inspect {name}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        bail!("{name} is not a bounded regular file");
    }
    let bytes = std::fs::read(&path).with_context(|| format!("failed to read {name}"))?;
    let record: JsonValue =
        serde_json::from_slice(&bytes).with_context(|| format!("{name} is not JSON"))?;
    let bound = record
        .get("version")
        .and_then(JsonValue::as_u64)
        .is_some_and(|version| versions.contains(&version))
        && record.get("ownerId").and_then(JsonValue::as_str) == Some(binding.owner_id.as_str())
        && record.get("runId").and_then(JsonValue::as_str) == Some(&binding.run_id.to_string())
        && record.get("initiatorUserId").and_then(JsonValue::as_str)
            == Some(&binding.initiator_user_id.to_string())
        && record.get("browserPageId").and_then(JsonValue::as_str)
            == Some(binding.browser_page_id.as_str());
    if !bound {
        bail!("{name} belongs to another run");
    }
    Ok(Some(record))
}

/// Every tab Octo opened in the run, kept ones included, from the run's own
/// `tabs.json` (version 2, or version 1 from an earlier runtime-agent).
fn run_agent_tabs(approval_dir: &Path, binding: &RunBinding) -> Result<Vec<String>> {
    let Some(tabs) = read_run_record(approval_dir, AGENT_TABS_FILE, &[1, 2], binding)? else {
        return Ok(Vec::new());
    };
    let tab_ids = tabs
        .get("tabs")
        .and_then(JsonValue::as_array)
        .context("tabs.json has no tab list")?
        .iter()
        .map(|tab| {
            tab.get("tabId")
                .and_then(JsonValue::as_str)
                .context("a tab in tabs.json has no id")
                .and_then(validate_page_id)
        })
        .collect::<Result<Vec<_>>>()?;
    if tab_ids.len() > MAX_AGENT_TABS || tab_ids.contains(&binding.browser_page_id) {
        bail!("tabs.json is out of bounds");
    }
    Ok(tab_ids)
}

/// The tabs Octo opened in this run that the person did not keep, from the
/// run's own records. A record bound to another run, or one that cannot be
/// read, names no tab: closing is never extended to tabs this run cannot
/// prove are its own.
fn agent_tabs_to_close(approval_dir: &Path, binding: &RunBinding) -> Result<Vec<String>> {
    let agent_tabs = run_agent_tabs(approval_dir, binding)?;
    if agent_tabs.is_empty() {
        return Ok(agent_tabs);
    }
    // A kept-tab record that cannot be read keeps every tab: leaving a tab
    // open is the safe side of the person's choice.
    let kept: Vec<String> = match read_run_record(approval_dir, KEPT_AGENT_TABS_FILE, &[1], binding)
    {
        Ok(None) => Vec::new(),
        Ok(Some(record)) => match record.get("tabIds").and_then(JsonValue::as_array) {
            Some(ids) => ids
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect(),
            None => return Ok(Vec::new()),
        },
        Err(_) => return Ok(Vec::new()),
    };
    Ok(agent_tabs
        .into_iter()
        .filter(|tab_id| !kept.contains(tab_id))
        .collect())
}

/// Why a tab was not closed. `unreachable`: the DevTools endpoint could not
/// be reached at all, so no other tab can be closed now either.
#[derive(Debug)]
struct TabCloseFailure {
    unreachable: bool,
    error: anyhow::Error,
}

/// Closes one tab through the browser's loopback DevTools HTTP endpoint
/// (`/json/close/<id>`), with a bounded wait. Synchronous, because it runs
/// while the run's guard is dropped.
fn close_browser_tab(host: &str, port: u16, tab_id: &str) -> Result<(), TabCloseFailure> {
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};

    let unreachable = |error: anyhow::Error| TabCloseFailure {
        unreachable: true,
        error,
    };
    let address: SocketAddr = format!("{host}:{port}")
        .to_socket_addrs()
        .context("DevTools address is invalid")
        .and_then(|mut addresses| addresses.next().context("DevTools address did not resolve"))
        .map_err(unreachable)?;
    if !address.ip().is_loopback() {
        return Err(unreachable(anyhow!("DevTools address is not loopback")));
    }
    let stream = TcpStream::connect_timeout(&address, AGENT_TAB_CLOSE_TIMEOUT)
        .context("failed to reach the browser's DevTools endpoint")
        .map_err(unreachable)?;
    close_browser_tab_over(stream, host, port, tab_id).map_err(|error| TabCloseFailure {
        unreachable: false,
        error,
    })
}

fn close_browser_tab_over(
    mut stream: std::net::TcpStream,
    host: &str,
    port: u16,
    tab_id: &str,
) -> Result<()> {
    use std::io::Read;

    let tab_id = validate_page_id(tab_id)?;
    stream.set_read_timeout(Some(AGENT_TAB_CLOSE_TIMEOUT))?;
    stream.set_write_timeout(Some(AGENT_TAB_CLOSE_TIMEOUT))?;
    stream.write_all(
        format!(
            "GET /json/close/{tab_id} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    )?;
    let mut head = [0u8; 64];
    let mut read = 0;
    while read < head.len() {
        match stream.read(&mut head[read..])? {
            0 => break,
            count => read += count,
        }
        if head[..read].contains(&b'\n') {
            break;
        }
    }
    let status_line = String::from_utf8_lossy(&head[..read]);
    let status = status_line.split_whitespace().nth(1).unwrap_or_default();
    // 404: the tab is already gone, which is what closing asks for.
    if status != "200" && status != "404" {
        bail!("DevTools answered {status} when closing the tab");
    }
    Ok(())
}

impl Drop for SharedBrowserAgentControlGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.heartbeat.abort();
        if let Some(window_watch) = self.window_watch.take() {
            window_watch.abort();
        }
        let Ok(_marker_io) = self.marker_io.lock() else {
            tracing::error!(
                marker_path = %self.path.display(),
                "Shared Browser agent-control marker lock was poisoned; preserving authority and recycling the runtime"
            );
            recycle_runtime_after_unconfirmed_browser_shutdown();
            return;
        };
        if self
            .shutdown_confirmation
            .shared_browser_shutdown_is_confirmed()
        {
            // Every tool process of the run is gone, so nothing opens another
            // tab. Octo's tabs close now, apart from those the person kept,
            // and so do earlier runs' leftover tabs. A tab that does not close
            // stays open, badged as Octo's in the leftover record, and no
            // later run can use it.
            let run_tabs = self.agent_tabs_to_close();
            close_agent_tabs_and_settle_leftovers(
                &self.approval_dir,
                self.cdp_base.as_ref(),
                run_tabs,
            );
            // What the person approved on their page stays available to the
            // run that continues this one (Let AI continue), and only to it.
            // It is read before the run's records are revoked, and kept only
            // once the run has let go of the browser.
            let ended = ended_run_grants(&self.approval_dir, &self.binding());
            if let Err(error) = prepare_clean_approval_directory(&self.approval_dir) {
                tracing::error!(
                    ?error,
                    approval_dir = %self.approval_dir.display(),
                    "Shared Browser shutdown was confirmed but approval revocation failed; preserving authority and recycling the runtime"
                );
                forget_ended_run_grants(&self.approval_dir);
                recycle_runtime_after_unconfirmed_browser_shutdown();
                return;
            }
            if let Err(error) = remove_owned_agent_control_marker(
                &self.path,
                &self.owner_id,
                self.run_id,
                self.initiator_user_id,
                &self.browser_page_id,
            ) {
                tracing::error!(
                    ?error,
                    marker_path = %self.path.display(),
                    "Shared Browser shutdown was confirmed but authority release failed; preserving fail-closed state and recycling the runtime"
                );
                forget_ended_run_grants(&self.approval_dir);
                recycle_runtime_after_unconfirmed_browser_shutdown();
                return;
            }
            store_ended_run_grants(&self.approval_dir, ended);
        } else {
            tracing::error!(
                marker_path = %self.path.display(),
                "Shared Browser execution ended without confirmed tool shutdown; preserving authority and recycling the runtime"
            );
            forget_ended_run_grants(&self.approval_dir);
            recycle_runtime_after_unconfirmed_browser_shutdown();
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct SharedBrowserRequest {
    method: String,
    path: String,
    body: Option<JsonValue>,
}

/// A code that ends a Shared Browser run: one of the approval codes, or
/// [`BROWSER_UNAVAILABLE_CODE`].
pub(crate) fn canonical_terminal_consent_failure_code(raw: &str) -> Option<&'static str> {
    TERMINAL_APPROVAL_FAILURE_CODES
        .iter()
        .copied()
        .chain(std::iter::once(BROWSER_UNAVAILABLE_CODE))
        .find(|code| raw == *code)
}

/// The controller could not reach Instafy's browser or the run's own tab
/// (exit code [`BROWSER_UNAVAILABLE_EXIT_CODE`]).
#[derive(Debug)]
struct BrowserUnavailable(String);

impl std::fmt::Display for BrowserUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for BrowserUnavailable {}

fn terminal_consent_failure_code_from_error(error: &anyhow::Error) -> Option<&'static str> {
    let rendered = format!("{error:#}");
    TERMINAL_APPROVAL_FAILURE_CODES
        .iter()
        .copied()
        .find(|code| rendered.contains(&format!("[{code}_non_retryable]")))
}

fn terminal_consent_signal(code: &'static str) -> JsonValue {
    json!({
        "terminalConsent": {
            "state": "blocked",
            "terminal": true,
            "retryable": false,
            "code": code,
        }
    })
}

fn terminal_consent_status(code: &'static str) -> JsonValue {
    let mut status = terminal_consent_signal(code);
    let object = status
        .as_object_mut()
        .expect("terminal consent signal is always an object");
    object.insert(
        "ready".to_string(),
        JsonValue::Bool(code != BROWSER_UNAVAILABLE_CODE),
    );
    object.insert("originApproved".to_string(), JsonValue::Bool(false));
    object.insert("redacted".to_string(), JsonValue::Bool(true));
    object.insert("url".to_string(), JsonValue::Null);
    object.insert("title".to_string(), JsonValue::Null);
    status
}

/// A terminal consent result, with the step's kind (`activity.step`) when the
/// controller said what the step was before it asked: the turn's line then
/// says "you said no to a search", not "a form".
fn terminal_consent_call_result_with_step(
    code: &'static str,
    step: Option<&'static str>,
) -> CallToolResult {
    let mut result = terminal_consent_call_result(code);
    if let Some(step) = step
        && let Some(JsonValue::Object(structured)) = result.structured_content.as_mut()
    {
        structured.insert("activity".to_string(), json!({ "step": step }));
    }
    result
}

fn terminal_consent_call_result(code: &'static str) -> CallToolResult {
    if code == "human_input_required" {
        let mut result = CallToolResult::success(vec![Content::text(
            "Human input is needed. End this turn now. The user will fill the highlighted fields directly after confirmed shutdown, then explicitly continue in a fresh browser turn. Never request or repeat their values.",
        )]);
        result.structured_content = Some(terminal_consent_signal(code));
        return result;
    }
    if code == BROWSER_UNAVAILABLE_CODE {
        let mut result = CallToolResult::error(vec![Content::text(
            "Instafy's browser closed or stopped responding on this space's machine. End this turn now: do not retry or call another browser tool. Say in one short sentence that the browser closed and that they can open it again and send a message to continue.",
        )]);
        result.structured_content = Some(terminal_consent_signal(code));
        return result;
    }
    if code == "approval_timeout" {
        // Unanswered is not a denial, but it still ends the browser for this
        // turn, so prompts never chain while the person is away.
        let mut result = CallToolResult::success(vec![Content::text(
            "The person has not answered the browser's approval prompt yet, so the step was not performed. End this turn now: do not retry or call another browser tool. Say in one short sentence what you were waiting for their OK on. They will continue in a new message when they are ready.",
        )]);
        result.structured_content = Some(terminal_consent_signal(code));
        return result;
    }
    let mut result = CallToolResult::error(vec![Content::text(format!(
        "Shared Browser consent is blocked for this run ({code}). Start a fresh browser run before requesting another browser action."
    ))]);
    result.structured_content = Some(terminal_consent_signal(code));
    result
}

#[derive(Debug)]
enum SharedBrowserMcpExecutionFailure {
    TerminalConsent(&'static str),
    Other(anyhow::Error),
}

#[derive(Clone)]
struct SharedBrowserMcpServer {
    tools: Arc<Vec<Tool>>,
    action_lock: Arc<AsyncMutex<()>>,
    terminal_consent_failure: Arc<AsyncMutex<Option<&'static str>>>,
    /// The step kind of the call that latched the terminal failure, for its
    /// own result only.
    terminal_step: Arc<AsyncMutex<Option<&'static str>>>,
    /// Tool calls in a row that found the browser unavailable.
    browser_unavailable_streak: Arc<AtomicU32>,
}

impl SharedBrowserMcpServer {
    fn new() -> Self {
        Self {
            tools: Arc::new(shared_browser_mcp_tools()),
            action_lock: Arc::new(AsyncMutex::new(())),
            terminal_consent_failure: Arc::new(AsyncMutex::new(None)),
            terminal_step: Arc::new(AsyncMutex::new(None)),
            browser_unavailable_streak: Arc::new(AtomicU32::new(0)),
        }
    }

    /// Latches `code` unless a code is already latched, and answers with the
    /// latched one.
    async fn latch_terminal_failure(&self, code: &'static str) -> SharedBrowserMcpExecutionFailure {
        let mut latch = self.terminal_consent_failure.lock().await;
        if latch.is_none() {
            *latch = Some(code);
        }
        SharedBrowserMcpExecutionFailure::TerminalConsent(
            latch.expect("terminal consent failure was just latched"),
        )
    }

    async fn execute_with_failure_latch<F, Fut>(
        &self,
        request: &SharedBrowserRequest,
        execute: F,
    ) -> std::result::Result<JsonValue, SharedBrowserMcpExecutionFailure>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<JsonValue>>,
    {
        if let Some(code) = *self.terminal_consent_failure.lock().await {
            if request.method == "GET" && request.path == "/v1/status" {
                return Ok(terminal_consent_status(code));
            }
            return Err(SharedBrowserMcpExecutionFailure::TerminalConsent(code));
        }

        let outcome = execute().await;
        // Only an unreachable browser continues the streak; any other answer
        // proves the browser and the run's tab were there.
        let unavailable = outcome
            .as_ref()
            .err()
            .is_some_and(|error| error.downcast_ref::<BrowserUnavailable>().is_some());
        let streak = if unavailable {
            self.browser_unavailable_streak
                .fetch_add(1, Ordering::SeqCst)
                .saturating_add(1)
        } else {
            self.browser_unavailable_streak.store(0, Ordering::SeqCst);
            0
        };
        match outcome {
            Ok(payload) => Ok(payload),
            Err(error) => {
                if let Some(code) = terminal_consent_failure_code_from_error(&error) {
                    let latched = self.latch_terminal_failure(code).await;
                    // The call that ended the run names its step's kind
                    // (a search said no to), for the turn's line.
                    if matches!(latched, SharedBrowserMcpExecutionFailure::TerminalConsent(latched_code) if latched_code == code)
                    {
                        *self.terminal_step.lock().await = error
                            .downcast_ref::<ControllerFailure>()
                            .and_then(|failure| failure.step);
                    }
                    return Err(latched);
                }
                if streak >= BROWSER_UNAVAILABLE_STREAK_LIMIT {
                    return Err(self.latch_terminal_failure(BROWSER_UNAVAILABLE_CODE).await);
                }
                Err(SharedBrowserMcpExecutionFailure::Other(error))
            }
        }
    }
}

impl ServerHandler for SharedBrowserMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Control the visible Instafy Shared Browser through bounded, instrumented actions. Take a fresh snapshot before using element indices.",
        )
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> impl std::future::Future<Output = std::result::Result<ListToolsResult, McpError>> + Send + '_
    {
        let tools = self.tools.clone();
        async move {
            Ok(ListToolsResult {
                tools: (*tools).clone(),
                next_cursor: None,
                meta: None,
            })
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> std::result::Result<CallToolResult, McpError> {
        let browser_request = mcp_tool_request(request.name.as_ref(), request.arguments)
            .map_err(|error| McpError::invalid_params(error.to_string(), None))?;
        // rmcp may dispatch independent requests concurrently. The approval
        // protocol deliberately owns one fixed runtime-local request slot, so
        // serialize every browser observation and mutation through the same
        // lane. This also prevents a second tool call from changing the page
        // while the first call is waiting for its exact one-shot decision.
        let _action_guard = self.action_lock.lock().await;
        match self
            .execute_with_failure_latch(&browser_request, || execute_request(&browser_request))
            .await
        {
            Ok(payload) => Ok(successful_tool_result(payload)),
            Err(SharedBrowserMcpExecutionFailure::TerminalConsent(code)) => {
                let step = self.terminal_step.lock().await.take();
                Ok(terminal_consent_call_result_with_step(code, step))
            }
            Err(SharedBrowserMcpExecutionFailure::Other(error)) => {
                Ok(CallToolResult::error(vec![Content::text(format!(
                    "Shared Browser action failed: {error:#}"
                ))]))
            }
        }
    }
}

/// A successful call's result. The text is compact JSON: a code-mode model
/// reads the whole result, text and structured content alike, so pretty
/// printing only spent its context on whitespace.
fn successful_tool_result(payload: JsonValue) -> CallToolResult {
    let text = serde_json::to_string(&payload)
        .unwrap_or_else(|_| "Shared Browser returned an unreadable result".to_string());
    let mut result = CallToolResult::success(vec![Content::text(text)]);
    result.structured_content = Some(payload);
    result
}

pub fn is_shared_browser_mcp_command(args: &[OsString]) -> bool {
    args.first().is_some_and(|value| value == MCP_COMMAND)
}

pub async fn run_mcp_stdio() -> Result<()> {
    if !browser_session_enabled(std::env::var(BROWSER_SESSION_ENV).ok().as_deref()) {
        bail!("Shared Browser MCP is unavailable outside a browser-session runtime");
    }
    // Before serving anything: runtime-agent releases browser authority only after it has
    // killed and confirmed gone every process group recorded here.
    crate::mcp_process_groups::register_current_process_group()
        .context("Shared Browser MCP could not record its process group")?;
    let running = SharedBrowserMcpServer::new()
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .context("failed to start the Shared Browser MCP server")?;
    running
        .waiting()
        .await
        .context("Shared Browser MCP transport failed")?;
    Ok(())
}

fn schema(value: JsonValue) -> Arc<JsonObject> {
    Arc::new(value.as_object().cloned().unwrap_or_default())
}

fn shared_browser_mcp_tools() -> Vec<Tool> {
    let tab_id = json!({
        "type": "string",
        "minLength": 1,
        "maxLength": MAX_PAGE_ID_BYTES,
        "pattern": "^[A-Za-z0-9_-]+$",
        "description": "A tab id from list_tabs."
    });
    let target_properties = json!({
        "index": { "type": "integer", "minimum": 0, "maximum": MAX_TARGET_INDEX },
        "snapshotId": {
            "type": "string",
            "minLength": SNAPSHOT_ID_CHARS,
            "maxLength": SNAPSHOT_ID_CHARS,
            "pattern": "^[0-9a-f]{64}$"
        }
    });
    vec![
        Tool::new(
            Cow::Borrowed("request_human_input"),
            Cow::Borrowed(
                "End this turn and ask the user to fill one to eight highlighted fields from a fresh snapshot. Never include field values. The user explicitly continues in a fresh turn.",
            ),
            schema(json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "indices": { "type": "array", "minItems": 1, "maxItems": 8, "uniqueItems": true,
                        "items": { "type": "integer", "minimum": 0, "maximum": MAX_TARGET_INDEX } },
                    "snapshotId": target_properties["snapshotId"].clone()
                },
                "required": ["indices", "snapshotId"]
            })),
        ),
        Tool::new(
            Cow::Borrowed("status"),
            Cow::Borrowed("Read Shared Browser readiness and current page identity."),
            schema(json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        ),
        Tool::new(
            Cow::Borrowed("snapshot"),
            Cow::Borrowed(
                "Read what a person can see on the page: title, URL, visible text, and indexed interactive elements. Controls a person cannot see yet, such as those in closed menus and drawers, are left out; `omittedControls` counts them, and opening a menu or scrolling may reveal them. `expanded` tells whether a toggle is open, `area` is the part of the page a control sits in, and links on the page's own site are paths. With `tabId`, that tab becomes the one later tools act on first.",
            ),
            schema(json!({
                "type": "object",
                "properties": { "tabId": tab_id.clone() },
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("navigate"),
            Cow::Borrowed(
                "Navigate the visible page to a credential-free HTTP(S) URL, or to a path on the current page's site such as a snapshot link's href. With `tabId`, that tab becomes the one later tools act on first.",
            ),
            schema(json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "minLength": 1, "maxLength": MAX_URL_CHARS },
                    "tabId": tab_id.clone()
                },
                "required": ["url"],
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("click"),
            Cow::Borrowed(
                "Click one element from a fresh snapshot, emitting the visible AI cursor and action ticker.",
            ),
            schema(json!({
                "type": "object",
                "properties": target_properties.clone(),
                "required": ["index", "snapshotId"],
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("type"),
            Cow::Borrowed(
                "Type non-sensitive text into one observed element, optionally submitting it.",
            ),
            schema(json!({
                "type": "object",
                "properties": {
                    "index": target_properties["index"].clone(),
                    "snapshotId": target_properties["snapshotId"].clone(),
                    "text": { "type": "string", "maxLength": MAX_TEXT_CHARS },
                    "submit": { "type": "boolean" }
                },
                "required": ["index", "snapshotId", "text"],
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("press"),
            Cow::Borrowed("Press one allowlisted key on one element from a fresh snapshot."),
            schema(json!({
                "type": "object",
                "properties": {
                    "index": target_properties["index"].clone(),
                    "snapshotId": target_properties["snapshotId"].clone(),
                    "key": { "type": "string", "enum": ALLOWED_PRESS_KEYS }
                },
                "required": ["index", "snapshotId", "key"],
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("scroll"),
            Cow::Borrowed("Scroll the visible page by bounded horizontal and vertical deltas."),
            schema(json!({
                "type": "object",
                "properties": {
                    "x": { "type": "number", "minimum": -MAX_SCROLL_DELTA, "maximum": MAX_SCROLL_DELTA },
                    "y": { "type": "number", "minimum": -MAX_SCROLL_DELTA, "maximum": MAX_SCROLL_DELTA }
                },
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("list_tabs"),
            Cow::Borrowed(
                "List the tabs this run may use: the page the person chose and the tabs Octo opened, with which one later tools act on. A tab's address and title show once its site is approved in that tab. Each of Octo's tabs has a `label` (\"Octo's tab 2\") that it keeps while it is open; the person's prompts and browser use the same label, so name tabs by it.",
            ),
            schema(json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        ),
        Tool::new(
            Cow::Borrowed("open_tab"),
            Cow::Borrowed(
                "Open a full credential-free HTTP(S) address in a new visible tab of the shared browser and act on it from now on. Octo may have at most three tabs of its own open; they close when this turn ends unless the person keeps them. The site's approval applies in that tab only.",
            ),
            schema(json!({
                "type": "object",
                "properties": { "url": { "type": "string", "minLength": 1, "maxLength": MAX_URL_CHARS } },
                "required": ["url"],
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("select_tab"),
            Cow::Borrowed(
                "Bring one tab from list_tabs to the front and act on it from now on. Take a fresh snapshot there before using element indices.",
            ),
            schema(json!({
                "type": "object",
                "properties": { "tabId": tab_id.clone() },
                "required": ["tabId"],
                "additionalProperties": false
            })),
        ),
        Tool::new(
            Cow::Borrowed("close_tab"),
            Cow::Borrowed(
                "Close one tab Octo opened in this turn. The page the person chose, their other tabs and tabs they kept are never closed.",
            ),
            schema(json!({
                "type": "object",
                "properties": { "tabId": tab_id },
                "required": ["tabId"],
                "additionalProperties": false
            })),
        ),
    ]
}

fn mcp_tool_request(name: &str, arguments: Option<JsonObject>) -> Result<SharedBrowserRequest> {
    let arguments = arguments.unwrap_or_default();
    if matches!(name, "status" | "list_tabs") && !arguments.is_empty() {
        bail!("Shared Browser {name} does not accept arguments");
    }
    let (method, path, body) = match name {
        "status" => ("GET", "/v1/status", None),
        "snapshot" if arguments.is_empty() => ("GET", "/v1/snapshot", None),
        "snapshot" => ("POST", "/v1/snapshot", Some(JsonValue::Object(arguments))),
        "navigate" => ("POST", "/v1/navigate", Some(JsonValue::Object(arguments))),
        "list_tabs" => ("GET", "/v1/tabs", None),
        "open_tab" => ("POST", "/v1/tabs/open", Some(JsonValue::Object(arguments))),
        "select_tab" => (
            "POST",
            "/v1/tabs/select",
            Some(JsonValue::Object(arguments)),
        ),
        "close_tab" => ("POST", "/v1/tabs/close", Some(JsonValue::Object(arguments))),
        "click" => ("POST", "/v1/click", Some(JsonValue::Object(arguments))),
        "type" => ("POST", "/v1/type", Some(JsonValue::Object(arguments))),
        "press" => ("POST", "/v1/press", Some(JsonValue::Object(arguments))),
        "scroll" => ("POST", "/v1/scroll", Some(JsonValue::Object(arguments))),
        "request_human_input" => (
            "POST",
            "/v1/request-human-input",
            Some(JsonValue::Object(arguments)),
        ),
        _ => bail!("unknown Shared Browser tool {name}"),
    };
    if let Some(body) = body.as_ref() {
        validate_request_body(path, body)?;
    }
    Ok(SharedBrowserRequest {
        method: method.to_string(),
        path: path.to_string(),
        body,
    })
}

pub fn is_shared_browser_command(args: &[OsString]) -> bool {
    args.first().is_some_and(|value| value == "shared-browser")
}

pub async fn run_cli(args: impl IntoIterator<Item = OsString>) -> Result<()> {
    let args = args
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow!("Shared Browser arguments must be valid UTF-8"))
        })
        .collect::<Result<Vec<_>>>()?;
    let request = parse_request_args(&args)?;
    let payload = execute_request(&request).await?;
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Ok(())
}

fn parse_request_args(args: &[String]) -> Result<SharedBrowserRequest> {
    if args.first().map(String::as_str) != Some("request") || !(3..=4).contains(&args.len()) {
        bail!("usage: runtime-agent shared-browser request <GET|POST> </v1/path> [JSON body]");
    }

    let method = args[1].trim().to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST") {
        bail!("Shared Browser only supports GET and POST");
    }
    let path = normalize_allowed_path(method.as_str(), &args[2])?;
    let body = args
        .get(3)
        .map(|raw| {
            if raw.len() > MAX_REQUEST_BODY_BYTES {
                bail!("Shared Browser request body is too large");
            }
            serde_json::from_str::<JsonValue>(raw)
                .context("Shared Browser request body must be valid JSON")
        })
        .transpose()?;

    if method == "GET" && body.is_some() {
        bail!("Shared Browser GET requests do not accept a body");
    }
    if method == "POST" && body.is_none() {
        bail!("Shared Browser POST requests require a JSON body");
    }
    if body.as_ref().is_some_and(|value| !value.is_object()) {
        bail!("Shared Browser request body must be a JSON object");
    }
    if let Some(body) = body.as_ref() {
        validate_request_body(&path, body)?;
    }

    Ok(SharedBrowserRequest { method, path, body })
}

fn require_only_keys(object: &JsonMap<String, JsonValue>, allowed: &[&str]) -> Result<()> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        bail!("Shared Browser request contains unsupported field {key}");
    }
    Ok(())
}

fn validate_target(object: &JsonMap<String, JsonValue>) -> Result<()> {
    let has_index = match object.get("index") {
        Some(value) => value
            .as_u64()
            .is_some_and(|index| index <= MAX_TARGET_INDEX),
        None => false,
    };
    let has_snapshot_id = object
        .get("snapshotId")
        .and_then(JsonValue::as_str)
        .is_some_and(valid_snapshot_id);
    if !has_index || !has_snapshot_id {
        bail!("Shared Browser action requires one valid index and its fresh snapshotId");
    }
    Ok(())
}

fn validate_tab_id_field(object: &JsonMap<String, JsonValue>, required: bool) -> Result<()> {
    match object.get("tabId") {
        None if !required => Ok(()),
        Some(JsonValue::String(tab_id)) if tab_id.trim() == tab_id => {
            validate_page_id(tab_id).map(|_| ())
        }
        _ => bail!("Shared Browser tabId must be one tab id from list_tabs"),
    }
}

fn valid_snapshot_id(value: &str) -> bool {
    value.len() == SNAPSHOT_ID_CHARS
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn validate_request_body(path: &str, body: &JsonValue) -> Result<()> {
    let object = body
        .as_object()
        .context("Shared Browser request body must be a JSON object")?;
    match path {
        "/v1/snapshot" | "/v1/tabs/select" | "/v1/tabs/close" => {
            require_only_keys(object, &["tabId"])?;
            validate_tab_id_field(object, true)?;
        }
        "/v1/tabs/open" => {
            require_only_keys(object, &["url"])?;
            let raw = object
                .get("url")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.chars().count() <= MAX_URL_CHARS)
                .context("Shared Browser open_tab requires a bounded URL string")?;
            // A new tab has no site yet: only a full address opens one.
            let url = reqwest::Url::parse(raw)
                .context("Shared Browser open_tab requires a full HTTP(S) address")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                bail!("Shared Browser open_tab requires a credential-free HTTP(S) URL");
            }
        }
        "/v1/navigate" => {
            require_only_keys(object, &["url", "tabId"])?;
            validate_tab_id_field(object, false)?;
            let raw = object
                .get("url")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.chars().count() <= MAX_URL_CHARS)
                .context("Shared Browser navigate requires a bounded URL string")?;
            // A path is on the current page's site, such as a snapshot link's
            // href. The controller resolves it against the page; here only its
            // form is checked, and it must not name another host.
            let url = if raw.starts_with('/') {
                let base = reqwest::Url::parse(NAVIGATION_PATH_FORM_ORIGIN)
                    .context("Shared Browser navigation path base is invalid")?;
                let url = base
                    .join(raw)
                    .context("Shared Browser navigation path is invalid")?;
                if url.origin() != base.origin() {
                    bail!("Shared Browser navigation path must stay on the page's site");
                }
                url
            } else {
                reqwest::Url::parse(raw)
                    .context("Shared Browser navigation requires a full URL or a path")?
            };
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                bail!("Shared Browser navigation requires a credential-free HTTP(S) URL");
            }
        }
        "/v1/request-human-input" => {
            require_only_keys(object, &["indices", "snapshotId"])?;
            let indices = object
                .get("indices")
                .and_then(JsonValue::as_array)
                .context("Human input requires observed indices")?;
            if indices.is_empty() || indices.len() > 8 {
                bail!("Human input requires one to eight fields");
            }
            let mut unique = std::collections::HashSet::new();
            for index in indices {
                let index = index
                    .as_u64()
                    .filter(|index| *index <= MAX_TARGET_INDEX)
                    .context("Human input index is invalid")?;
                if !unique.insert(index) {
                    bail!("Human input indices must be unique");
                }
                let mut target = object.clone();
                target.insert("index".to_string(), json!(index));
                validate_target(&target)?;
            }
        }
        "/v1/click" => {
            require_only_keys(object, &["index", "snapshotId"])?;
            validate_target(object)?;
        }
        "/v1/type" => {
            require_only_keys(object, &["index", "snapshotId", "text", "submit"])?;
            validate_target(object)?;
            let text = object
                .get("text")
                .and_then(JsonValue::as_str)
                .context("Shared Browser type requires a text string")?;
            if text.chars().count() > MAX_TEXT_CHARS {
                bail!("Shared Browser type text is too large");
            }
            if object
                .get("submit")
                .is_some_and(|value| !value.is_boolean())
            {
                bail!("Shared Browser type submit must be a boolean");
            }
        }
        "/v1/press" => {
            require_only_keys(object, &["index", "snapshotId", "key"])?;
            validate_target(object)?;
            let key = object
                .get("key")
                .and_then(JsonValue::as_str)
                .context("Shared Browser press requires a key string")?;
            if !ALLOWED_PRESS_KEYS.contains(&key) {
                bail!("Shared Browser press key is not allowed");
            }
        }
        "/v1/scroll" => {
            require_only_keys(object, &["x", "y"])?;
            for key in ["x", "y"] {
                if object.get(key).is_some_and(|value| {
                    value
                        .as_f64()
                        .is_none_or(|number| number.abs() > MAX_SCROLL_DELTA)
                }) {
                    bail!("Shared Browser scroll {key} must be a bounded number");
                }
            }
        }
        _ => bail!("unsupported Shared Browser method/path combination"),
    }
    Ok(())
}

fn normalize_allowed_path(method: &str, raw: &str) -> Result<String> {
    let path = raw.trim();
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#']) {
        bail!("Shared Browser request path must be an exact /v1 endpoint");
    }
    let allowed = matches!(
        (method, path),
        ("GET", "/v1/status" | "/v1/snapshot" | "/v1/tabs")
            | (
                "POST",
                "/v1/snapshot"
                    | "/v1/tabs/open"
                    | "/v1/tabs/select"
                    | "/v1/tabs/close"
                    | "/v1/navigate"
                    | "/v1/click"
                    | "/v1/type"
                    | "/v1/press"
                    | "/v1/scroll"
                    | "/v1/request-human-input"
            )
    );
    if !allowed {
        bail!("unsupported Shared Browser method/path combination");
    }
    Ok(path.to_string())
}

async fn execute_request(request: &SharedBrowserRequest) -> Result<JsonValue> {
    if !browser_session_enabled(std::env::var(BROWSER_SESSION_ENV).ok().as_deref()) {
        bail!("Shared Browser controller is unavailable outside a browser-session runtime");
    }
    let trusted_cwd = std::env::current_exe()
        .context("failed to locate the Shared Browser controller executable")?
        .parent()
        .map(Path::to_path_buf)
        .context("Shared Browser controller executable has no trusted parent directory")?;
    let mut command = Command::new(shared_browser_node_binary());
    // The script is read from stdin. Linux caps one argv string at 128 KiB
    // (MAX_ARG_STRLEN), and the script with its embedded policy modules is
    // larger than that.
    command
        .current_dir(trusted_cwd)
        .arg("-")
        .arg(&request.method)
        .arg(&request.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(body) = request.body.as_ref() {
        command.arg(serde_json::to_string(body)?);
    }

    let mut child = command
        .spawn()
        .context("failed to launch the Shared Browser controller")?;
    let mut stdin = child
        .stdin
        .take()
        .context("Shared Browser controller has no stdin")?;
    // Node reads the whole script before it runs it, so nothing is written to
    // stdout or stderr until stdin closes.
    let script_written = stdin
        .write_all(embedded_shared_browser_script().as_bytes())
        .await;
    drop(stdin);
    let output = child
        .wait_with_output()
        .await
        .context("failed to run the Shared Browser controller")?;
    if let Err(error) = script_written {
        // Node exited before it read the script; its stderr says why.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        bail!(
            "failed to pass the Shared Browser controller script ({error}); Node exited with {}: {}",
            output.status,
            if message.is_empty() {
                "no error details"
            } else {
                message
            }
        );
    }
    if !output.status.success() {
        return Err(controller_failure(
            output.status,
            &output.stderr,
            &output.stdout,
        ));
    }
    serde_json::from_slice::<JsonValue>(&output.stdout)
        .context("Shared Browser controller returned invalid JSON")
}

/// The error of a controller command that exited unsuccessfully. Only its
/// exit code, never its error text, marks the browser as unavailable.
fn controller_failure(
    status: std::process::ExitStatus,
    stderr: &[u8],
    stdout: &[u8],
) -> anyhow::Error {
    let stderr = String::from_utf8_lossy(stderr);
    let details = stderr.trim();
    let message = format!(
        "Shared Browser command exited with {status}: {}",
        if details.is_empty() {
            "no error details"
        } else {
            details
        }
    );
    if status.code() == Some(BROWSER_UNAVAILABLE_EXIT_CODE) {
        BrowserUnavailable(message).into()
    } else {
        ControllerFailure {
            message,
            step: failed_step_kind(stdout),
        }
        .into()
    }
}

/// A controller command that failed, with the step's kind when the command
/// said it (a search, or a form sent) before it asked the person.
#[derive(Debug)]
struct ControllerFailure {
    message: String,
    step: Option<&'static str>,
}

impl std::fmt::Display for ControllerFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ControllerFailure {}

/// The step kind a failed command printed: exactly `{"ok":false,"activity":
/// {"step":<kind>}}` on stdout, the kind one of the few the controller names
/// there. Anything else names none. The controller writes nothing else to
/// stdout before it fails, and never page text there.
fn failed_step_kind(stdout: &[u8]) -> Option<&'static str> {
    const KINDS: &[&str] = &["search", "submit"];
    if stdout.len() > 256 {
        return None;
    }
    let value = serde_json::from_slice::<JsonValue>(stdout).ok()?;
    let object = value.as_object()?;
    if object.len() != 2 || object.get("ok") != Some(&JsonValue::Bool(false)) {
        return None;
    }
    let activity = object.get("activity")?.as_object()?;
    if activity.len() != 1 {
        return None;
    }
    let step = activity.get("step")?.as_str()?;
    KINDS.iter().copied().find(|known| *known == step)
}

fn embedded_shared_browser_script() -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{SHARED_BROWSER_APPROVAL_SCRIPT}\n{SHARED_BROWSER_SCRIPT}",
        embedded_plain_script(BROWSER_REDACTION_SCRIPT),
        embedded_plain_script(BROWSER_ACTION_POLICY_SCRIPT),
        embedded_plain_script(BROWSER_PAGE_CAPTURE_SCRIPT),
        embedded_plain_script(BROWSER_FORM_SUBMISSION_SCRIPT),
        embedded_plain_script(BROWSER_LINK_ONLY_SCRIPT),
        embedded_link_only_sites(),
    )
}

/// The skill's link-only list as data for the controller script. The file is
/// JSON, which is a JavaScript expression as it stands.
fn embedded_link_only_sites() -> String {
    format!("globalThis.__instafyLinkOnlySites = {LINK_ONLY_SITES_DATA};")
}

/// What the origin evaluates, in an isolated world of the page, to read a page
/// a person sends to the chat: the redaction and page-capture scripts, and the
/// link-only matcher with the skill's list, which mark the page's links to
/// link-only sites. The origin adds the call itself (see
/// `origin_http_server::browser_page_capture`).
pub fn sent_page_capture_script() -> String {
    format!(
        "{}\n{}\n{}\n{}",
        embedded_plain_script(BROWSER_REDACTION_SCRIPT),
        embedded_plain_script(BROWSER_PAGE_CAPTURE_SCRIPT),
        embedded_plain_script(BROWSER_LINK_ONLY_SCRIPT),
        embedded_link_only_sites(),
    )
}

/// `node -e` defines `module` and `require`, which would make the package
/// scripts export through CommonJS. Hiding both makes each one publish its
/// API on `globalThis`, where the controller script reads it.
fn embedded_plain_script(source: &str) -> String {
    format!("(function (module, require) {{\n{source}\n}})(undefined, undefined);")
}

/// `INSTAFY_SHARED_BROWSER_NODE_BINARY` when it names an allowed binary,
/// otherwise the image's default.
fn shared_browser_node_binary() -> &'static str {
    shared_browser_node_binary_from(
        std::env::var(crate::browser_host::mode::SHARED_BROWSER_NODE_BINARY_ENV)
            .ok()
            .as_deref(),
    )
}

fn shared_browser_node_binary_from(raw: Option<&str>) -> &'static str {
    raw.map(str::trim)
        .and_then(|value| {
            ALLOWED_SHARED_BROWSER_NODE_BINARIES
                .iter()
                .copied()
                .find(|allowed| *allowed == value)
        })
        .unwrap_or(DEFAULT_SHARED_BROWSER_NODE_BINARY)
}

fn browser_session_enabled(raw: Option<&str>) -> bool {
    raw.map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

pub fn payload_requests_shared_browser(payload: &JsonValue) -> bool {
    payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("browserTransport")
                .or_else(|| metadata.get("browser_transport"))
        })
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"))
        .as_deref()
        == Some("shared")
}

pub fn page_id_from_payload(payload: &JsonValue) -> Result<String> {
    let raw = payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .and_then(|metadata| {
            metadata
                .get("browserPageId")
                .or_else(|| metadata.get("browser_page_id"))
        })
        .and_then(JsonValue::as_str)
        .context("Shared Browser job is missing its UI-selected browserPageId")?;
    validate_page_id(raw)
}

pub fn consent_version_from_payload(payload: &JsonValue) -> Result<u64> {
    let metadata = payload
        .get("metadata")
        .and_then(JsonValue::as_object)
        .context("Shared Browser job is missing consent-capable Studio metadata")?;
    let mut observed = None;
    for key in ["browserConsentVersion", "browser_consent_version"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let version = value
            .as_u64()
            .context("Shared Browser consent version must be an integer")?;
        if version != SHARED_BROWSER_CONSENT_VERSION || observed.is_some_and(|seen| seen != version)
        {
            bail!(
                "Shared Browser requires consent protocol version {SHARED_BROWSER_CONSENT_VERSION}"
            );
        }
        observed = Some(version);
    }
    observed.context("Shared Browser job is missing consent-capable Studio metadata")
}

pub fn initiator_user_id_from_payload(payload: &JsonValue) -> Result<Uuid> {
    let raw = payload
        .get("user_id")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("Shared Browser job is missing its authenticated initiator user")?;
    Uuid::parse_str(raw).context("Shared Browser authenticated initiator user must be a UUID")
}

pub fn validate_page_id(raw: &str) -> Result<String> {
    let page_id = raw.trim();
    if page_id.is_empty()
        || page_id.len() > MAX_PAGE_ID_BYTES
        || !page_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("Shared Browser browserPageId must be one bounded CDP target id");
    }
    Ok(page_id.to_string())
}

pub fn action_log_len() -> u64 {
    let path = std::env::var(ACTIONS_FILE_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ACTIONS_FILE.to_string());
    std::fs::metadata(Path::new(&path))
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

pub fn execution_evidence_missing(before: Option<u64>, after: u64) -> bool {
    before.is_some_and(|before| after <= before)
}
#[cfg(test)]
#[path = "shared_browser_tests.rs"]
mod tests;
