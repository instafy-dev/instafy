use std::borrow::Cow;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use rmcp::ErrorData as McpError;
use rmcp::ServiceExt;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use serde_json::Map as JsonMap;
use serde_json::Value as JsonValue;
use serde_json::json;
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
pub const MCP_COMMAND: &str = "shared-browser-mcp";
const DEFAULT_ACTIONS_FILE: &str = "/tmp/instafy/playwright/actions.jsonl";
const DEFAULT_AGENT_CONTROL_FILE: &str = "/run/instafy/browser/agent-control.json";
const DEFAULT_APPROVAL_DIR: &str = "/run/instafy/browser/approvals";
const AGENT_CONTROL_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);
const AGENT_CONTROL_TTL: Duration = Duration::from_secs(12);
const AGENT_CONTROL_DISPLAY_NAME_MAX_BYTES: usize = 80;
const SHARED_BROWSER_SCRIPT: &str = include_str!("../assets/shared-browser-cli.js");
const SHARED_BROWSER_APPROVAL_SCRIPT: &str = include_str!("../assets/shared-browser-approval.js");
const SHARED_BROWSER_NODE_BINARY: &str = "/usr/bin/node";
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const MAX_URL_CHARS: usize = 4_096;
const MAX_TEXT_CHARS: usize = 16_384;
const MAX_TARGET_INDEX: u64 = 199;
const SNAPSHOT_ID_CHARS: usize = 64;
const MAX_SCROLL_DELTA: f64 = 10_000.0;
const MAX_PAGE_ID_BYTES: usize = 256;
const SHARED_BROWSER_CONSENT_VERSION: u64 = 1;
const APPROVAL_DIRECTORY_MAX_ENTRIES: usize = 16;
const APPROVAL_FIXED_FILES: [&str; 3] = ["request.json", "decision.json", "state.json"];
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

/// Runtime-local authority marker consumed by origin-http-server. The marker
/// never contains page contents, typed text, or credentials; it only tells the
/// browser input arbiter that an exact Shared Browser job currently owns the
/// runtime-wide control lane.
pub struct SharedBrowserAgentControlGuard {
    path: PathBuf,
    approval_dir: PathBuf,
    owner_id: String,
    run_id: Uuid,
    initiator_user_id: Uuid,
    browser_page_id: String,
    active: Arc<AtomicBool>,
    marker_io: Arc<Mutex<()>>,
    shutdown_confirmation: JobCancelSignal,
    heartbeat: JoinHandle<()>,
}

#[cfg(test)]
static RUNTIME_RECYCLE_REQUESTED: AtomicBool = AtomicBool::new(false);

fn recycle_runtime_after_unconfirmed_browser_shutdown() {
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
        browser_session_enabled(std::env::var(BROWSER_SESSION_ENV).ok().as_deref()),
        &agent_control_file_path(),
        &approval_dir_path(),
    )
}

fn clear_stale_agent_control_marker_on_startup_for_mode(
    browser_session_enabled: bool,
    marker_path: &Path,
    approval_dir: &Path,
) -> Result<()> {
    if !browser_session_enabled {
        return Ok(());
    }
    clear_stale_agent_control_marker(marker_path)?;
    prepare_clean_approval_directory(approval_dir)
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
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp_path).with_context(|| {
        format!(
            "failed to create Shared Browser agent-control marker {}",
            temp_path.display()
        )
    })?;
    file.write_all(&payload).with_context(|| {
        format!(
            "failed to write Shared Browser agent-control marker {}",
            temp_path.display()
        )
    })?;
    file.sync_all().with_context(|| {
        format!(
            "failed to sync Shared Browser agent-control marker {}",
            temp_path.display()
        )
    })?;
    drop(file);
    #[cfg(unix)]
    std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600)).with_context(
        || {
            format!(
                "failed to protect Shared Browser agent-control marker {}",
                temp_path.display()
            )
        },
    )?;
    std::fs::rename(&temp_path, path).with_context(|| {
        format!(
            "failed to publish Shared Browser agent-control marker {}",
            path.display()
        )
    })?;
    Ok(())
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
    pub fn acquire(
        run_id: Uuid,
        initiator_user_id: Uuid,
        browser_page_id: &str,
        display_name: &str,
        cancel_signal: JobCancelSignal,
    ) -> Result<Self> {
        Self::acquire_with_path(
            agent_control_file_path(),
            approval_dir_path(),
            run_id,
            initiator_user_id,
            browser_page_id,
            display_name,
            cancel_signal,
            AGENT_CONTROL_HEARTBEAT_INTERVAL,
        )
    }

    fn acquire_with_path(
        path: PathBuf,
        approval_dir: PathBuf,
        run_id: Uuid,
        initiator_user_id: Uuid,
        browser_page_id: &str,
        display_name: &str,
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
        prepare_clean_approval_directory(&approval_dir)?;
        write_agent_control_marker(
            &path,
            &owner_id,
            run_id,
            initiator_user_id,
            &browser_page_id,
            &display_name,
        )?;

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
            owner_id,
            run_id,
            initiator_user_id,
            browser_page_id: marker_browser_page_id,
            active,
            marker_io,
            shutdown_confirmation: cancel_signal,
            heartbeat,
        })
    }
}

impl Drop for SharedBrowserAgentControlGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.heartbeat.abort();
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
            if let Err(error) = prepare_clean_approval_directory(&self.approval_dir) {
                tracing::error!(
                    ?error,
                    approval_dir = %self.approval_dir.display(),
                    "Shared Browser shutdown was confirmed but approval revocation failed; preserving authority and recycling the runtime"
                );
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
                recycle_runtime_after_unconfirmed_browser_shutdown();
            }
        } else {
            tracing::error!(
                marker_path = %self.path.display(),
                "Shared Browser execution ended without confirmed tool shutdown; preserving authority and recycling the runtime"
            );
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

pub(crate) fn canonical_terminal_consent_failure_code(raw: &str) -> Option<&'static str> {
    TERMINAL_APPROVAL_FAILURE_CODES
        .iter()
        .copied()
        .find(|code| raw == *code)
}

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
    object.insert("ready".to_string(), JsonValue::Bool(true));
    object.insert("originApproved".to_string(), JsonValue::Bool(false));
    object.insert("redacted".to_string(), JsonValue::Bool(true));
    object.insert("url".to_string(), JsonValue::Null);
    object.insert("title".to_string(), JsonValue::Null);
    status
}

fn terminal_consent_call_result(code: &'static str) -> CallToolResult {
    if code == "human_input_required" {
        let mut result = CallToolResult::success(vec![ContentBlock::text(
            "Human input is needed. End this turn now. The user will fill the highlighted fields directly after confirmed shutdown, then explicitly continue in a fresh browser turn. Never request or repeat their values.",
        )]);
        result.structured_content = Some(terminal_consent_signal(code));
        return result;
    }
    let mut result = CallToolResult::error(vec![ContentBlock::text(format!(
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
}

impl SharedBrowserMcpServer {
    fn new() -> Self {
        Self {
            tools: Arc::new(shared_browser_mcp_tools()),
            action_lock: Arc::new(AsyncMutex::new(())),
            terminal_consent_failure: Arc::new(AsyncMutex::new(None)),
        }
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

        match execute().await {
            Ok(payload) => Ok(payload),
            Err(error) => {
                let Some(code) = terminal_consent_failure_code_from_error(&error) else {
                    return Err(SharedBrowserMcpExecutionFailure::Other(error));
                };
                let mut latch = self.terminal_consent_failure.lock().await;
                if latch.is_none() {
                    *latch = Some(code);
                }
                Err(SharedBrowserMcpExecutionFailure::TerminalConsent(
                    latch.expect("terminal consent failure was just latched"),
                ))
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
        async move { Ok(ListToolsResult::with_all_items((*tools).clone())) }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::service::RoleServer>,
    ) -> std::result::Result<CallToolResponse, McpError> {
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
            Ok(payload) => {
                let text = serde_json::to_string_pretty(&payload)
                    .unwrap_or_else(|_| "Shared Browser returned an unreadable result".to_string());
                let mut result = CallToolResult::success(vec![ContentBlock::text(text)]);
                result.structured_content = Some(payload);
                Ok(result.into())
            }
            Err(SharedBrowserMcpExecutionFailure::TerminalConsent(code)) => {
                Ok(terminal_consent_call_result(code).into())
            }
            Err(SharedBrowserMcpExecutionFailure::Other(error)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "Shared Browser action failed: {error:#}"
                ))])
                .into())
            }
        }
    }
}

pub fn is_shared_browser_mcp_command(args: &[OsString]) -> bool {
    args.first().is_some_and(|value| value == MCP_COMMAND)
}

pub async fn run_mcp_stdio() -> Result<()> {
    if !browser_session_enabled(std::env::var(BROWSER_SESSION_ENV).ok().as_deref()) {
        bail!("Shared Browser MCP is unavailable outside a browser-session runtime");
    }
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
                "Read the current page title, URL, visible text, and indexed interactive elements.",
            ),
            schema(json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        ),
        Tool::new(
            Cow::Borrowed("navigate"),
            Cow::Borrowed("Navigate the visible page to a credential-free HTTP(S) URL."),
            schema(json!({
                "type": "object",
                "properties": { "url": { "type": "string", "minLength": 1, "maxLength": MAX_URL_CHARS } },
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
    ]
}

fn mcp_tool_request(name: &str, arguments: Option<JsonObject>) -> Result<SharedBrowserRequest> {
    let arguments = arguments.unwrap_or_default();
    if matches!(name, "status" | "snapshot") && !arguments.is_empty() {
        bail!("Shared Browser {name} does not accept arguments");
    }
    let (method, path, body) = match name {
        "status" => ("GET", "/v1/status", None),
        "snapshot" => ("GET", "/v1/snapshot", None),
        "navigate" => ("POST", "/v1/navigate", Some(JsonValue::Object(arguments))),
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
        "/v1/navigate" => {
            require_only_keys(object, &["url"])?;
            let raw = object
                .get("url")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.chars().count() <= MAX_URL_CHARS)
                .context("Shared Browser navigate requires a bounded URL string")?;
            let url = reqwest::Url::parse(raw)
                .context("Shared Browser navigation requires an absolute URL")?;
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
        ("GET", "/v1/status" | "/v1/snapshot")
            | (
                "POST",
                "/v1/navigate"
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
    let mut command = Command::new(SHARED_BROWSER_NODE_BINARY);
    let controller_script = embedded_shared_browser_script();
    command
        .current_dir(trusted_cwd)
        .arg("-e")
        .arg(controller_script)
        .arg("--")
        .arg(&request.method)
        .arg(&request.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(body) = request.body.as_ref() {
        command.arg(serde_json::to_string(body)?);
    }

    let output = command
        .output()
        .await
        .context("failed to launch the Shared Browser controller")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        bail!(
            "Shared Browser command exited with {}: {}",
            output.status,
            if message.is_empty() {
                "no error details"
            } else {
                message
            }
        );
    }
    serde_json::from_slice::<JsonValue>(&output.stdout)
        .context("Shared Browser controller returned invalid JSON")
}

fn embedded_shared_browser_script() -> String {
    format!("{SHARED_BROWSER_APPROVAL_SCRIPT}\n{SHARED_BROWSER_SCRIPT}")
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
